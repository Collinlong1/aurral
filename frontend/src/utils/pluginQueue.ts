import type { pluginAlbumPresentation } from "../../../backend/services/plugins/pluginPresentation.ts";
import { normalizeStreamQueueTrack } from "./audioQueue.ts";

type PluginQueueItem = NonNullable<
  Awaited<ReturnType<typeof pluginAlbumPresentation>>
>["groups"][number]["items"][number];

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
