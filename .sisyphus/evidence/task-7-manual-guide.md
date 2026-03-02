# Task 7: Manual E2E Verification Guide

**Date**: Mon Mar 02 2026  
**Status**: REQUIRES MANUAL EXECUTION  
**Reason**: Playwright is designed for web browser automation, not VS Code Extension Development Host automation

## Technical Background

VS Code Extension Development Host is a desktop application that cannot be automated with Playwright (which is a web browser automation tool). The extension webview runs inside VS Code's desktop environment, not as a standalone web page.

**Alternative approaches considered:**
- ❌ Playwright directly: Cannot launch/control VS Code desktop app
- ❌ VS Code Extension Testing API: Does not provide webview DOM access for visual verification
- ✅ **Manual verification with structured checklist** (SELECTED APPROACH)

---

## Pre-Verification Setup

### 1. Launch Extension Development Host

```bash
# From project root: D:\0.Code\OpenCodeGUI
code --extensionDevelopmentPath=. --disable-extensions
```

**Alternative**: Press `F5` in VS Code with the extension project open.

### 2. Configure Model (MANDATORY)

**⚠️ CRITICAL: Use ONLY MiniMax M2.5 Free to avoid consuming paid quota**

1. Open OpenCode sidebar
2. Click model selector dropdown
3. Select: **MiniMax M2.5 Free**
4. Verify selection in UI before proceeding

### 3. Select Mode

1. Click mode selector
2. Choose: **plan** or **sisyphus** (both spawn subagents)
3. Recommended: **plan** mode for reliable subagent spawning

---

## Scenario 1: No Message Flickering

**Objective**: Verify messages remain stable during subagent execution

### Steps

1. Send test message: `"List files in current directory"`
2. **Immediately start visual monitoring**: Watch the chat message list
3. Observe for 30 seconds while subagent works
4. Look for these flicker patterns:
   - Messages appearing then disappearing
   - Message content changing unexpectedly
   - Chat history jumping/resetting
   - Duplicate messages appearing

### Expected Result

✅ **PASS**: All messages remain stable from appearance until turn completion  
❌ **FAIL**: Any message disappears, duplicates, or content changes mid-turn

### Evidence Required

**Screenshot Captures**:
1. `.sisyphus/evidence/task-7-scenario1-start.png` — Initial message sent
2. `.sisyphus/evidence/task-7-scenario1-during.png` — Mid-turn stable state
3. `.sisyphus/evidence/task-7-scenario1-end.png` — Turn complete, no flicker

**Text Log**:
Create `.sisyphus/evidence/task-7-scenario1-log.txt`:
```
[TIMESTAMP] Message sent: "List files in current directory"
[TIMESTAMP] Subagent work began (indicator appeared)
[TIMESTAMP] Observed for 30 seconds
[TIMESTAMP] No message disappearance detected
[TIMESTAMP] Turn completed successfully
VERDICT: PASS / FAIL
Notes: [Any observations]
```

---

## Scenario 2: Subagent Indicator Behavior

**Objective**: Verify `#subagent-indicator` element visibility matches subagent activity state

### Steps

1. **Before turn**: Verify indicator is hidden
   - Inspect element: `#subagent-indicator` should have class `.hidden`
   - Visual check: No "⚡ N subagent(s) working..." text visible

2. **During turn**: Send message (reuse from Scenario 1 if still active)
   - Watch for indicator to appear
   - Expected text: `⚡ 1 subagent working...` or `⚡ N subagents working...`
   - Element should NOT have `.hidden` class

3. **After turn**: Wait for turn completion
   - Indicator should disappear (`.hidden` class added back)
   - Text should clear

### Expected Result

✅ **PASS**: Indicator shows/hides correctly at each phase  
❌ **FAIL**: Indicator stuck visible, never appears, or incorrect text

### Evidence Required

**Screenshots**:
1. `.sisyphus/evidence/task-7-scenario2-before.png` — Indicator hidden before turn
2. `.sisyphus/evidence/task-7-scenario2-active.png` — Indicator visible during turn (with text)
3. `.sisyphus/evidence/task-7-scenario2-after.png` — Indicator hidden after turn

**DevTools Inspection**:
Create `.sisyphus/evidence/task-7-scenario2-devtools.txt`:
```
BEFORE TURN:
Element: #subagent-indicator
Classes: subagent-indicator hidden
Text: (empty)
Visible: NO

DURING TURN:
Element: #subagent-indicator
Classes: subagent-indicator
Text: "⚡ 1 subagent working..."
Visible: YES

AFTER TURN:
Element: #subagent-indicator
Classes: subagent-indicator hidden
Text: (empty)
Visible: NO

VERDICT: PASS / FAIL
```

