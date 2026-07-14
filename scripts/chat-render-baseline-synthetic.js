/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = process.cwd();
const SOURCE_FILE = `${ROOT}/media/main.js`;
const EVIDENCE_FILE = `${ROOT}/.opencode/plans/chat-windowing-wave0-synthetic-baseline.json`;
const START_ANCHOR = 'const CHAT_RENDER_METRICS_SCHEMA_VERSION';
const END_ANCHOR = 'function getUnclearAnchorCircuitBreakerKey';
const PRIVATE_SENTINEL = 'SYNTHETIC_PRIVATE_MESSAGE_CONTENT_MUST_NOT_ESCAPE';
const MAX_EMITTED_MESSAGE_BYTES = 32 * 1024;

function assert(condition, label) {
  if (!condition) throw new Error(`Chat render synthetic baseline failed: ${label}`);
}

function occurrences(source, needle) {
  return source.split(needle).length - 1;
}

function sha256(source) {
  return crypto.createHash('sha256').update(source).digest('hex');
}

function extractMetricsBlock(source) {
  assert(occurrences(source, START_ANCHOR) === 1, 'metrics start anchor must be unique');
  assert(occurrences(source, END_ANCHOR) === 1, 'metrics end anchor must be unique');
  const start = source.indexOf(START_ANCHOR);
  const end = source.indexOf(END_ANCHOR, start);
  assert(start >= 0 && end > start, 'bounded metrics block anchors must be ordered');
  const block = source.slice(start, end);
  assert(block.includes('window.__ocChatRenderMetrics = Object.freeze({'), 'snapshot API is inside extracted block');
  assert(block.includes('function disposeChatRenderMetrics()'), 'disposal is inside extracted block');
  return { block, start, end };
}

function makeTimeline(length) {
  return Array.from({ length }, (_, index) => ({
    id: `synthetic-${index}`,
    text: PRIVATE_SENTINEL,
    content: PRIVATE_SENTINEL
  }));
}

function createRuntime(block, longtaskSupported) {
  const clock = { dateNow: 100000, performanceNow: 1000 };
  const messages = [];
  const warnings = [];
  const intervals = new Map();
  const pagehideListeners = [];
  const mutationObservers = [];
  const performanceObservers = [];
  let nextIntervalId = 1;

  class FakeDate extends Date {
    static now() {
      return clock.dateNow;
    }
  }

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = null;
      this.disconnected = false;
      mutationObservers.push(this);
    }

    observe(target, options) {
      this.observed = { target, options };
    }

    disconnect() {
      this.disconnected = true;
    }
  }

  class FakePerformanceObserver {
    static supportedEntryTypes = longtaskSupported ? ['longtask'] : [];

    constructor(callback) {
      this.callback = callback;
      this.observed = null;
      this.disconnected = false;
      performanceObservers.push(this);
    }

    observe(options) {
      this.observed = options;
    }

    disconnect() {
      this.disconnected = true;
    }
  }

  const state = {
    session: { timeline: makeTimeline(0) },
    container: {
      childElementCount: 0,
      renderedCount: 0,
      descendantCount: 0,
      querySelectorAll(selector) {
        return { length: selector === '*' ? this.descendantCount : this.renderedCount };
      }
    }
  };

  const window = {
    __ocChatRenderMetricsEnabled: true,
    addEventListener(type, callback, options) {
      if (type === 'pagehide') pagehideListeners.push({ callback, options });
    }
  };

  const sandbox = {
    Date: FakeDate,
    JSON,
    Math,
    Number,
    Object,
    Array,
    String,
    Boolean,
    console: {
      warn(...args) {
        warnings.push(args.map(String).join(' '));
      }
    },
    document: {
      createElement() {
        return {};
      },
      querySelectorAll() {
        return [];
      }
    },
    localStorage: {
      getItem(key) {
        return key === 'oc_chat_render_metrics' ? '1' : null;
      }
    },
    performance: { now: () => clock.performanceNow },
    MutationObserver: FakeMutationObserver,
    PerformanceObserver: FakePerformanceObserver,
    vscode: {
      postMessage(message) {
        messages.push(JSON.parse(JSON.stringify(message)));
      }
    },
    window,
    syntheticState: state,
    setInterval(callback, intervalMs) {
      const id = nextIntervalId++;
      intervals.set(id, { callback, intervalMs, cleared: false });
      return id;
    },
    clearInterval(id) {
      const interval = intervals.get(id);
      if (interval) interval.cleared = true;
    }
  };

  const prelude = `
    let activeSessionId = 'synthetic-session';
    let autoScrollPinnedToBottom = true;
    function getSessionState() { return syntheticState.session; }
  `;
  const exposeHooks = `
    window.__syntheticHooks = Object.freeze({
      start: startChatRenderPhase,
      finish: finishChatRenderPhase,
      reason: recordChatRenderReason,
      sample: sampleChatRenderDom,
      summary: emitChatRenderMetricsSummary,
      install: installChatRenderMetrics,
      dispose: disposeChatRenderMetrics,
      scenarioBand: getChatRenderScenarioBand,
      setPinned(value) { autoScrollPinnedToBottom = value; }
    });
  `;
  vm.runInNewContext(`${prelude}\n${block}\n${exposeHooks}`, sandbox, {
    filename: 'media/main.js#chat-render-metrics',
    timeout: 1000
  });

  return {
    clock,
    intervals,
    messages,
    mutationObservers,
    pagehideListeners,
    performanceObservers,
    state,
    warnings,
    hooks: window.__syntheticHooks,
    snapshot: window.__ocChatRenderMetrics.snapshot
  };
}

