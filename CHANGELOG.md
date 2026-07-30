# Changelog

All notable changes to this project will be documented in this file.

## 5.0.1

### Cross-session active turns and append

- Fixed active assistant content disappearing, reverting to an earlier temporary presentation, or attaching to the wrong bubble after switching between sessions.
- Stabilized append follow-up ownership and presentation so predecessor and successor assistant states remain separate, subagent progress stays on the correct bubble, and the final response is accepted without duplicate or stale assistant bubbles.
- Made final assistant text resolve by canonical message identity, preventing temporary text from being merged into or substituted for the final response.
- Improved active-turn hydration so genuine live updates take precedence over older backend history without persisting transient presentation markers into snapshots.

### Long-session reliability and interaction

- Reduced repeated rich-content reconciliation work during streaming to lower WebView rendering pressure and avoid unnecessary liveness warnings.
- Fixed background-completed sessions repeatedly forcing the chat to the bottom after users start scrolling upward.
- Preserved finalized turns when full session export is unavailable and retained valid snapshot history when session repair fails.
- Restored context-usage display after finalization and added on-hover quota refresh for the send button.

## 5.0.0

### Long-session performance and history

- Added TanStack-based virtualized chat rendering, keyed incremental reconciliation, bounded DOM budgets, and adaptive recovery to keep very long conversations responsive and substantially reduce WebView rendering pressure.
- Added local-history reveal controls and a floating jump-to-latest button, while preserving search navigation, scroll anchors, active streaming content, and session-switch positioning across virtualized ranges.
- Reworked reload recovery around snapshot-first continuity: saved UI state is restored in its exact timeline order, only messages newer than the snapshot are merged, and current turns continue to be persisted even when session export fails.
- Fixed long-session blank-window, gray-screen, rapid-scroll, hydration, change-list anchoring, nested segment ordering, and code-block copy regressions.

### Independent concurrent sessions

- Rebuilt cross-session runtime ownership so each session behaves like an independent single-session chat and can run, stream, finalize, cancel, search, append, undo, and restore without another session stealing its state or selection.
- Preserved active assistant turns and append chains across session switches, including atomic temporary-to-final assistant handoff without duplicate bubbles, stale presentation flashes, or misplaced follow-up output.
- Scoped busy state, composer drafts, attachments, overlays, conflicts, subagent activity, asynchronous responses, message identities, and background finalization to their owning sessions.

### Search, context, and media

- Reworked Smart Search to inspect complete session snapshots, improve descriptive-query recall and reranking, remain compatible with virtualized history, and avoid depending on model tool access.
- Added automatic editor context: the active file is attached visibly to the prompt, selected lines take priority, unsaved editor content is supported, context can be removed per prompt, and duplicate manual file references are suppressed.
- Prioritized the active file and other open editor tabs at the top of `@` workspace file suggestions.
- Added assistant image-reference previews for Markdown, full, relative, and abbreviated paths; successful references render as centered thumbnails and open the original image in the editor when clicked.

### UI and interaction improvements

- Added a theme-independent animated border for active assistant bubbles, including stable behavior across dark, light, and high-contrast themes and a reduced-motion fallback.
- Improved append/steering presentation, session-transition stability, expanded undo segments, nested segment rendering, image layout, and transition jitter.

### Architecture and reliability

- Modularized the extension host and WebView into dedicated transport, server lifecycle, history, search, composer, rendering, continuation, change-list, undo, session-runtime, and command-controller components.
- Added isolated feature, rendering, continuation, and undo bundles with deterministic build, size, source-map, and VSIX content-policy checks.
- Expanded regression coverage for virtualization, snapshot continuity, cross-session interleavings, active-turn finalization, append handoff, undo/restore, search, editor context, image previews, and module ownership boundaries.

## 3.0.3

- Fixed assistant text streaming/delta tracking by keying lengths per message part, avoiding dropped or incorrect chunks when multiple parts share a message.
- Hardened unresponsive WebView recovery with a generation-gated HTML reset followed, when needed, by feature-detected, active-turn-safe `Reload Webviews` escalation without automatically reloading the window.
- Made rescue delivery command-first and corrected acknowledgement, timeout, and undelivered-state accounting, including a late-ACK notification race.
- Reduced gray-screen render churn by treating background activity pulses that cannot change a visible indicator as no-ops.
- Coalesced and cached `resolveRepo` work with cross-manager index locking and content-fingerprint freshness checks to prevent extension-host resolution floods without serving stale repository state.

## 3.0.2

