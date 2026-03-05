# Stabilize Chat Rendering and Diff Timing

## TL;DR

> **Quick Summary**: Fix turn orchestration and UI rendering regressions so subagent/main-agent diffs anchor correctly, change-list appears only after final assistant message, tmp text never stacks into final text, and streaming/subagent typography matches intended rules.
>
> **Deliverables**:
> - Reliable diff/change-list emission order
> - Parent+subagent session-aware diff gating
> - Deterministic tmp->final key upgrade behavior
> - Correct streaming/subagent CSS typography and spacing
>
> **Estimated Effort**: Medium
> **Parallel Execution**: YES - 3 waves + final verification
> **Critical Path**: T1 -> T5 -> T8 -> F1-F4

---

## Context

### Original Request
User requested a single plan to fix multiple chat regressions: subagent edits not showing code diff, change-list appearing before final message, internal commit/change-list anchor binding validation, final message still stacking tmp text, plus style regressions after switching main-agent temporary text from cumulative append to latest-state replace.

### Interview Summary
**Key Discussions**:
- Main-agent temporary text behavior was intentionally changed to latest-state replace, consistent with subagent behavior.
- Diff gating should treat parent and subagent session IDs as one logical group.
- Change-list must be emitted only after finalization.
- Streaming text should be non-italic, tool-use should be italic, subagent inline spacing should match final-message style density.

**Research Findings**:
- `src/SidebarProvider.ts:606` contains diff skip gate.
- `src/SidebarProvider.ts:3537` and `src/SidebarProvider.ts:3778` emit change-list during file events (premature).
- `src/SidebarProvider.ts:1103` emits change-list in finalize path (desired path).
- `src/OpenCodeClient.ts:4286` skips `session.diff` when no writes found for that session.
- `media/main.css:1793`, `media/main.css:1902`, `media/main.css:1910` are key typography selectors.

### Metis Review
**Identified Gaps (addressed in this plan)**:
- Add explicit guardrail for subagent `session.diff` ID translation/association to parent session gating.
- Prevent mid-stream change-list emissions to avoid stale anchors.
- Add explicit fallback and segment-reset rules for tmp->final upgrade race.
- Scope CSS overrides to streaming context to avoid final-message regressions.

---

## Work Objectives

### Core Objective
Restore deterministic turn rendering and diff/change-list sequencing for main agent + subagent flows while preserving the new latest-state replace behavior for temporary text.

### Concrete Deliverables
- Updated extension orchestration in `src/SidebarProvider.ts` and `src/OpenCodeClient.ts` for session-aware diff gating and finalization-only change-list emission.
- Updated webview rendering behavior in `media/main.js` to prevent tmp/final stacking and ensure reliable key upgrades.
- Updated styles in `media/main.css` for intended italic/normal rules and compact subagent spacing.
- QA evidence artifacts under `.sisyphus/evidence/` for each task scenario.

### Definition of Done
- [ ] All planned tasks complete with evidence files.
- [ ] No premature change-list before final assistant message.
- [ ] Subagent file writes can trigger valid diff/change-list in parent turn.
- [ ] Final assistant text appears once (no stacking).
- [ ] Streaming/subagent typography matches requested behavior.

### Must Have
- Main and subagent session IDs treated as one logical diff-check group.
- Change-list emitted only after finalization sequence.
- Internal change-list anchor bound to final `msg_*` assistant ID.
- Executor performs all edits directly in current working directory (no new working directory).

### Must NOT Have (Guardrails)
- No mid-stream change-list system message insertion.
- No broad refactor of unrelated chat timeline architecture.
- No manual-only acceptance criteria.
- No workaround that reverts main-agent latest-state replace design.

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — all verification is agent-executed.

### Test Decision
- **Infrastructure exists**: YES (TypeScript project with compile checks)
- **Automated tests**: Tests-after (targeted checks + build/type verification)
- **Framework**: `npx tsc --noEmit` + log/order assertions via scripted runs/grep

