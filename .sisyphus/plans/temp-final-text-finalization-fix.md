# Stabilize Temp-to-Final Assistant Text Upgrade

## TL;DR

> **Quick Summary**: Fix stale/duplicated assistant text by hardening tmp-to-final ID upgrade targeting and stream-state transitions in webview/extension event flow.
>
> **Deliverables**:
> - Deterministic tmp-to-final upgrade behavior for assistant messages
> - No stale temporary text preserved in final assistant message
> - Verified event-order resilience for `assistantMessageMeta`, `chatDone`, and `userMessageUpgrade`
>
> **Estimated Effort**: Medium
> **Parallel Execution**: YES - 3 waves
> **Critical Path**: Task 2 -> Task 8 -> Task 11 -> Task 12

---

## Context

### Original Request
User asked to continue analysis and then create a work plan for why final assistant text can still include previous temporary text.

### Interview Summary
**Key Discussions**:
- Current runtime stream path is primarily `assistantMessageMeta(lastText=accumulated)` and webview applies replace semantics.
- `chatChunk` append logic exists in webview but appears non-primary in current extension flow.
- Most likely bug area is tmp/final ID upgrade targeting and timing, not simple accumulated-string append.

**Research Findings**:
- `src/SidebarProvider.ts` appends per-session buffer and emits `assistantMessageMeta` with accumulated `lastText`.
- `media/main.js` `handleAssistantMeta` replaces `target.text` and resets `currentSegment`; upgrade logic depends on key/mapping readiness.
- `src/OpenCodeClient.ts` dedupes full-text repeats via previous text lengths.

### Metis Review
**Identified Gaps** (addressed in plan):
- Validate whether `chatChunk` is active in runtime before treating it as a primary bug vector.
- Prevent scope creep into freeze/resync issue and broad architecture refactors.
- Add explicit acceptance criteria around upgrade correctness and temp/final parity.

---

## Work Objectives

### Core Objective
Ensure final assistant messages are text-correct and ID-correct by eliminating stale temp-state carryover and making tmp-to-final upgrade deterministic.

### Concrete Deliverables
- Hardened upgrade and stream-state logic in `media/main.js`
- Consistent tmpKey/meta propagation guardrails in `src/SidebarProvider.ts` and `src/OpenCodeClient.ts`
- Evidence-backed QA artifacts under `.sisyphus/evidence/`

### Definition of Done
- [ ] Final assistant message text exactly matches latest authoritative stream text for tested scenarios
- [ ] No duplicate temp/final assistant bubbles remain after turn completion
- [ ] `npm run compile` succeeds

### Must Have
- Correct key targeting for tmp-to-final assistant upgrade
- Stable behavior when `assistantMessageMeta`, `chatDone`, and `userMessageUpgrade` arrive in varying order
- Executor performs all edits directly in current working directory: `d:\0.Code\OpenCodeGUI`

### Must NOT Have (Guardrails)
- No fix work for watchdog/resync-loop archive issue in this plan
- No large architecture rewrite of the event protocol
- No separate worktree/new working directory; do not move execution outside current workspace

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** for acceptance checks. All verifications must be command/tool executable and produce evidence files.

### Test Decision
- **Infrastructure exists**: NO (no test framework/scripts beyond TypeScript compile)
- **Automated tests**: None by default for this scope
- **Framework**: none
- **Agent-Executed QA**: REQUIRED for every task (runtime log/assertion scenarios)

### QA Policy
Every task includes executable QA scenarios with evidence paths.

- **Frontend/UI behavior**: Use Playwright skill where visual verification is needed
- **Extension/runtime checks**: Use Bash/interactive logging and compile checks
- **Assertions**: Compare expected IDs/text/order and capture logs/screenshots

---

## Execution Strategy

### Parallel Execution Waves

Wave 1 (Start Immediately - instrumentation + deterministic foundations):
- Task 1: Add runtime trace points for assistant upgrade path
- Task 2: Harden `attemptAssistantUpgrade` key-selection priority and safety
- Task 3: Clear stale segment state on replace-path updates
- Task 4: Harden tmpKey lifecycle in SidebarProvider turn flow
- Task 5: Guard `chatDone` final-map-bind behavior against stale carryover
- Task 6: Verify/contain legacy `chatChunk` and `messageAppend` protocol paths

Wave 2 (After Wave 1 - upgrade correctness across event ordering):
- Task 7: Make `replaceKeyEverywhere` merge behavior deterministic when `newKey` exists
- Task 8: Align upgrade call-sites (`assistantMessageMeta`, `chatDone`, `userMessageUpgrade`)
- Task 9: Tighten OpenCodeClient -> SidebarProvider assistant meta consistency
- Task 10: Add lightweight invariant assertions for temp/final text parity in dev flow
- Task 11: Implement regression-focused QA scripts/evidence capture workflow

Wave 3 (After Wave 2 - integration and cleanup):
- Task 12: End-to-end validation across multi-turn + tool-call scenarios
- Task 13: Remove/trim temporary tracing while preserving essential diagnostics
- Task 14: Final pass on scope compliance and evidence completeness

