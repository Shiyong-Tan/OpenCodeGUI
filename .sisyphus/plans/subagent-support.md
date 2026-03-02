# Subagent Support & Plan Mode Session Fix

## TL;DR

> **Quick Summary**: Fix session ID flickering caused by oh-my-opencode subagents hijacking `currentSessionId`, and add universal subagent support (file change merging, undo/restore, subtle progress indicator) for all agent modes. Pre-flight SSE capture verifies payload assumptions before any code is changed; Playwright E2E verifies runtime behavior after changes.
>
> **Deliverables**:
> - Session ownership tracking (user-created vs subagent sessions)
> - `handleChatEvent()` guarded against ALL subagent event types
> - Subagent file changes merged into main session's undo boundary
> - Subagent sessions hidden from session list
> - Subtle "subagent working..." UI indicator
>
> **Estimated Effort**: Medium
> **Parallel Execution**: YES — Wave 0 (pre-flight) → Wave 1 → Wave 2 → Wave 3 → Final
QP|> **Critical Path**: Task 0 → Task 1 → Task 3 → Task 4 → Task 6 → Task 7 → F1/F2

QT|> **Working Directory**: `D:/0.Code/OpenCodeGUI` (main branch - NOT a separate worktree)

HY|

---

## Context

### Original Request
Messages flicker/disappear when opencode's native plan mode or oh-my-opencode (sisyphus, hephaestus, prometheus, atlas, etc.) spawns subagents that create new sessions. Additionally, oh-my-opencode modes need: main agent progress display, question card reuse, real-time code diff, unified change list and git commit for undo/restore.

### Interview Summary
**Key Discussions**:
- Main session lock: Track but don't overwrite — `currentSessionId` stays frozen to the session that sent the message; subagent session IDs tracked separately
- Subagent sessions: hidden from session history list
- Subagent file changes: merged into main session's change list and undo boundary
- Undo scope: full turn undo including all subagent file changes
- Subagent progress UI: subtle indicator only (small "subagent working..." text)
- Fix is universal — no mode-specific logic (applies to plan, sisyphus, hephaestus, prometheus, atlas, etc.)

**Research Findings**:
- Root cause: `SidebarProvider.ts:3237` — `handleChatEvent()` unconditionally overwrites `this.currentSessionId` when any `session.created` event fires
- `session.created` SSE payload has NO `parentSessionId` field — subagent identification must be inferred
- `activeSendSessionId` is a local variable (scoped to sendMessage handler), not a persistent field — cannot be used as anchor
- All per-session state is Map-based and already session-keyed
- `refreshSessions()` at line 3554 sends raw OpenCode session list with no filtering
- Session list shows ALL sessions from server — subagent sessions currently appear

### Metis Review
**Identified Gaps** (addressed):
- All 11 `handleChatEvent` branches need subagent filtering, not just `session` — resolved by single early guard
- Subagent identification approach: use "user-owned session set" (sessions explicitly created by user) rather than "during turn" heuristic — more robust
- Subagent `files` events must be merged not just skipped — handled in Task 4
- Permission/question overlay events from subagent sessions must be suppressed — included in Task 3
- Undo commit timing: subagent changes must be merged before `commitPendingTurnChanges()` is called — ensured by Task 4 hook on `files` events (real-time merge)
- Memory leak risk: subagent Set must be cleared on turn completion — handled in Task 6

---

## Work Objectives

### Core Objective
Prevent subagent sessions from hijacking the main session's state, while transparently merging subagent file changes into the main session's undo boundary.

### Concrete Deliverables
- `src/SidebarProvider.ts`: Session ownership infrastructure, guarded `handleChatEvent`, subagent session filtering in `refreshSessions`, subagent cleanup on turn end
- `src/OpenCodeClient.ts`: New public `queueSubagentChanges(mainSessionId, files)` method
- `media/main.js`: Subagent status message handler and indicator element
- `media/main.css`: Minimal styling for subagent indicator

### Definition of Done
- [ ] `npm run compile` exits with code 0 (no TypeScript errors)
- [ ] `this.currentSessionId = event.sessionId` is guarded (only fires for user-owned sessions)
- [ ] Session list UI does not show sessions in `activeSubagentSessionIds`
- [ ] Subagent indicator appears/disappears based on active subagent count

### Must Have
- Session ID never changes during an active turn unless the new session ID is user-owned
- ALL event types in `handleChatEvent` are filtered for non-user-owned sessions
- Subagent `files` events merged into main session pending turn changes
- Subagent sessions cleared from tracking Set at turn end
- No TypeScript errors

