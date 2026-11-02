import path from "path";
import type { DownloadJob, JobFields } from "./downloadJobs/downloadTracker.ts";
import { logger, safeLogDiagnostic } from "./logger.ts";

type RequestJob = Pick<DownloadJob, "id"> & { status: string } & JobFields<
    "managedBy" | "playlistType" | "requestGroupId" | "upgradeForJobId" | "finalPath"
  >;

// Statuses that can still change whether the request's tracks reach the Library.
const OPEN_STATUSES = new Set(["pending", "downloading", "cancel_requested", "blocked"]);

const belongsToRequest = (job: RequestJob) =>
  job.managedBy === "aurral" &&
  job.playlistType === "library" &&
  Boolean(job.requestGroupId) &&
  !job.upgradeForJobId;

// The deepest folder that holds every path, so a multi-disc album resolves to
// the album folder rather than one disc.
export function commonDirectory(filePaths: string[]) {
  const dirs = filePaths.map((filePath) => path.resolve(path.dirname(filePath)).split(path.sep));
  if (dirs.length === 0) return "";
  const shared: string[] = [];
  for (let index = 0; index < dirs[0].length; index++) {
    const part = dirs[0][index];
    if (!dirs.every((segments) => segments[index] === part)) break;
    shared.push(part);
  }
  return shared.join(path.sep) || path.sep;
}

export function requestAvailableOutcome(job: RequestJob, jobs: Iterable<RequestJob>) {
  if (!belongsToRequest(job)) return null;
  const members = [...jobs].filter(
    (entry) => belongsToRequest(entry) && entry.requestGroupId === job.requestGroupId,
  );
  if (members.some((entry) => OPEN_STATUSES.has(entry.status))) return null;
  const done = members
    .filter((entry) => entry.status === "done" && entry.finalPath)
    .map((entry) => String(entry.finalPath));
  if (done.length === 0) return null;
  return { requestGroupId: String(job.requestGroupId), albumPath: commonDirectory(done) };
}

// Marks an Aurral-managed album request available once its last job ends.
export function recordAurralRequestOutcome(job: RequestJob, jobs: Iterable<RequestJob>) {
  const outcome = requestAvailableOutcome(job, jobs);
  if (!outcome) return;
  import("./aurralHistoryService.ts")
    .then(({ recordAurralRequestAvailable }) => recordAurralRequestAvailable(outcome))
    .catch((error) => {
      logger.warn("history", "Could not record album request outcome", {
        reason: safeLogDiagnostic(error),
      });
    });
}
