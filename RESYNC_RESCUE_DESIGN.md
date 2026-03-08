# Draft: Resync Evaluation

## Requirements (confirmed)
- Evaluate the current resync mechanism in the codebase.
- Read `sse_resync.md`.
- Ask `metis` and `oracle` to review the current design and assess the newly attached proposal in `.opencode/attachments/ses_335a2ff59ffe6uPxwzeYvw3cEg/667ea0ea6d5d0388/resync.txt`.
- Deliver evaluation only; do not create a work plan yet.

## Technical Decisions
- Scope is analysis-only, read-only.
- Primary implementation focus is `src/OpenCodeClient.ts`, with `src/SidebarProvider.ts` as supporting context for subagent session handling.

## Research Findings
- `sse_resync.md` documents the current SSE/resync design as single-session centric for rescue triggering and replay.
- The attached proposal recommends splitting concerns: grouped activity for rescue/resync triggering, but keeping main-turn final acceptance strictly main-session only.
- Current code already has `subagentToParentSessionMap` and `getRelatedSessionIds(...)`, so grouped reasoning has an existing structural foothold.
- `src/OpenCodeClient.ts:901` already groups parent/subagent sessions for diff gating, but `src/OpenCodeClient.ts:4372` still updates SSE liveness and rescue reset per event session only.
- `src/OpenCodeClient.ts:1376` and `src/OpenCodeClient.ts:1446` show settle/rescue logic remains session-local today.
- `src/OpenCodeClient.ts:5484` replays one session at a time; subagent replay is not root-coordinated.
- `src/SidebarProvider.ts:3885` shows subagent `files` events currently trigger side effects, so replay-state restoration must distinguish live vs resync sources.

## Captured Resync Message Format
- Verified by direct local API reads against the running OpenCode server:
  - `GET /session/ses_335a2ff59ffe6uPxwzeYvw3cEg/message?limit=20`
  - `GET /session/ses_3355a5154ffesaHXz9Bh4ItXnP/message?limit=20`
  - `GET /session/ses_3355ad58affeKzoYea7qs6AosJ/message?limit=20`
- Authentication uses the same Basic auth built by `OpenCodeClient.buildAuthHeader(...)`, not raw SSE.
- Important: `/session/:id/message` is not a live SSE payload stream. It returns persisted message objects which the client later maps back into `ChatEvent`s during replay.

### Session Relationship Used For Capture
- Root/main session: `ses_335a2ff59ffe6uPxwzeYvw3cEg`
- Subagent session A: `ses_3355a5154ffesaHXz9Bh4ItXnP`
- Subagent session B: `ses_3355ad58affeKzoYea7qs6AosJ`

### Common Top-Level Shape
- All three sessions returned the same top-level structure:
  - `value: Array<{ info, parts }>`
  - `Count: number`
- Each message entry has:
  - `info`
  - `parts[]`

### Common `info` Fields Observed
- `info.id`
- `info.sessionID`
- `info.parentID`
- `info.role`
- `info.time.created`
- `info.time.completed` (present on completed messages)
- `info.finish`
- `info.mode`
- `info.agent`
- `info.modelID`
- `info.providerID`
- `info.tokens`
- Optional:
  - `info.summary`
  - `info.variant`

### Common `parts[]` Fields Observed
- Every part carries:
  - `type`
  - `id`
  - `sessionID`
  - `messageID`
- Part types observed across main/subagent sessions:
  - `step-start`
  - `reasoning`
  - `text`
  - `tool`
  - `step-finish`
  - `patch`

### `tool` Part Shape Observed
- `tool`
- `callID`
- `state.status`
- `state.input`
- `state.output`
- `title`
- `metadata`
- This confirms replay has enough data to reconstruct subagent UI state such as latest tool name, input summary, and completion status.