### Must NOT Have (Guardrails)
- NO mode-specific logic (`if (mode === 'sisyphus')` etc.) — fix is universal
- NO changes to `OpenCodeClient.mapServerEventToChatEvents()` — filter at consumer, not producer
- NO changes to `GitUndoEngine.ts` internals
- NO subagent text/thinking/tool calls displayed in main chat area
- NO subagent error surfacing in the UI
- NO parent-child session tree UI
- NO per-subagent progress tracking (single boolean "subagents active" is sufficient)
- NO `chat()` method in OpenCodeClient modified

---

## Verification Strategy

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed.

### Test Decision
- **Infrastructure exists**: Check at implementation time
- **Automated tests**: None (no existing test framework discovered)
- **Agent-Executed QA**: ALWAYS (grep assertions + compile verification for each task)

### QA Policy
Every task includes agent-executed QA scenarios using Bash (grep + compile).
Evidence saved to `.sisyphus/evidence/`.

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 0 (START FIRST — pre-flight SSE capture, BLOCKS everything):
└── Task 0: Capture real SSE event stream from oh-my-opencode [deep]

Wave 1 (After Task 0 — parallel, verify assumptions first):
├── Task 1: Session ownership tracking infrastructure [unspecified-low]
└── Task 2: Subagent indicator in webview UI [quick + frontend-ui-ux]

Wave 2a (After Wave 1 — Tasks 3 and 5 parallel):
├── Task 3: Guard handleChatEvent against ALL subagent events [deep]
└── Task 5: Filter subagent sessions from session list [quick]

Wave 2b (After Task 3 completes):
└── Task 4: Merge subagent file changes into main session undo [deep]

Wave 3 (After all Wave 2 complete):
└── Task 6: Cleanup on turn end + integration verification [unspecified-low]

Wave 4 — Playwright E2E (After Task 6):
└── Task 7: Playwright end-to-end verification with MiniMax M2.5 Free [unspecified-high + playwright]

Wave FINAL (After Task 7):
├── Task F1: Plan compliance audit [oracle]
└── Task F2: Code quality + compile check [unspecified-high]

Critical Path: Task 0 → Task 1 → Task 3 → Task 4 → Task 6 → Task 7 → F1/F2
```

### Dependency Matrix

| Task | Depends On | Blocks |
|------|------------|--------|
| **0** | None | 1, 2 (ALL implementation tasks) |
| 1 | 0 | 3, 4, 5, 6 |
| 2 | 0 | (none — independent webview work) |
| 3 | 1 | 4, 6 |
| 4 | 1, 3 | 6 |
| 5 | 1 | 6 |
| 6 | 3, 4, 5 | 7 |
| **7** | 6 | F1, F2 |
| F1 | 7 | — |
| F2 | 7 | — |
### Agent Dispatch Summary

- **Wave 0**: 1 — T0 → `deep` + `playwright`
- **Wave 1**: 2 parallel — T1 → `unspecified-low`, T2 → `quick` + `frontend-ui-ux`
- **Wave 2a**: 2 parallel — T3 → `deep`, T5 → `quick`
- **Wave 2b**: 1 — T4 → `deep`
- **Wave 3**: 1 — T6 → `unspecified-low`
- **Wave 4**: 1 — T7 → `unspecified-high` + `playwright`
- **FINAL**: 2 parallel — F1 → `oracle`, F2 → `unspecified-high`

---

## TODOs

---

#RH|- [ ] 0. Pre-flight: Capture real SSE event stream from oh-my-opencode [deep]

QT|  **Working Directory**: `D:/0.Code/OpenCodeGUI` (main branch)

XT|  **What to do**:
RM|  - Agent MUST execute all steps in this task - do NOT ask user to do manual steps
BV|  - Step 1: Read `.opencode/server.lock.json` to get port and password
KH|  - Step 2: Start SSE listener in BACKGROUND using interactive_bash (tmux):
    ```bash
    # Decode password and start curl in background
    tmux new-session -d -s sse-capture
    tmux send-keys -t sse-capture "curl -N -H 'Accept: text/event-stream' -H 'Authorization: Basic b3BlbmNvZGU6dWRtK1VyOVM5WS9XQmIuMWNWVFVBRHhtTXd3RkpIWlRtaVYzam82NTk=' http://127.0.0.1:42217/event -o .sisyphus/evidence/sse-capture-raw.txt" Enter
    ```
ZW|  - Step 3: Use playwright skill to trigger subagent in VS Code:
    - Open VS Code Extension Development Host
    - Select MiniMax M2.5 Free model
    - Select plan mode
    - Send message: "List files in current directory"
    - Wait for response to complete
    - Close VS Code
MR|  - Step 4: Kill the curl process:
    ```bash
    tmux kill-session -t sse-capture
    ```
PM|  - Step 5: Parse the capture file and create analysis:
    - Check for session.created events
    - Check for parentSessionId field
    - Document files event structure
    - Save to `.sisyphus/evidence/sse-analysis.md`

**CRITICAL**: If analysis reveals different payload structure, update subsequent tasks accordingly

  **Must NOT do**:
  - Do NOT use your own opencode credits for this test — use **MiniMax M2.5 Free** model only
  - Do NOT send a complex task that generates many file changes — a simple question is sufficient to trigger subagent spawning
  - Do NOT proceed to Task 1 if the SSE capture reveals assumptions are wrong without first updating the affected tasks

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Requires reading server lock file, running background curl, parsing SSE output, making structural judgments about payload shape
  - **Skills**: [`playwright`]
    - `playwright`: May be needed to open VS Code extension host and trigger the oh-my-opencode turn if curl alone cannot initiate a session

  **Parallelization**:
  - **Can Run In Parallel**: NO (must complete before all implementation tasks)
  - **Parallel Group**: Wave 0 (sole task)
  - **Blocks**: ALL subsequent tasks (1 through 7)
  - **Blocked By**: None (start immediately)

  **References**:
  - `.opencode/server.lock.json` — contains `port` and `password` for the running opencode server
  - `src/SidebarProvider.ts` — search for `server.lock.json` to see how the extension reads these values
  - `src/OpenCodeClient.ts` — search for `/event` to find the SSE endpoint path

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: SSE capture file exists and contains session.created events
    Tool: Bash
    Steps:
      1. ls -la .sisyphus/evidence/sse-capture-raw.txt
      2. grep -c 'session.created\|"type":"session"' .sisyphus/evidence/sse-capture-raw.txt
    Expected Result: file exists, >= 2 session.created events (main + at least 1 subagent)
    Evidence: .sisyphus/evidence/task-0-session-events.txt

  Scenario: SSE analysis document written with parentSessionId verdict
    Tool: Bash
    Steps:
      1. cat .sisyphus/evidence/sse-analysis.md
    Expected Result: file contains 'parentSessionId: YES/NO' and 'files event structure:' sections
    Evidence: .sisyphus/evidence/task-0-analysis-exists.txt
  ```

  **Commit**: NO

