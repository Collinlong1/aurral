import { useCallback, useMemo, useState } from "react";
import { cancellableJobIds, type ActivityRequest } from "./activityListUtils.ts";

// Picks queued jobs to cancel together. Every job under the current filter
// that can be cancelled counts, including ones further down than "Load more"
// has reached; picks of jobs that finished or left the filter drop out on
// their own.
export function useBulkSelection(requests: ActivityRequest[], enabled: boolean) {
  const [pickedJobIds, setPickedJobIds] = useState<ReadonlySet<string>>(() => new Set());
  const cancellableIds = useMemo(
    () => (enabled ? cancellableJobIds(requests) : []),
    [requests, enabled],
  );
  const selectedJobIds = useMemo(
    () => new Set(cancellableIds.filter((jobId) => pickedJobIds.has(jobId))),
    [cancellableIds, pickedJobIds],
  );
  const selectJobs = useCallback((jobIds: string[], selected: boolean) => {
    setPickedJobIds((current) => {
      const next = new Set(current);
      for (const jobId of jobIds) {
        if (selected) next.add(jobId);
        else next.delete(jobId);
      }
      return next;
    });
  }, []);
  // What each queue row needs to show its checkbox.
  const rowProps = { selectedJobIds, onSelectJobs: selectJobs };
  return { cancellableIds, selectedJobIds, selectJobs, rowProps };
}
