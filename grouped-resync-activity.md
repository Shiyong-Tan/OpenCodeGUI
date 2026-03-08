# Grouped Resync Activity

## TL;DR

> **Quick Summary**: Extend resync/rescue liveness from single-session to grouped root+subagent activity while preserving root-only final correctness and replaying subagent state in a restore-only manner.
>
> **Deliverables**:
> - Grouped liveness helpers and guarded rescue/resync decisions in `src/OpenCodeClient.ts`
> - Root-coordinated, per-session replay for main + related subagent sessions
> - Replay side-effect firewall and parent-ingestion dedupe in `src/SidebarProvider.ts` and `src/OpenCodeClient.ts`
> - Feature flag, observability markers, and automated verification coverage
>
> **Estimated Effort**: Large
> **Parallel Execution**: YES - 3 waves + final verification
> **Critical Path**: Task 1 -> Task 5 -> Task 9 -> Task 10 -> F1-F4

---

## Context

### Original Request
Create a work plan to implement the grouped-resync proposal captured in `.sisyphus/drafts/resync-evaluation.md`, after Metis confirmed the draft is ready for planning.

### Interview Summary
**Key Discussions**:
- The user wanted evaluation first, then a complete mechanism proposal, then a plan only after review.
- Grouped activity should influence rescue/resync liveness, but root/main final acceptance must remain root-owned.
- Main and subagent message payloads share the same persisted `/session/:id/message` schema; the problem is session scoping and replay filtering, not wire-format mismatch.
- Replay of subagent `files`-adjacent events must restore state only and must not re-trigger imperative UI side effects.
- Rollout preference is **automatic fallback** to legacy session-local behavior if grouped-resync behavior misbehaves.

**Research Findings**:
- `src/OpenCodeClient.ts:901` already has parent/subagent grouping primitives via `getRelatedSessionIds(...)`.
- `src/OpenCodeClient.ts:1324`, `src/OpenCodeClient.ts:1376`, `src/OpenCodeClient.ts:1446`, and `src/OpenCodeClient.ts:4372` show current resync/rescue logic is session-local.
- `src/OpenCodeClient.ts:5484` replays one session at a time today.
- `src/SidebarProvider.ts:3885` currently lets subagent replay-adjacent `files` state drive imperative side effects, which must be firewalled during resync replay.

### Metis Review
**Identified Gaps** (addressed):
- Proposal source stability: covered by recording a proposal snapshot requirement before/alongside implementation.
- Rollout safety: covered by `groupedResyncActivityEnabled` default-off flag with automatic fallback.
- Verification coverage: covered by unit + integration + manual/E2E verification structure.

---

## Work Objectives

### Core Objective
Implement grouped resync activity so root rescue/resync logic can consider related subagent activity without weakening root final correctness, while restoring subagent replay state safely and without duplicate side effects.

### Concrete Deliverables
- Grouped liveness helper layer in `src/OpenCodeClient.ts`
- Root-owned `resync -> sse` recovery gate updates in `src/OpenCodeClient.ts`
- Root-coordinated replay over root + related subagent sessions in `src/OpenCodeClient.ts`
- Session-local subagent replay filtering that excludes `summary=true` and `mode=compaction`
- Replay source tagging and side-effect suppression in `src/SidebarProvider.ts`
- Canonical parent change-ingestion behavior that avoids replay duplicates
- Feature flag and observability markers for grouped-resync behavior
- Automated and manual verification coverage for rescue, replay, and rollback behavior

### Definition of Done
- [x] Grouped-resync behavior can be turned on/off via a single flag, with `false` preserving legacy behavior.
- [x] Root final completion remains controlled only by root-owned evidence and acceptance paths.
- [x] Subagent replay restores card state without re-triggering `queueSubagentChanges(...)`, diff-open flows, change-list ingestion, or restore locks.
- [x] Grouped replay operates per session and does not merge main/subagent messages into one global ordered stream.
- [x] Replay and rescue debug markers make grouped behavior diagnosable from logs alone.
- [x] The UI continues to load and operate normally after the changes: sidebar renders, sessions load, messages display, and live SSE processing still works.

### Must Have
- Automatic fallback to legacy session-local behavior when grouped behavior is disabled or intentionally rolled back
- All changes made directly in the current working directory `d:\0.Code\OpenCodeGUI` (do not use a separate working directory)
- Session-local replay filtering for subagents using their own anchors before any time-window fallback
- Normal UI loading and operation must remain intact: sidebar renders, sessions load, and live message flow behaves normally after the resync changes

