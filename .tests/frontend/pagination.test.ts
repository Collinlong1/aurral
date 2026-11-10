import { test } from "vite-plus/test";
import assert from "node:assert/strict";

test("a new page size keeps the first item of the current page in view", async () => {
  const { pageSizeParams } = await import("../../frontend/src/pages/libraryViewQuery.ts");
  // Items 201–300 at 100 a page; at 25 a page item 201 is on page 9.
  assert.deepEqual(pageSizeParams(3, 100, 25), { size: 25, page: 9 });
  // Back to the default size drops both from the address.
  assert.deepEqual(pageSizeParams(2, 25, 100), { size: null, page: null });
  assert.deepEqual(pageSizeParams(5, 25, 50), { size: 50, page: 3 });
});
