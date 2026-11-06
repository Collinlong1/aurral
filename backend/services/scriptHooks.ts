import { spawn } from "child_process";
import { constants as fsConstants, realpathSync, statSync } from "fs";
import fs from "fs/promises";
import path from "path";
import * as v from "valibot";
import { asAppError } from "../../lib/errors.ts";
import { NOTIFICATION_EVENTS, type NotificationEvent } from "../../lib/notificationEvents.ts";
import type { StoredIntegrations } from "../db/helpers/settings.ts";
import { isPathInsideRoot } from "./downloadPaths.ts";
import { enqueueNotification } from "./honkerDb.ts";
import { logger } from "./logger.ts";

// Custom script hooks run admin-chosen executables from AURRAL_SCRIPTS_DIR
// when a notification event fires. The feature is off unless that folder is
// set and exists.

export const SCRIPT_OUTPUT_LIMIT = 64 * 1024;
export const SCRIPT_DEFAULT_TIMEOUT_SEC = 60;
export const SCRIPT_MAX_TIMEOUT_SEC = 3600;
export const SCRIPT_MAX_ARGS = 32;
export const SCRIPT_MAX_ARG_LENGTH = 4096;
const MAX_SCRIPTS = 10;
const KILL_GRACE_MS = 5000;
// Only these variables reach a script from Aurral's own environment, so
// secrets in it stay out of the script's.
const PASSTHROUGH_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR"];

// The event values a script receives, as AURRAL_* variables and stdin JSON.
const SCRIPT_VARS = [
  "flowPath",
  "flowName",
  "albumName",
  "artistName",
  "albumPath",
  "trackName",
  "path",
  "username",
  "userId",
  "event",
  "message",
] as const;

export type ScriptVars = Partial<Record<(typeof SCRIPT_VARS)[number], string>>;

// Every value, empty where the event has none.
const scriptVars = (vars: ScriptVars) =>
  Object.fromEntries(SCRIPT_VARS.map((key) => [key, vars[key] ?? ""])) as ScriptVars;

const text = v.optional(v.string());

export const scriptTargetSchema = v.looseObject({
  name: text,
  file: v.string(),
  args: v.optional(v.array(v.string())),
  timeoutSec: v.optional(v.number()),
});

export type ScriptTarget = v.InferOutput<typeof scriptTargetSchema>;

// A queued run of one script for one event.
export const scriptJobSchema = v.looseObject({
  kind: v.literal("script"),
  script: scriptTargetSchema,
  event: text,
  vars: v.optional(v.looseObject(Object.fromEntries(SCRIPT_VARS.map((key) => [key, text])))),
});

export interface ScriptRunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
  truncated: boolean;
}

export class ScriptPathError extends Error {
  code = "SCRIPT_PATH_REJECTED";
}

