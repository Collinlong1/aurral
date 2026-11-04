import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { isVisibleLibraryAlbum } from "../../frontend/src/pages/ArtistDetails/utils.ts";

const owned = { sizeOnDisk: 1024, trackFileCount: 10 };
const discographyIds = new Set(["rg-matched"]);

test("an owned album with no match in the artist's discography shows in Your Library", () => {
  const album = { id: 1, mbid: null, foreignAlbumId: null, monitored: false, statistics: owned };
  assert.equal(isVisibleLibraryAlbum(album, { discographyIds }), true);
});

test("an owned album matched to a discography release stays out of Your Library", () => {
  const album = { id: 2, mbid: "rg-matched", monitored: false, statistics: owned };
  assert.equal(isVisibleLibraryAlbum(album, { discographyIds }), false);
});

test("unmatched owned albums wait for the discography to load", () => {
  const album = { id: 3, mbid: null, monitored: false, statistics: owned };
  assert.equal(isVisibleLibraryAlbum(album, { discographyIds: null }), false);
});

test("an unmonitored album with no files stays hidden", () => {
  const album = { id: 4, mbid: null, monitored: false, statistics: { sizeOnDisk: 0 } };
  assert.equal(isVisibleLibraryAlbum(album, { discographyIds }), false);
});

test("monitored albums still show", () => {
  const album = { id: 5, mbid: "rg-matched", monitored: true, statistics: null };
  assert.equal(isVisibleLibraryAlbum(album, { discographyIds }), true);
});
