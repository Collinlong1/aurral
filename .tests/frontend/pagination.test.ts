import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { paginationPages, paginationRange } from "../../frontend/src/utils/pagination.ts";

test("the bar shows the ends and the pages beside the current one", () => {
  assert.deepEqual(paginationPages(2, 30), [1, 2, 3, "gap", 30]);
  assert.deepEqual(paginationPages(1, 30), [1, 2, 3, "gap", 30]);
  assert.deepEqual(paginationPages(15, 30), [1, "gap", 14, 15, 16, "gap", 30]);
  assert.deepEqual(paginationPages(30, 30), [1, "gap", 28, 29, 30]);
  assert.deepEqual(paginationPages(29, 30), [1, "gap", 28, 29, 30]);
});

test("a gap never hides a single page, and short lists show every page", () => {
  assert.deepEqual(paginationPages(4, 30), [1, 2, 3, 4, 5, "gap", 30]);
  assert.deepEqual(paginationPages(3, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(paginationPages(1, 2), [1, 2]);
  assert.deepEqual(paginationPages(1, 1), [1]);
  assert.deepEqual(paginationPages(9, 4), [1, 2, 3, 4]);
});

test("the range names the items a page shows", () => {
  assert.equal(paginationRange(2, 72, 2117), "73–144 of 2,117");
  assert.equal(paginationRange(30, 72, 2117), "2,089–2,117 of 2,117");
  assert.equal(paginationRange(1, 100, 0), "0 of 0");
});

test("a new page size keeps the first item of the current page in view", async () => {
  const { pageSizeParams } = await import("../../frontend/src/pages/libraryViewQuery.ts");
  // Items 201–300 at 100 a page; at 25 a page item 201 is on page 9.
  assert.deepEqual(pageSizeParams(3, 100, 25), { size: 25, page: 9 });
  // Back to the default size drops both from the address.
  assert.deepEqual(pageSizeParams(2, 25, 100), { size: null, page: null });
  assert.deepEqual(pageSizeParams(5, 25, 50), { size: 50, page: 3 });
});