---

- [x] 1. Add session ownership tracking infrastructure to SidebarProvider

  **What to do**:
  - Add two new private fields to the `SidebarProvider` class (near line 103 where other private fields are declared):
    ```typescript
    private userOwnedSessionIds = new Set<string>();
    private activeSubagentSessionIds = new Set<string>();
    ```
  - Add three helper methods to `SidebarProvider`:
    - `private isUserOwnedSession(id: string): boolean` — returns `this.userOwnedSessionIds.has(id) || id === this.currentSessionId`
    - `private trackUserOwnedSession(id: string): void` — adds `id` to `userOwnedSessionIds`
    - `private clearSubagentSessions(): void` — clears `activeSubagentSessionIds` (does NOT clear `userOwnedSessionIds`)
  - Call `this.trackUserOwnedSession(this.currentSessionId)` immediately after EVERY line where `this.currentSessionId` is explicitly set by user action. Find all such lines using grep (`grep -n 'this.currentSessionId =' src/SidebarProvider.ts`) — these are at approximately lines 868, 1365, 1657–1658, 2443, 2526–2527, 2557–2558, 2649–2650, 2699–2700. Only call it where a real user-chosen or user-initiated session ID is being set (not fallback/undefined assignments).
  - Do NOT modify `handleChatEvent` yet — that is Task 3.
  - Do NOT modify any other logic.

  **Must NOT do**:
  - Do NOT add mode-specific logic
  - Do NOT modify `handleChatEvent` in this task
  - Do NOT add more than these 2 fields and 3 methods

  **Recommended Agent Profile**:
  > Straightforward field and method additions, no logic changes.
  - **Category**: `unspecified-low`
    - Reason: Simple field declarations and helper methods, no complex logic
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 2)
  - **Blocks**: Tasks 3, 4, 5, 6
  - **Blocked By**: None (start immediately)

  **References**:

  **Pattern References**:
  - `src/SidebarProvider.ts:103-115` — where existing private fields are declared; add the two new Set fields here
  - `src/SidebarProvider.ts:868` — after `this.currentSessionId = sessionInfo.id;` call `trackUserOwnedSession`
  - `src/SidebarProvider.ts:1365` — after `this.currentSessionId = targetSessionId;` call `trackUserOwnedSession`
  - `src/SidebarProvider.ts:2699` — after `this.currentSessionId = newSession.id;` call `trackUserOwnedSession`

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Session ownership fields exist in compiled output
    Tool: Bash
    Steps:
      1. grep -c "userOwnedSessionIds\|activeSubagentSessionIds" src/SidebarProvider.ts
    Expected Result: >= 4 (declaration + at least 3 usages)
    Evidence: .sisyphus/evidence/task-1-ownership-fields.txt

  Scenario: Helper methods exist
    Tool: Bash
    Steps:
      1. grep -c "isUserOwnedSession\|trackUserOwnedSession\|clearSubagentSessions" src/SidebarProvider.ts
    Expected Result: >= 6 (definition + usage for each)
    Evidence: .sisyphus/evidence/task-1-helpers.txt

  Scenario: TypeScript compiles cleanly
    Tool: Bash
    Steps:
      1. npm run compile
    Expected Result: exit code 0
    Evidence: .sisyphus/evidence/task-1-compile.txt
  ```

  **Commit**: NO (groups with final commit)

---

- [x] 2. Add subagent indicator to webview (media/main.js + media/main.css)

  **What to do**:
  - In `media/main.js`, add a new message handler case for `type: 'subagentStatus'`:
    - When `{ type: 'subagentStatus', active: true, count: N }` received: show the indicator with text `⚡ ${count} subagent${count > 1 ? 's' : ''} working...`
    - When `{ type: 'subagentStatus', active: false }` received: hide the indicator
  - Add a new element `<div id="subagent-indicator" class="subagent-indicator hidden"></div>` in the chat area HTML (in `SidebarProvider.ts`'s `getHtmlForWebview()` method, near where `pending-indicator` exists)
  - In `media/main.css`, add minimal styling:
    ```css
    .subagent-indicator {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      padding: 2px 0;
      opacity: 0.7;
    }
    .subagent-indicator.hidden { display: none; }
    ```
  - Follow existing `pending-indicator` toggle pattern in `main.js` (find it with `grep -n 'pending-indicator' media/main.js`)

  **Must NOT do**:
  - Do NOT add animations or flashy effects — subtle only
  - Do NOT show subagent session ID or session name
  - Do NOT show subagent tool calls or streaming text

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Small, isolated webview UI addition following existing patterns
  - **Skills**: [`frontend-ui-ux`]
    - `frontend-ui-ux`: Ensures indicator follows VS Code design system (muted color, small font)

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Task 1)
  - **Blocks**: None (UI-only, other tasks don't depend on it)
  - **Blocked By**: None (start immediately)

  **References**:

  **Pattern References**:
  - `media/main.js` — search for `pending-indicator` to find the toggle pattern to follow
  - `media/main.js:238` — `setSystemNotice()` function for reference on how notices are shown/hidden
  - `media/main.css` — search for `.pending-indicator` to find existing styling to mimic
  - `src/SidebarProvider.ts` — search for `pending-indicator` to find where in the HTML template to insert the new element

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: subagentStatus handler exists in main.js
    Tool: Bash
    Steps:
      1. grep -c "subagentStatus\|subagent-indicator" media/main.js
    Expected Result: >= 2
    Evidence: .sisyphus/evidence/task-2-js-handler.txt

  Scenario: CSS for indicator exists
    Tool: Bash
    Steps:
      1. grep -c "subagent-indicator\|subagent" media/main.css
    Expected Result: >= 2
    Evidence: .sisyphus/evidence/task-2-css.txt

  Scenario: TypeScript compiles cleanly after HTML template change
    Tool: Bash
    Steps:
      1. npm run compile
    Expected Result: exit code 0
    Evidence: .sisyphus/evidence/task-2-compile.txt
  ```

  **Commit**: NO (groups with final commit)

