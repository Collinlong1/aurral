import { test, beforeAll, beforeEach, afterAll } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { listen, signedInAs } from "../helpers/honoApp.ts";
import { writeFlacFixture } from "../helpers/flacFixture.ts";

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

  const response = await linkFile(jobId, files[0].fileId);
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
  assert.equal(files[0].title, "Neon Coast");
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
  assert.equal((await linkFile(doneJob, file.fileId)).status, 409);

  const missingJob = addFailedJob("Kept Song");
  assert.equal((await linkFile(missingJob, 999_999)).status, 404);
  await fs.rm(filePath);
  assert.equal((await linkFile(missingJob, file.fileId)).status, 409);
  assert.equal(downloadTracker.getJob(missingJob)?.status, "failed");
});

const externalRoot = path.join(isolatedState.baseDir, "lidarr-music");

const importFile = (jobId: string, filePath: string) =>
  fetch(`${baseUrl}/api/playlists/jobs/${jobId}/import-file`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: filePath }),
  });

test("imports an audio file from disk for a missing track and keeps the original", async () => {
  const source = path.join(externalRoot, "Link Artist", "Song Two.flac");
  await fs.mkdir(path.dirname(source), { recursive: true });
  await writeFlacFixture(source, { title: "Something Else", artist: "Someone" }, { seconds: 2 });
  await fs.writeFile(path.join(path.dirname(source), "cover.jpg"), "front");
  await fs.writeFile(path.join(path.dirname(source), "back.png"), "back");
  await fs.writeFile(path.join(path.dirname(source), "notes.txt"), "not art");
  const jobId = addFailedJob("Song Two");

  const response = await importFile(jobId, source);
  assert.equal(response.status, 200, await response.text());

  const job = downloadTracker.getJob(jobId);
  assert.equal(job?.status, "done");
  assert.ok(job?.finalPath && job.finalPath !== source, job?.finalPath ?? "no path");
  assert.ok(job.finalPath.startsWith(managedRoot), job.finalPath);
  assert.equal(path.extname(job.finalPath), ".flac");
  await fs.access(job.finalPath);
  await fs.access(source);
  const libraryFolder = path.dirname(job.finalPath);
  assert.equal(await fs.readFile(path.join(libraryFolder, "cover.jpg"), "utf8"), "front");
  assert.equal(await fs.readFile(path.join(libraryFolder, "back.png"), "utf8"), "back");
  await fs.access(path.join(libraryFolder, "notes.txt")).then(
    () => assert.fail("notes.txt was copied"),
    () => {},
  );
  await fs.access(path.join(path.dirname(source), "cover.jpg"));
  const { parseFile } = await import("music-metadata");
  const tags = (await parseFile(job.finalPath)).common;
  assert.equal(tags.title, "Song Two");
  assert.equal(tags.artist, "Link Artist");
});

test("imports a file for a cancelled track", async () => {
  const source = path.join(externalRoot, "Cancelled.flac");
  await fs.mkdir(externalRoot, { recursive: true });
  await writeFlacFixture(source, {}, { seconds: 2 });
  const jobId = downloadTracker.addJob(
    { artistName: "Link Artist", trackName: "Cancelled", managedBy: "aurral" },
    "library",
  );
  assert.ok(jobId != null);
  downloadTracker.setCancelled(jobId);
  const { cancelDownloadJob } =
    await import("../../backend/services/downloadJobs/downloadCancellation.ts");
  cancelDownloadJob(jobId);

  const response = await importFile(jobId, source);
  assert.equal(response.status, 200, await response.text());
  assert.equal(downloadTracker.getJob(jobId)?.status, "done");
});

test("refuses paths that are not audio files Aurral can import", async () => {
  await fs.mkdir(externalRoot, { recursive: true });
  const jobId = addFailedJob("Refused");
  const text = path.join(externalRoot, "notes.txt");
  await fs.writeFile(text, "not audio");
  const fake = path.join(externalRoot, "fake.flac");
  await fs.writeFile(fake, "not audio either");
  const inLibrary = await addLibraryFile("Link Artist", "Album", "Refused");

  assert.equal((await importFile(jobId, "relative/song.flac")).status, 400);
  assert.equal((await importFile(jobId, path.join(externalRoot, "missing.flac"))).status, 404);
  assert.equal((await importFile(jobId, text)).status, 400);
  assert.equal((await importFile(jobId, fake)).status, 409);
  assert.equal((await importFile(jobId, inLibrary)).status, 409);
  assert.equal(downloadTracker.getJob(jobId)?.status, "failed");
});

