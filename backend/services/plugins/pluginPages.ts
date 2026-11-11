// Generic admin forms (v1) and admin pages (v2). Plugins supply bounded data,
// never executable browser code or HTML; the host renders it with its own UI.
import * as v from "valibot";
import type { RequestUser } from "../../middleware/requestUser.ts";
import { callPlugin, PluginError } from "./pluginHost.ts";
import { activePlugin, activePlugins, isCapabilityOn, pluginInput } from "./pluginStore.ts";
import { PluginRequestError } from "./pluginService.ts";

const text = (max = 10000) => v.pipe(v.string(), v.maxLength(max));
const key = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{1,80}$/));
const value = v.union([text(), v.boolean(), v.pipe(v.array(text(200)), v.maxLength(1000))]);
const values = v.pipe(
  v.record(key, value),
  v.check((items) => Object.keys(items).length <= 40),
);
const option = v.object({ value: text(200), label: text(500) });
export const pluginPageSchema = v.object({
  version: v.literal(1),
  title: text(200),
  description: v.optional(text()),
  revision: text(200),
  navigation: v.object({
    items: v.pipe(v.array(v.object({ id: text(200), label: text(500) })), v.maxLength(100)),
    total: v.pipe(v.number(), v.integer(), v.minValue(0)),
    offset: v.pipe(v.number(), v.integer(), v.minValue(0)),
  }),
  notes: v.optional(v.pipe(v.array(text()), v.maxLength(30)), []),
  forms: v.pipe(
    v.array(
      v.object({
        id: key,
        title: text(200),
        help: v.optional(text()),
        command: key,
        arguments: values,
        submitLabel: text(100),
        fields: v.pipe(
          v.array(
            v.object({
              key,
              label: text(200),
              type: v.picklist(["text", "textarea", "select", "checkbox", "order"]),
              value,
              required: v.optional(v.boolean(), false),
              help: v.optional(text()),
              options: v.optional(v.pipe(v.array(option), v.maxLength(1000)), []),
            }),
          ),
          v.maxLength(40),
        ),
      }),
    ),
    v.maxLength(100),
  ),
});
export type PluginPageData = v.InferOutput<typeof pluginPageSchema>;

// v2: a browse list with tabs plus a detail view built from generic sections.
const tone = v.optional(v.picklist(["default", "muted", "success", "warning", "error"]), "default");
const badge = v.object({ label: text(80), tone });
const action = v.object({
  label: text(100),
  command: key,
  arguments: values,
  tone: v.optional(v.picklist(["default", "danger"]), "default"),
  confirm: v.optional(text(500)),
});
const actions = (max: number) => v.optional(v.pipe(v.array(action), v.maxLength(max)), []);
const selection = text(500);
const v2Field = v.object({
  key,
  label: text(200),
  type: v.picklist(["text", "textarea", "lines", "select", "checkbox", "lookup", "mapping"]),
  value,
  required: v.optional(v.boolean(), false),
  help: v.optional(text()),
  placeholder: v.optional(text(200)),
  options: v.optional(v.pipe(v.array(option), v.maxLength(1000)), []),
  // lookup: the plugin's lookup source; valueLabel names the current value.
  lookup: v.optional(key),
  valueLabel: v.optional(text(500)),
  // mapping: one select per row, all sharing options; value is one entry per row.
  rows: v.optional(
    v.pipe(
      v.array(v.object({ label: text(500), detail: v.optional(text(500)) })),
      v.maxLength(500),
    ),
    [],
  ),
  // Provenance shown next to the field, with field-level actions.
  meta: v.optional(
    v.object({ source: text(80), pinned: v.boolean(), provider: v.optional(text(2000)) }),
  ),
  actions: actions(4),
});
const row = v.object({
  id: text(200),
  label: text(500),
  detail: v.optional(text(500)),
  badge: v.optional(badge),
  selection: v.optional(selection),
  actions: actions(4),
});
const section = v.variant("type", [
  v.object({
    type: v.literal("form"),
    id: key,
    title: v.optional(text(200)),
    note: v.optional(text()),
    command: key,
    arguments: values,
    submitLabel: text(100),
    fields: v.pipe(v.array(v2Field), v.maxLength(40)),
  }),
  v.object({
    type: v.literal("rows"),
    id: key,
    title: v.optional(text(200)),
    note: v.optional(text()),
    empty: v.optional(text(500)),
    rows: v.pipe(v.array(row), v.maxLength(500)),
    actions: actions(4),
  }),
  v.object({
    type: v.literal("details"),
    id: key,
    title: v.optional(text(200)),
    items: v.pipe(
      v.array(v.object({ label: text(200), value: text(2000), selection: v.optional(selection) })),
      v.maxLength(40),
    ),
  }),
]);
export const pluginPageV2Schema = v.object({
  version: v.literal(2),
  title: text(200),
  description: v.optional(text()),
  revision: text(200),
  tabs: v.pipe(
    v.array(
      v.object({
        id: key,
        label: text(80),
        count: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
      }),
    ),
    v.maxLength(12),
  ),
  tab: v.optional(text(80), ""),
  list: v.object({
    placeholder: v.optional(text(200)),
    items: v.pipe(v.array(row), v.maxLength(100)),
    total: v.pipe(v.number(), v.integer(), v.minValue(0)),
    offset: v.pipe(v.number(), v.integer(), v.minValue(0)),
    empty: v.optional(text(500)),
    actions: actions(4),
  }),
  view: v.nullable(
    v.object({
      crumbs: v.pipe(v.array(v.object({ label: text(200), selection })), v.maxLength(8)),
      title: text(500),
      subtitle: v.optional(text(500)),
      badges: v.optional(v.pipe(v.array(badge), v.maxLength(8)), []),
      actions: actions(8),
      sections: v.pipe(v.array(section), v.maxLength(40)),
    }),
  ),
  notes: v.optional(v.pipe(v.array(v.object({ tone, text: text() })), v.maxLength(20)), []),
});
export type PluginPageV2Data = v.InferOutput<typeof pluginPageV2Schema>;
export type PluginPageV2Field = v.InferOutput<typeof v2Field>;
export type PluginPageV2Action = v.InferOutput<typeof action>;
export const pluginLookupSchema = v.object({
  version: v.literal(2),
  lookup: key,
  options: v.pipe(
    v.array(v.object({ value: text(200), label: text(500), detail: v.optional(text(500)) })),
    v.maxLength(50),
  ),
});
const pluginPageResponse = v.union([pluginPageSchema, pluginPageV2Schema, pluginLookupSchema]);
export const pluginPageQuery = v.object({
  selection: v.optional(selection, ""),
  q: v.optional(text(200), ""),
  offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,8}$/)), "0"),
  tab: v.optional(v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{0,80}$/)), ""),
  lookup: v.optional(v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-]{0,80}$/)), ""),
});
export const pluginPageMutation = v.object({ revision: text(200), command: key, values });
const mutationResult = v.variant("ok", [
  v.object({ ok: v.literal(true), message: text(500), selection: v.optional(selection) }),
  v.object({ ok: v.literal(false), status: v.picklist([400, 409]), message: text(500) }),
]);

