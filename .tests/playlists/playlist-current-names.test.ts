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
  "playlist-current-names",
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

test("a playlist track playing a Library file shows the Library's current names", async () => {
  const { flowPlaylistConfig } =
    await import("../../backend/services/playlists/flowPlaylistConfig.ts");
  const filePath = path.join(managedRoot, "Tagged Artist", "Tagged Album", "Tagged Song.flac");
  await addLibraryFile("Tagged Artist", "Tagged Album", "Tagged Song");
  const [libraryJob, otherJob] = [
    { artistName: "Import Spelling", trackName: "Tagged Song - Remastered" },
    { artistName: "Nowhere Artist", trackName: "Not In Library" },
  ].map((track) => {
    const jobId = downloadTracker.addJob({ ...track, albumName: "Import Album" }, "library");
    assert.ok(jobId != null);
    return jobId;
  });
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: `Names ${Date.now()}`,
    tracks: [
      {
        artistName: "Import Spelling",
        trackName: "Tagged Song - Remastered",
        canonicalJobId: libraryJob!,
      },
      { artistName: "Nowhere Artist", trackName: "Not In Library", canonicalJobId: otherJob! },
    ],
  });
  downloadTracker.setDone(libraryJob!, filePath, "Import Album");
  downloadTracker.setDone(otherJob!, path.join(isolatedState.baseDir, "elsewhere.flac"));

  const names = async () => {
    const response = await fetch(`${baseUrl}/api/playlists/jobs/${playlist.id}`);
    assert.equal(response.status, 200);
    const jobs = (await response.json()) as {
      id: string;
      trackName: string;
      artistName: string;
      albumName: string | null;
    }[];
    return Object.fromEntries(
      jobs.map((job) => [job.id, [job.trackName, job.artistName, job.albumName]]),
    );
  };
  assert.deepEqual((await names())[libraryJob!], ["Tagged Song", "Tagged Artist", "Tagged Album"]);
  assert.deepEqual((await names())[otherJob!], [
    "Not In Library",
    "Nowhere Artist",
    "Import Album",
  ]);

  // A re-tag the Library picks up shows on the playlist too.
  libraryStore.upsertLibraryTrack({
    identityKey: "track:Tagged Artist:Tagged Song",
    title: "Tagged Song (Live)",
    artistName: "Tagged Artist feat. Guest",
  });
  assert.deepEqual((await names())[libraryJob!], [
    "Tagged Song (Live)",
    "Tagged Artist feat. Guest",
    "Tagged Album",
  ]);
});
