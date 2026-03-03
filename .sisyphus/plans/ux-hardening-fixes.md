# UX Hardening Fixes — subagent cards + question button width + status display + question markdown

## TL;DR

> **Quick Summary**: Fix 5 issues: (A) populate the subagent data map so cards show real data, (B) rename subagent card CSS classes to match spec and add mode/action fields, (C) make question overlay buttons auto-size to the longest label (max 98%), (D) fix status display bug where intermediate status strings ('Finalizing the response...', 'Writing: foo.ts') appear in the wrong place or persist in final message text, (E) render question card prompt text with markdown.
>
> **Deliverables**:
> - `src/SidebarProvider.ts`: subagentProgressBySession populated + emitSubagentStatus sends `count` + flush buffer on error path + forward `isStatusUpdate` flag
> - `src/OpenCodeClient.ts`: add `isStatusUpdate: true` to status-only `assistantMessageMeta` emissions
> - `media/main.js`: subagent card renders correct field names; question button width auto-sized; `handleAssistantMeta` routes status to `meta.statusText`; question prompt rendered with markdown
> - `media/main.css`: CSS class names updated; `.question-card-btn` uses CSS variable for width; `.message-status` styling for transient status display

---

## Context

### Original Request
Audit revealed 2 incomplete implementations from the prior `opencodegui-chat-ux-hardening` plan, plus a new user requirement for question button width.

### Audit Findings
- **Fix A**: `subagentProgressBySession` map is never `.set()` — so `emitSubagentStatus()` always emits `agents: []`, cards never show real data
- **Fix B**: Subagent card DOM uses wrong class names (`subagent-card-desc`, `subagent-card-time`) — spec requires `subagent-name`, `subagent-elapsed`, plus new `subagent-status` and `subagent-action` elements
- **Fix C**: `applyQuestionOptionWidth()` has the setProperty line commented out; buttons need to auto-size to longest label text, max 98%

### Metis Review Findings (critical)
- Frontend indicator text depends on `message.count` field which `emitSubagentStatus()` doesn't emit — must add `count: agents.length` to the payload
- Two additional raw `postMessage({ type: 'subagentStatus', active: false })` calls at lines ~1088 and ~1126 bypass the helper — replace with `this.emitSubagentStatus(false)`
- `agent.taskName`, `agent.mode`, `agent.model`, `agent.action` don't exist in the data model yet — render conditionally with fallbacks, hidden when empty

---

## Work Objectives

### Core Objective
Fix the three incomplete/incorrect implementations so subagent cards show real data with correct class names, and question buttons auto-size to longest label.

### Concrete Deliverables
- `src/SidebarProvider.ts`: `subagentProgressBySession.set()` called in both session-event branches; `emitSubagentStatus` emits `count: agents.length`; raw `postMessage` calls replaced
- `media/main.js`: correct class names (`subagent-name`, `subagent-elapsed`); conditional `subagent-status` and `subagent-action` elements; `applyQuestionOptionWidth` setProperty line uncommented; `count` derived from `agents.length` as fallback
- `media/main.css`: `.subagent-card-desc` → `.subagent-name`; `.subagent-card-time` → `.subagent-elapsed`; new `.subagent-status` + `.subagent-action` rules; `.question-card-btn` width uses CSS variable

### Must Have
- `subagentProgressBySession.set()` called when a subagent session is registered
- `emitSubagentStatus()` sends `count: agents.length` in payload
- Card DOM uses `subagent-name` and `subagent-elapsed` class names (+ `data-started-at` on elapsed element)
- `.subagent-status` (mode · model) and `.subagent-action` rendered conditionally (hidden/absent when data unavailable)
- `applyQuestionOptionWidth` sets `--question-option-width` CSS variable
- `.question-card-btn` width = `min(var(--question-option-width, 98%), 98%)`
- `npm run compile` passes with no errors

### Must NOT Have (Guardrails)
- Do NOT touch the success-path `clearSubagentSessions()` + postMessage at lines 1125–1126 except to replace the raw subagentStatus postMessage with `this.emitSubagentStatus(false)` if applicable
- Do NOT change `.permission-card-actions .question-card-btn` CSS override — permission buttons must keep `width: auto; min-width: 88px`
- Do NOT add `canvas.measureText` — `ch` units with `+4` buffer is sufficient
- Do NOT extend `subagentProgressBySession` data model with new fields (taskName/mode/model/action) — no server data for these yet
- Do NOT change `applyQuestionOptionWidth` call sites (lines ~6454, ~6600) — they're already correct

