import { statSync } from "fs";
import * as v from "valibot";
import axios from "../../lib/axiosFetch.ts";
import { dbOps } from "../db/helpers/index.ts";
import { logger } from "./logger.ts";
import { enqueueNotification, parseHonkerPayload } from "./honkerDb.ts";
import { asAppError } from "../../lib/errors.ts";
import { webhookSettingsSchema } from "../db/helpers/integrationSettings.ts";
import {
  runScript,
  scriptSucceeded,
  scriptsEnabled,
  type ScriptRunResult,
  type ScriptTarget,
} from "./scriptHooks.ts";
import type { StoredIntegrations } from "../db/helpers/settings.ts";
import { buildLibraryAlbumDir, resolveDownloadRoot } from "./downloadPaths.ts";

type WebhookSettings = v.InferOutput<typeof webhookSettingsSchema>;
type WebhookTarget = NonNullable<WebhookSettings["webhooks"]>[number];
type WebhookHeader = NonNullable<WebhookTarget["headers"]>[number];

interface WebhookVars {
  flowPath: string;
  flowName: string;
  albumName: string;
  artistName: string;
  albumPath: string;
  username: string;
  userId: string;
  event: string;
}

interface RequestActor {
  username?: string;
  userId?: number | string;
  id?: number | string;
}

interface RequestNotice {
  albumName?: string;
  artistName?: string;
  albumPath?: string;
  user?: RequestActor | null;
}

const text = v.optional(v.string());

const notificationVars = v.looseObject({
  flowPath: text,
  flowName: text,
  albumName: text,
  artistName: text,
  albumPath: text,
  username: text,
  userId: text,
  event: text,
});

export const queuedNotificationSchema = v.variant("kind", [
  v.looseObject({
    kind: v.literal("gotify"),
    title: text,
    message: text,
    priority: v.optional(v.number()),
  }),
  v.looseObject({
    kind: v.literal("webhooks"),
    integrations: v.optional(webhookSettingsSchema),
    event: text,
    vars: v.optional(notificationVars),
    flowPath: text,
    flowName: text,
  }),
  v.looseObject({
    kind: v.literal("script"),
    script: v.looseObject({
      name: text,
      file: v.string(),
      args: v.optional(v.array(v.string())),
      timeoutSec: v.optional(v.number()),
    }),
    event: text,
    vars: v.optional(notificationVars),
  }),
]);

function logDeliveryFailure(
  kind: string,
  event: string | null | undefined,
  url: string,
  error: unknown,
) {
  const failure = asAppError(error);
  logger.error("notifications", "Notification delivery failed", {
    kind,
    event: event || null,
    receiver: URL.parse(url)?.host ?? null,
    status: failure?.response?.status ?? null,
    message: failure?.message || String(error),
  });
}

async function sendGotifyDirect(
  title: string | undefined,
  message: string | undefined,
  priority = 5,
) {
  const settings = dbOps.getSettings();
  const gotify = settings.integrations?.gotify || {};
  const url = (gotify.url || "").trim().replace(/\/+$/, "");
  const token = (gotify.token || "").trim();
  if (!url || !token) return;
  try {
    await axios.post(
      `${url}/message`,
      { title, message, priority },
      { timeout: 10000, headers: { "Content-Type": "application/json", "X-Gotify-Key": token } },
    );
  } catch (error) {
    logDeliveryFailure("gotify", null, url, error);
    throw error;
  }
}

function buildHeaders(headers: WebhookHeader[] | undefined) {
  if (!Array.isArray(headers)) return {};
  const result: Record<string, string> = {};
  for (const { key, value } of headers) {
    const k = (key || "").trim();
    const v = (value || "").trim();
    if (k && v) result[k] = v;
  }
  return result;
}

function escapeJsonString(value: unknown) {
  return JSON.stringify(String(value ?? "")).slice(1, -1);
}

const WEBHOOK_PLACEHOLDERS = [
  "flowPath",
  "flowName",
  "albumName",
  "artistName",
  "albumPath",
  "username",
  "userId",
  "event",
];