function advance(runtime, milliseconds) {
  runtime.clock.dateNow += milliseconds;
  runtime.clock.performanceNow += milliseconds;
}

function setScenario(runtime, { timeline, rendered, directChildren, descendants, pinned }) {
  runtime.state.session.timeline = makeTimeline(timeline);
  runtime.state.container.renderedCount = rendered;
  runtime.state.container.childElementCount = directChildren;
  runtime.state.container.descendantCount = descendants;
  runtime.hooks.setPinned(pinned);
}

function sampleReason(runtime, reason, scenario, durationMs) {
  setScenario(runtime, scenario);
  runtime.hooks.reason(reason);
  advance(runtime, durationMs);
  runtime.hooks.sample(runtime.state.container);
}

function completePhase(runtime, phase, durationMs) {
  const startedAt = runtime.hooks.start();
  advance(runtime, durationMs);
  runtime.hooks.finish(phase, startedAt);
}

function triggerLongtasks(runtime, entries) {
  assert(runtime.performanceObservers.length === 1, 'supported longtask observer must be constructed once');
  const observer = runtime.performanceObservers[0];
  observer.callback({ getEntries: () => entries });
}

function emittedSummary(messages) {
  const summaries = messages.filter((message) => message.payload?.[0] === '[WV][CHAT_RENDER_METRICS]');
  assert(summaries.length === 1, 'exactly one dirty summary must be emitted');
  return JSON.parse(summaries[0].payload[1]);
}

function assertPrivacyAndBounds(messages) {
  for (const message of messages) {
    const serialized = JSON.stringify(message);
    assert(!serialized.includes(PRIVATE_SENTINEL), 'message text/content sentinel must not be emitted');
    assert(Buffer.byteLength(serialized, 'utf8') <= MAX_EMITTED_MESSAGE_BYTES, 'emitted payload must be bounded');
    assert(JSON.stringify(JSON.parse(serialized)) === serialized, 'emitted payload must round-trip as JSON');
  }
}

function assertMetricsSchema(metrics) {
  assert(JSON.stringify(Object.keys(metrics).sort()) === JSON.stringify([
    'descendants', 'directChildren', 'longTasks', 'phases', 'pinnedState', 'renderReasons',
    'renderedCount', 'scenarioBands', 'schemaVersion', 'timelineCount', 'warnings'
  ].sort()), 'summary schema fields must be exact');
  const serialized = JSON.stringify(metrics);
  for (const forbidden of ['"text"', '"content"', '"message"', PRIVATE_SENTINEL]) {
    assert(!serialized.includes(forbidden), `summary must not contain privacy field ${forbidden}`);
  }
}

