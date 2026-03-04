# Runtime Test Fixtures for Streaming Visibility and User Block Hiding

**Purpose**: Comprehensive test cases for manual verification after extension reload.  
**Target Features**: Task 1 (temporary text visibility), Task 2 (status lifecycle), Task 3 (marker hiding)  
**Evidence Type**: Runtime validation fixtures  

---

## Section A: Temporary Text Visibility

### Fixture A1: Normal Text Chunk
**Input**: `agent.latestText = "Processing file: main.js"`  
**Expected**: Div with class `.subagent-inline-text` appears, `textContent = "Processing file: main.js"`, `font-style = normal`  
**Verify**: Open DevTools → Elements tab → inspect temporary message area → check for div with correct class and text

### Fixture A2: Empty String
**Input**: `agent.latestText = ""`  
**Expected**: No div created (length check `text.length > 0` fails)  
**Verify**: DevTools shows NO `.subagent-inline-text` div in temporary message area

### Fixture A3: Null Value
**Input**: `agent.latestText = null`  
**Expected**: No div created (type check `typeof text === 'string'` fails)  
**Verify**: DevTools shows NO `.subagent-inline-text` div

### Fixture A4: Undefined Value
**Input**: `agent.latestText = undefined`  
**Expected**: No div created (type check fails)  
**Verify**: DevTools shows NO `.subagent-inline-text` div

### Fixture A5: Non-String Value (Number)
**Input**: `agent.latestText = 12345`  
**Expected**: No div created (type check fails)  
**Verify**: DevTools shows NO `.subagent-inline-text` div

### Fixture A6: Whitespace-Only String
**Input**: `agent.latestText = "   "`  
**Expected**: Div created (length > 0 passes, no trimming in logic)  
**Verify**: DevTools shows `.subagent-inline-text` with textContent = "   "

---

## Section B: Marker-Range Hiding (User Messages)

### Fixture B1: Closed Block (SYSTEM DIRECTIVE)
**Input**: User message containing:
```
My question here.

[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]
Internal system state...
<!-- OMO_INTERNAL_INITIATOR -->

More user text.
```
**Expected**: Displayed text = `"My question here.\n\nMore user text."`  
**Verify**: System directive block NOT visible in chat UI, only user text before/after visible

### Fixture B2: Closed Block (system-reminder)
**Input**: User message containing:
```
Question

<system-reminder>
Internal reminder content
<!-- OMO_INTERNAL_INITIATOR -->

Text after
```
**Expected**: Displayed text = `"Question\n\nText after"`  
**Verify**: `<system-reminder>` block NOT visible in chat UI

### Fixture B3: Unclosed Opener (SYSTEM DIRECTIVE)
**Input**: User message containing:
```
Question

[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]
No terminator here, just content
```
**Expected**: Displayed text = UNCHANGED (entire text including directive visible)  
**Verify**: Directive text VISIBLE in chat UI (graceful degradation when no terminator found)

### Fixture B4: Unclosed Opener (system-reminder)
**Input**: User message containing:
```
User text

<system-reminder>
No terminator present
```
**Expected**: Displayed text = UNCHANGED (entire text including `<system-reminder>` visible)  
**Verify**: `<system-reminder>` text VISIBLE in chat UI

### Fixture B5: Multiple Closed Blocks (Both Types)
**Input**: User message containing:
```
A

[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]
Block 1 content
<!-- OMO_INTERNAL_INITIATOR -->

B

<system-reminder>
Block 2 content
<!-- OMO_INTERNAL_INITIATOR -->

C
```
**Expected**: Displayed text = `"A\n\nB\n\nC"`  
**Verify**: Both blocks removed, only A/B/C visible in UI

### Fixture B6: No Markers (Plain Text)
**Input**: Plain user text = `"What is this error about?"`  
**Expected**: Displayed text = `"What is this error about?"` (unchanged)  
**Verify**: Text appears exactly as input, no modifications

