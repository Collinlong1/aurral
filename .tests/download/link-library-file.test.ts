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
  "link-library-file",
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

function addFailedJob(trackName: string) {
  const jobId = downloadTracker.addJob(
    { artistName: "Link Artist", trackName, managedBy: "aurral" },
    "library",
  );
  assert.ok(jobId != null);
  downloadTracker.setFailed(jobId, "No matching source result");
  return jobId;
}

type FileMatch = { fileId: number; title: string; albumTitle: string | null };

const searchFiles = async (jobId: string, q: string) => {
  const response = await fetch(
    `${baseUrl}/api/playlists/jobs/${jobId}/library-files?q=${encodeURIComponent(q)}`,
  );
  assert.equal(response.status, 200);
  return ((await response.json()) as { files: FileMatch[] }).files;
};

const linkFile = (jobId: string, fileId: number) =>
  fetch(`${baseUrl}/api/playlists/jobs/${jobId}/link-file`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fileId }),
  });

test("links a missing track to a Library file it finds by name", async () => {
  const filePath = await addLibraryFile("Link Artist", "Live Album", "Song One (Live)");
  await addLibraryFile("Other Artist", "Other Album", "Unrelated");
  const jobId = addFailedJob("Song One");

  const files = await searchFiles(jobId, "link song one");
  assert.deepEqual(
    files.map((file) => [file.title, file.albumTitle]),
    [["Song One (Live)", "Live Album"]],
  );
  assert.deepEqual(await searchFiles(jobId, "   "), []);

  const response = await linkFile(jobId, files[0]!.fileId);
  assert.equal(response.status, 200, await response.text());
  const job = downloadTracker.getJob(jobId);
  assert.equal(job?.status, "done");
  assert.equal(job?.finalPath, filePath);
  assert.equal(job?.albumName, "Live Album");
  assert.equal(job?.reusedLibraryFile, true);
});

test("finds a file under a slightly different name, best match first", async () => {
  await addLibraryFile("The Lanterns", "Night Drive", "Neon Coast");
  await addLibraryFile("The Lanterns", "Night Drive", "Harbor Song");
  await addLibraryFile("Neon Choir", "Hymns", "Morning");
  const jobId = addFailedJob("Neon Coast (Radio Edit)");

  const files = await searchFiles(jobId, "The Lanterns Neon Coast (Radio Edit)");
  assert.equal(files[0]!.title, "Neon Coast");
  assert.deepEqual(
    new Set(files.map((file) => file.title)),
    new Set(["Neon Coast", "Harbor Song", "Morning"]),
  );
});

test("treats LIKE wildcards in a search as text", async () => {
  await addLibraryFile("Link Artist", "Album", "Plain Title");
  const jobId = addFailedJob("Plain Title");
  assert.deepEqual(await searchFiles(jobId, "%"), []);
  assert.deepEqual(await searchFiles(jobId, "_"), []);
});

test("refuses to link a track that is not missing, or a file that is gone", async () => {
  const filePath = await addLibraryFile("Link Artist", "Album", "Kept Song");
  const [file] = await searchFiles(addFailedJob("Kept Song"), "kept song");

  const doneJob = downloadTracker.addJob(
    { artistName: "Link Artist", trackName: "Done" },
    "library",
  );
  assert.ok(doneJob != null);
  downloadTracker.setDone(doneJob, filePath, "Album");
  assert.equal((await linkFile(doneJob, file!.fileId)).status, 409);

  const missingJob = addFailedJob("Kept Song");
  assert.equal((await linkFile(missingJob, 999_999)).status, 404);
  await fs.rm(filePath);
  assert.equal((await linkFile(missingJob, file!.fileId)).status, 409);
  assert.equal(downloadTracker.getJob(missingJob)?.status, "failed");
});

test("standalone linking accepts saved/cancelled tracks but excludes a cancelled album", async () => {
  await addLibraryFile("Link Artist", "Album", "Available");
  const [file] = await searchFiles(addFailedJob("Available"), "available");
  assert.ok(file);
  const saved = downloadTracker.addJob(
    { artistName: "Link Artist", trackName: "Saved" },
    "library",
    { saved: true },
  );
  assert.ok(saved);
  assert.equal((await linkFile(saved, file.fileId)).status, 200);
  const cancelled = downloadTracker.addJob(
    { artistName: "Link Artist", trackName: "Cancelled" },
    "library",
  );
  assert.ok(cancelled);
  downloadTracker.setCancelled(cancelled);
  assert.equal((await linkFile(cancelled, file.fileId)).status, 200);
  const albumJob = downloadTracker.addJob(
    { artistName: "Link Artist", trackName: "Album Cancelled", requestGroupId: "cancelled-album" },
    "library",
  );
  assert.ok(albumJob);
  downloadTracker.setCancelled(albumJob);
  const { cancelDownloadJob } =
    await import("../../backend/services/downloadJobs/downloadCancellation.ts");
  cancelDownloadJob(albumJob);
  assert.equal((await linkFile(albumJob, file.fileId)).status, 409);
});
