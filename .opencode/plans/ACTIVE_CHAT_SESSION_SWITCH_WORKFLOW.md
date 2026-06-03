# Active Chat Session Switching Workflow Plan

> **For agentic workers:** This is a high-risk UI/workflow isolation plan. Execute only one verifiable slice at a time. After each slice, run the listed validation, inspect the actual diff, and use `code-reviewer` in `wave-diff review mode` before proceeding to the next dependent slice.

**Goal:** Allow users to switch sessions while a chat turn is active without cross-session UI/state pollution, lost timelines, wrong finalize binding, or git/snapshot/change-list ownership regressions.

**Architecture:** Separate event write ownership from active UI rendering. Every async event, finalization step, snapshot, change-list, undo/restore operation, append flow, and subagent update must carry a proven target session and, where needed, turn identity. `activeSessionId` / `currentSessionId` may select the visible UI or serve as command-ingress fallback only before an operation starts; they are not ownership proof after async boundaries.

**Primary Files:**
- `media/main.js`
- `src/SidebarProvider.ts`
- `src/OpenCodeClient.ts`
- `src/undo/ownershipResolver.ts` if undo/change-list ownership requires it

**Reference Plan:** `.opencode/plans/SESSION_ISOLATION_FIX.md`

---

## Core Invariants

- **Write path:** events mutate only the session identified by the event/session owner.
- **Render path:** only the active UI session may update the main DOM, scroll position, send/stop button, overlays, and active diff surface.
- **Command ingress:** user commands may default to the current active session only before an async operation starts and only when no explicit session payload exists.
- **Async ownership:** after a send/append/undo/restore/subagent operation starts, captured owner identity must flow through awaits; never re-read `currentSessionId` or `activeSessionId` as ownership proof.
- **Fallback:** missing `sessionId` defaults to drop. Single-in-flight fallback is allowed only for an explicit whitelist of legacy streaming events after tests prove the event is safe.
- **Turn identity:** turn-owned side effects must bind to `{ sessionId, turnEpoch/status, userMessageId, assistantMessageId? }` or a documented durable backend proof.
- **Snapshot safety:** do not persist snapshots with unresolved `local-*` / `tmp:*`, missing final assistant bind, ambiguous turn epoch, or DOM data from another active session.
- **Append compatibility:** append UI messages may have child user IDs, but git/change-list ownership remains anchored to the append root/continuation owner unless a future migration explicitly changes this.
- **Subagent semantics:** keep `agentSessionId` and `parentSessionId` distinct. Parent-visible status/progress/todos/pulse belongs to the parent session UI; agent-lane message/final content belongs to the agent session lane unless explicitly promoted by existing product semantics.

## Targeted Logs

Keep logs stable and grep-friendly:

- `[EXT][SESSION_ROUTE]` / `[EXT][SESSION_ROUTE_DROP]`
- `[EXT][TURN_BIND]`
- `[EXT][SNAPSHOT_ROUTE]`
- `[EXT][SUBAGENT_ROUTE]`
- `[EXT][SSE_SESSION_ROUTE]`
- `[WV][SESSION_ROUTE]` / `[WV][SESSION_ROUTE_DROP]`
- `[WV][BACKGROUND_STATE_UPDATE]`
- `[WV][HYDRATE_PRESERVE_VOLATILE]`
- `[WV][ASSIST_UPGRADE_SESSION]`
- `[WV][SNAPSHOT_ROUTE]`
- `[WV][TURN_BIND]`

## Slice 0 - Audit And Event Ownership Matrix

**Status:** Completed with blockers. See sibling audit note: `.opencode/plans/ACTIVE_CHAT_SESSION_SWITCH_WORKFLOW_SLICE0_AUDIT.md`.

**Goal:** Produce a concrete map of event/command ownership before editing behavior.

**Implementation lessons for this slice:**
- Treat `OpenCodeClient` as ownership-bearing, not just a transport helper; it can still re-label lane/session identity during recovery and emission.
- Audit every async boundary where ownership is captured or re-read. Missing owner on a workflow-critical path is a drop until proven safe.
- Include duplicate `diffChunk` and `messageAppend` cases in the audit; both copies are live surface until proven otherwise.
- `toolResult` and `permissionResult` are reply-bound to a call/prompt, not generic safe fallbacks.

