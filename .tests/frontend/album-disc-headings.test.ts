import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { albumDiscHeadings } from "../../frontend/src/utils/albumDiscs.ts";

test("a one-disc album gets no headings, whatever releases its files came from", () => {
  assert.deepEqual(
    albumDiscHeadings(
      [
        { disc: 1, title: "Houdini (Adam Port mix)" },
        { disc: 1, title: "Houdini (Danny L Harle mix)" },
        { disc: 1, title: "Radical Optimism (extended versions)" },
        { disc: 1, title: "" },
        { disc: 0, title: "" },
      ],
      "Houdini",
    ),
    [null, null, null, null, null],
  );
});

test("a box set gets a heading per disc, named after its discs' own titles", () => {
  assert.deepEqual(
    albumDiscHeadings(
      [
        { disc: 1, title: "Mahler: Symphony 4" },
        { disc: 1, title: "" },
        { disc: 1, title: "Mahler: Symphony 4" },
        { disc: 2, title: "Rimsky-Korsakov: Antar" },
        { disc: 0, title: "" },
        { disc: 3, title: "Decca Sound" },
      ],
      "Decca Sound",
    ),
    ["Disc 1 · Mahler: Symphony 4", null, null, "Disc 2 · Rimsky-Korsakov: Antar", null, "Disc 3"],
  );
});

test("a disc whose files disagree on a title is named by its number alone", () => {
  assert.deepEqual(
    albumDiscHeadings(
      [
        { disc: 1, title: "Album" },
        { disc: 2, title: "Album (Deluxe)" },
        { disc: 2, title: "Album (Bonus)" },
      ],
      "Album",
    ),
    ["Disc 1", "Disc 2", null],
  );
});
