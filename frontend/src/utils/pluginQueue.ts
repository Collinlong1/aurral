import { ExternalLink } from "../components/icons";
import { normalizeStreamQueueTrack, type QueueTrackLink } from "./audioQueue.ts";

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
  links?: QueueTrackLink[];
};

// A queued track that plays only part of its file (one movement of a track
// holding several). Playlists hold whole files, so adding one adds all of it.
export const isPartOfTrack = (track: {
  segmentStartMs?: number | null;
  segmentEndMs?: number | null;
}) => (track.segmentStartMs ?? 0) > 0 || track.segmentEndMs != null;

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
    links: item.links,
    recordHistory: true,
  });
}

// A plugin item's links (pluginLinks.ts) as menu entries, each place once.
export const pluginLinkMenuItems = (links: QueueTrackLink[] | null | undefined) =>
  (links ?? [])
    .filter((link, at, all) => all.findIndex((other) => other.href === link.href) === at)
    .map((link, at) => ({
      id: `plugin-link-${at}`,
      label: link.label,
      icon: ExternalLink,
      separatorBefore: at === 0,
      to: link.href,
    }));
