import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  isCancelableDownload,
  cancellableJobIds,
  type ActivityRequest,
} from "../../frontend/src/pages/activity/activityListUtils.ts";

const track = (jobId: string | null, status: string, kind = "track_download") =>
  ({ id: `request-${jobId}`, jobId, status, kind }) as unknown as ActivityRequest;

test("only waiting or running track downloads can be cancelled", () => {
  assert.equal(isCancelableDownload(track("a", "pending")), true);
  assert.equal(isCancelableDownload(track("b", "processing")), true);
  for (const status of ["blocked", "failed", "cancelled", "completed"]) {
    assert.equal(isCancelableDownload(track("c", status)), false, status);
  }
  assert.equal(isCancelableDownload(track(null, "pending")), false);
  assert.equal(isCancelableDownload(track("d", "pending", "album_download")), false);
});

test("bulk cancel takes each cancellable job once, including an album grab's tracks", () => {
  const album = {
    ...track(null, "processing", "album_download"),
    children: [track("t1", "processing"), track("t2", "blocked"), track("t3", "pending")],
  } as ActivityRequest;
  assert.deepEqual(
    cancellableJobIds([track("a", "pending"), album, track("a", "pending"), track("f", "failed")]),
    ["a", "t1", "t3"],
  );
  assert.deepEqual(cancellableJobIds([]), []);
});
