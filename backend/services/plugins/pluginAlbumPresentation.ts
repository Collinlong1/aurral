import * as v from "valibot";
import { logger } from "../logger.ts";
import { albumTarget } from "./pluginContext.ts";
import { callPlugin } from "./pluginHost.ts";
import { activePlugins, isCapabilityOn, pluginInput, type InstalledPlugin } from "./pluginStore.ts";

// Box sets run past a thousand tracks, often one piece per track.
const ALBUM_TRACKS = 5000;
const TIMEOUT_MS = 5000;
const text = (max: number) => v.pipe(v.string(), v.trim(), v.maxLength(max));

const answerSchema = v.nullish(
  v.object({
    // Names the grouped view in the album page's toggle, like "By work".
    label: v.optional(v.pipe(text(30), v.minLength(1))),
    groups: v.pipe(
      v.array(
        v.object({
          title: v.pipe(text(300), v.minLength(1)),
          subtitle: v.optional(text(300)),
          detail: v.optional(text(300)),
          trackIds: v.pipe(
            v.array(v.union([v.pipe(v.string(), v.maxLength(200)), v.number()])),
            v.minLength(1),
            v.maxLength(ALBUM_TRACKS),
          ),
          // What each track is called under the heading, in trackIds order.
          titles: v.optional(v.pipe(v.array(text(300)), v.maxLength(ALBUM_TRACKS))),
        }),
      ),
      v.maxLength(ALBUM_TRACKS),
    ),
  }),
);

type Answer = NonNullable<v.InferOutput<typeof answerSchema>>;

export type AlbumPresentationGroup = {
  title: string;
  subtitle: string | null;
  detail: string | null;
  trackIds: string[];
  // Matches trackIds; null leaves the track's own title.
  titles: (string | null)[];
};

const presenters = () =>
  activePlugins().filter(
    (plugin) => plugin.manifest.albumPresentation && isCapabilityOn(plugin, "albumPresentation"),
  );

export const hasAlbumPresentation = () => presenters().length > 0;

// A group gathers album tracks under one heading, in album order, wherever
// they sit (a work whose movements are numbered apart stays whole). Ids that
// aren't on the album, or that an earlier group already holds, are dropped,
// and so is a group left with none. Groups come in order of their first track.
export function readGroups(answer: Answer, albumTrackIds: string[]): AlbumPresentationGroup[] {
  const position = new Map(albumTrackIds.map((id, index) => [id, index]));
  const placed = answer.groups.flatMap((group) => {
    const titleOf = new Map(
      group.trackIds.map((id, index) => [String(id), group.titles?.[index] || null]),
    );
    const positions = [...new Set(group.trackIds.map(String))]
      .flatMap((id) => position.get(id) ?? [])
      .sort((a, b) => a - b);
    return positions.length ? [{ group, positions, titleOf }] : [];
  });
  placed.sort((a, b) => (a.positions[0] ?? 0) - (b.positions[0] ?? 0));
  const taken = new Set<number>();
  return placed.flatMap(({ group, positions, titleOf }) => {
    const own = positions.filter((at) => !taken.has(at));
    if (!own.length) return [];
    for (const at of own) taken.add(at);
    const trackIds = own.map((at) => albumTrackIds[at] ?? "");
    return [
      {
        title: group.title,
        subtitle: group.subtitle || null,
        detail: group.detail || null,
        trackIds,
        titles: trackIds.map((id) => titleOf.get(id) ?? null),
      },
    ];
  });
}

async function ask(plugin: InstalledPlugin, album: ReturnType<typeof albumTarget>) {
  // A slow or broken answer only costs the headings, so it isn't counted
  // toward turning the plugin off.
  return callPlugin(
    plugin,
    { path: "albumPresentation", input: { ...pluginInput(plugin), album } },
    answerSchema,
    TIMEOUT_MS,
    { countFailures: false },
  );
}

// The first plugin that has something to say about the album wins. Any
// failure leaves the album as it is.
export async function pluginAlbumPresentation(albumId: string) {
  const plugins = presenters();
  if (!plugins.length) return null;
  const album = albumTarget(albumId);
  const trackIds = album.tracks.map((track) => String(track.id));
  for (const plugin of plugins) {
    let answer: Answer | null | undefined;
    try {
      answer = await ask(plugin, album);
    } catch {
      continue;
    }
    if (!answer) continue;
    const groups = readGroups(answer, trackIds);
    const dropped = answer.groups.length - groups.length;
    if (dropped > 0) {
      logger.warn(`plugin:${plugin.id}`, `Dropped ${dropped} album groups Aurral couldn't place`);
    }
    if (!groups.length) continue;
    return { pluginId: plugin.id, label: answer.label || "Grouped", groups };
  }
  return null;
}
