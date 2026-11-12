# Synced with upstream through #1828 (November 12, 2026)

Backup of the previous branch: `aurral-classical-backup-2026-11-12` (`b53b30f`). Fork `main` merged upstream lklynet/aurral through #1828 (`5a96ac5`); this branch then merged `main` (`e9093ce`). Upstream removed Lidarr mode and moved shared modules; classical keeps its revoked-grant permanent failure, local-file open check, acquisition identity, segment start and album presentation. Merge commit messages list each resolution. Node 26.12: `pnpm check` (0 type errors; unsafe-any 1139 = new baseline), 2,641 unit tests across 385 files (upstream deleted Lidarr-mode suites) and the frontend build pass. Not run: plugin repo suite against this core, Chromium editor/work-page checks, Compose restart/playback.

# Album presentation detail line

Based on `6b7389c7`, for plugin manifest 1.0.14. Album-presentation groups accept an optional `detail` string, rendered as a muted line under the work heading. The plugin uses it for blocks of several tracks that are not matched to a work. Additive: older plugins omit it, older cores drop it. The plugin-host test asserts it passes through. Required checks, 28 plugin-host tests and the frontend build pass; no real-browser pass.

# Work-row playback actions and full player titles

Based on companion core `f3cea93c`. Album work rows keep native metadata/playlist actions, but their Play, Play next, Add to queue and radio actions now use the selected plugin item and work source. A shared queue converter retains item identity, native track/album references, stream path, segment bounds and relative duration. Album rows and resource-page playback both show the full work-and-part title in the player. No core API, schema or classical matching rule changes.

The existing queue unit case covers native identity, full titles, duration and boundaries. The companion plugin's Chromium workflow checks the real row menus at desktop and phone widths; its disposable fixture adds bounded segments. Those checks failed with the old menu Play handler selecting the full native track. Validation: 57 focused queue/plugin tests, required checks (zero type errors, unchanged unsafe-any baseline), production frontend build, full editor/work-view Chromium workflow, restart persistence/media hashes and admin/two-user exact-file comparison smoke pass. The synthetic containers and their volumes were removed after validation; no live install was accessed.

The full core run passed all 2,762 assertions across 406 files, but exited nonzero because `app-backup.test.ts` exceeded its 10-second `afterAll` cleanup timeout. That unchanged file then passed all four tests, including cleanup, in a one-second isolated rerun. The full run's cleanup failure is not hidden or treated as a completely green full-suite run; backup code and test timeouts were not changed.

# Plugin host: a busy plugin is not turned off by one crash or a queued page call

November 12, 2026, at the user's request (the classical plugin turned itself off when the editor was open during a scan). Two generic host rules in `pluginHost.ts`: (1) a call that waited behind another call counts as _busy_ even if that call finished just before this one timed out; before, it was counted as broken and the process (and any work in it) was killed; (2) one process death fails all its waiting calls with one error that counts once, where three waiting calls used to turn the plugin off at once. A call that waits alone and times out still restarts the process; repeated crashes still turn a plugin off. Two regression tests in `.tests/plugins/plugins.test.ts` (both fail on the previous source). Node 26.12: 2,762 unit tests, `pnpm check` (0 type errors; unsafe-any 1236 = baseline). The plugin-side causes (scan checkpoints rewriting all evidence, finished scans never compacted) are fixed in the plugin.

# Post-Phase-4 long plugin-action menu correction

Album/track/artist/playlist menus now group multiple actions from the same plugin under one plugin-named submenu. This prevents Aurral Classical's growing album action list from extending below the viewport while retaining every independently capability-controlled action. Single-action plugins retain their existing direct menu item. The generic submenu already scrolls within the viewport and uses its existing desktop/mobile and keyboard behavior. Node 26.12/pnpm 12.15 checks and the frontend production build pass.

# Current checkpoint — Phase 4 complete for review

