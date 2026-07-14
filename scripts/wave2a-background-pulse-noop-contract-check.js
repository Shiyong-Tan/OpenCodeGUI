/* eslint-disable no-console */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BASELINE_APPLY_BACKGROUND_SUBAGENT_INDICATOR_HASH = '6435a6ca1bf61d21711a2154dfa9bd2bb21ef19eaf133b1f7d6834efbe443a58';
const BASELINE_RENDER_FROM_STATE_HASH = '6a0b9fb7b264af018ecd024d5c1fc646fd8dd555046d1c4044ebaa76ed93eb9f';
const BASELINE_RENDER_FROM_STATE_SIGNATURES = [
  'window.__oc?.renderFromState?.(STATUS_ONLY_PENDING_RECONCILE_RENDER_REASON);',
  "window.__oc?.renderFromState?.('unclear-anchor-circuit-breaker');",
  "if (window.__oc && typeof window.__oc.renderFromState === 'function') {",
  'window.__oc.renderFromState(renderReason);',
  "if (window.__oc && typeof window.__oc.renderFromState === 'function') {",
  'window.__oc.renderFromState(`${renderReason}-raf`);',
  'window.__oc?.renderFromState?.();',
  'window.__oc?.renderFromState?.(reason);',
  'window.__oc?.renderFromState?.();',
  'window.__oc?.renderFromState?.();',
  'window.__oc?.renderFromState?.();',
  'window.__oc?.renderFromState?.();',
  'window.__oc?.renderFromState?.();',
  'window.__oc?.renderFromState?.();',
  'window.__oc?.renderFromState?.();',
  'renderFromState();',
  'function renderFromState() {',
  "payload: ['WV', 'renderFromState', 'skip', 'reason', 'chatContainer-null']",
  "payload: ['renderFromState',",
  "countBackgroundIndicatorApplyResult(applyBackgroundSubagentIndicator(session), [`sessionId=${activeSessionId || 'null'}`, 'source=renderFromState-pre-enhance']);",
  "countBackgroundIndicatorApplyResult(applyBackgroundSubagentIndicator(session), [`sessionId=${activeSessionId || 'null'}`, 'source=renderFromState-post-audit']);",
  'window.__oc.renderFromState = scheduleRenderFromState;',
  'window.__oc?.renderFromState?.();',
  "window.__oc?.renderFromState?.('sendPrompt:user-append-fallback');",
  'window.__oc?.renderFromState?.();',
  'window.__oc?.renderFromState?.();',
  'window.__oc?.renderFromState?.();',
  'window.__oc?.renderFromState?.();',
  'window.__oc?.renderFromState?.();',
  'window.__oc?.renderFromState?.();',
  'window.__oc?.renderFromState?.();',
  'window.__oc?.renderFromState?.();',
  'window.__oc?.renderFromState?.();',
  'window.__oc?.renderFromState?.();',
  'window.__oc?.renderFromState?.();',
  'window.__oc?.renderFromState?.();',
  'window.__oc?.renderFromState?.();',
  'window.__oc?.renderFromState?.();',
  'window.__oc?.renderFromState?.();',
  'window.__oc?.renderFromState?.();',
  'window.__oc?.renderFromState?.();',
  'window.__oc?.renderFromState?.();',
  'window.__oc?.renderFromState?.();',
  'window.__oc?.renderFromState?.();',
  'window.__oc?.renderFromState?.();'
];