Wave FINAL (After ALL tasks - independent review, parallel):
- Task F1: Plan compliance audit
- Task F2: Code quality/build review
- Task F3: Real QA execution of all scenarios
- Task F4: Scope fidelity and contamination check

Critical Path: Task 2 -> Task 8 -> Task 11 -> Task 12
Parallel Speedup: ~60% vs sequential
Max Concurrent: 6

### Dependency Matrix

- **1**: depends on none -> blocks 10, 11, 12
- **2**: depends on none -> blocks 7, 8, 12
- **3**: depends on none -> blocks 8, 12
- **4**: depends on none -> blocks 8, 9, 12
- **5**: depends on none -> blocks 8, 12
- **6**: depends on none -> blocks 8, 14
- **7**: depends on 2 -> blocks 12
- **8**: depends on 2,3,4,5,6 -> blocks 11,12
- **9**: depends on 4 -> blocks 12
- **10**: depends on 1 -> blocks 11,12
- **11**: depends on 1,8,10 -> blocks 12,14
- **12**: depends on 2,3,4,5,7,8,9,10,11 -> blocks 13,14
- **13**: depends on 12 -> blocks 14
- **14**: depends on 6,11,12,13 -> blocks F1-F4
- **F1**: depends on 14
- **F2**: depends on 14
- **F3**: depends on 14
- **F4**: depends on 14

### Agent Dispatch Summary

- **Wave 1**: T1 `unspecified-high`, T2 `deep`, T3 `quick`, T4 `quick`, T5 `deep`, T6 `unspecified-high`
- **Wave 2**: T7 `deep`, T8 `deep`, T9 `quick`, T10 `quick`, T11 `unspecified-high`
- **Wave 3**: T12 `deep`, T13 `quick`, T14 `unspecified-high`
- **Wave FINAL**: F1 `oracle`, F2 `unspecified-high`, F3 `unspecified-high` (+ `playwright`), F4 `deep`

### Risk Controls (Regression-Safe Execution)

- **Wave Gate 1 (after Tasks 2+3+5)**: Do not proceed to Wave 2 until duplicate-temp/final symptom is reduced in baseline scenarios.
- **Wave Gate 2 (after Task 8)**: Validate idempotent convergence under out-of-order trigger replay before any broader cleanup.
- **Atomic Commit Rule**: One risk domain per commit (key-targeting, stale-state reset, done-binding, then integration).
- **Stop-On-Fail Rule**: If any gate fails, halt progression and revert only the latest risk-domain commit, then re-validate.
- **Rollback Checkpoints**: Keep checkpoint tags/notes after each successful gate for fast rollback to last-known-good.
- **No Broad Refactor Rule**: Any change outside referenced functions requires explicit plan update before execution.

---

## TODOs