test("lists folders and audio files under the browse roots", async () => {
  const folder = path.join(externalRoot, "Browse");
  await fs.mkdir(path.join(folder, "Disc 1"), { recursive: true });
  await fs.writeFile(path.join(folder, "02 Track.flac"), "x");
  await fs.writeFile(path.join(folder, "10 Track.mp3"), "x");
  await fs.writeFile(path.join(folder, "cover.jpg"), "x");
  const previousRoots = process.env.FILE_BROWSE_ROOTS;
  process.env.FILE_BROWSE_ROOTS = externalRoot;
  try {
    const jobId = addFailedJob("Browse");
    const response = await fetch(
      `${baseUrl}/api/playlists/jobs/${jobId}/disk-files?path=${encodeURIComponent(folder)}`,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { entries: { name: string; kind: string }[] };
    assert.deepEqual(
      body.entries.map((entry) => [entry.kind, entry.name]),
      [
        ["folder", "Disc 1"],
        ["file", "02 Track.flac"],
        ["file", "10 Track.mp3"],
      ],
    );
  } finally {
    if (previousRoots === undefined) delete process.env.FILE_BROWSE_ROOTS;
    else process.env.FILE_BROWSE_ROOTS = previousRoots;
  }
});

test("keeps album art already in the Library folder and skips crowded folders", async () => {
  const { copyAlbumImages } = await import("../../backend/services/downloadJobs/importDiskFile.ts");
  const source = path.join(externalRoot, "Art Source");
  const target = path.join(managedRoot, "Art Target");
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(source, "cover.jpg"), "new");
  await fs.writeFile(path.join(target, "cover.jpg"), "existing");
  assert.deepEqual(await copyAlbumImages(source, target), []);
  assert.equal(await fs.readFile(path.join(target, "cover.jpg"), "utf8"), "existing");

  const crowded = path.join(externalRoot, "Crowded");
  await fs.mkdir(crowded, { recursive: true });
  for (let index = 0; index < 11; index += 1) {
    await fs.writeFile(path.join(crowded, `image-${index}.jpg`), "x");
  }
  assert.deepEqual(await copyAlbumImages(crowded, target), []);
});

test("a playlist track linked to a Library file gets that album's cover", async () => {
  const { flowPlaylistConfig } =
    await import("../../backend/services/playlists/flowPlaylistConfig.ts");
  await addLibraryFile("Link Artist", "Cover Album", "Covered Song");
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: `Covers ${Date.now()}`,
    tracks: [
      { artistName: "Link Artist", trackName: "Covered Song" },
      { artistName: "Link Artist", trackName: "Still Missing" },
    ],
  });
  const [coveredJob, missingJob] = playlist.tracks.map((track) => {
    const jobId = downloadTracker.addJob({ ...track, managedBy: "aurral" }, playlist.id);
    assert.ok(jobId != null);
    downloadTracker.setFailed(jobId, "No matching source result");
    return jobId;
  });
  const [file] = await searchFiles(coveredJob, "covered song");
  assert.equal((await linkFile(coveredJob, file.fileId)).status, 200);
  const albumId = (
    db.prepare("SELECT id FROM library_albums WHERE title = ?").get("Cover Album") as {
      id: number;
    }
  ).id;

  const response = await fetch(`${baseUrl}/api/playlists/jobs/${playlist.id}`);
  assert.equal(response.status, 200);
  const jobs = (await response.json()) as { id: string; libraryCoverUrl: string | null }[];
  assert.match(
    String(jobs.find((job) => job.id === coveredJob)?.libraryCoverUrl),
    new RegExp(`^/api/library/albums/${albumId}/cover`),
  );
  assert.equal(jobs.find((job) => job.id === missingJob)?.libraryCoverUrl, null);
});
