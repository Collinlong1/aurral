import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { test, afterAll } from "vite-plus/test";
import { setupIsolatedBackend, cleanupIsolatedState } from "../helpers/backendTestHarness.ts";

const [state, { db }, store, { downloadTracker }, { flowPlaylistConfig }, service] =
  await setupIsolatedBackend(
    "playlist-rescan-timestamp",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/services/libraryMediaStore.ts"),
    () => import("../../backend/services/downloadJobs/downloadTracker.ts"),
    () => import("../../backend/services/playlists/flowPlaylistConfig.ts"),
    () => import("../../backend/services/subsonicLibraryService.ts"),
  );
afterAll(() => cleanupIsolatedState(state));

test("file metadata changes invalidate list and detail timestamps without unrelated invalidations", async () => {
  const artist = store.upsertLibraryArtist({ identityKey: "artist:rescan", name: "Rescan Artist" });
  const album = store.upsertLibraryAlbum({
    identityKey: "album:rescan",
    artistId: artist.id,
    title: "Rescan Album",
  });
  const track = store.upsertLibraryTrack({
    identityKey: "track:rescan",
    title: "Rescan Song",
    artistName: "Rescan Artist",
  });
  store.linkLibraryAlbumTrack({ albumId: album.id, trackId: track.id, trackNumber: 1 });
  const filePath = path.join(state.baseDir, "rescan.flac");
  await fs.writeFile(filePath, "fixture");
  store.upsertLibraryMediaFile({
    trackId: track.id,
    albumId: album.id,
    source: "aurral",
    path: filePath,
  });
  const jobId = downloadTracker.addJob(
    { artistName: "Rescan Artist", trackName: "Rescan Song", albumName: "Rescan Album" },
    "library",
  );
  assert.ok(jobId);
  downloadTracker.setDone(jobId, filePath, "Rescan Album");
  const playlist = flowPlaylistConfig.createStaticPlaylist({
    name: "Rescan playlist",
    ownerUserId: 1,
    tracks: [{ artistName: "Rescan Artist", trackName: "Rescan Song", canonicalJobId: jobId }],
  });
  const user = { id: 1, username: "admin", role: "admin", permissions: {} };
  const entry = () => service.getSubsonicPlaylists(user).find((row) => row.name === playlist.name)!;
  const original = entry();
  assert.ok(original);
  assert.equal(entry().changed, original.changed);
  const updatedAt = Date.now() + 60000;
  db.prepare("UPDATE library_media_files SET updated_at = ? WHERE path = ?").run(
    updatedAt,
    filePath,
  );
  const changed = entry();
  assert.equal(changed.changed, new Date(updatedAt).toISOString());
  assert.equal(service.getSubsonicPlaylist(changed.id, user)?.changed, changed.changed);
  assert.notEqual(changed.changed, original.changed);
  const unrelated = path.join(state.baseDir, "unrelated.flac");
  store.upsertLibraryMediaFile({
    trackId: track.id,
    albumId: album.id,
    source: "aurral",
    path: unrelated,
  });
  db.prepare("UPDATE library_media_files SET updated_at = ? WHERE path = ?").run(
    updatedAt + 60000,
    unrelated,
  );
  assert.equal(entry().changed, changed.changed);
});
