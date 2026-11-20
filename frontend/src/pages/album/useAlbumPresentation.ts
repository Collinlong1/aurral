import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { useHasPluginAlbumPresentation } from "../../hooks/usePluginActions.ts";
import { queryKeys } from "../../queryClient.ts";
import { pluginsClient } from "../../utils/api/clients/plugins.ts";

const STORAGE_KEY = "aurral.album-view";
export type AlbumView = "grouped" | "tracks";

function readView(): AlbumView {
  try {
    return localStorage.getItem(STORAGE_KEY) === "tracks" ? "tracks" : "grouped";
  } catch {
    return "grouped";
  }
}

// Headings a plugin adds over runs of a Library album's tracks. Nothing is
// requested unless an active plugin offers them.
export function useAlbumPresentation(albumId: number | string | null | undefined) {
  const offered = useHasPluginAlbumPresentation();
  const enabled = offered && albumId != null;
  const query = useQuery({
    queryKey: queryKeys.pluginAlbumPresentation(albumId),
    queryFn: ({ signal }) =>
      parseResponse(
        pluginsClient["album-presentation"][":albumId"].$get(
          { param: { albumId: String(albumId) } },
          { init: { signal } },
        ),
      ),
    enabled,
    retry: false,
    staleTime: 60_000,
  });
  const [view, setViewState] = useState(readView);
  const setView = (next: AlbumView) => {
    setViewState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {}
  };
  const presentation = (enabled && query.data?.presentation) || null;
  return { presentation, view, setView, grouped: Boolean(presentation) && view === "grouped" };
}
