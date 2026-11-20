// The album part of the aurral-classical branch's plugin presentation
// (pluginPresentation.ts there), unchanged except as noted: a plugin groups a
// Library album's tracks into works for the album page's By work view. The
// work pages, saved queues and resource views stay on that branch.
import * as v from "valibot";
import type { RequestUser } from "../../middleware/requestUser.ts";
import { logger } from "../logger.ts";
import { albumTarget, PluginTargetMissing } from "./pluginContext.ts";
import { pluginItemLinks, pluginLink, resolvedItemLinks } from "./pluginLinks.ts";
import { callPlugin } from "./pluginHost.ts";
import { activePlugins, isCapabilityOn, pluginInput } from "./pluginStore.ts";
import { PluginRequestError } from "./pluginService.ts";

// Box sets run past a thousand tracks, often one piece per track, so an
// album's groups and their items are bounded by album size, not work size.
const ALBUM_TRACKS = 5000;
const text = (max = 500) => v.pipe(v.string(), v.maxLength(max));
const id = text(200);
const queueItem = v.object({
  id,
  trackId: id,
  fileId: id,
  albumId: id,
  title: text(),
  artist: text(),
  // Who plays, when the plugin can tell it from the artist.
  performer: v.optional(text()),
  album: text(),
  durationMs: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
  startMs: v.pipe(v.number(), v.integer(), v.minValue(0)),
  endMs: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
  // The work's movements this item plays, for comparing one movement.
  movementIds: v.optional(v.pipe(v.array(id), v.maxLength(50)), []),
  // Up to six labelled links (a work page, an album, a filtered search).
  links: pluginItemLinks,
});
const movement = v.object({ id, title: text(), position: v.pipe(v.number(), v.integer()) });
const albumPresentationSchema = v.nullable(
  v.object({
    version: v.literal(1),
    albumId: id,
    supportsToggle: v.literal(true),
    groups: v.pipe(
      v.array(
        // A group is a work, or a single piece with no work page.
        v.object({
          id,
          workId: v.nullable(id),
          title: text(),
          composer: text(),
          items: v.pipe(v.array(queueItem), v.minLength(1), v.maxLength(ALBUM_TRACKS)),
          missing: v.pipe(v.array(movement), v.maxLength(200)),
          movementCount: v.pipe(v.number(), v.integer(), v.minValue(1)),
          // A short note under the heading, such as why a block has no work page.
          detail: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200))),
          links: pluginItemLinks,
        }),
      ),
      v.maxLength(ALBUM_TRACKS),
    ),
  }),
);
// `favourite-item`, `save-queue` and `delete-queue` are for view 2 pages:
// a favourite on any item a page shows, and a person's saved queues.
function realUser(user: RequestUser) {
  if (!Number.isSafeInteger(user.id) || user.id <= 0)
    throw new PluginRequestError(403, "A real user account is required");
}

type AlbumTarget = ReturnType<typeof albumTarget>;
// Each album is read once per response, however many groups name it. An
// album that no longer exists has no playable tracks.
type PlayableAlbums = Map<string, Set<number>>;
const playableTracks = (album: AlbumTarget) =>
  new Set(album.tracks.filter((track) => track.path).map((track) => Number(track.id)));

// The plugin's catalogue follows the Library only after its next scan, and a
// retag gives a track or album a new id, so an item can name a track that is
// gone. Drop those; a malformed reference or range is still a plugin bug.
function playableItems<
  Item extends {
    trackId: string;
    albumId: string;
    startMs: number;
    endMs: number | null;
    links: { label: string; link: v.InferOutput<typeof pluginLink> }[];
  },
>(pluginId: string, items: Item[], albums: PlayableAlbums, expectedAlbumId?: string) {
  return items.flatMap((item) => {
    if (expectedAlbumId !== undefined && item.albumId !== expectedAlbumId)
      throw new PluginRequestError(502, "Plugin returned a track from another album");
    if (item.endMs !== null && item.endMs <= item.startMs)
      throw new PluginRequestError(502, "Plugin returned an invalid playback range");
    const numericTrackId = Number(item.trackId);
    if (!Number.isSafeInteger(numericTrackId) || numericTrackId <= 0)
      throw new PluginRequestError(502, "Plugin returned an invalid library track reference");
    let playable = albums.get(item.albumId);
    if (!playable) {
      try {
        playable = playableTracks(albumTarget(item.albumId));
      } catch (error) {
        if (!(error instanceof PluginTargetMissing))
          throw new PluginRequestError(502, "Plugin returned an unavailable album reference");
        playable = new Set();
      }
      albums.set(item.albumId, playable);
    }
    if (!playable.has(numericTrackId)) return [];
    return [
      {
        ...item,
        links: resolvedItemLinks(pluginId, item.links),
        streamPath: `/library/stream/${encodeURIComponent(item.albumId)}/${encodeURIComponent(item.trackId)}`,
      },
    ];
  });
}

function logDropped(pluginId: string, before: number, after: number) {
  if (before > after)
    logger.info(`plugin:${pluginId}`, "Left out items whose tracks are no longer in the Library", {
      dropped: before - after,
    });
}
function bounded<T>(value: T, maxBytes = 512000) {
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes)
    throw new PluginRequestError(502, "Plugin presentation is too large");
  return value;
}

export async function pluginAlbumPresentation(user: RequestUser, albumId: string) {
  realUser(user);
  const album = albumTarget(albumId);
  let failed = false;
  for (const plugin of activePlugins()) {
    if (!plugin.manifest.albumPresentation || !isCapabilityOn(plugin, "albumPresentation"))
      continue;
    try {
      const result = await callPlugin(
        plugin,
        {
          path: "albumPresentation",
          input: {
            ...pluginInput(plugin),
            // Changed from the branch: no itemLinks, since there are no work
            // pages here for the links to open.
            capabilities: { albumPresentation: 1 },
            user: { id: user.id, username: user.username, role: user.role },
            album,
          },
        },
        albumPresentationSchema,
        5000,
      );
      if (!result) continue;
      // album.tracks is in disc and track order; groups follow the album.
      const position = new Map(album.tracks.map((track, index) => [String(track.id), index]));
      const firstPosition = (group: { items: { trackId: string }[] }) =>
        Math.min(...group.items.map((item) => position.get(item.trackId) ?? Infinity));
      const albums: PlayableAlbums = new Map([[String(album.id), playableTracks(album)]]);
      const groups = result.groups.flatMap((group) => {
        const items = playableItems(plugin.id, group.items, albums, String(album.id));
        if (!items.length) return [];
        // Changed from the branch: headings link nowhere (no work pages here).
        const href = null;
        return [{ ...group, href, items, links: resolvedItemLinks(plugin.id, group.links) }];
      });
      logDropped(
        plugin.id,
        result.groups.reduce((total, group) => total + group.items.length, 0),
        groups.reduce((total, group) => total + group.items.length, 0),
      );
      return bounded(
        {
          pluginId: plugin.id,
          ...result,
          groups: groups.sort((a, b) => firstPosition(a) - firstPosition(b)),
        },
        // About 400 bytes a track, for the largest box sets.
        ALBUM_TRACKS * 1000,
      );
    } catch {
      failed = true;
    }
  }
  // The album page keeps its track list either way; a failure says so, so
  // the page can offer a retry instead of looking like a plain album.
  if (failed) throw new PluginRequestError(502, "Plugin album presentation failed");
  return null;
}
