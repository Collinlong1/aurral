export type SettingValue = string | number | boolean;

export interface Base {
  capabilities?: { adminForms?: 1 };
  userOperations?: { version: 1; url: string; token: string };
  settings: Record<string, SettingValue>;
  libraryFolder: string;
  dataFolder: string;
  api?: { url: string; key: string };
}

// Optional admin-only, host-rendered forms. No browser scripts/assets are accepted.
export type AdminPageValue = string | boolean | string[];
export type AdminPageInput = Base & { user: User; pageId: string } & (
    | { query: { selection: string; q: string; offset: string } }
    | { mutation: { revision: string; command: string; values: Record<string, AdminPageValue> } }
  );
export interface AdminPageField {
  key: string;
  label: string;
  type: "text" | "textarea" | "select" | "checkbox" | "order";
  value: AdminPageValue;
  required?: boolean;
  help?: string;
  options?: { value: string; label: string }[];
}
export interface AdminPageData {
  version: 1;
  title: string;
  description?: string;
  revision: string;
  navigation: { items: { id: string; label: string }[]; total: number; offset: number };
  notes?: string[];
  forms: {
    id: string;
    title: string;
    help?: string;
    command: string;
    arguments: Record<string, AdminPageValue>;
    submitLabel: string;
    fields: AdminPageField[];
  }[];
}
export type AdminPageMutationResult =
  | { ok: true; message: string; selection?: string }
  | { ok: false; status: 400 | 409; message: string };

export interface User {
  id: number;
  username: string;
  role: "admin" | "user";
}

export interface PlaylistTrack {
  path: string;
  title: string;
  artist: string;
  album?: string;
  durationMs?: number;
  mbid?: string;
}

export interface Playlist {
  id: string;
  name: string;
  kind: "playlist" | "flow";
  file: string | null;
  tracks: PlaylistTrack[];
}

export interface LibraryTrack {
  id: number;
  path: string | null;
  title: string;
  artist: string | null;
  album: string | null;
  durationMs: number | null;
  mbid: string | null;
  trackNumber: number | null;
  discNumber: number | null;
}

export interface Album {
  id: number;
  title: string;
  artist: string | null;
  mbid: string | null;
  releaseGroupMbid: string | null;
  year: number | null;
  tracks: LibraryTrack[];
}

export interface Artist {
  id: number;
  name: string;
  mbid: string | null;
  albums: { id: number; title: string; mbid: string | null; year: number | null }[];
}

export type ActionAnswer = { message?: string } | void;

export type PlaylistActionInput = Base & { user: User; playlist: Playlist };
export type AlbumActionInput = Base & { user: User; album: Album };
export type ArtistActionInput = Base & { user: User; artist: Artist };
export type TrackActionInput = Base & { user: User; tracks: LibraryTrack[] };

export interface Events {
  "playlist.changed": { playlist: Playlist & { title: string } };
  "playlist.removed": { playlist: { title: string } };
  "track.played": {
    user: { id: number; username: string | null };
    track: {
      id: string;
      title: string;
      artist: string;
      album: string | null;
      durationMs: number | null;
      artistMbid: string | null;
      albumMbid: string | null;
      trackMbid: string | null;
    };
    playedAt: number;
    source: string;
  };
  "download.finished": {
    track: {
      title: string | null;
      artist: string | null;
      album: string | null;
      mbid: string | null;
      path: string;
    };
    source: string | null;
  };
  notification: {
    kind: "discovery.updated" | "flow.done" | "request.made" | "request.available" | "artist.added";
    title: string;
    message: string;
    [detail: string]: unknown;
  };
}

export type EventInput<Name extends keyof Events> = Base & { event: Name } & Events[Name];

export interface TrackRequest {
  artist: string | null;
  title: string | null;
  album: string | null;
  durationMs: number | null;
  artistMbid: string | null;
  albumMbid: string | null;
  releaseMbid: string | null;
  trackMbid: string | null;
  releaseYear: number | null;
  trackNumber: number | null;
  discNumber: number | null;
}