The user explicitly authorized Phase 4 on November 10, 2026 (America/Chicago). Generic album contributions, regular-user resource pages and bounded local queue segments are complete locally. Validation passed 2,757 core unit tests across 406 files, 52 focused Phase 4 tests, required checks, the production frontend build, real Chromium and disposable Compose restart/playback checks. See `PHASE_4_REPORT.md` and the central plugin report. Stop before later search/Discover scope.

# Current checkpoint — Phase 3

Final observed implementation CI is green: plugin source 84ea58d39362532f1f3551906e4fef01a7eda77b / pinned core 7ea6b2211f469d9c1342fee998fe82d2289232ff; runs 42934882603 and 42934882763 passed all six jobs, including four Node versions, isolated model/editor tests, core checks/build, Chromium, permissions, restart/media hashes and existing comparison playback. Later documentation-only commits record this outcome; no runtime change.

November 10, 2026 (America/Chicago). The user explicitly said “Lets begin phase 3” and “Continue with phase 3.” Phase 3 is complete for review. Phase 4 is not authorized.

The plugin now provides an admin manual editor over schema 1: provider-free composers/works/broadcasts, typed field edits/provenance/pins/unpin, canonical movement reordering, role credits, owned-track attach/detach, read-only media and stale-tab protection. Generic core admin-forms v1 adds only opt-in manifest pages, authenticated bounded transport and a host renderer/Settings entry. No classical core schema or new migration. See the central plugin PHASE_3_REPORT.md, EDITOR_GUIDE.md and UPSTREAM_DELTA.md.

Validation: 2,755 core unit tests (406 files); 23 focused core plugin tests; 168 plugin tests including 9 editor tests; required checks with zero type errors and unchanged 1,236 unsafe-any baseline; frontend/docs/plugin builds; real Chromium desktop/phone workflow, regular-user denial, provider/pin/blank/conflict and stale-tab handling; real Compose restart with unchanged read-only media and existing admin/two-user streaming. The report distinguishes broad-run source from later CSS/docs/test typing refinements and records remote CI separately.

Local paths remain /workspace/work/plugin and /workspace/work/aurral. Implemented on existing local classical branches atop plugin bf47025 and core d93cd812. Separate phase3-review source snapshots are used without moving remote classical/main or merging prior PRs. No new PR, merge, release, upstream activity or production access. Preservation branches are untouched. No subagents.

The editor requires the matching fork's admin-forms bridge; no stock editor fallback is claimed. Work pages, grouping, segment playback, entity merges and richer pages remain Phase 4/later. The fixture HTTP relay is test tooling only and does not proxy WebSockets. Do not claim production-library or real-library operational acceptance.

Historical checkpoints below retain their original observations; their authorization/completion wording is superseded by the current checkpoint.

# Current shared checkpoint — Phase 2

Final observed Phase 2 implementation CI: plugin run 42887705310 passed all five jobs on `eb997d521ccf1aad2d1f611b0fd5b62bcba6e8eb` (159 full-suite tests on each Node22.16/22/24/26 plus isolated model tests and bundle consistency). Source snapshots are in both user repositories on phase2-review; core snapshot bae8d4ba is documentation only. Later handoff/result commits do not change runtime source. No new PR or merge.

November 10, 2026. User request: “Phase one should be done. Verify then continue and build phase 2.” This authorizes Phase 2 and supersedes old pending-approval language below. Phase 3 is not authorized.

Phase 1 review source is in open, unmerged plugin PR6 and core PR36. Fresh clones initially had only Phase 0.5 on remote classical. Local existing `aurral-classical` branches were fast-forwarded to plugin `e1a980ad768af6c8d3e5122e85f05a6e68b3629b` and core `581e8b6ca32908652eecb673620ee6f1389a96b5` as the Phase 2 baseline. No remote refs or PRs were merged. Preserve those prerequisites when applying the Phase 2 patch.