### Representative Main-Session Example
- Main message:
  - `info.sessionID = ses_335a2ff59ffe6uPxwzeYvw3cEg`
  - `info.parentID = msg_cca7589fc001kE5uYHSv2Gw897`
  - `info.finish = tool-calls`
  - `info.mode = Prometheus (Plan Builder)`
  - `parts` included:
    - `step-start`
    - `reasoning`
    - `tool` with `tool = task`, `state.status = completed`
    - `step-finish`
    - `patch`

### Representative Subagent-Session Examples
- Subagent A completed message:
  - `info.sessionID = ses_3355a5154ffesaHXz9Bh4ItXnP`
  - `info.parentID = msg_ccaa625ae001EczEXxBOIrjcvw`
  - `info.finish = stop`
  - `info.mode = compaction`
  - `info.agent = compaction`
  - `info.summary = true`
  - `parts` included:
    - `step-start`
    - `reasoning`
    - `text`
    - `step-finish`
    - `patch`
- Subagent B message:
  - `info.sessionID = ses_3355ad58affeKzoYea7qs6AosJ`
  - `info.parentID = msg_ccaa52a7a001DHaIlaWWep237W`
  - `info.finish = tool-calls`
  - `info.mode = explore`
  - `info.agent = explore`
  - `parts` included:
    - `step-start`
    - `tool` with `tool = read`, `state.status = completed`
    - additional `tool` parts
    - later messages also showed `text`, `reasoning`, `step-finish`, `patch`

### Important Semantic Difference
- The schema is effectively the same between main and subagent sessions.
- The real differences are semantic:
  - different `sessionID`
  - different per-session `parentID`
  - subagent streams may contain `summary=true` / `mode=compaction` messages that must be filtered from final acceptance
- Therefore the replay problem is not a payload-format mismatch. It is a session-scoping and filtering problem.

### Direct Implications For Implementation
- Root replay cannot reuse the main-session `currentTurnUserMsgId` filter for subagent messages.
- Replay must be per-session because `parentID` is session-local.
- `summary=true` / `mode=compaction` messages must be excluded from subagent final acceptance during replay.
- `tool` and `text` parts are available for subagent replay, so restoring subagent cards from resync is feasible without inventing a new parsing format.
- Because `tool`/`patch`/`files`-adjacent data exists in replay payloads, side-effect suppression remains mandatory for replayed subagent events.

## Agent Assessment Highlights
- **Metis**: Proposal direction is correct; strongest point is separating grouped liveness from main final acceptance. Biggest hidden risks are rescue suppression storms, epoch races across grouped replay, and duplicate side effects from replayed subagent `files` events.
- **Oracle**: Proposal is acceptable with caveats if grouped liveness is used for connection/activity sensing only, while root final/progress semantics stay root-owned. Replay must be restore-only and rolled out behind a fallback/flag.

## Deep Risk Analysis
- **Risk 1 - watchdog masked by unrelated activity**: main rescue logic currently resets from session-local SSE handling in `src/OpenCodeClient.ts:4372` and timer logic in `src/OpenCodeClient.ts:1446`. If grouped liveness is applied too broadly, subagent chatter can keep root rescue alive forever. Mitigation: separate `mainFinalLiveness` from `groupActivityLiveness`; grouped activity may suppress false disconnect assumptions, but watchdog expiry for main final still needs root-owned progress.
- **Risk 2 - premature resync exit**: `src/OpenCodeClient.ts:1324` flips a session from `resync` back to `sse` on broad session-event criteria. If extended to grouped behavior carelessly, subagent SSE can make the root leave resync before root state is fresh. Mitigation: require a root barrier or root-final progress proof before root leaves resync.
- **Risk 3 - grouped replay races**: `src/OpenCodeClient.ts:1293` and `src/OpenCodeClient.ts:5484` use per-session epoching and stale-drop checks. Group replay introduces multi-session interleaving risk. Mitigation: keep replay per-session, preserve monotonic epoch/ordering checks, and avoid global merged replay order.
- **Risk 4 - replay side effects**: `src/SidebarProvider.ts:3885` shows subagent `files` events trigger change queueing, restore locks, diff opening, and plan cards. Replay must be restore-only. Mitigation: carry `source='resync'` (or equivalent replay phase) through events and suppress imperative side effects in SidebarProvider.
- **Risk 5 - duplicate parent change tracking**: `src/OpenCodeClient.ts:2418` mirrors subagent changes to parent while `src/OpenCodeClient.ts:2431` and `src/SidebarProvider.ts:3887` provide another ingestion path. Replay can duplicate parent pending changes. Mitigation: choose one canonical ingestion path and/or suppress mirror/queue behavior for replayed subagent file events.

