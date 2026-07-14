/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

function read(rel) {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

function assertContains(haystack, needle, label) {
  const ok = typeof needle === 'string' ? haystack.includes(needle) : needle.test(haystack);
  if (!ok) {
    throw new Error(`Wave1c dual-post rescue contract check failed: ${label}`);
  }
}

function assertNotContains(haystack, needle, label) {
  if (haystack.includes(needle)) {
    throw new Error(`Wave1c dual-post rescue contract check failed: ${label}`);
  }
}

function assertOrder(haystack, before, after, label) {
  const beforeIndex = haystack.indexOf(before);
  const afterIndex = haystack.indexOf(after);
  if (beforeIndex < 0 || afterIndex < 0 || beforeIndex >= afterIndex) {
    throw new Error(`Wave1c dual-post rescue contract check failed: ${label}`);
  }
}

function run() {
  const sidebar = read('src/SidebarProvider.ts');
  const webview = read('media/main.js');

  assertContains(sidebar, 'webviewAutoRescue.sessionData.post', 'not-fresh sessionData post marker exists');
  assertContains(sidebar, 'webviewAutoRescue.command.post', 'command post marker exists');
  assertContains(sidebar, 'branch=not-fresh-sessionData', 'not-fresh branch is logged');
  assertContains(sidebar, "rescueRenderMode: 'force-full-render-once'", 'not-fresh command uses force-full-render-once mode');
  assertContains(sidebar, 'postedSessionData=false | postedCommand=true', 'not-fresh command marker records command-first post state');
  assertContains(sidebar, 'postedSessionData=true | postedCommand=true', 'not-fresh sessionData marker records both post paths after dual post');
  assertContains(sidebar, 'this.markWebviewAutoRescueAttemptPosted(rescueAttemptId, { sessionData: true });', 'pending attempt records sessionData post');
  assertContains(sidebar, 'this.markWebviewAutoRescueAttemptPosted(rescueAttemptId, { command: true });', 'pending attempt records command post');
  assertOrder(sidebar, "webviewAutoRescue.command.post | action=rescue-command-posted | branch=not-fresh-sessionData", "webviewAutoRescue.sessionData.post | action=rescue-sessionData-posted | branch=not-fresh-sessionData", 'not-fresh command marker precedes sessionData marker');
  assertOrder(sidebar, "this.markWebviewAutoRescueAttemptPosted(rescueAttemptId, { command: true });", "this.markWebviewAutoRescueAttemptPosted(rescueAttemptId, { sessionData: true });", 'not-fresh command pending mark precedes sessionData pending mark');
  assertContains(sidebar, "rescueAttemptId,\n                rescueSource: 'webviewAutoRescue',\n                rescueRenderMode: 'force-full-render-once',\n                branch: 'not-fresh-sessionData'", 'not-fresh command carries shared rescueAttemptId');
  assertContains(sidebar, "rescueRenderMode: 'force-full-render-once', rescueAttemptId, branch: 'not-fresh-sessionData'", 'not-fresh sessionData carries shared rescueAttemptId');

  assertContains(sidebar, "branch: 'fresh-active-turn-command'", 'fresh branch remains command-only branch');
  assertContains(sidebar, "rescueRenderMode: 'render-current-state-once'", 'fresh branch keeps current-state command mode');
  assertContains(sidebar, 'branch=fresh-active-turn-command | panelId=', 'fresh command post marker remains separate');
  assertNotContains(sidebar, "branch: 'fresh-active-turn-command' } });\n            this.markWebviewAutoRescueAttemptPosted(rescueAttemptId, { sessionData: true });", 'fresh branch does not mark sessionData post');

  assertContains(webview, "const validFreshCommand = branch === 'fresh-active-turn-command' && message.rescueRenderMode === 'render-current-state-once';", 'WebView accepts fresh command mode narrowly');
  assertContains(webview, "const validNotFreshCommand = branch === 'not-fresh-sessionData' && message.rescueRenderMode === 'force-full-render-once';", 'WebView accepts not-fresh force render command mode narrowly');
  assertContains(webview, 'webviewAutoRescue-force-full-render-once-command', 'WebView not-fresh command render reason exists');
  assertContains(webview, "postWebviewAutoRescueAck(message, 'received'", 'WebView posts receipt ack');
  assertContains(webview, "postWebviewAutoRescueAck(message, 'render-complete'", 'WebView posts render-complete ack');
  assertContains(webview, "postWebviewAutoRescueAck(message, 'render-skip'", 'WebView posts render-skip ack');
  assertContains(webview, "return { ok: false, attemptKey, reason: 'already-rendered-current-session' };", 'duplicate command/sessionData path is benign idempotent skip');
  assertContains(webview, 'sessionId !== activeSessionId', 'WebView command verifies active/current session before render');

  assertContains(sidebar, 'webviewAutoRescue.ack.undelivered', 'extension logs canonical undelivered marker');
  assertContains(sidebar, 'classification=undelivered-no-receipt', 'undelivered marker classifies no receipt');
  assertContains(sidebar, 'if (!attempt.receivedAckSeen)', 'undelivered marker is no-receipt specific');
  assertContains(sidebar, "this.setWebviewAutoRescueState(record, 'failed', 'soft-rescue-ack-timeout')", 'timeout remains failed/not-success');
  assertContains(sidebar, 'soft-rescue-not-confirmed', 'missing/failed ack remains not confirmed');
  assertContains(sidebar, "this.setWebviewAutoRescueState(record, 'cooldown', 'soft-rescue-success');", 'success cooldown still exists only after accepted ack branch');

  assertContains(sidebar, 'webviewReload.external-unobservable', 'external reload unobservable marker exists');
  assertContains(sidebar, 'webviewReload.expected-new-webview', 'expected new webview marker exists');
  assertContains(sidebar, 'webviewReload.handshake.observed', 'handshake observed marker exists');
  assertContains(sidebar, 'webviewReload.dispose.begin', 'dispose begin marker exists');
  assertContains(sidebar, 'webviewReload.dispose.done', 'dispose done marker exists');
  assertContains(sidebar, "vscode.commands.getCommands(true)", 'Reload Webviews command is feature detected before invocation');

  console.log('Wave1c dual-post rescue contract check passed.');
}

run();
