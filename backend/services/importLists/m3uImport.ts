import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import * as v from "valibot";
import { parseFile } from "music-metadata";
import { db } from "../../config/db-sqlite.ts";
import { dbOps } from "../../db/helpers/index.ts";
import { downloadTracker } from "../downloadJobs/downloadTracker.ts";
import { isPathInsideRoot, resolveDownloadRoot } from "../downloadPaths.ts";
import { logger, safeLogDiagnostic } from "../logger.ts";
import { flowPlaylistConfig } from "../playlists/flowPlaylistConfig.ts";
import {
  normalizePlaylistTrack,
  type PlaylistTrack,
  type PlaylistTrackInput,
} from "../playlists/playlistTracks.ts";
import { enqueueImportedPlaylist } from "./importPlaylist.ts";

// Imports .m3u/.m3u8 playlists from a folder on the server. Each entry is
// matched to a file; a file in the Library folder is pinned to that exact
// file, so the playlist never searches for or downloads it again. With
// copyTracks, the playlist's folder is first ingested (copied) into the
// Library, and the playlists are built once that ingest finishes.

export const M3U_PROVIDER = "m3u-file";
const PLAYLIST_EXTENSIONS = new Set([".m3u", ".m3u8"]);
const MAX_SCAN_DEPTH = 6;
const MAX_PLAYLISTS = 500;
const PENDING_SETTING = "m3uImport:pending";

export class M3uImportError extends Error {
  status = 400;
}

export type M3uEntry = {
  path: string;
  artist: string | null;
  title: string | null;
  durationMs: number | null;
};

function resolveEntryPath(raw: string, m3uDir: string) {
  let value = raw.trim();
  if (/^file:\/\//i.test(value)) {
    try {
      return fileURLToPath(value);
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return null; // http(s) streams
  value = value.replaceAll("\\", "/");
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(m3uDir, value);
}

function parseExtinf(line: string) {
  const match = line.match(/^#EXTINF:\s*(-?\d+(?:\.\d+)?)?[^,]*,(.*)$/i);
  if (!match) return null;
  const seconds = Number(match[1]);
  const label = String(match[2] || "").trim();
  const split = label.indexOf(" - ");
  return {
    durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
    artist: split > 0 ? label.slice(0, split).trim() || null : null,
    title: (split > 0 ? label.slice(split + 3) : label).trim() || null,
  };
}

export function parseM3u(text: string, m3uPath: string) {
  const m3uDir = path.dirname(m3uPath);
  const entries: M3uEntry[] = [];
  let name: string | null = null;
  let pending: ReturnType<typeof parseExtinf> = null;
  for (const raw of String(text || "")
    .replace(/^﻿/, "")
    .split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      if (/^#EXTINF:/i.test(line)) pending = parseExtinf(line);
      else if (/^#PLAYLIST:/i.test(line)) name = line.slice(10).trim() || name;
      continue;
    }
    const entryPath = resolveEntryPath(line, m3uDir);
    if (entryPath) {
      entries.push({
        path: entryPath,
        artist: pending?.artist ?? null,
        title: pending?.title ?? null,
        durationMs: pending?.durationMs ?? null,
      });
    }
    pending = null;
  }
  return { name, entries };
}

// A file named playlist.m3u8 takes its folder's name, as players do.
export function playlistNameFor(m3uPath: string, declaredName: string | null) {
  if (declaredName) return declaredName;
  const base = path.basename(m3uPath, path.extname(m3uPath));
  return /^playlist$/i.test(base) ? path.basename(path.dirname(m3uPath)) : base;
}

export async function resolveImportFolder(folder: unknown) {
  const requested = String(folder ?? "").trim();
  if (!requested || !path.isAbsolute(requested)) {
    throw new M3uImportError("Enter the full path of the playlists folder.");
  }
  const stat = await fs.stat(requested).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new M3uImportError("The folder does not exist, or Aurral cannot read it.");
  }
  return fs.realpath(requested);
}

async function findPlaylistFiles(root: string, libraryRoot: string) {
  const found: string[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > MAX_SCAN_DEPTH || found.length >= MAX_PLAYLISTS) return;
    // Aurral writes its own Navidrome playlists inside the Library folder.
    if (dir === libraryRoot || isPathInsideRoot(dir, libraryRoot)) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && PLAYLIST_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        found.push(full);
        if (found.length >= MAX_PLAYLISTS) return;
      }
    }
  };
  await walk(root, 0);
  return found;
}