**Scope:** Read-only.

**Files in scope:**
- `media/main.js`
- `src/SidebarProvider.ts`
- `src/OpenCodeClient.ts`
- relevant undo/change-list files only if referenced by the audit

**Tasks:**
- [x] S0.T1 List each incoming webview message handler and classify it as user command, extension event, SSE-derived event, hydration, overlay, snapshot, undo/restore, append, subagent, or global UI.
- [x] S0.T2 For each handler, record owner fields used today (`sessionId`, `sessionID`, `event.sessionId`, `currentSessionId`, `activeSessionId`, parent/agent IDs).
- [x] S0.T3 Identify every async boundary where ownership is captured or re-read.
- [x] S0.T4 Identify all current render calls after non-active-session mutations.
- [x] S0.T5 Identify all global state that can affect the active UI while a background session is active, especially `isBusy`, snapshot flags, overlays, conflict state, and subagent terminal/clear paths.
- [x] S0.T6 Write the matrix into this plan or a sibling note before implementation begins.

**Validation:**
- [x] S0.V1 Matrix includes `sendMessage`, `appendMessage`, `chatChunk`, `assistantMessageMeta`, `messageAppend`, `messageIndexMap`, `userMessageUpgrade`, `chatDone`, `turnFinalizePhase`, `sessionData`, `snapshotTimelineIds`, `diffChunk`, `diffFileList`, `changeListUpdate`, `permissionPrompt`, `todoUpdate`, subagent status/delta/pulse, undo/restore/conflict paths.
- [x] S0.V2 Matrix explicitly marks which paths are safe command-ingress fallbacks and which must require event payload session.

**Stop Conditions:**
- Missing ownership source for a workflow-critical path requires a plan amendment before implementation.

### Slice 0 Addendum

The following clarifications were requested in review and should be treated as part of the audit baseline before Slice 1.

#### Duplicate case coverage

- `media/main.js` contains duplicate `case` blocks for `diffChunk` and `messageAppend`.
- `diffChunk` appears at both `case 'diffChunk'` around the `8368` range and again near the `8549` range.
- `messageAppend` appears at both `case 'messageAppend'` around the `8469` range and again near the `8566` range.
- Audit conclusion: both copies must be treated as live ownership surface until proven otherwise. Any later implementation must update both reachable branches or explicitly delete the dead/duplicated branch after proving it is unreachable.

#### Narrowed fallback classification

- Safe command-ingress fallback should be limited to explicit UI actions that start an operation and capture owner immediately: `sendMessage`, `cancel`, `restoreAll`, `restoreSegment`, `openGitDiff`.
- `toolResult` and `permissionResult` should not be treated as generic safe fallback. They are replies to a specific prompt/call and should be audited as explicit reply-bound operations keyed by `sessionId` plus `callId`/`permissionId`.
- After async boundaries, all commit/upgrade/diff/finish/error-cleanup steps must use the owner captured at ingress. They must not re-read `this.currentSessionId` or `activeSessionId` as ownership proof.

#### OpenCodeClient ownership risks to include

- `src/OpenCodeClient.ts` has resync/restart paths that still depend on `currentSessionId` for ownership recovery, including event-stream fail/restart handling.
- `classifyEventLane` still uses `currentSessionId` to decide whether an event is on the main lane.
- Several event payload paths still fall back to `payload.sessionId || this.currentSessionId`, which makes active-session fallback part of the ownership model unless explicitly replaced.
- Audit conclusion: `OpenCodeClient` must be treated as an ownership-bearing source of truth, not just a transport helper, because it can still re-label lane/session identity during recovery and event emission.

## Slice 1 - Extension Send/Finalize Owner Capture

**Status:** Completed. Code-reviewer wave-diff verdict: `STATUS: REVIEW_COMPLETE`. S1.V3 was manually validated from attached `OpenCode-UI-Debug.log`; owner-bound extension/webview events remained on the captured target session while another session was selected. A separate UI auto-switch/hydration issue was observed and is tracked under Slice 4.

**Goal:** A turn started in session A continues to finalize, commit, upgrade, diff, and finish under A even if the user switches to B.

**Implementation lessons for this slice:**
- Capture `targetSessionId` once after selection/creation and before async work starts.
- After capture, never re-read `currentSessionId` for success-path ownership.
- The finalize chain must stay under the captured owner through `chatDone`, commit, upgrade, diff, finalize, and error cleanup.
- Keep `currentSessionId` only for visible selection or pre-send command fallback.