- [ ] 1. Add runtime trace points for assistant upgrade path

  **What to do**:
  - Add focused, toggleable debug traces in `media/main.js` around `handleAssistantMeta`, `attemptAssistantUpgrade`, and `handleChatDone`.
  - Log key fields: `sessionId`, `currentTurnAssistantKey`, `tmpKey`, `assistantMsgId`, `messageIndex`, `awaitingFinalMapBind`.
  - Ensure traces are clearly prefixed for parsing and can be removed in cleanup wave.

  **Must NOT do**:
  - Do not alter functional behavior in this task.
  - Do not create a new worktree/workdir; edit directly in `d:\0.Code\OpenCodeGUI`.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` (Reason: tracing across interacting runtime states)
  - **Skills**: [`playwright`]
    - `playwright`: needed to drive reproducible UI conversation flow for trace capture.
  - **Skills Evaluated but Omitted**:
    - `git-master`: not needed for runtime instrumentation itself.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2-6)
  - **Blocks**: 10, 11, 12
  - **Blocked By**: None

  **References**:
  - `media/main.js:4256` - `handleAssistantMeta` text replacement path.
  - `media/main.js:1584` - `attemptAssistantUpgrade` key-selection and upgrade gate.
  - `media/main.js:4433` - `handleChatDone` finalization + upgrade trigger.

  **Acceptance Criteria**:
  - [ ] Trace lines emitted for each upgrade attempt and done-event path.
  - [ ] No behavior change in baseline conversation except extra logs.

  **QA Scenarios**:
  ```text
  Scenario: Happy path trace capture
    Tool: Playwright
    Preconditions: Extension host running, sidebar opened on target workspace
    Steps:
      1. Send prompt "Explain current temp/final mapping".
      2. Wait until assistant completes and `chatDone` is observed.
      3. Assert console contains prefixed trace lines with `assistantMsgId` and `currentTurnAssistantKey`.
    Expected Result: All three trace sites emit at least once.
    Failure Indicators: Missing trace site or undefined key fields in output.
    Evidence: .sisyphus/evidence/task-1-happy-trace.log

  Scenario: Failure/edge trace path
    Tool: Playwright
    Preconditions: Trigger prompt that invokes tool-call/status transitions
    Steps:
      1. Send prompt expected to invoke tool execution.
      2. Observe status update then completion.
      3. Assert trace includes status-transition + upgrade-attempt ordering.
    Expected Result: Ordered trace shows no missing stage.
    Evidence: .sisyphus/evidence/task-1-edge-status-trace.log
  ```

  **Commit**: NO

- [ ] 2. Harden `attemptAssistantUpgrade` key-selection priority and safety

  **What to do**:
  - Refine key resolution so upgrade targets authoritative current-turn key/tmp mapping first.
  - Add safety checks before falling back to `resolveLastAssistantKey`.
  - Prevent wrong-message upgrade when current turn key is cleared early.

  **Must NOT do**:
  - Do not redesign entire upgrade architecture.
  - Do not touch freeze/resync-loop logic.

  **Recommended Agent Profile**:
  - **Category**: `deep` (Reason: high-risk stateful logic and ordering)
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `playwright`: validation happens in QA tasks, not core logic edit.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 7, 8, 12
  - **Blocked By**: None

  **References**:
  - `media/main.js:1584` - upgrade entry and source-driven behavior.
  - `media/main.js:1618` - current key fallback chain.
  - `media/main.js:1626` - messageIndexMap gating.

  **Acceptance Criteria**:
  - [ ] Upgrade never targets unrelated prior assistant message in traced repro.
  - [ ] Fallback path only triggers when guarded conditions are satisfied.

  **QA Scenarios**:
  ```text
  Scenario: Happy path correct upgrade target
    Tool: Bash (runtime log inspection)
    Preconditions: Task 1 traces available
    Steps:
      1. Run extension host and submit single-turn prompt.
      2. Capture upgrade trace showing oldKey/newKey mapping.
      3. Assert oldKey matches turn tmp/current key, not unrelated timeline key.
    Expected Result: One deterministic upgrade mapping for the turn.
    Failure Indicators: Upgrade maps from unrelated assistant key.
    Evidence: .sisyphus/evidence/task-2-happy-upgrade-target.log

  Scenario: Failure/edge missing tmpKey
    Tool: Bash (runtime log inspection)
    Preconditions: Simulate/force path where tmpKey absent at upgrade moment
    Steps:
      1. Reproduce flow with delayed/absent tmp registration.
      2. Observe fallback decision trace.
      3. Assert fallback does not rewrite unrelated assistant entry.
    Expected Result: Safe no-op or deferred bind, no contamination.
    Evidence: .sisyphus/evidence/task-2-edge-missing-tmpkey.log
  ```

  **Commit**: YES
  - Message: `fix(webview): make assistant upgrade targeting deterministic`

- [ ] 3. Clear stale segment state on replace-path updates

  **What to do**:
  - In replace-mode `assistantMessageMeta` handling, clear stale segment containers (`textSegments`/related transient fields) when replacing full `target.text`.
  - Ensure no stale cumulative state can rehydrate after replacement.

  **Must NOT do**:
  - Do not remove status-update behavior.
  - Do not convert entire pipeline to chunk-only streaming.

  **Recommended Agent Profile**:
  - **Category**: `quick` (Reason: localized, surgical state reset fix)
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `playwright`: not required for code edit itself.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 8, 12
  - **Blocked By**: None

  **References**:
  - `media/main.js:4345` - replace path assigning `target.text = nextText`.
  - `media/main.js:4353` - meta rewrite currently clearing only `currentSegment`.
  - `media/main.js:4400` - chunk path relying on segment state.

  **Acceptance Criteria**:
  - [ ] After replace update, stale segment arrays are empty/reset.
  - [ ] No duplicate segment reconstruction in mixed status flows.

  **QA Scenarios**:
  ```text
  Scenario: Happy path full-replace reset
    Tool: Bash (runtime assertions/log)
    Preconditions: Build includes temporary assertion/log for segment state after replace
    Steps:
      1. Trigger normal assistant streaming turn.
      2. Capture state after non-status `assistantMessageMeta` update.
      3. Assert segment containers are reset.
    Expected Result: Reset state recorded on every replace update.
    Failure Indicators: Non-empty stale segment state persists.
    Evidence: .sisyphus/evidence/task-3-happy-segment-reset.log

  Scenario: Failure/edge status interleave
    Tool: Bash (runtime assertions/log)
    Preconditions: Prompt that causes status update between text emissions
    Steps:
      1. Trigger tool-call/status path.
      2. Observe replace update after status step.
      3. Assert final text contains no duplicated prior segment.
    Expected Result: Text remains parity-correct with latest source text.
    Evidence: .sisyphus/evidence/task-3-edge-status-interleave.log
  ```

  **Commit**: YES
  - Message: `fix(webview): reset stale segment state on full-text replace`

- [ ] 4. Harden tmpKey lifecycle in SidebarProvider turn flow

  **What to do**:
  - Ensure tmpKey registration, propagation, and cleanup are consistent across success/error turn endings.
  - Prevent stale tmpKey values from leaking into subsequent turns.
  - Keep assistant buffer lifecycle tightly bound to active session turn.

  **Must NOT do**:
  - Do not change user-visible protocol fields beyond correctness.
  - Do not alter Git/undo subsystem behavior.

  **Recommended Agent Profile**:
  - **Category**: `quick` (Reason: contained lifecycle fixes in extension orchestrator)
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `git-master`: not required for non-git logic work.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 8, 9, 12
  - **Blocked By**: None

  **References**:
  - `src/SidebarProvider.ts:1057` - initial tmpKey capture on send.
  - `src/SidebarProvider.ts:1283` - `registerTmpKey` handling.
  - `src/SidebarProvider.ts:3757` - text-event meta emission with tmpKey.
  - `src/SidebarProvider.ts:3899` - buffer flush semantics.

  **Acceptance Criteria**:
  - [ ] tmpKey maps are cleared/updated correctly per turn boundary.
  - [ ] No stale tmpKey appears in next-turn assistant meta events.

  **QA Scenarios**:
  ```text
  Scenario: Happy path tmpKey lifecycle
    Tool: Bash (log inspection)
    Preconditions: Tracing enabled for tmpKey map updates
    Steps:
      1. Run two sequential turns in same session.
      2. Capture tmpKey assignment and cleanup logs.
      3. Assert turn 2 never reuses turn 1 tmpKey.
    Expected Result: Strict per-turn tmpKey isolation.
    Failure Indicators: Reused/stale tmpKey in second turn.
    Evidence: .sisyphus/evidence/task-4-happy-tmpkey-lifecycle.log

  Scenario: Failure/edge error completion path
    Tool: Bash (log inspection)
    Preconditions: Force error/cancel in first turn
    Steps:
      1. Trigger error path and observe cleanup.
      2. Start a new turn immediately.
      3. Assert fresh tmpKey and empty prior buffer.
    Expected Result: No stale key/buffer carryover.
    Evidence: .sisyphus/evidence/task-4-edge-error-cleanup.log
  ```

  **Commit**: YES
  - Message: `fix(sidebar): stabilize tmpKey and assistant buffer lifecycle`

- [ ] 5. Guard `chatDone` final-map-bind behavior against stale carryover

  **What to do**:
  - Tighten `chatDone` handling so finalization does not preserve mismatched temp state when final id mapping is delayed.
  - Ensure `awaitingFinalMapBind` transitions are deterministic and recoverable.

  **Must NOT do**:
  - Do not suppress legitimate deferred-bind behavior.
  - Do not modify watchdog/resync pipeline.

  **Recommended Agent Profile**:
  - **Category**: `deep` (Reason: subtle ordering/state transitions at turn finalization)
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `playwright`: runtime verification handled in QA tasks.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 8, 12
  - **Blocked By**: None

  **References**:
  - `media/main.js:4433` - `handleChatDone` flow.
  - `media/main.js:4473` - upgrade attempt at done.
  - `media/main.js:4487` - `awaitingFinalMapBind` set conditions.

  **Acceptance Criteria**:
  - [ ] Delayed final-id map no longer causes stale temp bubble persistence.
  - [ ] Done-state key cleanup does not break subsequent legitimate upgrade resolution.

  **QA Scenarios**:
  ```text
  Scenario: Happy path immediate final bind
    Tool: Bash (log inspection)
    Preconditions: Normal turn where assistantMsgId available by chatDone
    Steps:
      1. Complete a normal prompt-response turn.
      2. Inspect done and upgrade traces.
      3. Assert no lingering temp message after final bind.
    Expected Result: Single final assistant message remains.
    Failure Indicators: Temp and final duplicates coexist post-done.
    Evidence: .sisyphus/evidence/task-5-happy-chatdone-bind.log

  Scenario: Failure/edge delayed bind
    Tool: Bash (log inspection)
    Preconditions: Simulate delayed mapping order (meta after done)
    Steps:
      1. Reproduce delayed final-id arrival.
      2. Observe awaiting-bind lifecycle.
      3. Assert eventual convergence to single final message.
    Expected Result: Temporary waiting state resolves without contamination.
    Evidence: .sisyphus/evidence/task-5-edge-delayed-bind.log
  ```

  **Commit**: YES
  - Message: `fix(webview): harden chatDone final-map binding transitions`

- [ ] 6. Verify and contain legacy `chatChunk`/`messageAppend` protocol paths

  **What to do**:
  - Confirm which message types are actively emitted in current runtime.
  - If legacy handlers remain, guard them to avoid accidental split-path state mutation.
  - Document active vs legacy path assumptions in inline, minimal comments only where non-obvious.

  **Must NOT do**:
  - Do not remove handlers that are still used.
  - Do not introduce protocol-breaking changes.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` (Reason: protocol audit across extension/webview boundaries)
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `playwright`: optional; core work is protocol guardrails.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 8, 14
  - **Blocked By**: None

  **References**:
  - `src/SidebarProvider.ts:1093` - `messageAppend` emission.
  - `src/SidebarProvider.ts:3757` - current text path via `assistantMessageMeta`.
  - `media/main.js:5457` - `assistantMessageMeta` receive case.
  - `media/main.js:5476` - `chatChunk` receive case.

  **Acceptance Criteria**:
  - [ ] Active runtime path is explicitly confirmed by evidence logs.
  - [ ] Legacy path cannot silently contaminate active message state.

  **QA Scenarios**:
  ```text
  Scenario: Happy path active protocol verification
    Tool: Bash (instrumented event log)
    Preconditions: Event-type logging enabled for webview message receiver
    Steps:
      1. Execute a standard prompt-response turn.
      2. Capture inbound message types in order.
      3. Assert expected active set and absence/presence of legacy types.
    Expected Result: Deterministic message-type sequence documented.
    Failure Indicators: Unexpected legacy type mutating live state.
    Evidence: .sisyphus/evidence/task-6-happy-protocol-types.log

  Scenario: Failure/edge mixed-event injection
    Tool: Bash (debug harness)
    Preconditions: Simulate mixed order of meta/chunk append events
    Steps:
      1. Feed mixed event order in debug flow.
      2. Observe state mutation guards.
      3. Assert no duplicate final rendering state.
    Expected Result: Guards prevent split-path contamination.
    Evidence: .sisyphus/evidence/task-6-edge-mixed-events.log
  ```

  **Commit**: NO

