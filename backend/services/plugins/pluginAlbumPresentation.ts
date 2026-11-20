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
};

const presenters = () =>
  activePlugins().filter(
    (plugin) => plugin.manifest.albumPresentation && isCapabilityOn(plugin, "albumPresentation"),
  );

export const hasAlbumPresentation = () => presenters().length > 0;

// A group labels one run of the album's tracks, in album order. Ids that
// aren't on the album are dropped; a group whose tracks aren't one run, or
// that overlaps an earlier group, is dropped whole.
export function readGroups(answer: Answer, albumTrackIds: string[]): AlbumPresentationGroup[] {
  const position = new Map(albumTrackIds.map((id, index) => [id, index]));
  const placed = answer.groups.flatMap((group) => {
    const positions = [...new Set(group.trackIds.map(String))]
      .flatMap((id) => position.get(id) ?? [])
      .sort((a, b) => a - b);
    const [first = -1] = positions;
    if (first < 0 || positions.some((at, index) => at !== first + index)) return [];
    return [
      {
        first,
        last: first + positions.length - 1,
        group: {
          title: group.title,
          subtitle: group.subtitle || null,
          detail: group.detail || null,
          trackIds: positions.map((at) => albumTrackIds[at] ?? ""),
        },
      },
    ];
  });
  placed.sort((a, b) => a.first - b.first);
  let end = -1;
  return placed.flatMap(({ first, last, group }) => {
    if (first <= end) return [];
    end = last;
    return [group];
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