### Must NOT Have (Guardrails)
- No change to the core semantics of `shouldAcceptTurnCompletionFinal(...)`, `markTurnFinal(...)`, or `resolveTurnFinal(...)`
- No global merged replay stream across root + subagent sessions
- No replay-triggered imperative UI side effects for `source='resync'`
- No uncontrolled duplicate parent change ingestion through mirror + queue replay paths
- No dependence on manual human verification inside task acceptance criteria
- No code changes outside the main working directory `d:\0.Code\OpenCodeGUI` - no cloned repos, temp directories, or separate checkouts
- No changes to logic outside the resync/rescue/replay scope - no opportunistic refactors, no unrelated bug fixes, and no formatting-only churn outside touched lines

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION for task acceptance** — tasks must be verifiable by agent-executed commands and tooling. A final manual/E2E pass is included only as an additional release-confidence layer, not as a substitute for task acceptance.

### Test Decision
- **Infrastructure exists**: YES
- **Automated tests**: Tests-after
- **Framework**: Existing project test/build tooling in repo conventions
- **Flag under test**: `groupedResyncActivityEnabled` defaults to `false`; grouped behavior tests must explicitly enable it.

### QA Policy
Every implementation task below includes agent-executed QA scenarios and evidence expectations.

- **Library/logic verification**: Use Bash to run targeted test commands or node/bun entrypoints against helper logic.
- **Client/state verification**: Use Bash for targeted tests plus log assertions over emitted debug markers.
- **UI replay verification**: Use Playwright or test harnesses where available; otherwise use targeted extension/integration tests and evidence logs.
- **Current working directory rule**: All executor changes must happen in `d:\0.Code\OpenCodeGUI`, never in a cloned/temp working directory.

---

## Execution Strategy

> GLOBAL CONSTRAINT: All implementation tasks (T1-T13) must modify files only inside `d:\0.Code\OpenCodeGUI`. Executors must not create or switch to another working directory.

### Parallel Execution Waves

### Minimal Safe Implementation Order

> Before full wave execution, the executor must validate the minimum safe chain below in order. This prevents the system from entering the new grouped path before replay safety and side-effect containment are in place.

1. Task 1 - Feature flag and grouped-helper scaffolding
2. Task 2 - Replay source tagging contract
3. Task 3 - Session-local subagent replay filter rules
4. Task 4 - Observability marker schema
5. Task 8 - Root-coordinated per-session replay orchestration
6. Task 9 - Replay side-effect firewall in `SidebarProvider`
7. Task 10 - Duplicate-ingestion prevention and replay idempotency
8. Task 6 - Grouped rescue and settle liveness integration
9. Task 7 - Root-owned `resync -> sse` recovery gate

> Only after this chain passes compile/basic QA should the broader wave structure be used for the remaining work.

> Maximize throughput by separating helper foundations, replay/filter logic, and UI side-effect containment.

```
Wave 1 (Start Immediately - foundations and guardrails):
- Task 1: Feature flag + grouped helper scaffolding [quick]
- Task 2: Replay source tagging contract [quick]
- Task 3: Subagent replay filter rules [quick]
- Task 4: Observability marker schema [writing]
- Task 5: Parent change-ingestion inventory + canonical path [unspecified-high]

Wave 2 (After Wave 1 - core runtime behavior):
- Task 6: Grouped rescue/settle liveness integration [deep]
- Task 7: Root-owned resync recovery gate [deep]
- Task 8: Root-coordinated per-session replay orchestration [deep]
- Task 9: Replay side-effect firewall in SidebarProvider [unspecified-high]

Wave 3 (After Wave 2 - verification and rollout hardening):
- Task 10: Duplicate-ingestion prevention + replay idempotency [deep]
- Task 11: Automated tests for grouped liveness and replay filtering [unspecified-high]
- Task 12: Integration verification for replay suppression and fallback [unspecified-high]
- Task 13: Rollout/rollback validation under feature flag [quick]

Wave FINAL (After ALL tasks - independent review):
- Task F1: Plan compliance audit (oracle)
- Task F2: Code quality review (unspecified-high)
- Task F3: Real QA execution of all scenarios (unspecified-high)
- Task F4: Scope fidelity check (deep)

Critical Path: Task 1 -> Task 5 -> Task 8 -> Task 9 -> Task 10 -> F1-F4
Parallel Speedup: ~55% faster than sequential
Max Concurrent: 5
```

### Dependency Matrix

- **1**: — -> 6, 7, 8, 13
- **2**: — -> 8, 9, 10, 11, 12
- **3**: — -> 8, 11, 12
- **4**: — -> 6, 7, 8, 9, 12, 13
- **5**: — -> 9, 10, 12
- **6**: 1, 4 -> 12
- **7**: 1, 4 -> 12, 13
- **8**: 1, 2, 3, 4 -> 9, 10, 11, 12, 13
- **9**: 2, 4, 5, 8 -> 10, 12, 13
- **10**: 2, 5, 8, 9 -> 12, 13
- **11**: 2, 3, 8 -> 12
- **12**: 2, 3, 5, 6, 7, 8, 9, 10, 11 -> 13, F1-F4
- **13**: 1, 4, 7, 8, 9, 10, 12 -> F1-F4