---

## Verification Strategy

### Test Decision
- **Infrastructure exists**: NO
- **Automated tests**: None
- **Agent-Executed QA**: All verification via grep/compile/bash

---

## Execution Strategy

All 5 tasks are sequential (same files), run in order.

```
Wave 1 (sequential):
├── Task 1: SidebarProvider.ts — Fix A (subagentProgressBySession)
├── Task 2: main.js — Fix B (card class names + applyQuestionOptionWidth)
├── Task 3: main.css — Fix CSS class names + question-card-btn width variable
├── Task 4: Status display fix (OpenCodeClient.ts + SidebarProvider.ts + main.js + main.css)
└── Task 5: Question card markdown rendering (main.js)
```

---

## TODOs

- [x] 1. Fix A — SidebarProvider.ts: populate subagentProgressBySession + fix emitSubagentStatus payload

  **What to do**:

  All changes in `d:/0.Code/OpenCodeGUI/src/SidebarProvider.ts`. Do NOT use a new working directory.

  **Step 1** — Add `count: agents.length` to the postMessage payload in `emitSubagentStatus()`.

  Find this line (inside the `emitSubagentStatus` method, roughly line 138):
  ```ts
  liveWebview.postMessage({ type: 'subagentStatus', active: isActive, agents });
  ```
  Change to:
  ```ts
  liveWebview.postMessage({ type: 'subagentStatus', active: isActive, count: agents.length, agents });
  ```

  **Step 2** — In `handleChatEvent`, find the two branches that call `this.activeSubagentSessionIds.add(event.sessionId)` and then do a raw `postMessage({ type: 'subagentStatus', active: true, count: ... })`. There are two such branches (roughly lines 3292–3296 and 3299–3305). For EACH branch, AFTER the `this.activeSubagentSessionIds.add(event.sessionId)` line, add:
  ```ts
  if (!this.subagentProgressBySession.has(event.sessionId)) {
      this.subagentProgressBySession.set(event.sessionId, {
          taskId: event.sessionId,
          description: '',
          startedAt: Date.now()
      });
  }
  ```
  Then REPLACE the raw `liveWebview.postMessage({ type: 'subagentStatus', active: true, count: ... })` line (or `const liveWebview = ...` + `postMessage` pair) with:
  ```ts
  this.emitSubagentStatus(true);
  ```
  Note: The `liveWebview` variable is already set outside these branches (or use `this._view?.webview`). Remove the local `const liveWebview = ...` if it was only used for the now-removed postMessage.

  **Step 3** — Find any remaining raw `postMessage({ type: 'subagentStatus', active: false })` calls that are NOT going through `this.emitSubagentStatus()`. There are approximately 2 such sites (around lines 1088 and 1126). Replace each with:
  ```ts
  this.emitSubagentStatus(false);
  ```
  Verify by running: `grep -n "postMessage.*subagentStatus" src/SidebarProvider.ts` — result should be 0 matches (all should go through the helper now).

  **Must NOT do**:
  - Do NOT change the `ChatEvent` type definitions
  - Do NOT change the `clearSubagentSessions()` method itself
  - Do NOT change `removeSubagentSession()` method
  - Do NOT change any logic related to the success path (lines 1117–1140)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential — Task 1 first
  - **Blocks**: Tasks 2, 3
  - **Blocked By**: None

  **References**:
  - `src/SidebarProvider.ts` lines ~105–140: `subagentProgressBySession` map declaration + `emitSubagentStatus` method
  - `src/SidebarProvider.ts` lines ~3288–3310: the two session-event branches to fix
  - `src/SidebarProvider.ts` lines ~1080–1095 and ~1120–1130: the two raw postMessage sites to replace

  **Acceptance Criteria**:
  - [x] `grep -n "postMessage.*subagentStatus" src/SidebarProvider.ts` → 0 matches
  - [x] `grep -n "subagentProgressBySession.set" src/SidebarProvider.ts` → at least 1 match
  - [x] `grep -n "count.*agents.length" src/SidebarProvider.ts` → at least 1 match in emitSubagentStatus
  - [x] `npm run compile` → exit 0, no errors

  **QA Scenarios**:
  ```
  Scenario: Compile passes with no TypeScript errors
    Tool: Bash
    Steps:
      1. Run: npm run compile
    Expected Result: exit code 0, no errors printed
    Evidence: terminal output

  Scenario: No raw subagentStatus postMessage calls remain
    Tool: Bash
    Steps:
      1. Run: grep -n "postMessage.*subagentStatus" src/SidebarProvider.ts
    Expected Result: 0 lines output
    Evidence: terminal output

  Scenario: subagentProgressBySession.set is called
    Tool: Bash
    Steps:
      1. Run: grep -n "subagentProgressBySession.set" src/SidebarProvider.ts
    Expected Result: at least 1 match
    Evidence: terminal output
  ```

  **Commit**: YES
  - Message: `fix(subagent): populate subagentProgressBySession and fix emitSubagentStatus payload`
  - Files: `src/SidebarProvider.ts`
  - Pre-commit: `npm run compile`