**Files in scope:**
- `src/SidebarProvider.ts`
- `src/OpenCodeClient.ts` only for narrowly required explicit session APIs

**Out of scope:**
- Webview render gating
- Snapshot eligibility rewrite
- Undo/restore migration

**Tasks:**
- [x] S1.T0 Prerequisite from Slice 0 blocker: replace or drop legacy `handleChatEvent` `diff` and `permission` bridge ownership paths that label events with `this.currentSessionId`; event-owned session proof is required before implementation proceeds.
- [x] S1.T1 In `sendMessage`, capture `targetSessionId` once after session creation/selection and before async work starts.
- [x] S1.T2 Capture initial turn identity: target session, client user message ID, optional turn epoch/current-lifetime marker, tmp assistant key.
- [x] S1.T3 Replace success-path ownership uses of `this.currentSessionId` after capture with `targetSessionId` for chat, idle wait, assistant final lookup, `chatDone`, `commitPendingTurnChanges`, `resolvePendingUserUpgrade`, `emitDiffFileListWithRetry`, `finishTurn`, `turnInFlight`, `turnFinalizePhase`, pending maps, and build-mode segment persistence.
- [x] S1.T4 Keep `currentSessionId` only for visible session selection or pre-send command fallback.
- [x] S1.T5 Add `[EXT][SESSION_ROUTE]` and `[EXT][TURN_BIND]` logs around send start, stream done, commit, upgrade, diff list, finalize, and error path.
- [x] S1.T6 Ensure send error path does not retarget to changed `currentSessionId` after the request has begun.

**Validation:**
- [x] S1.V1 Static grep: success finalization path does not use `this.currentSessionId` where `targetSessionId` is required.
- [x] S1.V2 Compile/type check passes.
- [x] S1.V3 Manual/log scenario: start A, switch B before finalize; final `chatDone`, `turnInFlight:false`, commit/upgrade/diff logs remain `targetSessionId=A`. Validated from `OpenCode-UI-Debug.log`: send capture and downstream `chatDone`, `turnInFlight:false`, commit/change-list/diff events remained on `ses_17ab27346ffeNBqm46aO24D3vW`; note that the UI also auto-switched back to the active chat session, which is tracked under Slice 4.

**Stop Conditions:**
- If `OpenCodeClient` APIs cannot be made session-explicit without broad refactor, stop and amend plan with a scoped wrapper strategy.

## Slice 2 - Active-Session Busy And Send Button Ownership

**Status:** Code complete; manual validation partially passed. Code-reviewer wave-diff verdict: `STATUS: REVIEW_COMPLETE`. S2.V2 passed from manual log validation; S2.V3 is blocked by Slice 4 hydration/selection volatility loss, not by send-button busy ownership.

**Goal:** Background active turns do not put the visible session's send button into stop/blocked state.

**Implementation lessons for this slice:**
- Visible busy state must be derived from the active session, not from any background turn.
- If the backend is truly single-flight, model it as a separate global-server block instead of overloading session busy.

**Files in scope:**
- `media/main.js`

**Out of scope:**
- Server/global concurrency limits unless discovered by validation
- Broad event routing refactor

**Tasks:**
- [x] S2.T1 Introduce `isSessionBusy(sessionId)` and `isActiveSessionBusy()`.
- [x] S2.T2 Update send button icon, `is-busy` class, click cancel/send decision, and send gate to use active session busy state.
- [x] S2.T3 Keep any true server-wide busy as a separately named concept if the backend cannot accept concurrent sends; do not reuse session busy for it.
- [x] S2.T4 Ensure session switch calls refresh send button state.

**Validation:**
- [x] S2.V1 `node --check media/main.js` passes.
- [x] S2.V2 Manual/log scenario: A busy, switch B; B button is send and can start B if backend supports it, or shows a clear global-server block if backend does not. Validated from `OpenCode-UI-Debug.log`: A=`ses_19e19bd79ffe74XCoFf0PZbSWS` was in flight, B=`ses_1900c8895ffeSE53Ey9I91vNM2` selected and rendered independently.
- [ ] S2.V3 Manual/log scenario: switch back A; A button is stop while A is in flight. Manual validation failed because switching back to A loaded an older snapshot/sessionData view (`messagesLen=196`, `SESSION_LOADED messages=198`) over the active-turn timeline (`timelineSize=200`). Track under Slice 4 before accepting this validation.