---


- [x] 3. Guard `handleChatEvent` against ALL subagent session events

  **What to do**:
  - In `src/SidebarProvider.ts`, in `handleChatEvent()` starting at line 3234:
  - REPLACE the current `session` event block (lines 3235–3267) with a new version that:
    1. If `event.sessionId` is provided AND is NOT user-owned AND a turn is currently in-flight (`this.sendInFlightBySession.has(this.currentSessionId!)`): add `event.sessionId` to `this.activeSubagentSessionIds`, post `{ type: 'subagentStatus', active: true, count: this.activeSubagentSessionIds.size }` to the webview, and return early (do NOT overwrite `currentSessionId`)
    2. If `event.sessionId` is user-owned OR no turn is in-flight: process exactly as before (existing session switch logic)
  - AFTER the `session` event block, add a SECOND early-return guard at the very TOP of the remaining logic (before the `questionOverlay` check at ~line 3269):
    ```typescript
    // Suppress ALL events from known subagent sessions
    if (event.sessionId && this.activeSubagentSessionIds.has(event.sessionId)) {
        // Special case: files events must still be merged (handled in Task 4)
        // For now (Task 3), just return early for all non-files events
        if (event.type !== 'files') return;
    }
    ```
    (Note: Task 4 will change this block to actually handle `files` events from subagents)
  - This guard covers: `questionOverlay`, `permissionRequest`, `permissionReplied`, `autoResumeStallWarn`, `autoResumeStallClear`, `autoResumeHardStop`, `assistantMessageMeta`, `text`, `diff`, `message`, `error` — all will return early for subagent sessions.

  **Must NOT do**:
  - Do NOT add mode-specific checks (`if (this.selectedMode === 'sisyphus')` etc.)
  - Do NOT change the `queueTurnChanges` / `commitPendingTurnChanges` logic in this task — that is Task 4
  - Do NOT remove or reorder any of the 11 existing event handler branches — only add guards
  - Do NOT filter events that have no `sessionId` (anonymous events should pass through)

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Requires careful understanding of all 11 event type branches and the guard insertion point to avoid breaking existing behavior
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Task 5)
  - **Parallel Group**: Wave 2a
  - **Blocks**: Task 4, Task 6
  - **Blocked By**: Task 1 (needs `userOwnedSessionIds`, `activeSubagentSessionIds`, helper methods)

  **References**:

  **Pattern References**:
  - `src/SidebarProvider.ts:3234–3484` — full `handleChatEvent()` method; read entirely before modifying
  - `src/SidebarProvider.ts:3235–3267` — the `session` event handler block being replaced
  - `src/SidebarProvider.ts:896` — `this.sendInFlightBySession` is a `Set<string>`; check `.has(this.currentSessionId!)` to detect active turn
  - `src/SidebarProvider.ts:924–926` — where `sendInFlightBySession` is populated at turn start
  - `src/SidebarProvider.ts:1092–1096` — where `sendInFlightBySession` is cleared at turn end

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: Unconditional currentSessionId overwrite is gone
    Tool: Bash
    Steps:
      1. grep -n "this.currentSessionId = event.sessionId" src/SidebarProvider.ts
    Expected Result: 0 lines (the old unconditional line is replaced by guarded version)
    Failure Indicators: Any line containing exactly `this.currentSessionId = event.sessionId` without a preceding condition check
    Evidence: .sisyphus/evidence/task-3-no-unconditional-overwrite.txt

  Scenario: Subagent guard exists covering non-files events
    Tool: Bash
    Steps:
      1. grep -n "activeSubagentSessionIds.has\|isUserOwnedSession" src/SidebarProvider.ts
    Expected Result: >= 2 lines inside handleChatEvent
    Evidence: .sisyphus/evidence/task-3-guard-exists.txt

  Scenario: All 11 event handler branches still exist (no accidental deletions)
    Tool: Bash
    Steps:
      1. grep -c "event.type === '" src/SidebarProvider.ts
    Expected Result: >= 11 (same or more than before the change)
    Evidence: .sisyphus/evidence/task-3-branches-intact.txt

  Scenario: TypeScript compiles cleanly
    Tool: Bash
    Steps:
      1. npm run compile
    Expected Result: exit code 0
    Evidence: .sisyphus/evidence/task-3-compile.txt
  ```

  **Commit**: NO (groups with final commit)

---

- [x] 4. Merge subagent file changes into main session undo boundary

  **What to do**:
  - In `src/OpenCodeClient.ts`, add a new PUBLIC method `queueSubagentChanges(mainSessionId: string, files: any[]): void`:
    - This method merges file changes from a subagent into the main session's `pendingTurnChangesBySession` entry
    - Look at the private `queueTurnChanges()` method signature and implementation to understand the data structure
    - The new method should call the appropriate internal queueing logic with `mainSessionId` as the session key
    - If `mainSessionId` has no active turn state, log a debug message and return (don't throw)
  - In `src/SidebarProvider.ts`, in `handleChatEvent()`, update the subagent guard added in Task 3:
    - Change the `if (event.type !== 'files') return;` condition to actually handle `files` events:
    ```typescript
    if (event.sessionId && this.activeSubagentSessionIds.has(event.sessionId)) {
        if (event.type === 'files' && event.files && event.files.length && this.currentSessionId) {
            // Merge subagent file changes into main session
            this.client.queueSubagentChanges(this.currentSessionId, event.files);
            // Also open diff view for the file (same as normal files handling)
            // ... copy the existing files event handling logic from lines 3447-3479 ...
        }
        return; // suppress all other subagent events
    }
    ```
  - The subagent `files` event should ALSO trigger the diff view (same as main session files events) — copy the existing diff-opening logic from the `files` branch (lines 3447–3479) into this path so diffs show in real-time.

  **Must NOT do**:
  - Do NOT change `commitPendingTurnChanges()` — it already commits whatever is in the Map for the given sessionId; merging during `queueSubagentChanges` is sufficient
  - Do NOT track which subagent contributed which file change — just merge everything into main session
  - Do NOT expose private internals beyond the single `queueSubagentChanges` method

  **Recommended Agent Profile**:
  - **Category**: `deep`
    - Reason: Requires understanding `queueTurnChanges` internals, the pending turn changes data structure, and correctly delegating to the right internal APIs
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (must follow Task 3)
  - **Parallel Group**: Wave 2b (sequential after Task 3)
  - **Blocks**: Task 6
  - **Blocked By**: Tasks 1 and 3

  **References**:

  **Pattern References**:
  - `src/OpenCodeClient.ts` — search for `queueTurnChanges` to find the private method signature and implementation
  - `src/OpenCodeClient.ts` — search for `pendingTurnChangesBySession` to understand the data structure
  - `src/OpenCodeClient.ts` — search for `commitPendingTurnChanges` to see what it reads from `pendingTurnChangesBySession`
  - `src/SidebarProvider.ts:3447–3479` — the existing `files` event handler in `handleChatEvent`; copy the diff-opening logic

  **API/Type References**:
  - `src/OpenCodeClient.ts` — search for the `PendingTurnChanges` type definition to understand the expected shape

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: queueSubagentChanges public method exists on OpenCodeClient
    Tool: Bash
    Steps:
      1. grep -n "queueSubagentChanges" src/OpenCodeClient.ts
    Expected Result: >= 1 line (method declaration)
    Evidence: .sisyphus/evidence/task-4-method-exists.txt

  Scenario: SidebarProvider calls queueSubagentChanges for subagent files events
    Tool: Bash
    Steps:
      1. grep -n "queueSubagentChanges" src/SidebarProvider.ts
    Expected Result: >= 1 line (inside the subagent files handling block)
    Evidence: .sisyphus/evidence/task-4-sidebar-calls-method.txt

  Scenario: TypeScript compiles cleanly
    Tool: Bash
    Steps:
      1. npm run compile
    Expected Result: exit code 0
    Evidence: .sisyphus/evidence/task-4-compile.txt
  ```

  **Commit**: NO (groups with final commit)