### QA Policy
- Frontend/webview checks: Playwright skill where feasible; otherwise deterministic log assertions from extension debug output.
- API/CLI checks: Bash commands for compile and log pattern assertions.
- Evidence path convention: `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`

---

## Execution Strategy

### Parallel Execution Waves

Wave 1 (Start immediately — foundation and independent fixes):
- T1 Session-group diff gating model in client
- T2 Subagent->parent session association plumbing in provider
- T3 Webview tmp->final upgrade fallback and segment-reset logic
- T4 Streaming/subagent italic selector corrections
- T5 Subagent spacing normalization aligned with final-message style

Wave 2 (After Wave 1 — orchestration and anchor timing):
- T6 Remove/gate mid-stream change-list emissions
- T7 Finalization anchor readiness check and retry path
- T8 Internal commit/change-list to assistant ID binding validation path

Wave 3 (After Wave 2 — integration hardening):
- T9 Multi-subagent concurrent-write aggregation verification hooks
- T10 Late-event grace handling (post-finalization diff event safety)
- T11 Regression guard assertions for latest-state replace behavior

Wave FINAL (Parallel independent review):
- F1 Plan compliance audit
- F2 Code quality review
- F3 Scenario QA replay
- F4 Scope fidelity check

### Dependency Matrix
- T1: none -> T6, T8, T9
- T2: none -> T6, T9
- T3: none -> T7, T11
- T4: none -> T11
- T5: none -> T11
- T6: T1, T2 -> T7, T8, T10
- T7: T3, T6 -> T8, T10
- T8: T1, T6, T7 -> T10
- T9: T1, T2 -> T10
- T10: T6, T7, T8, T9 -> F1-F4
- T11: T3, T4, T5 -> F1-F4

### Agent Dispatch Summary
- Wave 1: T1 `unspecified-high`, T2 `quick`, T3 `unspecified-high`, T4 `quick`, T5 `quick`
- Wave 2: T6 `quick`, T7 `unspecified-high`, T8 `unspecified-high`
- Wave 3: T9 `unspecified-high`, T10 `deep`, T11 `quick`
- Final: F1 `oracle`, F2 `unspecified-high`, F3 `unspecified-high`, F4 `deep`

---

## TODOs

- [x] 1. Add session-group diff gating primitives in client

  **What to do**:
  - Add parent/subagent association store in `src/OpenCodeClient.ts` and helper APIs to query related session IDs.
  - Add grouped gating helpers so write checks can pass when either parent or any mapped subagent has writes/pending changes.
  - Keep behavior backward compatible for sessions without subagents.

  **Must NOT do**:
  - Do not change non-diff event translation behavior.
  - Do not remove existing single-session checks; wrap them.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: stateful event orchestration with regression risk.
  - **Skills**: `[]`
  - **Skills Evaluated but Omitted**:
    - `git-master`: no git history operation required.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with T2-T5)
  - **Blocks**: T6, T8, T9
  - **Blocked By**: None

  **References**:
  - `src/OpenCodeClient.ts:747` - existing per-session write gate API (`hasActiveTurnWrites`).
  - `src/OpenCodeClient.ts:756` - existing pending-change gate (`hasPendingTurnChanges`).
  - `src/OpenCodeClient.ts:4280` - `session.diff` skip path using session-local gating.

  **Why Each Reference Matters**:
  - These are the exact gate chokepoints where grouped session logic must be introduced.

  **Acceptance Criteria**:
  - [ ] Grouped helper APIs exist and are used by `session.diff` skip checks.
  - [ ] `npx tsc --noEmit` passes.

  **QA Scenarios**:
  ```text
  Scenario: Parent/subagent grouped gate passes
    Tool: Bash
    Preconditions: Build compiles with new helper wiring
    Steps:
      1. Trigger a session where subagent produces file changes while parent has active turn
      2. Inspect debug log for absence of "session.diff.skip ... reason=no-turn-writes" on mapped subagent event
      3. Assert grouped gate path log indicates parent/subagent association considered
    Expected Result: Subagent diff is not skipped due to session-local mismatch
    Failure Indicators: skip log persists on subagent diff events
    Evidence: .sisyphus/evidence/task-1-grouped-gate.log

  Scenario: Non-subagent session remains unchanged
    Tool: Bash
    Preconditions: Plain main-agent turn with no subagent
    Steps:
      1. Run a turn with no subagent activity
      2. Confirm diff gating behavior matches prior baseline for single session
    Expected Result: No regression in single-session gating
    Evidence: .sisyphus/evidence/task-1-single-session.log
  ```