### Fixture B7: Nested Markers (Edge Case)
**Input**: User message containing:
```
[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]
Outer start
<system-reminder>
Inner content
<!-- OMO_INTERNAL_INITIATOR -->
Outer continues
<!-- OMO_INTERNAL_INITIATOR -->
```
**Expected**: First block removed up to first terminator (inner `<system-reminder>` opener subsumed), second terminator treated as orphan (no matching opener)  
**Verify**: Complex nesting handled (document actual behavior if different from expected)

### Fixture B8: Mixed Closed and Unclosed
**Input**: User message containing:
```
Q1

[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]
Closed block
<!-- OMO_INTERNAL_INITIATOR -->

Q2

<system-reminder>
Unclosed block
```
**Expected**: First block removed, unclosed reminder preserved → `"Q1\n\nQ2\n\n<system-reminder>\nUnclosed block"`  
**Verify**: Closed block hidden, unclosed block visible (graceful degradation)

### Fixture B9: Partial Terminator (Edge Case)
**Input**: User message containing:
```
[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]
Content here
<!-- OMO_INTERNAL
```
**Expected**: Unclosed (partial terminator `<!-- OMO_INTERNAL` doesn't match exact pattern) → entire text visible  
**Verify**: Directive and partial terminator visible (no removal)

### Fixture B10: Terminator Before Opener (Edge Case)
**Input**: User message containing:
```
Text before

<!-- OMO_INTERNAL_INITIATOR -->

[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]
Content
<!-- OMO_INTERNAL_INITIATOR -->
```
**Expected**: First terminator ignored (no matching opener), second block properly closed and hidden  
**Verify**: Only "Text before" and orphaned first terminator visible (if logic preserves orphan terminators)

### Fixture B11: Empty Block (Opener and Terminator Adjacent)
**Input**: User message containing:
```
Before

[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]
<!-- OMO_INTERNAL_INITIATOR -->

After
```
**Expected**: Displayed text = `"Before\n\nAfter"` (empty block removed)  
**Verify**: No content from block visible, only before/after text

---

## Section C: Tool Status Lifecycle (Assistant Messages)

### Fixture C1: Active Streaming with Status
**Input**: Message with `meta.isThinking = true`, `meta.statusText = "Running tool: grep"`  
**Expected**: Div with class `.message-status` appears, `textContent = "Running tool: grep"`, `font-style = italic`  
**Verify**: DevTools shows `.message-status` div in temporary message area during streaming

### Fixture C2: Completed (Status Cleared)
**Input**: Message with `meta.isThinking = false`, `meta.statusText = null`  
**Expected**: NO `.message-status` div created (dual-gate condition fails)  
**Verify**: DevTools shows NO `.message-status` div (status hidden after completion)

### Fixture C3: Active Thinking without Tool
**Input**: Message with `meta.isThinking = true`, `meta.statusText = null`  
**Expected**: NO `.message-status` div (statusText gate fails)  
**Verify**: DevTools shows NO status div (only shows when both truthy)

### Fixture C4: Thinking Cleared but Status Remains (Bug Scenario)
**Input**: Message with `meta.isThinking = false`, `meta.statusText = "lingering text"`  
**Expected**: NO `.message-status` div (isThinking gate fails)  
**Verify**: Status NOT visible (dual-gate prevents lingering status)

### Fixture C5: Empty Status Text
**Input**: Message with `meta.isThinking = true`, `meta.statusText = ""`  
**Expected**: NO `.message-status` div (empty string is falsy-like for display purposes, check actual implementation)  
**Verify**: DevTools shows NO status div (or verify actual behavior if empty strings are handled)

### Fixture C6: Status Transition (Active → Cleared)
**Input**: Same message transitions from `{isThinking: true, statusText: "Running tool: bash"}` to `{isThinking: false, statusText: null}`  
**Expected**: `.message-status` div appears during first render, disappears on second render  
**Verify**: Watch DevTools Elements tab during streaming → status div removed when thinking completes

---

## Manual Test Procedure

### Prerequisites
1. **Reload Extension**: Press F5 in extension development host or reload VSCode window
2. **Open DevTools**: F12 → Elements tab (for DOM inspection)
3. **Open Console**: F12 → Console tab (for `[WV][RENDER_AUDIT]` logs)

### Test Section A: Temporary Text Visibility
1. Trigger a subagent task (e.g., use `/explore` or background agent)
2. Watch temporary message area for `.subagent-inline-text` divs during streaming
3. **Verify A1**: Text chunks appear with normal font-style (not italic)
4. **Verify A2-A5**: Empty/null/undefined/non-string values don't create divs (simulate by checking code paths or reviewing logs)
5. **Verify A6**: Whitespace-only string creates div (edge case confirmation)

### Test Section B: Marker-Range Hiding
1. Send messages with marker blocks to chat (or review existing messages in session)
2. **Verify B1-B2**: Closed blocks (directive + reminder) are hidden in UI
3. **Verify B3-B4**: Unclosed blocks remain visible (graceful degradation)
4. **Verify B5**: Plain text unchanged
5. **Verify B6**: No markers = no modifications
6. **Verify B7-B11**: Edge cases (nested, mixed, partial, orphan terminators, empty blocks)
7. Check developer console for `[WV][RENDER_AUDIT]` logs showing sanitization

### Test Section C: Tool Status Lifecycle
1. Trigger a tool call (e.g., `bash`, `read`, `grep`)
2. Watch temporary message area during execution
3. **Verify C1**: Status appears with italic font during streaming
4. **Verify C2**: After completion, status div removed from DOM
5. **Verify C3-C4**: Edge cases (no status text, lingering status) don't create divs
6. **Verify C6**: Watch status transition from visible to hidden during completion

### Evidence Capture
1. **Screenshots**: DevTools element inspection showing:
   - `.subagent-inline-text` with normal font
   - `.message-status` with italic font
   - Absence of hidden marker blocks in DOM
2. **Console Logs**: Copy `[WV][RENDER_AUDIT]` output showing:
   - Sanitization operations (blocks removed)
   - Error counts (should remain 0)
3. **Behavioral Notes**: Document any unexpected behavior in `issues.md`

---

## Acceptance Checklist

### Section A: Temporary Text Visibility
- [ ] At least one text chunk renders with `.subagent-inline-text` class during streaming
- [ ] Text content displays with `font-style: normal` (confirmed in DevTools Computed styles)
- [ ] Empty/null/undefined values do NOT create divs (verified via code path or absence in DOM)

### Section B: Marker-Range Hiding
- [ ] At least one closed SYSTEM DIRECTIVE block confirmed hidden in UI
- [ ] At least one closed `<system-reminder>` block confirmed hidden in UI
- [ ] At least one unclosed marker confirmed visible (graceful degradation working)
- [ ] Multiple blocks handled correctly (B5: both blocks hidden)
- [ ] Edge cases (nested B7, mixed B8, partial B9) behave as expected or documented

### Section C: Tool Status Lifecycle
- [ ] Status div present during streaming with correct class `.message-status`
- [ ] Status text displays with `font-style: italic` (confirmed in DevTools)
- [ ] Status div absent after completion (verified in DOM)
- [ ] Dual-gate prevents lingering status (C4 verified)

### General
- [ ] No render errors in console (`[WV][RENDER_AUDIT] errors=0` maintained)
- [ ] All edge cases behave as expected or differences documented
- [ ] Screenshots and logs captured in evidence folder

---

## Notes for User

- **This is a MANUAL test document**: Runtime validation requires extension reload and live observation.
- **DevTools is essential**: Use Elements tab for DOM inspection, Console tab for logs.
- **Edge cases matter**: Pay special attention to fixtures B7-B11 and C3-C6 (these test boundary conditions).
- **Evidence capture**: Take screenshots and save console logs to `.sisyphus/evidence/streaming-visibility-and-user-block-hiding/` folder.
- **Issues tracking**: If any fixture fails or behaves unexpectedly, document in `issues.md` with fixture ID and observed behavior.

---

**Generated**: Task 8 from streaming-visibility-and-user-block-hiding plan (line 79)  
**Date**: 2026-03-04  
**Purpose**: Runtime verification of implementation changes from Tasks 1-3
