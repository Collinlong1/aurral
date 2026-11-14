import { normalizeStreamQueueTrack } from "./audioQueue.ts";

// What a plugin's playable item needs to play: album and resource pages both
// send these (pluginPresentation.ts).
type PluginQueueItem = {
  id: string;
  trackId: string;
  albumId: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number | null;
  startMs: number;
  endMs: number | null;
  streamPath: string;
};

export const pluginItemDurationMs = (item: PluginQueueItem) =>
  item.endMs != null ? item.endMs - item.startMs : item.durationMs;

export function pluginQueueTrack(item: PluginQueueItem, workTitle: string) {
  return normalizeStreamQueueTrack({
    id: item.id,
    libraryTrackId: item.trackId,
    libraryAlbumId: item.albumId,
    title:
      !workTitle || item.title.startsWith(workTitle) ? item.title : `${workTitle}: ${item.title}`,
    artist: item.artist,
    album: item.album,
    durationMs: pluginItemDurationMs(item),
    segmentStartMs: item.startMs,
    segmentEndMs: item.endMs,
    streamPath: item.streamPath,
    recordHistory: true,
  });
}
