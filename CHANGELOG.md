# Changelog

All notable changes to this project will be documented in this file.

## 1.0.26

- Added structured permission handling pipeline: mapped `permission.asked` / `permission.replied` SSE events to chat events and forwarded them to webview overlays.
- Implemented interactive permission modal in webview (same visual style as question cards) with `once` / `always` / `reject` actions.
- Added backend permission response support in client/provider: prefer `POST /session/{sessionID}/permissions/{permissionID}`, with fallback to `/permission/{requestID}/reply`.
- Added permission overlay close/ack/fail flow and session-switch cleanup to prevent stuck permission state.
- Updated question option button sizing to be content-driven by longest option while capping visual width to 95% of the card.

## 1.0.25

- Hardened Git repo locking after crashes/restarts by adding stale-lock auto-reap in `GitLock` (instead of timing out on leftover `.lock` files).
- Added lock ownership metadata (`pid`, `hostname`, `acquiredAt`, `repoId`) and owner-aware stale checks to safely reclaim dead-process locks.
- Improved lock timeout diagnostics with `repoId`, retry attempts, lock age, and owner PID in error messages.
- Added lock reaping debug logs (`repoLock.reap` / `repoLock.reap.fail`) to make lock recovery behavior observable.
- Refined session-history delete row UI behavior and sizing polish (larger `x`, compact inline actions, title visibility fixes) while keeping click-to-select behavior intact.

## 1.0.22

- Increased agent non-response notice delay from 30s to 60s to reduce false timeout warnings on long-running turns.
- Fixed question-card recovery after SSE gaps by allowing `resync` replay to emit `questionOverlay` events (with existing dedupe protection).
- Added session deletion support in history: UI now sends `deleteSession`, backend calls `DELETE /session/{id}`, treats `404` as already deleted, and refreshes the list.
- Added workspace-scoped delete cleanup for local artifacts: session snapshots, persisted reverted segments, undo-segment cache, attachments, and `.opencode/git/sessions/<sessionId>`.
- Added Git repo-map cleanup on session delete by updating `.opencode/git/index.json` and removing orphaned internal repos only when no `sessionToRepo`/`turnToRepo` references remain.
- Redesigned history-item delete UX to an inline right action rail with hover `x`, then in-row `delete/cancel` confirm state; kept row click for session selection.
- Tuned delete control visuals for readability: two-line title clamp, non-hover hidden divider, compact vertical confirm actions, and larger `x` icon.

## 1.0.21

- Implemented two-stage session loading: render local snapshot first, then fetch recent server messages (`limit=200`) and merge by message ID.
- Added stale-request protection for session switching with a selection epoch, so late async results from old sessions are dropped safely.
- Added phased session payload markers (`phase: snapshot | recent | full`) and richer timing/debug logs for snapshot/recent/full load paths.
- Added `exportSessionRecent(sessionId, limit)` and enabled query-string aware message endpoint matching for timeout/retry policies.
- Optimized session formatting by validating message ID/final assistant eligibility before expensive text concatenation.

## 1.0.20

- Added “Send to OpenCode UI” context menu actions for editor selections and output (clipboard) selections with tokenized input references.
- Introduced an always-visible server status dot beside the session title, updated by SSE/health signals with hover status text.
- Added SSE failure detection with health check, limited resync fallback, and auto-restart attempts to recover from event stream outages.

## 1.0.19

- Implemented limited resync replay scoped to the current turn, including assistant final + tool/patch change recovery without full-history storms.
- Added current-turn anchor tracking, SSE activity timestamps, and silence-window fallback to compensate for missing SSE tail events.

## 1.0.18

- Added resync single-flight + cooldown, final-meta dedupe, and resync replay counters to stop session replay storms.
- Hardened UI streaming updates against historical message replays and added render/linkify caching to reduce repeated full renders.


## 1.0.17

- Implemented two-phase webview initialization in `SidebarProvider` so `init` (models/variant/mode) is posted before session export/snapshot loading.
- Added an `initPosted` guard to ensure `init` is emitted exactly once per activation and removed the duplicate end-of-init post that could reset UI state.
- Prevented session export failures from blocking model UI availability; model/variant selectors now remain usable even when session export falls back or fails.
- Improved snapshot diagnostics by logging `SNAP_LOAD_HIT` on successful fallback and `SNAP_LOAD_MISS` only on actual misses.


## 1.0.15

- Refined Change List delta rendering for visual symmetry.
- Rebuilt `+x | -y` as a fixed 3-column CSS grid (`plus | minus`) so spacing is controlled by layout, not whitespace.
- Separator now renders as a pure `|` character with centered alignment and tunable width via `--change-sep-width`.
- Added dedicated delta columns (`--delta-col-width`) for stable alignment across different number widths and zoom levels.