function admin(user: RequestUser) {
  if (user.role !== "admin" || !Number.isSafeInteger(user.id) || user.id <= 0)
    throw new PluginRequestError(403, "A real admin account is required");
}
export function listPluginPages(user: RequestUser) {
  if (user.role !== "admin" || user.id <= 0) return { pages: [] };
  return {
    pages: activePlugins().flatMap((plugin) =>
      plugin.manifest.pages
        .filter((page) => page.admin && isCapabilityOn(plugin, `page:${page.id}`))
        .map((page) => ({ pluginId: plugin.id, pluginName: plugin.manifest.name, ...page })),
    ),
  };
}
export async function invokePluginPage(
  user: RequestUser,
  pluginId: string,
  pageId: string,
  request:
    | { operation: "read"; query: v.InferOutput<typeof pluginPageQuery> }
    | { operation: "mutate"; mutation: v.InferOutput<typeof pluginPageMutation> },
) {
  admin(user);
  const plugin = activePlugin(pluginId);
  if (
    !plugin ||
    !plugin.manifest.pages.some((page) => page.id === pageId) ||
    !isCapabilityOn(plugin, `page:${pageId}`)
  )
    throw new PluginRequestError(404, "Plugin page is unavailable or disabled");
  const input = {
    ...pluginInput(plugin),
    pageId,
    // 2: the host also renders admin pages v2 and answers lookups.
    capabilities: { adminForms: 2 },
    user: { id: user.id, username: user.username, role: user.role },
    ...(request.operation === "read" ? { query: request.query } : { mutation: request.mutation }),
  };
  try {
    if (request.operation === "read") {
      const data = await callPlugin(
        plugin,
        { path: "pages.read", input },
        pluginPageResponse,
        15000,
      );
      if (Buffer.byteLength(JSON.stringify(data)) > 512000)
        throw new PluginRequestError(502, "Plugin page is too large");
      return data;
    }
    const result = await callPlugin(plugin, { path: "pages.mutate", input }, mutationResult, 15000);
    if (!result.ok) throw new PluginRequestError(result.status, result.message);
    return result;
  } catch (error) {
    if (error instanceof PluginError)
      throw new PluginRequestError(502, `Plugin page: ${error.message}`);
    throw error;
  }
}