const exists = (filePath: string) =>
  fs
    .stat(filePath)
    .then((stat) => stat.isFile())
    .catch(() => false);

const realOrSelf = (filePath: string) => fs.realpath(filePath).catch(() => filePath);

export function findImportedPlaylist(m3uPath: string) {
  return (
    flowPlaylistConfig
      .getStaticPlaylists()
      .find(
        (playlist) =>
          playlist.importSource?.provider === M3U_PROVIDER &&
          playlist.importSource.externalId === m3uPath,
      ) || null
  );
}

export async function readM3u(m3uPath: string) {
  const text = await fs.readFile(m3uPath, "utf8");
  const parsed = parseM3u(text, m3uPath);
  return { ...parsed, name: playlistNameFor(m3uPath, parsed.name) };
}

export async function scanM3uFolder(folder: unknown) {
  const root = await resolveImportFolder(folder);
  const libraryRoot = await realOrSelf(path.resolve(resolveDownloadRoot()));
  const files = await findPlaylistFiles(root, libraryRoot);
  const playlists = [];
  for (const file of files) {
    try {
      const { name, entries } = await readM3u(file);
      let present = 0;
      let inLibrary = 0;
      for (const entry of entries) {
        const real = await realOrSelf(entry.path);
        if (await exists(real)) present += 1;
        if (isPathInsideRoot(real, libraryRoot)) inLibrary += 1;
      }
      playlists.push({
        path: file,
        name,
        trackCount: entries.length,
        filesFound: present,
        inLibrary,
        alreadyImported: Boolean(findImportedPlaylist(file)),
      });
    } catch (error) {
      logger.warn("playlist-import", "Could not read M3U playlist", {
        file,
        reason: safeLogDiagnostic(error),
      });
    }
  }
  return { folder: root, libraryRoot, playlists };
}

const text = (value: unknown) => {
  const result = String(Array.isArray(value) ? value[0] : (value ?? "")).trim();
  return result || null;
};

// Untagged files: "07 - Artist - Title" or "07 - Title" under Artist/Album.
function trackFromFileName(filePath: string) {
  const base = path.basename(filePath, path.extname(filePath));
  const parts = base.split(" - ").map((part) => part.trim());
  const number = /^\d{1,3}$/.test(parts[0] || "") ? Number(parts.shift()) : null;
  const folderArtist = path.basename(path.dirname(path.dirname(filePath)));
  const folderAlbum = path.basename(path.dirname(filePath));
  const artist = parts.length > 1 ? parts.shift()! : folderArtist;
  const albumPrefix = `${artist} - `;
  return {
    artistName: artist || null,
    trackName: parts.join(" - ") || base,
    albumName: folderAlbum.startsWith(albumPrefix)
      ? folderAlbum.slice(albumPrefix.length)
      : folderAlbum || null,
    trackNumber: number,
  };
}

export async function readTrackInfo(filePath: string, entry: M3uEntry | null = null) {
  const fallback = trackFromFileName(filePath);
  let tags: Awaited<ReturnType<typeof parseFile>> | null = null;
  try {
    tags = await parseFile(filePath, { duration: true, skipCovers: true });
  } catch {}
  const common = tags?.common;
  const artistName =
    text(common?.artist) || text(common?.albumartist) || entry?.artist || fallback.artistName;
  const trackName = text(common?.title) || entry?.title || fallback.trackName;
  if (!artistName || !trackName) return null;
  const seconds = Number(tags?.format?.duration);
  return {
    artistName,
    trackName,
    albumName: text(common?.album) || fallback.albumName,
    artistMbid: text(common?.musicbrainz_artistid),
    albumMbid: text(common?.musicbrainz_releasegroupid),
    trackMbid: text(common?.musicbrainz_recordingid),
    releaseYear: common?.year ? String(common.year) : null,
    durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
    trackNumber: common?.track?.no || fallback.trackNumber || null,
    discNumber: common?.disk?.no || null,
  };
}

