export type SettingValue = string | number | boolean;

export interface Base {
  capabilities?: {
    adminForms?: 1;
    resourceView?: 1 | 2;
    albumPresentation?: 1;
    search?: 1;
    // Items may carry `links` (classical fork).
    itemLinks?: 1;
    trackLinks?: 1;
  };
  userOperations?: { version: 1; url: string; token: string };
  settings: Record<string, SettingValue>;
  libraryFolder: string;
  dataFolder: string;
  api?: { url: string; key: string };
}

export interface PresentationQueueItem {
  id: string;
  trackId: string;
  fileId: string;
  albumId: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number | null;
  startMs: number;
  endMs: number | null;
  links?: ItemLink[];
}

// Typed links; Aurral builds every path. A filter link applies its filters
// to the page it is on, or opens the plugin's search results elsewhere.
export type PluginLink =
  | { type: "resource"; pageId: string; resourceId: string }
  | { type: "album"; albumId: string }
  | { type: "filter"; filters: Record<string, string[]> };
// Up to six on one item, for its menu.
export interface ItemLink {
  label: string;
  link: PluginLink;
}

export interface AlbumPresentationInput extends Base {
  user: User;
  album: Album;
}

// `"search": true`: results for Aurral's search page. Core renders them and
// builds each link; a result without a link is plain text.
export interface SearchInput extends Base {
  user: User;
  query: {
    q: string;
    filters: Record<string, string[]>;
    // Set when the person opened one section to see more of it.
    section: string | null;
    offset: number;
    limit: number;
  };
}
export type SearchLink = PluginLink;
export interface SearchItem {
  id: string;
  kind: string;
  title: string;
  subtitle?: string;
  detail?: string;
  link?: SearchLink | null;
  links?: ItemLink[];
}
export interface SearchResult {
  version: 1;
  best?: SearchItem | null;
  total: number;
  sections: { id: string; title: string; total: number; items: SearchItem[] }[];
  facets?: {
    key: string;
    label: string;
    selected?: string[];
    options: { value: string; label: string; count: number }[];
  }[];
}

export interface ResourcePageInput extends Base {
  user: User;
  pageId: string;
  resourceId: string;
  // View 2 hosts: what the page's URL asks for.
  query?: {
    q: string;
    sort: string;
    tab: string;
    page: number;
    filters: Record<string, string[]>;
  };
  mutation?: ResourceMutation;
}
export type ResourceMutation =
  | { command: "favourite" | "pick" | "admin-pick"; value?: boolean; realizationId?: string | null }
  | { command: "favourite-item"; target: string; value?: boolean }
  | { command: "delete-queue"; target: string }
  | { command: "save-queue"; name: string; itemIds: string[] };

// A Library page (`capabilities.resourceView: 2`), rendered by core.
export interface ViewRow {
  id: string;
  label: string;
  detail?: string;
  badge?: string;
  link?: PluginLink | null;
}
export interface ViewFact {
  label: string;
  value: string;
  link?: PluginLink | null;
}
export type ViewAction = { label: string; pressed?: boolean } & (
  | { link: PluginLink }
  | { mutation: ResourceMutation }
);
export type ViewSection =
  | {
      type: "header";
      title: string;
      subtitle?: string;
      facts?: ViewFact[];
      badges?: string[];
      actions?: ViewAction[];
    }
  | { type: "rows"; id: string; title?: string; rows: ViewRow[]; empty?: string }
  | {
      type: "groups";
      id: string;
      title?: string;
      groups: { heading: string; detail?: string; link?: PluginLink | null; rows: ViewRow[] }[];
    }
  | {
      type: "tracks";
      id: string;
      title?: string;
      context?: string;
      items: (PresentationQueueItem & { link?: PluginLink | null })[];
    }
  | { type: "details"; id: string; title?: string; items: ViewFact[] }
  | { type: "pager"; total: number; offset: number; limit: number }
  | { type: "tabs"; active?: string; tabs: { id: string; label: string; count?: number }[] }
  | {
      type: "filters";
      filters: {
        key: string;
        label: string;
        options: { value: string; label: string; count?: number }[];
        selected?: string[];
      }[];
    }
  | { type: "sort"; active?: string; options: { value: string; label: string }[] }
  | { type: "empty"; message: string };
export interface ResourceViewV2 {
  version: 2;
  title: string;
  sections: ViewSection[];
}

// `"trackLinks": true`: links for Library tracks, by track ID.
export interface TrackLinksInput extends Base {
  user: User;
  trackIds: string[];
}
export interface TrackLinksResult {
  version: 1;
  tracks: Record<string, ItemLink[]>;
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
  ):
    | { done: boolean; path?: string; filed?: number }
    | Promise<{ done: boolean; path?: string; filed?: number }>;
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
  search?(input: SearchInput): Answer<SearchResult>;
  trackLinks?(input: TrackLinksInput): Answer<TrackLinksResult>;
}
