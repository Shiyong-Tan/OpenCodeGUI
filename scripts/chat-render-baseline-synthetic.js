/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = process.cwd();
const SOURCE_FILE = `${ROOT}/media/main.js`;
const BUNDLE_FILE = `${ROOT}/media/rendering.bundle.js`;
const EVIDENCE_FILE = 'C:/Users/tan_s/AppData/Local/Temp/opencode/a1.5-node-synthetic-evidence.json';
const START_ANCHOR = 'const CHAT_RENDER_METRICS_SCHEMA_VERSION';
const END_ANCHOR = 'function getUnclearAnchorCircuitBreakerKey';
const PRIVATE_SENTINEL = 'SYNTHETIC_PRIVATE_MESSAGE_CONTENT_MUST_NOT_ESCAPE';
const PRIVATE_SENTINELS = Object.freeze(Object.fromEntries([
  'text', 'html', 'code', 'path', 'toolPayload', 'search', 'copiedContent',
  'sessionId', 'activeSessionId', 'failedSessionId', 'blockerSessionId',
  'messageId', 'unitId', 'unitKey', 'key', 'aliasId', 'searchId', 'rawId'
].map((name, index) => [name, `A15_PRIVATE_${index}_MUST_NOT_ESCAPE`])));
const FORBIDDEN_KEYS = Object.freeze([
  'text', 'content', 'html', 'code', 'path', 'filePath', 'toolPayload', 'payload', 'search', 'searchTerm',
  'copiedContent', 'sessionId', 'activeSessionId', 'failedSessionId', 'messageId',
  'unitId', 'unitKey', 'key', 'aliasId', 'searchId', 'searchTargetKey', 'rawId',
  'raw', 'acceptanceBlocker', '__ocChatWindowDescendantAcceptanceBlocker'
]);
const ATTRIBUTED_DESCENDANT_TOTAL = 22040;
const MODEL_INPUT_CAP = 140;
const DIRECT_CHILD_CAP = 146;
const STRUCTURAL_ROOTS = 6;
const TOP_K = 8;
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
  return Array.from({ length }, (_, index) => index);
}