### Agent Dispatch Summary

- **Wave 1**: T1 `quick`, T2 `quick`, T3 `quick`, T4 `writing`, T5 `unspecified-high`
- **Wave 2**: T6 `deep`, T7 `deep`, T8 `deep`, T9 `unspecified-high`
- **Wave 3**: T10 `deep`, T11 `unspecified-high`, T12 `unspecified-high`, T13 `quick`
- **Final**: F1 `oracle`, F2 `unspecified-high`, F3 `unspecified-high`, F4 `deep`

### Execution Watchpoints (Metis Re-review)

- **Watchpoint 1 - Enforce the minimal safe chain**: Task 1 -> 2 -> 3 -> 4 -> 8 -> 9 -> 10 -> 6 -> 7 must run in order and pass compile/basic QA before broader wave parallelization. Do not shortcut this sequence.
- **Watchpoint 2 - Keep Task 5 convergent**: Task 5 must end with one explicit canonical parent change-ingestion path decision. Avoid open-ended analysis that delays Tasks 9 and 10.
- **Watchpoint 3 - Make F2 UI verification blocking**: Treat extension compile + sidebar/webview load + session render + basic live message flow checks as blocking pass/fail gates, not informational checks.

---

## TODOs

- [x] 1. Feature flag and grouped-helper scaffolding

  **What to do**:
  - Add the `groupedResyncActivityEnabled` gate in `src/OpenCodeClient.ts` with default `false` and a clear legacy-path fallback.
  - Introduce grouped helper primitives such as root-session lookup, related-session enumeration reuse, grouped SSE freshness, and grouped progress freshness.
  - Keep helpers read-only over existing state maps; do not introduce unnecessary new persistent state.

  **Must NOT do**:
  - Do not gate root final acceptance logic behind the feature flag.
  - Do not create a separate working directory; change files directly in `d:\0.Code\OpenCodeGUI`.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: targeted helper extraction and flag wiring in a constrained area.
  - **Skills**: `[]`
  - **Skills Evaluated but Omitted**:
    - `playwright`: not needed for helper/flag scaffolding.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 6, 7, 8, 13
  - **Blocked By**: None

  **References**:
  - `src/OpenCodeClient.ts:901` - Existing related-session grouping primitive to build on.
  - `.sisyphus/drafts/resync-evaluation.md:153` - Narrow grouped-liveness constraints and flag defaults.

  **Acceptance Criteria**:
- [x] A single flag named `groupedResyncActivityEnabled` exists with default `false`.
- [x] Grouped helper functions compile and are callable without altering legacy behavior when the flag is off.

  **QA Scenarios**:
  ```text
  Scenario: Flag off preserves legacy path
    Tool: Bash
    Preconditions: Project builds before changes
    Steps:
      1. Run the targeted test/build command covering OpenCodeClient compilation with the flag default state.
      2. Assert no grouped-only code path is required for normal startup.
    Expected Result: Build/tests pass with default flag `false`.
    Failure Indicators: Compile errors, undefined helper access, or forced grouped behavior while flag is off.
    Evidence: .sisyphus/evidence/task-1-flag-off.txt

  Scenario: Grouped helper computes from existing maps only
    Tool: Bash
    Preconditions: Helper tests or targeted runtime harness available
    Steps:
      1. Execute targeted helper test/harness with mock root + subagent map data.
      2. Assert grouped helper output matches expected max freshness / related-session set.
    Expected Result: Helpers return deterministic grouped values without new persistent state.
    Evidence: .sisyphus/evidence/task-1-helper-output.txt
  ```

  **Commit**: NO

- [x] 2. Replay source tagging contract

  **What to do**:
  - Define a clear event/source contract so replayed events can be distinguished from live SSE events.
  - Ensure replay-produced events carry a stable `source='resync'` or equivalent explicit marker through downstream handlers.
  - Document where the source marker must survive so UI/event consumers can firewall side effects.

  **Must NOT do**:
  - Do not overload ambiguous existing flags if they cannot reliably distinguish replay from live SSE.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: focused contract work with low file count.
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 8, 9, 10, 11, 12
  - **Blocked By**: None

  **References**:
  - `src/OpenCodeClient.ts:5484` - Current replay entry point where source tagging must originate.
  - `src/SidebarProvider.ts:3885` - Consumer path that must distinguish replay from live events.
  - `.sisyphus/drafts/resync-evaluation.md:175` - Replay side-effect firewall requirement.

  **Acceptance Criteria**:
