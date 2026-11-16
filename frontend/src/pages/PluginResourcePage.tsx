import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useAuth } from "../contexts/AuthContext.tsx";
import { useAudioQueue } from "../contexts/audioQueueContext.ts";
import { useToast } from "../contexts/ToastContext.tsx";
import { Select } from "../components/Select";
import StatePanel from "../components/StatePanel";
import { AlertCircle, Play } from "../components/icons";
import { pluginsClient } from "../utils/api/clients/plugins.ts";
import { pluginQueueTrack } from "../utils/pluginQueue.ts";
import { albumPath } from "../../../lib/albumPath.ts";
import { getApiErrorMessage, readApiError } from "../utils/api/errors.ts";
import { formatDuration } from "./library/libraryShared.tsx";
import type { readPluginResource } from "../../../backend/services/plugins/pluginPresentation.ts";
import "./PluginPage.css";

type ResourceView = Awaited<ReturnType<typeof readPluginResource>>;
type WorkView = Extract<ResourceView, { version: 1 }>;
type Recording = WorkView["recordings"][number];
type Item = Recording["items"][number];

const ROLE_ORDER = ["soloist", "performer", "conductor", "orchestra", "ensemble", "choir"];
const ROLE_LABEL: Record<string, string> = {
  soloist: "Soloist",
  performer: "Performer",
  conductor: "Conductor",
  orchestra: "Orchestra",
  ensemble: "Ensemble",
  choir: "Choir",
};

// Who plays, by role, as each recording's heading lists them.
function performerLines(recording: Recording) {
  const credits = recording.credits.filter((credit) => credit.role !== "composer");
  return ROLE_ORDER.flatMap((role) => {
    const names = credits.filter((credit) => credit.role === role).map((credit) => credit.name);
    return names.length ? [{ role: ROLE_LABEL[role] ?? role, names: names.join(", ") }] : [];
  });
}

const itemsFor = (recording: Recording, movementId: string) =>
  recording.items.filter((item) => item.movementIds.includes(movementId));

