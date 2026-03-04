# Task 10: Extension-Host Reload QA (MANUAL - USER REQUIRED)

## Overview

This task requires the **USER** to manually reload the VS Code extension development host and verify the runtime behavior of all Wave 2 changes.

**Why manual?** Atlas (orchestrator) cannot launch VS Code extension hosts or interact with the UI directly. This requires human verification.

## Prerequisites

1. ✅ All code changes committed (media/main.js modified)
2. ✅ Compile passes (npm run compile exit 0)
3. ✅ LSP diagnostics clean (zero errors)
4. ✅ Runtime test fixtures created (`.sisyphus/evidence/streaming-visibility-and-user-block-hiding/runtime-test-fixtures.md`)

## User Instructions

### Step 1: Reload Extension Development Host

**In VS Code**:
1. Open the extension project (`D:\0.Code\OpenCodeGUI`)
2. Press `F5` to launch extension development host (if not already running)
3. If already running: Press `Ctrl+R` in the extension host window to reload

**Expected**: Extension reloads with latest changes from media/main.js

### Step 2: Open DevTools Console

1. In the extension host window, press `F12` to open DevTools
2. Switch to **Console** tab
3. Filter for `[WV]` to see webview debug logs
4. Look for `[WV][RENDER_AUDIT]` log line

**Expected log format**:
```
[WV][RENDER_AUDIT] rendered=XXX hidden=YYY dcpHidden=ZZZ errors=0
```

**Critical baseline**: `errors=0` MUST be maintained (any increase = regression)

### Step 3: Run Test Fixtures

Follow the **runtime-test-fixtures.md** manual test procedure:

#### Section A: Temporary Text Visibility
1. Trigger a subagent task (e.g., `/refactor` command or delegate a task)
2. During streaming, inspect temporary message area in DevTools → Elements tab
3. **Verify**:
   - [ ] `.subagent-inline-text` divs appear when text chunks stream
   - [ ] Text content is visible (not empty)
   - [ ] Font-style is **normal** (NOT italic)
   - [ ] Empty/null/undefined latestText does NOT create divs

#### Section B: Marker-Range Hiding
1. Review existing user messages in the session, OR
2. Send a test message containing:
   ```
   My question.

   [SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]
   Internal system state
   <!-- OMO_INTERNAL_INITIATOR -->

   More text.
   ```
3. **Verify**:
   - [ ] Closed directive blocks are **hidden** in chat UI
   - [ ] Only user text before/after markers is visible
   - [ ] Unclosed markers are **visible** (graceful degradation)

**To test unclosed**:
Send message with:
```
Question

[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]
No terminator
```
Expected: Directive text VISIBLE (preserved because unclosed)

#### Section C: Tool Status Lifecycle
1. Trigger a tool call (e.g., send a message that requires code search)
2. During streaming, inspect temporary message area in DevTools → Elements tab
3. **Verify**:
   - [ ] `.message-status` div appears with italic font during execution
   - [ ] Status text shows tool name (e.g., "Running tool: grep")
   - [ ] After completion, status div is **removed from DOM** (NOT just hidden)

**How to verify removal**:
- In Elements tab, select the temporary message bubble
- Watch the `.message-status` div during streaming
- After completion, confirm div is GONE (not present in HTML)

### Step 4: Capture Evidence

1. **Screenshots**:
   - Text chunks rendering with normal font
   - Marker blocks hidden in user messages
   - Status div present during streaming, absent after completion

2. **Console logs**:
   - Copy `[WV][RENDER_AUDIT]` output to evidence file below
   - Copy any `[WV][RENDER_ERR]` logs (SHOULD BE NONE)

3. **Issues**:
   - If any fixture fails, document in `.sisyphus/notepads/streaming-visibility-and-user-block-hiding/issues.md`

### Step 5: Report Results

**In the chat**, report:
```
Task 10 QA Results:

Text Visibility (Section A): [PASS/FAIL + details]
Marker Hiding (Section B): [PASS/FAIL + details]
Status Lifecycle (Section C): [PASS/FAIL + details]

[WV][RENDER_AUDIT] output:
[paste audit log]

Errors: [any errors encountered, or "NONE"]

Screenshots: [attach or describe]
```

## Acceptance Criteria

Task 10 is COMPLETE when user confirms:
- [ ] Extension reloaded successfully
- [ ] At least ONE text chunk rendered with normal font during streaming
- [ ] At least ONE closed marker block confirmed hidden in user messages
- [ ] Status div confirmed removed after tool completion
- [ ] `[WV][RENDER_AUDIT] errors=0` maintained (no regressions)
- [ ] No unexpected behavior or visual bugs

## If QA Fails

**If ANY fixture fails**:
1. Document the failure in issues.md
2. Report to Atlas in chat with specific error details
3. Atlas will resume appropriate subagent session to fix the issue

**Do NOT mark Task 10 complete** until all fixtures pass.

## Next Steps After Task 10

Once Task 10 passes, Atlas will proceed to **Final Verification (F1-F4)**:
- F1: Plan compliance audit
- F2: Code quality review
- F3: Real manual QA (this IS F3)
- F4: Scope fidelity check

## Notes

- This QA replaces automated UI tests (not feasible for VS Code extension webviews)
- User is the final authority on UX correctness
- Atlas trusts user verification as ground truth

---

**Awaiting user execution and results reporting.**