- Fixed WebView reload recovery during active turns by restoring metadata, history, live user/assistant bubbles, streaming/final reconciliation, and append controls without reposting destructive session data while the turn is fresh.
- Added guarded WebView liveness diagnostics and debug ack-drop commands to validate reload/rescue behavior.

## 3.0.0

- Hardened multi-session isolation so active/background session switches no longer steal selection, render ownership, or in-flight turn state from the intended session.
- Fixed active-turn append after session switches, including retained root binding, local/server root alias resolution, explicit-root propagation through the append send gate, and append-chain presentation so appended prompts stay under the correct root message.
- Improved subagent ownership routing so missing-parent subagent events no longer attach to the active session; subagent status, diffs, tools, and final output now stay scoped to the explicit or stable parent session.
- Stabilized background turn finalization for no-file-change turns by treating confirmed no-commit terminal states and already-bound message IDs as clean finalize outcomes instead of repeatedly reporting missing temporary bindings.
- Improved change-list, commit, undo, restore, and conflict ownership by keeping file ownership tied to authoritative message/session data and preventing unrelated session state from driving restore or commit decisions.
- Refined chat UI interactions, including cleaner send/stop button visuals, question panel layout, subagent text expansion, and safer append hydration during active turns.
- Added targeted regression coverage for append runtime isolation, subagent session ownership, and finalize-binding terminal behavior.

## 2.0.5

- Added current-session search controls with match highlighting, first-match auto-jump, and previous/next navigation.
- Added Smart semantic session search using a temporary model-backed ranking session, preferring free or `0x` models before falling back to the selected/default model.
- Added semantic-result message highlighting and a spinner while Smart search is running.

## 2.0.3

- Fixed active-turn append handling so appended user messages do not replace the root turn anchor during final matching.
- Moved active-turn append entry into the stable bottom input composer with append mode, draft preservation, and input-border pulse feedback.
- Improved append queue status so queued prompts remain sendable, use queued/received colors, and transition to received when the assistant starts processing appended prompts.
- Added a quote function to quote text in chat window.

## 2.0.1

- Improved user-message action visibility by sliding the user bubble left on hover/focus and showing append/undo controls in the newly exposed space to the right.

## 2.0.0

- Added live append/steering for active turns: while OpenCode is still processing, hover the active user message and click the `+` button to append a plain-text instruction to that same turn.
- Merged appended instructions into the original user message with dividers, while keeping a single final assistant response in the timeline.
- Kept append-compatible turn ownership, change-list, undo, restore, and snapshot behavior aligned with the existing final assistant message flow.

## 1.5.0

- Added `@` workspace file mentions in the chat input with searchable file suggestions, keyboard navigation, and removable file chips.
- Sent referenced workspace files through OpenCode file parts with workspace path validation, file URLs, and supported MIME detection for common source/text files.
- Unified removable input chips for file mentions and editor-selection context so users can remove selected context before sending.
- Improved Antigravity local development reload by using `npm.cmd run compile` for the debug prelaunch task on Windows.

## 1.3.6

- Added patch-only OpenCode diff support so diff rendering can handle patch payloads without requiring a full diff object.
- Filtered session visibility by workspace path to keep history scoped to the active workspace and reduce cross-workspace noise.
- Refreshed Copilot speed multipliers from the docs and added regression coverage for the mapping logic.

## 1.3.5

- Hardened continuation revive handling so background completion signals only bootstrap a revived turn when the revive gate and turn bootstrap both succeed.
- Prevented `turnInFlight` owner updates from overwriting an active temporary or local assistant key, which keeps turn ownership and send gating aligned.
- Preserved pending assistant tmp-key mappings until the correct upgrade path resolves them, reducing continuation and assistant binding drift.

## 1.3.3

- Added a cancel-time rollback confirmation for turns with pending local changes, so users can choose to roll back or keep work before cancel completes.
- Kept the rollback confirmation on a local-only question flow, avoiding any change to the server-side question handling path.
- Fixed the temporary final/tail ordering issue by normalizing the timeline after final acceptance and preserving the bound final assistant message.
- Refined subagent display by trimming redundant title suffixes and showing model/provider information more clearly.

## 1.3.2

- Added a cancel-time rollback confirmation for turns with pending local changes, giving users the choice to roll back or keep work before the revert step runs.
- Kept local question handling isolated from the server question flow so the new confirmation can reuse the existing overlay without changing backend behavior.

## 1.3.1