// Where an ingest filed a source file: its new path, or the Library's
// existing copy when the file was a duplicate. Any earlier ingest counts, so
// a playlist pointing into another playlist's folder finds those copies.
function ingestTargetsFor(sourcePath: string) {
  return db
    .prepare<[string], { target_path: string | null }>(
      `SELECT target_path FROM library_file_operation_items
       WHERE source_path = ? AND status IN ('done', 'duplicate') AND target_path IS NOT NULL
       ORDER BY operation_id DESC, position DESC`,
    )
    .all(sourcePath)
    .map((row) => row.target_path!);
}

const isIndexedLibraryFile = (filePath: string) =>
  Boolean(
    db
      .prepare<[string], { id: number }>(
        "SELECT id FROM library_media_files WHERE path = ? AND available = 1 LIMIT 1",
      )
      .get(filePath),
  );

export async function buildM3uTracks(
  m3uPath: string,
  { downloadMissing = false }: { downloadMissing?: boolean } = {},
) {
  const { name, entries } = await readM3u(m3uPath);
  const libraryRoot = path.resolve(resolveDownloadRoot());
  const tracks: (PlaylistTrackInput & { canonicalJobId?: string })[] = [];
  const stats = { pinned: 0, byName: 0, skipped: 0, total: entries.length };
  for (const entry of entries) {
    const source = await realOrSelf(entry.path);
    try {
      let target = isPathInsideRoot(source, libraryRoot) ? source : null;
      for (const candidate of target ? [] : ingestTargetsFor(source)) {
        if (await exists(candidate)) {
          target = candidate;
          break;
        }
      }
      if (target && (await exists(target))) {
        const info = await readTrackInfo(target, entry);
        const job = info ? downloadTracker.ensureLibraryTrackJob(info, target) : null;
        if (info && job) {
          tracks.push({ ...info, canonicalJobId: job.id });
          stats.pinned += 1;
          continue;
        }
      }
      const sourceExists = await exists(source);
      // A file Aurral indexed in a read-only Library folder is reused by
      // name; anything else is only added when downloads are allowed.
      if (sourceExists && !downloadMissing && !isIndexedLibraryFile(source)) {
        stats.skipped += 1;
        continue;
      }
      const info = sourceExists
        ? await readTrackInfo(source, entry)
        : entry.artist && entry.title
          ? { artistName: entry.artist, trackName: entry.title, durationMs: entry.durationMs }
          : null;
      if (!info || (!sourceExists && !downloadMissing)) {
        stats.skipped += 1;
        continue;
      }
      tracks.push(info);
      stats.byName += 1;
    } catch (error) {
      stats.skipped += 1;
      logger.warn("playlist-import", "Could not read M3U entry", {
        file: entry.path,
        reason: safeLogDiagnostic(error),
      });
    }
  }
  return { name, tracks, stats };
}

const pendingSchema = v.array(
  v.object({
    m3uPath: v.string(),
    ownerUserId: v.number(),
    downloadMissing: v.boolean(),
    ingestOperationIds: v.array(v.number()),
  }),
);
type PendingImport = v.InferOutput<typeof pendingSchema>[number];

const readPending = () => dbOps.getJSONSetting(PENDING_SETTING, pendingSchema) ?? [];
const writePending = (pending: PendingImport[]) => dbOps.setJSONSetting(PENDING_SETTING, pending);

async function createPlaylistFromM3u({ m3uPath, ownerUserId, downloadMissing }: PendingImport) {
  if (findImportedPlaylist(m3uPath)) return { m3uPath, skipped: "already imported" };
  const { name, tracks, stats } = await buildM3uTracks(m3uPath, { downloadMissing });
  if (tracks.length === 0) return { m3uPath, name, skipped: "no tracks found", stats };
  const result = await enqueueImportedPlaylist({
    ownerUserId,
    name,
    sourceName: "M3U",
    provider: M3U_PROVIDER,
    externalId: m3uPath,
    externalName: name,
    tracks: tracks
      .map((track) => normalizePlaylistTrack(track))
      .filter((track): track is PlaylistTrack => Boolean(track)),
    syncEnabled: false,
    syncIntervalHours: 0,
    keepRemovedTracks: true,
  });
  logger.info("playlist-import", "M3U playlist imported", { m3uPath, name, ...stats });
  return { m3uPath, name, playlistId: result.playlistId, stats };
}