- [x] Replay-emitted events carry an explicit replay source marker.
- [x] The source marker is available at the consumer points that need to suppress side effects.

  **QA Scenarios**:
  ```text
  Scenario: Replay event carries explicit source marker
    Tool: Bash
    Preconditions: Targeted replay/unit test available
    Steps:
      1. Invoke replay path for a sample persisted message.
      2. Inspect emitted event payload.
      3. Assert event contains `source='resync'` (or the chosen explicit equivalent).
    Expected Result: Replay events are source-identifiable.
    Failure Indicators: Replay path emits events indistinguishable from live SSE.
    Evidence: .sisyphus/evidence/task-2-replay-source.txt

  Scenario: Live SSE path remains untagged or differently tagged
    Tool: Bash
    Preconditions: Targeted event-normalization test available
    Steps:
      1. Feed a live SSE sample into the normal event path.
      2. Compare with replay path output.
    Expected Result: Live and replay events are distinguishable at runtime.
    Evidence: .sisyphus/evidence/task-2-live-vs-replay.txt
  ```

  **Commit**: NO

- [x] 3. Session-local subagent replay filter rules

  **What to do**:
  - Implement a subagent replay acceptance/filter path that uses the subagent session's own anchors.
  - Exclude `summary=true` and `mode=compaction` messages from subagent final acceptance/replay restoration.
  - Use conservative time-window fallback only when both current and pending subagent anchors are missing.

  **Must NOT do**:
  - Do not reuse the main-session current-turn filter verbatim for subagent sessions.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: logic is localized and rule-driven.
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 8, 11, 12
  - **Blocked By**: None

  **References**:
  - `.sisyphus/drafts/resync-evaluation.md:190` - Required subagent replay filtering rules.
  - `.sisyphus/drafts/resync-evaluation.md:123` - Main/subagent schema equivalence but semantic filtering differences.

  **Acceptance Criteria**:
- [x] Subagent replay rejects `summary=true` and `mode=compaction` messages.
- [x] Subagent replay prefers session-local anchors before time fallback.

  **QA Scenarios**:
  ```text
  Scenario: Summary and compaction messages are skipped
    Tool: Bash
    Preconditions: Filter unit tests available with persisted message fixtures
    Steps:
      1. Pass a `summary=true` subagent message through the replay filter.
      2. Pass a `mode=compaction` subagent message through the replay filter.
      3. Assert both are rejected.
    Expected Result: Non-user-facing summary/compaction messages never restore subagent state.
    Evidence: .sisyphus/evidence/task-3-summary-skip.txt

  Scenario: Session-local anchor beats time fallback
    Tool: Bash
    Preconditions: Filter test with valid and stale subagent messages
    Steps:
      1. Provide current-turn anchor and stale older messages.
      2. Assert only anchor-matching messages are accepted.
    Expected Result: Replay is scoped to the correct subagent turn.
    Evidence: .sisyphus/evidence/task-3-anchor-filter.txt
  ```

  **Commit**: NO

- [x] 4. Observability marker schema

  **What to do**:
  - Define and wire the debug markers needed to understand grouped rescue/replay behavior.
  - Ensure each marker includes `rootSessionId`, `targetSessionId`, `reason`, and event source (`sse` vs `resync`).
  - Keep log naming stable so test/evidence tooling can grep exact markers.

  **Must NOT do**:
  - Do not add noisy unstructured logs that cannot be asserted in tests.

  **Recommended Agent Profile**:
  - **Category**: `writing`
    - Reason: the main task is precise log contract definition and consistent naming.
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 6, 7, 8, 9, 12, 13
  - **Blocked By**: None

  **References**:
  - `.sisyphus/drafts/resync-evaluation.md:202` - Required observability points and fields.

  **Acceptance Criteria**:
- [x] Marker names exist for grouped activity, grouped fetch, replay accept/skip, side-effect suppression, and blocked root recovery.
- [x] Marker payloads include the minimum required diagnostic fields.

  **QA Scenarios**:
  ```text
  Scenario: Marker schema is assertable
    Tool: Bash
    Preconditions: Logging test or targeted harness available
    Steps:
      1. Trigger one grouped replay path and one replay skip path.
      2. Capture logs.
      3. Assert required marker keys are present in each line.
    Expected Result: Logs can be machine-checked without manual interpretation.
    Evidence: .sisyphus/evidence/task-4-log-schema.txt

  Scenario: Marker names remain stable
    Tool: Bash
    Preconditions: Test fixture with expected marker names
    Steps:
      1. Run the harness that emits markers.
      2. Compare emitted names against expected set.
    Expected Result: Marker contract matches the documented names.
    Evidence: .sisyphus/evidence/task-4-marker-names.txt
  ```

  **Commit**: NO

- [x] 5. Parent change-ingestion inventory and canonical replay path

  **What to do**:
  - Trace all current paths by which subagent file/change data can enter parent/session change tracking.
  - Decide and implement one canonical ingestion path for live behavior.
  - Ensure replay paths do not re-enter parent change tracking unless explicitly required for restore-only state hydration.

  **Must NOT do**:
  - Do not leave mirror + queue replay paths both active for the same replayed subagent change.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: this touches multiple connected flows and requires careful invariants.
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: 9, 10, 12
  - **Blocked By**: None

  **References**:
  - `src/OpenCodeClient.ts:2418` - Existing mirror-to-parent path.
  - `src/OpenCodeClient.ts:2431` - Existing queued subagent change path.
  - `src/SidebarProvider.ts:3885` - Consumer-side file-event side effects.
  - `.sisyphus/drafts/resync-evaluation.md:147` - Duplicate-ingestion risk.

  **Acceptance Criteria**:
- [x] There is one clearly defined live ingestion path for parent change tracking.
- [x] Replay no longer duplicates parent pending changes.

  **QA Scenarios**:
  ```text
  Scenario: Replay does not duplicate parent pending changes
    Tool: Bash
    Preconditions: Integration harness with root + subagent replay fixtures
    Steps:
      1. Capture parent pending-change count before replay.
      2. Run replay for a subagent session containing file/tool activity.
      3. Capture parent pending-change count after replay.
    Expected Result: Count does not increase due solely to replay.
    Evidence: .sisyphus/evidence/task-5-parent-dedupe.txt

  Scenario: Live path still records intended parent changes
    Tool: Bash
    Preconditions: Live-path integration fixture
    Steps:
      1. Trigger a genuine subagent file-change path in live mode.
      2. Assert parent change tracking updates exactly once.
    Expected Result: Canonical live ingestion remains functional.
    Evidence: .sisyphus/evidence/task-5-live-ingestion.txt
  ```

  **Commit**: NO

- [x] 6. Grouped rescue and settle liveness integration

  **What to do**:
  - Update rescue/settle silence checks to consult grouped activity for false-rescue suppression.
  - Keep root final progress distinct from grouped activity so subagent chatter cannot indefinitely mask a stuck root finalization.
  - Apply grouped liveness only where rescue/resync triggering needs it.

  **Must NOT do**:
  - Do not let grouped activity alone prove root final progress.

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: timer semantics and liveness boundaries are core correctness logic.
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: 12
  - **Blocked By**: 1, 4

  **References**:
  - `src/OpenCodeClient.ts:1376` - Current settle/silence logic.
  - `src/OpenCodeClient.ts:1446` - Current rescue timer logic.
  - `.sisyphus/drafts/resync-evaluation.md:155` - Grouped-liveness constraints.

  **Acceptance Criteria**:
- [x] Rescue/settle logic can treat recent subagent activity as group liveness.
- [x] Root final watchdog still expires when root-owned progress is absent long enough.

  **QA Scenarios**:
  ```text
  Scenario: Root quiet but subagent active avoids false rescue
    Tool: Bash
    Preconditions: Integration harness with controllable root/subagent event timing; flag on
    Steps:
      1. Pause root activity while continuing subagent text/tool progress inside the freshness window.
      2. Observe rescue/settle decision.
    Expected Result: No false rescue is triggered while grouped activity remains fresh.
    Evidence: .sisyphus/evidence/task-6-group-active.txt

  Scenario: Root final stall still triggers rescue despite subagent chatter
    Tool: Bash
    Preconditions: Integration harness with prolonged root-final silence; flag on
    Steps:
      1. Keep subagent events flowing without root final growth past the allowed threshold.
      2. Observe watchdog outcome.
    Expected Result: Rescue still fires once root-owned final progress remains stale long enough.
    Evidence: .sisyphus/evidence/task-6-root-stall.txt
  ```

  **Commit**: NO

- [x] 7. Root-owned `resync -> sse` recovery gate

  **What to do**:
  - Tighten root recovery so grouped/subagent activity can keep the turn considered alive but cannot directly switch the root session from `resync` back to `sse`.
  - Require root-owned freshness evidence such as root final text growth or root acceptance progress.

  **Must NOT do**:
  - Do not allow subagent SSE alone to recover the root session mode.

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: this is a subtle state-machine boundary with direct correctness impact.
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: 12, 13
  - **Blocked By**: 1, 4

  **References**:
  - `src/OpenCodeClient.ts:1324` - Current broad resync recovery trigger.
  - `.sisyphus/drafts/resync-evaluation.md:166` - Root-owned recovery requirement.

  **Acceptance Criteria**:
- [x] Root leaves `resync` only on root-owned evidence.
- [x] Subagent-only SSE activity cannot flip root mode back to `sse`.

  **QA Scenarios**:
  ```text
  Scenario: Subagent-only SSE does not recover root
    Tool: Bash
    Preconditions: Root in resync, subagent receiving fresh SSE, flag on
    Steps:
      1. Hold root final text/static state unchanged.
      2. Feed subagent events through the grouped path.
      3. Inspect root mode.
    Expected Result: Root remains in `resync` until root-owned freshness evidence arrives.
    Evidence: .sisyphus/evidence/task-7-subagent-cannot-recover-root.txt

  Scenario: Root-owned evidence recovers root
    Tool: Bash
    Preconditions: Root in resync with grouped mode on
    Steps:
      1. Deliver root final text growth or root final acceptance evidence.
      2. Inspect state transition.
    Expected Result: Root transitions back to `sse` only after root-owned evidence.
    Evidence: .sisyphus/evidence/task-7-root-recovery.txt
  ```

  **Commit**: NO