export function interpolateBody(str: string | null | undefined, vars: Partial<WebhookVars> = {}) {
  const source = String(str ?? "");
  const pattern = new RegExp(`\\$(${WEBHOOK_PLACEHOLDERS.join("|")})`, "g");
  return source.replace(pattern, (_, key: keyof WebhookVars) => escapeJsonString(vars[key] ?? ""));
}

function normalizeWebhookVars(vars: Partial<WebhookVars> = {}, flowPath = "", flowName = "") {
  if (vars && typeof vars === "object" && !Array.isArray(vars)) {
    return {
      flowPath: vars.flowPath ?? flowPath ?? "",
      flowName: vars.flowName ?? flowName ?? "",
      albumName: vars.albumName ?? "",
      artistName: vars.artistName ?? "",
      albumPath: vars.albumPath ?? "",
      username: vars.username ?? "",
      userId: vars.userId ?? "",
      event: vars.event ?? "",
    };
  }
  return {
    flowPath: flowPath || "",
    flowName: flowName || "",
    albumName: "",
    artistName: "",
    albumPath: "",
    username: "",
    userId: "",
    event: "",
  };
}

function requestActorVars(user: RequestActor | null = null) {
  if (!user || typeof user !== "object") {
    return { username: "", userId: "" };
  }
  const username = String(user.username || "").trim();
  const userId = user.userId ?? user.id;
  return {
    username,
    userId: userId == null || userId === "" ? "" : String(userId),
  };
}

function formatRequestSubject(albumName?: string, artistName?: string) {
  const album = String(albumName || "").trim() || "Album";
  const artist = String(artistName || "").trim();
  return artist ? `${album} by ${artist}` : album;
}

async function sendWebhooksDirect(
  { webhooks, webhookEvents = {} }: WebhookSettings,
  event: string | undefined,
  vars: Partial<WebhookVars> = {},
) {
  if (!event || !webhookEvents[event]) return;
  if (!Array.isArray(webhooks) || webhooks.length === 0) return;

  const resolved = normalizeWebhookVars({ ...vars, event });

  for (const webhook of webhooks) {
    const url = (webhook.url || "").trim();
    if (!url) continue;
    if (!/^https?:\/\//i.test(url)) {
      console.warn(`[NotificationService] Skipping webhook with non-http(s) URL: ${url}`);
      continue;
    }
    const rawBody = (webhook.body || "").trim();
    try {
      if (rawBody) {
        const interpolated = interpolateBody(rawBody, resolved);
        let parsed;
        try {
          parsed = JSON.parse(interpolated);
        } catch {
          parsed = interpolated;
        }
        const headers = {
          ...buildHeaders(webhook.headers),
          "Content-Type": "application/json",
        };
        await axios.post(url, parsed, { timeout: 30000, headers });
      } else {
        await axios.get(url, {
          timeout: 30000,
          headers: buildHeaders(webhook.headers),
        });
      }
    } catch (error) {
      logDeliveryFailure("webhooks", event, url, error);
      throw error;
    }
  }
}

const scriptLabel = (script: ScriptTarget) => String(script.name || "").trim() || script.file;

// The end of a script's output, short enough for a log line.
const outputTail = (output: string, limit = 2000) =>
  output.length > limit ? output.slice(-limit) : output;

async function runScriptDirect(
  script: ScriptTarget,
  event: string | undefined,
  vars: Partial<WebhookVars>,
) {
  if (!scriptsEnabled()) {
    logger.warn("notifications", "Script skipped: custom scripts are not enabled", {
      script: scriptLabel(script),
      event: event || null,
    });
    return;
  }
  let result: ScriptRunResult;
  try {
    result = await runScript(script, normalizeWebhookVars({ ...vars, event }));
  } catch (error) {
    logger.error("notifications", "Script could not start", {
      script: scriptLabel(script),
      event: event || null,
      message: asAppError(error)?.message || String(error),
    });
    throw error;
  }
  const details = {
    script: scriptLabel(script),
    event: event || null,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    output: outputTail(result.output),
  };
  if (scriptSucceeded(result)) {
    logger.info("notifications", "Script finished", details);
    return;
  }
  logger.error("notifications", "Script failed", details);
  throw new Error(
    result.timedOut
      ? `Script ${scriptLabel(script)} timed out`
      : `Script ${scriptLabel(script)} exited with ${result.exitCode ?? result.signal}`,
  );
}