---

- [x] 5. Filter subagent sessions from session list UI

  **What to do**:
  - In `src/SidebarProvider.ts`, in `refreshSessions()` method at approximately line 3554:
    ```typescript
    private async refreshSessions(webview: vscode.Webview, requestId: string): Promise<void> {
        try {
            const sessions = await this.client.listSessions();
            // Filter out known subagent sessions from the current extension lifecycle
            const filteredSessions = sessions.filter(s => !this.activeSubagentSessionIds.has(s.id));
            webview.postMessage({ type: 'sessionsList', requestId, sessions: filteredSessions });
        } catch (error) { ... }
    }
    ```
  - That is the ONLY change in this file for Task 5. No other modifications.

  **Must NOT do**:
  - Do NOT filter sessions based on session names or metadata
  - Do NOT modify `listSessions()` in OpenCodeClient
  - Do NOT retroactively identify old subagent sessions from previous extension sessions (only current lifecycle)

  **Recommended Agent Profile**:
  - **Category**: `quick`
    - Reason: Single-line filter addition in one method
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Task 3)
  - **Parallel Group**: Wave 2a
  - **Blocks**: Task 6
  - **Blocked By**: Task 1 (needs `activeSubagentSessionIds`)

  **References**:

  **Pattern References**:
  - `src/SidebarProvider.ts:3554–3562` — the `refreshSessions` method; the only place to modify

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: refreshSessions filters subagent sessions
    Tool: Bash
    Steps:
      1. grep -n "activeSubagentSessionIds\|filteredSessions\|filter.*subagent" src/SidebarProvider.ts
    Expected Result: >= 1 line in or near the refreshSessions method
    Evidence: .sisyphus/evidence/task-5-filter.txt

  Scenario: TypeScript compiles cleanly
    Tool: Bash
    Steps:
      1. npm run compile
    Expected Result: exit code 0
    Evidence: .sisyphus/evidence/task-5-compile.txt
  ```

  **Commit**: NO (groups with final commit)

---

- [x] 6. Cleanup on turn end + integration verification

  **What to do**:
  - In `src/SidebarProvider.ts`, find all places where `finishTurn()` is called (search: `grep -n 'finishTurn' src/SidebarProvider.ts`):
    - After each `this.client.finishTurn(this.currentSessionId)` call, add:
      ```typescript
      this.clearSubagentSessions();
      const liveWebview = this._view?.webview || webview; // use the right webview ref
      liveWebview.postMessage({ type: 'subagentStatus', active: false });
      ```
  - Also add the same cleanup in the error handler path (around line 1062 in the `catch` block) after the error is reported.
  - After all cleanup calls are added, run `npm run compile` and fix any TypeScript errors.
  - Run the full grep verification suite (all evidence files from Tasks 1–5) to confirm everything is still in place.

  **Must NOT do**:
  - Do NOT clear `userOwnedSessionIds` here — those should persist for the lifetime of the extension (so newly selected sessions remain tracked)
  - Do NOT add any other changes beyond cleanup and verification

  **Recommended Agent Profile**:
  - **Category**: `unspecified-low`
    - Reason: Small additions in known locations + verification commands
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (must follow Tasks 3, 4, 5)
  - **Parallel Group**: Wave 3 (sequential)
  - **Blocks**: Task 7 (Playwright E2E)
  - **Blocked By**: Tasks 3, 4, 5

  **References**:

  **Pattern References**:
  - `src/SidebarProvider.ts:1044–1046` — where `finishTurn` is called in normal flow
  - `src/SidebarProvider.ts:1062–1096` — the error/finally block path

  **Acceptance Criteria**:

  **QA Scenarios (MANDATORY)**:

  ```
  Scenario: clearSubagentSessions called after finishTurn
    Tool: Bash
    Steps:
      1. grep -n "clearSubagentSessions" src/SidebarProvider.ts
    Expected Result: >= 2 lines (normal path + error path)
    Evidence: .sisyphus/evidence/task-6-cleanup.txt

  Scenario: subagentStatus false posted on turn end
    Tool: Bash
    Steps:
      1. grep -n "subagentStatus.*false\|active.*false" src/SidebarProvider.ts
    Expected Result: >= 2 lines
    Evidence: .sisyphus/evidence/task-6-indicator-cleared.txt

  Scenario: Full integration compile check
    Tool: Bash
    Steps:
      1. npm run compile 2>&1
    Expected Result: exit code 0, no errors
    Evidence: .sisyphus/evidence/task-6-final-compile.txt

  Scenario: Unconditional currentSessionId overwrite still absent (regression)
    Tool: Bash
    Steps:
      1. grep -n "this.currentSessionId = event.sessionId" src/SidebarProvider.ts
    Expected Result: 0 lines
    Evidence: .sisyphus/evidence/task-6-regression-check.txt
  ```

  **Commit**: YES (atomic commit for entire feature)
  - Message: `fix(subagent): prevent subagent sessions from hijacking currentSessionId and merge file changes into main session undo`
  - Files: `src/SidebarProvider.ts`, `src/OpenCodeClient.ts`, `media/main.js`, `media/main.css`
  - Pre-commit: `npm run compile`

---

- [x] 7. Playwright End-to-End Verification (MiniMax M2.5 Free)

  **What to do**:
  - Use the `playwright` skill to launch VS Code with the extension loaded (Extension Development Host).
  - Set the model to **MiniMax M2.5 Free** before starting — this is MANDATORY to avoid consuming paid quota.
  - Send a message in the chat that will trigger oh-my-opencode subagent spawning (e.g., send to a mode like `plan` or `sisyphus`). Wait for the full response cycle to complete.
  - **Verify each of the following with Playwright assertions + screenshots:**

  **Scenario 1 — No message flickering:**
  - While the subagent turn is running, poll the chat message list every 500ms for 30 seconds.
  - Assert that messages that appeared do NOT disappear mid-turn.
  - Evidence: screenshot of stable message list + `.sisyphus/evidence/task-7-no-flicker.png`

  **Scenario 2 — Subagent indicator appears and disappears:**
  - Assert `#subagent-indicator` element is visible (not `.hidden`) while subagent is active.
  - Assert `#subagent-indicator` element becomes hidden after turn completes.
  - Evidence: screenshot during active subagent + screenshot after completion: `.sisyphus/evidence/task-7-indicator-active.png`, `.sisyphus/evidence/task-7-indicator-hidden.png`

  **Scenario 3 — Subagent sessions NOT in session list:**
  - Open the session list UI.
  - Assert that only 1 session appears (the main session) — not the subagent sessions that were spawned.
  - Evidence: screenshot of session list: `.sisyphus/evidence/task-7-session-list.png`

  **Scenario 4 — Change list includes subagent file changes:**
  - If the subagent modified any files, assert the change list (diffFileList or changeListUpdate) includes those file paths.
  - Evidence: screenshot of change list: `.sisyphus/evidence/task-7-change-list.png`

  **Scenario 5 — currentSessionId did NOT change during the turn:**
  - Read the extension's Output Channel (`OpenCode GUI`) for the session ID logged at turn start vs turn end.
  - Assert the session ID logged at start equals the session ID logged at end.
  - Evidence: `.sisyphus/evidence/task-7-session-id-stable.txt`

  **Must NOT do**:
  - Do NOT use any paid model — ONLY MiniMax M2.5 Free
  - Do NOT run more scenarios than listed above — minimize API usage
  - Do NOT block indefinitely if VS Code Extension Host fails to launch — timeout after 60 seconds and report failure

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
    - Reason: Requires orchestrating VS Code Extension Host, managing browser state, and asserting complex async UI behavior
  - **Skills**: [`playwright`]
    - `playwright`: Required for browser/VS Code UI automation, screenshots, DOM assertions

  **Parallelization**:
  - **Can Run In Parallel**: NO (must follow Task 6)
  - **Parallel Group**: Wave 4 (sole task)
  - **Blocks**: F1, F2
  - **Blocked By**: Task 6

  **References**:
  - `.sisyphus/evidence/sse-analysis.md` — from Task 0; confirms what events to expect
  - `src/SidebarProvider.ts` — Output Channel name (search for `uiDebugChannel`)
  - `media/main.js` — `#subagent-indicator` element ID, `#pending-indicator` pattern to follow

  **Acceptance Criteria**:

  **QA Scenarios**: (See Scenarios 1–5 above — each requires evidence file)

  **Commit**: NO (verification only)