- [ ] 7. Make `replaceKeyEverywhere` merge behavior deterministic when `newKey` already exists

  **What to do**:
  - Define deterministic merge priority if `newKey` already exists when upgrading from temp key.
  - Preserve the most complete text/meta state and avoid dropping richer temp state silently.
  - Ensure timeline and segment membership remain deduplicated.

  **Must NOT do**:
  - Do not rewrite segment architecture.
  - Do not introduce duplicate IDs in timeline arrays.

  **Recommended Agent Profile**:
  - **Category**: `deep` (Reason: data-structure integrity across multiple indexes)
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `git-master`: not required.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 8-11)
  - **Blocks**: 12
  - **Blocked By**: 2

  **References**:
  - `media/main.js:1189` - `replaceKeyEverywhere` implementation.
  - `media/main.js:1209` - existing `newKey` branch behavior.
  - `media/main.js:1224` - timeline replacement and dedupe.

  **Acceptance Criteria**:
  - [ ] Existing-newKey upgrade path keeps most complete assistant content.
  - [ ] Timeline has no duplicate assistant entries after replacement.

  **QA Scenarios**:
  ```text
  Scenario: Happy path existing-newKey merge
    Tool: Bash (state dump/log)
    Preconditions: Repro where final key exists before upgrade
    Steps:
      1. Trigger upgrade with pre-existing final message key.
      2. Capture pre/post state snapshots of messagesById + timeline.
      3. Assert retained entry has full expected text/meta and single timeline occurrence.
    Expected Result: Deterministic retained state with no data loss.
    Failure Indicators: Lost text/meta or duplicate timeline entries.
    Evidence: .sisyphus/evidence/task-7-happy-existing-key-merge.log

  Scenario: Failure/edge partial temp richer than final
    Tool: Bash (state dump/log)
    Preconditions: Temp contains newer text than existing final placeholder
    Steps:
      1. Simulate richer temp before replacement.
      2. Execute replacement.
      3. Assert richer content is preserved.
    Expected Result: No regression to stale/shorter text.
    Evidence: .sisyphus/evidence/task-7-edge-richer-temp.log
  ```

  **Commit**: YES
  - Message: `fix(webview): preserve complete state when upgrading to existing final key`

