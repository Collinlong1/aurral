import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { test } from "vite-plus/test";
import Database from "better-sqlite3";
import type { SettingsRow } from "../../backend/db/rows.ts";

import { createIsolatedStateDir } from "../helpers/backendTestHarness.ts";

test("upgrading turns each per-event webhook body into its own webhook", async () => {
  const state = await createIsolatedStateDir("webhook-event-bodies-migration");
  const start = () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'const { db } = await import("./backend/config/db-sqlite.ts"); db.close();',
      ],
      {
        cwd: new URL("../..", import.meta.url),
        env: {
          ...process.env,
          AURRAL_DATA_DIR: state.dataDir,
          AURRAL_DB_PATH: state.dbPath,
          NODE_ENV: "test",
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
  };

  start();
  const db = new Database(state.dbPath);
  try {
    const headers = [{ key: "X-Token", value: "secret" }];
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('integrations', ?)").run(
      JSON.stringify({
        gotify: { url: "http://gotify.test" },
        webhooks: [
          {
            url: "http://hook.test",
            body: '{"text":"$message"}',
            headers,
            events: ["notifyRequestMade", "notifyRequestAvailable", "notifyWeeklyFlowDone"],
            eventBodies: {
              notifyRequestMade: '{"text":"Requested $albumName"}',
              notifyRequestAvailable: ' {"text":"Requested $albumName"} ',
              notifyWeeklyFlowDone: "   ",
              notifyArtistAdded: '{"text":"never sent"}',
            },
          },
          {
            url: "http://only-bodies.test",
            headers: [],
            events: ["notifyArtistAdded"],
            eventBodies: { notifyArtistAdded: '{"artist":"$artistName"}' },
          },
          { url: "http://plain.test", headers: [], events: ["notifyTrackAdded"] },
        ],
      }),
    );
    db.prepare("DELETE FROM settings WHERE key = 'migration:webhook-event-bodies-split-v1'").run();

    start();

    const stored = db
      .prepare<[], Pick<SettingsRow, "value">>(
        "SELECT value FROM settings WHERE key = 'integrations'",
      )
      .get();
    assert.deepEqual(JSON.parse(stored?.value ?? "null"), {
      gotify: { url: "http://gotify.test" },
      webhooks: [
        {
          url: "http://hook.test",
          body: '{"text":"$message"}',
          headers,
          events: ["notifyWeeklyFlowDone"],
        },
        {
          url: "http://hook.test",
          body: '{"text":"Requested $albumName"}',
          headers,
          events: ["notifyRequestMade", "notifyRequestAvailable"],
        },
        {
          url: "http://only-bodies.test",
          body: '{"artist":"$artistName"}',
          headers: [],
          events: ["notifyArtistAdded"],
        },
        { url: "http://plain.test", headers: [], events: ["notifyTrackAdded"] },
      ],
    });
  } finally {
    db.close();
    await rm(state.baseDir, { recursive: true, force: true });
  }
});