export interface AlbumRequest {
  artist: string | null;
  title: string | null;
  releaseMbid: string | null;
  releaseGroupMbid: string | null;
  tracks: {
    title: string;
    trackNumber: number;
    discNumber: number;
    durationMs: number | null;
  }[];
}

export interface TrackResult {
  id: string;
  title: string;
  artist: string;
  album?: string | null;
  durationMs?: number | null;
  format?: string | null;
  bitrate?: number | null;
  data?: unknown;
}

export interface AlbumResult {
  id: string;
  title: string;
  artist: string;
  year?: number | null;
  trackCount?: number | null;
  format?: string | null;
  bitrate?: number | null;
  data?: unknown;
}

export type Pending = { pending: string };

export type QualityTier =
  | "flac-hires"
  | "flac-standard"
  | "mp3-320"
  | "m4a-320"
  | "mp3-256"
  | "m4a-256"
  | "mp3-192"
  | "m4a-192"
  | "mp3-128"
  | "m4a-128";

export type Upgrade = { currentTier: QualityTier | null } | null;

export interface DownloadSource {
  acquisitionIdentity?(
    input: Base & { track: TrackRequest },
  ):
    | { blocked: true }
    | { artist: string; aliases: string[]; requiredTerms?: string[] }
    | null
    | Promise<
        { blocked: true } | { artist: string; aliases: string[]; requiredTerms?: string[] } | null
      >;
  search?(
    input: Base & { track: TrackRequest; upgrade: Upgrade },
  ): TrackResult[] | Promise<TrackResult[]>;
  download?(
    input: Base & { result: TrackResult; directory: string },
  ): { path: string } | Pending | Promise<{ path: string } | Pending>;
  searchAlbum?(
    input: Base & { album: AlbumRequest; upgrade: Upgrade },
  ): AlbumResult[] | Promise<AlbumResult[]>;
  downloadAlbum?(
    input: Base & { result: AlbumResult; album: AlbumRequest; directory: string },
  ): Pending | void | Promise<Pending | void>;
  listFiles?(
    input: Base & { id: string },
  ): { path: string; size: number }[] | null | Promise<{ path: string; size: number }[] | null>;
  keepFiles?(input: Base & { id: string; paths: string[] }): unknown;
  status?(
    input: Base & { id: string; directory: string },
  ): { done: boolean; path?: string } | Promise<{ done: boolean; path?: string }>;
  discard?(input: Base & { id: string }): unknown;
}

export interface ImportedPlaylist {
  name: string;
  artworkUrl?: string | null;
  tracks: {
    artist: string;
    title: string;
    album?: string | null;
    durationMs?: number | null;
    mbid?: string | null;
  }[];
}

type Answer<Value> = Value | Promise<Value>;

export type ActionInput =
  | PlaylistActionInput
  | AlbumActionInput
  | ArtistActionInput
  | TrackActionInput;

type ActionHandler = {
  handle(input: ActionInput): Answer<ActionAnswer>;
}["handle"];

export interface AurralPlugin {
  pages?: {
    read(
      input: Base & {
        user: User;
        pageId: string;
        query: { selection: string; q: string; offset: string };
      },
    ): Answer<AdminPageData>;
    mutate(
      input: Base & {
        user: User;
        pageId: string;
        mutation: { revision: string; command: string; values: Record<string, AdminPageValue> };
      },
    ): Answer<AdminPageMutationResult>;
  };
  test?(input: Base): Answer<ActionAnswer>;
  actions?: Record<string, ActionHandler>;
  events?: { [Name in keyof Events]?: (input: EventInput<Name>) => Answer<unknown> };
  downloadSource?: DownloadSource;
  importList?: { fetch(input: Base & { url: string }): Answer<ImportedPlaylist> };
  scheduled?(input: Base): Answer<unknown>;
}