- Added continuation takeover handoff flow so revived sessions can transfer ownership cleanly across the main client, sidebar, diff provider, and undo engine.
- Added ownership-aware undo resolution to keep restore/undo behavior aligned with the active continuation owner and reduce cross-session ambiguity.
- Expanded continuation lifecycle coverage with new regression tests for revive, takeover resolution, current-owner routing, post-final watch handling, and end-to-end handoff behavior.
- Refined continuation revive invariants and stopped auto-sending the continuation stop control message, which reduces accidental extra control rounds.
- Added a cancel-draft restore fallback so restore operations can recover more reliably when the primary path is unavailable.
- Fixed cancel draft restore fallback, continuation pulse and changelist finalize flow, background subagent spinner styles, first-session subagent misclassification, OMO modes grouping, and error snapshot alignment with finalize flow.

## 1.1.20

- Added full compaction UX/state flow in header usage: compact trigger, running state feedback, and post-compaction usage refresh.
- Disabled the header `context usage` compact action while the current session is active/in-flight or otherwise not sendable, with explicit disabled styling and click guards.
- Improved usage capsule behavior and synchronization: refined hover/warning display logic and stabilized session usage updates in webview.
- Improved Windows OpenCode binary resolution by merging common PATH/env sources to reduce launch/path-detection failures.
- Finalized errored turns more reliably and skipped snapshot persistence on error-finalize paths to avoid saving inconsistent turn state.
- Reduced snapshot image bloat and added graceful degradation for missing attachments during snapshot load/export paths.
- Refined Copilot/OpenCode model speed-label mapping behavior to improve model list readability.

## 1.1.19

- Stabilized session reload with snapshot-first recovery: reload now restores snapshot timeline as the authoritative base and only appends truly newer messages from recent export.
- Fixed duplicate/noise message reappearance after reload by tightening append candidate rules (skip pre-snapshot items and unresolved local/tmp IDs).
- Fixed undo/restore segment ordering after reload/restart by honoring `meta.timelineMessageIds` slot order (`system:undo-seg:*`) and preventing placeholder re-location drift.
- Hardened segment/changelist anchoring so persisted records keep stable message anchors instead of being rebound to the latest assistant turn.
- Improved send initialization reliability around baseline/git-prep flow with clearer fallback behavior and fewer blocked-send deadlocks.
- Improved streaming UX: assistant temporary updates no longer force-scroll the chat when the user has manually scrolled up; auto-scroll resumes near the bottom.

## 1.1.18

- Stop processing SSE events for a session after finalization, preventing late meta events from creating post-final temporary assistant bubbles.

## 1.1.17

- Tightened post-final continuation handling so hidden `/stop-continuation` control rounds no longer leak extra visible assistant activity into the UI.
- Fixed snapshot-adjacent reload behavior for control-noise messages by filtering post-snapshot hidden-control assistants using their hidden user parent relationship instead of letting them attach to the previous visible turn.
- Improved stop/continuation noise suppression across reload paths so `Stopped.` / similar stop-confirmation replies do not reappear as visible finals after reload.
- Fixed a timing bug in the stop-continuation guard so the protection survives `finishTurn()` long enough to suppress the control round that arrives immediately after final acceptance.
- Added bash-tool file-path extraction for common write patterns, including `python Path(...).write_text(...)`, so bash-based file edits are recorded in touched files and final change lists more reliably.
- Updated Marketplace categories to improve extension discoverability.

## 1.1.15

- Hardened undo/restore after reload: fixed stale active-segment state, corrected segment hydration, and aligned restore commit selection with the effective restore message set.
- Fixed merged segment behavior across active/invalid child segments so UI merge, restore boundaries, and invalid-child recovery stay consistent after nested undo operations.
- Changed snapshot persistence to keep only visible timeline messages plus change-list/segment state, and restored snapshot timelines strictly by saved snapshot message order/IDs.
- Filtered continuation control noise more aggressively: hidden `/stop-continuation` command wrappers and `continuation ... stopped` assistant replies no longer pollute live chat, snapshots, or reload results.
- Refined delayed-final and continuation guards so post-final control rounds are suppressed without hiding normal `OC_UI_AUTORESUME` follow-up assistant activity.
- Fixed cancel/send flow so a new prompt can be sent immediately after stopping a running turn, without getting blocked by stale in-flight state.

## 1.1.13

- Improved Marketplace metadata for discoverability: added targeted search keywords for OpenCode, AI coding, code agents, and developer tooling.
- Updated extension listing copy with a more descriptive display name and clearer description focused on OpenCode CLI, subagents, code diff, change lists, and undo/restore.
- Refined README top section so Marketplace visitors can understand the core workflow and key features more quickly without relying on animated demos.

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

- Added "Send to OpenCode UI" context menu actions for editor selections and output (clipboard) selections with tokenized input references.
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
