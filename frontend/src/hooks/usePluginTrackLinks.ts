// Plugin links for library tracks (GET /plugins/track-links), cached per
// track id. Asked only when a plugin answers them, and for a menu only when
// it opens.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { useReducer } from "react";
import { useAuth } from "../contexts/AuthContext";
import { pluginsClient } from "../utils/api/clients/plugins.ts";
import type { QueueTrackLink } from "../utils/audioQueue.ts";
import { usePluginActionList } from "./usePluginActions.ts";

const TRACK_LINKS_STALE_MS = 10 * 60_000;
const trackLinksKey = (userId: unknown, trackId: string) =>
  ["plugin-track-links", userId ?? null, trackId] as const;
const trackId = (id: unknown) => (/^\d{1,12}$/.test(String(id ?? "")) ? String(id) : "");

const fetchTrackLinks = async (id: string, signal?: AbortSignal): Promise<QueueTrackLink[]> => {
  const answer = await parseResponse(
    pluginsClient["track-links"].$get({ query: { trackIds: id } }, { init: { signal } }),
  );
  return answer.links[id] ?? [];
};

// For menus built per row: `load` when a menu opens, then `linksFor`.
export function usePluginTrackLinks() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const enabled = usePluginActionList().data?.trackLinks === true;
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  return {
    load(rawId: unknown) {
      const id = trackId(rawId);
      if (!enabled || !id) return;
      void queryClient
        .fetchQuery({
          queryKey: trackLinksKey(user?.id, id),
          queryFn: ({ signal }) => fetchTrackLinks(id, signal),
          staleTime: TRACK_LINKS_STALE_MS,
        })
        .then(refresh, () => {});
    },
    linksFor(rawId: unknown): QueueTrackLink[] {
      const id = trackId(rawId);
      if (!enabled || !id) return [];
      return queryClient.getQueryData<QueueTrackLink[]>(trackLinksKey(user?.id, id)) ?? [];
    },
  };
}

// For one track on show, as the player's current track.
export function usePluginTrackLinksFor(rawId: unknown, skip = false) {
  const { user } = useAuth();
  const id = trackId(rawId);
  const wanted = Boolean(id) && !skip;
  const enabled = usePluginActionList(wanted).data?.trackLinks === true && wanted;
  return (
    useQuery({
      queryKey: trackLinksKey(user?.id, id),
      queryFn: ({ signal }) => fetchTrackLinks(id, signal),
      enabled,
      staleTime: TRACK_LINKS_STALE_MS,
    }).data ?? []
  );
}
