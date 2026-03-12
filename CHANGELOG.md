# Changelog

All notable changes to this project will be documented in this file.

## 1.1.17

- Tightened post-final continuation handling so hidden `/stop-continuation` control rounds no longer leak extra visible assistant activity into the UI.
- Fixed snapshot-adjacent reload behavior for control-noise messages by filtering post-snapshot hidden-control assistants using their hidden user parent relationship instead of letting them attach to the previous visible turn.
- Improved stop/continuation noise suppression across reload paths so `Stopped.` / similar stop-confirmation replies do not reappear as visible finals after reload.
- Fixed a timing bug in the stop-continuation guard so the protection survives `finishTurn()` long enough to suppress the control round that arrives immediately after final acceptance.
- Added bash-tool file-path extraction for common write patterns, including `python Path(...).write_text(...)`, so bash-based file edits are recorded in touched files and final change lists more reliably.
- Updated Marketplace categories to improve extension discoverability.

## 1.1.13

- Improved Marketplace metadata for discoverability: added targeted search keywords for OpenCode, AI coding, code agents, and developer tooling.
- Updated extension listing copy with a more descriptive display name and clearer description focused on OpenCode CLI, subagents, code diff, change lists, and undo/restore.
- Refined README top section so Marketplace visitors can understand the core workflow and key features more quickly without relying on animated demos.

## 1.1.15

- Hardened undo/restore after reload: fixed stale active-segment state, corrected segment hydration, and aligned restore commit selection with the effective restore message set.
- Fixed merged segment behavior across active/invalid child segments so UI merge, restore boundaries, and invalid-child recovery stay consistent after nested undo operations.
- Changed snapshot persistence to keep only visible timeline messages plus change-list/segment state, and restored snapshot timelines strictly by saved snapshot message order/IDs.
- Filtered continuation control noise more aggressively: hidden `/stop-continuation` command wrappers and `continuation ... stopped` assistant replies no longer pollute live chat, snapshots, or reload results.
- Refined delayed-final and continuation guards so post-final control rounds are suppressed without hiding normal `OC_UI_AUTORESUME` follow-up assistant activity.
- Fixed cancel/send flow so a new prompt can be sent immediately after stopping a running turn, without getting blocked by stale in-flight state.

## 1.1.12

- Refined transient task UI: reduced oversized subagent/todo status circles, added a `Todo list` title, normalized its typography, and improved icon/text alignment for todo rows.
- Limited input-box `Tab` mode switching to the `plan` and `build` modes only, avoiding accidental cycling into unrelated modes during prompt entry.

## 1.1.11

- Reworked subagent support end-to-end: added session ownership tracking, prevented subagent sessions from hijacking the main session, filtered subagents out of the session list, and rendered dedicated subagent activity/status cards in the webview.
- Stabilized subagent completion and finalization flow: only authoritative final events can finish a subagent, completed cards now collapse cleanly to `Task done.`, and mode/model metadata is recovered reliably from SSE updates.
- Overhauled assistant streaming rendering: temporary assistant bubbles now refresh using the latest chunk instead of accumulating stale text, final assistant content no longer replays intermediate text, and turn dividers / transient states render more predictably.
- Hardened user-message filtering so injected system blocks such as analyze/search/BOULDER continuation directives and DCP protocol metadata are stripped from visible chat history while preserving real user prompts.
- Added and refined todo/question UX: todo updates are rendered as persistent transient cards with clearer status styling, and question cards now use markdown rendering with better overflow handling and more consistent button sizing.
- Improved code-diff and change-list behavior for multi-agent turns: added grouped diff gating, anchor-readiness retry, late-diff grace handling, better changelist hydration on reload/session switch, and markdown files in change lists now open via preview.
- Fixed replay/resync behavior for grouped activity: grouped resync plumbing is in place, main-agent final acceptance now waits for OMO Boulder continuation prompts in Atlas/Sisyphus/Hephaestus-style modes, and replayed write/edit/apply_patch tool completions can restore final change-list eligibility without re-triggering full side effects.
- Corrected undo/restore internals across multiple regressions: baseline/file-set drift was fixed, invalid segments survive merge/restore more safely, segment hydration/count display is more accurate, and changelist baselines align more closely with the actual turn base.
- Improved persistence and reload behavior: snapshots now better align with display-message flow, persisted change lists rehydrate correctly after reload, transient UI cards were cleaned up, and several glyph/encoding regressions in action icons were fixed.
- Fixed Windows internal-repo path normalization in undo/change tracking so drive-letter case differences no longer cause touched files to be filtered out before commit generation, and added targeted commit-trace diagnostics to speed up debugging when change-list generation fails.