**Stop Conditions:**
- If backend is truly single-operation global, document a separate `serverBusy` UX rule before proceeding.

## Slice 3 - Webview Route Helper And Render Gating

**Status:** Code complete with repair; manual/harness validation pending. Code-reviewer wave-diff verdicts: initial `STATUS: REVIEW_COMPLETE`, repair `STATUS: REVIEW_COMPLETE`. S3.T1-S3.T8 accepted; S3.V2 passed by manual validation after repair; S3.V1 and S3.V3 remain open pending harness/manual validation after Slice 4.

**Goal:** Background session events mutate background state but do not redraw/scroll/overlay the active session.

**Implementation lessons for this slice:**
- Missing non-whitelisted session ownership should drop with `[WV][SESSION_ROUTE_DROP]`.
- Background mutations should update state without redrawing active DOM, scroll, overlays, or snapshot flags.
- If a helper is still routing by `currentSessionId`, treat it as a regression until fixed.
- Repair note: `sessionId` and `sessionData` messages must not implicitly change `activeSessionId` unless they match an explicit pending user selection or first bootstrap. Background `sessionData` may hydrate target state but must preserve the currently active visible session and render only via active-session gating.

**Files in scope:**
- `media/main.js`

**Out of scope:**
- Full snapshot refactor
- Undo/restore migration

**Tasks:**
- [x] S3.T1 Add `resolveEventSessionId(message, eventName, options)` returning `{ sessionId, source, isActive, shouldRender }` or `null`.
- [x] S3.T2 Default missing-session behavior is drop with `[WV][SESSION_ROUTE_DROP]`.
- [x] S3.T3 Add a small whitelist for single-in-flight fallback only if audit proves specific legacy streaming events need it.
- [x] S3.T4 Add `renderIfActive(sessionId, reason, options)` and use it for high-frequency events first: `assistantMessageMeta`, `chatChunk`, `chatDone`, `turnFinalizePhase`, `messageIndexMap`, `messageAppend`, `diffChunk`, `permissionPrompt`, `diffFileList`, `changeListUpdate`, `todoUpdate`.
- [x] S3.T5 Add `[WV][BACKGROUND_STATE_UPDATE]` logs for background mutations.
- [x] S3.T6 Ensure scroll-to-bottom only happens for the active target session.
- [x] S3.T7 Fix background assistant final binding blockers: `attemptAssistantUpgrade`, `replaceKeyEverywhere`, `messageIndexMap`, and `userMessageUpgrade` must operate on target session, not active session.
- [x] S3.T8 Patch interim snapshot hazard: background `finalize_done` must not arm a global active-DOM snapshot flag.

**Validation:**
- [ ] S3.V1 Tests or harness cover: payload session wins; missing non-whitelist drops; missing whitelist with one in-flight falls back; multiple in-flight drops.
- [x] S3.V2 Manual/log scenario: A streams while B active; A state changes, B DOM/timeline/scroll do not. User validated after repair that A background finalize leaves B active and does not pull UI back to A; debug log shows `[WV][SESSION_SELECTION_PRESERVE]` for A while B remains active.
- [ ] S3.V3 Manual/log scenario: A final assistant binding completes while B active; switching back A shows final assistant replacing tmp.

**Stop Conditions:**
- Duplicate switch cases or broad default fallback are blockers.

## Slice 4 - SessionData Hydration Versus Selection

**Status:** Code complete; manual validation pending. Code-reviewer wave-diff verdict: `STATUS: REVIEW_COMPLETE`. Implementation preserves target-session live/volatile state across `sessionData` hydration so switching back to a background-updated session does not regress to older snapshot/sessionData. Durable snapshot persistence remains Slice 5.

**Goal:** Loading/hydrating a session updates that session's historical state without implicitly stealing active selection or destroying volatile active-turn state.

