/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

function assert(condition, label) {
  if (!condition) throw new Error(`Chat render baseline contract check failed: ${label}`);
}

function assertContains(source, needle, label) {
  assert(source.includes(needle), label);
}

function count(source, needle) {
  return source.split(needle).length - 1;
}

function run() {
  const source = read('media/main.js');

  for (const field of [
    'projection', 'fullRender', 'richEnhancement', 'appendFastPath', 'streamPatch',
    'directChildren', 'descendants', 'renderReasons', 'pinnedState',
    'timelineCount', 'renderedCount', 'longTasks'
  ]) {
    assertContains(source, field, `aggregate metrics field ${field} exists`);
  }

  assertContains(source, "localStorage.getItem('oc_chat_render_metrics') === '1'", 'metrics are developer guarded');
  assertContains(source, "supportedEntryTypes.includes('longtask')", 'long-task support is checked');
  assertContains(source, "observer.observe({ type: 'longtask', buffered: true });", 'long-task observer is guarded and buffered');
  assertContains(source, 'chatRenderLongTaskObserver?.disconnect();', 'long-task observer is disposable');
  assertContains(source, 'CHAT_RENDER_DIRECT_CHILD_WARNING_THRESHOLD = 160', 'direct-child warning threshold is exactly 160');
  assertContains(source, 'CHAT_RENDER_DESCENDANT_WARNING_THRESHOLD = 4000', 'descendant warning threshold is exactly 4000');
  assertContains(source, 'CHAT_RENDER_METRICS_SUMMARY_INTERVAL_MS = 30000', 'summary frequency is low-volume');
  assertContains(source, 'CHAT_RENDER_WARNING_INTERVAL_MS = 30000', 'warnings are rate limited');
  assertContains(source, "['50', '200', '1000+']", 'static synthetic scenario bands are recorded');

  const metricsBlockStart = source.indexOf('const CHAT_RENDER_METRICS_SCHEMA_VERSION');
  const metricsBlockEnd = source.indexOf('function getUnclearAnchorCircuitBreakerKey', metricsBlockStart);
  assert(metricsBlockStart >= 0 && metricsBlockEnd > metricsBlockStart, 'bounded metrics implementation block exists');
  const metricsBlock = source.slice(metricsBlockStart, metricsBlockEnd);
  for (const forbidden of ['message.text', 'message.content', 'msg.text', 'content.textContent', 'innerHTML']) {
    assert(!metricsBlock.includes(forbidden), `metrics do not capture message content via ${forbidden}`);
  }
  for (const forbidden of ['requestAnimationFrame(', 'requestIdleCallback(', '.appendChild(', '.remove(', '.innerHTML =', '.replaceChildren(']) {
    assert(!metricsBlock.includes(forbidden), `instrumentation does not schedule rendering or mutate DOM via ${forbidden}`);
  }

  const directWriterContracts = [
    ["chatContainer.innerHTML = '';", 2],
    ['chatContainer.appendChild(div);', 2],
    ['chatContainer.appendChild(messageElement);', 1],
    ['chatContainer.appendChild(row);', 1],
    ['chatContainer.appendChild(container);', 3],
    ['chatContainer.appendChild(divider);', 1],
    ['content.innerHTML = beforeHtml;', 1]
  ];
  for (const [operation, expected] of directWriterContracts) {
    assert(count(source, operation) === expected, `writer signature count preserved for ${operation}`);
  }
  assertContains(source, 'renderMessageElement(message, renderedSet);', 'append fast path still delegates to the existing renderer');
  assertContains(source, 'renderAssistantMarkdown(content, message);', 'stream patch still uses the existing markdown renderer');
  assertContains(source, 'scrollToBottom(true);', 'existing pinned scroll operation remains');

  console.log('Chat render baseline contract: PASS (schema, guards, thresholds, privacy, writer signatures)');
  console.log('Static baseline scenarios: 50, 200, 1000+ timeline entries; render/append/stream/search/session-switch hooks present; runtime timings and manual smoke pending.');
}

run();