## 1.1.9

- Fixed turn-state race when sends are blocked in-flight: `registerPendingUserLocal` no longer starts a new turn and no longer clears finalize waiters/timers for the active turn.
- Improved user message ID binding by prioritizing SSE `message.part.updated` user text acknowledgements (`part.messageID`) and binding `local-* -> msg_*` earlier and more reliably.
- Added synthetic user handling for auto-resume/compaction flows: non-manual user messages are marked hidden in session hydration and excluded from visible timeline rendering.
- Added GitHub Copilot speed label mapping for `Claude Sonnet 4.6` as `1x`.

## 1.1.8

- Added dynamic mode loading from `GET /agent` and now only shows agents where `mode=primary` and `hidden!=true`, with safe fallback to `plan/build` when agent discovery is unavailable.
- Updated mode initialization and persistence: invalid stored modes are auto-corrected to an available mode, and default selection now prefers `plan`.
- Improved header blocked-send UX: session title temporarily switches to `Waiting for previous response...` with warning color, then restores automatically when the turn is sendable again.
- Fixed a pending-indicator regression where blocked-send text (`Please wait while the previous response finishes.`) could still appear next to the header after the title-based waiting UX update.
- Fixed mode/variant dropdown item indentation by separating simple dropdown option styling from model-option styling.
- Refined model dropdown sizing: keep selected-model control width unchanged, while sizing only the model popup panel from measured content width (`name + two spaces + speed`, speed-aware) with a `320px` max cap.

## 1.1.7

- Security hotfix: removed hardcoded Google OAuth `client_id`/`client_secret` from source and switched Google quota token refresh to runtime-loaded credentials.
- Added memory-only runtime credential resolution for Antigravity quota: prefer `opencode-antigravity-auth/dist/src/constants.js`, then optional environment fallback; no extension-managed secret persistence.
- Kept OpenAI/Copilot quota auth flow unchanged (read from OpenCode runtime auth), and skip Antigravity quota safely when runtime constants are unavailable.

## 1.1.6

- Added resync stall auto-recovery for takeover mode: when no progress is detected for `>= 5` epochs and `>= 100s` (with tools complete and no interactive blocker), the client now sends a hidden rescue prompt (`[OC_UI_AUTORESUME v1]`) to continue the same user request.
- Added staged stall safety UX: after `3min` of no progress a non-timeline warning notice is shown, and if the same no-progress trigger happens again after the first auto-resume, the current turn is cancelled and a stuck card is shown with a one-click `Reload Window` action.
- Added webview/system bridging for stall events (`systemNotice`, `systemNoticeClear`, `stallCard`) plus hidden rendering of auto-resume synthetic user messages so timeline content stays user-focused.

## 1.1.5

- Fixed finalize binding race by reordering turn-finalization pipeline to commit turn file changes before export-based message ID binding, so `tmp -> commit -> finalMsgId` mapping is available when `finalizeBinding` runs.
- Added finalize-order diagnostics to verify runtime ordering (`commit-start/commit-done/upgrade-start/upgrade-done`) and simplify field debugging.
- Hardened undo completion flow for no-op/missing-commit cases by emitting an explicit undo ack payload (`revertedSegment` with `applied=false`) so pending undo state is cleared instead of timing out.
- Added structured undo failure reasons (`missing-startCommit`, `missing-headCommit`, conflict classes, etc.) from engine to bridge/UI and updated user-facing messaging to avoid false "Undo applied" responses.

## 1.1.3

- Optimized post-final ID reconciliation by using a lightweight recent-session export path first (`exportSessionRecent`) instead of always fetching full session history.
- Added automatic fallback to full export only when recent data is insufficient to safely resolve user/assistant bindings, preserving correctness while reducing average wait time.
- Added debug visibility for export resolution path selection (`EXT: export.resolve.path`) to make performance behavior and fallback decisions observable.
- Updated resync to use lightweight recent message fetch first (`/session/:id/message?limit=200`) and only fallback to full history when the prior observed anchor message is not found.
- Added per-session resync anchor tracking (`lastObservedMsgId`) from SSE/resync streams to validate recent-window continuity before deciding full fallback.
- Improved cold-start behavior: when no anchor exists yet, resync now accepts recent results directly and initializes anchor from the newest observed `msg_*`, avoiding unnecessary first-pass full fetches.
- Added resync fetch-path diagnostics (`EXT: resync.fetch.path`) with source/anchor hit counters for clearer performance and correctness tracing.