**Implementation lessons for this slice:**
- `sessionData` should hydrate historical state first; selection is a separate explicit action.
- Hydration must preserve volatile active-turn data when the target session is still in-flight.
- Append/composer state is part of hydration, not a side effect of active-session switching.
- Slice 1 manual validation observed that selecting another session while a turn is active can still be followed by `resetUiState`/`sessionData` paths that make the webview appear to switch back to the active chat session; Slice 4 must separate hydration from selection and preserve the user's explicit visible selection.
- Slice 2 manual validation observed that switching back to an in-flight session can hydrate from an older snapshot/sessionData payload (`messagesLen=196`, `SESSION_LOADED messages=198`) even though the live volatile timeline had already reached `timelineSize=200`, causing the recent active-turn conversation to disappear from the visible session.
- Latest Slice 4 evidence showed A had live tail up to roughly `timelineSize=209`, but selecting A loaded snapshot-authoritative `sessionData` with `messagesLen=204` and rendered `timelineSize=206`; implementation must preserve the existing target-session live tail over stale historical payload.
- Code-reviewer noted a non-blocking caveat: the additive `messagesById` restore can preserve non-timeline backing messages. Renderer is timeline-driven, so this is acceptable for Slice 4 but should be watched in Slice 5 cleanup.

**Files in scope:**
- `media/main.js`
- `src/SidebarProvider.ts` only if payload flags are needed

**Tasks:**
- [x] S4.T1 Split sessionData handling into historical hydration plus explicit activation/render logic, using targeted volatile capture/restore helpers around hydration and existing selection gates.
- [x] S4.T2 Activate only on explicit selection payload or no active session initial bootstrap.
- [x] S4.T3 Preserve volatile fields during hydration when target session has active/in-flight/pending bind state.
- [x] S4.T4 Keep append composer draft/root/pending prompt state scoped to the target session.
- [x] S4.T5 Add `[WV][HYDRATE_PRESERVE_VOLATILE]` logs.

**Validation:**
- [ ] S4.V1 Background `sessionData` for A while B active does not switch active session to A.
- [ ] S4.V2 Hydrating active in-flight A does not remove thinking assistant, pending assistant upgrade, append draft, or busy state.
- [x] S4.V3 Switching back to A after background updates shows complete timeline. Manual validation passed; debug log shows old snapshot payload (`messagesLen=204`, render baseline `timelineSize=206`) followed by `[WV][HYDRATE_PRESERVE_VOLATILE]` preserving 7 IDs and fields, then `SESSION_LOADED messages=213` and render `timelineSize=213`.

## Slice 5 - Snapshot And Turn Identity Safety

**Status:** Completed. Change-list/git/commit-bind subset completed in earlier waves; undo ownership, undo segment range/order, restoreSegment/full-scope restore, and conflictDecision ownership completed and manually validated.

**Execution note:** User requested implementing Slice 5 together with the change-list/git commit/commit-bind subset of Slice 6. Keep Slice 6 undo/restore/conflict ownership for a later separate slice.

**Goal:** Snapshots are session-correct and turn-correct, including background finalize and reload ambiguity.

**Implementation lessons for this slice:**
- Background finalize should persist the display-ready state before the session is considered complete.
- Snapshot eligibility must reject unresolved temp IDs, missing final assistant bind, and ambiguous turn ownership.
- If `timelineMessageIds` exists, reload should respect it rather than re-deriving anchor positions from current visible state.
- Background finalize may complete extension-side file-change, git commit, commit bind, and change-list flows while the finalized session is not active; snapshot persistence must be session-owned and must not use the currently active DOM.

**Files in scope:**
- `media/main.js`
- `src/SidebarProvider.ts`
- `src/OpenCodeClient.ts` only if needed for turn identity proof

**Tasks:**
- [ ] S5.T1 Define current-lifetime turn identity fields and logs for send/append flows.
- [ ] S5.T2 Mark post-reload or ambiguous records as `unknown-after-reload`; do not synthesize turn ownership.
- [ ] S5.T3 Add snapshot eligibility checks for unresolved temp IDs, missing final assistant bind, pending `messageIndexMap`, and ambiguous turn pairings.
- [ ] S5.T4 Ensure background finalized sessions queue activation catch-up rather than emitting snapshots from the active DOM.
- [ ] S5.T5 Update `handleSnapshotTimelineIds()` to accept target-session payloads and reject wrong/ambiguous/unresolved payloads with `[EXT][SNAPSHOT_ROUTE]`.