- [x] 2. Register and clear subagent-parent session mapping in provider

  **What to do**:
  - On subagent session discovery, register mapping in client (subagent -> parent).
  - On subagent completion/cleanup, clear mapping to avoid stale associations.
  - Keep mapping updates aligned with existing `activeSubagentSessionIds` lifecycle.

  **Must NOT do**:
  - Do not alter user-facing subagent status payload shape.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: targeted lifecycle plumbing in known block.
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: T6, T9
  - **Blocked By**: None

  **References**:
  - `src/SidebarProvider.ts:105` - active subagent set.
  - `src/SidebarProvider.ts:3360` - subagent add path.
  - `src/SidebarProvider.ts:1115` - cleanup path.

  **Why Each Reference Matters**:
  - These lifecycle points are authoritative for mapping creation/removal.

  **Acceptance Criteria**:
  - [ ] Mapping register call on subagent creation.
  - [ ] Mapping clear call on subagent cleanup.
  - [ ] `npx tsc --noEmit` passes.

  **QA Scenarios**:
  ```text
  Scenario: Mapping created and removed correctly
    Tool: Bash
    Preconditions: One turn with at least one subagent
    Steps:
      1. Start turn that spawns subagent
      2. Verify debug logs show mapping add for subagent session
      3. Finish turn and verify mapping clear log
    Expected Result: No stale mapping remains after cleanup
    Evidence: .sisyphus/evidence/task-2-mapping-lifecycle.log

  Scenario: Multiple subagents map to same parent
    Tool: Bash
    Preconditions: Turn spawns >=2 subagents
    Steps:
      1. Capture mapping logs for all subagents
      2. Verify all map to same current parent session
    Expected Result: Correct parent association for each subagent
    Evidence: .sisyphus/evidence/task-2-multi-map.log
  ```

- [x] 3. Hardening tmp->final assistant key upgrade and segment reset

  **What to do**:
  - In `media/main.js`, add fallback upgrade path when new `msg_*` key exists but index map is not ready.
  - In assistant meta replace path, reset `currentSegment` when replacing full latest text.
  - Preserve latest-state replace model for temporary text.

  **Must NOT do**:
  - Do not revert to cumulative append for main-agent temporary text.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: race-prone UI state transitions.
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: T7, T11
  - **Blocked By**: None

  **References**:
  - `media/main.js:1584` - `attemptAssistantUpgrade` decision tree.
  - `media/main.js:4341` - assistant meta replace assignment.
  - `media/main.js:2866` - completed-vs-streaming text render branch.

  **Why Each Reference Matters**:
  - They directly control tmp/final identity swap and potential text stacking.

  **Acceptance Criteria**:
  - [ ] tmp->msg upgrade succeeds when index map is temporarily missing.
  - [ ] No duplicated final text after turn completion.

  **QA Scenarios**:
  ```text
  Scenario: tmp key upgrades to msg key without stacking
    Tool: Bash
    Preconditions: Streaming turn with temp message and delayed messageIndexMap
    Steps:
      1. Run turn and capture debug logs around ASSIST_UPGRADE
      2. Confirm upgrade reason indicates fallback path (not no-change)
      3. Validate rendered final content appears exactly once
    Expected Result: tmp message replaced by final msg identity and single final text
    Failure Indicators: ASSIST_UPGRADE reason=no-change or duplicated final text
    Evidence: .sisyphus/evidence/task-3-upgrade-fallback.log

  Scenario: Replace mode remains active for temporary text
    Tool: Bash
    Preconditions: Streaming assistant output with successive meta updates
    Steps:
      1. Observe successive temporary text updates
      2. Confirm each update replaces current body rather than appending
    Expected Result: Latest-state text only
    Evidence: .sisyphus/evidence/task-3-replace-mode.log
  ```