## Latest Direction
- User requested a full solution/spec proposal, not a plan file.
- Metis recommends a coherent scheme centered on: grouped liveness for rescue decisions, root-owned final correctness, per-session replay under root coordination, replay as restore-only for subagent file/UI state, and canonical parent change ingestion to avoid duplication.

## Additional Implementation Constraints

### 1. Grouped Liveness Must Be Narrowly Defined
- Grouped liveness is only for deciding whether rescue/resync should trigger or continue.
- It must not be treated as proof that the root session is making finalization progress.
- Count as grouped activity only when the related session produces evidence of real forward motion, such as:
  - assistant `text` part progress
  - assistant `tool` progress/completion
  - assistant final/meta acceptance candidate
  - optionally `session.diff` if it is already part of the active-turn write path
- Do not count low-signal noise such as generic `session.status` chatter.
- Use a bounded freshness window. The same rescue delay window already used by watchdog logic is the safest default.

### 2. Root Exit From `resync -> sse` Must Stay Root-Owned
- Grouped activity can prevent false rescue triggers.
- Grouped activity must not, by itself, move the root session from `resync` back to `sse`.
- Root may leave `resync` only when there is root-owned evidence, for example:
  - root session receives fresh SSE for the root finalizing assistant message
  - root final text grows
  - root final meta/final acceptance evidence arrives
- Subagent SSE may prove the turn is still alive, but it must not prove that root state is fresh enough to abandon resync recovery.

### 3. Replay Side-Effect Firewall Must Be Explicit
- Replay must restore state, not re-run imperative UI or parent-ingestion behavior.
- For `source='resync'`, allow only state restoration such as:
  - subagent `latestText`
  - subagent `latestTool`
  - subagent `latestToolInput`
  - subagent final/done state
- For `source='resync'`, explicitly suppress:
  - `queueSubagentChanges(...)`
  - auto-opening code diff
  - change-list ingestion
  - restore-lock / segment-lock side effects
  - plan-card / prompt-card / other imperative UI side effects
- This suppression rule must be documented as a hard implementation boundary, not a best-effort guideline.

### 4. Subagent Replay Filter Must Be Session-Local
- Main-session replay rules cannot be reused verbatim for subagent sessions.
- Subagent replay acceptance must be based on the subagent session's own anchor and its own message stream.
- Required filtering rules:
  - assistant messages only
  - exclude `summary=true`
  - exclude `mode=compaction`
  - prefer matching the subagent session's own `currentTurnUserMsgIdBySession`
  - if no current-turn anchor exists, fall back to `pendingUserMsgIdBySession`
  - only if both anchors are missing, use a conservative time-window fallback
- This ensures replayed subagent status is scoped to the correct turn and does not pull stale historical messages back into the UI.

### 5. Observability Requirements
- The implementation should emit dedicated debug markers so grouped rescue behavior can be verified without guesswork.
- Recommended log points:
  - `resync.group.activity`
  - `resync.group.fetch`
  - `resync.subagent.replay.accept`
  - `resync.subagent.replay.skip`
  - `resync.subagent.sideeffect.suppressed`
  - `resync.root.recover.blocked`
- Each marker should include at least:
  - `rootSessionId`
  - `targetSessionId`
  - `reason`
  - whether the event came from `sse` or `resync`

## Open Questions
- None blocking for evaluation.

## Scope Boundaries
- INCLUDE: current mechanism review, proposal assessment, risks, correctness analysis, migration/operational considerations.
- EXCLUDE: implementation work, edits outside this draft, formal work plan generation.
