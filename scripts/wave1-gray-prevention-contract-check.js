/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

function read(rel) {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

function assertContains(haystack, needle, label) {
  const ok = typeof needle === 'string' ? haystack.includes(needle) : needle.test(haystack);
  if (!ok) {
    throw new Error(`Wave1 gray prevention contract check failed: ${label}`);
  }
}

function assertNotContains(haystack, needle, label) {
  if (haystack.includes(needle)) {
    throw new Error(`Wave1 gray prevention contract check failed: ${label}`);
  }
}

function run() {
  const webview = read('media/main.js');
  const self = read('scripts/wave1-gray-prevention-contract-check.js');

  assertContains(webview, 'window.__oc.isRenderPending = () => renderScheduled', 'render scheduler exposes narrow pending accessor');
  assertContains(webview, "typeof window.__oc?.isRenderPending !== 'function' || !window.__oc.isRenderPending()", 'coalescing is gated by render pending accessor');
  assertContains(webview, 'pendingStatusOnlyCoalescedByKey', 'pending status-only coalescing state exists');
  assertContains(webview, 'STATUS_ONLY_PENDING_RECONCILE_RENDER_REASON', 'post-pending reconcile render reason constant exists');

  assertContains(webview, 'status-coalesce-state-only', 'state-only coalescing marker exists');
  assertContains(webview, 'status-local-patch-suppressed-unclear-anchor', 'local patch suppressed marker exists');
  assertContains(webview, 'status-reconcile-deferred-render-pending', 'deferred reconcile marker exists');
  assertContains(webview, 'status-post-pending-reconcile-scheduled', 'post-pending reconcile scheduled marker exists');
  assertContains(webview, 'shouldLogPendingStatusOnlyCoalesce', 'coalescing logging is rate-limited/summarized');
  assertContains(webview, 'count <= 3 || count % 25 === 0', 'coalescing marker avoids per-event storms');

  assertContains(webview, "reason !== 'unclear-anchor' || (source !== 'subagentStatus' && source !== 'backgroundActivityPulse')", 'coalescing limited to unclear-anchor status sources');
  assertContains(webview, "source !== 'subagentStatus' && source !== 'backgroundActivityPulse'", 'source gating includes both status sources');
  assertContains(webview, 'getBackgroundSubagentIndicatorNoClearAnchorReason(session)', 'background pulse uses no-clear-anchor prediction');
  assertContains(webview, 'isTerminalSubagentStatusUpdate(incomingAgents, doneJustNowCount)', 'terminal subagent status transitions bypass coalescing');
  assertContains(webview, 'SESSION_METADATA_RENDER_INTERVAL_MS = 250', 'subagent metadata refresh has a bounded interval');
  assertContains(webview, "scheduleCoalescedSessionMetadataRender(sessionId, 'subagentStatus-coalesced'", 'subagent status uses the metadata coalescer');
  assertContains(webview, 'immediate: terminalStatusUpdate', 'terminal subagent status flushes immediately');
  assertContains(webview, '{ coalescedRender: true }', 'local patch failures defer to the owned metadata render');

  assertContains(webview, 'isUnclearAnchorCircuitBreakerCurrentlyOpen(sessionId, source, reason)', 'coalescing checks existing Wave2 breaker without scheduling it');
  assertContains(webview, "isUnclearAnchorCircuitBreakerOpen(sessionId, source, 'unclear-anchor', ['phase=arm-show'])", 'existing background breaker path remains in use');
  assertContains(webview, "handleBackgroundIndicatorPatchResult(sessionId, applyBackgroundSubagentIndicator(latest), source, ['phase=timer-expiry-hide'])", 'background timer expiry hide semantics are unchanged');

  assertNotContains(webview, "window.__oc?.renderFromState?.('unclear-anchor-circuit-breaker')\n            window.__oc?.renderFromState?.(STATUS_ONLY_PENDING_RECONCILE_RENDER_REASON)", 'Wave1 does not directly double-schedule beside Wave2 breaker');
  assertNotContains(self, 'const sidebar' + ' = read', 'contract check does not require extension-side files');

  console.log('Wave1 gray prevention contract check passed.');
}

run();