export default function PluginResourcePage() {
  const { id = "", pageId = "", resourceId = "" } = useParams();
  const { user } = useAuth();
  const { playQueue } = useAudioQueue();
  const { showSuccess, showError } = useToast();
  const navigate = useNavigate();
  // "" compares whole works; a movement ID compares that movement.
  const [movementId, setMovementId] = useState("");
  // A view 2 page's search, sort, filters, page and tab live in the URL.
  const [search] = useSearchParams();
  const pageQuery = Object.fromEntries(
    (["q", "sort", "filters", "page", "tab"] as const).flatMap((key) => {
      const value = search.get(key);
      return value ? [[key, value]] : [];
    }),
  );
  const query = useQuery({
    queryKey: ["plugin-resource", id, pageId, resourceId, user?.id, pageQuery],
    queryFn: () =>
      parseResponse(
        pluginsClient[":id"].resources[":pageId"][":resourceId"].$get({
          param: { id, pageId, resourceId },
          query: pageQuery,
        }),
      ) as Promise<ResourceView>,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: (body: {
      command: "favourite" | "pick" | "admin-pick";
      value?: boolean;
      realizationId?: string | null;
    }) =>
      parseResponse(
        pluginsClient[":id"].resources[":pageId"][":resourceId"].$post({
          param: { id, pageId, resourceId },
          json: body,
        }),
      ),
    onSuccess: () => query.refetch(),
  });
  const savePlaylist = useMutation({
    mutationFn: (body: { name: string; itemIds: string[] }) =>
      parseResponse(
        pluginsClient[":id"].resources[":pageId"][":resourceId"].playlist.$post({
          param: { id, pageId, resourceId },
          json: body,
        }),
      ),
    onSuccess: (_, body) => showSuccess(`Saved “${body.name}” to your playlists`),
    onError: (error) => showError(getApiErrorMessage(error, "Couldn't save the playlist")),
  });
  const mutationError = mutation.isError
    ? (() => {
        const details = readApiError(mutation.error);
        return details.error || details.message || "Couldn't save that change. Try again.";
      })()
    : "";
  const loaded = query.data;
  if (query.isPending)
    return (
      <div className="plugin-page">
        <p role="status">Loading…</p>
      </div>
    );
  if (!loaded || query.isError)
    return (
      <div className="plugin-page">
        <StatePanel
          icon={<AlertCircle aria-hidden="true" />}
          heading="h1"
          role="alert"
          title="Couldn't load this work"
          message="The plugin could not load it."
          onRetry={() => query.refetch()}
          retrying={query.isFetching}
        />
      </div>
    );
  if (loaded.version !== 1)
    return (
      <div className="plugin-page">
        <StatePanel
          icon={<AlertCircle aria-hidden="true" />}
          heading="h1"
          role="alert"
          title="Can't show this page"
          message="This plugin page needs a newer Aurral."
        />
      </div>
    );
  const data: WorkView = loaded;
  const workTitle = data.work.title;
  const movement = data.work.movements.find((entry) => entry.id === movementId) ?? null;
  const composers = data.work.credits.filter((credit) => credit.role === "composer");
  const recordings = movement
    ? data.recordings.filter((recording) => itemsFor(recording, movement.id).length)
    : data.recordings;
  const queueOf = (items: Item[]) => items.map((item) => pluginQueueTrack(item, workTitle));
  const playItems = (items: Item[], source: string, startTrackId: string | null = null) =>
    playQueue(queueOf(items), {
      startTrackId,
      source: { type: "plugin-work", id: source, label: workTitle },
    });
  // The comparison, one recording after another: whole works, or the chosen
  // movement from each.
  const comparisonItems = recordings.flatMap((recording) =>
    movement ? itemsFor(recording, movement.id) : recording.items,
  );
  const comparisonName = movement
    ? `Compare: ${workTitle} – ${movement.title}`
    : `Compare: ${workTitle}`;
  const pickButtons = (recording: Recording) => (
    <>
      {data.pickedRealizationId === recording.id && data.pickScope === "user" ? (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          aria-pressed="true"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate({ command: "pick", realizationId: null })}
        >
          Your pick · Clear
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate({ command: "pick", realizationId: recording.id })}
        >
          {data.pickedRealizationId === recording.id
            ? "Server pick · Make my pick"
            : "Make my pick"}
        </button>
      )}
      {user?.role === "admin" && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={mutation.isPending}
          onClick={() =>
            mutation.mutate({
              command: "admin-pick",
              realizationId: data.adminPickId === recording.id ? null : recording.id,
            })
          }
        >
          {data.adminPickId === recording.id ? "Clear server pick" : "Set server pick"}
        </button>
      )}
    </>
  );
  return (
    <div className="plugin-page plugin-resource">
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate(-1)}>
        Back
      </button>
      <h1 className="page-title plugin-resource__title">{workTitle}</h1>
      <p className="plugin-resource__meta">
        {[
          composers.map((credit) => credit.name).join(", "),
          data.work.nickname && `“${data.work.nickname}”`,
          data.work.collections.length
            ? `Part of ${data.work.collections.map((collection) => collection.title).join(", ")}`
            : "",
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {data.work.description && <p className="plugin-resource__meta">{data.work.description}</p>}
      <div className="plugin-resource__actions">
        <button
          type="button"
          className="btn btn-secondary"
          aria-pressed={data.favourite}
          disabled={mutation.isPending}
          onClick={() => mutation.mutate({ command: "favourite", value: !data.favourite })}
        >
          {data.favourite ? "Remove favourite" : "Favourite work"}
        </button>
      </div>
      {mutationError && <p role="alert">{mutationError}</p>}

      <section aria-labelledby="plugin-resource-compare">
        <div className="plugin-resource__heading">
          <h2 id="plugin-resource-compare">Owned recordings</h2>
          {data.work.movements.length > 1 ? (
            <Select
              className="input plugin-resource__select"
              aria-label="Compare"
              value={movementId}
              options={[
                { value: "", label: "Whole work" },
                ...data.work.movements.map((entry) => ({ value: entry.id, label: entry.title })),
              ]}
              onChange={setMovementId}
            />
          ) : null}
        </div>
        {recordings.length > 1 ? (
          <div className="plugin-resource__actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => playItems(comparisonItems, `${data.work.id}:compare:${movementId}`)}
            >
              Play comparison
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={savePlaylist.isPending}
              onClick={() =>
                savePlaylist.mutate({
                  name: comparisonName,
                  itemIds: comparisonItems.map((item) => item.id),
                })
              }
            >
              Save as playlist
            </button>
          </div>
        ) : null}
        {!recordings.length ? (
          <p className="plugin-resource__meta">
            {movement
              ? "No recording in your library has this movement."
              : "No recordings in your library."}
          </p>
        ) : null}
        <div className="plugin-resource__compare">
          {recordings.map((recording) => {
            const items = movement ? itemsFor(recording, movement.id) : recording.items;
            const lines = performerLines(recording);
            const partMs = movement
              ? recording.parts.find((part) => part.movementId === movement.id)?.durationMs
              : recording.durationMs;
            return (
              <article className="plugin-resource__recording" key={recording.id}>
                <h3>{recording.label}</h3>
                {lines.length ? (
                  <p className="plugin-resource__facts">
                    {lines
                      .map((line) =>
                        line.role ? `${line.names} (${line.role.toLowerCase()})` : line.names,
                      )
                      .join(" · ")}
                  </p>
                ) : null}
                <p className="plugin-resource__facts">
                  {[
                    recording.year,
                    recording.recordLabel,
                    formatDuration(partMs ?? null),
                    movement
                      ? ""
                      : recording.complete
                        ? "Complete"
                        : `Missing ${recording.missing.map((entry) => entry.title).join(", ")}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <p className="plugin-resource__facts">
                  {recording.releases.length > 1 ? (
                    <>
                      On{" "}
                      {recording.releases.map((release, index) => (
                        <span key={release.albumId}>
                          {index ? ", " : ""}
                          <Link to={albumPath(release.albumId)}>{release.album || "Album"}</Link>
                        </span>
                      ))}
                    </>
                  ) : recording.albumId ? (
                    <Link to={albumPath(recording.albumId)}>Open album</Link>
                  ) : null}
                </p>
                <ol className="plugin-resource__parts">
                  {items.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="plugin-resource__movement"
                        aria-label={`Play ${item.title}`}
                        onClick={() => playItems(recording.items, recording.id, item.id)}
                      >
                        <span>{item.title}</span>
                        <span className="plugin-resource__time">
                          {formatDuration(
                            item.endMs != null ? item.endMs - item.startMs : item.durationMs,
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
                <div className="plugin-resource__actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => playItems(items, recording.id)}
                  >
                    <Play aria-hidden="true" /> {movement ? "Play movement" : "Play whole work"}
                  </button>
                  {pickButtons(recording)}
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
