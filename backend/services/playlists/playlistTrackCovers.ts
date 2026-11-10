import path from "path";
import { db } from "../../config/db-sqlite.ts";

type LibraryJob = { id: string; status?: string | null; finalPath?: string | null };

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
export function getLibraryTrackInfoForJobs(jobs: readonly LibraryJob[]) {
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