---

- [x] 2. Fix B — main.js: correct subagent card class names + fix applyQuestionOptionWidth

  **What to do**:

  All changes in `d:/0.Code/OpenCodeGUI/media/main.js`. Do NOT use a new working directory.

  **Step 1** — Fix the `count` fallback at the top of the `subagentStatus` handler (line ~4456):
  ```js
  // BEFORE:
  const count = typeof message.count === 'number' ? Math.max(0, message.count) : 0;
  // AFTER:
  const count = typeof message.count === 'number' ? Math.max(0, message.count) : (Array.isArray(message.agents) ? message.agents.length : 0);
  ```

  **Step 2** — In the card CREATION block (inside the `if (!card)` branch, lines ~4496–4506), replace the `descEl` and `timeEl` creation with the new structure:
  ```js
  const nameEl = document.createElement('div');
  nameEl.className = 'subagent-name';
  nameEl.textContent = agent.taskName || agent.description || 'Subagent Task';

  const elapsedEl = document.createElement('div');
  elapsedEl.className = 'subagent-elapsed';
  elapsedEl.textContent = '0s';
  if (agent.startedAt) {
      elapsedEl.dataset.startedAt = String(agent.startedAt);
  }

  card.appendChild(nameEl);

  if (agent.mode || agent.model) {
      const statusEl = document.createElement('div');
      statusEl.className = 'subagent-status';
      statusEl.textContent = [agent.mode, agent.model].filter(Boolean).join(' · ');
      card.appendChild(statusEl);
  }

  if (agent.action) {
      const actionEl = document.createElement('div');
      actionEl.className = 'subagent-action';
      actionEl.textContent = agent.action;
      card.appendChild(actionEl);
  }

  card.appendChild(elapsedEl);
  ```

  **Step 3** — In the card UPDATE block (inside the `else` branch, lines ~4508–4511), update to use new class name and fallback:
  ```js
  const nameEl = card.querySelector('.subagent-name');
  if (nameEl) {
      const newText = agent.taskName || agent.description || 'Subagent Task';
      if (nameEl.textContent !== newText) {
          nameEl.textContent = newText;
      }
  }
  ```

  **Step 4** — In the elapsed interval's `querySelector` call (line ~4520), change:
  ```js
  // BEFORE:
  const timeEl = card.querySelector('.subagent-card-time');
  // AFTER:
  const timeEl = card.querySelector('.subagent-elapsed');
  ```
  Also update any other `card.querySelector('.subagent-card-time')` references.

  **Step 5** — In `applyQuestionOptionWidth` (line ~6413), uncomment the setProperty line:
  ```js
  // BEFORE:
  // actionsEl.style.setProperty('--question-option-width', `${widthCh}ch`);
  // AFTER:
  actionsEl.style.setProperty('--question-option-width', `${widthCh}ch`);
  ```

  **Must NOT do**:
  - Do NOT change `applyQuestionOptionWidth` call sites (lines ~6454, ~6600)
  - Do NOT remove or modify the `subagentIntervals` map usage
  - Do NOT touch the DCP/OMO/system-reminder filter logic above `upsertMessage`
  - Do NOT change the `active === false` / cleanup / stale-card-removal logic

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (depends on Task 1 conceptually; same file as Task 3 CSS)
  - **Parallel Group**: Sequential — Task 2 second
  - **Blocks**: Task 3
  - **Blocked By**: None (independent of Task 1 in practice)

  **References**:
  - `media/main.js` lines ~4454–4560: full `subagentStatus` handler
  - `media/main.js` lines ~6408–6414: `applyQuestionOptionWidth` function

  **Acceptance Criteria**:
  - [x] `grep -c "subagent-card-desc\|subagent-card-time" media/main.js` → 0
  - [x] `grep -c "subagent-name\|subagent-elapsed" media/main.js` → at least 4
  - [x] `grep -n "setProperty.*question-option-width" media/main.js` → 1 match, NOT preceded by `//`

  **QA Scenarios**:
  ```
  Scenario: Old class names gone from main.js
    Tool: Bash
    Steps:
      1. Run: grep -c "subagent-card-desc\|subagent-card-time" media/main.js
    Expected Result: 0
    Evidence: terminal output

  Scenario: New class names present in main.js
    Tool: Bash
    Steps:
      1. Run: grep -c "subagent-name\|subagent-elapsed" media/main.js
    Expected Result: >= 4
    Evidence: terminal output

  Scenario: applyQuestionOptionWidth setProperty line is uncommented
    Tool: Bash
    Steps:
      1. Run: grep -n "setProperty.*question-option-width" media/main.js
    Expected Result: 1 match, line does not start with //
    Evidence: terminal output
  ```

  **Commit**: YES (group with Task 3)
  - Message: `fix(subagent-cards): correct class names and add mode/action fields; fix question button auto-width`
  - Files: `media/main.js`, `media/main.css`
  - Pre-commit: `npm run compile`

