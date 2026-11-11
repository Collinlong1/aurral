import { useMutation, useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { Link, useParams } from "react-router";
import { useAuth } from "../contexts/AuthContext.tsx";
import { useAudioQueue } from "../contexts/audioQueueContext.ts";
import { pluginsClient } from "../utils/api/clients/plugins.ts";
import { normalizeStreamQueueTrack } from "../utils/audioQueue.ts";
import type { readPluginResource } from "../../../backend/services/plugins/pluginPresentation.ts";
import "./PluginPage.css";

type WorkView = Awaited<ReturnType<typeof readPluginResource>>;

export default function PluginResourcePage() {
  const { id = "", pageId = "", resourceId = "" } = useParams();
  const { user } = useAuth();
  const { playQueue } = useAudioQueue();
  const query = useQuery({
    queryKey: ["plugin-resource", id, pageId, resourceId, user?.id],
    queryFn: () =>
      parseResponse(
        pluginsClient[":id"].resources[":pageId"][":resourceId"].$get({
          param: { id, pageId, resourceId },
        }),
      ) as Promise<WorkView>,
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
  const data = query.data;
  const play = (recording: WorkView["recordings"][number]) =>
    playQueue(
      recording.items.map((item) =>
        normalizeStreamQueueTrack({
          id: item.id,
          trackId: item.trackId,
          title: item.title,
          artist: item.artist,
          album: item.album,
          durationMs: item.endMs != null ? item.endMs - item.startMs : item.durationMs,
          segmentStartMs: item.startMs,
          segmentEndMs: item.endMs,
          streamPath: item.streamPath,
          recordHistory: true,
        }),
      ),
      { source: { type: "plugin-work", id: recording.id, label: data?.work.title } },
    );
  if (query.isPending)
    return (
      <div className="plugin-page">
        <p role="status">Loading…</p>
      </div>
    );
  if (!data || query.isError)
    return (
      <div className="plugin-page">
        <h1>Work unavailable</h1>
        <p role="alert">The plugin could not load this work.</p>
      </div>
    );
  const composers = data.work.credits.filter((credit) => credit.role === "composer");
  return (
    <div className="plugin-page plugin-resource">
      <Link to="/library/albums">Library</Link>
      <h1>{data.work.title}</h1>
      {data.work.nickname && <p>{data.work.nickname}</p>}
      {composers.length > 0 && <p>{composers.map((credit) => credit.name).join(", ")}</p>}
      {data.work.description && <p>{data.work.description}</p>}
      {data.work.collections.length > 0 && (
        <p>Part of {data.work.collections.map((collection) => collection.title).join(", ")}</p>
      )}
      <button
        type="button"
        className={data.favourite ? "btn btn-primary" : "btn btn-secondary"}
        disabled={mutation.isPending}
        onClick={() => mutation.mutate({ command: "favourite", value: !data.favourite })}
      >
        {data.favourite ? "Remove favourite" : "Favourite work"}
      </button>
      <section>
        <h2>Movements</h2>
        <ol>
          {data.work.movements.map((movement) => (
            <li key={movement.id}>{movement.title}</li>
          ))}
        </ol>
      </section>
      <section>
        <h2>Owned recordings</h2>
        {data.recordings.map((recording) => (
          <article className="plugin-resource__recording" key={recording.id}>
            <h3>{recording.label}</h3>
            {recording.credits.length > 0 && (
              <p>
                {recording.credits.map((credit) => `${credit.name} · ${credit.role}`).join("; ")}
              </p>
            )}
            <p>
              {recording.complete
                ? "Complete"
                : `Missing: ${recording.missing.map((item) => item.title).join(", ")}`}
            </p>
            <ol>
              {recording.items.map((item) => (
                <li key={item.id}>{item.title}</li>
              ))}
            </ol>
            <button type="button" className="btn btn-primary" onClick={() => play(recording)}>
              Play whole work
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate({ command: "pick", realizationId: recording.id })}
            >
              {data.pickedRealizationId === recording.id
                ? `Your pick${data.pickScope === "admin" ? " (admin fallback)" : ""}`
                : "Make my pick"}
            </button>
            {user?.role === "admin" && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={mutation.isPending}
                onClick={() =>
                  mutation.mutate({ command: "admin-pick", realizationId: recording.id })
                }
              >
                Set admin pick
              </button>
            )}
          </article>
        ))}
      </section>
    </div>
  );
}
