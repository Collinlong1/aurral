import * as v from "valibot";
import type { IAudioMetadata, ICommonTagsResult } from "music-metadata";

// The artist credits exactly as a file's tags spell them, kept for clients that show
// tag credits (Subsonic) instead of Aurral's artist entities.
export const artistTagsSchema = v.object({
  artist: v.optional(v.string()),
  artists: v.optional(v.array(v.string())),
  albumArtist: v.optional(v.string()),
  albumArtists: v.optional(v.array(v.string())),
});

export type ArtistTags = v.InferOutput<typeof artistTagsSchema>;

// What Navidrome puts between several values of one artist tag.
export const ARTIST_TAG_JOINER = " • ";

type NativeTags = IAudioMetadata["native"];
type TagMetadata = { common?: Partial<ICommonTagsResult>; native?: NativeTags };

// Native frame ids per field, compared without case. A field reads only from the
// format's own frames, so a stray ID3v1 tag never wins over Vorbis comments.
const NATIVE_IDS = {
  artist: ["artist", "tpe1", "tp1", "©art", "author"],
  artists: ["artists", "txxx:artists", "----:com.apple.itunes:artists", "wm/artists"],
  albumArtist: [
    "albumartist",
    "album artist",
    "album_artist",
    "tpe2",
    "tp2",
    "aart",
    "wm/albumartist",
  ],
  albumArtists: [
    "albumartists",
    "album_artists",
    "txxx:albumartists",
    "txxx:album_artists",
    "----:com.apple.itunes:albumartists",
    "wm/albumartists",
  ],
} as const;

const TAG_TYPE_ORDER = ["vorbis", "ID3v2.4", "ID3v2.3", "ID3v2.2", "iTunes", "APEv2", "asf"];
// ID3v2.3 and earlier have no multi-value separator, so music-metadata splits these frames
// on "/". Joining the parts with "/" again gives back what the file holds ("AC/DC").
const SLASH_SPLIT_TYPES = new Set(["ID3v2.3", "ID3v2.2"]);

// Each distinct non-empty text value, in order.
const textValues = (values: unknown[]) => [
  ...new Set(
    values.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean),
  ),
];

function nativeValues(tags: NativeTags[string], ids: readonly string[]) {
  return textValues(
    tags.filter((tag) => ids.includes(String(tag.id).toLowerCase())).map((tag) => tag.value),
  );
}

function fieldPair(
  type: string,
  tags: NativeTags[string],
  singleIds: readonly string[],
  pluralIds: readonly string[],
) {
  const single = nativeValues(tags, singleIds);
  const plural = nativeValues(tags, pluralIds);
  const slashSplit = SLASH_SPLIT_TYPES.has(type);
  const display = single.length
    ? single.join(slashSplit ? "/" : ARTIST_TAG_JOINER)
    : plural.join(ARTIST_TAG_JOINER);
  // Several values of the single tag are a list of artists, the way Navidrome reads them,
  // unless they only exist because an ID3v2.3 frame was split on "/".
  const list = plural.length ? plural : single.length > 1 && !slashSplit ? single : [];
  return { display, list };
}

function fromNative(native: NativeTags | undefined) {
  if (!native) return null;
  const types = Object.keys(native).sort(
    (left, right) =>
      (TAG_TYPE_ORDER.indexOf(left) + 1 || 99) - (TAG_TYPE_ORDER.indexOf(right) + 1 || 99),
  );
  for (const type of types) {
    if (type === "ID3v1") continue;
    const tags = native[type] || [];
    const artist = fieldPair(type, tags, NATIVE_IDS.artist, NATIVE_IDS.artists);
    const albumArtist = fieldPair(type, tags, NATIVE_IDS.albumArtist, NATIVE_IDS.albumArtists);
    if (artist.display || albumArtist.display) return { artist, albumArtist };
  }
  return null;
}

// Reads a file's artist credits verbatim. Values are never split, so a credit such as
// "Composer — Performer — Ensemble — Conductor" stays one string.
export function readArtistTags(metadata: TagMetadata | null | undefined): ArtistTags {
  const native = fromNative(metadata?.native);
  const common = metadata?.common || {};
  const commonText = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const artist = native?.artist.display || commonText(common.artist);
  const albumArtist = native?.albumArtist.display || commonText(common.albumartist);
  const artists = native ? native.artist.list : [];
  const albumArtists = native ? native.albumArtist.list : [];
  // Only the credits the file has.
  const tags = { artist, artists, albumArtist, albumArtists };
  return Object.fromEntries(
    Object.entries(tags).filter(([, value]) => value.length > 0),
  ) as ArtistTags;
}
