import { spawn } from "child_process";
import { constants as fsConstants, realpathSync, statSync } from "fs";
import fs from "fs/promises";
import path from "path";
import { isPathInsideRoot } from "./downloadPaths.ts";

// Custom script hooks run admin-chosen executables from AURRAL_SCRIPTS_DIR
// when a notification event fires. The feature is off unless that folder is
// set and exists.

export const SCRIPT_OUTPUT_LIMIT = 64 * 1024;
export const SCRIPT_DEFAULT_TIMEOUT_SEC = 60;
export const SCRIPT_MAX_TIMEOUT_SEC = 3600;
export const SCRIPT_MAX_ARGS = 32;
export const SCRIPT_MAX_ARG_LENGTH = 4096;
const KILL_GRACE_MS = 5000;
// Only these variables reach a script from Aurral's own environment, so
// secrets in it stay out of the script's.
const PASSTHROUGH_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR"];

export type ScriptVars = Partial<
  Record<
    | "event"
    | "albumName"
    | "artistName"
    | "albumPath"
    | "username"
    | "userId"
    | "flowName"
    | "flowPath",
    string
  >
>;

export interface ScriptTarget {
  name?: string | null;
  file: string;
  args?: string[] | null;
  timeoutSec?: number | null;
}

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

export function buildScriptEnv(vars: ScriptVars, env = process.env) {
  const result: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    if (env[key] != null) result[key] = String(env[key]);
  }
  for (const [key, value] of Object.entries(vars)) {
    result[envName(key)] = String(value ?? "");
  }
  return result;
}

// Keeps the last `limit` bytes written, so a chatty script shows its ending.
class OutputTail {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  private limit: number;
  constructor(limit: number) {
    this.limit = limit;
  }
  push(chunk: Buffer) {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.limit && this.chunks.length > 0) {
      const overflow = this.size - this.limit;
      const first = this.chunks[0];
      this.truncated = true;
      if (first.length <= overflow) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.subarray(overflow);
        this.size -= overflow;
      }
    }
  }
  toString() {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

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
  const output = new OutputTail(SCRIPT_OUTPUT_LIMIT);

  return new Promise<ScriptRunResult>((resolve, reject) => {
    const child = spawn(file, args, {
      shell: false,
      detached: true,
      cwd: scriptsDir!,
      env: buildScriptEnv(vars),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(vars));

    child.on("error", (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      // Reap anything the script left running in its group.
      if (timedOut) killGroup(child.pid, "SIGKILL");
      resolve({
        exitCode: code,
        signal: signal ?? null,
        timedOut,
        durationMs: Date.now() - started,
        output: output.toString(),
        truncated: output.truncated,
      });
    });
  });
}

export const scriptSucceeded = (result: ScriptRunResult) =>
  !result.timedOut && result.exitCode === 0;
