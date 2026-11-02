import { listeningAddress } from "../helpers/backendTestHarness.ts";
import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { dbOps }, history, completion] = await setupIsolatedBackend(
  "request-available",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/aurralHistoryService.ts"),
  () => import("../../backend/services/aurralRequestCompletion.ts"),
);

const { commonDirectory, requestAvailableOutcome } = completion;

beforeEach(() => {
  resetDatabase(db);
});

afterAll(async () => {
  await cleanupIsolatedState(isolatedState);
});

type RequestJob = Parameters<typeof requestAvailableOutcome>[0];

const job = (overrides: Partial<RequestJob>): RequestJob => ({
  id: String(Math.random()),
  status: "done",
  managedBy: "aurral",
  playlistType: "library",
  requestGroupId: "group-1",
  upgradeForJobId: null,
  finalPath: "/music/Artist/Album/01 - One.flac",
  ...overrides,
});

test("commonDirectory resolves the album folder across discs", () => {
  assert.equal(
    commonDirectory(["/music/A/B/01 - One.flac", "/music/A/B/02 - Two.flac"]),
    path.resolve("/music/A/B"),
  );
  assert.equal(
    commonDirectory(["/music/A/B/CD1/01.flac", "/music/A/B/CD2/01.flac"]),
    path.resolve("/music/A/B"),
  );
});

test("an Aurral request is available only once every job has ended with one in the Library", () => {
  const done = job({});
  const pending = job({ status: "pending", finalPath: null });
  assert.equal(requestAvailableOutcome(done, [done, pending]), null);

  const blocked = job({ status: "blocked", finalPath: null });
  assert.equal(requestAvailableOutcome(done, [done, blocked]), null);

  const failed = job({ status: "failed", finalPath: null });
  assert.deepEqual(requestAvailableOutcome(done, [done, failed]), {
    requestGroupId: "group-1",
    albumPath: path.resolve("/music/Artist/Album"),
  });

  assert.equal(requestAvailableOutcome(failed, [failed]), null);
  const other = job({ requestGroupId: "group-2", status: "pending" });
  assert.ok(requestAvailableOutcome(done, [done, other]));
  const lidarr = job({ managedBy: "lidarr" });
  assert.equal(requestAvailableOutcome(lidarr, [lidarr]), null);
});

test("a finished Aurral request sends request-available once, with its album path", async () => {
  const bodies: unknown[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    dbOps.updateSettings({
      integrations: {
        webhookEvents: { notifyRequestAvailable: true },
        webhooks: [
          {
            url: `http://127.0.0.1:${listeningAddress(server).port}/hook`,
            body: '{"event":"$event","album":"$albumName","path":"$albumPath"}',
            headers: [],
          },
        ],
      },
    });
    history.recordAlbumRequested({
      albumId: "album-1",
      albumName: "Blue Train",
      artistName: "John Coltrane",
      managedBy: "aurral",
      requestGroupId: "group-1",
      searching: true,
    });

    const entry = history.recordAurralRequestAvailable({
      requestGroupId: "group-1",
      albumPath: "/music/John Coltrane/Blue Train",
    });
    assert.equal(entry?.statusLabel, "Downloaded");
    assert.equal(entry?.metadata?.managedBy, "aurral");
    assert.equal(
      history.recordAurralRequestAvailable({ requestGroupId: "group-1", albumPath: "/x" }),
      null,
    );

    const deadline = Date.now() + 5000;
    while (bodies.length < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(bodies, [
      {
        event: "notifyRequestAvailable",
        album: "Blue Train",
        path: "/music/John Coltrane/Blue Train",
      },
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