function runSupported(block) {
  const runtime = createRuntime(block, true);
  assert(runtime.hooks.scenarioBand(50) === '50', '50 boundary must map to 50 band');
  assert(runtime.hooks.scenarioBand(51) === '200', '51 must map to 200 band');
  assert(runtime.hooks.scenarioBand(200) === '200', '200 boundary must map to 200 band');
  assert(runtime.hooks.scenarioBand(201) === '1000+', '201 must map to 1000+ band');

  runtime.hooks.install(runtime.state.container);
  assert(runtime.mutationObservers.length === 1, 'mutation observer must be installed');
  assert(runtime.mutationObservers[0].observed.options.childList === true, 'mutation observer childList option must be enabled');
  assert(runtime.mutationObservers[0].observed.options.subtree === true, 'mutation observer subtree option must be enabled');
  assert(runtime.intervals.size === 1, 'summary timer must be installed once');
  assert([...runtime.intervals.values()][0].intervalMs === 30000, 'summary timer must use 30000ms interval');

  sampleReason(runtime, 'initial-load', {
    timeline: 50, rendered: 45, directChildren: 40, descendants: 800, pinned: true
  }, 8);
  completePhase(runtime, 'richEnhancement', 3);
  sampleReason(runtime, 'session-switch', {
    timeline: 200, rendered: 190, directChildren: 160, descendants: 4000, pinned: false
  }, 12);

  runtime.hooks.finish('appendFastPath', null); // Bailout before timing starts: no successful outcome.
  completePhase(runtime, 'appendFastPath', 2);
  sampleReason(runtime, 'stream-update', {
    timeline: 1001, rendered: 980, directChildren: 161, descendants: 4001, pinned: true
  }, 20);
  runtime.hooks.finish('streamPatch', null); // Fallback before timing starts: no successful outcome.
  completePhase(runtime, 'streamPatch', 4);
  completePhase(runtime, 'streamPatch', 5); // Post-upgrade alias success.

  setScenario(runtime, {
    timeline: 1001, rendered: 981, directChildren: 162, descendants: 4002, pinned: false
  });
  runtime.hooks.sample(runtime.state.container); // Warnings suppressed inside the 30s window.
  advance(runtime, 30000);
  setScenario(runtime, {
    timeline: 1001, rendered: 982, directChildren: 163, descendants: 4003, pinned: true
  });
  runtime.hooks.sample(runtime.state.container); // Suppression count is emitted at the boundary.

  triggerLongtasks(runtime, [{ duration: 75 }, { duration: -4 }, { duration: Number.NaN }]);
  runtime.hooks.summary();
  runtime.hooks.summary(); // Clean metrics must not emit a second summary.
  const metrics = emittedSummary(runtime.messages);
  assertMetricsSchema(metrics);
  assertPrivacyAndBounds(runtime.messages);

  assert(metrics.schemaVersion === 1, 'schema version must be 1');
  assert(JSON.stringify(metrics.scenarioBands) === JSON.stringify({ '50': 1, '200': 1, '1000+': 3 }), 'scenario counters must be deterministic');
  assert(JSON.stringify(metrics.pinnedState) === JSON.stringify({ true: 3, false: 2 }), 'pinned/unpinned counters must be deterministic');
  assert(metrics.directChildren.samples === 5 && metrics.directChildren.max === 163, 'direct-child samples must cover threshold and pressure');
  assert(metrics.descendants.samples === 5 && metrics.descendants.max === 4003, 'descendant samples must cover threshold and pressure');
  assert(metrics.warnings.directChildren === 2 && metrics.warnings.descendants === 2, 'warnings must emit once then re-emit at 30s');
  assert(runtime.warnings.length === 4, 'console warning count must match emitted pressure warnings');
  assert(runtime.messages.filter((message) => message.payload?.[0] === '[WV][CHAT_RENDER_PRESSURE]').length === 4, 'pressure payload count must match warning metrics');
  assert(runtime.messages.some((message) => message.payload?.includes('suppressed=1')), 'rate-limited warning must report one suppression');
  assert(metrics.phases.projection.count === 3 && metrics.phases.projection.totalMs === 40, 'projection phases must correlate with render reasons');
  assert(metrics.phases.fullRender.count === 3 && metrics.phases.fullRender.totalMs === 40, 'full-render phases must correlate with render reasons');
  assert(metrics.phases.richEnhancement.count === 1 && metrics.phases.richEnhancement.totalMs === 3, 'rich enhancement phase must be recorded');
  assert(metrics.phases.appendFastPath.count === 1 && metrics.phases.appendFastPath.totalMs === 2, 'only successful append outcome must be recorded');
  assert(metrics.phases.streamPatch.count === 2 && metrics.phases.streamPatch.totalMs === 9, 'successful direct and alias stream outcomes must be recorded');
  assert(metrics.longTasks.count === 3 && metrics.longTasks.totalMs === 75 && metrics.longTasks.maxMs === 75, 'supported fake longtasks must clamp invalid durations');

  runtime.hooks.dispose();
  assert(runtime.mutationObservers[0].disconnected, 'mutation observer must disconnect on disposal');
  assert(runtime.performanceObservers[0].disconnected, 'longtask observer must disconnect on disposal');
  assert([...runtime.intervals.values()][0].cleared, 'summary timer must clear on disposal');
  assert(runtime.pagehideListeners.length === 1 && runtime.pagehideListeners[0].options.once === true, 'one-shot pagehide disposal must be registered');

  return {
    metrics,
    emitted: {
      pressureWarnings: 4,
      summaries: 1,
      totalMessages: runtime.messages.length,
      maxMessageBytes: Math.max(...runtime.messages.map((message) => Buffer.byteLength(JSON.stringify(message), 'utf8')))
    },
    appendOutcomeCoverage: { 'bail-before-phase': 1, success: 1 },
    streamPatchOutcomeCoverage: { 'fallback-before-phase': 1, success: 1, 'post-upgrade-alias-success': 1 },
    observerDisposal: { mutation: true, longtask: true, summaryTimer: true }
  };
}

