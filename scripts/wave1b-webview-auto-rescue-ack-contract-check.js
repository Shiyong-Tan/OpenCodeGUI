/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

function read(rel) {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

function assertContains(haystack, needle, label) {
  const ok = typeof needle === 'string' ? haystack.includes(needle) : needle.test(haystack);
  if (!ok) {
    throw new Error(`Wave1b webview auto-rescue ack contract check failed: ${label}`);
  }
}

function assertNotContains(haystack, needle, label) {
  if (haystack.includes(needle)) {
    throw new Error(`Wave1b webview auto-rescue ack contract check failed: ${label}`);
  }
}

function run() {
  const sidebar = read('src/SidebarProvider.ts');
  const webview = read('media/main.js');

  assertContains(sidebar, 'webviewAutoRescuePendingAttemptById', 'extension tracks pending rescue attempts');
  assertContains(sidebar, 'webviewAutoRescueAckTimeoutMs = 5000', 'extension has 5000ms ack timeout');
  assertContains(sidebar, 'webviewAutoRescueFailureCooldownMs = 15000', 'extension has >=15000ms failure cooldown');
  assertContains(sidebar, 'webviewAutoRescue.sessionData.post', 'extension has sessionData post marker');
  assertContains(sidebar, 'webviewAutoRescue.ack.result', 'extension logs ack result marker');
  assertContains(sidebar, 'webviewAutoRescue.ack.timeout', 'extension logs ack timeout marker');
  assertContains(sidebar, 'webviewAutoRescue.ack.escalation-needed', 'extension logs bounded escalation marker');
  assertContains(sidebar, 'waitForWebviewAutoRescueRenderAck', 'extension waits for render ack before success');
  assertContains(sidebar, 'successSource=webview-render-ack', 'success marker identifies WebView render ack source');
  assertContains(sidebar, "phase === 'render-complete' || benignSkip", 'success is gated by render-complete or benign skip');
  assertContains(sidebar, "data?.reason === 'already-rendered-current-session'", 'only explicit benign render-skip can count');
  assertContains(sidebar, 'soft-rescue-posted-awaiting-ack', 'post is separated from success');
  assertContains(sidebar, 'soft-rescue-not-confirmed', 'missing ack is not success');
  assertNotContains(sidebar, "this.setWebviewAutoRescueState(record, 'cooldown', 'soft-rescue-success');\n        } else if (result.reason", 'success cooldown is not immediately after post result');

  assertContains(webview, 'postWebviewAutoRescueAck', 'WebView posts rescue ack messages');
  assertContains(webview, "type: 'webviewAutoRescueAck'", 'WebView ack message type exists');
  assertContains(webview, "event: 'webviewAutoRescue.ack'", 'WebView ack event marker exists');
  assertContains(webview, "postWebviewAutoRescueAck(message, 'received'", 'WebView posts receipt ack');
  assertContains(webview, "postWebviewAutoRescueAck(message, 'render-complete'", 'WebView posts render-complete ack');
  assertContains(webview, "postWebviewAutoRescueAck(message, 'render-skip'", 'WebView posts render-skip ack');
  assertContains(webview, "postWebviewAutoRescueAck(message, 'render-fail'", 'WebView posts render-fail ack');
  assertContains(webview, "logWebviewAutoRescueMarker('webviewAutoRescue.ack'", 'WebView logs ack marker');
  assertContains(webview, 'activeSessionMatches', 'WebView ack includes active/current session match');
  assertContains(webview, 'rescueAttemptId', 'WebView ack includes attempt id');

  console.log('Wave1b webview auto-rescue ack contract check passed.');
}

run();
