import { useEffect, useState } from "react";
import { parseResponse } from "hono/client";
import { Download } from "../../components/icons";
import { ModalShell } from "../../components/PlaylistModals.tsx";
import { DotLoader } from "../../components/DotLoader.tsx";
import { playlistJobsClient } from "../../utils/api/clients/playlistJobs.ts";
import { getApiErrorMessage } from "../../utils/api/errors.ts";
import { DiskFilePanel } from "./DiskFilePanel.tsx";
import { useAuth } from "../../contexts/AuthContext";

export type ImportFileJob = { id: string; trackName?: string | null; artistName?: string | null };

export default function ImportDiskFileModal({
  job,
  playlistId = null,
  onClose,
  onImported,
}: {
  job: ImportFileJob | null;
  playlistId?: string | null;
  onClose: () => void;
  onImported?: (job: ImportFileJob) => void;
}) {
  const [selectedPath, setSelectedPath] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const { user } = useAuth();
  useEffect(() => {
    setSelectedPath("");
    setError("");
  }, [job]);
  const handleImport = async () => {
    if (!job || !selectedPath || user?.role !== "admin") return;
    setSubmitting(true);
    setError("");
    try {
      await parseResponse(
        playlistJobsClient.jobs[":jobId"]["import-file"].$post({
          param: { jobId: encodeURIComponent(job.id) },
          json: { path: selectedPath, ...(playlistId && { playlistId }) },
        }),
      );
      onImported?.(job);
      onClose();
    } catch (err) {
      setError(getApiErrorMessage(err, "Could not import the file."));
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <ModalShell
      open={Boolean(job) && user?.role === "admin"}
      className="manual-search-modal"
      title="Import a file from disk"
      description={`${job?.artistName || "Unknown artist"} · ${job?.trackName || "Unknown track"}`}
      onClose={onClose}
      disableClose={submitting}
      footer={
        <>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleImport}
            disabled={!selectedPath || submitting}
          >
            {submitting ? (
              <DotLoader size="sm" label={null} />
            ) : (
              <Download className="artist-icon-sm" aria-hidden="true" />
            )}
            Import file
          </button>
        </>
      }
    >
      {job ? (
        <DiskFilePanel
          jobId={job.id}
          selectedPath={selectedPath}
          disabled={submitting}
          onSelect={(value) => {
            setSelectedPath(value);
            setError("");
          }}
        />
      ) : null}
      {error ? (
        <p className="artist-error-text" role="alert">
          {error}
        </p>
      ) : null}
    </ModalShell>
  );
}