**Validation:**
- [ ] S5.V1 A finalizes in background while B active; no B-DOM-derived snapshot is persisted for A.
- [ ] S5.V2 Switching back to A emits/persists catch-up snapshot only after A renders.
- [ ] S5.V3 Unresolved `local-*` / `tmp:*` blocks or defers snapshot.
- [ ] S5.V4 Reload ambiguity causes conservative defer/recovery, not guessed ownership.

## Slice 6 - Git Commit, Change List, Undo/Restore, And Conflict Ownership

**Status:** Completed. Wave plan and audit: `.opencode/plans/2026-06-03-slice7-append-isolation-wave.md` and `.opencode/plans/2026-06-03-slice7-wave0-audit.md`. Runtime retention, root-authoritative ingress, snapshot/hydrate metadata preservation, append presentation de-duplication, append status finalize normalization, root+latest-child authoritative diff union, commit-bind topology, and hot switch-back busy reset were implemented and verifier-accepted. Manual validation passed for append background finalize, reload/switch-back render, queued status clearing, change-list correctness, and undo without reload.

**Execution note:** Split this slice. The next implementation wave should include only change-list, git commit, and commit-bind ownership together with Slice 5. Undo/restore/conflict ownership remains deferred for a later implementation wave.

**Goal:** Side effects are scoped to the originating session and turn/operation, not the visible session.

**Implementation lessons for this slice:**
- Final authoritative change list comes from message details, not session-wide diff aggregation.
- Authoritative message detail source: `GET /session/:id/message/:messageID`, returning `{ info: Message, parts: Part[] }`.
- Final change list file set must use `info.summary.diffs` from the message detail response.
- Append flows must query both the root user message and the latest append user message, then use the union of both `info.summary.diffs` file sets.
- Git commit file set must use the same authoritative file set as change list: `info.summary.diffs` from message detail, or the root/latest-append union for append flows.
- Session-wide diff aggregation is no longer a primary source for final change-list ownership/file-set decisions.
- Append flows may need both root and append child message details before computing the final file set.
- `msgToCommit` and `msgToBaseCommit` are distinct: commit is the result, base is the pre-commit state.
- Undo/restore must keep `headCommit` and `currentBaseCommit` synchronized after recovery.
- New-file undo should delete, not restore content.
- Undo reverted-segment payloads must carry an explicit ordered `messageIds` range. WebView must prefer that range over reconstructing from local timeline indices, because local timeline order can diverge from extension canonical undo order.
- Undo reverted-segment UI membership may need the WebView-visible anchor-forward message order, because extension canonical undo `messageOrder` can omit or reorder messages that are visible before the clicked anchor. File undo side effects remain extension-owned; segment display membership uses the validated UI-visible range when supplied.
- Undo canonical `messageOrder` / `messageIndexById` must be session-scoped in the extension. A session switch must not leave the target session with empty or stale global order; `undoFromMessage` resolves by explicit target session first, then uses operation-scoped WebView visible order only as fallback.

**Files in scope:**
- `src/SidebarProvider.ts`
- `src/OpenCodeClient.ts`
- `src/undo/ownershipResolver.ts`
- `media/main.js` only for missing sender payloads

