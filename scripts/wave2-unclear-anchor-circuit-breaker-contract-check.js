/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

function read(rel) {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

function assertContains(haystack, needle, label) {
  const ok = typeof needle === 'string' ? haystack.includes(needle) : needle.test(haystack);
  if (!ok) {
    throw new Error(`Wave2 unclear-anchor circuit-breaker contract check failed: ${label}`);
  }
}

function assertNotContains(haystack, needle, label) {
  if (haystack.includes(needle)) {
    throw new Error(`Wave2 unclear-anchor circuit-breaker contract check failed: ${label}`);
  }
}

function run() {
  const webview = read('media/main.js');

  assertContains(webview, 'UNCLEAR_ANCHOR_CIRCUIT_BREAKER_SHORT_WINDOW_MS = 5000', '5s short threshold window exists');
  assertContains(webview, 'UNCLEAR_ANCHOR_CIRCUIT_BREAKER_SHORT_LIMIT = 20', '20-failure short threshold exists');
  assertContains(webview, 'UNCLEAR_ANCHOR_CIRCUIT_BREAKER_LONG_WINDOW_MS = 30000', '30s long threshold window exists');
  assertContains(webview, 'UNCLEAR_ANCHOR_CIRCUIT_BREAKER_LONG_LIMIT = 100', '100-failure long threshold exists');
  assertContains(webview, 'UNCLEAR_ANCHOR_CIRCUIT_BREAKER_IDLE_RESET_MS = 10000', '10s idle reset exists');

  assertContains(webview, 'unclear-anchor-circuit-breaker-open', 'open marker exists');
  assertContains(webview, 'unclear-anchor-coalesced-render-scheduled', 'coalesced render marker exists');
  assertContains(webview, 'unclear-anchor-circuit-breaker-reset', 'reset marker exists');
  assertContains(webview, 'renderReason=unclear-anchor-circuit-breaker', 'coalesced render reason is logged');
  assertContains(webview, "window.__oc?.renderFromState?.('unclear-anchor-circuit-breaker')", 'coalesced render uses WebView renderFromState only');

  assertContains(webview, 'source !== \'subagentStatus\' && source !== \'backgroundActivityPulse\'', 'breaker limited to subagent/background sources');
  assertContains(webview, "reason !== 'unclear-anchor'", 'breaker limited to unclear-anchor reason');
  assertContains(webview, 'state.sessionId && state.sessionId === activeSessionId', 'active/current session isolation enforced');
  assertContains(webview, 'skipReason=inactive-session', 'inactive session skip marker exists');
  assertContains(webview, 'skipReason=already-scheduled', 'coalesced render already-scheduled skip exists');
  assertContains(webview, 'skipReason=cooldown', 'coalesced render cooldown skip exists');
  assertContains(webview, 'skipReason=open-window', 'open-window local-patch skip exists');
  assertContains(webview, 'noteUnclearAnchorCoalescedRenderComplete(activeSessionId)', 'successful render reset hook exists');

  assertContains(webview, 'recordUnclearAnchorLocalPatchFailure(sessionId, source, reason, fields)', 'subagent status failure path records breaker failures');
  assertContains(webview, "armBackgroundSubagentIndicator(sessionId, anchorAssistantId, 'backgroundActivityPulse')", 'background pulse source is passed to breaker');
  assertContains(webview, "isUnclearAnchorCircuitBreakerOpen(sessionId, 'subagentStatus', 'unclear-anchor'", 'subagent status local patch is gated while breaker is open');

  assertNotContains(webview, 'location.reload(', 'no WebView reload introduced');
  assertNotContains(webview, 'recreate=true', 'no recreate marker introduced');
  assertNotContains(webview, 'postedSessionData=true', 'no sessionData repost introduced by Wave2');

  console.log('Wave2 unclear-anchor circuit-breaker contract check passed.');
}

run();