- [x] 8. Root-coordinated per-session replay orchestration

  **What to do**:
  - Expand resync replay from single-session replay to root-triggered replay over root + related subagent sessions.
  - Preserve per-session fetch, per-session filtering, per-session stale checks, and per-session final acceptance handling.
  - Keep replay ordering session-scoped; do not create a merged global replay order.

  **Must NOT do**:
  - Do not flatten root and subagent message streams into one chronological stream.

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: this is the center of the redesign and depends on multiple invariants.
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: 9, 10, 11, 12, 13
  - **Blocked By**: 1, 2, 3, 4

  **References**:
  - `src/OpenCodeClient.ts:5484` - Current single-session replay entry.
  - `src/OpenCodeClient.ts:1293` - Existing per-session epoch / stale-run guard.
  - `.sisyphus/drafts/resync-evaluation.md:131` - Replay implications from captured message schema.
  - `.sisyphus/drafts/resync-evaluation.md:142` - Group replay race risk.

  **Acceptance Criteria**:
- [x] Root replay iterates root + related subagent sessions without merged global ordering.
- [x] Existing stale/epoch protections still reject stale replay runs per session.

  **QA Scenarios**:
  ```text
  Scenario: Group replay rehydrates root and subagent sessions separately
    Tool: Bash
    Preconditions: Persisted message fixtures for root + two subagents; flag on
    Steps:
      1. Trigger grouped replay.
      2. Capture replay fetch order and emitted event targets.
      3. Assert each session is fetched and replayed independently.
    Expected Result: Replay is root-coordinated but session-local in filtering and acceptance.
    Evidence: .sisyphus/evidence/task-8-group-replay.txt

  Scenario: Stale per-session replay run is dropped
    Tool: Bash
    Preconditions: Harness can simulate overlapping replay epochs
    Steps:
      1. Start replay for one session.
      2. Invalidate the run by triggering a newer epoch for that same session.
      3. Observe stale-drop handling.
    Expected Result: Stale replay output is ignored without corrupting other session lanes.
    Evidence: .sisyphus/evidence/task-8-stale-drop.txt
  ```

  **Commit**: NO

- [x] 9. Replay side-effect firewall in `SidebarProvider`

  **What to do**:
  - Use replay source tagging to suppress imperative side effects when restoring subagent replay state.
  - Allow restore-only state updates such as latest text, latest tool, latest tool input, and done/final status.
  - Block replay-triggered queueing, diff opening, restore locks, prompt/plan cards, and similar imperative flows.

  **Must NOT do**:
  - Do not suppress legitimate live SSE side effects.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: this is consumer-path logic with strong correctness and UX implications.
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocks**: 10, 12, 13
  - **Blocked By**: 2, 4, 5, 8

  **References**:
  - `src/SidebarProvider.ts:3885` - Current side-effectful subagent file/tool handling.
  - `.sisyphus/drafts/resync-evaluation.md:175` - Restore-only replay firewall requirement.

  **Acceptance Criteria**:
- [x] Replay can restore subagent card state.
- [x] Replay no longer triggers `queueSubagentChanges(...)`, auto-open diff, change-list ingestion, or restore-lock side effects.

  **QA Scenarios**:
  ```text
  Scenario: Replay restores subagent card state only
    Tool: Bash
    Preconditions: Replay fixture with subagent text/tool/files activity; flag on
    Steps:
      1. Trigger grouped replay.
      2. Inspect restored subagent state.
      3. Verify latestText/latestTool/latestToolInput/done state are present.
    Expected Result: UI state is restored without imperative actions.
    Evidence: .sisyphus/evidence/task-9-restore-only.txt

  Scenario: Replay suppresses imperative side effects
    Tool: Bash
    Preconditions: Instrumentation or log assertions around queue/diff/lock paths
    Steps:
      1. Trigger replay over subagent messages containing file/tool activity.
      2. Assert side-effect markers show suppression and no queue/diff/lock path fires.
    Expected Result: Replay side-effect firewall blocks all listed imperative behaviors.
    Evidence: .sisyphus/evidence/task-9-suppressed-effects.txt
  ```

  **Commit**: NO

- [x] 10. Duplicate-ingestion prevention and replay idempotency

  **What to do**:
  - Enforce idempotent replay handling so the same replayed message/part does not re-apply state transitions or parent-ingestion behavior.
  - Use a deterministic dedupe identity such as `sessionID + messageID + part.id` where needed.
  - Make sure replay idempotency works with the canonical parent-ingestion path chosen earlier.

  **Must NOT do**:
  - Do not rely on brittle timing assumptions alone to prevent duplicate replay effects.

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: dedupe and idempotency sit at the intersection of replay and state mutation.
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: 12, 13
  - **Blocked By**: 2, 5, 8, 9

  **References**:
  - `.sisyphus/drafts/resync-evaluation.md:145` - Group replay race risk.
  - `.sisyphus/drafts/resync-evaluation.md:147` - Duplicate parent-ingestion risk.

  **Acceptance Criteria**:
- [x] Replaying the same persisted event twice does not double-apply replay state or parent change tracking.
- [x] Dedupe identity is stable across replay passes for the same session message part.

  **QA Scenarios**:
  ```text
  Scenario: Duplicate replay pass is idempotent
    Tool: Bash
    Preconditions: Replay harness with repeatable persisted payloads
    Steps:
      1. Run replay for a session fixture.
      2. Run the same replay again without resetting the underlying persisted payload.
      3. Compare resulting state and parent-ingestion counts.
    Expected Result: Second replay makes no duplicate observable changes.
    Evidence: .sisyphus/evidence/task-10-idempotent-replay.txt

  Scenario: Dedupe key is session-local and stable
    Tool: Bash
    Preconditions: Fixtures with same message IDs across different sessions if available
    Steps:
      1. Feed replay fixtures from two different sessions.
      2. Assert dedupe does not cross-contaminate sessions.
    Expected Result: Dedupe works per session, not globally across unrelated sessions.
    Evidence: .sisyphus/evidence/task-10-dedupe-key.txt
  ```

  **Commit**: NO

- [x] 11. Automated tests for grouped liveness and replay filtering

  **What to do**:
  - Add or extend automated tests covering grouped freshness helpers, root-owned recovery gating, subagent replay filtering, and replay-source tagging.
  - Cover both flag-off legacy behavior and flag-on grouped behavior.

  **Must NOT do**:
  - Do not rely solely on manual inspection for core helper/filter correctness.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: test additions span multiple behaviors and need careful fixtures.
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: 12
  - **Blocked By**: 2, 3, 8

  **References**:
  - `.sisyphus/drafts/resync-evaluation.md:190` - Required replay filter rules.
  - `.sisyphus/drafts/resync-evaluation.md:155` - Grouped liveness constraints.
  - `.sisyphus/drafts/resync-evaluation.md:202` - Observability marker expectations.

  **Acceptance Criteria**:
- [x] Automated tests cover grouped liveness positive/negative cases.
- [x] Automated tests cover replay filter skip/accept cases.
- [x] Automated tests cover replay source tagging presence.

  **QA Scenarios**:
  ```text
  Scenario: Targeted grouped-resync test suite passes
    Tool: Bash
    Preconditions: Tests added and runnable from repo root
    Steps:
      1. Run the targeted grouped-resync test command.
      2. Capture pass/fail counts.
    Expected Result: All grouped-resync logic tests pass.
    Evidence: .sisyphus/evidence/task-11-test-suite.txt

  Scenario: Flag-off legacy behavior test passes
    Tool: Bash
    Preconditions: Tests include flag-off path
    Steps:
      1. Run the targeted tests with `groupedResyncActivityEnabled=false`.
      2. Assert legacy session-local expectations pass.
    Expected Result: The new work does not break legacy mode.
    Evidence: .sisyphus/evidence/task-11-legacy-mode.txt
  ```

  **Commit**: NO

- [x] 12. Integration verification for replay suppression and grouped rescue behavior

  **What to do**:
  - Build integration-level verification that exercises root quiet + subagent active behavior, grouped replay restoration, and suppression of replay side effects.
  - Assert behavior through logs/state rather than manual observation alone.

  **Must NOT do**:
  - Do not ship grouped logic without one end-to-end automated verification path.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: integration verification needs broad coordination across helpers, replay, and UI state consumers.
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: 13, F1-F4
  - **Blocked By**: 2, 3, 5, 6, 7, 8, 9, 10, 11

  **References**:
  - `.sisyphus/drafts/resync-evaluation.md:142` - Risk inventory that must be covered.
  - `.sisyphus/drafts/resync-evaluation.md:203` - Required debug markers for assertions.

  **Acceptance Criteria**:
- [x] Integration verification covers false-rescue suppression, root-owned recovery, and replay side-effect suppression.
- [x] Evidence logs show grouped markers and suppressed-side-effect markers in the expected places.

  **QA Scenarios**:
  ```text
  Scenario: Root quiet plus subagent activity behaves correctly
    Tool: Bash
    Preconditions: Integration harness can simulate root/subagent timing; flag on
    Steps:
      1. Create a root-quiet/subagent-active scenario.
      2. Capture logs and state transitions.
      3. Assert no false rescue occurs before the grouped freshness window expires.
    Expected Result: Grouped mode suppresses false rescue but does not incorrectly resolve root final.
    Evidence: .sisyphus/evidence/task-12-grouped-rescue.txt

  Scenario: Replay suppression markers are emitted
    Tool: Bash
    Preconditions: Replay fixture with subagent file/tool activity; flag on
    Steps:
      1. Run grouped replay.
      2. Grep logs for `resync.subagent.sideeffect.suppressed` and related markers.
    Expected Result: Suppression is observable and corresponds to blocked imperative paths.
    Evidence: .sisyphus/evidence/task-12-suppression-markers.txt
  ```

  **Commit**: NO