---

- [x] 3. Fix C — main.css: update class names + question-card-btn width variable

  **What to do**:

  All changes in `d:/0.Code/OpenCodeGUI/media/main.css`. Do NOT use a new working directory.

  **Step 1** — Rename `.subagent-card-desc` CSS rule selector to `.subagent-name` (line ~1775).

  **Step 2** — Rename `.subagent-card-time` CSS rule selector to `.subagent-elapsed` (line ~1783).

  **Step 3** — After the `.subagent-elapsed` rule block, add two new rules:
  ```css
  .subagent-status {
      font-size: 0.8em;
      opacity: 0.7;
      grid-column: 1 / -1;
  }

  .subagent-action {
      font-size: 0.8em;
      opacity: 0.85;
      font-style: italic;
      grid-column: 1 / -1;
  }
  ```

  **Step 4** — In the `.question-card-btn` rule (line ~853–859), change the `width` property:
  ```css
  /* BEFORE: */
  width: 98%;
  /* AFTER: */
  width: min(var(--question-option-width, 98%), 98%);
  ```

  **Step 5** — Leave `.permission-card-actions .question-card-btn` (line ~915) UNCHANGED. Its `width: auto` override is correct and should remain.

  **Must NOT do**:
  - Do NOT change `.question-card-btn.active` rule
  - Do NOT change `.permission-card-actions .question-card-btn` rule

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES — can be done alongside Task 2 (different file)
  - **Parallel Group**: Wave 1 with Task 2
  - **Blocks**: None
  - **Blocked By**: None

  **References**:
  - `media/main.css` line ~853: `.question-card-btn` rule
  - `media/main.css` line ~915: `.permission-card-actions .question-card-btn` (do NOT change)
  - `media/main.css` line ~1775: `.subagent-card-desc` rule (rename)
  - `media/main.css` line ~1783: `.subagent-card-time` rule (rename)

  **Acceptance Criteria**:
  - [x] `grep -c "subagent-card-desc\|subagent-card-time" media/main.css` → 0
  - [x] `grep -n "\.subagent-name\|\.subagent-elapsed" media/main.css` → at least 2
  - [x] `grep -n "question-option-width" media/main.css` → at least 1 match in `.question-card-btn` rule
  - [x] `grep -A3 "permission-card-actions .question-card-btn" media/main.css` → still contains `width: auto`

  **QA Scenarios**:
  ```
  Scenario: Old subagent CSS class names gone
    Tool: Bash
    Steps:
      1. Run: grep -c "subagent-card-desc\|subagent-card-time" media/main.css
    Expected Result: 0
    Evidence: terminal output

  Scenario: question-card-btn uses CSS variable for width
    Tool: Bash
    Steps:
      1. Run: grep -n "question-option-width" media/main.css
    Expected Result: at least 1 match
    Evidence: terminal output

  Scenario: Permission button override unchanged
    Tool: Bash
    Steps:
      1. Run: grep -A4 "permission-card-actions .question-card-btn" media/main.css
    Expected Result: line with "width: auto" is still present
    Evidence: terminal output
  ```

  **Commit**: YES (group with Task 2)
  - Message: `fix(subagent-cards): correct class names and add mode/action fields; fix question button auto-width`
  - Files: `media/main.js`, `media/main.css`
  - Pre-commit: `npm run compile`

