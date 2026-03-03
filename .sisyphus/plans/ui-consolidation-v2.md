# UI Consolidation V2 — Restore Lost Features + New Streaming UX + Todo List

## TL;DR

> **Quick Summary**: Restore 7 features lost in media/main.js git restore, implement 3 new UX features (streaming overhaul, question card auto-height, todo list display), all WITHOUT touching git restore.
>
> **Deliverables**:
> - Restored: BOULDER filter, turn-divider, plan file card, subagent rich cards, isStatusUpdate separation, question prompt markdown, subagent card class names
> - New: Streaming overhaul (text accumulate + tool replace + final clear + bubble flicker no text flicker), question card auto-height (3 lines max, 60% window cap), todo list display below assistant bubbles
>
> **Estimated Effort**: Large
> **Parallel Execution**: YES — 3 waves
> **Critical Path**: Task 1 (globals + BOULDER + turn-divider) → Task 3 (streaming overhaul) → Task 6 (todo list full stack) → Task 7 (compile)

---

## Context

### Original Request
User requested: "请继续分析并把之前的撤销或者未实现的计划整合到同一个plan中"

Additional new requirements:
1. Question card input auto-expand to max 3 lines, scrollbar beyond 3 lines, card height ≤ 60% of chat window
2. Streaming: text accumulates progressively, tool-use shows as italic real-time replace (not accumulate), final message clears all temp text; bubble flickers but text content inside does NOT flicker
3. Do NOT restore from git checkout

### What's Already Done (Do NOT Re-implement)
- Bug fixes from bug-fixes-premature-chatdone-init-fail.md: ALL 3 tasks [x] — session.idle wiring, agent filter for chatDone, sendInit error resilience
- Ghost bubble removal (ff5de23 already re-applied to main.js)
- SidebarProvider.ts: BOULDER filter in formatSession, planFileCard, isStatusUpdate forwarding, emitSubagentStatus with rich payload — ALL INTACT
- OpenCodeClient.ts: isStatusUpdate emissions, assistantHasDelta progressive diff — ALL INTACT
- main.css: prior plan CSS additions — INTACT

### Research Findings
- **main.js globals missing**: `let subagentIntervals = new Map()` and `let subagentCardsContainer = null`
- **handleAssistantMeta (L3866-3968)**: no isStatusUpdate branch, no statusText storage
- **chatDone (L4042-4100)**: does NOT clear statusText
- **renderMessageElement (L2507-2847)**: no statusText div, no subagent cards, no plan file card, no turn-divider, no todo list
- **renderQuestionOverlayModal (L6343-6437)**: uses `textContent =` for prompt, no auto-height input
- **subagentStatus handler (L4462-4475)**: very simple indicator only, no rich cards
- **OpenCodeClient.ts**: has `isStatusUpdate` at L108, L4140, L4175; no todowrite detection
- **SidebarProvider.ts**: no todoUpdate handler; BOULDER filter at L4229; emitSubagentStatus at L129

---

## Work Objectives

### Core Objective
Restore all 7 lost main.js features from prior plans (manually, no git restore) and implement 3 new UX features, producing a fully functional UI with rich streaming, subagent progress, todo list, and question card improvements.

### Concrete Deliverables
- `media/main.js`: 7 restorations + 3 new features
- `src/OpenCodeClient.ts`: todoUpdate event emission
- `src/SidebarProvider.ts`: todoUpdate postMessage handler
- `media/main.css`: streaming status styles + todo list styles + question card height styles

### Must Have
- BOULDER CONTINUATION messages hidden from chat
- Turn dividers between conversation turns
- Plan file cards shown with clickable filenames
- Subagent cards with title, elapsed time, latestText, latestTool
- isStatusUpdate text shown separately (not as main text), cleared on chatDone
- Question prompt rendered as markdown
- Todo list shown below assistant bubble
- Question card max 3 auto-expand lines, 60% window cap
- Streaming: text accumulates, tool events replace (one-at-a-time italic), final clears temp text
- Bubble flickers while streaming, text inside does NOT flicker/rerender
- Compile passes: `npm run compile`

### Must NOT Have (Guardrails)
- NO git checkout to restore files (manual implementation only)
- NO changes to already-working: ghost bubble, session.idle, agent filter, sendInit
- NO breaking of existing renderFromState/renderMessageElement contract
- NO new global state beyond the two missing globals (subagentIntervals, subagentCardsContainer)
- NO clickable todo checkboxes (display only)
- NO subagent todo display (only main session todos)
- NO accumulation of tool status text (always replace, not append)
- NO text flicker inside streaming bubbles (only outer bubble container may have flicker class)

---

## Verification Strategy

### Test Decision
- **Infrastructure exists**: NO
- **Automated tests**: None
- **Agent-Executed QA**: YES for all tasks via interactive_bash / Playwright

