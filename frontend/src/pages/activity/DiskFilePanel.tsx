import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { ArrowUp, Folder, Music } from "../../components/icons";
import { DotLoader } from "../../components/DotLoader.tsx";
import { playlistJobsClient } from "../../utils/api/clients/playlistJobs.ts";
import { getApiErrorMessage } from "../../utils/api/errors.ts";
import "./DiskFilePanel.css";

const diskFiles = playlistJobsClient.jobs[":jobId"]["disk-files"];

// Browses the folders Aurral can read for an audio file, or takes a typed
// path, such as one Lidarr uses. The parent imports the chosen file.
export function DiskFilePanel({
  jobId,
  selectedPath,
  disabled,
  onSelect,
}: {
  jobId: string;
  selectedPath: string;
  disabled: boolean;
  onSelect: (filePath: string) => void;
}) {
  const [folder, setFolder] = useState<string | undefined>(undefined);
  const [typed, setTyped] = useState("");
  const listing = useQuery({
    queryKey: ["disk-files", jobId, folder ?? ""],
    queryFn: ({ signal }) =>
      parseResponse(
        diskFiles.$get(
          {
            param: { jobId: encodeURIComponent(jobId) },
            query: folder ? { path: folder } : {},
          },
          { init: { signal } },
        ),
      ),
    staleTime: 10_000,
  });
  const data = listing.data;

  const handleTyped = (event: FormEvent) => {
    event.preventDefault();
    const value = typed.trim();
    if (value) onSelect(value);
  };

  return (
    <div className="disk-file-panel">
      <form className="manual-search-modal__controls" onSubmit={handleTyped}>
        <label className="artist-field-label" htmlFor="disk-file-path">
          File path
        </label>
        <div className="manual-search-modal__source-row">
          <input
            id="disk-file-path"
            type="text"
            className="input input--tall"
            autoComplete="off"
            spellCheck={false}
            placeholder="/music/Artist/Album/01 Track.flac"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            disabled={disabled}
          />
          <button
            type="submit"
            className="btn btn-secondary btn-sm manual-search-modal__action"
            disabled={disabled || !typed.trim()}
          >
            Use path
          </button>
        </div>
        <p className="disk-file-panel__hint">
          Paste a path as Aurral or Lidarr sees it, or choose a file below. Aurral copies it into
          the Library and leaves the original where it is.
        </p>
      </form>

      <div className="disk-file-panel__browser" aria-busy={listing.isFetching}>
        <p className="disk-file-panel__location">{data?.displayPath || "Storage"}</p>
        <ul className="disk-file-panel__list" aria-label="Folders and audio files">
          {data?.parent ? (
            <li>
              <button
                type="button"
                className="disk-file-panel__entry"
                onClick={() => setFolder(data.parent!)}
                disabled={disabled}
              >
                <ArrowUp aria-hidden="true" />
                <span>Up one folder</span>
              </button>
            </li>
          ) : null}
          {(data?.entries ?? []).map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                className={`disk-file-panel__entry${
                  entry.kind === "file" && selectedPath === entry.path ? " is-selected" : ""
                }`}
                aria-pressed={entry.kind === "file" ? selectedPath === entry.path : undefined}
                onClick={() =>
                  entry.kind === "folder" ? setFolder(entry.path) : onSelect(entry.path)
                }
                disabled={disabled}
              >
                {entry.kind === "folder" ? (
                  <Folder aria-hidden="true" />
                ) : (
                  <Music aria-hidden="true" />
                )}
                <span>{entry.name}</span>
              </button>
            </li>
          ))}
        </ul>
        {listing.isFetching && !data ? (
          <p className="disk-file-panel__status">
            <DotLoader size="sm" label={null} /> Loading…
          </p>
        ) : null}
        {data && data.entries.length === 0 ? (
          <p className="disk-file-panel__status">No folders or audio files here.</p>
        ) : null}
        {listing.error ? (
          <p className="artist-error-text" role="alert">
            {getApiErrorMessage(listing.error, "Could not browse that folder.")}
          </p>
        ) : null}
      </div>
      {selectedPath ? (
        <p className="disk-file-panel__selected">
          Selected: <span>{selectedPath}</span>
        </p>
      ) : null}
    </div>
  );
}
