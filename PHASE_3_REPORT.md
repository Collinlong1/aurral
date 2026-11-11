# Phase 3 — generic admin forms

The user authorized Phase 3. This fork adds D01's admin-forms v1 subset: optional manifest pages and individual capabilities, real-admin bounded read/mutate endpoints, a lazy host-rendered form page with draft/conflict handling, Settings links, types/docs and tests. No classical schema, title/provider logic or plugin storage is added to core.

Validation: core unit suite 406 files / 2,755 tests passed; focused plugin/permission suite 23 passed; required checks, zero type errors, unchanged unsafe-any baseline, frontend and documentation builds pass. Full browser/Compose checks use the companion plugin: creation, reordering, attachments, provenance/pins/blanks/conflicts, stale tabs, regular-user denial, phone layout, unchanged read-only media and restart persistence. Source details and limitations are in Collinlong1/Aurral-Classical-Plugin/PHASE_3_REPORT.md.

Later CSS/documentation/new-test response typing refinements were covered by focused checks/builds/browser testing; no repeated full-suite claim at every documentation commit. A companion CI workflow pins this core implementation source and records its actual outcome separately.

Developed on the existing local classical branch; phase3-review saves a separate snapshot. No main/upstream/preservation changes, new PR, merge, release, production server or deployment. No new SQL migration. Stop before Phase 4.

Final remote implementation validation: companion plugin runs 42934882603 and 42934882763 passed all six jobs on plugin 84ea58d39362532f1f3551906e4fef01a7eda77b with this core pinned at 7ea6b2211f469d9c1342fee998fe82d2289232ff. This includes actual Chromium, permissions, media preservation and restart/streaming checks. Later commits only record this result.