- [x] 4. Correct streaming and tool-use italic rules

  **What to do**:
  - Scope non-italic `em` override to streaming context so temporary text is non-italic.
  - Ensure tool-use rows keep italic style and are not overridden by broader selectors.
  - Keep final non-streaming assistant text emphasis behavior unaffected.

  **Must NOT do**:
  - Do not globally disable italics for all message content.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: localized CSS selector corrections.
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: T11
  - **Blocked By**: None

  **References**:
  - `media/main.css:1793` - current streaming/subagent italic override.
  - `media/main.css:1902` - `.subagent-inline-tool` rule.
  - `media/main.js:2964` - tool row class assignment.

  **Why Each Reference Matters**:
  - They define where italic behavior is requested and where it is rendered.

  **Acceptance Criteria**:
  - [ ] Streaming temp text renders non-italic.
  - [ ] Tool-use text renders italic.
  - [ ] Final non-streaming emphasis remains intact.

  **QA Scenarios**:
  ```text
  Scenario: Streaming text non-italic, tool-use italic
    Tool: Playwright
    Preconditions: Active streaming turn with visible subagent tool row
    Steps:
      1. Open chat UI and trigger streaming turn
      2. Inspect computed style for `.message.streaming .message-content em` => normal
      3. Inspect computed style for `.subagent-inline-tool` => italic
    Expected Result: Rules match requested typography behavior
    Evidence: .sisyphus/evidence/task-4-typography.png

  Scenario: Final message emphasis unaffected
    Tool: Playwright
    Preconditions: Completed assistant message with markdown emphasis
    Steps:
      1. Wait until message leaves streaming state
      2. Verify non-streaming emphasized text remains intended style
    Expected Result: No global italic suppression regression
    Evidence: .sisyphus/evidence/task-4-final-emphasis.png
  ```

- [x] 5. Normalize subagent inline text spacing to match final-message style

  **What to do**:
  - Replace `white-space: pre-wrap` in `.subagent-inline-text` with `white-space: normal`.
  - Apply compact block spacing rules similar to final message content for subagent inline text.
  - Ensure list/item spacing is not overly tall and code blocks remain readable.

  **Must NOT do**:
  - Do not change global `.message .message-content` spacing rules.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: localized CSS adjustments.
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: T11
  - **Blocked By**: None

  **References**:
  - `media/main.css:1910` - `.subagent-inline-text` base rules.
  - `media/main.css:1920` - existing subagent spacing normalization.
  - `media/main.css:1680` - final message spacing baseline.

  **Why Each Reference Matters**:
  - These selectors are the direct levers for subagent inline spacing density.

  **Acceptance Criteria**:
  - [ ] Subagent inline text does not show excessive vertical gaps.
  - [ ] Code blocks and lists remain readable.

  **QA Scenarios**:
  ```text
  Scenario: Subagent spacing compact and consistent
    Tool: Playwright
    Preconditions: Subagent inline text contains paragraphs, lists, and code
    Steps:
      1. Trigger subagent with multi-line output
      2. Inspect spacing between paragraphs and list items
      3. Confirm code block spacing unaffected
    Expected Result: Spacing resembles final message density
    Evidence: .sisyphus/evidence/task-5-subagent-spacing.png

  Scenario: No regressions in normal messages
    Tool: Playwright
    Preconditions: Normal assistant messages present
    Steps:
      1. Verify normal assistant message spacing unchanged
    Expected Result: Only subagent inline text affected
    Evidence: .sisyphus/evidence/task-5-normal-spacing.png
  ```

