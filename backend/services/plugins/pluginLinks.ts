// Where a plugin's item leads. Plugins send typed links; core builds every
// path itself, so a plugin never sends a URL.
import * as v from "valibot";

const text = (max = 500) => v.pipe(v.string(), v.maxLength(max));
const key = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{1,40}$/));
const id = text(200);

export const pluginFilters = v.pipe(
  v.record(key, v.pipe(v.array(id), v.maxLength(10))),
  v.check((filters) => Object.keys(filters).length <= 10),
);

export const pluginLink = v.variant("type", [
  // A page of the same plugin.
  v.object({ type: v.literal("resource"), pageId: key, resourceId: id }),
  v.object({ type: v.literal("album"), albumId: id }),
  // The page it is on (or search) with these filters, as for a person's
  // other recordings.
  v.object({ type: v.literal("filter"), filters: pluginFilters }),
]);
export type PluginLink = v.InferOutput<typeof pluginLink>;

// Up to six labelled links on one item, for a menu.
export const pluginItemLinks = v.optional(
  v.pipe(v.array(v.object({ label: text(80), link: pluginLink })), v.maxLength(6)),
  [],
);

// The app path of a link; a filter link has none of its own: the page it is
// shown on applies `filters`.
export function hrefFor(pluginId: string, link: PluginLink | null | undefined) {
  if (!link) return null;
  if (link.type === "resource")
    return `/plugins/${encodeURIComponent(pluginId)}/${encodeURIComponent(link.pageId)}/${encodeURIComponent(link.resourceId)}`;
  if (link.type === "album") return `/album/${encodeURIComponent(link.albumId)}`;
  return null;
}

// A link as the app reads it.
export const resolvedLink = (pluginId: string, link: PluginLink | null | undefined) =>
  link
    ? { href: hrefFor(pluginId, link), filters: link.type === "filter" ? link.filters : null }
    : null;

export const resolvedItemLinks = (
  pluginId: string,
  links: { label: string; link: PluginLink }[] = [],
) =>
  links.flatMap(({ label, link }) => {
    const resolved = resolvedLink(pluginId, link);
    return resolved ? [{ label, ...resolved }] : [];
  });

// "composer=a,b;period=x" -> { composer: ["a","b"], period: ["x"] }, as
// search and plugin pages write filters in their URL.
export function parseFilters(raw: string) {
  const filters: Record<string, string[]> = {};
  for (const part of raw.split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const name = part.slice(0, at);
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(name)) continue;
    const values = part
      .slice(at + 1)
      .split(",")
      .map((value) => decodeURIComponent(value))
      .filter((value) => value && value.length <= 200)
      .slice(0, 10);
    if (values.length) filters[name] = values;
    if (Object.keys(filters).length >= 10) break;
  }
  return filters;
}