Phase 2 implementation lives entirely in the plugin: native SQLite/WAL schema 1, typed catalogue/relationships, provenance/pins, conservative reconciliation, classification and tag guards, persistent fenced scan jobs, admin scan/status/cancel actions, maintenance CLI and operator documentation. Core runtime is unchanged. See central plugin MODEL_V1.md and PHASE_2_REPORT.md for executable APIs, exact checks and limitations.

The final model suite includes all committed synthetic fixtures, full rescans, provider-free broadcasts, reissues and multi-work ranges. No real-library snapshot or production server was used. The host still lacks an automatic database epoch: admin must update Library database epoch after replacing/restoring its database. Hashes guard reused IDs; ambiguous/retagged moves are held for review. No editor, work page, grouping, user picks or new player behavior is claimed.

Phase 1 verification caveat: core head checks and latest disposable integration passed. Plugin push CI at e1a980ad passed all Node versions, but PR run 42882247578 failed Node22 and cancelled its other jobs. Connected GitHub job logs subsequently identified ENOTEMPTY in background-writer test teardown; Phase 2 waits for completion before cleanup. A loaded Node26 run also exposed a dispatch-throttle race, now fixed with serialized rate-limited dispatch and a regression test. Fresh Phase 1 tests passed 138/138; final Phase 2 tests pass 159/159 on Node22/24/26, with 20 model tests on Node22.16 and in a no-network read-only-source container. Keep the original failed observations in the report.

Current checkout paths: /workspace/work/plugin and /workspace/work/aurral. Work is on local existing classical branches, not main. Phase 2 is saved as a separate phase2-review source snapshot; remote classical/main and existing Phase 1 PRs are not merged. No new PR, release or deployment was requested. The source branch and report are the review handoff. Keep main, upstream, preservation branches and existing review PRs untouched. No subagents were used. Stop for review before Phase 3.

Historical handoff follows; its authorization and completion statements are superseded by this checkpoint.

# Codex / Claude shared handoff — Phase 1

## Published review checkpoint

Final observed implementation CI: core run 42881762781 passed all jobs (required checks/docs, both unit shards, full integration suite and production-container build/smoke); core Perf passed. Plugin CI and disposable integration run 42881393448 passed. Later documentation-only commits may trigger repeat checks, but runtime source is unchanged. Phase 1 is complete for review; stop here and wait for Phase 2 approval.

Remote disposable Compose integration run 42881393448 completed successfully, including real HTTP comparison/playback for admin and two users and a repeat after restart. Plugin Node22/24/26 CI also passed. Core CI rerun 42881762781 follows the fork-workflow fixes; consult its live status. Authoritative fetched review worktrees: /workspace/work/phase1/review-core and /workspace/work/phase1/review-plugin.

Phase 1 implementation and local acceptance are complete. Both fork-only PRs are open and unmerged: core https://github.com/Collinlong1/aurral/pull/36 and plugin https://github.com/Collinlong1/Aurral-Classical-Plugin/pull/6. Both target aurral-classical from phase1-review. Core runtime source commit aecbb96625340cb3a1bd469787211cfe9bedcab5; plugin source commit 2f9beeb2608d41cb767664a3d378180e6b942136. Later commits record CI/workflow fixes and this handoff.

GitHub core unit/integration/Perf checks passed on the first publication. Core CI also exposed two inherited workflow issues: unsupported Dependency Review on this fork and uppercase OCI image tag. The review workflow now checks dependency changes before invoking the dependency API (no dependency changes in this PR) and lowercases the image name. No checks are made continue-on-error. Plugin Node22/24/26 CI passed; disposable integration run 42881393448 was running at this checkpoint. Consult live PR checks before merging; the final chat reports the observed final status. Never treat local green results as a claim that all remote jobs are green.

No further feature implementation is authorized until Phase2 approval. Finish only CI repairs for these PRs if needed. Do not merge, deploy, modify main or upstream. The historical recovery/state paragraphs below describe the development sequence and are superseded by this published checkpoint.

