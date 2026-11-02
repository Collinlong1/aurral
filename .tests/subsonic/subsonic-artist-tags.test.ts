import assert from "node:assert/strict";
import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseFile } from "music-metadata";
import { afterAll, beforeAll, test } from "vite-plus/test";

import {
  cleanupIsolatedState,
  resetDatabase,
  setupIsolatedBackend,
} from "../helpers/backendTestHarness.ts";

const [isolatedState, { db }, { dbOps }, subsonic, { scanMusicRoot }, { readArtistTags }, tags] =
  await setupIsolatedBackend(
    "subsonic-artist-tags",
    () => import("../../backend/config/db-sqlite.ts"),
    () => import("../../backend/db/helpers/index.ts"),
    () => import("../../backend/services/subsonicLibraryService.ts"),
    () => import("../../backend/services/libraryFileScanner.ts"),
    () => import("../../backend/services/artistTags.ts"),
    () => import("../../backend/services/audioTags.ts"),
  );

const { getAlbum, getAlbumList, getArtist, getSong, getRandomSongs } = subsonic;

const FIXTURES = path.join(import.meta.dirname, "../fixtures/artist-tags/library");
const CLASSICAL = "Gustav Mahler — Jessye Norman — London Symphony Orchestra — Colin Davis";
const CLASSICAL_ARTISTS = [
  "Gustav Mahler",
  "Jessye Norman",
  "London Symphony Orchestra",
  "Colin Davis",
];
const GOULD = "Johann Sebastian Bach — Glenn Gould";

// What Navidrome 0.58 serves for these files (displayArtist, artists[], displayAlbumArtist,
// albumArtists[]), except "Nameless": it has no ARTIST tag, so Aurral falls back to the
// library artist where Navidrome shows "[Unknown Artist]".
const SONGS: Record<string, [string, string[], string, string[]]> = {
  "Das himmlische Leben": [CLASSICAL, CLASSICAL_ARTISTS, CLASSICAL, CLASSICAL_ARTISTS],
  Thunder: ["AC/DC", ["AC/DC"], GOULD, [GOULD]],
  Together: ["Artist A • Artist B", ["Artist A", "Artist B"], "Duo", ["Duo"]],
  Nameless: ["Fallback Band", ["Fallback Band"], "Fallback Band", ["Fallback Band"]],
  Aria: [GOULD, ["Johann Sebastian Bach", "Glenn Gould"], GOULD, [GOULD]],
  Feature: ["Main Artist feat. Guest", ["Main Artist", "Guest"], "Main Artist", ["Main Artist"]],
  "Hit 1": ["Band One", ["Band One"], "Various Artists", ["Various Artists"]],
  "Hit 2": ["Band Two", ["Band Two"], "Various Artists", ["Various Artists"]],
};
const ALBUMS: Record<string, [string, string[]]> = {
  "Symphony No. 4": [CLASSICAL, CLASSICAL_ARTISTS],
  "Bach Covers": [GOULD, [GOULD]],
  "Split Single": ["Duo", ["Duo"]],
  Untagged: ["Fallback Band", ["Fallback Band"]],
  "Goldberg Variations": [GOULD, [GOULD]],
  "Guest Spots": ["Main Artist", ["Main Artist"]],
  Hits: ["Various Artists", ["Various Artists"]],
};

let root = "";

const setArtistSource = (artistSource: "tags" | "library") =>
  dbOps.updateSettings({ subsonic: { favoriteAutoKeep: true, artistSource } });

const albums = () =>
  getAlbumList({ type: "alphabeticalByName", size: "50" }).map((album) => getAlbum(album.id)!);
const songs = () => albums().flatMap((album) => album.song);
const songNamed = (title: string) => songs().find((song) => song.title === title)!;
const names = (artists: { name: string }[]) => artists.map((artist) => artist.name);

beforeAll(async () => {
  resetDatabase(db);
  root = await mkdtemp(path.join(tmpdir(), "aurral-artist-tags-"));
  await cp(FIXTURES, root, { recursive: true });
  await scanMusicRoot({ rootPath: root, source: "aurral" });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await cleanupIsolatedState(isolatedState);
});

