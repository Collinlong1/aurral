// Track links: a plugin with `"trackLinks": true` names its own places for
// library tracks (a work, a performer), for track menus and the player when
// a track was queued from an ordinary page. Core builds every path.
import * as v from "valibot";
import type { RequestUser } from "../../middleware/requestUser.ts";
import { callPlugin } from "./pluginHost.ts";
import { pluginItemLinkList, resolvedItemLinks } from "./pluginLinks.ts";
import { activePlugins, isCapabilityOn, pluginInput } from "./pluginStore.ts";
import { PluginRequestError } from "./pluginService.ts";

const MAX_LINKS = 6;
const resultSchema = v.object({
  version: v.literal(1),
  tracks: v.record(v.pipe(v.string(), v.regex(/^\d{1,12}$/)), pluginItemLinkList),
});

export const pluginTrackLinksQuery = v.object({
  trackIds: v.pipe(v.string(), v.regex(/^\d{1,12}(?:,\d{1,12}){0,99}$/)),
});

const providers = () =>
  activePlugins().filter(
    (plugin) => plugin.manifest.trackLinks && isCapabilityOn(plugin, "trackLinks"),
  );

// Whether any plugin can answer, so the app asks only when one can.
export const hasTrackLinks = () => providers().length > 0;

// Links per asked track id, at most six a track. Each plugin has 3 seconds;
// one that fails or times out adds nothing.
export async function pluginTrackLinks(user: RequestUser, rawIds: string) {
  if (!Number.isSafeInteger(user.id) || user.id <= 0)
    throw new PluginRequestError(403, "A real user account is required");
  const trackIds = [...new Set(rawIds.split(","))];
  const links: Record<string, { label: string; href: string }[]> = Object.fromEntries(
    trackIds.map((id) => [id, []]),
  );
  const answers = await Promise.all(
    providers().map(async (plugin) => {
      try {
        const result = await callPlugin(
          plugin,
          {
            path: "trackLinks",
            input: {
              ...pluginInput(plugin),
              capabilities: { trackLinks: 1 },
              user: { id: user.id, username: user.username, role: user.role },
              trackIds,
            },
          },
          resultSchema,
          3000,
        );
        return { plugin, tracks: result.tracks };
      } catch {
        return { plugin, tracks: {} };
      }
    }),
  );
  for (const { plugin, tracks } of answers) {
    for (const [trackId, entries] of Object.entries(tracks)) {
      const list = links[trackId];
      if (!list) continue;
      for (const entry of resolvedItemLinks(plugin.id, entries)) {
        if (list.length < MAX_LINKS && !list.some((link) => link.href === entry.href))
          list.push(entry);
      }
    }
  }
  return { links };
}