- [ ] 8. Align upgrade triggers across `assistantMessageMeta`, `chatDone`, and `userMessageUpgrade`

  **What to do**:
  - Consolidate trigger precedence so multiple upgrade signals do not race into inconsistent state.
  - Ensure idempotent behavior if same final id arrives from multiple sources.
  - Keep upgrade decision logs explicit for each trigger source.

  **Must NOT do**:
  - Do not break backward compatibility for any existing trigger event.
  - Do not disable upgrade from any source without replacement policy.

  **Recommended Agent Profile**:
  - **Category**: `deep` (Reason: race/order resolution across three event sources)
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `playwright`: validation only.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: 11, 12
  - **Blocked By**: 2,3,4,5,6

  **References**:
  - `media/main.js:4286` - upgrade from assistant meta path.
  - `media/main.js:4473` - upgrade from chatDone path.
  - `media/main.js:5633` - upgrade from userMessageUpgrade path.
  - `media/main.js:1584` - common upgrade function entry.

  **Acceptance Criteria**:
  - [ ] Repeated same-final-id signals are idempotent.
  - [ ] Trigger order variation does not change final rendered outcome.

  **QA Scenarios**:
  ```text
  Scenario: Happy path multi-trigger idempotence
    Tool: Bash (trace log)
    Preconditions: Enable source-tagged upgrade trace logging
    Steps:
      1. Run prompt producing all three signal types.
      2. Capture sequence of upgrade attempts.
      3. Assert final state converges once with no duplicate bubble.
    Expected Result: Idempotent convergence independent of trigger repetition.
    Failure Indicators: Divergent final states across runs.
    Evidence: .sisyphus/evidence/task-8-happy-multitrigger.log

  Scenario: Failure/edge out-of-order delivery
    Tool: Bash (debug harness)
    Preconditions: Simulate out-of-order done/meta/upgrade signals
    Steps:
      1. Replay event order variants.
      2. Observe upgrade decisions.
      3. Assert final text/key parity across all variants.
    Expected Result: Same final message identity and text for each variant.
    Evidence: .sisyphus/evidence/task-8-edge-out-of-order.log
  ```

  **Commit**: YES
  - Message: `fix(webview): make assistant upgrade triggers order-safe and idempotent`