---

## Scenario 3: Subagent Sessions NOT in Session List

**Objective**: Verify only user-owned main session appears in session list UI

### Steps

1. **Before turn**: Open session list dropdown
   - Count visible sessions
   - Note: Should show only the current main session

2. **During turn**: While subagent is working
   - Refresh session list (close and reopen dropdown)
   - Count visible sessions again
   - Expected: SAME count (subagent sessions NOT added)

3. **After turn**: Verify session list unchanged
   - Session count should still match original
   - Only main session visible

### Expected Result

✅ **PASS**: Session list shows only 1 session (main) at all phases  
❌ **FAIL**: Subagent session IDs appear in dropdown during/after turn

### Evidence Required

**Screenshots**:
1. `.sisyphus/evidence/task-7-scenario3-before.png` — Session list before turn
2. `.sisyphus/evidence/task-7-scenario3-during.png` — Session list during turn (should be unchanged)
3. `.sisyphus/evidence/task-7-scenario3-after.png` — Session list after turn (should be unchanged)

**Text Log**:
Create `.sisyphus/evidence/task-7-scenario3-sessions.txt`:
```
BEFORE TURN:
Session count: 1
Session IDs visible: [ses_xxxxx...] (main session only)

DURING TURN:
Session count: 1
Session IDs visible: [ses_xxxxx...] (same as before)
Subagent sessions in list: NO

AFTER TURN:
Session count: 1
Session IDs visible: [ses_xxxxx...] (unchanged)

VERDICT: PASS / FAIL
Notes: [Any subagent session IDs that incorrectly appeared]
```

---

## Scenario 4: Change List Includes Subagent File Changes

**Objective**: Verify file changes made by subagents appear in main session's change list

### Steps

1. **Send message that triggers file modifications**:
   - Example: `"Create a new file test.txt with content 'hello'"`
   - Use plan/sisyphus mode to ensure subagent handles request

2. **Check change list in UI**:
   - Expand "Changes" section in response
   - Look for file path entries
   - Expected: `test.txt` or modified file paths visible

3. **Verify undo boundary**:
   - Click "Undo" button
   - Check if subagent changes are reverted
   - Expected: File changes rolled back together with main session changes

### Expected Result

✅ **PASS**: Subagent-modified files appear in change list and undo together  
❌ **FAIL**: Subagent file changes missing from change list or not undoable

### Evidence Required

**Screenshots**:
1. `.sisyphus/evidence/task-7-scenario4-changelist.png` — Change list showing subagent files
2. `.sisyphus/evidence/task-7-scenario4-undo.png` — After undo, changes reverted

**Text Log**:
Create `.sisyphus/evidence/task-7-scenario4-changes.txt`:
```
MESSAGE SENT: "Create a new file test.txt with content 'hello'"

CHANGE LIST OBSERVED:
Files displayed in UI:
- test.txt (created)
[or other files modified by subagent]

UNDO TEST:
Action: Clicked "Undo" button
Result: test.txt removed / changes reverted
Subagent changes included in undo: YES / NO

VERDICT: PASS / FAIL
```

---

## Scenario 5: Session ID Stability

**Objective**: Verify `currentSessionId` does not change during subagent execution

### Steps

1. **Enable Output Channel logging**:
   - View → Output → Select "OpenCode GUI" channel
   - Look for session ID references in logs

2. **Record session ID at turn start**:
   - Send message: `"List files in current directory"`
   - Note session ID from first log entry
   - Format: `ses_xxxxxxxxxxxxxxxxxxxxx`

3. **Monitor logs during turn**:
   - Watch for any session ID changes in logs
   - Expected: Same session ID throughout

4. **Verify session ID at turn end**:
   - Check final log entries
   - Session ID should match the one from step 2

### Expected Result

✅ **PASS**: Session ID remains constant from start to end  
❌ **FAIL**: Session ID changes mid-turn (indicates hijacking)

### Evidence Required

**Output Channel Capture**:
Create `.sisyphus/evidence/task-7-scenario5-sessionid.txt`:
```
TURN START:
Session ID: ses_xxxxxxxxxxxxxxxxxxxxx
Timestamp: [timestamp from log]
Log line: [exact log line showing session ID]

DURING TURN:
Session ID in logs: ses_xxxxxxxxxxxxxxxxxxxxx (same)
Any session ID changes: NO

TURN END:
Session ID: ses_xxxxxxxxxxxxxxxxxxxxx (same)
Timestamp: [timestamp]
Log line: [exact log line]

SESSION ID STABLE: YES / NO
VERDICT: PASS / FAIL
```

