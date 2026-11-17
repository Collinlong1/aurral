import { randomUUID } from "node:crypto";
import * as v from "valibot";
import { getLibraryForTrackIds } from "../libraryQueryService.ts";
import { playlistOperationQueue } from "../playlists/playlistOperationQueue.ts";
import type { RequestUser } from "../../middleware/requestUser.ts";
import { logger } from "../logger.ts";
import { albumTarget, PluginTargetMissing } from "./pluginContext.ts";
import {
  hrefFor,
  parseFilters,
  pluginItemLinks,
  pluginLink,
  resolvedItemLinks,
  resolvedLink,
} from "./pluginLinks.ts";
import { callPlugin, PluginError } from "./pluginHost.ts";
import { activePlugin, activePlugins, isCapabilityOn, pluginInput } from "./pluginStore.ts";
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
const credit = v.object({
  role: text(80),
  instrument: v.nullable(text(200)),
  id,
  name: text(),
});
const positiveMs = v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1)));
const recording = v.object({
  id,
  label: text(),
  albumId: v.optional(v.nullable(id), null),
  // Optional comparison details: who plays, when, on which label, how long
  // each movement lasts, and every release the recording appears on.
  performer: v.optional(text(), ""),
  year: v.optional(
    v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1000), v.maxValue(3000))),
    null,
  ),
  recordLabel: v.optional(text(200), ""),
  durationMs: v.optional(positiveMs, null),
  parts: v.optional(
    v.pipe(v.array(v.object({ movementId: id, durationMs: positiveMs })), v.maxLength(200)),
    [],
  ),
  releases: v.optional(
    v.pipe(
      v.array(v.object({ albumId: id, album: text(), realizationId: v.optional(id) })),
      v.maxLength(50),
    ),
    [],
  ),
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
const mutationSchema = v.pipe(
  v.object({
    command: v.picklist([
      "favourite",
      "pick",
      "admin-pick",
      "favourite-item",
      "save-queue",
      "delete-queue",
    ]),
    value: v.optional(v.boolean()),
    realizationId: v.optional(v.nullable(id)),
    target: v.optional(id),
    name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200))),
    itemIds: v.optional(v.pipe(v.array(id), v.minLength(1), v.maxLength(500))),
  }),
  v.check(
    (m) =>
      (m.command !== "favourite-item" && m.command !== "delete-queue") ||
      typeof m.target === "string",
    "Choose what to change",
  ),
  v.check(
    (m) => m.command !== "save-queue" || (!!m.name && !!m.itemIds),
    "Name the queue and choose its items",
  ),
);

// View 2: any page a plugin builds from bounded, typed sections. Core
// renders every section with its own components and builds every link.
const viewKey = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{1,40}$/));
const count = v.pipe(v.number(), v.integer(), v.minValue(0));
const viewLink = v.optional(v.nullable(pluginLink), null);
const viewRow = v.object({
  id,
  label: text(),
  detail: v.optional(text(), ""),
  badge: v.optional(text(80), ""),
  link: viewLink,
});
const viewFact = v.object({ label: text(80), value: text(), link: viewLink });
const viewAction = v.pipe(
  v.object({
    label: text(80),
    link: viewLink,
    mutation: v.optional(v.nullable(mutationSchema), null),
    pressed: v.optional(v.boolean()),
  }),
  v.check((a) => !a.link !== !a.mutation, "An action has a link or a mutation"),
);
const sectionTitle = v.optional(text(200), "");
const viewSection = v.variant("type", [
  v.object({
    type: v.literal("header"),
    title: text(),
    subtitle: v.optional(text(), ""),
    facts: v.optional(v.pipe(v.array(viewFact), v.maxLength(20)), []),
    badges: v.optional(v.pipe(v.array(text(80)), v.maxLength(6)), []),
    actions: v.optional(v.pipe(v.array(viewAction), v.maxLength(6)), []),
  }),
  v.object({
    type: v.literal("rows"),
    id: viewKey,
    title: sectionTitle,
    rows: v.pipe(v.array(viewRow), v.maxLength(100)),
    empty: v.optional(text(), ""),
  }),
  v.object({
    type: v.literal("groups"),
    id: viewKey,
    title: sectionTitle,
    groups: v.pipe(
      v.array(
        v.object({
          heading: text(),
          detail: v.optional(text(), ""),
          link: viewLink,
          rows: v.pipe(v.array(viewRow), v.maxLength(100)),
        }),
      ),
      v.maxLength(50),
    ),
  }),
  // Playable rows: the same items as work pages, so ranges and the
  // Library checks are shared. `context` prefixes queued titles.
  v.object({
    type: v.literal("tracks"),
    id: viewKey,
    title: sectionTitle,
    context: v.optional(text(), ""),
    items: v.pipe(v.array(queueItem), v.maxLength(500)),
  }),
  v.object({
    type: v.literal("details"),
    id: viewKey,
    title: sectionTitle,
    items: v.pipe(v.array(viewFact), v.maxLength(50)),
  }),
  v.object({
    type: v.literal("pager"),
    total: count,
    offset: count,
    limit: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500)),
  }),
  v.object({
    type: v.literal("tabs"),
    active: v.optional(v.union([viewKey, v.literal("")]), ""),
    tabs: v.pipe(
      v.array(v.object({ id: viewKey, label: text(80), count: v.optional(count) })),
      v.maxLength(10),
    ),
  }),
  v.object({
    type: v.literal("filters"),
    filters: v.pipe(
      v.array(
        v.object({
          key: viewKey,
          label: text(80),
          options: v.pipe(
            v.array(v.object({ value: id, label: text(), count: v.optional(count) })),
            v.maxLength(100),
          ),
          selected: v.optional(v.pipe(v.array(id), v.maxLength(10)), []),
        }),
      ),
      v.maxLength(10),
    ),
  }),
  v.object({
    type: v.literal("sort"),
    active: v.optional(v.union([viewKey, v.literal("")]), ""),
    options: v.pipe(v.array(v.object({ value: viewKey, label: text(80) })), v.maxLength(10)),
  }),
  v.object({ type: v.literal("empty"), message: text() }),
]);
const viewV2 = v.object({
  version: v.literal(2),
  title: text(),
  sections: v.pipe(v.array(viewSection), v.maxLength(30)),
});
const resourceView = v.variant("version", [workView, viewV2]);

