// Generic admin forms v1. Plugins supply data, never executable browser code or HTML.
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
export const pluginPageQuery = v.object({
  selection: v.optional(text(200), ""),
  q: v.optional(text(200), ""),
  offset: v.optional(v.pipe(v.string(), v.regex(/^\d{1,8}$/)), "0"),
});
export const pluginPageMutation = v.object({ revision: text(200), command: key, values });
const mutationResult = v.variant("ok", [
  v.object({ ok: v.literal(true), message: text(500), selection: v.optional(text(200)) }),
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
    capabilities: { adminForms: 1 },
    user: { id: user.id, username: user.username, role: user.role },
    ...(request.operation === "read" ? { query: request.query } : { mutation: request.mutation }),
  };
  try {
    if (request.operation === "read") {
      const data = await callPlugin(plugin, { path: "pages.read", input }, pluginPageSchema, 15000);
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
