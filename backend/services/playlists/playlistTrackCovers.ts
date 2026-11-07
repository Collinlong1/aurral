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

type LibraryTrackInfo = { trackName: string; artistName: string | null; albumName: string | null };

const libraryTrackInfoByPathStmt = db.prepare<
  [string],
  { path: string; title: string; artist_name: string | null; album_title: string | null }
>(
  `SELECT media.path, track.title,
          COALESCE(NULLIF(TRIM(track.artist_name), ''), artist.name) AS artist_name,
          album.title AS album_title
     FROM library_media_files AS media
     JOIN library_tracks AS track ON track.id = media.track_id
     LEFT JOIN library_albums AS album ON album.id = media.album_id
     LEFT JOIN library_artists AS artist ON artist.id = album.artist_id
    WHERE media.available = 1 AND media.path IN (SELECT value FROM json_each(?))`,
);

// The title, artist, and album the Library holds now for each finished track whose file is
// in the Library. A playlist row was named when the track was added, often the way an import
// service spells it, so it shows these instead and follows re-tags and rescans like the
// Library does.
export function getLibraryTrackInfoForJobs(jobs: readonly CoverJob[]) {
  const pathByJob = new Map<string, string>();
  for (const job of jobs) {
    if (job.status === "done" && job.finalPath) {
      pathByJob.set(String(job.id), path.resolve(job.finalPath));
    }
  }
  const info = new Map<string, LibraryTrackInfo>();
  if (pathByJob.size === 0) return info;
  const byPath = new Map(
    libraryTrackInfoByPathStmt
      .all(JSON.stringify([...new Set(pathByJob.values())]))
      .map((row) => [row.path, row]),
  );
  for (const [jobId, filePath] of pathByJob) {
    const row = byPath.get(filePath);
    if (!row?.title) continue;
    info.set(jobId, {
      trackName: row.title,
      artistName: row.artist_name || null,
      albumName: row.album_title || null,
    });
  }
  return info;
}