- [ ] 9. Tighten OpenCodeClient -> SidebarProvider assistant meta consistency

  **What to do**:
  - Validate and harden `assistantMsgId`, `tmpKey`, and `messageIndex` propagation consistency.
  - Ensure emitted meta fields are complete enough for deterministic webview targeting.
  - Add concise diagnostics on missing critical fields.

  **Must NOT do**:
  - Do not alter core SSE parsing semantics unrelated to this issue.
  - Do not add noisy permanent logs.

  **Recommended Agent Profile**:
  - **Category**: `quick` (Reason: targeted contract consistency across two files)
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `playwright`: not required for contract edit.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: 12
  - **Blocked By**: 4

  **References**:
  - `src/OpenCodeClient.ts:1764` - assistant meta event emission.
  - `src/OpenCodeClient.ts:1827` - text event emission.
  - `src/SidebarProvider.ts:3719` - meta forwarding to webview.
  - `src/SidebarProvider.ts:3757` - text-event conversion to meta update.

  **Acceptance Criteria**:
  - [ ] Missing-id scenarios no longer produce ambiguous target selection.
  - [ ] Meta payload fields required for upgrade are consistently present or safely deferred.

  **QA Scenarios**:
  ```text
  Scenario: Happy path complete meta contract
    Tool: Bash (structured log diff)
    Preconditions: Contract-field logging enabled in dev mode
    Steps:
      1. Run standard prompt turn.
      2. Capture emitted client and forwarded sidebar meta payloads.
      3. Assert required fields are preserved across handoff.
    Expected Result: Stable field parity from client emission to webview post.
    Failure Indicators: Dropped/mismatched critical fields.
    Evidence: .sisyphus/evidence/task-9-happy-meta-contract.log

  Scenario: Failure/edge missing assistantMsgId early
    Tool: Bash (structured log diff)
    Preconditions: Early stream phase without final assistant id
    Steps:
      1. Observe early meta/text events.
      2. Verify deferred upgrade behavior.
      3. Assert no wrong-message upgrade attempt occurs.
    Expected Result: Safe deferral until sufficient identity data exists.
    Evidence: .sisyphus/evidence/task-9-edge-missing-assistant-id.log
  ```

  **Commit**: YES
  - Message: `fix(streaming): harden assistant meta identity consistency`

- [ ] 10. Add lightweight invariant assertions for temp/final text parity (dev-only)

  **What to do**:
  - Add guarded assertions around key transition points to verify final text parity and state sanity.
  - Keep assertions behind dev/debug guard so production behavior is unaffected.

  **Must NOT do**:
  - Do not introduce crashing assertions in production runtime.
  - Do not bloat logs with high-frequency noise.

  **Recommended Agent Profile**:
  - **Category**: `quick` (Reason: minimal dev-guarded assertions)
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `playwright`: verification is separate.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: 11, 12
  - **Blocked By**: 1

  **References**:
  - `media/main.js:4345` - replace text write point.
  - `media/main.js:4473` - done-time upgrade point.
  - `media/main.js:1189` - replace-key path for id transitions.

  **Acceptance Criteria**:
  - [ ] Assertions catch parity mismatches in repro harness.
  - [ ] Assertions remain silent in healthy runs.

  **QA Scenarios**:
  ```text
  Scenario: Happy path no assertion failures
    Tool: Bash
    Preconditions: Dev assertion mode enabled
    Steps:
      1. Run three normal prompt turns.
      2. Collect runtime output.
      3. Assert zero parity/state assertion failures.
    Expected Result: Clean run with no invariant violations.
    Failure Indicators: Any assertion mismatch logged.
    Evidence: .sisyphus/evidence/task-10-happy-assertions.log

  Scenario: Failure/edge induced mismatch
    Tool: Bash (debug harness)
    Preconditions: Inject known out-of-order event sequence
    Steps:
      1. Replay sequence designed to violate invariant.
      2. Observe assertion output.
      3. Assert mismatch is detected explicitly.
    Expected Result: Assertion surfaces precise failure condition.
    Evidence: .sisyphus/evidence/task-10-edge-invariant-catch.log
  ```

  **Commit**: NO