## 1.1.2

- Fixed cross-turn assistant overlay races by making tmp-key resolution turn-scoped (`localKey -> tmpKey`) instead of relying only on session-level tmp-key state.
- Added extension-side single-turn in-flight guarding to prevent overlapping sends in the same session while previous turn-finalization/upgrade cleanup is still running.
- Synced frontend send-button gating with backend turn-in-flight state via a new `turnInFlight` bridge event so button visuals and send behavior stay consistent.
- Updated blocked-send UX: disabled button now uses a clear gray style, and a system notice is shown while blocked (`Please wait while the previous response finishes.`), then cleared automatically when sending is available.

## 1.1.1

- Fixed a webview initialization regression where send-button scope mismatch could break UI startup and prevent sessions/models from rendering.
- Added send gating to block new prompts while a turn is still unresolved (`thinking`, pending assistant upgrade, or final-map binding in progress), reducing cross-turn overlay races.
- Added early final index delivery (`messageIndexMapDelta`) so webview can bind `tmp -> final msgId` sooner, while keeping existing post-`chatDone` full `messageIndexMap` reconciliation.
- Hardened final-bind cleanup paths so gate state is released on successful binding, cancellation, and session rehydrate/reset.

## 1.1.0

- Reworked resync takeover behavior for both final and non-final phases so SSE recovery can immediately abort stale resync runs and return to live streaming.
- Added per-session resync recovery mode/epoch guards to prevent stale resync replay from re-appending old content and to reduce duplicate final handling races.
- Updated rescue scheduling to a 20s SSE-driven timer model with immediate recovery on stream close/error/reconnect-fail, while preserving interactive blocker pause/resume behavior.
- Fixed final settle deadlock where rescue timer resets could cancel pending `sse-drain` checks, causing `finalizing` to loop indefinitely.
- Improved resync replay filtering for long tool chains by prioritizing user-parent and turn-time-window matching (and excluding compaction-summary messages), reducing cases where final replies were missed.

## 1.0.39

- Switched summary/final filtering to structured SSE metadata checks only: messages flagged with `summary: true`, `mode: "compaction"`, or `agent: "compaction"` are no longer eligible as turn finals.
- Ignored compaction-summary assistant messages entirely in chat event mapping so they do not render in UI, do not enter upgrade chains, and do not interfere with final settle.
- Added per-session tracking for ignored summary message IDs and dropped their subsequent `message.part.updated` payloads.
- Removed text-pattern summary fallback logic, relying exclusively on structured compaction/summary markers for final-gate decisions.

## 1.0.38

- Hardened turn-boundary state initialization by clearing inherited assistant/tmp linkage on each new turn to prevent stale carry-over across turns.
- Tightened final-meta emission so `assistantMessageMeta` for final candidates is only emitted when final acceptance checks pass (including parent-match constraints).
- Applied the same accepted-final gate to resync final-meta replay, reducing cross-turn assistant ID pollution in upgrade paths.

## 1.0.37

- Disabled non-essential resync triggers from `silence-window` and `session.status=idle` to reduce unnecessary cross-turn synchronization pressure.
- Removed the extra post-final `resyncForChatResolve()` call at the end of `chat()` to avoid redundant heavy fetches after final completion.
- Kept the primary settle strategy intact (`sse-drain` + pass2 + 10s non-final keepalive) while reducing opportunities for abort-prone overlap.

## 1.0.36

- Tuned request timeout policy to reduce false `AbortError` failures under heavy load.
- Added dedicated `prompt_async` timeout/retry settings (`60s` + abort retry with `90s` retry timeout) instead of using the default `/session/*` timeout.
- Adjusted `session.message` timeout/retry window to `20s` / `30s` and `session.info` to `10s` / `15s` with abort retry enabled.
- Kept post-settle idle-resync suppression and existing settle safeguards intact while improving request resilience.

## 1.0.35

