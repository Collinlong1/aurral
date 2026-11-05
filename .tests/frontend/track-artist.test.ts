import { test, afterEach } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  fileTagArtist,
  setTrackArtistSource,
  trackArtistLabel,
} from "../../frontend/src/utils/trackArtist.ts";
import {
  normalizePlaylistQueueTrack,
  normalizeQueueTrack,
} from "../../frontend/src/utils/audioQueue.ts";

afterEach(() => setTrackArtistSource("tags"));

test("a track shows its file's ARTIST tag unless tracks show library names", () => {
  setTrackArtistSource("tags");
  assert.equal(
    trackArtistLabel("Main Artist", "Main Artist feat. Guest"),
    "Main Artist feat. Guest",
  );
  assert.equal(trackArtistLabel("AC", " AC/DC "), "AC/DC");
  // No tag: Aurral's name, or nothing.
  assert.equal(trackArtistLabel("Fallback Band", null), "Fallback Band");
  assert.equal(trackArtistLabel("Fallback Band", "  "), "Fallback Band");
  assert.equal(trackArtistLabel(null, undefined), "");

  setTrackArtistSource("library");
  assert.equal(trackArtistLabel("Main Artist", "Main Artist feat. Guest"), "Main Artist");

  // Anything unrecognized falls back to tags, the server's default.
  setTrackArtistSource("something else");
  assert.equal(
    trackArtistLabel("Main Artist", "Main Artist feat. Guest"),
    "Main Artist feat. Guest",
  );
});

test("the tag comes from a playable file, preferring the file on the album shown", () => {
  const files = [
    { available: false, albumId: 1, artistTags: { artist: "Gone" } },
    { available: true, albumId: 2, artistTags: { artist: "Compilation Credit" } },
    { available: true, albumId: 3, artistTags: { artist: "Album Credit" } },
    { available: true, albumId: 4, artistTags: null },
  ];
  assert.equal(fileTagArtist(files, 3), "Album Credit");
  assert.equal(fileTagArtist(files), "Compilation Credit");
  assert.equal(fileTagArtist(files, 1), "Compilation Credit");
  assert.equal(fileTagArtist([{ available: true, artistTags: {} }]), null);
  assert.equal(fileTagArtist(undefined), null);
});

test("queued tracks keep Aurral's artist for history and carry the tag for display", () => {
  const library = normalizeQueueTrack({
    id: 7,
    title: "Feature",
    artist: "Main Artist",
    tagArtist: "Main Artist feat. Guest",
  });
  assert.equal(library.artist, "Main Artist");
  assert.equal(library.tagArtist, "Main Artist feat. Guest");

  const playlist = normalizePlaylistQueueTrack({
    id: "job-1",
    trackName: "Thunder",
    artistName: "AC",
    tagArtist: "AC/DC",
  });
  assert.equal(playlist.artist, "AC");
  assert.equal(playlist.tagArtist, "AC/DC");

  assert.equal(normalizeQueueTrack({ id: 8, title: "Preview", artist: "Someone" }).tagArtist, null);
});