- [x] 13. Rollout and rollback validation under feature flag

  **What to do**:
  - Validate grouped mode under the default-off flag model and confirm rollback behavior is immediate and safe.
  - Verify that automatic fallback expectations are documented and testable without new persistent cleanup steps.

  **Must NOT do**:
  - Do not require data migration or restart-only rollback just to disable grouped behavior.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: this task validates configuration and operational guardrails rather than inventing new architecture.
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3
  - **Blocks**: F1-F4
  - **Blocked By**: 1, 4, 7, 8, 9, 10, 12

  **References**:
  - `.sisyphus/drafts/resync-evaluation.md:224` - Feature-flag and fallback defaults.
  - `.sisyphus/drafts/resync-evaluation.md:239` - Verified automatic fallback preference.

  **Acceptance Criteria**:
- [x] Flag-off mode preserves legacy behavior.
- [x] Disabling the flag after grouped-mode issues returns behavior to session-local logic on the next rescue/settle cycle.

  **QA Scenarios**:
  ```text
  Scenario: Flag-off legacy mode still works
    Tool: Bash
    Preconditions: Integration test/harness with grouped flag configurable
    Steps:
      1. Run the grouped-resync verification path with the flag off.
      2. Assert behavior matches legacy session-local expectations.
    Expected Result: No grouped replay or grouped liveness behavior occurs.
    Evidence: .sisyphus/evidence/task-13-flag-off.txt

  Scenario: Rollback to legacy mode is immediate
    Tool: Bash
    Preconditions: Grouped mode on, then toggled off mid-validation
    Steps:
      1. Enable grouped mode and trigger grouped behavior.
      2. Disable the flag.
      3. Trigger the next rescue/settle cycle.
    Expected Result: Behavior falls back to legacy session-local flow without restart or cleanup migration.
    Evidence: .sisyphus/evidence/task-13-rollback.txt
  ```

  **Commit**: NO

---

## Final Verification Wave

> 4 review agents run in parallel after implementation. All must approve; any rejection must be fixed and re-run.

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read the plan and verify: grouped liveness only affects rescue/resync decisions; root final acceptance remains root-owned; replay source tagging exists; replay side effects are suppressed for `source='resync'`; subagent replay filtering is session-local.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT`

- [x] F2. **Code Quality Review** — `unspecified-high`
  Run build/test/lint commands used by the repo and inspect changed files for accidental broad refactors, duplicated logic, weak guards, or dead logging. Verify no temp working directory assumptions were introduced. Additionally verify the extension compiles, the sidebar/webview loads without errors, sessions render, and a basic live message flow still works.
  Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Tests [N pass/N fail] | VERDICT`

- [x] F3. **Real QA Execution** — `unspecified-high`
  Execute every task QA scenario, including grouped activity during root silence, replay of subagent sessions, rollback with flag off, and duplicate-side-effect checks. Save evidence under `.sisyphus/evidence/final-qa/`.
  Output: `Scenarios [N/N pass] | Integration [N/N] | Edge Cases [N tested] | VERDICT`

- [x] F4. **Scope Fidelity Check** — `deep`
  Compare actual changes to plan scope. Reject if the implementation changes final acceptance semantics, introduces merged replay ordering, leaks replay side effects into live paths, or modifies code unrelated to resync/rescue/replay. Diff each changed file and verify every hunk is traceable to a plan task.
  Output: `Tasks [N/N compliant] | Contamination [CLEAN/N issues] | VERDICT`

---

## Commit Strategy

- Use small commits aligned to waves where practical; each commit message should reflect why the change exists, not just what changed.
- Do not commit generated evidence artifacts unless the repo already tracks that specific path by convention.

---

## Success Criteria

### Verification Commands
```bash
# Use the repo's existing test/build commands plus any targeted test command(s)
# added for grouped-resync logic. Expected: all pass with grouped flag on in test
# scenarios and legacy behavior preserved with flag off.
```

### Final Checklist
- [x] Grouped liveness affects rescue/resync only
- [x] Root `resync -> sse` recovery stays root-owned
- [x] Subagent replay is per-session and session-local
- [x] Replay side effects are suppressed for `source='resync'`
- [x] Parent change ingestion is not duplicated during replay
- [x] Automatic fallback path remains available via `groupedResyncActivityEnabled=false`
- [x] UI loads normally - sidebar renders, session list populates, and live message flow works without regression