### QA Policy
Every task includes agent-executed scenarios. Evidence saved to `.sisyphus/evidence/task-{N}-{slug}.{ext}`.

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (foundation — safe isolated additions):
├── Task 1: main.js — Add globals + BOULDER filter + turn-divider [quick]
├── Task 2: main.js — Restore plan file card + handler [unspecified-high]
├── Task 4: main.js — Question prompt markdown + free-text row [quick]
└── Task 5: main.css — All new CSS (streaming status, todo, question height) [visual-engineering]

Wave 2 (complex logic — depends on Wave 1 foundations):
├── Task 3: main.js — Streaming overhaul (isStatusUpdate + chatDone clear + bubble flicker) [deep]
└── Task 6: main.js — Subagent rich cards + subagentCardsContainer logic [unspecified-high]

Wave 3 (full-stack additions):
├── Task 7: OpenCodeClient.ts + SidebarProvider.ts — todoUpdate event + handler [unspecified-high]
└── Task 8: main.js — todoUpdate message handler + renderMessageElement todo card [unspecified-high]

Wave FINAL:
└── Task 9: Compile + syntax check + smoke test [quick]
```

### Dependency Matrix
- Task 1: none → blocks Tasks 3, 6
- Task 2: none → independent
- Task 3: depends on CSS from Task 5 → blocks Task 9
- Task 4: none → independent
- Task 5: none → blocks Tasks 3, 8
- Task 6: depends on globals from Task 1 → blocks Task 9
- Task 7: none → blocks Task 8
- Task 8: depends on Tasks 5, 7 → blocks Task 9
- Task 9: depends on ALL → terminal

---

## TODOs

- [x] 1. **main.js — Add missing globals + BOULDER filter + turn-divider**

  **What to do**:
  - Add two missing globals near the existing globals block (~L26-76):
    ```js
    let subagentIntervals = new Map();
    let subagentCardsContainer = null;
    ```
  - Add BOULDER CONTINUATION filter in `renderFromState` loop (or wherever user messages are rendered from session data): skip rendering any user message where `message.text.includes('[SYSTEM DIRECTIVE: OH-MY-OPENCODE - BOULDER CONTINUATION]')`
  - Also filter in `messageAppend` case handler: before pushing to session messages, if `payload.role === 'user'` and text contains BOULDER directive, skip
  - Add turn-divider in `renderMessageElement`: when a user message is being rendered AND `renderedSet.size > 0` (i.e., not the first message), insert `<div class="turn-divider"></div>` BEFORE the user message div in chatContainer

  **Must NOT do**:
  - Do NOT alter handleChatDone, handleAssistantMeta, or streaming logic (those are Task 3)
  - Do NOT add CSS here (that's Task 5)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2, 4, 5)
  - **Blocks**: Tasks 3, 6 (need subagentIntervals + subagentCardsContainer globals)
  - **Blocked By**: None

  **References**:
  - `media/main.js` L26-76: existing globals block (insert after)
  - `media/main.js` renderFromState loop: where messages are iterated
  - `media/main.js` messageAppend case handler: where user messages are appended
  - `media/main.js` renderMessageElement: where user message div is created
  - `src/SidebarProvider.ts` L4229: SidebarProvider already tags these; same text match needed in main.js

  **Acceptance Criteria**:
  - [x] `node --check media/main.js` passes
  - [x] `subagentIntervals` and `subagentCardsContainer` globals present at file top
  - [x] BOULDER text string found in main.js (2+ locations)
  - [x] `turn-divider` string found in main.js (1+ location)

  ```
  Scenario: BOULDER message hidden
    Tool: interactive_bash (tmux)
    Steps:
      1. Load extension, trigger a /ralph-loop or BOULDER continuation
      2. Check chat UI: BOULDER user message should NOT appear
    Expected Result: No "[SYSTEM DIRECTIVE..." text visible in chat
    Evidence: .sisyphus/evidence/task-1-boulder-hidden.txt

  Scenario: Turn divider appears
    Tool: Playwright
    Steps:
      1. Have a multi-turn conversation (user → assistant → user → assistant)
      2. Assert `.turn-divider` element exists in DOM between turns
    Expected Result: At least 1 `.turn-divider` element present
    Evidence: .sisyphus/evidence/task-1-turn-divider.png
  ```

  **Commit**: YES (group with Task 2)
  - Message: `feat(ui): restore BOULDER filter, turn-divider, missing globals`

---

- [x] 2. **main.js — Restore plan file card**

  **What to do**:
  - In `renderMessageElement`: after handling changeList and undoSegment, add handler for `message.meta?.kind === 'planFile'`:
    - Create `.plan-file-card` div with header icon + "Plan File" label
    - For each file in `message.meta.files`, create a `.plan-file-name` span with click handler that sends `{type:'openFileAtLocation', path: file}` to vscode
  - Add `case 'planFileCard'` in the `window.addEventListener('message')` switch:
    - Store in `session.planFileCards = session.planFileCards || new Map()`
    - `session.planFileCards.set(data.anchorMessageId, { files: data.files })`
    - Re-render: find anchor message in `session.messagesById`, inject planFile meta, call `renderFromState()`

  **Must NOT do**:
  - Do NOT modify SidebarProvider.ts (planFileCard postMessage already implemented there)
  - Do NOT handle `.md` file detection in main.js (SidebarProvider handles that)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: Task 9
  - **Blocked By**: None

  **References**:
  - `media/main.js` renderMessageElement ~L2507: existing kind handlers pattern (changeList at L2514, undoSegmentPlaceholder at L2632) — match this pattern
  - `media/main.js` L4343: existing `window.addEventListener('message')` switch
  - `src/SidebarProvider.ts` L3463, L3693: how planFileCard is posted (fields: `anchorMessageId`, `files: string[]`)

  **Acceptance Criteria**:
  - [x] `node --check media/main.js` passes
  - [x] `planFileCard` string appears in main.js
  - [x] `plan-file-card` CSS class used in main.js

  ```
  Scenario: Plan file card rendered
    Tool: Playwright
    Steps:
      1. Trigger a session that references a .md plan file
      2. Assert `.plan-file-card` element appears in chat
      3. Click on a file name and assert `openFileAtLocation` message sent
    Expected Result: Card visible, click opens file
    Evidence: .sisyphus/evidence/task-2-planfile-card.png
  ```

  **Commit**: YES (group with Task 1)
  - Message: `feat(ui): restore plan file card rendering`

---

- [x] 3. **main.js — Streaming overhaul: isStatusUpdate + bubble flicker + final clear**

  **What to do**:

  ### A. handleAssistantMeta — split text vs status
  - **New message path** (`!target`): No change to creating thinking bubble, BUT add `meta.statusText = ''`
  - **isStatusUpdate=true path**: Set `target.meta.statusText = event.lastText` (NOT target.text). Do NOT change target.text. Call lightweight status-only DOM update (avoid full renderFromState — just update `.message-status` span in existing bubble).
  - **isStatusUpdate=false path** (real text): Set `target.text = nextText` as before. Clear `target.meta.statusText = ''`.

  ### B. handleChatDone — clear statusText
  - After marking `msg.meta.isThinking = false`, also set `msg.meta.statusText = null`

  ### C. renderMessageElement — render statusText div
  - When `message.meta?.isThinking` AND `message.meta?.statusText`:
    - Append `<div class="message-status">{statusText}</div>` inside the message bubble (after text content)
  - When NOT isThinking (final): do NOT render statusText div

  ### D. Bubble flicker — outer container only, NOT content
  - When `message.meta?.isThinking === true`: add class `streaming` to the outer bubble `div` (the wrapper element, NOT the content div)
  - The `.streaming` CSS class (Task 5) uses `@keyframes` on `border-color` or `opacity` on the bubble border/outline, NOT on text content
  - When `isThinking` becomes false: remove `streaming` class
  - **Critical**: `renderAssistantMarkdown` must NOT be called on every status update — only on real text changes. This prevents text flicker.

  ### E. Efficient partial update for status-only events
  - In handleAssistantMeta for isStatusUpdate path: instead of calling `renderFromState()`, find the existing bubble DOM element (`document.querySelector('[data-message-id="'+id+'"] .message-status')`) and update its textContent directly. Only call renderFromState if element not found (fallback).

  ### F. Final message — clear temp text
  - When `messageAppend` event arrives with `payload.role === 'assistant'` and `payload.finalizedAt`:
    - Find existing streaming message in session, update its text to `payload.text`, set `isThinking: false`, clear `statusText`
    - This ensures streaming temp text is replaced by the canonical final text

  **Must NOT do**:
  - Do NOT flicker text content inside bubble — only the bubble container border/shadow
  - Do NOT accumulate tool status texts (always replace statusText, never append)
  - Do NOT call renderFromState() on every tool status update (performance)
  - Do NOT touch chatDone ghost bubble logic (already working)

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 2 with Task 6)
  - **Parallel Group**: Wave 2
  - **Blocks**: Task 9
  - **Blocked By**: Task 1 (needs statusText in meta), Task 5 (needs CSS classes)

  **References**:
  - `media/main.js` handleAssistantMeta L3866-3968: full function to modify
  - `media/main.js` handleChatDone L4042-4100: add statusText cleanup
  - `media/main.js` renderMessageElement L2770-2847: add statusText div + streaming class
  - `media/main.js` `renderAssistantMarkdown`: confirm it's only called from renderMessageElement, not from handleAssistantMeta
  - `src/OpenCodeClient.ts` L4132-4175: how isStatusUpdate is emitted (isStatusUpdate=true for Finalizing and tool status)
  - `src/SidebarProvider.ts` L3577: how isStatusUpdate is forwarded to webview

  **Acceptance Criteria**:
  - [x] `node --check media/main.js` passes
  - [x] Tool status text (e.g., "Reading file.ts...") appears and is replaced (not accumulated)
  - [x] Bubble container has `streaming` class while streaming, removed on done
  - [x] Text content inside bubble does NOT flicker between tool events
  - [x] Final messageAppend clears temp text and shows final text

  ```
  Scenario: Tool status replaces (not accumulates)
    Tool: Playwright
    Steps:
      1. Trigger agent that uses multiple tools (read, edit, bash)
      2. Observe status text in assistant bubble during streaming
      3. Verify only ONE italic status line visible at a time (not a list)
    Expected Result: Status text is single line, replaced each time
    Evidence: .sisyphus/evidence/task-3-status-replace.png

  Scenario: Bubble flicker, text stable
    Tool: Playwright
    Steps:
      1. Start a streaming response
      2. Check outer bubble div has class 'streaming'
      3. Check text content div does NOT have animation class
      4. Wait for chatDone
      5. Check 'streaming' class removed from bubble
    Expected Result: Outer div flickers, inner text stable; flicker stops on done
    Evidence: .sisyphus/evidence/task-3-bubble-flicker.png

  Scenario: Final text replaces temp text
    Tool: Playwright
    Steps:
      1. Trigger a response (streaming will have partial text)
      2. After chatDone, verify assistant bubble shows ONLY final text
      3. No "Thinking..." or partial text remains
    Expected Result: Final canonical text displayed, no streaming artifacts
    Evidence: .sisyphus/evidence/task-3-final-clear.png
  ```

  **Commit**: YES
  - Message: `feat(ui): streaming overhaul — status replace, bubble flicker, final clear`

---

- [x] 4. **main.js — Question prompt markdown + question card auto-height**

  **What to do**:

  ### A. Prompt markdown rendering
  - In `renderQuestionOverlayModal` (~L6376): replace `prompt.textContent = current.prompt` with `renderMarkdownInto(prompt, current.prompt || '')`
  - Add `markdown-body` class to the prompt element

  ### B. Question card auto-height input
  - The question overlay currently has option buttons. User wants a free-text input row (already existed in the lost git version).
  - Add a free-text input `<textarea>` row at the bottom of the modal (before submit button if multiple, or as standalone):
    - `rows="1"` initially, auto-expands up to `rows="3"` on input
    - Beyond 3 rows: `overflow-y: auto` (scrollbar appears)
    - Listens for `Enter` (without Shift) to submit; `Shift+Enter` adds newline
    - On submit: sends `{type: 'questionFreeTextAnswer', callId: current.callId, text: input.value}`
  - Card container: add `max-height: 60vh` + `overflow-y: auto`

  **Must NOT do**:
  - Do NOT break existing options button rendering
  - Do NOT make existing multiple-select behavior stop working

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 1)
  - **Parallel Group**: Wave 1
  - **Blocks**: Task 9
  - **Blocked By**: None

  **References**:
  - `media/main.js` renderQuestionOverlayModal ~L6343-6437: full function
  - `media/main.js` `renderMarkdownInto`: find its definition, confirm signature
  - `media/main.css`: existing `.question-card` styles to understand structure
  - Lost git version had free-text row — pattern: `<div class="question-free-text-row"><textarea>...</textarea><button>Submit</button></div>`

  **Acceptance Criteria**:
  - [x] `node --check media/main.js` passes
  - [x] Question prompt renders markdown (bold, code, lists)
  - [x] Textarea expands to max 3 rows, then scrolls
  - [x] Card does not exceed 60% of viewport height

  ```
  Scenario: Markdown prompt
    Tool: Playwright
    Steps:
      1. Trigger question overlay with markdown in prompt (e.g., **bold** text)
      2. Assert rendered HTML has <strong> tag in prompt area
    Expected Result: Markdown rendered correctly
    Evidence: .sisyphus/evidence/task-4-question-md.png

  Scenario: Textarea auto-height
    Tool: Playwright
    Steps:
      1. Open question overlay with free-text input
      2. Type 4 lines of text into textarea
      3. Assert textarea height is capped (not expanding beyond 3-line height)
      4. Assert scrollbar visible
    Expected Result: Auto-height capped at 3 lines, scrollbar appears
    Evidence: .sisyphus/evidence/task-4-textarea-height.png
  ```

  **Commit**: YES (group with Task 5)
  - Message: `feat(ui): question card markdown prompt + auto-height textarea`

---

- [x] 5. **main.css — All new CSS additions**

  **What to do**:

  ### A. Turn divider
  ```css
  .turn-divider {
    border: none;
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    margin: 12px 0 8px 0;
  }
  ```

  ### B. Streaming bubble flicker (outer container only)
  ```css
  @keyframes bubble-pulse {
    0%, 100% { box-shadow: 0 0 0 1px var(--vscode-focusBorder, rgba(0,120,212,0.3)); }
    50% { box-shadow: 0 0 0 2px var(--vscode-focusBorder, rgba(0,120,212,0.6)); }
  }
  .message-bubble.streaming {
    animation: bubble-pulse 1.5s ease-in-out infinite;
  }
  /* CRITICAL: inner content must NOT animate */
  .message-bubble.streaming .message-content,
  .message-bubble.streaming .markdown-body,
  .message-bubble.streaming p,
  .message-bubble.streaming code {
    animation: none !important;
  }
  ```

  ### C. Status text (tool use italic)
  ```css
  .message-status {
    font-style: italic;
    font-size: 0.85em;
    opacity: 0.7;
    color: var(--vscode-descriptionForeground);
    margin-top: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  ```
  (Note: if `.message-status` already has rules in CSS, add/override only missing properties)

  ### D. Plan file card
  ```css
  .plan-file-card {
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    padding: 8px 12px;
    margin: 4px 0;
    font-size: 0.9em;
  }
  .plan-file-name {
    cursor: pointer;
    color: var(--vscode-textLink-foreground);
    text-decoration: underline;
    display: block;
    padding: 2px 0;
  }
  .plan-file-name:hover { opacity: 0.8; }
  ```

  ### E. Subagent cards
  ```css
  .subagent-cards { display: flex; flex-direction: column; gap: 4px; margin: 4px 0; }
  .subagent-card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px 10px; font-size: 0.85em; }
  .subagent-name { font-weight: 600; }
  .subagent-elapsed { opacity: 0.6; font-size: 0.9em; margin-left: 6px; }
  .subagent-status { font-style: italic; opacity: 0.7; }
  .subagent-action { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  ```

  ### F. Todo list
  ```css
  .todo-list { margin: 8px 0 0 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
  .todo-item { display: flex; align-items: flex-start; gap: 6px; font-size: 0.88em; padding: 2px 0; }
  .todo-check { font-size: 1em; flex-shrink: 0; line-height: 1.4; }
  .todo-content { line-height: 1.4; }
  .todo-completed .todo-content { text-decoration: line-through; opacity: 0.6; }
  .todo-completed .todo-check { color: var(--vscode-testing-iconPassed, #4caf50); }
  .todo-in_progress .todo-check { color: var(--vscode-progressBar-background, #0e70c0); }
  .todo-cancelled .todo-content { opacity: 0.4; text-decoration: line-through; }
  .todo-pending .todo-check { opacity: 0.5; }
  ```

  ### G. Question card height cap + textarea auto-height
  ```css
  .question-card { max-height: 60vh; overflow-y: auto; }
  .question-free-text-row { display: flex; gap: 6px; margin-top: 8px; align-items: flex-end; }
  .question-free-text-row textarea {
    flex: 1;
    min-height: 1.5em;
    max-height: calc(3 * 1.5em + 16px);
    overflow-y: auto;
    resize: none;
    font-family: inherit;
    font-size: inherit;
    padding: 4px 8px;
    border-radius: 4px;
    border: 1px solid var(--vscode-input-border);
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
  }
  ```

  **Must NOT do**:
  - Do NOT remove existing CSS rules — only add/extend
  - Check if `.message-status` already exists before adding duplicate

  **Recommended Agent Profile**:
  - **Category**: `visual-engineering`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 1)
  - **Parallel Group**: Wave 1
  - **Blocks**: Tasks 3, 8
  - **Blocked By**: None

  **References**:
  - `media/main.css`: read existing file first, find end of file, check for `.message-status`, `.subagent-cards`, `.todo-list` — add only missing rules
  - `media/main.js` renderMessageElement: confirms DOM structure (which classes are used on which elements)

  **Acceptance Criteria**:
  - [x] All new CSS class names present in main.css
  - [x] No duplicate rule blocks
  - [x] No syntax errors in CSS

  ```
  Scenario: Streaming bubble flicker visible
    Tool: Playwright
    Steps:
      1. Start streaming response
      2. Assert `.streaming` class on message bubble div
      3. Assert computed style shows animation property on bubble
      4. Assert text inside has no animation
    Expected Result: Bubble animates, inner text does not
    Evidence: .sisyphus/evidence/task-5-streaming-flicker.png
  ```

  **Commit**: YES (group with Task 4)
  - Message: `style(css): add streaming, todo, subagent, question card, turn-divider styles`

---

- [x] 6. **main.js — Restore subagent rich cards**

  **What to do**:

  The current `case 'subagentStatus'` handler (at two locations, ~L4462 and ~L4890) only updates a simple text indicator. Replace both with a full rich card renderer.

  ### A. Remove/replace simple handlers
  - Replace both `case 'subagentStatus'` handlers (find both via search) with the full implementation below (keep only ONE handler)

  ### B. Rich card renderer
  ```js
  case 'subagentStatus': {
    const { active, agents } = data;
    // Update the header indicator count
    const indicator = document.getElementById('subagent-indicator');
    if (indicator) {
      indicator.style.display = active && agents.length > 0 ? '' : 'none';
      indicator.textContent = active ? `${agents.length} agent${agents.length !== 1 ? 's' : ''} running` : '';
    }
    // Manage in-chat subagent cards container
    const chatContainer = document.getElementById('chat-container');
    if (!active || agents.length === 0) {
      // Clear cards and intervals
      if (subagentCardsContainer) {
        subagentCardsContainer.remove();
        subagentCardsContainer = null;
      }
      // Clear all elapsed timers
      for (const [id, timer] of subagentIntervals) clearInterval(timer);
      subagentIntervals.clear();
    } else {
      // Create container if needed
      if (!subagentCardsContainer) {
        subagentCardsContainer = document.createElement('div');
        subagentCardsContainer.className = 'subagent-cards in-chat';
        // Insert after last thinking bubble, or at end of chatContainer
        const thinkingBubble = chatContainer?.querySelector('.message-bubble.streaming');
        if (thinkingBubble?.parentElement) {
          thinkingBubble.parentElement.insertAdjacentElement('afterend', subagentCardsContainer);
        } else {
          chatContainer?.appendChild(subagentCardsContainer);
        }
      }
      // Update cards for each agent
      const renderedIds = new Set();
      for (const agent of agents) {
        const sid = agent.sessionId;
        renderedIds.add(sid);
        let card = subagentCardsContainer.querySelector(`[data-agent-id="${sid}"]`);
        if (!card) {
          card = document.createElement('div');
          card.className = 'subagent-card';
          card.dataset.agentId = sid;
          card.dataset.startedAt = agent.startedAt;
          card.innerHTML = `<span class="subagent-name"></span><span class="subagent-elapsed"></span><div class="subagent-status"></div><div class="subagent-action"></div>`;
          subagentCardsContainer.appendChild(card);
          // Elapsed time interval
          const startedAt = agent.startedAt;
          const timer = setInterval(() => {
            const el = card.querySelector('.subagent-elapsed');
            if (el) {
              const sec = Math.floor((Date.now() - startedAt) / 1000);
              el.textContent = sec < 60 ? `${sec}s` : `${Math.floor(sec/60)}m${sec%60}s`;
            }
          }, 1000);
          subagentIntervals.set(sid, timer);
        }
        card.querySelector('.subagent-name').textContent = agent.title || agent.description || 'Agent';
        card.querySelector('.subagent-status').textContent = agent.latestText ? agent.latestText.slice(0, 80) : '';
        card.querySelector('.subagent-action').textContent = agent.latestTool || '';
      }
      // Remove cards for agents no longer active
      for (const card of subagentCardsContainer.querySelectorAll('.subagent-card')) {
        if (!renderedIds.has(card.dataset.agentId)) {
          card.remove();
          const timer = subagentIntervals.get(card.dataset.agentId);
          if (timer) { clearInterval(timer); subagentIntervals.delete(card.dataset.agentId); }
        }
      }
    }
    break;
  }
  ```

  **Must NOT do**:
  - Do NOT keep the old simple `subagent-indicator` text-only handler
  - Do NOT modify emitSubagentStatus in SidebarProvider.ts (already correct)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 2 with Task 3)
  - **Parallel Group**: Wave 2
  - **Blocks**: Task 9
  - **Blocked By**: Task 1 (needs subagentIntervals + subagentCardsContainer globals)

  **References**:
  - `media/main.js` ~L4462 and ~L4890: both subagentStatus handlers to replace
  - `media/main.js` L26-76: globals block where subagentIntervals and subagentCardsContainer are added (Task 1)
  - `src/SidebarProvider.ts` L129-143: emitSubagentStatus payload shape (sessionId, title, model, latestText, latestTool, startedAt, description)
  - `media/main.css` subagent card classes (from Task 5): `.subagent-cards`, `.subagent-card`, `.subagent-name`, `.subagent-elapsed`, `.subagent-status`, `.subagent-action`

  **Acceptance Criteria**:
  - [x] `node --check media/main.js` passes
  - [x] Only ONE `case 'subagentStatus'` handler in main.js
  - [x] `subagentIntervals` referenced in main.js
  - [x] `subagentCardsContainer` referenced in main.js

  ```
  Scenario: Subagent cards appear during multi-agent run
    Tool: Playwright
    Steps:
      1. Trigger a task that spawns subagents
      2. Assert `.subagent-cards` container appears in chat
      3. Assert cards show agent title and elapsed time
      4. Wait for subagents to finish
      5. Assert cards disappear (subagentCardsContainer removed)
    Expected Result: Rich cards show during run, disappear after
    Evidence: .sisyphus/evidence/task-6-subagent-cards.png
  ```

  **Commit**: YES
  - Message: `feat(ui): restore subagent rich progress cards with elapsed timer`

---

- [x] 7. **OpenCodeClient.ts + SidebarProvider.ts — todoUpdate event**

  **What to do**:

  ### A. OpenCodeClient.ts
  - In `ChatEvent` type (L80-109): add `'todoUpdate'` to the type union string literal
  - Add field `todos?: Array<{content: string; status: string; priority: string}>` to ChatEvent
  - In `mapServerEventToChatEvents()`, after the tool completed handling (after L4184), add:
    ```typescript
    // Todowrite detection
    if (part?.type === 'tool' && part?.tool === 'todowrite' && part?.state?.status === 'completed') {
      const todos = part?.state?.metadata?.todos;
      if (Array.isArray(todos) && todos.length > 0) {
        events.push({
          type: 'todoUpdate',
          todos,
          sessionId,
          assistantMsgId: msgId || this.getTurnAssistantMsgId?.(sessionId) || '',
        });
      }
    }
    ```
  - If `getTurnAssistantMsgId` doesn't exist, use `assistantMsgId` from the current message context (the part has a `messageID` field: `part?.messageID`)

  ### B. SidebarProvider.ts
  - In `handleChatEvent()` (L3334), add a new case for `event.type === 'todoUpdate'`:
    ```typescript
    if (event.type === 'todoUpdate' && this.isUserOwnedSession(event.sessionId || '')) {
      webview.postMessage({
        type: 'todoUpdate',
        todos: event.todos,
        anchorMessageId: event.assistantMsgId,
        sessionId: event.sessionId,
      });
      return;
    }
    ```
  - This must appear BEFORE the subagent early-return check (or within the main session path only)

  **Must NOT do**:
  - Do NOT display todos for subagent sessions (only `this.currentSessionId`)
  - Do NOT add todoUpdate to the resync/formatSession path (optional for now)

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (Wave 3 with Task 8, but Task 8 depends on Task 7)
  - **Parallel Group**: Wave 3 (start first, Task 8 can begin after)
  - **Blocks**: Task 8, Task 9
  - **Blocked By**: None

  **References**:
  - `src/OpenCodeClient.ts` L80-109: ChatEvent type
  - `src/OpenCodeClient.ts` L4147-4184: tool handling section (insert todowrite detection after L4184)
  - `src/OpenCodeClient.ts` L4099: `this.assistantHasDelta.add(msgId)` — msgId scope available here
  - `src/SidebarProvider.ts` L3334: handleChatEvent function
  - `src/SidebarProvider.ts` L3336: subagent early-return pattern (place todoUpdate BEFORE or separate from this)
  - `src/SidebarProvider.ts` `this.isUserOwnedSession`: how to check if main session

  **Acceptance Criteria**:
  - [x] `npm run compile` passes (TypeScript check)
  - [x] `'todoUpdate'` in OpenCodeClient.ts ChatEvent type union
  - [x] `todos?:` field in ChatEvent
  - [x] todowrite detection block in mapServerEventToChatEvents
  - [x] todoUpdate handler in SidebarProvider handleChatEvent

  ```
  Scenario: todoUpdate event fires for main session
    Tool: interactive_bash (tmux)
    Steps:
      1. Trigger Prometheus plan generation (uses todowrite tool)
      2. Check VSCode output channel 'ui-debug' for todoUpdate messages
    Expected Result: 'todoUpdate' messages appear in output channel
    Evidence: .sisyphus/evidence/task-7-todoupdate-event.txt
  ```

  **Commit**: YES
  - Message: `feat(client+provider): emit todoUpdate event from todowrite tool completion`

---

- [x] 8. **main.js — todoUpdate message handler + todo card rendering**

  **What to do**:

  ### A. Message handler
  In `window.addEventListener('message')` switch, add:
  ```js
  case 'todoUpdate': {
    const { todos, anchorMessageId, sessionId: sid } = data;
    if (!anchorMessageId || !Array.isArray(todos)) break;
    const session = getSessionState(sid || activeSessionId);
    if (!session) break;
    const msg = session.messagesById.get(anchorMessageId);
    if (!msg) break;
    if (!msg.meta) msg.meta = {};
    msg.meta.todos = todos;
    renderFromState();
    break;
  }
  ```

  ### B. renderMessageElement — todo card
  After building the message `div` and BEFORE `chatContainer.appendChild(div)`, add:
  ```js
  // Todo list (below assistant bubble)
  if (message.role === 'assistant' && !message.meta?.isThinking &&
      Array.isArray(message.meta?.todos) && message.meta.todos.length > 0) {
    const todoCard = document.createElement('div');
    todoCard.className = 'todo-list';
    for (const todo of message.meta.todos) {
      if (!todo || typeof todo.content !== 'string') continue;
      const item = document.createElement('div');
      const status = todo.status || 'pending';
      item.className = `todo-item todo-${status}`;
      const check = document.createElement('span');
      check.className = 'todo-check';
      check.textContent = status === 'completed' ? '✓' : status === 'cancelled' ? '✗' : status === 'in_progress' ? '◎' : '○';
      const label = document.createElement('span');
      label.className = 'todo-content';
      label.textContent = todo.content;
      item.appendChild(check);
      item.appendChild(label);
      todoCard.appendChild(item);
    }
    div.appendChild(todoCard);
  }
  ```
  Note: append inside `div` (sibling of content), NOT to chatContainer directly.

  **Must NOT do**:
  - Do NOT show todos while `isThinking` is true (only show on completed messages)
  - Do NOT make todos clickable
  - Do NOT show subagent todos

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (start when Task 7 is done)
  - **Parallel Group**: Wave 3
  - **Blocks**: Task 9
  - **Blocked By**: Tasks 5 (CSS), 7 (event plumbing)

  **References**:
  - `media/main.js` renderMessageElement: find `chatContainer.appendChild(div)` (~L2847), insert todo card just before
  - `media/main.js` window message switch: find end of switch, add new case
  - `media/main.css` todo styles (Task 5): `.todo-list`, `.todo-item`, `.todo-check`, `.todo-content`, status variants
  - `src/SidebarProvider.ts` todoUpdate postMessage (Task 7): `{type:'todoUpdate', todos, anchorMessageId, sessionId}`

  **Acceptance Criteria**:
  - [x] `node --check media/main.js` passes
  - [x] `case 'todoUpdate'` in main.js message switch
  - [x] `todo-list` class used in renderMessageElement
  - [x] `✓` / `○` / `◎` / `✗` icons in main.js

  ```
  Scenario: Todo list appears below assistant bubble
    Tool: Playwright
    Steps:
      1. Trigger Prometheus plan generation (todowrite tool fires)
      2. Assert `.todo-list` div appears in DOM
      3. Assert todos with completed status show '✓' and line-through
      4. Assert pending todos show '○'
    Expected Result: Todo list visible with correct icons and strikethrough
    Evidence: .sisyphus/evidence/task-8-todo-list.png

  Scenario: Todos only on non-streaming messages
    Tool: Playwright
    Steps:
      1. During active streaming, verify no .todo-list visible on current bubble
      2. After chatDone, if todoUpdate was received, verify .todo-list appears
    Expected Result: No todos shown while streaming
    Evidence: .sisyphus/evidence/task-8-todo-streaming-guard.png
  ```

  **Commit**: YES (group with Task 7)
  - Message: `feat(ui): display todo list below assistant message bubbles`

---

- [x] 9. **Compile + smoke test**

  **What to do**:
  - Run `npm run compile` — must pass with 0 errors
  - Run `node --check media/main.js` — must pass
  - Verify key strings present in compiled output

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO — must run after ALL other tasks
  - **Blocked By**: Tasks 1-8

  **Acceptance Criteria**:
  - [x] `npm run compile` exits 0
  - [x] `node --check media/main.js` exits 0
  - [x] `grep -c "BOULDER CONTINUATION" media/main.js` ≥ 1
  - [x] `grep -c "turn-divider" media/main.js` ≥ 1
  - [x] `grep -c "planFileCard" media/main.js` ≥ 1
  - [x] `grep -c "subagentIntervals" media/main.js` ≥ 1
  - [x] `grep -c "todoUpdate" media/main.js` ≥ 1
  - [x] `grep -c "streaming" media/main.js` ≥ 1

  **Commit**: YES
  - Message: `chore: compile and verify all ui-consolidation-v2 tasks`

---

## Final Verification Wave

- [x] F1. **Code Quality Review** — `unspecified-high`
  Run `npm run compile` + `node --check media/main.js`. Search for: `console.log` in production paths, syntax errors, unclosed brackets. Check for duplicate `case` handlers in main.js switch. Verify no accidental removal of existing functionality.
  Output: `Build [PASS/FAIL] | Syntax [PASS/FAIL] | Duplicates [CLEAN/issues] | VERDICT`

---

## Commit Strategy

- Wave 1: Tasks 1+2 together, Tasks 4+5 together
- Wave 2: Task 3 alone, Task 6 alone
- Wave 3: Tasks 7+8 together
- Final: Task 9

---

## Success Criteria

```bash
npm run compile           # Expected: exit 0, 0 errors
node --check media/main.js  # Expected: exit 0
grep -c "BOULDER" media/main.js     # ≥ 1
grep -c "turn-divider" media/main.js  # ≥ 1
grep -c "todoUpdate" media/main.js  # ≥ 1
grep -c "streaming" media/main.js   # ≥ 1
```