---

## Final Verification Wave

- [x] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists (read file, grep). For each "Must NOT Have": grep codebase for forbidden patterns. Check `npm run compile` passes. Verify all evidence files in `.sisyphus/evidence/`.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [x] F2. **Code Quality + Compile Check** — `unspecified-high`
  Run `npm run compile`. Check all modified files for: `as any` added, empty catches added, console.log added in extension code, TypeScript errors, unused imports. Verify no AI slop (excessive comments, over-abstraction, generic names). Check that guard in `handleChatEvent` is properly placed before all 11 event type branches (not just session).
  Output: `Build [PASS/FAIL] | Files clean [N/N] | VERDICT: APPROVE/REJECT`

---

## Commit Strategy

- **1 atomic commit after Task 6** (before Playwright E2E): `fix(subagent): prevent subagent sessions from hijacking currentSessionId and merge file changes into main session undo`
  - Files: `src/SidebarProvider.ts`, `src/OpenCodeClient.ts`, `media/main.js`, `media/main.css`
  - Pre-commit: `npm run compile`
  - Note: Task 7 (Playwright E2E) runs AFTER this commit. If Task 7 reveals issues, additional fix commits may follow.

---

## Success Criteria

### Verification Commands
```bash
# No unconditional currentSessionId overwrite
grep -n "this.currentSessionId = event.sessionId" src/SidebarProvider.ts
# Expected: 0 results (guarded version replaces it)

# Session ownership tracking exists
grep -c "userOwnedSessionIds\|isUserOwnedSession\|trackUserOwnedSession" src/SidebarProvider.ts
# Expected: >= 4

# Subagent indicator in webview
grep -c "subagentStatus\|subagent-indicator\|subagent.*working" media/main.js
# Expected: >= 2

# Clean compile
npm run compile
# Expected: exit code 0
```

- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] `npm run compile` exits 0
- [ ] No new `as any` or TypeScript suppression comments
- [x] Task 0: SSE analysis at `.sisyphus/evidence/sse-analysis.md` confirms payload assumptions
- [ ] Task 7: All 5 Playwright evidence files exist in `.sisyphus/evidence/task-7-*.{png,txt}`
- [ ] Task 7: No message flickering observed during subagent turn
- [ ] Task 7: Subagent sessions do NOT appear in session list
- [ ] Task 7: `#subagent-indicator` appears and disappears correctly
