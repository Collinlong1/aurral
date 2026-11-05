// Which artist name a track shows across Aurral: its file's ARTIST tag as written (the
// default, as Navidrome and Aurral's Subsonic API do) or Aurral's own artist name. Links,
// artist pages, play history, and lookups keep Aurral's name; only the label changes.

export type TrackArtistSource = "tags" | "library";

let source: TrackArtistSource = "tags";

export const setTrackArtistSource = (value: unknown) => {
  source = value === "library" ? "library" : "tags";
};

type TaggedFile =
  | {
      available?: boolean | null;
      albumId?: string | number | null;
      artistTags?: { artist?: string | null } | null;
    }
  | null
  | undefined;

// The ARTIST tag of the track's playable file, preferring the file on `albumId`.
export function fileTagArtist(
  files: readonly TaggedFile[] | null | undefined,
  albumId: string | number | null = null,
) {
  const tagged = (files || []).filter(
    (file) => file?.available !== false && String(file?.artistTags?.artist || "").trim(),
  );
  const file =
    (albumId != null && tagged.find((entry) => String(entry?.albumId) === String(albumId))) ||
    tagged[0];
  return file?.artistTags?.artist?.trim() || null;
}

export const trackArtistLabel = (
  name: string | null | undefined,
  tagArtist: string | null | undefined,
) => (source === "tags" && String(tagArtist || "").trim() ? String(tagArtist).trim() : name || "");
