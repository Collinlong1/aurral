import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { parseResponse } from "hono/client";
import { Download, Link, Search } from "../../components/icons";
import { ModalShell } from "../../components/PlaylistModals.tsx";
import { DotLoader } from "../../components/DotLoader.tsx";
import { playlistJobsClient } from "../../utils/api/clients/playlistJobs.ts";
import { getApiErrorMessage } from "../../utils/api/errors.ts";
import { useAuth } from "../../contexts/AuthContext";
import { DiskFilePanel } from "./DiskFilePanel.tsx";

const jobRoutes = playlistJobsClient.jobs[":jobId"];

export type LinkFileJob = { id: string; trackName?: string | null; artistName?: string | null };

const formatDuration = (durationMs: number) => {
  const seconds = Math.floor(durationMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const defaultQuery = (job: LinkFileJob | null) =>
  [job?.artistName, job?.trackName].filter(Boolean).join(" ");

// Fills a missing track with a file you already have, so Aurral stops
// searching for it: a file in the Library, linked where it is, or for an admin,
// an audio file on disk that Aurral copies into the Library.
export default function LinkLibraryFileModal({
  job,
  playlistId = null,
  onClose,
  onLinked,
}: {
  job: LinkFileJob | null;
  playlistId?: string | null;
  onClose: () => void;
  onLinked?: (job: LinkFileJob, how: "linked" | "imported") => void;
}) {
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState("");
  const [tab, setTab] = useState<"library" | "disk">("library");
  const [diskPath, setDiskPath] = useState("");
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  useEffect(() => {
    const initial = defaultQuery(job);
    setDraft(initial);
    setQuery(initial);
    setSelectedId(null);
    setActionError("");
    setTab("library");
    setDiskPath("");
  }, [job]);

  const jobId = job?.id ?? "";
  const filesQuery = useQuery({
    queryKey: ["link-library-files", jobId, playlistId, query],
    queryFn: ({ signal }) =>
      parseResponse(
        jobRoutes["library-files"].$get(
          {
            param: { jobId: encodeURIComponent(jobId) },
            query: { q: query, ...(playlistId && { playlistId }) },
          },
          { init: { signal } },
        ),
      ),
    enabled: Boolean(job && query.trim()),
    staleTime: 15_000,
  });
  const files = filesQuery.data?.files ?? [];

  const handleSearch = (event: FormEvent) => {
    event.preventDefault();
    setSelectedId(null);
    setActionError("");
    setQuery(draft.trim());
  };

  const fromDisk = tab === "disk";
  const canSubmit = fromDisk ? Boolean(diskPath) : selectedId != null;

  const handleLink = async () => {
    if (!job || !canSubmit) return;
    setSubmitting(true);
    setActionError("");
    try {
      const param = { jobId: encodeURIComponent(job.id) };
      const target = playlistId ? { playlistId } : {};
      await parseResponse(
        fromDisk
          ? jobRoutes["import-file"].$post({ param, json: { path: diskPath, ...target } })
          : jobRoutes["link-file"].$post({ param, json: { fileId: selectedId!, ...target } }),
      );
      onLinked?.(job, fromDisk ? "imported" : "linked");
      onClose();
    } catch (err) {
      setActionError(
        getApiErrorMessage(
          err,
          fromDisk
            ? "Could not import the file. Try again."
            : "Could not link the file. Try again.",
        ),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const error =
    actionError ||
    (filesQuery.error ? getApiErrorMessage(filesQuery.error, "Could not search the Library.") : "");

  return (
    <ModalShell
      open={Boolean(job)}
      className="manual-search-modal"
      title="Use a file you have"
      description={`${job?.artistName || "Unknown artist"} · ${job?.trackName || "Unknown track"}`}
      onClose={onClose}
      disableClose={submitting}
      footer={
        <>
          <button
            type="button"
            className="btn btn-secondary manual-search-modal__action"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary manual-search-modal__action"
            onClick={handleLink}
            disabled={!canSubmit || submitting}
          >
            {submitting ? (
              <DotLoader size="sm" label={null} />
            ) : fromDisk ? (
              <Download className="artist-icon-sm" aria-hidden="true" />
            ) : (
              <Link className="artist-icon-sm" aria-hidden="true" />
            )}
            {fromDisk ? "Import file" : "Link file"}
          </button>
        </>
      }
    >
      {isAdmin ? (
        <div className="artist-segmented" role="group" aria-label="Where the file is">
          {(
            [
              { id: "library", label: "In the Library" },
              { id: "disk", label: "File on disk" },
            ] as const
          ).map((option) => (
            <button
              key={option.id}
              type="button"
              className={`artist-segmented-button${tab === option.id ? " is-active" : ""}`}
              aria-pressed={tab === option.id}
              onClick={() => {
                setTab(option.id);
                setActionError("");
              }}
              disabled={submitting}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
      {fromDisk && job ? (
        <>
          <DiskFilePanel
            jobId={job.id}
            selectedPath={diskPath}
            disabled={submitting}
            onSelect={(filePath) => {
              setDiskPath(filePath);
              setActionError("");
            }}
          />
          {actionError ? (
            <p className="artist-error-text" role="alert">
              {actionError}
            </p>
          ) : null}
        </>
      ) : (
        <>
          <form className="manual-search-modal__controls" onSubmit={handleSearch}>
            <label className="artist-field-label" htmlFor="link-library-file-query">
              Search the Library
            </label>
            <div className="manual-search-modal__source-row">
              <input
                id="link-library-file-query"
                type="search"
                className="input input--tall"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Artist, title, or album"
                disabled={submitting}
              />
              <button
                type="submit"
                className="btn btn-secondary btn-sm manual-search-modal__action"
                disabled={!draft.trim() || submitting || filesQuery.isFetching}
              >
                {filesQuery.isFetching ? (
                  <DotLoader size="sm" label={null} />
                ) : (
                  <Search className="artist-icon-sm" aria-hidden="true" />
                )}
                Search
              </button>
            </div>
          </form>

          {error ? (
            <p className="artist-error-text" role="alert">
              {error}
            </p>
          ) : null}
          {filesQuery.isSuccess && files.length === 0 ? (
            <p className="manual-search-modal__empty">
              No Library files match. Try fewer words, or only the title.
            </p>
          ) : null}
          {files.length > 0 ? (
            <fieldset className="manual-search-results">
              <legend>
                {files.length} file{files.length === 1 ? "" : "s"}
              </legend>
              <div className="manual-search-results__list">
                {files.map((file) => (
                  <label
                    className={`manual-search-result${selectedId === file.fileId ? " is-selected" : ""}`}
                    key={file.fileId}
                  >
                    <input
                      type="radio"
                      name="link-library-file"
                      value={file.fileId}
                      checked={selectedId === file.fileId}
                      onChange={() => setSelectedId(file.fileId)}
                      disabled={submitting}
                    />
                    <span className="manual-search-result__content">
                      <strong>{file.title}</strong>
                      <span>
                        {[file.artistName, file.albumTitle].filter(Boolean).join(" · ") ||
                          "Unknown artist"}
                      </span>
                      {file.format || file.durationMs ? (
                        <small>
                          {[
                            file.format?.toUpperCase(),
                            file.durationMs ? formatDuration(file.durationMs) : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </small>
                      ) : null}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
        </>
      )}
    </ModalShell>
  );
}