- [x] 6. Remove/gate mid-stream change-list emission

  **What to do**:
  - Remove or gate `emitDiffFileList()` calls from `files` event handlers (subagent and main).
  - Keep finalization call only in `chatDone` flow.

  **Must NOT do**:
  - Do not remove finalization emit at `src/SidebarProvider.ts:1103`.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: narrow change to callsites.
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2
  - **Blocks**: T7, T8, T10
  - **Blocked By**: T1, T2

  **References**:
  - `src/SidebarProvider.ts:3537` - subagent files handler emit.
  - `src/SidebarProvider.ts:3778` - main files handler emit.
  - `src/SidebarProvider.ts:1103` - finalization emit.

  **Acceptance Criteria**:
  - [ ] No `[EXT][DIFF_LIST]` logs appear before `finalize.order | phase=upgrade-done`.

  **QA Scenarios**:
  ```text
  Scenario: Change-list appears only after final message
    Tool: Bash
    Preconditions: Turn with file edits
    Steps:
      1. Capture debug logs during turn
      2. Verify no diff list log before finalize upgrade done
    Expected Result: Change-list emitted only after finalization
    Evidence: .sisyphus/evidence/task-6-change-list-timing.log
  ```

- [x] 7. Anchor readiness check and retry for change-list emission

  **What to do**:
  - Add a short retry loop or deferred emission when `anchorMessageId` is missing or `tmp:`.
  - Ensure change-list binds to final `msg_*` assistant ID.

  **Must NOT do**:
  - Do not create infinite retries or blocking waits.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: timing-sensitive orchestration.
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2
  - **Blocks**: T8, T10
  - **Blocked By**: T3, T6

  **References**:
  - `src/SidebarProvider.ts:637` - anchor retrieval in emit.
  - `src/SidebarProvider.ts:1098` - upgrade completion boundary.

  **Acceptance Criteria**:
  - [ ] `[EXT][DIFF_LIST]` log shows `anchor=msg_*`.

  **QA Scenarios**:
  ```text
  Scenario: Anchor resolves to final assistant ID
    Tool: Bash
    Preconditions: Turn with file edits and delayed upgrade
    Steps:
      1. Capture diff list emission log
      2. Verify anchor is msg_* and not tmp/local/null
    Expected Result: Anchor is final assistant message ID
    Evidence: .sisyphus/evidence/task-7-anchor-ready.log
  ```

- [x] 8. Validate internal commit/change-list binding to assistant message ID

  **What to do**:
  - Ensure `changeListId` uses internal repo HEAD commit and is associated with final `msg_*` anchor.
  - Add debug trace proving commit hash and anchor ID were bound post-finalization.

  **Must NOT do**:
  - Do not change commit generation logic in GitUndo.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: linking internal repo state to UI artifacts.
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 2
  - **Blocks**: T10
  - **Blocked By**: T1, T6, T7

  **References**:
  - `src/SidebarProvider.ts:638` - changeListId creation.
  - `src/SidebarProvider.ts:652` - upsertChangeList binding with anchor.

  **Acceptance Criteria**:
  - [ ] Log shows commit hash bound to `msg_*` anchor after finalization.

  **QA Scenarios**:
  ```text
  Scenario: Commit hash bound to final assistant message
    Tool: Bash
    Preconditions: Turn with internal git commit creation
    Steps:
      1. Capture `[EXT][DIFF_LIST]` log
      2. Confirm `changeListId` includes commit hash and anchor=msg_*
    Expected Result: commit hash bound to final assistant ID
    Evidence: .sisyphus/evidence/task-8-commit-anchor.log
  ```