const OPERATION_FINISHED = new Set(["complete", "cancelled", "failed"]);

async function ingestFinished(operationIds: number[]) {
  const { getLibraryFileOperationStatus } = await import("../libraryFiles/operationStore.ts");
  return operationIds.every((id) => {
    const status = getLibraryFileOperationStatus(id)?.status;
    return !status || OPERATION_FINISHED.has(status);
  });
}

// Builds every waiting playlist whose ingest has finished. Safe to call any
// time: on ingest completion, and again from the import page in case Aurral
// restarted in between.
export async function completePendingM3uImports() {
  const pending = readPending();
  if (pending.length === 0) return [];
  const ready: PendingImport[] = [];
  for (const item of pending) {
    if (await ingestFinished(item.ingestOperationIds)) ready.push(item);
  }
  if (ready.length === 0) return [];
  writePending(
    readPending().filter((item) => !ready.some((done) => done.m3uPath === item.m3uPath)),
  );
  const results = [];
  for (const item of ready) {
    try {
      results.push(await createPlaylistFromM3u(item));
    } catch (error) {
      logger.error("playlist-import", "M3U playlist import failed", {
        m3uPath: item.m3uPath,
        reason: safeLogDiagnostic(error),
      });
    }
  }
  return results;
}

export async function importM3uPlaylists({
  folder,
  files,
  ownerUserId,
  copyTracks,
  downloadMissing,
}: {
  folder: unknown;
  files: string[];
  ownerUserId: number;
  copyTracks: boolean;
  downloadMissing: boolean;
}) {
  const root = await resolveImportFolder(folder);
  const chosen: string[] = [];
  for (const file of new Set(files)) {
    const real = await realOrSelf(path.resolve(String(file || "")));
    if (!isPathInsideRoot(real, root) || !PLAYLIST_EXTENSIONS.has(path.extname(real).toLowerCase()))
      throw new M3uImportError(`Not a playlist file in ${root}: ${file}`);
    if (!(await exists(real))) throw new M3uImportError(`Playlist file not found: ${file}`);
    chosen.push(real);
  }
  if (chosen.length === 0) throw new M3uImportError("Choose at least one playlist.");

  const ingests = new Map<string, number[]>();
  if (copyTracks) {
    const { startIngest } = await import("../libraryFiles/operations.ts");
    for (const dir of new Set(chosen.map((file) => path.dirname(file)))) {
      try {
        const operation = await startIngest({ sourcePath: dir, mode: "copy" });
        if (operation?.id) ingests.set(dir, [operation.id]);
      } catch (error) {
        // A folder the Library already covers needs no copy.
        logger.warn("playlist-import", "M3U folder not ingested", {
          folder: dir,
          reason: safeLogDiagnostic(error),
        });
      }
    }
  }

  const queued: PendingImport[] = chosen.map((m3uPath) => ({
    m3uPath,
    ownerUserId,
    downloadMissing,
    ingestOperationIds: ingests.get(path.dirname(m3uPath)) || [],
  }));
  const waiting = queued.filter((item) => item.ingestOperationIds.length > 0);
  if (waiting.length > 0) {
    const others = readPending().filter((item) => !chosen.includes(item.m3uPath));
    writePending([...others, ...waiting]);
  }
  const results = [];
  for (const item of queued.filter((entry) => entry.ingestOperationIds.length === 0)) {
    results.push(await createPlaylistFromM3u(item));
  }
  // An ingest with nothing new to copy can finish before we get here.
  results.push(...(await completePendingM3uImports()));
  return { imported: results, waitingForIngest: waiting.map((item) => item.m3uPath) };
}