- [ ] 11. Build regression evidence workflow for temp/final correctness

  **What to do**:
  - Define and execute repeatable scenario matrix (single-turn, tool-call interleave, delayed-bind, multi-turn).
  - Capture standardized evidence logs/screenshots per scenario.
  - Provide pass/fail rubric tied to acceptance criteria from tasks 2/3/5/8.

  **Must NOT do**:
  - Do not rely on manual-only visual judgment.
  - Do not skip failure/edge scenarios.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` (Reason: cross-scenario verification orchestration)
  - **Skills**: [`playwright`]
    - `playwright`: deterministic UI automation and screenshot evidence.
  - **Skills Evaluated but Omitted**:
    - `git-master`: not relevant.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: 12, 14
  - **Blocked By**: 1,8,10

  **References**:
  - `.sisyphus/drafts/stall-log-analysis.md` - known symptom context and boundaries.
  - `media/main.js:4256` - assistant meta processing entry.
  - `media/main.js:4433` - done-finalization behavior.

  **Acceptance Criteria**:
  - [ ] Evidence exists for all defined scenarios.
  - [ ] Each scenario has binary pass/fail outcome with concrete assertions.

  **QA Scenarios**:
  ```text
  Scenario: Happy path matrix execution
    Tool: Playwright
    Preconditions: Extension dev host ready, traces available
    Steps:
      1. Execute scenario matrix script for normal and tool-call flows.
      2. Capture UI states and logs per scenario.
      3. Assert final message count/text parity conditions per scenario.
    Expected Result: All baseline scenarios pass.
    Failure Indicators: Any scenario shows temp+final duplicate or text mismatch.
    Evidence: .sisyphus/evidence/task-11-happy-matrix.json

  Scenario: Failure/edge delayed-upgrade matrix
    Tool: Playwright + Bash
    Preconditions: Delayed-bind scenario enabled
    Steps:
      1. Run delayed-bind and out-of-order variants.
      2. Capture logs/screenshots.
      3. Assert eventual single-final convergence and text parity.
    Expected Result: Edge scenarios converge without stale carryover.
    Evidence: .sisyphus/evidence/task-11-edge-delayed-matrix.json
  ```

  **Commit**: NO

- [ ] 12. End-to-end validation across multi-turn and tool-call scenarios

  **What to do**:
  - Run integrated verification using completed fixes from waves 1-2.
  - Validate no regression in thinking status transitions, diff updates, and final message rendering.
  - Confirm convergence to exactly one final assistant message per turn.

  **Must NOT do**:
  - Do not skip negative/error scenarios.
  - Do not alter scope to unrelated freeze/resync-loop fixes.

  **Recommended Agent Profile**:
  - **Category**: `deep` (Reason: cross-component integration validation)
  - **Skills**: [`playwright`]
    - `playwright`: verifies real UI runtime behavior across scenarios.
  - **Skills Evaluated but Omitted**:
    - `git-master`: not required.

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3 (sequential anchor)
  - **Blocks**: 13, 14
  - **Blocked By**: 2,3,4,5,7,8,9,10,11

  **References**:
  - `src/OpenCodeClient.ts:1707` - streaming parse/event emission baseline.
  - `src/SidebarProvider.ts:1143` - flush/done/upgrade ordering.
  - `media/main.js:1584` - upgrade core logic.
  - `media/main.js:4433` - completion state transition.

  **Acceptance Criteria**:
  - [ ] All planned scenarios pass with expected single-final outcome.
  - [ ] Final rendered text parity holds against authoritative latest text state.

  **QA Scenarios**:
  ```text
  Scenario: Happy path integrated run
    Tool: Playwright + Bash
    Preconditions: Tasks 2-11 complete
    Steps:
      1. Execute end-to-end multi-turn script including one tool-call turn.
      2. Capture runtime logs and UI screenshots.
      3. Assert each turn ends with one final assistant message and correct final text.
    Expected Result: 100% pass on baseline integrated flow.
    Failure Indicators: Duplicate bubbles or final text contamination.
    Evidence: .sisyphus/evidence/task-12-happy-e2e.log

  Scenario: Failure/edge cancellation/retry flow
    Tool: Playwright + Bash
    Preconditions: Include cancel/retry during active streaming
    Steps:
      1. Start a prompt, cancel mid-stream, then submit new prompt.
      2. Observe key lifecycle and final rendering.
      3. Assert no stale carryover into new turn final message.
    Expected Result: Clean new turn state after cancellation.
    Evidence: .sisyphus/evidence/task-12-edge-cancel-retry.log
  ```

  **Commit**: YES
  - Message: `fix(integration): validate temp-to-final text correctness across real flows`

- [ ] 13. Remove temporary tracing and keep essential diagnostics only

  **What to do**:
  - Remove high-noise temporary tracing added for diagnosis.
  - Keep minimal, useful diagnostics for future triage guarded by debug flag.
  - Ensure evidence artifacts remain in `.sisyphus/evidence/` even after trace cleanup.

  **Must NOT do**:
  - Do not remove required invariant/error diagnostics.
  - Do not modify functional logic while cleaning traces.

  **Recommended Agent Profile**:
  - **Category**: `quick` (Reason: straightforward cleanup pass)
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `playwright`: not needed for cleanup edit.

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3
  - **Blocks**: 14
  - **Blocked By**: 12

  **References**:
  - `media/main.js` - all temporary trace insertion points from Task 1.
  - `.sisyphus/evidence/` - preserve generated proof artifacts.

  **Acceptance Criteria**:
  - [ ] Temporary noisy logs removed.
  - [ ] Debug-essential diagnostics remain available and gated.

  **QA Scenarios**:
  ```text
  Scenario: Happy path post-cleanup run
    Tool: Bash
    Preconditions: Cleanup applied
    Steps:
      1. Run a normal prompt-response turn.
      2. Capture runtime output.
      3. Assert no noisy trace spam while key diagnostics still available in debug mode.
    Expected Result: Clean logs and preserved essential diagnostics.
    Failure Indicators: Lost critical diagnostics or remaining noisy spam.
    Evidence: .sisyphus/evidence/task-13-happy-cleanup.log

  Scenario: Failure/edge debug diagnostics check
    Tool: Bash
    Preconditions: Debug flag enabled
    Steps:
      1. Trigger delayed-upgrade edge scenario.
      2. Capture diagnostic output.
      3. Assert required debug diagnostics are still emitted.
    Expected Result: Edge diagnostics available without broad spam.
    Evidence: .sisyphus/evidence/task-13-edge-debug.log
  ```

  **Commit**: YES
  - Message: `chore(logging): remove temporary traces and keep targeted diagnostics`

- [ ] 14. Final scope/evidence compliance pass for this plan

  **What to do**:
  - Audit all changed files and evidence against plan tasks.
  - Ensure no freeze/resync-loop fixes were included.
  - Ensure executor worked directly in current workspace path.

  **Must NOT do**:
  - Do not introduce new functional changes in audit task.
  - Do not leave undocumented evidence gaps.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` (Reason: thorough compliance and artifact audit)
  - **Skills**: []
  - **Skills Evaluated but Omitted**:
    - `playwright`: main verification already done in prior tasks.

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3
  - **Blocks**: F1, F2, F3, F4
  - **Blocked By**: 6,11,12,13

  **References**:
  - `.sisyphus/plans/temp-final-text-finalization-fix.md` - compliance source of truth.
  - `.sisyphus/drafts/TODO-finalization-resync-loop-archive.md` - deferred scope boundary.
  - `.sisyphus/evidence/` - required evidence artifacts.

  **Acceptance Criteria**:
  - [ ] All tasks have matching evidence files.
  - [ ] No out-of-scope code touched.
  - [ ] Workspace-path constraint explicitly satisfied.

  **QA Scenarios**:
  ```text
  Scenario: Happy path compliance audit
    Tool: Bash
    Preconditions: Tasks 1-13 complete
    Steps:
      1. Compare changed files against plan task references.
      2. Verify evidence files for each task scenario exist.
      3. Assert no out-of-scope files/logic changed.
    Expected Result: Full compliance across scope and evidence.
    Failure Indicators: Missing evidence or unexpected file changes.
    Evidence: .sisyphus/evidence/task-14-happy-compliance.log

  Scenario: Failure/edge missing evidence detection
    Tool: Bash
    Preconditions: Temporarily remove one expected evidence artifact in dry-check context
    Steps:
      1. Run compliance checker/audit script.
      2. Confirm it flags missing artifact.
      3. Restore artifact and rerun clean.
    Expected Result: Audit reliably detects and reports evidence gaps.
    Evidence: .sisyphus/evidence/task-14-edge-missing-evidence.log
  ```

  **Commit**: NO

