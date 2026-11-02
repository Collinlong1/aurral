import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, test } from "vite-plus/test";
import { writeFlacFixture } from "../helpers/flacFixture.ts";
import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [state, { db }, store, titles] = await setupIsolatedBackend(
  "box-set-titles",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/libraryMediaStore.ts"),
  () => import("../../backend/services/libraryAlbumTitles.ts"),
);

const RELEASE_GROUP = "11111111-2222-3333-4444-555555555555";
let root = "";

beforeEach(() => {
  resetDatabase(db);
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aurral-box-set-")));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

afterAll(async () => {
  await cleanupIsolatedState(state);
});

const artist = () =>
  store.upsertLibraryArtist({ identityKey: "artist:various", name: "Various Artists" });

// Files one disc each, as a scan stores them: one album per release group.
async function boxSet(discs: { folder: string; album: string }[], albumArtist = "Various Artists") {
  const { id: artistId } = artist()!;
  let album = null;
  for (const [index, disc] of discs.entries()) {
    const filePath = path.join(root, disc.folder, `01 - Track ${index + 1}.flac`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    await writeFlacFixture(filePath, { album: disc.album, title: `Track ${index + 1}` });
    album = store.upsertLibraryAlbum({
      identityKey: `release-group:${RELEASE_GROUP}`,
      releaseGroupMbid: RELEASE_GROUP,
      artistId,
      title: disc.album,
      albumArtist,
    });
    const track = store.upsertLibraryTrack({
      identityKey: `track:${index}`,
      title: `Track ${index + 1}`,
    });
    store.upsertLibraryMediaFile({
      trackId: track!.id,
      albumId: album!.id,
      source: "readonly",
      path: filePath,
      scanId: 1,
    });
  }
  return albumRow(album!.id);
}

const albumRow = (id: number) =>
  db
    .prepare<[number], { id: number; title: string; metadata_json: string | null }>(
      "SELECT id, title, metadata_json FROM library_albums WHERE id = ?",
    )
    .get(id)!;

const DISCS = [
  { folder: "Decca Sound_ The Analogue Years/CD01", album: "Rachmaninov: Piano Concerto No. 2" },
  { folder: "Decca Sound_ The Analogue Years/CD02", album: "Holst: The Planets" },
  { folder: "Decca Sound_ The Analogue Years/CD03", album: "Rimsky-Korsakov: Antar" },
];

test("an album keyed by release group keeps its first title when discs disagree", async () => {
  const album = await boxSet(DISCS);
  const row = albumRow(album.id);
  assert.equal(row.title, "Rachmaninov: Piano Concerto No. 2");
  assert.equal(JSON.parse(row.metadata_json || "{}").mixedTitles, true);
});

test("a box set is named after its release group, and keeps that name on later scans", async () => {
  const album = await boxSet(DISCS);
  const renamed = await titles.nameMixedTitleAlbums(async (mbid) => {
    assert.equal(mbid, RELEASE_GROUP);
    return { title: "The Decca Sound: The Analogue Years" };
  });
  assert.equal(renamed, 1);
  assert.equal(albumRow(album.id).title, "The Decca Sound: The Analogue Years");

  store.upsertLibraryAlbum({
    identityKey: `release-group:${RELEASE_GROUP}`,
    releaseGroupMbid: RELEASE_GROUP,
    artistId: artist()!.id,
    title: "Holst: The Planets",
  });
  assert.equal(albumRow(album.id).title, "The Decca Sound: The Analogue Years");
});

test("a box set MusicBrainz does not have takes its folder's name", async () => {
  const album = await boxSet(DISCS);
  const notFound = Object.assign(new Error("not found"), { response: { status: 404 } });
  await titles.nameMixedTitleAlbums(async () => {
    throw notFound;
  });
  assert.equal(albumRow(album.id).title, "Decca Sound: The Analogue Years");
});

test("an artist folder is not used as a box set name", async () => {
  const album = await boxSet(
    [
      { folder: "Franz Liszt; Leslie Howard/Vol 1", album: "Waltzes" },
      { folder: "Franz Liszt; Leslie Howard/Vol 2", album: "Music for Piano and Orchestra" },
    ],
    "Franz Liszt; Leslie Howard",
  );
  await titles.nameMixedTitleAlbums(async () => null);
  assert.equal(albumRow(album.id).title, "Waltzes");
});

test("albums merged before this change are found by reading their files once", async () => {
  const album = await boxSet(DISCS);
  // As stored before: the last disc's title, with nothing flagged.
  db.prepare("UPDATE library_albums SET title = ?, metadata_json = NULL WHERE id = ?").run(
    "Rimsky-Korsakov: Antar",
    album.id,
  );
  assert.equal(await titles.findMixedTitleAlbums(), 1);
  assert.equal(JSON.parse(albumRow(album.id).metadata_json || "{}").mixedTitles, true);

  // A regular album split over folders with one title is checked once.
  const single = await (async () => {
    db.prepare("DELETE FROM library_albums").run();
    return boxSet([
      { folder: "Album/CD1", album: "Same Album" },
      { folder: "Album/CD2", album: "Same Album" },
    ]);
  })();
  assert.equal(await titles.findMixedTitleAlbums(), 0);
  assert.equal(JSON.parse(albumRow(single.id).metadata_json || "{}").titlesChecked, true);
  assert.equal(albumRow(single.id).title, "Same Album");
});
