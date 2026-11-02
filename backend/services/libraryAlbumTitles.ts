import path from "node:path";
import { parseFile } from "music-metadata";
import { db } from "../config/db-sqlite.ts";
import { asAppError } from "../../lib/errors.ts";
import { readRawLibraryMetadata } from "./libraryMetadata.ts";
import { markLibraryAlbumTitles, setLibraryAlbumCanonicalTitle } from "./libraryMediaStore.ts";
import { logger } from "./logger.ts";
import { getAlbumByMbid } from "./providers/brainzmashProvider.ts";

// Box sets tagged with one album title per disc share a release group, so
// they are one Library album. These passes give such an album the release
// group's own title instead of one disc's.

// Files sampled from each candidate album to compare their album tags.
const SAMPLE_FILES = 6;
// An album this large, or spread over several folders, may be a box set.
const LARGE_ALBUM_FILES = 40;
const LOOKUP_RETRY_MS = 24 * 60 * 60 * 1000;

type AlbumFiles = {
  id: number;
  metadata_json: string | null;
  paths: string[];
};

const albumTag = async (filePath: string) => {
  try {
    const { common } = await parseFile(filePath, { duration: false, skipCovers: true });
    return String(common.album || "").trim() || null;
  } catch {
    return null;
  }
};

const sample = <T>(items: T[], count: number) =>
  items.length <= count
    ? items
    : Array.from(
        { length: count },
        (_, index) => items[Math.round((index * (items.length - 1)) / (count - 1))],
      );

// Albums from before titles were kept stable never had their files compared;
// check each likely box set once.
export async function findMixedTitleAlbums() {
  const rows = db
    .prepare<[], { id: number; metadata_json: string | null; path: string }>(
      `SELECT album.id, album.metadata_json, media.path
       FROM library_albums album
       JOIN library_media_files media ON media.album_id = album.id AND media.available = 1
       WHERE album.release_group_mbid IS NOT NULL
       ORDER BY album.id, media.path`,
    )
    .all();
  const albums = new Map<number, AlbumFiles>();
  for (const row of rows) {
    const album = albums.get(row.id) ?? { id: row.id, metadata_json: row.metadata_json, paths: [] };
    album.paths.push(row.path);
    albums.set(row.id, album);
  }
  let flagged = 0;
  for (const album of albums.values()) {
    const metadata = readRawLibraryMetadata(album.metadata_json);
    if (metadata.canonicalTitle || metadata.mixedTitles || metadata.titlesChecked) continue;
    const folders = new Set(album.paths.map((filePath) => path.dirname(filePath)));
    if (folders.size < 2 && album.paths.length <= LARGE_ALBUM_FILES) continue;
    const firstPerFolder = [...folders].map((folder) =>
      album.paths.find((filePath) => path.dirname(filePath) === folder)!,
    );
    const titles = new Set<string>();
    for (const filePath of sample(folders.size > 1 ? firstPerFolder : album.paths, SAMPLE_FILES)) {
      const title = await albumTag(filePath);
      if (title) titles.add(title);
    }
    if (titles.size > 1) {
      markLibraryAlbumTitles(album.id, { mixedTitles: true });
      flagged += 1;
    } else {
      markLibraryAlbumTitles(album.id, { titlesChecked: true });
    }
  }
  return flagged;
}

type ReleaseGroupLookup = (mbid: string) => Promise<{ title?: string | null } | null>;

// A box set's own folder, when all its discs sit under one folder other than
// its artist's: "Decca Sound_ The Analogue Years" for files tagged per disc.
// Taggers write ": " as "_ " in folder names.
function boxSetFolderTitle(albumId: number, albumArtist: string | null) {
  const paths = db
    .prepare<[number], { path: string }>(
      "SELECT path FROM library_media_files WHERE album_id = ? AND available = 1",
    )
    .all(albumId)
    .map((row) => path.dirname(row.path).split(path.sep));
  if (paths.length === 0) return null;
  const shared: string[] = [];
  for (let index = 0; index < paths[0].length; index++) {
    if (!paths.every((parts) => parts[index] === paths[0][index])) break;
    shared.push(paths[0][index]);
  }
  const spread = paths.some((parts) => parts.length > shared.length);
  const folder = (shared.at(-1) || "").replaceAll("_ ", ": ").trim();
  if (!spread || !folder) return null;
  const sameAsArtist = (name: string | null) =>
    Boolean(name) && folder.toLowerCase() === String(name).trim().toLowerCase();
  return sameAsArtist(albumArtist) ? null : folder;
}

// Names each flagged album after its MusicBrainz release group, or after the
// box set's folder when MusicBrainz does not have it.
export async function nameMixedTitleAlbums(lookup: ReleaseGroupLookup = getAlbumByMbid) {
  const albums = db
    .prepare<
      [],
      {
        id: number;
        release_group_mbid: string | null;
        metadata_json: string | null;
        album_artist: string | null;
      }
    >(
      `SELECT id, release_group_mbid, metadata_json, album_artist FROM library_albums
       WHERE release_group_mbid IS NOT NULL
         AND json_extract(metadata_json, '$.mixedTitles') = 1
         AND json_extract(metadata_json, '$.canonicalTitle') IS NULL`,
    )
    .all();
  let renamed = 0;
  for (const album of albums) {
    const metadata = readRawLibraryMetadata(album.metadata_json);
    if (Number(metadata.titleLookupAt) > Date.now() - LOOKUP_RETRY_MS) continue;
    let title = "";
    try {
      const releaseGroup = await lookup(album.release_group_mbid!);
      title = String(releaseGroup?.title || "").trim();
    } catch (error) {
      const failure = asAppError(error);
      if (failure?.code === "ERR_METADATA_COOLDOWN") break;
      if (failure?.response?.status !== 404) {
        logger.warn("library", "Stopped naming box sets; metadata provider unavailable", {
          message: failure?.message || String(error),
        });
        break;
      }
    }
    title ||= boxSetFolderTitle(album.id, album.album_artist) || "";
    if (title && setLibraryAlbumCanonicalTitle(album.id, title)) {
      renamed += 1;
      continue;
    }
    markLibraryAlbumTitles(album.id, { titleLookupAt: Date.now() });
  }
  return renamed;
}

export async function settleMixedAlbumTitles() {
  await findMixedTitleAlbums();
  return (await nameMixedTitleAlbums()) > 0;
}
