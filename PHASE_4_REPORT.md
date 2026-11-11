# Phase 4 generic host integration

Post-Phase-4 correction: menus now group multiple actions from one plugin under a plugin-named submenu, preventing long capability lists from rendering actions below the viewport. This is a generic core presentation change; single-action plugins remain direct menu items.

Phase 4 was explicitly authorized on November 10, 2026 (America/Chicago). The fork adds three generic, independently capability-checked pieces for the plugin-owned classical experience:

1. `albumPresentation` lets an enabled plugin contribute bounded groups to a native library album. Core validates every response and verifies each album/track reference before adding a native stream URL. Missing, disabled, invalid, timed-out or crashing contributions leave the stock album page intact.
2. A manifest page declared with `admin:false` gets an authenticated real-user resource route and a host-rendered page. Admin forms remain admin-only. The host supplies the current user; mutations never accept a caller-supplied owner. The current bounded schema renders work-like catalogue resources while retaining generic transport/security boundaries.
3. Native queue entries accept optional segment start/end milliseconds. Local playback starts at the boundary, advances at the end, presents range-relative progress/seeking and persists the boundary. The existing remote queue protocol has no range field, so bounded entries are not handed off as full tracks.

Core contains no classical entities, SQLite changes, title parsing, grouping rules, work identity, favourites or picks. Disabling either plugin capability restores stock behavior. Existing plugins default to admin pages and no album contribution.

Validation: the full core unit suite passes **2,757 tests across 406 files**. Required formatting/lint/CSS/generated-type/type/unsafe-any checks pass with zero type errors and the unchanged 1,236 unsafe-any baseline; the production frontend build passes; focused plugin and audio/queue suites pass **52 tests**. Disposable Chromium/Compose exercises the real album/work UI, two users, restart persistence and existing playback regression checks through the companion plugin. See the central plugin `PHASE_4_REPORT.md` for end-to-end details and migration notes.

No production server, upstream branch, main branch, merge, deployment or release is involved. Stop after the Phase 4 review snapshot.