// What a view 2 page was asked for: written in the page's URL and passed
// to the plugin as `input.query`.
export const pluginResourceQuery = v.object({
  q: v.optional(text(200), ""),
  sort: v.optional(v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{0,40}$/)), ""),
  filters: v.optional(text(2000), ""),
  page: v.optional(v.pipe(v.string(), v.regex(/^\d{0,5}$/)), ""),
  tab: v.optional(v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{0,40}$/)), ""),
});
const resourceInputQuery = (query: v.InferOutput<typeof pluginResourceQuery>) => ({
  q: query.q,
  sort: query.sort,
  tab: query.tab,
  page: Number(query.page || 0),
  filters: parseFilters(query.filters),
});
const mutationResult = v.object({ ok: v.literal(true) });

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

function hydrateWork(pluginId: string, view: v.InferOutput<typeof workView>) {
  const albums: PlayableAlbums = new Map();
  let before = 0;
  let after = 0;
  const recordings = view.recordings.flatMap((recording) => {
    const items = playableItems(pluginId, recording.items, albums);
    before += recording.items.length;
    after += items.length;
    // A recording whose every track is gone has nothing left to show.
    return recording.items.length && !items.length ? [] : [{ ...recording, items }];
  });
  logDropped(pluginId, before, after);
  return { ...view, recordings };
}

// Links become app paths; playable rows keep only tracks still in the
// Library, as on work pages.
function hydrateView(pluginId: string, view: v.InferOutput<typeof viewV2>) {
  const albums: PlayableAlbums = new Map();
  let before = 0;
  let after = 0;
  const link = (value: v.InferOutput<typeof viewLink>) => resolvedLink(pluginId, value);
  const row = (entry: v.InferOutput<typeof viewRow>) => ({ ...entry, link: link(entry.link) });
  const fact = (entry: v.InferOutput<typeof viewFact>) => ({ ...entry, link: link(entry.link) });
  const sections = view.sections.map((section) => {
    switch (section.type) {
      case "header":
        return {
          ...section,
          facts: section.facts.map(fact),
          actions: section.actions.map((action) => ({ ...action, link: link(action.link) })),
        };
      case "rows":
        return { ...section, rows: section.rows.map(row) };
      case "groups":
        return {
          ...section,
          groups: section.groups.map((group) => ({
            ...group,
            link: link(group.link),
            rows: group.rows.map(row),
          })),
        };
      case "details":
        return { ...section, items: section.items.map(fact) };
      case "tracks": {
        const items = playableItems(pluginId, section.items, albums);
        before += section.items.length;
        after += items.length;
        return { ...section, items };
      }
      default:
        return section;
    }
  });
  logDropped(pluginId, before, after);
  return { ...view, sections };
}

