import * as v from "valibot";
import type { RequestUser } from "../../middleware/requestUser.ts";
import { albumTarget } from "./pluginContext.ts";
import { callPlugin, PluginError } from "./pluginHost.ts";
import { activePlugin, activePlugins, isCapabilityOn, pluginInput } from "./pluginStore.ts";
import { PluginRequestError } from "./pluginService.ts";

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
});
const movement = v.object({ id, title: text(), position: v.pipe(v.number(), v.integer()) });
const credit = v.object({
  role: text(80),
  instrument: v.nullable(text(200)),
  id,
  name: text(),
});
const recording = v.object({
  id,
  label: text(),
  albumId: v.optional(v.nullable(id), null),
  recordingIds: v.pipe(v.array(id), v.maxLength(100)),
  credits: v.pipe(v.array(credit), v.maxLength(100)),
  items: v.pipe(v.array(queueItem), v.maxLength(500)),
  missing: v.pipe(v.array(movement), v.maxLength(200)),
  complete: v.boolean(),
});
const workView = v.object({
  version: v.literal(1),
  work: v.object({
    id,
    title: text(),
    nickname: text(),
    description: text(10000),
    credits: v.pipe(v.array(credit), v.maxLength(100)),
    movements: v.pipe(v.array(movement), v.maxLength(200)),
    collections: v.pipe(v.array(v.object({ id, title: text() })), v.maxLength(100)),
  }),
  favourite: v.boolean(),
  pickedRealizationId: v.nullable(id),
  pickScope: v.nullable(v.picklist(["user", "admin"])),
  adminPickId: v.optional(v.nullable(id), null),
  recordings: v.pipe(v.array(recording), v.maxLength(200)),
});
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
          items: v.pipe(v.array(queueItem), v.minLength(1), v.maxLength(500)),
          missing: v.pipe(v.array(movement), v.maxLength(200)),
          movementCount: v.pipe(v.number(), v.integer(), v.minValue(1)),
          // A short note under the heading, such as why a block has no work page.
          detail: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(200))),
        }),
      ),
      v.maxLength(200),
    ),
  }),
);
const mutationSchema = v.object({
  command: v.picklist(["favourite", "pick", "admin-pick"]),
  value: v.optional(v.boolean()),
  realizationId: v.optional(v.nullable(id)),
});
const mutationResult = v.object({ ok: v.literal(true) });

function realUser(user: RequestUser) {
  if (!Number.isSafeInteger(user.id) || user.id <= 0)
    throw new PluginRequestError(403, "A real user account is required");
}

function playableItems<
  Item extends { trackId: string; albumId: string; startMs: number; endMs: number | null },
>(items: Item[], expectedAlbumId?: string) {
  const albums = new Map<string, ReturnType<typeof albumTarget>>();
  return items.map((item) => {
    if (expectedAlbumId !== undefined && item.albumId !== expectedAlbumId)
      throw new PluginRequestError(502, "Plugin returned a track from another album");
    if (item.endMs !== null && item.endMs <= item.startMs)
      throw new PluginRequestError(502, "Plugin returned an invalid playback range");
    const numericTrackId = Number(item.trackId);
    if (!Number.isSafeInteger(numericTrackId) || numericTrackId <= 0)
      throw new PluginRequestError(502, "Plugin returned an invalid library track reference");
    let album = albums.get(item.albumId);
    if (!album) {
      try {
        album = albumTarget(item.albumId);
      } catch {
        throw new PluginRequestError(502, "Plugin returned an unavailable album reference");
      }
      albums.set(item.albumId, album);
    }
    if (!album.tracks.some((track) => Number(track.id) === numericTrackId && track.path))
      throw new PluginRequestError(502, "Plugin returned a track outside its album");
    return {
      ...item,
      streamPath: `/library/stream/${encodeURIComponent(item.albumId)}/${encodeURIComponent(item.trackId)}`,
    };
  });
}

function hydrateWork(view: v.InferOutput<typeof workView>) {
  return {
    ...view,
    recordings: view.recordings.map((recording) => ({
      ...recording,
      items: playableItems(recording.items),
    })),
  };
}

function bounded<T>(value: T) {
  if (Buffer.byteLength(JSON.stringify(value)) > 512000)
    throw new PluginRequestError(502, "Plugin presentation is too large");
  return value;
}

export async function readPluginResource(
  user: RequestUser,
  pluginId: string,
  pageId: string,
  resourceId: string,
) {
  realUser(user);
  const plugin = activePlugin(pluginId);
  const page = plugin?.manifest.pages.find((entry) => entry.id === pageId && !entry.admin);
  if (!plugin || !page || !isCapabilityOn(plugin, `page:${pageId}`))
    throw new PluginRequestError(404, "Plugin page is unavailable or disabled");
  try {
    const view = await callPlugin(
      plugin,
      {
        path: "pages.read",
        input: {
          ...pluginInput(plugin),
          pageId,
          resourceId,
          capabilities: { resourceView: 1 },
          user: { id: user.id, username: user.username, role: user.role },
        },
      },
      workView,
      15000,
    );
    return bounded(hydrateWork(view));
  } catch (error) {
    if (error instanceof PluginError)
      throw new PluginRequestError(502, `Plugin page: ${error.message}`);
    throw error;
  }
}

export async function mutatePluginResource(
  user: RequestUser,
  pluginId: string,
  pageId: string,
  resourceId: string,
  mutation: v.InferOutput<typeof mutationSchema>,
) {
  realUser(user);
  if (mutation.command === "admin-pick" && user.role !== "admin")
    throw new PluginRequestError(403, "Only admins can set the server pick");
  const plugin = activePlugin(pluginId);
  const page = plugin?.manifest.pages.find((entry) => entry.id === pageId && !entry.admin);
  if (!plugin || !page || !isCapabilityOn(plugin, `page:${pageId}`))
    throw new PluginRequestError(404, "Plugin page is unavailable or disabled");
  try {
    return await callPlugin(
      plugin,
      {
        path: "pages.mutate",
        input: {
          ...pluginInput(plugin),
          pageId,
          resourceId,
          capabilities: { resourceView: 1 },
          user: { id: user.id, username: user.username, role: user.role },
          mutation,
        },
      },
      mutationResult,
      15000,
    );
  } catch (error) {
    if (error instanceof PluginError)
      throw new PluginRequestError(502, `Plugin page: ${error.message}`);
    throw error;
  }
}

export async function pluginAlbumPresentation(user: RequestUser, albumId: string) {
  realUser(user);
  const album = albumTarget(albumId);
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
      const firstPosition = (group: (typeof result.groups)[number]) =>
        Math.min(...group.items.map((item) => position.get(item.trackId) ?? Infinity));
      return bounded({
        pluginId: plugin.id,
        ...result,
        groups: result.groups
          .map((group) => ({
            ...group,
            href: group.workId ? `/plugins/${plugin.id}/work/${group.workId}` : null,
            items: playableItems(group.items, String(album.id)),
          }))
          .sort((a, b) => firstPosition(a) - firstPosition(b)),
      });
    } catch {
      // Album pages retain their stock presentation when an optional contribution fails.
    }
  }
  return null;
}

export { mutationSchema as pluginResourceMutation };
