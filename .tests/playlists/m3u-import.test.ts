import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, test } from "vite-plus/test";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [state, { db }, { dbOps }, m3u, { downloadTracker }] = await setupIsolatedBackend(
  "m3u-import",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/db/helpers/index.ts"),
  () => import("../../backend/services/importLists/m3uImport.ts"),
  () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
);

let root = "";
let library = "";
let playlists = "";

const write = (file: string, content = "not really audio") => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};

beforeEach(() => {
  resetDatabase(db);
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aurral-m3u-")));
  library = path.join(root, "library");
  playlists = path.join(root, "playlists");
  fs.mkdirSync(library);
  fs.mkdirSync(playlists);
  dbOps.updateSettings({ ...dbOps.getSettings(), downloadFolderPath: library });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

afterAll(async () => {
  await cleanupIsolatedState(state);
});

test("parseM3u reads relative, absolute and file:// entries with EXTINF details", () => {
  const parsed = m3u.parseM3u(
    [
      "﻿#EXTM3U",
      "#PLAYLIST:Road Trip",
      "#EXTINF:215,Bilmuri - Party In The U.S.A.",
      "Bilmuri/Bilmuri - Muri and Friends/01 - Bilmuri - Party In The U.S.A.mp3",
      "/music/BVG/03 - Dreams.mp3",
      "file:///music/Song%20One.flac",
      "https://example.com/stream.mp3",
      "",
    ].join("\r\n"),
    "/data/playlists/Chill/playlist.m3u8",
  );
  assert.equal(parsed.name, "Road Trip");
  assert.deepEqual(parsed.entries, [
    {
      path: "/data/playlists/Chill/Bilmuri/Bilmuri - Muri and Friends/01 - Bilmuri - Party In The U.S.A.mp3",
      artist: "Bilmuri",
      title: "Party In The U.S.A.",
      durationMs: 215000,
    },
    { path: "/music/BVG/03 - Dreams.mp3", artist: null, title: null, durationMs: null },
    { path: "/music/Song One.flac", artist: null, title: null, durationMs: null },
  ]);
});

test("a playlist.m3u8 takes its folder's name", () => {
  assert.equal(m3u.playlistNameFor("/p/Chill/playlist.m3u8", null), "Chill");
  assert.equal(m3u.playlistNameFor("/p/Workout.m3u", null), "Workout");
  assert.equal(m3u.playlistNameFor("/p/Chill/playlist.m3u8", "Named"), "Named");
});

test("untagged files take artist, title, album and number from their path", async () => {
  const file = write(
    path.join(playlists, "Chill/BVG/BVG - Floating Dreams/03 - BVG - Dreams Can Come True.mp3"),
  );
  const info = await m3u.readTrackInfo(file);
  assert.equal(info?.artistName, "BVG");
  assert.equal(info?.trackName, "Dreams Can Come True");
  assert.equal(info?.albumName, "Floating Dreams");
  assert.equal(info?.trackNumber, 3);
});

test("scanning finds playlists and counts their files, skipping the Library folder", async () => {
  const chill = path.join(playlists, "collin/Chill");
  write(path.join(chill, "BVG/BVG - Floating Dreams/03 - BVG - Dreams Can Come True.mp3"));
  write(
    path.join(chill, "playlist.m3u8"),
    "BVG/BVG - Floating Dreams/03 - BVG - Dreams Can Come True.mp3\nmissing/gone.mp3\n",
  );
  write(path.join(library, "aurral-weekly-flow/_playlists/Exported.m3u"), "x.mp3\n");

  const result = await m3u.scanM3uFolder(playlists);
  assert.deepEqual(
    result.playlists.map(({ name, trackCount, filesFound, alreadyImported }) => ({
      name,
      trackCount,
      filesFound,
      alreadyImported,
    })),
    [{ name: "Chill", trackCount: 2, filesFound: 1, alreadyImported: false }],
  );

  const fromRoot = await m3u.scanM3uFolder(root);
  assert.deepEqual(
    fromRoot.playlists.map((entry) => entry.name),
    ["Chill"],
  );
  await assert.rejects(m3u.scanM3uFolder("relative/path"), m3u.M3uImportError);
});

test("files in the Library folder are pinned to that exact file", async () => {
  const track = write(
    path.join(library, "BVG/Floating Dreams/03 - BVG - Dreams Can Come True.mp3"),
  );
  const list = write(path.join(playlists, "Chill.m3u"), `${track}\n`);

  const { tracks, stats } = await m3u.buildM3uTracks(list);
  assert.deepEqual(stats, { pinned: 1, byName: 0, skipped: 0, total: 1 });
  const job = downloadTracker.getJob(tracks[0]!.canonicalJobId!);
  assert.equal(job?.status, "done");
  assert.equal(job?.finalPath, track);
  assert.equal(tracks[0]!.trackName, "Dreams Can Come True");
});

test("files copied by an ingest are pinned to their Library copy", async () => {
  const source = write(
    path.join(playlists, "Chill/BVG/BVG - Floating Dreams/03 - BVG - Dreams.mp3"),
  );
  const target = write(path.join(library, "BVG/Floating Dreams/03 - Dreams.mp3"));
  const list = write(
    path.join(playlists, "Chill/playlist.m3u8"),
    "BVG/BVG - Floating Dreams/03 - BVG - Dreams.mp3\n",
  );
  const now = Date.now();
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO library_file_operations (kind, status, options_json, summary_json, created_at, updated_at) VALUES ('ingest', 'complete', '{}', '{}', ?, ?)",
    )
    .run(now, now);
  db.prepare(
    "INSERT INTO library_file_operation_items (operation_id, position, source_path, target_path, status, details_json, updated_at) VALUES (?, 0, ?, ?, 'done', '{}', ?)",
  ).run(lastInsertRowid, source, target, now);

  const { tracks, stats } = await m3u.buildM3uTracks(list);
  assert.equal(stats.pinned, 1);
  assert.equal(downloadTracker.getJob(tracks[0]!.canonicalJobId!)?.finalPath, target);
});

test("tracks outside the Library are left out unless downloads are allowed", async () => {
  write(path.join(playlists, "Chill/BVG/BVG - Floating Dreams/03 - BVG - Dreams.mp3"));
  const list = write(
    path.join(playlists, "Chill/playlist.m3u8"),
    "#EXTINF:200,Ghost Artist - Gone Song\nnowhere/gone.mp3\nBVG/BVG - Floating Dreams/03 - BVG - Dreams.mp3\n",
  );

  const skipped = await m3u.buildM3uTracks(list);
  assert.deepEqual(skipped.stats, { pinned: 0, byName: 0, skipped: 2, total: 2 });

  const allowed = await m3u.buildM3uTracks(list, { downloadMissing: true });
  assert.deepEqual(allowed.stats, { pinned: 0, byName: 2, skipped: 0, total: 2 });
  assert.deepEqual(
    allowed.tracks.map((track) => [track.artistName, track.trackName, track.canonicalJobId]),
    [
      ["Ghost Artist", "Gone Song", undefined],
      ["BVG", "Dreams", undefined],
    ],
  );
});

test("pending imports wait for their ingest to finish", async () => {
  const list = write(path.join(playlists, "Empty/playlist.m3u8"), "nowhere/gone.mp3\n");
  const now = Date.now();
  const { lastInsertRowid } = db
    .prepare(
      "INSERT INTO library_file_operations (kind, status, options_json, summary_json, created_at, updated_at) VALUES ('ingest', 'running', '{}', '{}', ?, ?)",
    )
    .run(now, now);
  const operationId = Number(lastInsertRowid);
  dbOps.setJSONSetting("m3uImport:pending", [
    { m3uPath: list, ownerUserId: 1, downloadMissing: false, ingestOperationIds: [operationId] },
  ]);

  assert.deepEqual(await m3u.completePendingM3uImports(), []);
  db.prepare("UPDATE library_file_operations SET status = 'complete' WHERE id = ?").run(
    operationId,
  );
  const results = await m3u.completePendingM3uImports();
  assert.equal(results.length, 1);
  assert.equal(results[0]!.skipped, "no tracks found");
  assert.deepEqual(await m3u.completePendingM3uImports(), []);
});
