import type { QualityState } from "../../../../backend/services/qualityProfileModel.ts";

export interface MissingJob {
  id?: string | number;
  status?: string;
  upgradeForJobId?: string | number | null;
  monitored?: boolean;
  albumCancelled?: boolean;
  qualityOwned?: boolean;
  qualityState?: QualityState | null;
  createdAt?: number;
  trackName?: string | null;
}

// Matches the playlist page, which calls failed and cancelled tracks Missing.
// Tracks of a cancelled album request stay out: they need a new album request.
export const isMissingJob = (job: MissingJob | null | undefined) =>
  (job?.status === "failed" || (job?.status === "cancelled" && job?.albumCancelled !== true)) &&
  !job?.upgradeForJobId &&
  job?.monitored !== false;

export const isCutoffUnmetJob = (job: MissingJob | null | undefined) =>
  job?.status === "done" &&
  job?.qualityOwned === true &&
  job?.qualityState !== "preferred" &&
  job?.monitored !== false;

export const getMissingJobKey = (job: MissingJob | null | undefined) => String(job?.id || "");

export const sortMissingJobs = (
  left: MissingJob | null | undefined,
  right: MissingJob | null | undefined,
) =>
  Number(right?.createdAt || 0) - Number(left?.createdAt || 0) ||
  String(left?.trackName || "").localeCompare(String(right?.trackName || ""));
