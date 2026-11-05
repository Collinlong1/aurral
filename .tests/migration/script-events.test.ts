import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { test } from "vite-plus/test";
import Database from "better-sqlite3";
import type { SettingsRow } from "../../backend/db/rows.ts";

import { createIsolatedStateDir } from "../helpers/backendTestHarness.ts";

test("upgrading gives every saved script the events that were turned on for all scripts", async () => {
  const state = await createIsolatedStateDir("script-events-migration");
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
    const webhooks = [{ url: "http://hook.test", headers: [], events: ["notifyTrackAdded"] }];
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('integrations', ?)").run(
      JSON.stringify({
        webhooks,
        scriptEvents: {
          notifyRequestAvailable: true,
          notifyRequestMade: false,
          notifyArtistAdded: true,
        },
        scripts: [
          { name: "Tag", file: "tag.sh", args: [], timeoutSec: 60, enabled: true },
          { name: "Scan", file: "scan.sh", args: ["--all"], timeoutSec: 5, enabled: false },
        ],
      }),
    );
    db.prepare("DELETE FROM settings WHERE key = 'migration:script-events-per-script-v1'").run();

    start();

    const stored = db
      .prepare<[], Pick<SettingsRow, "value">>(
        "SELECT value FROM settings WHERE key = 'integrations'",
      )
      .get();
    const events = ["notifyRequestAvailable", "notifyArtistAdded"];
    assert.deepEqual(JSON.parse(stored?.value ?? "null"), {
      webhooks,
      scripts: [
        { name: "Tag", file: "tag.sh", args: [], timeoutSec: 60, enabled: true, events },
        { name: "Scan", file: "scan.sh", args: ["--all"], timeoutSec: 5, enabled: false, events },
      ],
    });
  } finally {
    db.close();
    await rm(state.baseDir, { recursive: true, force: true });
  }
});