export function getScriptsDir(env = process.env) {
  const configured = String(env.AURRAL_SCRIPTS_DIR || "").trim();
  if (!configured) return null;
  try {
    const real = realpathSync(path.resolve(configured));
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export const scriptsEnabled = () => getScriptsDir() !== null;

// The script's real location, which must stay inside the scripts folder
// after every symlink is followed.
export async function resolveScriptFile(file: string, scriptsDir = getScriptsDir()) {
  if (!scriptsDir) throw new ScriptPathError("Custom scripts are not enabled");
  const name = String(file ?? "").trim();
  if (!name || name.includes("\0")) throw new ScriptPathError("Choose a script file");
  let real: string;
  try {
    real = await fs.realpath(path.resolve(scriptsDir, name));
  } catch {
    throw new ScriptPathError(`Script not found: ${name}`);
  }
  if (!isPathInsideRoot(real, scriptsDir)) {
    throw new ScriptPathError(`Script must be inside the scripts folder: ${name}`);
  }
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new ScriptPathError(`Script is not a file: ${name}`);
  try {
    await fs.access(real, fsConstants.X_OK);
  } catch {
    throw new ScriptPathError(`Script is not executable: ${name}`);
  }
  return real;
}

// Files directly in the scripts folder, named as settings refer to them.
export async function listScriptFiles(scriptsDir = getScriptsDir()) {
  if (!scriptsDir) return [];
  const entries = await fs.readdir(scriptsDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    try {
      const real = await fs.realpath(path.join(scriptsDir, entry.name));
      if (!isPathInsideRoot(real, scriptsDir) || !(await fs.stat(real)).isFile()) continue;
      const executable = await fs
        .access(real, fsConstants.X_OK)
        .then(() => true)
        .catch(() => false);
      files.push({ name: entry.name, executable });
    } catch {}
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

// Script settings exist only while AURRAL_SCRIPTS_DIR is set; otherwise
// settings read and save exactly as they do without the feature. Each script
// runs on its own events, none by default.
export function readableScriptSettings(integrations: StoredIntegrations): StoredIntegrations {
  const { scripts, ...rest } = integrations;
  if (!scriptsEnabled()) return rest;
  return {
    ...rest,
    scripts: (scripts ?? []).map((script) => ({ ...script, events: script.events ?? [] })),
  };
}

export function normalizeScriptSettings(integrations: StoredIntegrations) {
  if (!scriptsEnabled()) {
    delete integrations.scripts;
    return;
  }
  if (!Array.isArray(integrations.scripts)) return;
  integrations.scripts = integrations.scripts
    .map((script) => ({
      name: String(script.name ?? "").trim(),
      file: String(script.file ?? "").trim(),
      args: normalizeScriptArgs(script.args),
      timeoutSec: normalizeTimeoutSec(script.timeoutSec),
      enabled: script.enabled !== false,
      events: NOTIFICATION_EVENTS.filter((event) => script.events?.includes(event)),
    }))
    .filter((script) => script.file)
    .slice(0, MAX_SCRIPTS);
}

export function normalizeScriptArgs(args: unknown) {
  if (!Array.isArray(args)) return [];
  return args
    .filter((arg): arg is string => typeof arg === "string")
    .slice(0, SCRIPT_MAX_ARGS)
    .map((arg) => arg.slice(0, SCRIPT_MAX_ARG_LENGTH));
}

export function normalizeTimeoutSec(value: unknown) {
  const seconds = Math.floor(Number(value));
  if (!Number.isFinite(seconds) || seconds <= 0) return SCRIPT_DEFAULT_TIMEOUT_SEC;
  return Math.min(seconds, SCRIPT_MAX_TIMEOUT_SEC);
}

const envName = (key: string) =>
  `AURRAL_${key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()}`;

export const buildScriptEnv = (vars: ScriptVars, env = process.env) => ({
  ...Object.fromEntries(
    PASSTHROUGH_ENV.filter((key) => env[key] != null).map((key) => [key, String(env[key])]),
  ),
  ...Object.fromEntries(
    Object.entries(vars).map(([key, value]) => [envName(key), String(value ?? "")]),
  ),
});

function killGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

// Runs one script without a shell: arguments and event values reach it as
// plain strings, never as shell syntax.
export async function runScript(
  target: ScriptTarget,
  vars: ScriptVars,
  { scriptsDir = getScriptsDir() }: { scriptsDir?: string | null } = {},
): Promise<ScriptRunResult> {
  const file = await resolveScriptFile(target.file, scriptsDir);
  const args = normalizeScriptArgs(target.args);
  const timeoutMs = normalizeTimeoutSec(target.timeoutSec) * 1000;
  const started = Date.now();
  // Only the last SCRIPT_OUTPUT_LIMIT bytes are kept, so a chatty script shows its ending.
  let output = Buffer.alloc(0);
  let truncated = false;
  const keep = (chunk: Buffer) => {
    output = Buffer.concat([output, chunk]);
    if (output.length <= SCRIPT_OUTPUT_LIMIT) return;
    output = output.subarray(output.length - SCRIPT_OUTPUT_LIMIT);
    truncated = true;
  };

  return new Promise<ScriptRunResult>((resolve, reject) => {
    const child = spawn(file, args, {
      shell: false,
      detached: true,
      cwd: scriptsDir!,
      env: buildScriptEnv(vars),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const stopTimers = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    }, timeoutMs);

    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(vars));

    child.on("error", (error) => {
      stopTimers();
      reject(error);
    });
    child.on("close", (code, signal) => {
      stopTimers();
      // Reap anything the script left running in its group.
      if (timedOut) killGroup(child.pid, "SIGKILL");
      resolve({
        exitCode: code,
        signal: signal ?? null,
        timedOut,
        durationMs: Date.now() - started,
        output: output.toString("utf8"),
        truncated,
      });
    });
  });
}

export const scriptSucceeded = (result: ScriptRunResult) =>
  !result.timedOut && result.exitCode === 0;

const scriptLabel = (script: ScriptTarget) => String(script.name || "").trim() || script.file;

// One job per script, so a failing script retries alone and never holds up
// webhooks, Gotify, or another script.
export function queueScripts(
  { scripts }: StoredIntegrations,
  event: string,
  vars: ScriptVars = {},
) {
  if (!scriptsEnabled() || !Array.isArray(scripts)) return [];
  const resolved = scriptVars({ ...vars, event });
  return scripts
    .filter(
      (script) =>
        script.enabled !== false &&
        String(script.file || "").trim() &&
        script.events?.includes(event as NotificationEvent),
    )
    .map((script) =>
      enqueueNotification({
        kind: "script",
        script: {
          name: String(script.name || ""),
          file: String(script.file),
          args: script.args ?? [],
          ...(script.timeoutSec && { timeoutSec: Number(script.timeoutSec) }),
        },
        event,
        vars: resolved,
        requestedAt: Date.now(),
      }),
    );
}

// Runs a queued script job. A failure throws, so the job is retried.
export async function runScriptJob({
  script,
  event,
  vars = {},
}: v.InferOutput<typeof scriptJobSchema>) {
  const details = { script: scriptLabel(script), event: event || null };
  if (!scriptsEnabled()) {
    logger.warn("notifications", "Script skipped: custom scripts are not enabled", details);
    return;
  }
  let result: ScriptRunResult;
  try {
    result = await runScript(script, scriptVars({ ...vars, event }));
  } catch (error) {
    logger.error("notifications", "Script could not start", {
      ...details,
      message: asAppError(error)?.message || String(error),
    });
    throw error;
  }
  const { exitCode, signal, timedOut, durationMs } = result;
  // The end of the output, short enough for a log line.
  const output = result.output.slice(-2000);
  const logged = { ...details, exitCode, signal, timedOut, durationMs, output };
  if (scriptSucceeded(result)) {
    logger.info("notifications", "Script finished", logged);
    return;
  }
  logger.error("notifications", "Script failed", logged);
  throw new Error(
    timedOut
      ? `Script ${details.script} timed out`
      : `Script ${details.script} exited with ${exitCode ?? signal}`,
  );
}

export const sendScriptTest = (script: ScriptTarget) =>
  runScript(
    script,
    scriptVars({
      albumName: "Test album",
      artistName: "Test artist",
      albumPath: "/music/Test artist/Test album",
      username: "script-test-user",
      userId: "script-test-user",
      event: "scriptTest",
    }),
  );
