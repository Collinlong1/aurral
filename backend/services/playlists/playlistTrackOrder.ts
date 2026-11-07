import { flowPlaylistConfig } from "./flowPlaylistConfig.ts";
import { playlistJobEntries } from "./playlistJobs.ts";
import { playlistManager } from "./playlistManager.ts";

export class PlaylistOrderError extends Error {}

// Puts a static playlist's tracks in the order of `jobIds`, the track rows as
// the playlist page shows them. `jobIds` must name every track row once, so an
// order made from a stale page is refused instead of dropping or duplicating
// tracks. Playlist entries without a row keep their place.
export function reorderStaticPlaylistTracks(playlistId: string, jobIds: readonly string[]) {
  const playlist = flowPlaylistConfig.getStaticPlaylist(playlistId);
  if (!playlist) return null;
  const trackIndexByJobId = new Map(
    playlistJobEntries(playlist)
      .filter(({ trackIndex }) => trackIndex >= 0)
      .map(({ job, trackIndex }) => [String(job.id), trackIndex]),
  );
  // Rows without a playlist entry are listed last and have no place to keep.
  const requested = jobIds.map(String).filter((jobId) => trackIndexByJobId.has(jobId));
  if (new Set(requested).size !== requested.length || requested.length !== trackIndexByJobId.size) {
    throw new PlaylistOrderError("The playlist changed. Reload it and try again.");
  }
  const slots = [...trackIndexByJobId.values()].sort((left, right) => left - right);
  const tracks = [...playlist.tracks];
  requested.forEach((jobId, position) => {
    const slot = slots[position];
    const track = playlist.tracks[trackIndexByJobId.get(jobId)!];
    if (slot !== undefined && track) tracks[slot] = track;
  });
  if (tracks.every((track, index) => track === playlist.tracks[index])) return playlist;
  const next = flowPlaylistConfig.updateStaticPlaylist(playlistId, { tracks });
  // The playlist file follows the new order.
  playlistManager.requestPlaylistSync([playlistId]);
  return next;
}