- Reduced finalization latency by ensuring `sse-drain` / `sse-drain-pass2` settle checks do not block on synchronous resync.
- Kept final completion robust with two-stage settle (`sse-drain` + 1s pass2) and existing no-delta fallback behavior.
- Added idle-resync suppression after clean settle (`idle-post-settle-clean`) to avoid post-final empty resync runs.
- Preserved non-final recovery via existing silence/hard-timeout resync paths while minimizing unnecessary idle resync.
- Enforced diff visibility gating for write turns only; non-write turns now consistently skip code diff display.
- Improved change-list reliability by union-merging repeated file-list updates and stats to avoid omissions.
- Continued final dedupe guarantees so repeated SSE/resync accepts do not duplicate final UI completion.
- Kept `chatDone` assistant IDs and message-index reconciliation improvements for more reliable tmp-key upgrades.

## 1.0.32

- Prevented summary-style messages (Goal/Instructions/Discoveries/Accomplished/Remaining headings) from being accepted as final completions, avoiding premature turn completion.
- Expanded assistant text tracking to support summary detection and finalization filtering.
- Refined quota tooltip visuals: enlarged title icon, tightened row spacing, and aligned percentage column numerals.
- Fixed quota provider matching so Copilot Codex models no longer use OpenAI quota.
- Rendered free models as 100% quota rings (Copilot 0x models and OpenCode models with "free" in the name).
- Tightened final settle behavior to prioritize SSE-drain checks, add 1s pass-2 confirmation, and fall back to no-delta completion when SSE stays silent.
- Added duplicate-final guards so repeated SSE/resync accepts for the same final message are ignored.
- Included `assistantMsgId`/`lastAssistantMsgId` in `chatDone` messages to improve tmp-key to final-message reconciliation speed.
- Added a second post-upgrade `messageIndexMap` publish to reduce tmp-key upgrade races after turn completion.
- Enabled resync diff replay with per-turn text-hash dedupe in webview so recovery can show missing diffs without duplicate popups.
- Removed resync blocking from SSE-drain/pass2 settle checks so final completion can resolve quickly without waiting on slow resync requests.
- Added diff/toolPatch display gating to write turns only, preventing non-write turns from showing code diffs.
- Merged repeated change-list updates by unioning file paths and stats to avoid missing files during recovery updates.

## 1.0.31

- Tightened final message locking so `finalizing` only accepts `finish=stop` candidates whose `parentID` matches the current turn user message, preventing summary/compaction messages from hijacking settle.
- Consolidated finalize/rescue cleanup into a shared session cleanup path to reduce state drift between `startTurn` and `finishTurn`.
- Tuned rescue cadence for long-running tools: when tool status is `pending/running`, settle checks back off to 60s and trigger an immediate confirm when tools transition to terminal states.


## 1.0.30

- Reworked final-response settling to avoid hanging on `Finalizing the response...` when `resync` sees `finish=stop` before late SSE text arrives.
- Updated rescue confirmation flow to prefer SSE drain (`800ms` quiet window) and use `10s` interval resync checks with capped fallback to current text after max attempts.
- Added interactive-card blocking for settle/resync rescue: question and permission prompts now pause rescue checks until all pending cards are answered, then auto-resume.
- Fixed hydrated undo-segment rendering after reload by preventing placeholder rebuild from clearing `hiddenSet` and leaking folded messages into the main timeline.

## 1.0.29

- Updated chat completion to wait for completion-final assistant messages (excluding `tool-calls`) with unified SSE/resync acceptance and safe user-anchor backfill to avoid stuck tool-only states.
- Added rescue-mode resync watchdog with 10s silence threshold and progress-based reset so missing SSE tails still resolve and file changes are queued for commit.

## 1.0.28

- Fixed reverted-segment message count display to use currently available timeline messages instead of historical total IDs, eliminating misleading `total > visible` card counts.
- Stabilized undo-segment rendering by recalculating `memberMsgIds` from timeline ranges and normalizing hydrated IDs against current timeline presence.
- Added dual-set segment persistence support (`memberMsgIds` for UI rendering, `operationMsgIds` for restore/cleanup), so restore correctness is preserved without inflating folded UI counts.
- Updated restore requests to prefer `operationMsgIds` (with safe fallback), improving consistency between UI collapse display and backend restore scope.
- Improved undo/restore commit resolution by adding missing-commit fallback search in `GitUndoEngine` (`undo`: forward search from anchor candidates, `restore`: backward search from end candidates) to avoid false failures when target messages have no direct commit mapping.

## 1.0.27

- Updated permission-card actions to a single-row layout (`once / always / reject`) while keeping question-card options in their original vertical layout.
- Adjusted card visual styling with a green border accent and corrected question/permission action-class mapping regressions.

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