**Tasks:**
- [x] S6.C1 For final change-list/git metadata, fetch authoritative message details via `GET /session/:id/message/:messageID` and derive files from `info.summary.diffs`.
- [x] S6.C2 For append flows, fetch both root user message and latest append user message details and union both `info.summary.diffs` file sets.
- [x] S6.C3 Bind git commit/change-list/commit-bind side effects to originating `{ sessionId, turn identity, root/latest message identity }`, never active/current visible session; git commit and change-list must use the same authoritative file set.
- [x] S6.C4 Treat session-wide diff aggregation as fallback/debug evidence only, not the primary final file-list source.
- [x] S6.T1 Audit real ingress for `undoToMessage`, restore all, `restoreSegment`, and `conflictDecision`; do not assume nonexistent message types. `undoToMessage` ingress was verified from debug log with explicit `sessionId`, `operationId`, and `messageId`; production restore UI uses full-scope `restoreSegment` rather than a `restoreAll` sender; conflictDecision ingress was reviewed.
- [x] S6.T2 Add or verify explicit `sessionId` on webview senders for undo/restore/conflict commands. `undoToMessage`, production `restoreSegment`, and `conflictDecision` now carry explicit owner fields; `restoreAll` remains guarded legacy/API-only.
- [x] S6.T3 Capture operation owner session and message/turn identity at ingress. Implemented for `undoToMessage`: payload `sessionId`/`operationId`/`messageId` are required, captured once, and used through undo execution/responses.
- [x] S6.T4 Replace global/singleton conflict ownership with per-operation or clearly enforced single-global-conflict semantics. Current single pending conflict is retained but now carries immutable `sessionId`, `operationId`, `conflictId`, `kind`, and source metadata; decisions must match exactly before applying.
- [x] S6.T5 Ensure change-list updates bind to originating `{ sessionId, turnEpoch/status, userMessageId }` or durable backend proof. Change-list/git subset uses authoritative message detail `info.summary.diffs`; undo revertedSegment now carries explicit ordered `messageIds` for canonical undo range display.
- [x] S6.T6 Add route/drop logs for missing/ambiguous operation ownership. Implemented for `undoToMessage`, production `restoreSegment`, and `conflictDecision` with scoped route/drop/tx/error logs.
- [x] S6.T7 Use WebView-visible anchor-forward message order for undo reverted-segment display membership when provided, while keeping file undo side effects bound to the extension undo result.
- [x] S6.T8 Make undo message order/index session-scoped and hydrate/update it by target session; `undoFromMessage` uses explicit session cache first, WebView visible order fallback second, and fails with diagnostic logs if neither can prove the anchor.
- [x] S6.T9 Scope production restoreSegment/full-scope restore and conflictDecision by captured owner session/operation. Restore responses/errors include `sessionId`/`operationId`; mismatched conflict decisions drop without clearing pending conflict.

**Validation:**
- [x] S6.V1 Start undo/restore in A, switch B before completion; conflict cards, restored/reverted segment messages, persisted segment changes, and change-list reverted flags remain A-scoped. Undo and restore/conflict ownership fixes are code-reviewed, test-covered, and manually validated.
- [x] S6.V2 Change-list/git metadata produced by A cannot attach to B's latest user message after switching.
- [x] S6.V3 Concurrent or overlapping conflicts resolve by conflict/operation ID plus captured session, never by active/current session fallback.
- [x] S6.V4 Undo reverted segment uses explicit canonical `messageIds`; inverted WebView anchor/end timeline order no longer expands/infers the wrong range. Focused extension/webview tests and code-review passed; manual UI validation pending.
- [x] S6.V5 Undo reverted segment uses WebView-visible anchor-forward range when extension canonical order disagrees with visible timeline order. Focused tests and code-review passed; manual Session B validation pending.
- [x] S6.V6 Undo after session switch no longer depends on global/current message order. Focused tests cover A/B distinct order caches, UI fallback when target cache is missing, and clear failure when both sources are absent; manual A/B validation pending.
- [x] S6.V7 RestoreSegment/full-scope restore and conflictDecision ownership are scoped by explicit session/operation/conflict metadata. Focused tests and code-review passed; manual restore/conflict switching validation pending.

**Stop Conditions:**
- Missing session payload on a user command is acceptable only if command source is visibly active and captured before async work. Missing ownership on async continuation is a blocker.

## Slice 7 - Append Workflow Isolation

**Status:** Completed. Wave plan/audit: `.opencode/plans/2026-06-03-slice8-subagent-routing-wave.md` and `.opencode/plans/2026-06-03-slice8-wave0-audit.md`. Extension payload ownership, WebView parent-visible routing, agent-lane preservation, and parent-scoped terminal/clear behavior were implemented and verifier-accepted. Manual log validation from `OpenCode-UI-Debug.log` showed parent-visible routing and agent-lane state routing without active/current fallback pollution; conservative `unknown-session-parent` drops were observed and treated as designed drops, not route leakage.

**Goal:** Append remains compatible with session switching and root continuation ownership.

**Implementation lessons for this slice:**
- Append root ownership stays authoritative for git/change-list ownership.
- Append child user IDs are UI/evidence identity only; they must not steal ownership.
- The append relationship must survive session switching until snapshot persistence is complete.
- Normalize/hydrate logic must preserve `meta.appendedPrompts` and related root-child links.

**Files in scope:**
- `media/main.js`
- `src/SidebarProvider.ts`
- `src/OpenCodeClient.ts` only for append state ownership

