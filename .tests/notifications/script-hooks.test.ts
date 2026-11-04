import { listeningAddress } from "../helpers/backendTestHarness.ts";
import { signedInAs } from "../helpers/honoApp.ts";
import { testUser } from "../helpers/userFixtures.ts";
import { test, beforeEach, afterEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { dbOps },
  notifications,
  honker,
  hooks,
  appSettings,
  { default: scriptRoutes },
] = await setupIsolatedBackend(
  "script-hooks",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/notificationService.ts"),
  () => import("../../backend/services/honkerDb.ts"),
  () => import("../../backend/services/scriptHooks.ts"),
  () => import("../../backend/services/appSettings.ts"),
  () => import("../../backend/routes/settings/scripts.ts"),
);

const { notifyRequestAvailable, deliverQueuedNotification } = notifications;
const { runScript, resolveScriptFile, listScriptFiles, getScriptsDir, SCRIPT_OUTPUT_LIMIT } = hooks;

let root = "";
let scriptsDir = "";
let outside = "";
const originalEnv = process.env.AURRAL_SCRIPTS_DIR;

function writeScript(dir: string, name: string, body: string, mode = 0o755) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode });
  return file;
}

async function waitForFile(file: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // Let the script finish writing.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return fs.readFileSync(file, "utf8");
}

// A killed process whose parent is gone stays a zombie until init reaps it,
// which some container inits never do.
const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[2] !== "Z";
  } catch {
    return true;
  }
};

const queuedScriptFiles = () =>
  honker
    .listHonkerJobs("_outbox:notifications")
    .map((job) => job.payload as { kind?: string; script?: { file?: string } })
    .filter((payload) => payload.kind === "script")
    .map((payload) => payload.script?.file);

