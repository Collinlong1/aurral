import { test, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import { listen, signedInAs } from "../helpers/honoApp.ts";

import {
  setupIsolatedBackend,
  cleanupIsolatedState,
  resetDatabase,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { downloadTracker },
  { flowPlaylistConfig },
  { collectPlaylistFileTracks },
  { api },
] = await setupIsolatedBackend(
  "playlist-track-order",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
  () => import("../../backend/services/playlists/playlistFileTracks.ts"),
  () => import("../../backend/routes/api.ts"),
);

const server = await listen(
  signedInAs({ id: 1, username: "test", role: "admin", permissions: {} }).route("/api", api),
);
const address = server.address();
assert.ok(address && typeof address !== "string");
const baseUrl = `http://127.0.0.1:${address.port}`;

const downloadRoot = process.env.WEEKLY_FLOW_FOLDER;
assert.ok(downloadRoot != null);

beforeEach(async () => {
  await resetDatabase(db);
  downloadTracker.clearAll();
  await fs.rm(downloadRoot, { recursive: true, force: true });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupIsolatedState(isolatedState);
});

let sequence = 0;

async function createPlaylist(names: string[]) {
  sequence += 1;
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: `Ordered ${sequence}`,
    tracks: names.map((name) => ({ artistName: "Artist", trackName: name, albumName: "Album" })),
  });
  const jobIds: string[] = [];
  for (const track of playlist.tracks) {
    const jobId = downloadTracker.addJob(track, playlist.id);
    assert.ok(jobId != null);
    const filePath = path.join(downloadRoot!, "music", `${track.trackName}.flac`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "audio");
    downloadTracker.setDone(jobId, filePath, "Album");
    jobIds.push(jobId);
  }
  return { playlist, jobIds };
}

const putOrder = (playlistId: string, jobIds: string[]) =>
  fetch(`${baseUrl}/api/playlists/shared-playlists/${playlistId}/track-order`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobIds }),
  });

const trackNames = (playlistId: string) =>
  flowPlaylistConfig.getStaticPlaylist(playlistId)!.tracks.map((track) => track.trackName);

test("reorders a playlist's tracks and its playlist file", async () => {
  const { playlist, jobIds } = await createPlaylist(["One", "Two", "Three"]);
  const membershipIds = playlist.tracks.map((track) => track.membershipId);

  const response = await putOrder(playlist.id, [jobIds[2], jobIds[0], jobIds[1]]);
  assert.equal(response.status, 200, await response.text());

  assert.deepEqual(trackNames(playlist.id), ["Three", "One", "Two"]);
  assert.deepEqual(
    flowPlaylistConfig.getStaticPlaylist(playlist.id)!.tracks.map((track) => track.membershipId),
    [membershipIds[2], membershipIds[0], membershipIds[1]],
  );
  const fileTracks = await collectPlaylistFileTracks(playlist.id, { downloadRoot });
  assert.deepEqual(
    fileTracks.map((entry) => path.basename(entry.path)),
    ["Three.flac", "One.flac", "Two.flac"],
  );
});

test("refuses an order that leaves out or repeats a track", async () => {
  const { playlist, jobIds } = await createPlaylist(["One", "Two", "Three"]);

  const missing = await putOrder(playlist.id, [jobIds[1], jobIds[0]]);
  assert.equal(missing.status, 409);
  const repeated = await putOrder(playlist.id, [jobIds[1], jobIds[1], jobIds[0]]);
  assert.equal(repeated.status, 409);
  assert.deepEqual(trackNames(playlist.id), ["One", "Two", "Three"]);
});

test("ignores ids that are not tracks of the playlist", async () => {
  const { playlist, jobIds } = await createPlaylist(["One", "Two"]);

  const response = await putOrder(playlist.id, ["not-a-job", jobIds[1], jobIds[0]]);
  assert.equal(response.status, 200, await response.text());
  assert.deepEqual(trackNames(playlist.id), ["Two", "One"]);
});

test("returns 404 for an unknown playlist", async () => {
  const response = await putOrder("missing-playlist", []);
  assert.equal(response.status, 404);
});