---

## Final Verification Wave (MANDATORY)

- [ ] F1. **Plan Compliance Audit** - `oracle`
  Verify each Must Have and Must NOT Have against actual diff and runtime evidence files in `.sisyphus/evidence/`.

- [ ] F2. **Code Quality Review** - `unspecified-high`
  Run `npm run compile` and inspect changed files for risky patterns, dead paths, and unintended scope expansion.

- [ ] F3. **Real QA Execution** - `unspecified-high` (+ `playwright` skill)
  Execute all task QA scenarios end-to-end and save artifacts under `.sisyphus/evidence/final-qa/`.

- [ ] F4. **Scope Fidelity Check** - `deep`
  Validate task-to-diff 1:1 mapping, no freeze/resync-loop work included, no workdir/worktree drift.

---

## Commit Strategy

- Commit 1: `fix(webview): stabilize assistant temp-to-final upgrade targeting`
- Commit 2: `fix(streaming): align meta/tmpKey lifecycle across extension and client`
- Commit 3: `chore(qa): add evidence-backed regression validation for temp/final text`

---

## Success Criteria

### Verification Commands
```bash
npm run compile
```

### Final Checklist
- [ ] All Must Have items verified
- [ ] All Must NOT Have constraints respected
- [ ] Evidence files exist for each task scenario
- [ ] No duplicate/stale temp text observed in final assistant messages for defined scenarios
