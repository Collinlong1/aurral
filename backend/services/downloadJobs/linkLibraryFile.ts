import fs from "fs/promises";
import path from "path";
import { db } from "../../config/db-sqlite.ts";
import { resolveDownloadRoot } from "../downloadPaths.ts";
import { downloadTracker, type DownloadJob } from "./downloadTracker.ts";
import { noPlaylistDownloadedFile, refreshPlaylistAfterReuse } from "./fileReuse.ts";
import { restoreDownloadJobCancellations } from "./downloadCancellation.ts";

// A missing track can be linked to a file that is already in the Library, so
// Aurral stops searching for it. The file stays where it is and is treated as
// reused: removing the track or its playlist never deletes it.

export class LinkLibraryFileError extends Error {
  readonly status: 404 | 409;
  constructor(message: string, status: 404 | 409) {
    super(message);
    this.status = status;
  }
}

export type LibraryFileMatch = {
  fileId: number;
  title: string;
  artistName: string | null;
  albumTitle: string | null;
  format: string | null;
  durationMs: number | null;
};

const SEARCH_LIMIT = 25;
const MAX_TERMS = 6;

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (match) => `\\${match}`);

// Finds available Library files for a query, best match first: files whose
// title, artist, or album contain more of the query's words rank higher, so
// "Neon Coast (Radio Edit)" still finds "Neon Coast". Punctuation is ignored.
export function searchLibraryFiles(query: string, limit = SEARCH_LIMIT): LibraryFileMatch[] {
  const terms = [
    ...new Set(
      String(query || "")
        .toLowerCase()
        .split(/[^\p{L}\p{N}']+/u)
        .filter((term) => term.length > 1 || /\p{N}/u.test(term)),
    ),
  ].slice(0, MAX_TERMS);
  if (terms.length === 0) return [];
  const matches = terms.map(
    () =>
      "(CASE WHEN t.title LIKE ? ESCAPE '\\' OR COALESCE(f.artist_tag, t.artist_name, '') LIKE ? ESCAPE '\\' OR COALESCE(a.title, '') LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)",
  );
  const params = terms.flatMap((term) => {
    const pattern = `%${escapeLike(term)}%`;
    return [pattern, pattern, pattern];
  });
  return db
    .prepare<unknown[], LibraryFileMatch>(
      `SELECT fileId, title, artistName, albumTitle, format, durationMs FROM (
         SELECT f.id AS fileId, t.title AS title,
                COALESCE(f.artist_tag, t.artist_name) AS artistName,
                a.title AS albumTitle, f.format AS format, f.duration_ms AS durationMs,
                ${matches.join(" + ")} AS score
           FROM library_media_files f
           JOIN library_tracks t ON t.id = f.track_id
           LEFT JOIN library_albums a ON a.id = f.album_id
          WHERE f.available = 1)
        WHERE score > 0
        ORDER BY score DESC, title COLLATE NOCASE, artistName COLLATE NOCASE, fileId
        LIMIT ?`,
    )
    .all(...params, Math.max(1, Math.min(limit, 100)));
}

// Tracks that can be linked: missing ones in Wanted, and ones saved without a
// download.
export const canLinkLibraryFile = (job: DownloadJob | null | undefined): job is DownloadJob =>
  (job?.status === "saved" && !job.upgradeForJobId) || downloadTracker.isWantedMissing(job);

export async function linkLibraryFileToJob(jobId: string, fileId: number) {
  const job = downloadTracker.getJob(jobId);
  if (!job) throw new LinkLibraryFileError("Track not found", 404);
  if (!canLinkLibraryFile(job)) {
    throw new LinkLibraryFileError("Only a missing track can be linked to a file", 409);
  }
  const file = db
    .prepare<[number], { path: string; source: string; albumTitle: string | null }>(
      `SELECT f.path AS path, f.source AS source, a.title AS albumTitle
         FROM library_media_files f
         LEFT JOIN library_albums a ON a.id = f.album_id
        WHERE f.id = ? AND f.available = 1`,
    )
    .get(fileId);
  if (!file) throw new LinkLibraryFileError("Library file not found", 404);
  const finalPath = path.resolve(file.path);
  const stat = await fs.stat(finalPath).catch(() => null);
  if (!stat?.isFile()) {
    throw new LinkLibraryFileError("Aurral cannot read that file. Rescan the Library.", 409);
  }
  if (job.status === "cancelled") restoreDownloadJobCancellations([job.id]);
  const downloadRoot = path.resolve(resolveDownloadRoot());
  const linked = downloadTracker.setDone(
    job.id,
    finalPath,
    file.albumTitle || job.albumName || null,
    file.source === "aurral" ? null : file.path,
    { reusedLibraryFile: noPlaylistDownloadedFile(finalPath, job.id, downloadRoot) },
  );
  if (!linked) throw new LinkLibraryFileError("Only a missing track can be linked to a file", 409);
  await refreshPlaylistAfterReuse(job.playlistType, job.playlistType === "library", [finalPath]);
  return downloadTracker.getJob(job.id);
}

export type LinkLibraryFileResult =
  | { ok: true; status: string }
  | { ok: false; status: 404 | 409; error: string };

// The same as linkLibraryFileToJob, as a plain result that can be sent
// between processes.
export async function runLinkLibraryFile(
  jobId: string,
  fileId: number,
): Promise<LinkLibraryFileResult> {
  try {
    const job = await linkLibraryFileToJob(jobId, fileId);
    return { ok: true, status: job?.status ?? "done" };
  } catch (error) {
    if (error instanceof LinkLibraryFileError) {
      return { ok: false, status: error.status, error: error.message };
    }
    throw error;
  }
}