export async function deliverQueuedNotification(
  payload: v.InferOutput<typeof queuedNotificationSchema>,
) {
  if (payload.kind === "gotify") {
    await sendGotifyDirect(payload.title, payload.message, payload.priority ?? 5);
    return;
  }
  if (payload.kind === "script") {
    await runScriptDirect(payload.script, payload.event, payload.vars ?? {});
    return;
  }
  await sendWebhooksDirect(
    payload.integrations || {},
    payload.event,
    normalizeWebhookVars(payload.vars, payload.flowPath, payload.flowName),
  );
}

function queueGotify(title: string, message: string, priority = 5) {
  return enqueueNotification({
    kind: "gotify",
    title,
    message,
    priority,
    requestedAt: Date.now(),
  });
}

function queueWebhooks(
  { webhooks, webhookEvents }: StoredIntegrations,
  event: string,
  vars: Partial<WebhookVars> = {},
) {
  const resolved = normalizeWebhookVars({ ...vars, event });
  return enqueueNotification({
    kind: "webhooks",
    integrations: parseHonkerPayload(JSON.stringify({ webhooks, webhookEvents })) ?? {},
    event,
    vars: resolved,
    flowPath: resolved.flowPath,
    flowName: resolved.flowName,
    requestedAt: Date.now(),
  });
}

// One job per script, so a failing script retries alone and never holds up
// webhooks, Gotify, or another script.
function queueScripts(
  { scripts, scriptEvents }: StoredIntegrations,
  event: string,
  vars: Partial<WebhookVars> = {},
) {
  if (!scriptsEnabled() || !scriptEvents?.[event as keyof typeof scriptEvents]) return [];
  if (!Array.isArray(scripts)) return [];
  const resolved = normalizeWebhookVars({ ...vars, event });
  return scripts
    .filter((script) => script.enabled !== false && String(script.file || "").trim())
    .map((script) =>
      enqueueNotification({
        kind: "script",
        script: {
          name: String(script.name || ""),
          file: String(script.file),
          args: Array.isArray(script.args) ? script.args.map(String) : [],
          ...(script.timeoutSec ? { timeoutSec: Number(script.timeoutSec) } : {}),
        },
        event,
        vars: resolved,
        requestedAt: Date.now(),
      }),
    );
}

function queueEventHooks(
  integrations: StoredIntegrations,
  event: string,
  vars: Partial<WebhookVars> = {},
) {
  return [queueWebhooks(integrations, event, vars), ...queueScripts(integrations, event, vars)];
}

export async function sendGotifyTest(
  url: string | null | undefined,
  token: string | null | undefined,
) {
  const base = (url || "").trim().replace(/\/+$/, "");
  const t = (token || "").trim();
  if (!base || !t) {
    const err: Error & { code?: string } = new Error("Gotify URL and token are required");
    err.code = "MISSING_CONFIG";
    throw err;
  }
  const response = await axios.post(
    `${base}/message`,
    {
      title: "Aurral test",
      message: "Test notification received.",
      priority: 5,
    },
    { timeout: 10000, headers: { "Content-Type": "application/json", "X-Gotify-Key": t } },
  );
  return response.status === 200;
}

const WEBHOOK_TEST_VARS = Object.freeze({
  flowPath: "/aurral/test-webhook",
  flowName: "Aurral webhook test",
  albumName: "Test album",
  artistName: "Test artist",
  albumPath: "/music/Test artist/Test album",
  username: "webhook-test-user",
  userId: "webhook-test-user",
});

export async function sendWebhookTest(webhook: WebhookTarget) {
  await sendWebhooksDirect(
    {
      webhooks: [webhook],
      webhookEvents: { webhookTest: true },
    },
    "webhookTest",
    WEBHOOK_TEST_VARS,
  );
}

