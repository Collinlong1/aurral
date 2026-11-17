import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { parseFilters } from "../../backend/services/plugins/pluginLinks.ts";
import { readFilters, writeFilters } from "../../frontend/src/pages/PluginResourceView.tsx";

test("a plugin page's filters survive the URL both ways, whatever their values hold", () => {
  const filters = { composer: ["c1", "c2"], form: ["Theme, variations; fugue"], key: ["a=b"] };
  const written = writeFilters(filters);
  assert.equal(written.split(";").length, 3, "values never add separators");
  assert.deepEqual(parseFilters(written), filters);
  assert.deepEqual(readFilters(written), filters);
  // An empty filter is left out.
  assert.equal(writeFilters({ composer: [], period: ["baroque"] }), "period=baroque");
  assert.deepEqual(readFilters(null), {});
});