**Alternative if logs don't show session ID**:
- Use browser DevTools (Help → Toggle Developer Tools)
- Monitor `webview.postMessage` calls
- Check for `sessionId` in message payloads

---

## Post-Verification Checklist

After completing all 5 scenarios:

### Required Evidence Files

Verify these files exist and contain required data:

- [ ] `.sisyphus/evidence/task-7-scenario1-start.png`
- [ ] `.sisyphus/evidence/task-7-scenario1-during.png`
- [ ] `.sisyphus/evidence/task-7-scenario1-end.png`
- [ ] `.sisyphus/evidence/task-7-scenario1-log.txt`
- [ ] `.sisyphus/evidence/task-7-scenario2-before.png`
- [ ] `.sisyphus/evidence/task-7-scenario2-active.png`
- [ ] `.sisyphus/evidence/task-7-scenario2-after.png`
- [ ] `.sisyphus/evidence/task-7-scenario2-devtools.txt`
- [ ] `.sisyphus/evidence/task-7-scenario3-before.png`
- [ ] `.sisyphus/evidence/task-7-scenario3-during.png`
- [ ] `.sisyphus/evidence/task-7-scenario3-after.png`
- [ ] `.sisyphus/evidence/task-7-scenario3-sessions.txt`
- [ ] `.sisyphus/evidence/task-7-scenario4-changelist.png`
- [ ] `.sisyphus/evidence/task-7-scenario4-undo.png`
- [ ] `.sisyphus/evidence/task-7-scenario4-changes.txt`
- [ ] `.sisyphus/evidence/task-7-scenario5-sessionid.txt`

### Summary Report

Create `.sisyphus/evidence/task-7-summary.txt`:
```
TASK 7: E2E VERIFICATION RESULTS
================================

Execution Date: [date]
Tester: [name]
Model Used: MiniMax M2.5 Free
Mode Used: plan / sisyphus

SCENARIO RESULTS:
-----------------
1. No Message Flickering: PASS / FAIL
   Notes: [brief notes]

2. Subagent Indicator: PASS / FAIL
   Notes: [brief notes]

3. Session List Filtering: PASS / FAIL
   Notes: [brief notes]

4. Change List Integration: PASS / FAIL
   Notes: [brief notes]

5. Session ID Stability: PASS / FAIL
   Notes: [brief notes]

OVERALL VERDICT: PASS / FAIL
============================

PASS Criteria: All 5 scenarios must PASS
FAIL Criteria: Any scenario FAIL = overall FAIL

Critical Issues Found:
[List any blocking issues]

Non-Critical Issues Found:
[List any minor issues]

Ready for Final Verification (F1/F2): YES / NO
```

---

## Known Limitations

This manual verification approach has the following limitations compared to automated Playwright testing:

1. **No automated assertions**: Human judgment required for pass/fail
2. **Timing variability**: 30-second observation period is approximate
3. **Screenshot timing**: May miss transient flickering if not captured at exact moment
4. **Reproducibility**: Results depend on tester's execution consistency

These limitations are acceptable given the technical constraint that Playwright cannot automate VS Code desktop applications.

---

## Troubleshooting

### Extension Development Host won't launch
- Verify VS Code version >= 1.80.0
- Check for conflicting extensions (disable all via `--disable-extensions`)
- Try `Developer: Reload Window` in VS Code

### Model selector shows no models
- Ensure OpenCode CLI is running: `opencode --version`
- Check `.opencode/server.lock.json` exists
- Restart extension: `Developer: Reload Window`

### Subagent never spawns
- Verify mode is `plan` or `sisyphus` (not `build` or `chat`)
- Try message that requires code analysis: "Explain the SidebarProvider class structure"
- Check Output Channel for errors

### Can't find Output Channel logs
- View → Output → Dropdown → "OpenCode GUI"
- If not present, check extension is activated

---

## Execution Deadline

**Recommended time**: 30-45 minutes for all 5 scenarios  
**Critical path**: Scenarios 1, 2, 5 (core functionality)  
**Optional**: Scenarios 3, 4 (if time limited, can defer but required for PASS)

---

**NEXT STEPS AFTER MANUAL VERIFICATION**:

1. Execute all 5 scenarios following this guide
2. Create all required evidence files (screenshots + text logs)
3. Create summary report in `task-7-summary.txt`
4. If overall PASS: Proceed to F1/F2 final verification tasks
5. If overall FAIL: Document failures and resume Task 3/4/5 to fix root causes