**Tasks:**
- [x] S7.T1 Treat `appendMessage.sessionId`, `rootUserKey`, and `clientMessageId` as authoritative at ingress.
- [x] S7.T2 Replace append gates that depend on changed `currentSessionId` with captured target-session/root gates.
- [x] S7.T3 Preserve append child user ID as UI/evidence identity while keeping git/change-list owner anchored to append root continuation owner.
- [x] S7.T4 Preserve append composer drafts and pending prompts per session across hydration and switching.
- [x] S7.T5 Ensure append ack/final assistant/finalize update target session only.

**Validation:**
- [x] S7.V1 Submit append in A, switch B before ack/finalize; A receives append user/final/change-list state, B unchanged.
- [x] S7.V2 Append draft open in A survives switching to B and hydrating sessions.
- [x] S7.V3 Append-generated git/change-list metadata remains owned by A root owner, not B/latest user.

## Slice 8 - Subagent Routing And Parent Mapping

**Status:** Pending.

**Goal:** Subagent status/progress and agent-lane content are routed by authoritative parent/agent IDs, never by mutable current session.

**Implementation lessons for this slice:**
- Keep `agentSessionId` and `parentSessionId` distinct.
- Parent-visible status/progress/todos/pulse belongs to the parent session UI.
- Agent-lane message/final content belongs to the agent lane unless explicitly promoted by existing product semantics.
- Terminal/clear operations should scope by parent session; global clears are reserved for named shutdown paths.

**Files in scope:**
- `src/OpenCodeClient.ts`
- `src/SidebarProvider.ts`
- `media/main.js`

**Tasks:**
- [x] S8.T1 Audit `subagentToParentSessionMap`, stable pulse root mappings, lane classification, and parent association sources.
- [x] S8.T2 Ensure extension messages include both `parentSessionId` and `agentSessionId` plus `displayTarget` when ambiguous.
- [x] S8.T3 Scope subagent terminal/clear operations by parent session; reserve global clear only for named shutdown paths.
- [x] S8.T4 In webview, route parent-visible status/progress/todos/pulse to parent session state and render only when parent active.
- [x] S8.T5 Keep agent session message/final content in agent lane unless an explicit existing summary/promote path handles it.

**Validation:**
- [x] S8.V1 A active, B parent has subagent C update; B state changes, A DOM/send gate unchanged.
- [x] S8.V2 C emits diff/todo/progress while B background; switching to B shows expected parent UI/agent-lane state.
- [x] S8.V3 Parent B terminal/clear does not clear parent A/D subagents.

## Slice 9 - End-To-End Acceptance

**Status:** Pending.

**Goal:** Validate the complete workflow and remove/debug-gate noisy logs.

**Tasks:**
- [ ] S9.T1 Run compile/type checks.
- [ ] S9.T2 Run relevant tests.
- [ ] S9.T3 Manual: A active turn, switch B, B remains stable and can send/behave according to server concurrency rule.
- [ ] S9.T4 Manual: A background finalizes, switch back A, final assistant/timeline/change-list/snapshot are correct.
- [ ] S9.T5 Manual: missing-session non-whitelist drops; whitelist one-in-flight fallback logs clearly; multiple in-flight drops.
- [ ] S9.T6 Manual: sessionData hydration and switching preserve active/background timelines.
- [ ] S9.T7 Manual: undo/restore/change-list/git commit paths remain scoped during A/B switching.
- [ ] S9.T8 Manual: append paths remain scoped during A/B switching.
- [ ] S9.T9 Manual: subagent parent/agent display remains correct during A/B switching.
- [ ] S9.T10 Code-reviewer final verify mode confirms write path/render path separation and turn-level ownership integrity.

## Execution Order

Recommended order:

1. Slice 0 audit.
2. Slice 1 send/finalize owner capture.
3. Slice 2 active-session busy/send button.
4. Slice 3 route helper/render gating/background final binding.
5. Slice 4 hydration/selection split.
6. Slice 5 snapshot/turn identity.
7. Slice 6 undo/restore/change-list/git ownership.
8. Slice 7 append.
9. Slice 8 subagent.
10. Slice 9 end-to-end acceptance.

Do not start a later slice if the previous dependent slice has failing validation, unresolved ownership ambiguity, or unreviewed high-risk diff.
