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

const [
  state,
  { db },
  titles,
  { scanMusicRoots },
  { getMetadataBaseUrl },
  { setMetadataProviderCooldown },
] = await setupIsolatedBackend(
  "box-set-titles",
  () => import("../../backend/config/db-sqlite.ts"),
  () => import("../../backend/services/libraryAlbumTitles.ts"),
  () => import("../../backend/services/libraryFileScanner.ts"),
  () => import("../../backend/services/providers/brainzmashProvider.ts"),
  () => import("../../backend/services/metadataProviderBudget.ts"),
);
// Unit tests are offline: the metadata provider refuses lookups up front.
setMetadataProviderCooldown(getMetadataBaseUrl(), 403, Number.MAX_SAFE_INTEGER);

const RELEASE_GROUP = "11111111-2222-4333-8444-555555555555";
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

type Disc = { folder: string; album: string };

const DECCA: Disc[] = [
  {
    folder: "Compilations/Decca Sound_ The Analogue Years/CD01",
    album: "Rachmaninov: Piano Concerto No. 2",
  },
  { folder: "Compilations/Decca Sound_ The Analogue Years/CD02", album: "Holst: The Planets" },
  { folder: "Compilations/Decca Sound_ The Analogue Years/CD03", album: "Rimsky-Korsakov: Antar" },
];

async function writeDiscs(discs: Disc[], albumArtist = "Various Artists") {
  for (const [index, disc] of discs.entries()) {
    await writeFlacFixture(path.join(root, disc.folder, "01 - Track.flac"), {
      album: disc.album,
      album_artist: albumArtist,
      artist: albumArtist,
      title: `Track on disc ${index + 1}`,
      track: 1,
      disc: index + 1,
      MUSICBRAINZ_RELEASEGROUPID: RELEASE_GROUP,
    });
  }
}

const scan = () => scanMusicRoots({ rootPaths: [root], source: "readonly", syncSearch: false });

const boxSetAlbum = () => {
  const rows = db
    .prepare<[string], { id: number; title: string; metadata_json: string | null }>(
      "SELECT id, title, metadata_json FROM library_albums WHERE release_group_mbid = ?",
    )
    .all(RELEASE_GROUP);
  assert.equal(rows.length, 1, "one album per release group");
  return { ...rows[0], metadata: JSON.parse(rows[0].metadata_json || "{}") || {} };
};

const notFound = async () => {
  throw Object.assign(new Error("not found"), { response: { status: 404 } });
};

test("a scan flags a release-group album whose discs carry different titles", async () => {
  await writeDiscs(DECCA);
  await scan();
  assert.equal(boxSetAlbum().metadata.mixedTitles, true);
});

test("a box set is named after its release group, and keeps that name on later scans", async () => {
  await writeDiscs(DECCA);
  await scan();
  const renamed = await titles.nameMixedTitleAlbums(async (mbid) => {
    assert.equal(mbid, RELEASE_GROUP);
    return { title: "The Decca Sound: The Analogue Years" };
  });
  assert.equal(renamed, 1);
  assert.equal(boxSetAlbum().title, "The Decca Sound: The Analogue Years");

  // A disc retagged later is read again, and the album keeps its name.
  await writeFlacFixture(path.join(root, DECCA[1].folder, "01 - Track.flac"), {
    album: "Holst: The Planets (Remastered)",
    album_artist: "Various Artists",
    artist: "Various Artists",
    title: "Track on disc 2",
    track: 1,
    disc: 2,
    MUSICBRAINZ_RELEASEGROUPID: RELEASE_GROUP,
  });
  await scan();
  assert.equal(boxSetAlbum().title, "The Decca Sound: The Analogue Years");
});

test("a box set MusicBrainz does not have takes its folder's name", async () => {
  await writeDiscs(DECCA);
  await scan();
  await titles.nameMixedTitleAlbums(notFound);
  assert.equal(boxSetAlbum().title, "Decca Sound: The Analogue Years");
});

test("an artist folder is not used as a box set name", async () => {
  const artist = "Franz Liszt; Leslie Howard";
  await writeDiscs(
    [
      { folder: `${artist}/Vol 1`, album: "Waltzes" },
      { folder: `${artist}/Vol 2`, album: "Music for Piano and Orchestra, bonus disk" },
    ],
    artist,
  );
  await scan();
  const before = boxSetAlbum().title;
  await titles.nameMixedTitleAlbums(notFound);
  assert.equal(boxSetAlbum().title, before);
});

test("an album retagged with one new title takes it, as before", async () => {
  await writeDiscs([
    { folder: "Album/CD1", album: "Old Name" },
    { folder: "Album/CD2", album: "Old Name" },
  ]);
  await scan();
  await writeDiscs([
    { folder: "Album/CD1", album: "New Name" },
    { folder: "Album/CD2", album: "New Name" },
  ]);
  await scan();
  const album = boxSetAlbum();
  assert.equal(album.title, "New Name");
  assert.equal(album.metadata.mixedTitles, undefined);
});

test("albums merged before this change are found by reading their files once", async () => {
  await writeDiscs(DECCA);
  await scan();
  // As stored before: the last disc's title, with nothing flagged.
  db.prepare("UPDATE library_albums SET title = ?, metadata_json = NULL").run(
    "Rimsky-Korsakov: Antar",
  );
  assert.equal(await titles.findMixedTitleAlbums(), 1);
  assert.equal(boxSetAlbum().metadata.mixedTitles, true);
});

test("a regular album spread over folders is checked once and left alone", async () => {
  await writeDiscs([
    { folder: "Album/CD1", album: "Same Album" },
    { folder: "Album/CD2", album: "Same Album" },
  ]);
  await scan();
  assert.equal(await titles.findMixedTitleAlbums(), 0);
  const album = boxSetAlbum();
  assert.equal(album.metadata.titlesChecked, true);
  assert.equal(album.title, "Same Album");
});

test("while the metadata provider is unreachable, a box set takes its folder's name", async () => {
  await writeDiscs(DECCA);
  await scan();
  await titles.nameMixedTitleAlbums(async () => {
    throw new Error("fetch failed");
  });
  assert.equal(boxSetAlbum().title, "Decca Sound: The Analogue Years");
});