Updated November 10, 2026. User authorized completing Phase 1 and opening PRs **in Collinlong1's repos targeting aurral-classical**. Phase 2 is not authorized. Finish pending Phase 1 verification/publication recorded in PHASE_1_REPORT.md; then stop for review.

Read PHASE_1_REPORT.md, FORK_FEATURE_INVENTORY.md and (in the plugin repo) INTEGRATION_CONTRACT_v0.1.md and UPSTREAM_DELTA.md. PHASE_0_REPORT.md and PHASE_05_REPORT.md are historical audit records; their pending-approval statements do not describe current authorization.

## Current work

- Existing classical branches were used for implementation. Review snapshots go on phase1-review so the requested PRs can target the existing classical branches. Do not merge PRs automatically.
- Plugin: all owned explicit-work comparison, per-user playlist keys and queue completion, performer-first slskd, preview/clear/restore tags, verified atomic writes/backups, background writes off by default, synthetic fixtures and internal-network Compose.
- Generic core: action-scoped user-operation grants, complete library snapshot, local-only durable playlist operation with execution-time permission/expiry checks, consistent indexed paths on create/update/append, native Soulseek acquisition identity before source priority.
- No plugin data-model migrations or classical fields in core tables. Existing core jobs/settings persist operations; no new SQL schema.
- Fixtures exercise admin plus two regular users (no acquisition permission), exact owned streaming, no downloads, restart/idempotency, >25 recordings, cross-release copies, seven-value native tags, provider omissions and stock missing capability.
- Full structured schema/manual identities without explicit work evidence, editor, grouping, work pages and segment playback remain Phase 2–4.

## Source drift

Entry plugin classical: 393fbdb507324473ba861b577a9517d252332048; plugin main: 506e5259e1442b8cfe072a75b129abb428c6bcf7.
Entry core classical: 1a7f0081ef6b75ce4faa408dfae3a40572d1d359. Core locally merged frozen fork main c0deb211 via 30ba667d, then Phase 1 source a051bf3e.
During this phase, external merges advanced core main to 3739443a000defa9f246681e8a62233c1faef1c3 and core classical to 1b3c1c0074bd39df48bb115eca5254a07dde64b9, bringing upstream 021b1f03. These updates are preserved in a local merge. Do not reset remote refs. None of our writes target main or upstream.
The original fork still has 52 net changed paths (+3130/-181) against matching upstream 021b1f03, with 111 fork-only historical commits on live main. Sixteen preservation branches remain unchanged on 7afcb7cb. See PRESERVATION_BRANCHES.json.

## Validation and recovery

Read the Phase 1 report for final checks. Initial pre-drift full core run passed 2750 tests/406 files; subsequent source refinements and external drift require the recorded post-merge checks. Do not substitute the old audit's 2743-plus-timeout run. New plugin suite reached 138 passing tests; focused core grant/playlist tests and 40 Subsonic integration tests pass. The report records later results and limitations.

Core checkout /workspace/work/phase05/classical; plugin /workspace/work/phase05/plugin-repo. Logs /workspace/work/phase05/phase1-*.log. Node26.12 and pnpm12.15 under /workspace/work/phase05/tools/bin. Use workspace XDG directories; ASTRO_TELEMETRY_DISABLED=1. Independent node_modules per checkout; avoid heavy simultaneous builders.
Compose project aurral-classical-phase1 has only synthetic named volumes and an internal network. The daemon's published port was unavailable from the outer shell in this environment; docker compose exec runs the real HTTP/stream smoke inside the container. It passed for admin and two users, including after restart. No user server was accessed.

## Persistent boundaries

No main writes/merges, upstream edits/branches/PRs/comments, production credentials/server access or automatic deployments. No subagents without explicit user approval. Keep classical logic/storage in plugin and core hooks generic. No automatic PR merge. User approval is required before Phase 2. Update this shared handoff and report at each session boundary.
