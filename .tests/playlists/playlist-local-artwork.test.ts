import { test, beforeAll, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { listen, signedInAs } from "../helpers/honoApp.ts";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [
  isolatedState,
  { db },
  { dbOps },
  libraryStore,
  { downloadTracker },
  { downloadWorker },
  { api },
] = await setupIsolatedBackend(
  "playlist-local-artwork",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/libraryMediaStore.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
  () => import("../../backend/services/downloadJobs/downloadWorker.ts"),
  () => import("../../backend/routes/api.ts"),
);

const server = await listen(
  signedInAs({ id: 1, username: "test", role: "admin", permissions: {} }).route("/api", api),
);
const address = server.address();
assert.ok(address && typeof address !== "string");
const baseUrl = `http://127.0.0.1:${address.port}`;

const managedRoot = path.join(isolatedState.baseDir, "managed");
const originalSettings = dbOps.getSettings();
const originalWorkerStart = downloadWorker.start;

beforeAll(async () => {
  await fs.mkdir(managedRoot, { recursive: true });
  downloadWorker.start = async () => {};
});

beforeEach(() => {
  downloadTracker.clearAll();
  resetDatabase(db);
  dbOps.updateSettings({ ...originalSettings, downloadFolderPath: managedRoot });
});

afterAll(async () => {
  downloadWorker.start = originalWorkerStart;
  dbOps.updateSettings(originalSettings);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanupIsolatedState(isolatedState);
});

async function addLibraryFile(artistName: string, albumTitle: string, title: string) {
  const artist = libraryStore.upsertLibraryArtist({
    identityKey: `name:${artistName}`,
    name: artistName,
  });
  const album = libraryStore.upsertLibraryAlbum({
    identityKey: `album:${artistName}:${albumTitle}`,
    artistId: artist.id,
    title: albumTitle,
  });
  const track = libraryStore.upsertLibraryTrack({
    identityKey: `track:${artistName}:${title}`,
    title,
    artistName,
  });
  libraryStore.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
  const filePath = path.join(managedRoot, artistName, albumTitle, `${title}.flac`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, "audio");
  libraryStore.upsertLibraryMediaFile({
    scanId: undefined,
    trackId: track.id,
    albumId: album.id,
    source: "aurral",
    path: filePath,
  });
  return filePath;
}

test("a playlist track linked to a Library file gets that album's cover", async () => {
  const { flowPlaylistConfig } =
    await import("../../backend/services/playlists/flowPlaylistConfig.ts");
  const filePath = await addLibraryFile("Link Artist", "Cover Album", "Covered Song");
  const [coveredJob, missingJob] = [
    { artistName: "Link Artist", trackName: "Covered Song" },
    { artistName: "Link Artist", trackName: "Still Missing" },
  ].map((track) => {
    const jobId = downloadTracker.addJob({ ...track, managedBy: "aurral" }, "library");
    assert.ok(jobId != null);
    downloadTracker.setFailed(jobId, "No matching source result");
    return jobId;
  });
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: `Covers ${Date.now()}`,
    tracks: [
      { artistName: "Link Artist", trackName: "Covered Song", canonicalJobId: coveredJob! },
      { artistName: "Link Artist", trackName: "Still Missing", canonicalJobId: missingJob! },
    ],
  });
  downloadTracker.setDone(coveredJob!, filePath, "Cover Album");
  const albumId = (
    db.prepare("SELECT id FROM library_albums WHERE title = ?").get("Cover Album") as {
      id: number;
    }
  ).id;

  const response = await fetch(`${baseUrl}/api/playlists/jobs/${playlist.id}`);
  assert.equal(response.status, 200);
  const jobs = (await response.json()) as { id: string; artworkUrl: string | null }[];
  // With no album MBID for an online cover, the track uses the Library album's cover.
  assert.match(
    String(jobs.find((job) => job.id === coveredJob)?.artworkUrl),
    new RegExp(`^/api/library/albums/${albumId}/cover`),
  );
  assert.equal(jobs.find((job) => job.id === missingJob)?.artworkUrl, null);
});