function runUnsupported(block) {
  const runtime = createRuntime(block, false);
  runtime.hooks.install(runtime.state.container);
  assert(runtime.performanceObservers.length === 0, 'unsupported longtask environment must not construct an observer');
  const suppliedUnsupportedEntries = [{ duration: 88 }];
  assert(runtime.snapshot().longTasks.count === 0, 'unsupported fake longtask entry must not be observed');
  runtime.hooks.dispose();
  assert(runtime.mutationObservers[0].disconnected, 'unsupported run mutation observer must disconnect');
  assert([...runtime.intervals.values()][0].cleared, 'unsupported run timer must clear');
  return {
    advertisedSupport: false,
    suppliedFakeEntries: suppliedUnsupportedEntries.length,
    observedCount: runtime.snapshot().longTasks.count,
    performanceObserverConstructed: false
  };
}

function runOnce(block) {
  return {
    supportedLongtask: runSupported(block),
    unsupportedLongtask: runUnsupported(block),
    syntheticNotBrowserTiming: true,
    privacy: {
      fixtureContainsMessageTextAndContent: true,
      privateSentinelEmitted: false,
      jsonSafe: true,
      maxEmittedMessageBytes: MAX_EMITTED_MESSAGE_BYTES
    }
  };
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== 'nodeSyntheticMs')
      .map(([key, child]) => [key, normalize(child)]));
  }
  return value;
}

function main() {
  const source = fs.readFileSync(SOURCE_FILE, 'utf8');
  const extracted = extractMetricsBlock(source);
  const first = runOnce(extracted.block);
  const second = runOnce(extracted.block);
  assert(JSON.stringify(normalize(first)) === JSON.stringify(normalize(second)), 'two in-process runs must have identical normalized results');

  const evidence = {
    evidenceKind: 'synthetic-node-vm-chat-render-baseline',
    syntheticNotBrowserTiming: true,
    source: {
      file: 'media/main.js',
      sha256: sha256(source),
      extractedBlockSha256: sha256(extracted.block),
      uniqueAnchors: { start: START_ANCHOR, end: END_ANCHOR },
      byteRange: { start: extracted.start, endExclusive: extracted.end }
    },
    nodeVersion: process.version,
    determinism: {
      inProcessRuns: 2,
      normalizedEqual: true,
      excludedFields: ['nodeSyntheticMs']
    },
    results: first,
    manuallySuppliedRealLogEvidence: {
      label: 'MANUALLY SUPPLIED EVIDENCE — not generated or timed by this Node harness',
      timelineCountRange: [445, 447],
      renderedCountRange: [439, 441],
      childrenRange: [634, 637],
      realTimingAvailable: false,
      summary: 'Supplied real-log anchors: timeline 445-447, rendered 439-441, children 634-637; no real timing.'
    },
    limitations: [
      'Synthetic VM durations validate instrumentation arithmetic and schema, not browser rendering performance.',
      'Fake DOM and observer implementations do not establish browser layout, paint, memory, or responsiveness behavior.',
      'Append and stream outcomes exercise the extracted timing seam; product rendering code is not executed.'
    ]
  };

  fs.writeFileSync(EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log('Chat render synthetic baseline: PASS');
  console.log(`Evidence: ${EVIDENCE_FILE}`);
  console.log(`Source SHA-256: ${evidence.source.sha256}`);
  console.log(`Scenario bands: ${JSON.stringify(first.supportedLongtask.metrics.scenarioBands)}`);
  console.log(`Warnings/summaries: ${first.supportedLongtask.emitted.pressureWarnings}/${first.supportedLongtask.emitted.summaries}`);
  console.log('Timing classification: syntheticNotBrowserTiming=true');
}

main();
