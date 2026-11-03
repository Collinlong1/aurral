import { useState } from "react";
import { ConfirmModal } from "../../components/ConfirmModal.tsx";
import { cancellableJobIds, type ActivityRequest } from "./activityListUtils.ts";
import type { useBulkSelection } from "./useBulkSelection.ts";

type BulkCancelProps = ReturnType<typeof useBulkSelection> & {
  controllingJobs: Record<string, "cancel" | "retry">;
  // Cancels one job without refreshing the queue.
  cancelJob: (jobId: string) => Promise<void>;
  // Refreshes the queue once the jobs are cancelled.
  onCancelled: () => void;
  filtered: boolean;
};

// The queue's bar for cancelling picked downloads, or all of them.
export function ActivityBulkCancel({
  cancellableIds,
  selectedJobIds,
  selectJobs,
  controllingJobs,
  cancelJob,
  onCancelled,
  filtered,
}: BulkCancelProps) {
  const [bulkCancelling, setBulkCancelling] = useState(false);
  const [confirmingCancelAll, setConfirmingCancelAll] = useState(false);

  // Cancels these jobs a few at a time, then refreshes the queue once.
  const cancelJobs = async (jobIds: string[]) => {
    const pending = jobIds.filter((jobId) => !controllingJobs[jobId]);
    if (!pending.length || bulkCancelling) return;
    setBulkCancelling(true);
    try {
      const cancelNext = async () => {
        for (let jobId = pending.shift(); jobId; jobId = pending.shift()) {
          await cancelJob(jobId);
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, pending.length) }, cancelNext));
      selectJobs(jobIds, false);
      onCancelled();
    } finally {
      setBulkCancelling(false);
      setConfirmingCancelAll(false);
    }
  };

  return (
    <>
      {cancellableIds.length > 0 ? (
        <div className="activity-bulk" role="group" aria-label="Cancel queued downloads">
          <label className="activity-bulk__all">
            <input
              type="checkbox"
              checked={selectedJobIds.size === cancellableIds.length}
              ref={(input) => {
                if (input) {
                  input.indeterminate =
                    selectedJobIds.size > 0 && selectedJobIds.size < cancellableIds.length;
                }
              }}
              onChange={(event) => selectJobs(cancellableIds, event.target.checked)}
              disabled={bulkCancelling}
            />
            <span role="status">
              {selectedJobIds.size
                ? `${selectedJobIds.size} selected`
                : `Select all ${cancellableIds.length}`}
            </span>
          </label>
          {selectedJobIds.size > 0 ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void cancelJobs([...selectedJobIds])}
              disabled={bulkCancelling}
              aria-busy={bulkCancelling}
            >
              {bulkCancelling ? "Cancelling…" : "Cancel selected"}
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-ghost-danger btn-sm"
            onClick={() => setConfirmingCancelAll(true)}
            disabled={bulkCancelling}
          >
            Cancel all
          </button>
        </div>
      ) : null}
      <ConfirmModal
        open={confirmingCancelAll}
        title="Cancel all queued downloads?"
        body={`Cancels ${cancellableIds.length === 1 ? "the 1 download" : `all ${cancellableIds.length} downloads`} waiting or running${filtered ? " under this filter" : ""}. You can retry them afterwards.`}
        confirmLabel="Cancel all"
        cancelLabel="Keep them"
        tone="danger"
        busyLabel="Cancelling"
        busy={bulkCancelling}
        onCancel={() => setConfirmingCancelAll(false)}
        onConfirm={() => void cancelJobs(cancellableIds)}
      />
    </>
  );
}

// A queue row's checkbox. A row picks its own job, or every job of an album
// grab that can be cancelled.
export function ActivityRowSelect({
  request,
  title,
  selectedJobIds,
  onSelectJobs,
}: {
  request: ActivityRequest;
  title: string;
  selectedJobIds?: ReadonlySet<string>;
  onSelectJobs: (jobIds: string[], selected: boolean) => void;
}) {
  const jobIds = cancellableJobIds([request]);
  const selectedCount = jobIds.filter((jobId) => selectedJobIds?.has(jobId)).length;
  return (
    <span className="activity-row__select">
      {jobIds.length ? (
        <input
          type="checkbox"
          checked={selectedCount > 0 && selectedCount === jobIds.length}
          ref={(input) => {
            if (input) input.indeterminate = selectedCount > 0 && selectedCount < jobIds.length;
          }}
          onChange={(event) => onSelectJobs(jobIds, event.target.checked)}
          aria-label={`Select ${title}`}
        />
      ) : null}
    </span>
  );
}