test("artist tags are read verbatim from FLAC, ID3v2.3, ID3v2.4 and M4A files", async () => {
  const read = async (relative: string) =>
    readArtistTags(await parseFile(path.join(FIXTURES, relative), { skipCovers: true }));
  assert.deepEqual(await read("Gustav Mahler/Symphony No. 4/01 Das himmlische Leben.flac"), {
    artist: CLASSICAL,
    artists: CLASSICAL_ARTISTS,
    albumArtist: CLASSICAL,
    albumArtists: CLASSICAL_ARTISTS,
  });
  // music-metadata splits ID3v2.3 frames on "/", which would turn this into "AC".
  assert.deepEqual(await read("AC-DC/Bach Covers/01 Thunder.mp3"), {
    artist: "AC/DC",
    albumArtist: GOULD,
  });
  assert.deepEqual(await read("Main Artist/Guest Spots/01 Feature.mp3"), {
    artist: "Main Artist feat. Guest",
    artists: ["Main Artist", "Guest"],
    albumArtist: "Main Artist",
  });
  assert.deepEqual(await read("Johann Sebastian Bach/Goldberg Variations/01 Aria.m4a"), {
    artist: GOULD,
    artists: ["Johann Sebastian Bach", "Glenn Gould"],
    albumArtist: GOULD,
  });
  assert.deepEqual(await read("Duo/Split Single/01 Together.flac"), {
    artist: "Artist A • Artist B",
    artists: ["Artist A", "Artist B"],
    albumArtist: "Duo",
  });
  assert.deepEqual(await read("Fallback Band/Untagged/01 Nameless.flac"), {
    albumArtist: "Fallback Band",
  });
  // A reader that only fills common tags, such as a download's own metadata, still counts.
  assert.deepEqual(readArtistTags({ common: { artist: "Solo", albumartist: "Owner" } }), {
    artist: "Solo",
    albumArtist: "Owner",
  });
});

test("Subsonic songs and albums show the file's artist tags", () => {
  setArtistSource("tags");
  const served = songs();
  assert.equal(served.length, Object.keys(SONGS).length);
  for (const song of served) {
    const [artist, artists, albumArtist, albumArtists] = SONGS[song.title];
    assert.equal(song.artist, artist, song.title);
    assert.equal(song.displayArtist, artist, song.title);
    assert.deepEqual(names(song.artists), artists, song.title);
    assert.equal(song.displayAlbumArtist, albumArtist, song.title);
    assert.deepEqual(names(song.albumArtists), albumArtists, song.title);
  }
  for (const album of albums()) {
    const [artist, artists] = ALBUMS[album.name];
    assert.equal(album.artist, artist, album.name);
    assert.equal(album.displayArtist, artist, album.name);
    assert.deepEqual(names(album.artists), artists, album.name);
  }
  const random = getRandomSongs({ size: "50" });
  assert.equal(random.find((song) => song.title === "Aria")?.artist, GOULD);
  assert.equal(getSong(songNamed("Thunder").id)?.artist, "AC/DC");
});

test("every artist ID served with tag names opens a library artist", () => {
  setArtistSource("tags");
  for (const song of songs()) {
    for (const id of [
      song.artistId,
      ...song.artists.map((artist) => artist.id),
      ...song.albumArtists.map((artist) => artist.id),
    ]) {
      assert.ok(getArtist(id), `${song.title}: ${id}`);
    }
  }
  const hit = songNamed("Hit 1");
  const compilation = getArtist(hit.artistId)!;
  assert.equal(compilation.name, "Various Artists");
  assert.ok(compilation.album.some((album) => album.name === "Hits"));
});

test("the library setting serves Aurral's artist names as before", () => {
  setArtistSource("library");
  try {
    const hit = songNamed("Hit 1");
    assert.equal(hit.artist, "Various Artists");
    assert.equal(hit.displayArtist, undefined);
    assert.deepEqual(names(hit.artists), ["Various Artists"]);
    assert.equal(getAlbum(getAlbumList({ size: "50" })[0].id)?.displayArtist, undefined);
  } finally {
    setArtistSource("tags");
  }
});

test("a rescan fills artist tags for files indexed before they were stored", async () => {
  setArtistSource("tags");
  db.prepare("UPDATE library_media_files SET artist_tags_json = NULL").run();
  assert.equal(songNamed("Hit 1").artist, "Various Artists");

  await scanMusicRoot({ rootPath: root, source: "aurral" });

  assert.equal(songNamed("Hit 1").artist, "Band One");
  assert.equal(songNamed("Das himmlische Leben").artist, CLASSICAL);
  const stored = db
    .prepare<[], { missing: number }>(
      "SELECT COUNT(*) AS missing FROM library_media_files WHERE artist_tags_json IS NULL",
    )
    .get();
  assert.equal(stored?.missing, 0);
});

test("re-tagged files show their new artist after the next scan", async () => {
  setArtistSource("tags");
  const file = path.join(root, "Gustav Mahler/Symphony No. 4/01 Das himmlische Leben.flac");
  const before = await stat(file);
  const retagged =
    "Gustav Mahler — Renée Fleming — Royal Concertgebouw Orchestra — Riccardo Chailly";
  await tags.writeAudioTags(file, { artist: retagged });
  assert.notEqual((await stat(file)).mtimeMs, before.mtimeMs);

  await scanMusicRoot({ rootPath: root, source: "aurral" });

  const song = songNamed("Das himmlische Leben");
  assert.equal(song.artist, retagged);
  assert.deepEqual(names(song.artists), CLASSICAL_ARTISTS);
});