function read(rel) {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

function extractFunction(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing function marker: ${marker}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = braceStart; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '\'' || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unclosed function: ${marker}`);
}

function normalize(source) {
  return source.replace(/\s+/g, ' ').trim();
}

function hash(source) {
  return crypto.createHash('sha256').update(normalize(source)).digest('hex');
}

function renderFromStateSignatures(source) {
  return source
    .split(/\r?\n/)
    .filter((line) => line.includes('renderFromState'))
    .map(normalize);
}

function assert(condition, label) {
  if (!condition) throw new Error(`Wave2a background pulse no-op contract check failed: ${label}`);
}

function assertContains(source, needle, label) {
  assert(source.includes(needle), label);
}

function run() {
  const webview = read('media/main.js');
  const apply = extractFunction(webview, 'function applyBackgroundSubagentIndicator(');
  const render = extractFunction(webview, 'function renderFromState()');
  const chatWindowRoute = extractFunction(webview, 'function applyChatWindowOrWave2(');
  const arm = extractFunction(webview, 'function armBackgroundSubagentIndicator(');
  const noopStart = arm.indexOf('const backgroundPulseNoopState = getBackgroundPulseNoActiveIndicatorNoopState');
  const sharedApply = arm.lastIndexOf("handleBackgroundIndicatorPatchResult(sessionId, applyBackgroundSubagentIndicator(session), source, ['phase=arm-show']);");
  const noopBranch = arm.slice(noopStart, sharedApply);

  assert(hash(apply) === BASELINE_APPLY_BACKGROUND_SUBAGENT_INDICATOR_HASH, 'applyBackgroundSubagentIndicator normalized hash changed from the pre-edit baseline');
  const currentRenderHash = hash(render);
  assert(currentRenderHash === BASELINE_RENDER_FROM_STATE_HASH, `renderFromState normalized hash changed from the accepted Wave 3 baseline: actual=${currentRenderHash}`);
  const currentRenderSignatures = renderFromStateSignatures(webview);
  assert(BASELINE_RENDER_FROM_STATE_SIGNATURES.every((signature) => currentRenderSignatures.includes(signature)), 'pre-Wave-2 renderFromState call-site signatures are not preserved');
  assert(currentRenderSignatures.includes('function renderFromStateLegacy() {'), 'Wave 2 legacy kill-switch renderer exists');
  assert(currentRenderSignatures.includes('renderFromStateLegacy();'), 'Wave 2 coordinator routes to legacy fallback');
  assertContains(render, 'applyChatWindowOrWave2(session, units);', 'keyed render coordinator routes through the Wave 3/Wave 2 boundary');
  assertContains(render, 'if (!KEYED_CHAT_RECONCILE_ENABLED || !window.__ocRendering || keyedChatFailedSessionId === activeSessionId)', 'keyed-disabled/failed sessions retain the legacy renderer gate');
  assertContains(render, 'renderFromStateLegacy();', 'keyed-disabled/failed sessions retain the accepted legacy route');
  assertContains(chatWindowRoute, 'if (!isChatWindowAvailable())', 'window kill switch/facade failure selects Wave 2 keyed reconciliation');
  assertContains(chatWindowRoute, 'applyWindowedKeyedChatReconciliation(session, units);', 'compatible keyed rendering selects the Wave 3 window');
  assertContains(chatWindowRoute, "disableChatWindowForSession('adapter-fail-closed', windowError);", 'window failure deterministically disables Wave 3 for the session');
  assert(chatWindowRoute.split('applyKeyedChatReconciliation(session, units);').length - 1 === 2, 'Wave 2 keyed reconciliation is retained for disabled and fail-closed routes');
  assert(noopStart >= 0 && sharedApply > noopStart, 'no-op decision is at pulse entry before the shared arm-show apply/result path');
  assertContains(noopBranch, 'if (backgroundPulseNoopState)', 'no-op branch exists');
  assertContains(noopBranch, 'noteBackgroundPulseNoActiveIndicatorNoop(sessionId, backgroundPulseNoopState);', 'no-op branch only records bounded pulse state');
  assertContains(noopBranch, 'return;', 'no-op branch returns before shared apply/result handling');
  assertContains(arm, 'existingBackgroundPulseNoopState', 'repeated equivalent pulse no-ops retain rate-limited bookkeeping');
  for (const forbidden of ['applyBackgroundSubagentIndicator(', 'handleBackgroundIndicatorPatchResult(', 'renderFromState', 'requestThrottledBackgroundFallbackRender', 'scheduleUnclearAnchorCoalescedRender']) {
    assert(!noopBranch.includes(forbidden), `no-op branch does not call ${forbidden}`);
  }
  assertContains(webview, "source !== 'backgroundActivityPulse' || !sessionId || sessionId !== activeSessionId || session !== getSessionState(activeSessionId)", 'no-op is restricted to the active/current pulse session');
  assertContains(webview, "reason: 'no-active-indicator'", 'no-op predicts only the shared no-active-indicator result');
  assertContains(webview, ".message-background-subagent-indicator, .message.bot.has-background-subagent-indicator", 'no-op requires no indicator node or class');
  assertContains(webview, 'visibleTargetRequiresChange', 'no-op rejects an anchored/fallback visible target requiring change');
  assertContains(webview, 'count > 3 && count % 25 !== 0', 'no-op markers are rate limited to first three/every 25th event');
  assertContains(webview, 'background-pulse-noop-no-active-indicator', 'no-active-indicator marker exists');
  assertContains(webview, 'background-indicator-noop', 'background indicator no-op marker exists');
  assertContains(webview, 'background-pulse-render-avoided', 'render avoided marker exists');
  assertContains(webview, 'timelineCount >= 1200 || domChildren >= 1600', 'diagnostic pressure thresholds exist without changing correctness routing');
  for (const preserved of ['scroll-unpinned', 'rich-content-unsafe', 'rich-content-render-throw', 'hardRescueGenerationToken']) {
    assertContains(webview, preserved, `${preserved} preservation marker exists`);
  }
  console.log(`Wave2a background pulse no-op contract: PASS (apply=${BASELINE_APPLY_BACKGROUND_SUBAGENT_INDICATOR_HASH}, render=${BASELINE_RENDER_FROM_STATE_HASH}, signatures=${BASELINE_RENDER_FROM_STATE_SIGNATURES.length})`);
}

run();