- [x] 9. Multi-subagent concurrent write aggregation verification hooks

  **What to do**:
  - Ensure grouped gating considers multiple subagent sessions simultaneously.
  - Add debug log indicating how many related sessions contributed to a diff decision.

  **Must NOT do**:
  - Do not alter subagent status UI payload.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: concurrency and aggregation.
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3
  - **Blocks**: T10
  - **Blocked By**: T1, T2

  **References**:
  - `src/SidebarProvider.ts:3360` - subagent tracking.
  - `src/OpenCodeClient.ts:747` - gating checks.

  **Acceptance Criteria**:
  - [ ] Logs indicate multiple related sessions are considered in diff gating.

  **QA Scenarios**:
  ```text
  Scenario: Multiple subagents do not break diff gating
    Tool: Bash
    Preconditions: Turn spawns 2+ subagents with file edits
    Steps:
      1. Capture gating logs
      2. Verify no diff skip due to session mismatch
    Expected Result: Grouped gating passes for multi-subagent
    Evidence: .sisyphus/evidence/task-9-multi-subagent.log
  ```

- [x] 10. Late-event grace handling for post-finalization diff events

  **What to do**:
  - Add a short grace window or re-check logic so late-arriving diff events after `finishTurn` do not get silently dropped.
  - Ensure no duplicate change-list emission occurs.

  **Must NOT do**:
  - Do not extend turn lifetimes indefinitely.

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: timing and state cleanup interplay.
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3
  - **Blocks**: F1-F4
  - **Blocked By**: T6, T7, T8, T9

  **References**:
  - `src/OpenCodeClient.ts:708` - turn finalization cleanup.
  - `src/SidebarProvider.ts:1106` - finishTurn invocation.

  **Acceptance Criteria**:
  - [ ] Late diff events within grace window still render change-list once.
  - [ ] No duplicate change-list entries.

  **QA Scenarios**:
  ```text
  Scenario: Late diff event after finishTurn
    Tool: Bash
    Preconditions: Simulated late session.diff event after finalize
    Steps:
      1. Trigger late diff event
      2. Verify change-list appears once
    Expected Result: Late diff handled once, no duplication
    Evidence: .sisyphus/evidence/task-10-late-diff.log
  ```

- [x] 11. Regression guard for latest-state replace behavior

  **What to do**:
  - Add an explicit log or assertion path to confirm `assistantMessageMeta` replace behavior remains in effect for main agent.
  - Ensure no append logic reintroduced.

  **Must NOT do**:
  - Do not change the main-agent latest-state replace behavior.

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: lightweight instrumentation check.
  - **Skills**: `[]`

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Wave 3
  - **Blocks**: F1-F4
  - **Blocked By**: T3, T4, T5

  **References**:
  - `media/main.js:4341` - assistant meta replace logic.
  - `media/main.js:4345` - latest text handling branch.

  **Acceptance Criteria**:
  - [ ] Logs confirm replace behavior for temporary text updates.

  **QA Scenarios**:
  ```text
  Scenario: Replace mode preserved for main agent temp text
    Tool: Bash
    Preconditions: Streaming updates with assistantMessageMeta
    Steps:
      1. Capture logs on each meta update
      2. Confirm replace-mode marker present
    Expected Result: Replace behavior unchanged
    Evidence: .sisyphus/evidence/task-11-replace-guard.log
  ```

---

## Final Verification Wave (MANDATORY)

- [ ] F1. Plan Compliance Audit (`oracle`)
- [ ] F2. Code Quality Review (`unspecified-high`)
- [ ] F3. Scenario QA Replay (`unspecified-high`)
- [ ] F4. Scope Fidelity Check (`deep`)

---

## Commit Strategy

- Group 1: session/diff orchestration changes (`src/OpenCodeClient.ts`, `src/SidebarProvider.ts`)
- Group 2: webview rendering/style changes (`media/main.js`, `media/main.css`)
- Suggested message style: `fix(chat): stabilize diff timing and streaming/final rendering`

---

## Success Criteria

### Verification Commands
```bash
npx tsc --noEmit
```

### Final Checklist
- [ ] All Must Have items present
- [ ] All Must NOT Have items absent
- [ ] Evidence artifacts produced for every task scenario