beforeEach(() => {
  resetDatabase(db);
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aurral-scripts-")));
  scriptsDir = path.join(root, "scripts");
  outside = path.join(root, "outside");
  fs.mkdirSync(scriptsDir);
  fs.mkdirSync(outside);
  process.env.AURRAL_SCRIPTS_DIR = scriptsDir;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.AURRAL_SCRIPTS_DIR;
  else process.env.AURRAL_SCRIPTS_DIR = originalEnv;
  fs.rmSync(root, { recursive: true, force: true });
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

test("the feature is off without AURRAL_SCRIPTS_DIR, and settings read as upstream", () => {
  const fresh = appSettings.readAppSettings().integrations;
  assert.deepEqual(fresh.scripts, []);
  assert.equal(fresh.scriptEvents?.notifyRequestAvailable, false);

  dbOps.updateSettings({
    integrations: {
      scripts: [{ name: "x", file: "x.sh", args: [], timeoutSec: 5, enabled: true }],
      scriptEvents: { notifyRequestAvailable: true },
    },
  });
  assert.equal(getScriptsDir(), scriptsDir);
  const enabled = appSettings.readAppSettings().integrations;
  assert.equal(enabled.scripts?.length, 1);
  assert.equal(enabled.scriptEvents?.notifyRequestAvailable, true);

  delete process.env.AURRAL_SCRIPTS_DIR;
  assert.equal(getScriptsDir(), null);
  const disabled = appSettings.readAppSettings().integrations;
  assert.equal("scripts" in disabled, false);
  assert.equal("scriptEvents" in disabled, false);

  process.env.AURRAL_SCRIPTS_DIR = path.join(root, "missing");
  assert.equal(getScriptsDir(), null);
});

test("scripts outside the folder are rejected, including through symlinks", async () => {
  writeScript(scriptsDir, "ok.sh", "exit 0");
  const escaped = writeScript(outside, "evil.sh", "exit 0");
  fs.symlinkSync(escaped, path.join(scriptsDir, "link-out.sh"));
  fs.symlinkSync(outside, path.join(scriptsDir, "dir-out"));
  fs.symlinkSync(path.join(scriptsDir, "ok.sh"), path.join(scriptsDir, "link-in.sh"));
  writeScript(scriptsDir, "plain.txt", "exit 0", 0o644);

  assert.equal(await resolveScriptFile("ok.sh"), path.join(scriptsDir, "ok.sh"));
  assert.equal(await resolveScriptFile("link-in.sh"), path.join(scriptsDir, "ok.sh"));
  for (const file of [
    "../outside/evil.sh",
    escaped,
    "link-out.sh",
    "dir-out/evil.sh",
    "plain.txt",
    "missing.sh",
    "",
    ".",
  ]) {
    await assert.rejects(resolveScriptFile(file), { code: "SCRIPT_PATH_REJECTED" }, file);
  }

  assert.deepEqual(await listScriptFiles(), [
    { name: "link-in.sh", executable: true },
    { name: "ok.sh", executable: true },
    { name: "plain.txt", executable: false },
  ]);
});

test("event values reach the script as env and stdin JSON, never as shell syntax", async () => {
  const out = path.join(root, "env.txt");
  const pwned = path.join(root, "pwned");
  writeScript(
    scriptsDir,
    "dump.sh",
    `{ env | grep '^AURRAL_' | sort; echo "ARGS:$#:$1|$2"; echo "STDIN:$(cat)"; } > "${out}"`,
  );
  const album = `"; rm -rf / # $(touch ${pwned}) \`touch ${pwned}\``;
  const result = await runScript(
    { file: "dump.sh", args: ["two words", `; touch ${pwned}`] },
    {
      event: "notifyRequestAvailable",
      albumName: album,
      artistName: "John Coltrane",
      albumPath: "/music/John Coltrane/Blue Train",
      username: "alice",
      userId: "7",
      flowName: "",
      flowPath: "",
    },
  );
  assert.equal(result.exitCode, 0);
  const dump = fs.readFileSync(out, "utf8");
  assert.match(dump, /^AURRAL_ALBUM_NAME=/m);
  assert.ok(dump.includes(`AURRAL_ALBUM_NAME=${album}\n`));
  assert.ok(dump.includes("AURRAL_ALBUM_PATH=/music/John Coltrane/Blue Train\n"));
  assert.ok(dump.includes("AURRAL_ARTIST_NAME=John Coltrane\n"));
  assert.ok(dump.includes("AURRAL_EVENT=notifyRequestAvailable\n"));
  assert.ok(dump.includes("AURRAL_USERNAME=alice\n"));
  assert.ok(dump.includes("AURRAL_USER_ID=7\n"));
  assert.ok(dump.includes(`ARGS:2:two words|; touch ${pwned}\n`));
  const stdin = JSON.parse(dump.split("STDIN:")[1]!);
  assert.equal(stdin.albumName, album);
  assert.equal(stdin.albumPath, "/music/John Coltrane/Blue Train");
  assert.equal(fs.existsSync(pwned), false);
});

test("Aurral's own environment stays out of the script's", async () => {
  const out = path.join(root, "env.txt");
  writeScript(scriptsDir, "env.sh", `env > "${out}"`);
  process.env.AURRAL_TEST_SECRET = "do-not-leak";
  try {
    await runScript({ file: "env.sh" }, { event: "scriptTest" });
  } finally {
    delete process.env.AURRAL_TEST_SECRET;
  }
  assert.doesNotMatch(fs.readFileSync(out, "utf8"), /do-not-leak/);
});

test("a timeout kills the script and everything it started", async () => {
  const pidFile = path.join(root, "child.pid");
  writeScript(scriptsDir, "hang.sh", `sleep 30 & echo $! > "${pidFile}"; echo started; wait`);
  const result = await runScript({ file: "hang.sh", timeoutSec: 1 }, { event: "scriptTest" });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.match(result.output, /started/);
  assert.ok(result.durationMs < 8000);
  const child = Number(fs.readFileSync(pidFile, "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(isAlive(child), false);
});

test("output is capped to its last 64KB and failures report the exit code", async () => {
  writeScript(
    scriptsDir,
    "loud.sh",
    "i=0; while [ $i -lt 2000 ]; do echo 'line padded to make this output long enough'; i=$((i+1)); done; echo END >&2; exit 3",
  );
  const result = await runScript({ file: "loud.sh" }, { event: "scriptTest" });
  assert.equal(result.exitCode, 3);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.output) <= SCRIPT_OUTPUT_LIMIT);
  assert.match(result.output, /END\n$/);
});

test("a failing script throws for retry and logs its exit and output", async () => {
  writeScript(scriptsDir, "fail.sh", "echo boom; exit 2");
  const errors: unknown[][] = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    await assert.rejects(
      deliverQueuedNotification({
        kind: "script",
        script: { name: "Fail", file: "fail.sh" },
        event: "notifyRequestAvailable",
        vars: { albumName: "Blue Train" },
      }),
      /Script Fail exited with 2/,
    );
  } finally {
    console.error = originalError;
  }
  const logged = JSON.stringify(errors);
  assert.match(logged, /Script failed/);
  assert.match(logged, /boom/);
});

test("a real request-available event runs each script independently of webhooks", async () => {
  const out = path.join(root, "ran.txt");
  writeScript(scriptsDir, "fail.sh", "exit 1");
  writeScript(scriptsDir, "record.sh", `env | grep '^AURRAL_' | sort > "${out}"`);

  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests.push(String(req.url));
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const originalError = console.error;
  console.error = () => {};
  try {
    dbOps.updateSettings({
      integrations: {
        webhookEvents: { notifyRequestAvailable: true },
        webhooks: [{ url: `http://127.0.0.1:${listeningAddress(server).port}/hook`, headers: [] }],
        scriptEvents: { notifyRequestAvailable: true, notifyRequestMade: false },
        scripts: [
          { name: "Fails", file: "fail.sh", args: [], timeoutSec: 5, enabled: true },
          { name: "Off", file: "record.sh", args: ["off"], timeoutSec: 5, enabled: false },
          { name: "Records", file: "record.sh", args: [], timeoutSec: 5, enabled: true },
        ],
      },
    });

    const queuedBefore = queuedScriptFiles().length;
    await notifications.notifyRequestMade({ albumName: "Ignored" });
    await notifyRequestAvailable({
      albumName: "Blue Train",
      artistName: "John Coltrane",
      albumPath: "/music/John Coltrane/Blue Train",
      user: { id: 7, username: "alice" },
    });

    const env = await waitForFile(out);
    assert.match(env, /^AURRAL_EVENT=notifyRequestAvailable$/m);
    assert.match(env, /^AURRAL_ALBUM_NAME=Blue Train$/m);
    assert.match(env, /^AURRAL_ARTIST_NAME=John Coltrane$/m);
    assert.match(env, /^AURRAL_ALBUM_PATH=\/music\/John Coltrane\/Blue Train$/m);
    assert.match(env, /^AURRAL_USERNAME=alice$/m);
    assert.match(env, /^AURRAL_USER_ID=7$/m);

    const deadline = Date.now() + 5000;
    while (requests.length < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual(requests, ["/hook"]);

    // The failing script stays queued for retry; the others are done.
    assert.deepEqual(queuedScriptFiles().slice(queuedBefore), ["fail.sh"]);
  } finally {
    console.error = originalError;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("scripts are not queued while the feature is off", async () => {
  delete process.env.AURRAL_SCRIPTS_DIR;
  dbOps.updateSettings({
    integrations: {
      scriptEvents: { notifyRequestAvailable: true },
      scripts: [{ name: "x", file: "x.sh", args: [], timeoutSec: 5, enabled: true }],
    },
  });
  const queuedBefore = queuedScriptFiles().length;
  await notifyRequestAvailable({ albumName: "Blue Train" });
  assert.equal(queuedScriptFiles().length, queuedBefore);
});

test("script endpoints are admin-only and hidden while the feature is off", async () => {
  writeScript(scriptsDir, "hello.sh", 'echo "hello $AURRAL_EVENT"; exit 4');
  const admin = signedInAs(testUser(1, { role: "admin" })).route("/", scriptRoutes);
  const member = signedInAs(testUser(2)).route("/", scriptRoutes);
  const post = (body: unknown) => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  assert.equal((await member.request("/settings/scripts/files")).status, 403);
  assert.equal(
    (await member.request("/settings/scripts/test", post({ file: "hello.sh" }))).status,
    403,
  );

  const files = await admin.request("/settings/scripts/files");
  assert.equal(files.status, 200);
  assert.deepEqual(await files.json(), { files: [{ name: "hello.sh", executable: true }] });

  const run = await admin.request("/settings/scripts/test", post({ file: "hello.sh" }));
  assert.equal(run.status, 200);
  const body = await run.json();
  assert.equal(body.success, false);
  assert.equal(body.exitCode, 4);
  assert.equal(body.output, "hello scriptTest\n");

  const escaped = await admin.request("/settings/scripts/test", post({ file: "../outside/x" }));
  assert.equal(escaped.status, 400);

  delete process.env.AURRAL_SCRIPTS_DIR;
  for (const app of [admin, member]) {
    const hidden = await app.request("/settings/scripts/files");
    assert.equal(hidden.status, 404);
    assert.deepEqual(await hidden.json(), { error: "Not found" });
  }
});
