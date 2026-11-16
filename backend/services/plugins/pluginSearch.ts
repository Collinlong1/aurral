// Plugin search providers: a plugin with `"search": true` answers searches
// from Aurral's search page with typed, bounded result sections and filters.
// Core renders them with its own components and builds every link itself.
import * as v from "valibot";
import { hrefFor, parseFilters, pluginLink as link } from "./pluginLinks.ts";
import type { RequestUser } from "../../middleware/requestUser.ts";
import { callPlugin } from "./pluginHost.ts";
import { activePlugins, isCapabilityOn, pluginInput } from "./pluginStore.ts";
import { PluginRequestError } from "./pluginService.ts";

const text = (max = 500) => v.pipe(v.string(), v.maxLength(max));
const key = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{1,40}$/));
const id = text(200);
const count = v.pipe(v.number(), v.integer(), v.minValue(0));
const item = v.object({
  id,
  kind: key,
  title: text(),
  subtitle: v.optional(text(), ""),
  detail: v.optional(text(), ""),
  link: v.optional(v.nullable(link), null),
});
const resultSchema = v.object({
  version: v.literal(1),
  best: v.optional(v.nullable(item), null),
  total: count,
  sections: v.pipe(
    v.array(
      v.object({
        id: key,
        title: text(80),
        total: count,
        items: v.pipe(v.array(item), v.maxLength(50)),
      }),
    ),
    v.maxLength(10),
  ),
  facets: v.optional(
    v.pipe(
      v.array(
        v.object({
          key,
          label: text(80),
          selected: v.optional(v.pipe(v.array(id), v.maxLength(10)), []),
          options: v.pipe(
            v.array(v.object({ value: id, label: text(200), count })),
            v.maxLength(50),
          ),
        }),
      ),
      v.maxLength(12),
    ),
    [],
  ),
});

export const pluginSearchQuery = v.object({
  q: v.optional(text(200), ""),
  plugin: v.optional(v.pipe(v.string(), v.regex(/^(?:[a-z0-9][a-z0-9-]{0,63})?$/)), ""),
  section: v.optional(v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{0,40}$/)), ""),
  filters: v.optional(text(2000), ""),
  offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,5}$/)), "0"),
});

// Searches each search provider, at most 3 seconds each. A provider that
// fails or times out is reported, never fatal: the rest of search renders.
export async function pluginSearch(
  user: RequestUser,
  query: v.InferOutput<typeof pluginSearchQuery>,
) {
  if (!Number.isSafeInteger(user.id) || user.id <= 0)
    throw new PluginRequestError(403, "A real user account is required");
  const filters = parseFilters(query.filters);
  const providers = activePlugins().filter(
    (plugin) =>
      plugin.manifest.search &&
      isCapabilityOn(plugin, "search") &&
      (!query.plugin || plugin.id === query.plugin),
  );
  const answers = await Promise.all(
    providers.map(async (plugin) => {
      try {
        const result = await callPlugin(
          plugin,
          {
            path: "search",
            input: {
              ...pluginInput(plugin),
              capabilities: { search: 1 },
              user: { id: user.id, username: user.username, role: user.role },
              query: {
                q: query.q,
                filters,
                section: query.section || null,
                offset: Number(query.offset) || 0,
                // A focused search lists more of each section.
                limit: query.plugin ? 20 : 4,
              },
            },
          },
          resultSchema,
          3000,
        );
        const withHref = (entry: v.InferOutput<typeof item>) => ({
          ...entry,
          href: hrefFor(plugin.id, entry.link),
          filters: entry.link?.type === "filter" ? entry.link.filters : null,
        });
        return {
          pluginId: plugin.id,
          pluginName: plugin.manifest.name,
          ok: true as const,
          total: result.total,
          best: result.best ? withHref(result.best) : null,
          sections: result.sections.map((section) => ({
            ...section,
            items: section.items.map(withHref),
          })),
          facets: result.facets,
        };
      } catch {
        return { pluginId: plugin.id, pluginName: plugin.manifest.name, ok: false as const };
      }
    }),
  );
  return { providers: answers, filters };
}