---

- [x] 4. Fix D — Status display: separate transient status strings from message text

  **Problem Analysis**:

  During streaming, real text chunks (`type: 'text'`) are silently buffered by SidebarProvider and **never sent to the webview until turn completion**. The ONLY way the webview sees text during streaming is via `assistantMessageMeta.lastText` — the **same channel** used for status strings ('Finalizing the response...', 'Writing: foo.ts', 'Editing: bar.ts'). There is no flag to distinguish status from real text.

  **3 confirmed failure modes:**
  1. **Premature 'Finalizing the response...'**: First text chunk triggers a `assistantMessageMeta(lastText='Finalizing the response...')` BEFORE the text event. SidebarProvider forwards the status immediately but silently buffers the real text. User sees 'Finalizing the response...' as the message body even though the agent is actively working.
  2. **Status persists on error path**: If an error occurs, SidebarProvider sends `chatDone` WITHOUT calling `flushAssistantBufferToWebview()`. The last status string remains as `target.text` permanently.
  3. **Compaction-triggered re-emission**: When compaction triggers resync, `resetSessionState()` clears `assistantStatusCleared` Set (line 368). When event processing restarts, the first text chunk for the same msgId re-triggers 'Finalizing the response...' because the guard was cleared.

  **Note**: The `chatChunk` handler in main.js is dead code — SidebarProvider never emits `chatChunk` events. All text updates go through `handleAssistantMeta`'s REPLACE mechanism (`target.text = message.lastText`).

  **What to do**:

  Changes span 4 files. Do NOT use a new working directory. All paths relative to `d:/0.Code/OpenCodeGUI`.

  **Step 1 — `src/OpenCodeClient.ts`: Add `isStatusUpdate: true` to status-only emissions**

  Find the 'Finalizing the response...' emission (line ~4127, inside `mapServerEventToChatEvents`, `part.type === 'text'` branch). The current code looks like:
  ```ts
  events.push({
      type: 'assistantMessageMeta', sessionId,
      assistantMsgId: part?.messageID,
      lastText: 'Finalizing the response...',
      tmpKey: this.getPendingAssistantTmpKey(sessionId)
  });
  ```
  Add `isStatusUpdate: true` to this object:
  ```ts
  events.push({
      type: 'assistantMessageMeta', sessionId,
      assistantMsgId: part?.messageID,
      lastText: 'Finalizing the response...',
      isStatusUpdate: true,
      tmpKey: this.getPendingAssistantTmpKey(sessionId)
  });
  ```

  Find the tool status emission (line ~4162, inside `part.type === 'tool'` branch). The current code looks like:
  ```ts
  events.push({ type: 'assistantMessageMeta', sessionId, assistantMsgId, lastText: statusText, tmpKey });
  ```
  Add `isStatusUpdate: true`:
  ```ts
  events.push({ type: 'assistantMessageMeta', sessionId, assistantMsgId, lastText: statusText, isStatusUpdate: true, tmpKey });
  ```

  **Step 2 — `src/SidebarProvider.ts`: Forward `isStatusUpdate` flag + flush on error**

  In `handleChatEvent`, find where `assistantMessageMeta` events are forwarded to webview (line ~3450). The current code posts:
  ```ts
  liveWebview.postMessage({ type: 'assistantMessageMeta', lastText: event.lastText, sessionId: ..., assistantMsgId: ..., tmpKey: ... });
  ```
  Add `isStatusUpdate: event.isStatusUpdate` to the postMessage payload:
  ```ts
  liveWebview.postMessage({ type: 'assistantMessageMeta', lastText: event.lastText, isStatusUpdate: event.isStatusUpdate, sessionId: ..., assistantMsgId: ..., tmpKey: ... });
  ```

  In the error handler path (line ~3479-3501), find where `chatDone` is sent AFTER an error. Add a call to `this.flushAssistantBufferToWebview(activeWebview)` BEFORE the `chatDone` post:
  ```ts
  // Before chatDone on error:
  this.flushAssistantBufferToWebview(activeWebview);
  ```
  This ensures the real text buffer is flushed even on error, preventing status strings from persisting.

  **Step 3 — `media/main.js`: Route status to `meta.statusText` instead of `target.text`**

  In `handleAssistantMeta` (line ~3966-3972), the current code is:
  ```js
  const nextText = typeof message.lastText === 'string' ? message.lastText : target.text;
  // ...
  target.text = nextText;
  target.meta = { ...target.meta, isThinking: true };
  ```
  Replace with a branching logic:
  ```js
  if (message.isStatusUpdate === true) {
      // Status-only update: store in meta, do NOT touch target.text
      target.meta = { ...target.meta, isThinking: true, statusText: message.lastText || '' };
  } else {
      // Real text update: set target.text and clear status
      const nextText = typeof message.lastText === 'string' ? message.lastText : target.text;
      target.text = nextText;
      target.meta = { ...target.meta, isThinking: true, statusText: null };
  }
  ```

  Also apply the same logic to the message creation path (line ~3944, the `upsertMessage` call when no target exists):
  ```js
  // If isStatusUpdate, create with 'Thinking...' as text, put status in meta
  if (message.isStatusUpdate === true) {
      msg = upsertMessage(resolvedSession, { ..., text: 'Thinking...', meta: { isThinking: true, statusText: message.lastText || '' } });
  } else {
      msg = upsertMessage(resolvedSession, { ..., text: message.lastText || 'Thinking...', meta: { isThinking: true } });
  }
  ```

  In `handleChatDone` (line ~4046-4092), clear `statusText` when the turn finishes:
  ```js
  if (msg) {
      msg.meta = { ...msg.meta, isThinking: false, statusText: null };
  }
  ```

  In `renderMessageElement` (line ~2759-2766), add a `.message-status` div when `meta.statusText` is present and `meta.isThinking` is true. Find the section that renders the 'thinking' class or thinking indicator, and add:
  ```js
  if (message.meta?.isThinking && message.meta?.statusText) {
      const statusDiv = document.createElement('div');
      statusDiv.className = 'message-status';
      statusDiv.textContent = message.meta.statusText;
      // Append to the message bubble container, after the markdown content
      messageContentEl.appendChild(statusDiv);
  }
  ```
  When `meta.statusText` is null/empty, do NOT render the status div (or remove it if it exists).

  **Step 4 — `media/main.css`: Add `.message-status` styling**

  Add a new rule for `.message-status`:
  ```css
  .message-status {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground, #888);
      opacity: 0.8;
      padding: 4px 0 2px;
      font-style: italic;
  }
  ```

  **Must NOT do**:
  - Do NOT change `formatToolStatus()` logic (which tools generate status strings)
  - Do NOT remove the `assistantStatusCleared` guard — it correctly prevents duplicate 'Finalizing' emissions
  - Do NOT change `chatChunk` handler (it's dead code but harmless)
  - Do NOT change the `flushAssistantBufferToWebview` logic itself
  - Do NOT change compaction filtering logic (`isCompactionSummaryInfo` etc.)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO (touches same files as Tasks 2, 3)
  - **Parallel Group**: Sequential — Task 4 after Task 3
  - **Blocks**: Task 5
  - **Blocked By**: Task 3

  **References**:
  - `src/OpenCodeClient.ts` line ~4127: 'Finalizing the response...' emission
  - `src/OpenCodeClient.ts` line ~4162: tool status emission
  - `src/OpenCodeClient.ts` line ~368: `assistantStatusCleared` cleared in `resetSessionState`
  - `src/SidebarProvider.ts` line ~3450: `assistantMessageMeta` forwarding to webview
  - `src/SidebarProvider.ts` line ~3479: error handler path (missing flush)
  - `media/main.js` line ~3966: `handleAssistantMeta` text assignment
  - `media/main.js` line ~3944: message creation with `upsertMessage`
  - `media/main.js` line ~4046: `handleChatDone`
  - `media/main.js` line ~2759: `renderMessageElement`

  **Acceptance Criteria**:
  - [x] `grep -n 'isStatusUpdate' src/OpenCodeClient.ts` → at least 2 matches
  - [x] `grep -n 'isStatusUpdate' src/SidebarProvider.ts` → at least 1 match
  - [x] `grep -n 'statusText' media/main.js` → at least 3 matches (handleAssistantMeta + handleChatDone + renderMessageElement)
  - [x] `grep -n 'message-status' media/main.css` → at least 1 match
  - [x] `grep -n 'flushAssistantBuffer' src/SidebarProvider.ts` → at least 2 matches (normal path + error path)
  - [x] `npm run compile` → exit 0, no errors

  **QA Scenarios**:
  ```
  Scenario: isStatusUpdate flag added to OpenCodeClient status emissions
    Tool: Bash
    Steps:
      1. Run: grep -n 'isStatusUpdate' src/OpenCodeClient.ts
    Expected Result: at least 2 matches (Finalizing + tool status)
    Evidence: terminal output

  Scenario: SidebarProvider forwards isStatusUpdate flag
    Tool: Bash
    Steps:
      1. Run: grep -n 'isStatusUpdate' src/SidebarProvider.ts
    Expected Result: at least 1 match
    Evidence: terminal output

  Scenario: handleAssistantMeta branches on isStatusUpdate
    Tool: Bash
    Steps:
      1. Run: grep -n 'isStatusUpdate\|statusText' media/main.js
    Expected Result: at least 4 matches
    Evidence: terminal output

  Scenario: message-status CSS rule exists
    Tool: Bash
    Steps:
      1. Run: grep -n 'message-status' media/main.css
    Expected Result: at least 1 match
    Evidence: terminal output

  Scenario: Error path flushes buffer
    Tool: Bash
    Steps:
      1. Run: grep -c 'flushAssistantBuffer' src/SidebarProvider.ts
    Expected Result: at least 2
    Evidence: terminal output
  ```

  **Commit**: YES
  - Message: `fix(status): separate transient status strings from message text with isStatusUpdate flag`
  - Files: `src/OpenCodeClient.ts`, `src/SidebarProvider.ts`, `media/main.js`, `media/main.css`
  - Pre-commit: `npm run compile`

---

- [x] 5. Fix E — Question card prompt: render with markdown

  **Problem**: Question card prompt text is rendered as plain text (`prompt.textContent = current.prompt`), but it should support markdown formatting like assistant messages do.

  **What to do**:

  All changes in `d:/0.Code/OpenCodeGUI/media/main.js`. Do NOT use a new working directory.

  **Step 1** — In `renderQuestionOverlayModal()` (line ~6449), change:
  ```js
  // BEFORE:
  prompt.textContent = current.prompt;
  // AFTER:
  renderMarkdownInto(prompt, current.prompt || '');
  ```
  The `renderMarkdownInto(element, text)` function is already available in main.js (line ~1976) — it uses markdown-it + DOMPurify, same as assistant messages.

  **Step 2** — Add a CSS class to the prompt element for proper markdown styling. Ensure the prompt element has a class that allows markdown content to render correctly (inline code, bold, italic, links, etc.).
  ```js
  prompt.className = 'question-card-prompt markdown-body';
  ```
  If `markdown-body` doesn't exist as a class, use whatever class the assistant message content area uses for markdown styling (check `renderMessageElement`).

  **Step 3** — If option `description` fields are present and shown in the question card, consider rendering those with markdown too. Currently option descriptions are not rendered in the DOM, so this is optional / future work.

  **Must NOT do**:
  - Do NOT change the button label rendering (`button.textContent = optionLabel`) — button labels should stay as plain text
  - Do NOT change the question card header rendering (`header.textContent = current.title`) — headers are limited to 30 chars and don't need markdown
  - Do NOT change permission card rendering

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO
  - **Parallel Group**: Sequential — Task 5 after Task 4
  - **Blocks**: None
  - **Blocked By**: Task 4 (same file)

  **References**:
  - `media/main.js` line ~6449: `prompt.textContent = current.prompt`
  - `media/main.js` line ~1976: `renderMarkdownInto(element, text, options)` function
  - `media/main.js` line ~2759: `renderMessageElement` for reference on markdown content styling

  **Acceptance Criteria**:
  - [x] `grep -n 'renderMarkdownInto.*prompt' media/main.js` → at least 1 match
  - [x] `grep -n 'prompt.textContent.*current.prompt' media/main.js` → 0 matches (replaced)
  - [x] `npm run compile` → exit 0

  **QA Scenarios**:
  ```
  Scenario: Question prompt uses markdown rendering
    Tool: Bash
    Steps:
      1. Run: grep -n 'renderMarkdownInto.*prompt' media/main.js
    Expected Result: at least 1 match
    Evidence: terminal output

  Scenario: Old plain text rendering removed
    Tool: Bash
    Steps:
      1. Run: grep -c 'prompt.textContent.*current.prompt' media/main.js
    Expected Result: 0
    Evidence: terminal output
  ```

  **Commit**: YES (group with Task 4)
  - Message: `fix(question-card): render prompt text with markdown`
  - Files: `media/main.js`
  - Pre-commit: `npm run compile`
---

## Final Verification Wave

- [x] F1. **Full build + grep audit** — `quick`

  Run `npm run compile` and all grep checks:
  ```bash
  npm run compile
  # Task 1 checks:
  grep -n "postMessage.*subagentStatus" src/SidebarProvider.ts     # expect: 0
  grep -n "subagentProgressBySession.set" src/SidebarProvider.ts   # expect: >= 1
  # Task 2 checks:
  grep -c "subagent-card-desc\|subagent-card-time" media/main.js   # expect: 0
  grep -c "subagent-card-desc\|subagent-card-time" media/main.css  # expect: 0
  grep -n "setProperty.*question-option-width" media/main.js       # expect: 1, not commented
  grep -n "question-option-width" media/main.css                   # expect: >= 1
  grep -A4 "permission-card-actions .question-card-btn" media/main.css  # expect: width: auto present
  # Task 4 checks:
  grep -n 'isStatusUpdate' src/OpenCodeClient.ts                   # expect: >= 2
  grep -n 'isStatusUpdate' src/SidebarProvider.ts                   # expect: >= 1
  grep -n 'statusText' media/main.js                                # expect: >= 3
  grep -n 'message-status' media/main.css                           # expect: >= 1
  grep -c 'flushAssistantBuffer' src/SidebarProvider.ts            # expect: >= 2
  # Task 5 checks:
  grep -n 'renderMarkdownInto.*prompt' media/main.js               # expect: >= 1
  grep -c 'prompt.textContent.*current.prompt' media/main.js       # expect: 0
  ```
  Output: `Build [PASS/FAIL] | All checks [N/N pass] | VERDICT: APPROVE/REJECT`

---

## Commit Strategy

- **Commit 1**: `fix(subagent): populate subagentProgressBySession and fix emitSubagentStatus payload` — `src/SidebarProvider.ts`
- **Commit 2**: `fix(subagent-cards): correct class names and add mode/action fields; fix question button auto-width` — `media/main.js`, `media/main.css`
- **Commit 3**: `fix(status): separate transient status strings from message text with isStatusUpdate flag` — `src/OpenCodeClient.ts`, `src/SidebarProvider.ts`, `media/main.js`, `media/main.css`
- **Commit 4**: `fix(question-card): render prompt text with markdown` — `media/main.js`

## Success Criteria

```bash
npm run compile                                                              # exit 0
# Subagent fixes (Tasks 1-3):
grep -n "postMessage.*subagentStatus" src/SidebarProvider.ts                # 0 matches
grep -n "subagentProgressBySession.set" src/SidebarProvider.ts              # >= 1 match
grep -c "subagent-card-desc\|subagent-card-time" media/main.js              # 0
grep -c "subagent-card-desc\|subagent-card-time" media/main.css             # 0
grep -n "setProperty.*question-option-width" media/main.js                  # 1 match, uncommented
grep -n "question-option-width" media/main.css                              # >= 1 match
grep -A4 "permission-card-actions .question-card-btn" media/main.css        # width: auto present
# Status fix (Task 4):
grep -n 'isStatusUpdate' src/OpenCodeClient.ts                              # >= 2 matches
grep -n 'isStatusUpdate' src/SidebarProvider.ts                              # >= 1 match
grep -n 'statusText' media/main.js                                           # >= 3 matches
grep -n 'message-status' media/main.css                                      # >= 1 match
grep -c 'flushAssistantBuffer' src/SidebarProvider.ts                       # >= 2
# Question markdown (Task 5):
grep -n 'renderMarkdownInto.*prompt' media/main.js                          # >= 1 match
grep -c 'prompt.textContent.*current.prompt' media/main.js                  # 0
```