const SCRIPT_TEST_VARS = Object.freeze({
  flowPath: "",
  flowName: "",
  albumName: "Test album",
  artistName: "Test artist",
  albumPath: "/music/Test artist/Test album",
  username: "script-test-user",
  userId: "script-test-user",
});

export async function sendScriptTest(script: ScriptTarget) {
  return runScript(script, normalizeWebhookVars({ ...SCRIPT_TEST_VARS, event: "scriptTest" }));
}

export async function notifyDiscoveryUpdated() {
  const settings = dbOps.getSettings();
  const gotify = settings.integrations?.gotify || {};
  const tasks = [];
  if (gotify.notifyDiscoveryUpdated) {
    tasks.push(
      queueGotify("Aurral – Discover", "Daily Discover recommendations have been updated.", 5),
    );
  }
  tasks.push(
    ...queueEventHooks(settings.integrations, "notifyDiscoveryUpdated", {
      flowName: "Aurral – Discover",
    }),
  );
  await Promise.all(tasks);
}

export async function notifyFlowDone(
  playlistType: string,
  stats: { completed?: number; failed?: number } = {},
  flowPath = "",
  flowName = "",
) {
  const settings = dbOps.getSettings();
  const gotify = settings.integrations?.gotify || {};
  const completed = stats.completed ?? 0;
  const failed = stats.failed ?? 0;
  const displayName = String(flowName || playlistType || "").trim() || playlistType;
  const tasks = [];
  if (gotify.notifyWeeklyFlowDone) {
    tasks.push(
      queueGotify(
        "Aurral – Flow",
        `Flow "${displayName}" finished processing.${completed > 0 || failed > 0 ? ` Completed: ${completed}, Failed: ${failed}` : ""}`,
        5,
      ),
    );
  }
  tasks.push(
    ...queueEventHooks(settings.integrations, "notifyWeeklyFlowDone", {
      flowPath,
      flowName: displayName,
    }),
  );
  await Promise.all(tasks);
}

export async function notifyRequestMade({
  albumName,
  artistName,
  user = null,
}: RequestNotice = {}) {
  const settings = dbOps.getSettings();
  const gotify = settings.integrations?.gotify || {};
  const actor = requestActorVars(user);
  const subject = formatRequestSubject(albumName, artistName);
  const tasks = [];
  if (gotify.notifyRequestMade) {
    const byUser = actor.username ? ` (${actor.username})` : "";
    tasks.push(queueGotify("Aurral – Request", `Album requested: ${subject}${byUser}`, 5));
  }
  tasks.push(
    ...queueEventHooks(settings.integrations, "notifyRequestMade", {
      albumName: String(albumName || "").trim(),
      artistName: String(artistName || "").trim(),
      ...actor,
    }),
  );
  await Promise.all(tasks);
}

// The album's folder in the Library, when it is there.
function resolveAlbumPath(albumName?: string, artistName?: string, known?: string) {
  const candidate = String(known || "").trim();
  if (candidate) return candidate;
  if (!String(albumName || "").trim()) return "";
  try {
    const dir = buildLibraryAlbumDir(resolveDownloadRoot(), { albumName, artistName });
    return statSync(dir).isDirectory() ? dir : "";
  } catch {
    return "";
  }
}

export async function notifyRequestAvailable({
  albumName,
  artistName,
  albumPath,
  user = null,
}: RequestNotice = {}) {
  const settings = dbOps.getSettings();
  const gotify = settings.integrations?.gotify || {};
  const actor = requestActorVars(user);
  const subject = formatRequestSubject(albumName, artistName);
  const tasks = [];
  if (gotify.notifyRequestAvailable) {
    const byUser = actor.username ? ` requested by ${actor.username}` : "";
    tasks.push(queueGotify("Aurral – Request", `Album available: ${subject}${byUser}`, 5));
  }
  tasks.push(
    ...queueEventHooks(settings.integrations, "notifyRequestAvailable", {
      albumName: String(albumName || "").trim(),
      artistName: String(artistName || "").trim(),
      albumPath: resolveAlbumPath(albumName, artistName, albumPath),
      ...actor,
    }),
  );
  await Promise.all(tasks);
}
