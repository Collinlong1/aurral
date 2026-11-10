import path from "path";
import { db } from "../../config/db-sqlite.ts";
import { buildLibraryArtworkUrl, getLibraryArtworkVersions } from "../libraryArtwork.ts";
import { buildCustomArtworkUrl, getCustomArtworkMap } from "../customArtworkService.ts";

type CoverJob = { id: string; status?: string | null; finalPath?: string | null };

const albumIdsByPathStmt = db.prepare<[string], { path: string; album_id: number }>(
  `SELECT path, album_id FROM library_media_files
    WHERE album_id IS NOT NULL AND path IN (SELECT value FROM json_each(?))`,
);

// The Library album cover for each finished track whose file is in the Library,
// the same art the Library shows: a custom cover, the album folder's cover
// file, or the art in the files. A playlist row falls back to it when it has no
// other artwork, so a track imported or linked from a file is not left blank.
export function getLibraryCoverUrlsForJobs(jobs: readonly CoverJob[]) {
  const pathByJob = new Map<string, string>();
  for (const job of jobs) {
    if (job.status === "done" && job.finalPath) {
      pathByJob.set(String(job.id), path.resolve(job.finalPath));
    }
  }
  const covers = new Map<string, string>();
  if (pathByJob.size === 0) return covers;
  const albumByPath = new Map(
    albumIdsByPathStmt
      .all(JSON.stringify([...new Set(pathByJob.values())]))
      .map((row) => [row.path, row.album_id]),
  );
  const albumIds = [...new Set(albumByPath.values())];
  if (albumIds.length === 0) return covers;
  const versions = getLibraryArtworkVersions("album", albumIds);
  const custom = getCustomArtworkMap("album", albumIds);
  for (const [jobId, filePath] of pathByJob) {
    const albumId = albumByPath.get(filePath);
    if (albumId == null) continue;
    const customVersion = custom.get(String(albumId));
    covers.set(
      jobId,
      customVersion
        ? buildCustomArtworkUrl("album", albumId, customVersion)
        : buildLibraryArtworkUrl("album", albumId, versions.get(String(albumId))),
    );
  }
  return covers;
}