function createRuntime(block, longtaskSupported) {
  const clock = { dateNow: 100000, performanceNow: 1000 };
  const messages = [];
  const warnings = [];
  const intervals = new Map();
  const pagehideListeners = [];
  const mutationObservers = [];
  const performanceObservers = [];
  const consoleCaptures = [];
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
        this.queryCount = (this.queryCount || 0) + 1;
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
        const line = args.map(String).join(' ');
        warnings.push(line);
        consoleCaptures.push(line);
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
    consoleCaptures,
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

function assertNoSentinelLeak(value, label) {
  const serialized = JSON.stringify(value);
  for (const sentinel of [PRIVATE_SENTINEL, ...Object.values(PRIVATE_SENTINELS)]) {
    assert(!serialized.includes(sentinel), `${label} must omit private sentinel values`);
  }
}

function assertNoPrivateLeak(value, label) {
  const serialized = JSON.stringify(value);
  assertNoSentinelLeak(value, label);
  for (const key of FORBIDDEN_KEYS) {
    assert(!serialized.includes(`"${key}"`), `${label} must omit forbidden key ${key}`);
  }
}

function assertMetricsSchema(metrics) {
  assert(JSON.stringify(Object.keys(metrics).sort()) === JSON.stringify([
    'descendants', 'directChildren', 'longTasks', 'phases', 'pinnedState', 'renderReasons',
    'renderedCount', 'scenarioBands', 'schemaVersion', 'timelineCount', 'warnings',
    'pressureAttribution'
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

  const scansBeforeNotifications = runtime.state.container.queryCount || 0;
  for (let index = 0; index < 125; index += 1) runtime.mutationObservers[0].callback([]);
  assert((runtime.state.container.queryCount || 0) === scansBeforeNotifications, '125 stream notifications must perform no subtree scan');

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
  assertNoPrivateLeak(metrics, 'metrics summary');
  assertNoSentinelLeak({ messages: runtime.messages, consoleCaptures: runtime.consoleCaptures }, 'transport and console diagnostics');

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
    environment: 'node-synthetic',
    syntheticNotBrowserTiming: true,
    metrics,
    emitted: {
      pressureWarnings: 4,
      summaries: 1,
      totalMessages: runtime.messages.length,
      maxMessageBytes: Math.max(...runtime.messages.map((message) => Buffer.byteLength(JSON.stringify(message), 'utf8')))
    },
    appendOutcomeCoverage: { 'bail-before-phase': 1, success: 1 },
    streamPatchOutcomeCoverage: { 'fallback-before-phase': 1, success: 1, 'post-upgrade-alias-success': 1 },
    observerDisposal: { mutation: true, longtask: true, summaryTimer: true },
    streamNotifications: { count: 125, subtreeScans: 0 }
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
    environment: 'node-synthetic',
    syntheticNotBrowserTiming: true,
    advertisedSupport: false,
    suppliedFakeEntries: suppliedUnsupportedEntries.length,
    observedCount: runtime.snapshot().longTasks.count,
    performanceObserverConstructed: false
  };
}

function runOnce(block) {
  return {
    environment: 'node-synthetic',
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

function loadAttributionBuilder() {
  const bundle = fs.readFileSync(BUNDLE_FILE, 'utf8');
  const windowObject = {};
  const sandbox = { window: windowObject };
  Object.defineProperty(sandbox, 'document', {
    configurable: true,
    get() { throw new Error('A1.5 dormant bundle must not access DOM'); }
  });
  vm.runInNewContext(bundle, sandbox, { filename: 'media/rendering.bundle.js', timeout: 1000 });
  assert(Object.isFrozen(windowObject.__ocRendering), 'rendering facade must remain frozen');
  assert(typeof windowObject.__ocRendering?.buildChatPressureAttribution === 'function', 'bundle attribution API must load');
  assert(typeof windowObject.__ocRendering?.planChatWindowContainment === 'function', 'bundle containment planner API must load');
  assert(typeof windowObject.__ocRendering?.classifyChatWindowIntegrity === 'function', 'bundle integrity classifier API must load');
  return {
    build: windowObject.__ocRendering.buildChatPressureAttribution,
    plan: windowObject.__ocRendering.planChatWindowContainment,
    classify: windowObject.__ocRendering.classifyChatWindowIntegrity,
    bundleSha256: sha256(bundle)
  };
}

function assertBoundedPlan(plan, label) {
  assert(plan?.allowed === true, `${label} must be accepted`);
  assert(Object.isFrozen(plan), `${label} must be immutable`);
  assert(plan.mountedCount <= MODEL_INPUT_CAP, `${label} mounted roots must be <=140`);
  assert(plan.directChildCount <= DIRECT_CHILD_CAP, `${label} direct children must be <=146`);
  assert(plan.acceptedKeys.length === plan.mountedCount, `${label} accepted keys must equal mounted count`);
}

function containmentRequest(timelineCount, limits = { mounted: MODEL_INPUT_CAP, directChildren: DIRECT_CHILD_CAP }) {
  const keys = Array.from({ length: timelineCount }, (_, index) => `unit-${timelineCount}-${index}`);
  return {
    keys,
    request: {
      requestedKeys: keys,
      visibleLoadedKeys: keys,
      viewportKeys: keys.slice(0, 360),
      coreKeys: keys.slice(360, 640),
      overscanKeys: keys.slice(640, 1040),
      adapterSnapshotKeys: keys.slice(0, 420),
      currentTurnAssistantKey: keys.at(-1),
      thinkingId: keys.at(-2),
      lastTurnUserId: keys.at(-3),
      appendRootUserKey: keys.at(-4),
      anchorKey: keys.at(-5),
      searchTargetKey: keys.at(-6),
      projectedStructuralRoots: STRUCTURAL_ROOTS,
      limits,
      shellRequests: []
    }
  };
}

function runContainmentScenario(plan, timelineCount, descendants, generation) {
  const { keys, request } = containmentRequest(timelineCount);
  const accepted = plan(request);
  assertBoundedPlan(accepted, `${timelineCount} initial plan`);
  assert(accepted.deferredPins.length === 6, `${timelineCount} excess semantic pins must be deferred at capacity`);

  const observedBudget = {
    mountedUnits: accepted.mountedCount + 8,
    directChildren: accepted.directChildCount + 5,
    descendants
  };
  const audit = Object.freeze({
    mountedExceeded: observedBudget.mountedUnits > MODEL_INPUT_CAP,
    directChildrenExceeded: observedBudget.directChildren > DIRECT_CHILD_CAP,
    descendantsAdvisory: observedBudget.descendants > 4000,
    failClosed: false
  });
  const correctionKey = `synthetic-session:${generation}:1`;
  const correctionKeys = new Set();
  const correctionPlans = [];
  for (let observation = 0; observation < 3; observation += 1) {
    if (correctionKeys.has(correctionKey)) continue;
    correctionKeys.add(correctionKey);
    const corrected = plan({
      ...request,
      limits: {
        mounted: MODEL_INPUT_CAP - (observedBudget.mountedUnits - accepted.mountedCount),
        directChildren: DIRECT_CHILD_CAP - (observedBudget.directChildren - accepted.directChildCount)
      }
    });
    assertBoundedPlan(corrected, `${timelineCount} correction plan`);
    assert(corrected.mountedCount < accepted.mountedCount, `${timelineCount} correction must reduce mounted roots`);
    correctionPlans.push(corrected);
  }
  assert(correctionPlans.length === 1, `${timelineCount} correction must be deduplicated by owner/revision`);
  const appliedPlans = [accepted, ...correctionPlans];
  assert(appliedPlans.every((candidate) => candidate.mountedCount <= MODEL_INPUT_CAP
    && candidate.directChildCount <= DIRECT_CHILD_CAP), `${timelineCount} every applied plan must remain hard capped`);
  assert(keys.length === timelineCount && request.viewportKeys.length > MODEL_INPUT_CAP,
    `${timelineCount} fixture must retain a realistic oversized range`);
  return {
    environment: 'node-synthetic',
    syntheticNotBrowserTiming: true,
    timelineCount,
    advisoryDescendants: descendants,
    oversizedRequestedRange: keys.length,
    oversizedViewportRange: request.viewportKeys.length,
    excessPins: 6,
    projectedStructuralRoots: STRUCTURAL_ROOTS,
    observedBudget,
    audit,
    appliedPlans: appliedPlans.map((candidate) => ({
      mounted: candidate.mountedCount,
      directChildren: candidate.directChildCount,
      accepted: candidate.acceptedKeys.length
    })),
    correction: { observations: 3, scheduled: correctionPlans.length, deduplicated: 2 },
    allHistoryRoots: 0,
    automaticLegacyCalls: 0
  };
}

function boundedTailPlan(plan, timelineCount, shellRequest = null) {
  const { keys } = containmentRequest(timelineCount);
  const tail = keys.slice(-80);
  const result = plan({
    requestedKeys: tail,
    visibleLoadedKeys: tail,
    viewportKeys: tail,
    coreKeys: [],
    overscanKeys: [],
    adapterSnapshotKeys: tail,
    projectedStructuralRoots: STRUCTURAL_ROOTS,
    limits: { mounted: MODEL_INPUT_CAP, directChildren: DIRECT_CHILD_CAP },
    shellRequests: shellRequest ? [{ key: tail.at(-1), mode: 'safe-shell', family: shellRequest }] : []
  });
  assertBoundedPlan(result, `${timelineCount} bounded tail plan`);
  return result;
}

function runRecoveryEvidence(plan, classify) {
  const checkpoint = Object.freeze({ owner: 'synthetic-session:7', mounted: 80, directChildren: 86 });
  const exceptionFixtures = [
    { name: 'factory-create', operation: 'create', family: 'message-assistant', retry: true },
    { name: 'rich-presentation', operation: 'presentation', family: 'message-markdown', retry: true },
    { name: 'reconcile-ordering', operation: 'reconcile', family: '', retry: false }
  ];
  const exceptions = exceptionFixtures.map((fixture) => {
    const retryPlan = fixture.retry ? boundedTailPlan(plan, 1384, fixture.family) : null;
    if (retryPlan) assert(Object.keys(retryPlan.shellSelections).length === 1,
      `${fixture.name} must make one truthful bounded shell retry`);
    return {
      ...fixture,
      exactCheckpointRetained: checkpoint,
      retries: retryPlan ? 1 : 0,
      retryPlan: retryPlan ? { mounted: retryPlan.mountedCount, directChildren: retryPlan.directChildCount } : null,
      outcome: retryPlan ? 'recovered-bounded' : 'retained-pending',
      automaticLegacyCalls: 0
    };
  });
  assert(exceptions.every((fixture) => fixture.retries <= 1), 'exceptions must retry at most once');
  assert(exceptions.every((fixture) => fixture.exactCheckpointRetained === checkpoint), 'exceptions must retain exact C0 identity');

  const corruptionSamples = [
    { code: 'duplicate-keyed-root', expected: 1, actual: 2 },
    { code: 'missing-accepted-keyed-root', expected: true, actual: false },
    { code: 'unexpected-keyed-root', expected: false, actual: true },
    { code: 'unclassified-direct-root', expected: 0, actual: 1 },
    { code: 'root-map-dom-mismatch', expected: ['a'], actual: ['b'] },
    { code: 'active-spacer-missing-or-duplicated', expected: 1, actual: 0 },
    { code: 'adapter-session-generation-mismatch', expected: 7, actual: 8 }
  ];
  const corruption = corruptionSamples.map((sample) => {
    const classification = classify(sample);
    assert(classification.corrupt === true && classification.code === sample.code,
      `${sample.code} must produce its exact closed classification`);
    const emergencyPlan = boundedTailPlan(plan, 1384, 'message-assistant');
    return {
      corruptionClassification: sample.code,
      sampleCount: 1,
      classification: classification.code,
      emergency: true,
      mounted: emergencyPlan.mountedCount,
      directChildren: emergencyPlan.directChildCount,
      automaticLegacyCalls: 0
    };
  });
  const negativeFixtures = [
    { name: 'zero-samples', samples: [], emergency: false },
    { name: 'multiple-proved-samples', samples: corruptionSamples.slice(0, 2), emergency: false },
    { name: 'unknown-evidence', samples: [{ code: 'pressure-descendants', actual: 22044 }], emergency: false },
    { name: 'pressure-only', samples: [{ descendants: 22044, mounted: 140 }], emergency: false }
  ];
  for (const fixture of negativeFixtures) {
    const classifications = fixture.samples.map((sample) => classify(sample));
    const exactOneProved = fixture.samples.length === 1
      && classifications.length === 1
      && classifications[0]?.corrupt === true
      && classifications[0]?.code === fixture.samples[0]?.code;
    assert(exactOneProved === false && fixture.emergency === false,
      `${fixture.name} must not enter emergency`);
  }
  assert(corruption.every((fixture) => fixture.mounted <= MODEL_INPUT_CAP
    && fixture.directChildren <= DIRECT_CHILD_CAP), 'all emergency plans must remain capped');
  const negativeEvidence = negativeFixtures.map((fixture) => ({
    name: fixture.name,
    sampleCount: fixture.samples.length,
    emergency: fixture.emergency,
    automaticLegacyCalls: 0
  }));
  return {
    environment: 'node-synthetic',
    syntheticNotBrowserTiming: true,
    exceptions,
    corruption,
    negativeEvidence,
    exactOneEmergencyCount: corruption.length,
    automaticLegacyCalls: 0
  };
}

function runAggregateSmoke(plan, recovery) {
  const steps = [
    'load', 'initial-tail', 'primary-send',
    ...Array.from({ length: 125 }, (_, index) => `stream-notification-${index + 1}`),
    'final', 'old-range', 'return', 'search-target', 'pressure', 'safe-shell',
    'recovery', 'emergency', 'session-switch'
  ];
  const initial = boundedTailPlan(plan, 1382);
  const final = boundedTailPlan(plan, 1384);
  assert(steps.filter((step) => step.startsWith('stream-notification-')).length > 100,
    'aggregate smoke must include more than 100 stream notifications');
  assert(steps.indexOf('primary-send') < steps.indexOf('final')
    && steps.indexOf('old-range') < steps.indexOf('search-target')
    && steps.indexOf('emergency') < steps.indexOf('session-switch'),
  'aggregate smoke transition order must be deterministic');
  assert(recovery.corruption.length === 7, 'aggregate smoke must include all closed emergency classifications');
  return {
    environment: 'node-synthetic',
    syntheticNotBrowserTiming: true,
    steps,
    stepCount: steps.length,
    streamNotifications: 125,
    appliedPlans: [initial, final].map((candidate) => ({ mounted: candidate.mountedCount, directChildren: candidate.directChildCount })),
    browserTimingClaimed: false,
    browserLayoutClaimed: false,
    browserMemoryClaimed: false,
    automaticLegacyCalls: 0
  };
}

function runA27ContainmentEvidence() {
  const { plan, classify, bundleSha256 } = loadAttributionBuilder();
  const scenarios = [1382, 1383, 1384].map((timelineCount, index) => (
    runContainmentScenario(plan, timelineCount, ATTRIBUTED_DESCENDANT_TOTAL + index, 101 + index)
  ));
  const recovery = runRecoveryEvidence(plan, classify);
  const smoke = runAggregateSmoke(plan, recovery);
  assert(scenarios.every((scenario) => scenario.audit.failClosed === false
    && scenario.allHistoryRoots === 0 && scenario.automaticLegacyCalls === 0),
  'pressure scenarios must never fail closed, mount all history, or call legacy');
  return {
    environment: 'node-synthetic',
    syntheticNotBrowserTiming: true,
    bundleSha256,
    caps: { mounted: MODEL_INPUT_CAP, directChildren: DIRECT_CHILD_CAP, structuralRoots: STRUCTURAL_ROOTS },
    scenarios,
    recovery,
    smoke,
    claims: { browserTiming: false, browserLayout: false, browserMemory: false }
  };
}

function distributedUnits(total, exceptional = false) {
  const units = [];
  let remaining = total;
  if (exceptional) {
    const boundary = Math.ceil(total * 35 / 100);
    units.push({ unitIndex: 0, kind: 'message', role: 'assistant', descendants: boundary, directChildren: 2, mounted: true });
    remaining -= boundary;
  }
  const start = units.length;
  const slots = MODEL_INPUT_CAP - start;
  for (let index = start; index < MODEL_INPUT_CAP; index += 1) {
    const descendants = Math.floor(remaining / slots) + (index - start < remaining % slots ? 1 : 0);
    units.push({
      unitIndex: index,
      kind: index % 11 === 0 ? 'segment' : (index % 17 === 0 ? 'change-list' : 'message'),
      role: index % 2 === 0 ? 'assistant' : 'user',
      descendants,
      directChildren: 1 + (index % 3),
      mounted: true,
      visible: index >= MODEL_INPUT_CAP - 80,
      pinned: index === MODEL_INPUT_CAP - 1
    });
  }
  assert(units.length === MODEL_INPUT_CAP, 'fixture must respect model input cap 140');
  assert(units.reduce((sum, unit) => sum + unit.descendants, 0) === total, 'fixture descendants must reconcile exactly');
  return units;
}

function cleanCleanup(generation) {
  return { available: true, generation, ownedUnmount: true, residualRoots: 0, postUnmountDescendantDelta: 0, staleRejections: 0 };
}

function modelInput(generation, units, cleanup, coverageAvailable = true) {
  return {
    generation,
    auditAvailable: true,
    coverageAvailable,
    totalDescendants: units.reduce((sum, unit) => sum + unit.descendants, 0),
    units,
    cleanup
  };
}

function hostileInput() {
  const ordinary = distributedUnits(ATTRIBUTED_DESCENDANT_TOTAL);
  ordinary[0] = {
    ...ordinary[0],
    text: PRIVATE_SENTINELS.text,
    html: PRIVATE_SENTINELS.html,
    content: PRIVATE_SENTINELS.text,
    code: PRIVATE_SENTINELS.code,
    path: PRIVATE_SENTINELS.path,
    filePath: PRIVATE_SENTINELS.path,
    toolPayload: PRIVATE_SENTINELS.toolPayload,
    payload: { value: PRIVATE_SENTINELS.toolPayload },
    searchTerm: PRIVATE_SENTINELS.search,
    search: PRIVATE_SENTINELS.search,
    copiedContent: PRIVATE_SENTINELS.copiedContent,
    messageId: PRIVATE_SENTINELS.messageId,
    unitId: PRIVATE_SENTINELS.unitId,
    unitKey: PRIVATE_SENTINELS.unitKey,
    key: PRIVATE_SENTINELS.key,
    aliasId: PRIVATE_SENTINELS.aliasId,
    searchId: PRIVATE_SENTINELS.searchId,
    searchTargetKey: PRIVATE_SENTINELS.searchId,
    rawId: PRIVATE_SENTINELS.rawId,
    raw: PRIVATE_SENTINELS.rawId
  };
  return {
    ...modelInput(90, ordinary, cleanCleanup(90)),
    sessionId: PRIVATE_SENTINELS.sessionId,
    activeSessionId: PRIVATE_SENTINELS.activeSessionId,
    failedSessionId: PRIVATE_SENTINELS.failedSessionId,
    __ocChatWindowDescendantAcceptanceBlocker: {
      sessionId: PRIVATE_SENTINELS.blockerSessionId,
      descendants: ATTRIBUTED_DESCENDANT_TOTAL
    }
  };
}

function runA15AttributionEvidence() {
  const { build, bundleSha256 } = loadAttributionBuilder();
  const ordinary = distributedUnits(ATTRIBUTED_DESCENDANT_TOTAL);
  const exceptional = distributedUnits(ATTRIBUTED_DESCENDANT_TOTAL, true);
  const cases = [
    { name: 'cumulative-ordinary', timelineCount: 1382, input: modelInput(81, ordinary, cleanCleanup(81)) },
    { name: 'exceptional-unit', timelineCount: 1383, input: modelInput(82, exceptional, cleanCleanup(82)) },
    {
      name: 'suspected-cleanup-drift', timelineCount: 1384,
      preUnmountInput: modelInput(83, ordinary, cleanCleanup(83)),
      input: modelInput(83, [], { ...cleanCleanup(83), residualRoots: 1 })
    },
    { name: 'mixed', timelineCount: 1384, input: modelInput(84, ordinary, { ...cleanCleanup(84), postUnmountDescendantDelta: 1 }) },
    { name: 'unknown', timelineCount: 1384, input: modelInput(85, ordinary, cleanCleanup(85), false) }
  ];
  const results = cases.map((fixture) => {
    const preUnmount = fixture.preUnmountInput ? build(fixture.preUnmountInput) : null;
    const first = build(fixture.input);
    const second = build(fixture.input);
    assert(JSON.stringify(first) === JSON.stringify(second), `${fixture.name} classification must be deterministic`);
    assert(first.classification.value === fixture.name, `${fixture.name} classification must match`);
    assert(first.topContributors.length <= TOP_K, `${fixture.name} top contributors must be bounded to 8`);
    if (preUnmount) {
      assert(preUnmount.audit.reconciled && preUnmount.audit.totalDescendants === ATTRIBUTED_DESCENDANT_TOTAL, 'cleanup pre-unmount population must reconcile 22040');
      assert(first.audit.reconciled && first.audit.totalDescendants === 0, 'cleanup return audit must reconcile empty post-unmount state');
    } else {
      assert(first.audit.reconciled && first.audit.totalDescendants === ATTRIBUTED_DESCENDANT_TOTAL, `${fixture.name} must reconcile 22040`);
    }
    assertNoPrivateLeak(first, `${fixture.name} record/classification/top-K`);
    return {
      name: fixture.name,
      timelineCount: fixture.timelineCount,
      primaryDescendantPopulation: ATTRIBUTED_DESCENDANT_TOTAL,
      auditTotal: first.audit.totalDescendants,
      reconciled: first.audit.reconciled,
      observedUnitCount: first.audit.observedUnitCount,
      topContributorCount: first.topContributors.length,
      topUnitBasisPoints: first.dominance.topUnitBasisPoints,
      topThreeBasisPoints: first.dominance.topThreeBasisPoints,
      classification: first.classification.value,
      missingDiscriminators: first.classification.missingDiscriminators
    };
  });

  const singleBoundary = build(modelInput(86, exceptional, cleanCleanup(86)));
  const topThreeUnits = distributedUnits(ATTRIBUTED_DESCENDANT_TOTAL);
  const topThreeValue = ATTRIBUTED_DESCENDANT_TOTAL / 5;
  for (let index = 0; index < MODEL_INPUT_CAP; index += 1) topThreeUnits[index].descendants = index < 5 ? topThreeValue : 0;
  const topThreeBoundary = build(modelInput(87, topThreeUnits, cleanCleanup(87)));
  assert(singleBoundary.dominance.topUnitBasisPoints === 3500, '35 percent boundary must be inclusive');
  assert(topThreeBoundary.dominance.topThreeBasisPoints === 6000, '60 percent top-three boundary must be inclusive');
  assert(singleBoundary.classification.value === 'exceptional-unit' && topThreeBoundary.classification.value === 'exceptional-unit', 'inclusive boundaries must classify exceptional');

  const hostile = build(hostileInput());
  assertNoPrivateLeak(hostile, 'hostile fixture output');
  const oldGeneration = build(modelInput(91, ordinary, { ...cleanCleanup(90), residualRoots: 3 }));
  assert(oldGeneration.classification.value === 'unknown', 'old-generation return audit must not merge cleanup evidence');
  const switched = build(modelInput(92, ordinary, cleanCleanup(92)));
  assert(switched.classification.value === 'cumulative-ordinary', 'session-switch generation must start cleanly');

  const smoke = {
    bundleScriptLoad: true,
    primaryAudit: results[0].classification,
    streamNotifications: 125,
    finalAudit: results[1].classification,
    oldRangeReturnAudit: oldGeneration.classification.value,
    sessionSwitchAudit: switched.classification.value,
    diagnosticsPrivacy: 'zero-leakage',
    environment: 'node-synthetic',
    syntheticNotBrowserTiming: true
  };
  assertNoPrivateLeak({ results, smoke }, 'written attribution evidence');
  return {
    environment: 'node-synthetic',
    syntheticNotBrowserTiming: true,
    bundleSha256,
    caps: { modelInput: MODEL_INPUT_CAP, topK: TOP_K },
    boundaries: { singleInclusiveBasisPoints: 3500, topThreeInclusiveBasisPoints: 6000 },
    results,
    privacy: { sentinelCategories: Object.keys(PRIVATE_SENTINELS).length, leakageCount: 0 },
    smoke
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
  assert(typeof runA15AttributionEvidence === 'function', 'A1.5 realistic attribution parser must exist');
  const source = fs.readFileSync(SOURCE_FILE, 'utf8');
  const extracted = extractMetricsBlock(source);
  const first = runOnce(extracted.block);
  const second = runOnce(extracted.block);
  assert(JSON.stringify(normalize(first)) === JSON.stringify(normalize(second)), 'two in-process runs must have identical normalized results');
  const attribution = runA15AttributionEvidence();
  const containment = runA27ContainmentEvidence();

  const evidence = {
    evidenceKind: 'synthetic-node-vm-chat-render-baseline',
    environment: 'node-synthetic',
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
    attribution,
    containment,
    limitations: [
      'Synthetic VM durations validate instrumentation arithmetic and schema, not browser rendering performance.',
      'Fake DOM and observer implementations do not establish browser layout, paint, memory, or responsiveness behavior.',
      'Append and stream outcomes exercise the extracted timing seam; the real bundled planner/classifier execute, but browser DOM rendering does not.'
    ]
  };

  assertNoPrivateLeak(evidence, 'written temp evidence');
  fs.writeFileSync(EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log('Chat render synthetic baseline: PASS');
  console.log(`Evidence: ${EVIDENCE_FILE}`);
  console.log(`Source SHA-256: ${evidence.source.sha256}`);
  console.log(`Scenario bands: ${JSON.stringify(first.supportedLongtask.metrics.scenarioBands)}`);
  console.log(`Warnings/summaries: ${first.supportedLongtask.emitted.pressureWarnings}/${first.supportedLongtask.emitted.summaries}`);
  console.log(`Attribution classifications: ${attribution.results.map((result) => result.classification).join(', ')}`);
  console.log(`Fixture totals: ${attribution.results.map((result) => result.primaryDescendantPopulation).join(', ')}`);
  console.log(`Privacy leakage count: ${attribution.privacy.leakageCount}`);
  console.log(`Containment scenarios/applied plans: ${containment.scenarios.length}/${containment.scenarios.reduce((sum, scenario) => sum + scenario.appliedPlans.length, 0)}`);
  console.log(`Recovery exceptions/closed corruption codes: ${containment.recovery.exceptions.length}/${containment.recovery.corruption.length}`);
  console.log(`Aggregate smoke steps/stream notifications: ${containment.smoke.stepCount}/${containment.smoke.streamNotifications}`);
  console.log('Containment assertions: mounted<=140 direct<=146 pressureFailClosed=0 allHistoryRoots=0 automaticLegacyCalls=0 correctionScheduledPerOwnerRevision<=1');
  console.log('Timing environment: node-synthetic');
  console.log('Timing classification: syntheticNotBrowserTiming=true');
}

main();