function bounded<T>(value: T, maxBytes = 512000) {
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes)
    throw new PluginRequestError(502, "Plugin presentation is too large");
  return value;
}

export async function readPluginResource(
  user: RequestUser,
  pluginId: string,
  pageId: string,
  resourceId: string,
  query: v.InferOutput<typeof pluginResourceQuery> = {
    q: "",
    sort: "",
    filters: "",
    page: "",
    tab: "",
  },
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
          // 2: generic view 2 pages with `input.query`; a plugin may still
          // answer with a version 1 work page.
          capabilities: { resourceView: 2, itemLinks: 1 },
          query: resourceInputQuery(query),
          user: { id: user.id, username: user.username, role: user.role },
        },
      },
      resourceView,
      15000,
    );
    return bounded(
      view.version === 2 ? hydrateView(plugin.id, view) : hydrateWork(plugin.id, view),
    );
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
          capabilities: { resourceView: 2 },
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
            capabilities: { albumPresentation: 1, itemLinks: 1 },
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
        const href = group.workId ? `/plugins/${plugin.id}/work/${group.workId}` : null;
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

export { mutationSchema as pluginResourceMutation };

export const resourcePlaylistInput = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(200)),
  itemIds: v.pipe(v.array(id), v.minLength(1), v.maxLength(500)),
});

// Saves items from a resource page (a comparison) as the signed-in person's
// own playlist. The items are read again from the plugin as that person, so
// only items their page shows can be saved, and each becomes the exact
// Library file it plays: classical titles repeat across recordings, so a
// playlist never matches them by name.
export async function saveResourcePlaylist(
  user: RequestUser,
  pluginId: string,
  pageId: string,
  resourceId: string,
  { name, itemIds }: v.InferOutput<typeof resourcePlaylistInput>,
) {
  const view = await readPluginResource(user, pluginId, pageId, resourceId);
  // A work page's recordings, or a view 2 page's playable rows.
  const pageItems =
    view.version === 2
      ? view.sections.flatMap((section) => (section.type === "tracks" ? section.items : []))
      : view.recordings.flatMap((recording) => recording.items);
  const items = new Map(pageItems.map((item) => [item.id, item]));
  const chosen = itemIds.map((itemId) => {
    const item = items.get(itemId);
    if (!item) throw new PluginRequestError(400, "That recording is no longer on this page");
    return item;
  });
  const library = getLibraryForTrackIds({ ids: [...new Set(chosen.map((item) => item.trackId))] });
  const tracks = chosen.flatMap((item, index) => {
    // One file for a run of items on it (movements sharing an attacca track).
    if (index > 0 && chosen[index - 1]?.fileId === item.fileId) return [];
    const track = library.tracks.find((entry) => String(entry.id) === item.trackId);
    const file = track?.files.find((entry) => String(entry.id) === item.fileId && entry.available);
    if (!track || !file?.path)
      throw new PluginRequestError(409, "A recording's file is no longer in the Library");
    return [
      {
        path: file.path,
        artistName: item.artist || track.artistName || "",
        trackName: item.title,
        albumName: item.album,
        durationMs: file.durationMs ?? item.durationMs,
      },
    ];
  });
  const playlistId = randomUUID();
  await playlistOperationQueue.enqueuePayload({
    kind: "static-playlist-create",
    label: "static-playlist:create",
    playlistId,
    name,
    sourceName: view.version === 2 ? view.title : view.work.title,
    sourceFlowId: null,
    tracks,
    ownerUserId: user.id,
    downloadMissing: false,
  });
  return { ok: true as const, playlistId, tracks: tracks.length };
}

// The Library's navigation entries: one per plugin that declares a
// non-admin Library page, with the entry and that page switched on.
export function pluginLibraryEntries() {
  return activePlugins().flatMap((plugin) => {
    const entry = plugin.manifest.library;
    if (
      !entry ||
      !isCapabilityOn(plugin, "library") ||
      !isCapabilityOn(plugin, `page:${entry.pageId}`)
    )
      return [];
    if (!plugin.manifest.pages.some((page) => page.id === entry.pageId && !page.admin)) return [];
    const path = hrefFor(plugin.id, {
      type: "resource",
      pageId: entry.pageId,
      resourceId: entry.resourceId,
    });
    return path ? [{ pluginId: plugin.id, label: entry.label, path }] : [];
  });
}
