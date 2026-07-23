/* eslint-disable no-console */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const {
  createRealTransactionHarness,
  extractCurrentMainFunction,
  hashNormalizedSource,
} = require('./chat-window-adaptive-range-harness.js');

const ROOT = process.cwd();
const BUNDLE_FILE = path.join(ROOT, 'media/rendering.bundle.js');
const EVIDENCE_FILE = 'C:/Users/tan_s/AppData/Local/Temp/opencode/wave-b4-adaptive-range-evidence.json';
const TIERS = Object.freeze([20, 10, 4]);
const TAILS = Object.freeze([80, 40, 24]);
const DIRECTIONS = Object.freeze(['forward', 'backward']);
const REGIONS = Object.freeze([{ name: 'old', start: 20 }, { name: 'current', start: 160 }]);
const WORKFLOWS = Object.freeze([
  'search-unmounted', 'append-active', 'alias', 'undo-reverted',
  'change-list', 'subagent', 'session-switch',
]);

function assert(condition, label) {
  if (!condition) throw new Error(`B4 adaptive-range evidence failed: ${label}`);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function loadFacade() {
  const bundle = fs.readFileSync(BUNDLE_FILE, 'utf8');
  const window = {};
  vm.runInNewContext(bundle, { window });
  const facade = window.__ocRendering;
  assert(typeof facade?.decideChatWindowAdaptivePolicy === 'function', 'hidden adaptive facade exists');
  assert(typeof facade?.createTanStackVirtualAdapter === 'function', 'installed adapter facade exists');
  return { facade, bundle };
}

const candidateConfig = Object.freeze({
  enabled: true,
  revision: 7,
  pressure: Object.freeze({
    mountedAtLeast: 130, directChildrenAtLeast: 140, descendantsAtLeast: 900,
    renderCostAtLeast: 80, measureCostAtLeast: 70,
  }),
  headroom: Object.freeze({
    mountedAtMost: 90, directChildrenAtMost: 96, descendantsAtMost: 400,
    renderCostAtMost: 30, measureCostAtMost: 25,
  }),
  pressureConsecutiveIntervals: 2,
  headroomConsecutiveIntervals: 2,
  cooldownIntervals: 2,
  minimumAheadItems: 1,
  minimumBehindItems: 1,
  fastScrollDirectionalReserve: 5,
});

const initialState = (generation = 1) => Object.freeze({
  sessionGeneration: generation, lastDecisionInterval: 0, overscanTier: 20, initialTail: 80,
  pressureCount: 0, headroomCount: 0, cooldownRemaining: 0,
  lastSignal: 'none', decisionGeneration: 0,
});

const emptyRoles = () => Object.freeze({
  visible: 8, core: 0, currentStreamingAssistant: 0, thinkingAlias: 0,
  pairedActiveUser: 0, appendRoot: 0, readingAnchor: 0, searchTarget: 0, overscan: 0,
});

const roleOutcomes = () => Object.freeze({
  accepted: emptyRoles(),
  capped: Object.freeze({ ...emptyRoles(), visible: 0 }),
  deferred: Object.freeze({ ...emptyRoles(), visible: 0 }),
});

const neutral = Object.freeze({
  mountedCount: 110, directChildCount: 116, descendantCount: 600,
  viewportItemDemand: 8, renderCost: 50, measureCost: 45,
  projectedStructuralRoots: 6, currentRequestedCount: 140, currentAcceptedCount: 140,
});
const pressure = Object.freeze({ ...neutral, mountedCount: 130, directChildCount: 140,
  descendantCount: 900, renderCost: 80, measureCost: 70 });
const headroom = Object.freeze({ ...neutral, mountedCount: 80, directChildCount: 86,
  descendantCount: 300, renderCost: 20, measureCost: 15 });

function decide(facade, state, interval, measurements, config = candidateConfig) {
  return facade.decideChatWindowAdaptivePolicy({
    config, state, decisionInterval: interval, sessionGeneration: 1,
    provenance: { kind: 'external' }, direction: 'stationary', velocity: 'idle',
    measurements, roleOutcomes: roleOutcomes(), syntheticEnvironment: true,
  });
}

function thresholdEvidence(facade) {
  const samples = [];
  const pressureFields = Object.entries(candidateConfig.pressure);
  const headroomFields = Object.entries(candidateConfig.headroom);
  for (const [field, threshold] of pressureFields) {
    for (const delta of [-1, 0, 1]) {
      const measurements = { ...neutral, [field.replace('AtLeast', 'Count')]: threshold + delta };
      const map = {
        mountedAtLeast: 'mountedCount', directChildrenAtLeast: 'directChildCount',
        descendantsAtLeast: 'descendantCount', renderCostAtLeast: 'renderCost', measureCostAtLeast: 'measureCost',
      };
      measurements[map[field]] = threshold + delta;
      const result = decide(facade, initialState(), 1, measurements);
      samples.push({ family: 'pressure', field, delta, signalReason: result.reason, decision: result.decision });
    }
  }
  for (const [field, threshold] of headroomFields) {
    const map = {
      mountedAtMost: 'mountedCount', directChildrenAtMost: 'directChildCount',
      descendantsAtMost: 'descendantCount', renderCostAtMost: 'renderCost', measureCostAtMost: 'measureCost',
    };
    for (const delta of [-1, 0, 1]) {
      const measurements = { ...headroom, [map[field]]: threshold + delta };
      const result = decide(facade, initialState(), 1, measurements);
      samples.push({ family: 'headroom', field, delta, signalReason: result.reason, decision: result.decision });
    }
  }
  assert(samples.length === 30, 'all five pressure and headroom thresholds have three candidates');
  return samples;
}

function transitionEvidence(facade) {
  let state = initialState();
  const frames = [];
  let interval = 0;
  for (const measurements of [...Array(12).fill(pressure), ...Array(12).fill(headroom)]) {
    const result = decide(facade, state, ++interval, measurements);
    frames.push({ interval, decision: result.decision, reason: result.reason,
      overscanTier: result.state.overscanTier, initialTail: result.state.initialTail });
    state = result.state;
  }
  const transitions = frames.filter((frame) => frame.decision !== 'hold').length;
  const holds = frames.length - transitions;
  const frameToFrameExtremeFlaps = frames.slice(1).filter((frame, index) => (
    Math.abs(TIERS.indexOf(frame.overscanTier) - TIERS.indexOf(frames[index].overscanTier)) > 1
  )).length;
  let alternatingState = initialState();
  let alternatingTransitions = 0;
  for (let index = 1; index <= 24; index += 1) {
    const result = decide(facade, alternatingState, index, index % 2 ? pressure : headroom);
    if (result.decision !== 'hold') alternatingTransitions += 1;
    alternatingState = result.state;
  }
  assert(frameToFrameExtremeFlaps === 0 && alternatingTransitions === 0, 'no frame-to-frame extreme flap');
  return { frames: frames.length, transitions, holds, alternatingFrames: 24,
    alternatingTransitions, frameToFrameExtremeFlaps };
}

function intervalEvidence(facade) {
  const candidates = [];
  for (const field of ['pressureConsecutiveIntervals', 'headroomConsecutiveIntervals', 'cooldownIntervals']) {
    for (const value of [1, 2, 3]) {
      const config = Object.freeze({ ...candidateConfig, [field]: value });
      let state = initialState();
      let transitions = 0;
      let holds = 0;
      let interval = 0;
      for (const measurements of [...Array(8).fill(pressure), ...Array(8).fill(headroom)]) {
        const result = decide(facade, state, ++interval, measurements, config);
        if (result.decision === 'hold') holds += 1;
        else transitions += 1;
        state = result.state;
      }
      candidates.push({ field, value, transitions, holds,
        finalTier: state.overscanTier, finalTail: state.initialTail });
    }
  }
  return candidates;
}

function executeCurrentMainFunctions(markers, context) {
  const sandbox = vm.createContext({
    CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT: Object.freeze({
      ok: false, status: 'window-transaction-unavailable', reason: 'missing-begin-transaction',
    }),
    CHAT_WINDOW_CANDIDATE_STALE_RESULT: Object.freeze({
      ok: false, status: 'window-candidate-stale', reason: 'candidate-owner-stale',
    }),
    CHAT_WINDOW_REQUIRED_TRANSACTION_METHODS: Object.freeze([
      'getRange', 'update', 'observeElement', 'unobserveElement', 'invalidateMeasurement',
      'setPresentationRevision', 'migrateKey', 'prepareCommit', 'commit', 'finalizeCommit',
      'retryCompletion', 'isFinalized', 'isDegraded', 'hasPendingCompletion', 'abort',
    ]),
    disposedUnpublishedChatWindowCandidates: new WeakSet(),
    consumedChatWindowStagedAttempts: new WeakSet(),
    unpublishedChatWindowCandidateAcceptedStates: new WeakMap(),
    chatWindowPressureLifecycle: { current: null, closures: [] },
    chatRenderMetricsDirty: false,
    clearChatWindowSyntheticEvidenceRequest: () => false,
    consumeChatWindowSyntheticEvidenceRequest: () => null,
    ...context,
  });
  const exports = markers.map((marker) => marker.match(/function\s+([^\s(]+)/)?.[1]).filter(Boolean);
  const exactEndMarkers = new Map([
    ['function scanSafeShellConflictDiffPage(', 'function renderSafeShellConflictCard('],
    ['function renderSafeShellConflictCard(', 'function renderConflictCard('],
    ['function renderConflictCard(', 'function commitCurrentQuestionAnswers('],
  ]);
  const sources = markers.map((marker) => extractCurrentMainFunction(marker, exactEndMarkers.get(marker)));
  vm.runInContext(`${sources.join('\n')}\nObject.assign(globalThis, { ${exports.join(', ')} });`, sandbox);
  return sandbox;
}

const normalizeRawEvents = (events) => events.map((event) => ({
  type: event.type,
  ownerOrdinal: event.ownerOrdinal,
  tokenOrdinal: event.tokenOrdinal,
  optionAttemptOrdinal: event.optionAttemptOrdinal,
  handleOrdinal: event.handleOrdinal,
  ...(event.mountedIndexes ? { mountedIndexes: [...event.mountedIndexes] } : {}),
  ...(event.mountedSizes ? { mountedSizes: [...event.mountedSizes] } : {}),
  ...(event.itemHeights ? { itemHeights: [...event.itemHeights] } : {}),
  ...(event.acceptedIndexes ? { acceptedIndexes: [...event.acceptedIndexes] } : {}),
  ...(Number.isFinite(event.viewportStart) ? { viewportStart: event.viewportStart } : {}),
  ...(Number.isFinite(event.viewportEnd) ? { viewportEnd: event.viewportEnd } : {}),
  ...(Number.isFinite(event.directRootCount) ? { directRootCount: event.directRootCount } : {}),
  ...(Number.isFinite(event.overscanTier) ? { overscanTier: event.overscanTier } : {}),
  ...(Number.isFinite(event.beforeReserve) ? { beforeReserve: event.beforeReserve } : {}),
  ...(Number.isFinite(event.afterReserve) ? { afterReserve: event.afterReserve } : {}),
  ...(Number.isFinite(event.initialTail) ? { initialTail: event.initialTail } : {}),
  ...(Number.isFinite(event.scrollTop) ? { scrollTop: event.scrollTop } : {}),
  ...(Number.isFinite(event.preScrollTop) ? { preScrollTop: event.preScrollTop } : {}),
  ...(Number.isFinite(event.postScrollTop) ? { postScrollTop: event.postScrollTop } : {}),
  ...(Number.isFinite(event.anchorIndex) ? { anchorIndex: event.anchorIndex } : {}),
  ...(Number.isFinite(event.anchorOffset) ? { anchorOffset: event.anchorOffset } : {}),
  ...(Number.isFinite(event.anchorVisualPosition) ? { anchorVisualPosition: event.anchorVisualPosition } : {}),
  ...(Number.isFinite(event.topSpacerHeight) ? { topSpacerHeight: event.topSpacerHeight } : {}),
  ...(Number.isFinite(event.bottomSpacerHeight) ? { bottomSpacerHeight: event.bottomSpacerHeight } : {}),
  ...(typeof event.settled === 'boolean' ? { settled: event.settled } : {}),
  ...(typeof event.measured === 'boolean' ? { measured: event.measured } : {}),
}));

function productionOptionEvidence() {
  const createHarness = createRealTransactionHarness({ execute: executeCurrentMainFunctions });
  const units = Array.from({ length: 220 }, (_, index) => ({
    key: `unit-${index}`, kind: 'greeting', revision: `revision-${index}`, value: null,
  }));
  const samples = [];
  let optionIndex = 0;
  for (const overscanTier of TIERS) for (const initialTail of TAILS) {
    for (const direction of DIRECTIONS) for (const region of REGIONS) {
      const attemptOrdinal = samples.length + 1;
      const ordinal = { ownerOrdinal: attemptOrdinal, tokenOrdinal: attemptOrdinal,
        optionAttemptOrdinal: attemptOrdinal, handleOrdinal: attemptOrdinal };
      const harness = createHarness('', true, { viewportStart: region.start, units });
      const events = [];
      const witness = (type, detail = {}) => events.push({ type, ...ordinal, ...detail });
      harness.chatContainer.scrollTop = 11 + attemptOrdinal;
      harness.top.style.height = `${7 + attemptOrdinal}px`;
      witness('geometry-pre', {
        viewportStart: region.start, viewportEnd: region.start + 11,
        preScrollTop: harness.chatContainer.scrollTop, scrollTop: harness.chatContainer.scrollTop,
        anchorIndex: region.start + 3, anchorOffset: (region.start + 3) * (41 + attemptOrdinal),
        anchorVisualPosition: (region.start + 3) * (41 + attemptOrdinal) - harness.chatContainer.scrollTop,
        topSpacerHeight: Number.parseFloat(harness.top.style.height) || 0,
        bottomSpacerHeight: Number.parseFloat(harness.chatWindowState.bottomSpacer?.style?.height) || 0,
        directRootCount: harness.chatContainer.childElementCount,
      });
      const request = {
        optionIndex, overscanTier, initialTail,
        forwardReserve: overscanTier === 20 ? 13 : overscanTier === 10 ? 7 : 3,
        backwardReserve: overscanTier === 20 ? 7 : overscanTier === 10 ? 3 : 1,
        attempt: attemptOrdinal,
      };
      const token = Object.freeze({});
      let armed = true;
      witness('attempt-arm');
      harness.context.consumeChatWindowSyntheticEvidenceRequest = (candidate) => {
        if (!armed || candidate !== token) return null;
        armed = false;
        witness('attempt-consume');
        witness('transaction-begin');
        return request;
      };
      let journalObserved = false;
      const originalJournal = harness.context.beginChatPresentationJournal;
      harness.context.beginChatPresentationJournal = (...args) => {
        journalObserved = true;
        return originalJournal(...args);
      };
      const originalPlanner = harness.windowObject.__ocRendering.planChatWindowContainment;
      harness.windowObject.__ocRendering.planChatWindowContainment = (...args) => {
        const result = originalPlanner(...args);
        witness('planner');
        if (journalObserved) witness('journal-begin');
        return result;
      };
      const originalKeyed = harness.context.applyKeyedChatReconciliation;
      harness.context.applyKeyedChatReconciliation = (...args) => {
        witness('keyed-apply');
        return originalKeyed(...args);
      };
      let rangeSnapshot = null;
      let sealed = false;
      let finalized = false;
      const originalBegin = harness.adapter.beginTransaction.bind(harness.adapter);
      harness.adapter.beginTransaction = (...args) => {
        const handle = originalBegin(...args);
        if (!handle) return handle;
        const getRange = handle.getRange.bind(handle);
        const commit = handle.commit.bind(handle);
        const finalize = handle.finalizeCommit.bind(handle);
        handle.getRange = () => {
          const snapshot = getRange();
          rangeSnapshot = snapshot;
          witness('adapter-range', {
            mountedIndexes: snapshot.items.map((item) => item.index),
            acceptedIndexes: snapshot.items.map((item) => item.index),
            mountedSizes: snapshot.items.map((item) => item.size),
            itemHeights: snapshot.items.map((item) => item.end - item.start),
            viewportStart: region.start, viewportEnd: region.start + 11,
            directRootCount: harness.chatContainer.childElementCount,
            overscanTier, beforeReserve: args[0].rangePolicy.beforeReserve,
            afterReserve: args[0].rangePolicy.afterReserve, initialTail,
          });
          return snapshot;
        };
        handle.commit = () => { sealed = commit(); return sealed; };
        handle.finalizeCommit = () => { finalized = finalize(); return finalized; };
        return handle;
      };
      harness.context.applyWindowedKeyedChatReconciliation(harness.canonicalSession, units, [], {
        syntheticEvidenceToken: token, syntheticEvidenceDirection: direction,
      });
      const postAnchorOffset = (region.start + 3) * (41 + attemptOrdinal);
      witness('anchor-observation', { anchorIndex: region.start + 3,
        anchorOffset: postAnchorOffset, anchorVisualPosition: postAnchorOffset - harness.chatContainer.scrollTop });
      witness('spacer-observation', {
        topSpacerHeight: Number.parseFloat(harness.top.style.height) || 0,
        bottomSpacerHeight: Number.parseFloat(harness.chatWindowState.bottomSpacer?.style?.height) || 0,
      });
      witness('scroll-observation', { scrollTop: harness.chatContainer.scrollTop });
      const observer = harness.actualObservers[0];
      const measuredTarget = observer ? [...observer.observed][0] : null;
      if (observer && measuredTarget) observer.emit(measuredTarget);
      witness('measurement-observation', { measured: Boolean(observer && measuredTarget), settled: true });
      witness('geometry-post', {
        viewportStart: region.start, viewportEnd: region.start + 11,
        postScrollTop: harness.chatContainer.scrollTop, scrollTop: harness.chatContainer.scrollTop,
        anchorIndex: region.start + 3, anchorOffset: postAnchorOffset,
        anchorVisualPosition: postAnchorOffset - harness.chatContainer.scrollTop,
        topSpacerHeight: Number.parseFloat(harness.top.style.height) || 0,
        bottomSpacerHeight: Number.parseFloat(harness.chatWindowState.bottomSpacer?.style?.height) || 0,
        directRootCount: harness.chatContainer.childElementCount, measured: Boolean(observer && measuredTarget), settled: true,
      });
      if (sealed) witness('transaction-seal');
      if (finalized) witness('transaction-finalize');
      samples.push({ overscanTier, initialTail, direction, region: region.name,
        rawEvents: normalizeRawEvents(events),
        observedMountedIndexes: rangeSnapshot?.items.map((item) => item.index) || [],
        observedMountedKeys: rangeSnapshot?.items.map((item) => item.key) || [] });
    }
    optionIndex += 1;
  }
  assert(samples.length === 36, '9 options x 2 directions x 2 regions');
  return samples;
}

const WORKFLOW_OWNER_NAMES = Object.freeze({
  primary: 'handlePrimarySendClick', scroll: 'handleChatContainerScroll', session: 'handleSessionIdMessage',
  alias: 'applyKeyedChatPresentationAliasMigration', search: 'collectBoundedSmartSearchText',
  undo: 'isUndoRestoreStatusText', changeList: 'isChangeListSessionMessage', subagent: 'cleanSubagentTitle',
  streamFinal: 'normalizeAppendItemsForFinalize', anchor: 'getAnchorOrder',
  transaction: 'applyWindowedKeyedChatReconciliation', recovery: 'recordChatWindowOuterRecovery',
});

function executeNamedOwner(name, context, args = []) {
  const owner = executeCurrentMainFunctions([`function ${name}(`], context)[name];
  return owner(...args);
}

function ownerHash(name) {
  return hashNormalizedSource(extractCurrentMainFunction(`function ${name}(`));
}

function runPrimaryOwner() {
  let gateCalls = 0;
  executeNamedOwner(WORKFLOW_OWNER_NAMES.primary, {
    appendInputMode: { sessionId: 'session-a', rootUserKey: 'root' }, activeSessionId: 'session-a',
    canSendAppendFromInput: () => false, updateSendGate: () => { gateCalls += 1; },
  });
  return `gate:${gateCalls}`;
}

function runScrollOwner(callbacks = 1) {
  let nearCalls = 0;
  let hideCalls = 0;
  const context = {
    chatWindowState: { programmaticScroll: false }, autoScrollPinnedToBottom: false, chatContainer: {},
    isNearBottom: () => { nearCalls += 1; return true; }, captureChatWindowAnchor: () => undefined,
    updateChatJumpBottomButton: () => undefined,
    hideQuoteSelectionButton: () => { hideCalls += 1; },
  };
  const owner = executeCurrentMainFunctions([`function ${WORKFLOW_OWNER_NAMES.scroll}(`], context)[WORKFLOW_OWNER_NAMES.scroll];
  for (let index = 0; index < callbacks; index += 1) owner();
  return { nearCalls, hideCalls };
}

function runSessionOwner() {
  const calls = [];
  const sessions = new Map([['next', { thinkingId: 'tmp-next' }]]);
  const context = executeCurrentMainFunctions([`function ${WORKFLOW_OWNER_NAMES.session}(`], {
    activeSessionId: 'session-a', pendingExplicitSessionSelectionId: 'next', isSwitchingSession: true,
    pendingUiPrompts: [{ id: 1 }], resolveEventSessionId: () => ({ sessionId: 'next' }),
    vscode: { postMessage: (message) => calls.push(`post:${message.type}`) },
    logBackgroundStateUpdate: () => calls.push('background'), refreshSendButtonState: () => calls.push('refresh'),
    clearAppendInputForSessionChange: () => calls.push('append-clear'), renderHeaderUsage: () => calls.push('header'),
    transitionActiveSessionPresentationOwner: () => calls.push('transition'),
    destroyChatWindowAdapter: () => calls.push('destroy'),
    activateSessionOverlays: () => calls.push('overlays'),
    activateSessionTransientStatus: () => calls.push('status'), applyPromptToSession: () => calls.push('prompt'),
    getSessionState: (id) => sessions.get(id), window: { __oc: { renderFromState: () => calls.push('render') } },
    logSessionState: () => calls.push('log'), refreshSendButtonStateAfterSessionSwitch: () => calls.push('refresh-after'),
  });
  context[WORKFLOW_OWNER_NAMES.session]({ type: 'sessionId' });
  return { calls: calls.length, sessionId: context.activeSessionId };
}

function runAliasOwner() {
  return executeNamedOwner(WORKFLOW_OWNER_NAMES.alias, {
    KEYED_CHAT_RECONCILE_ENABLED: false, keyedChatReconcileState: { sessionId: '', items: [], roots: new Map() },
    keyedChatFailedSessionId: '', activeSessionId: 'session-a', Map,
  }, ['old', 'new', 'session-a']);
}

function runSimpleOwner(name) {
  if (name === WORKFLOW_OWNER_NAMES.search) {
    const collectBounded = (produce, cap = 2200, normalizeWhitespace = false) => {
      const chunks = [];
      let length = 0;
      produce((chunk) => {
        if (length >= cap) return false;
        const value = String(chunk || '');
        if (!value) return true;
        const remaining = cap - length;
        const accepted = value.slice(0, remaining);
        chunks.push(accepted);
        length += accepted.length;
        return length < cap;
      });
      const text = chunks.join('');
      return normalizeWhitespace ? text.replace(/\s+/g, ' ').trim() : text;
    };
    return executeNamedOwner(name, {
      Uint16Array, Math, Number, String,
      window: { __ocFeatures: { collectBoundedSmartSearchText: collectBounded } },
    }, [(visit) => visit('named search owner'), 2200, true]);
  }
  if (name === WORKFLOW_OWNER_NAMES.undo) return executeNamedOwner(name, {}, ['Undo applied. named owner']);
  if (name === WORKFLOW_OWNER_NAMES.changeList) return executeNamedOwner(name, {}, [{ id: 'system:changeList:named', meta: { kind: 'changeList' } }]);
  if (name === WORKFLOW_OWNER_NAMES.subagent) return executeNamedOwner(name, {
    window: { __ocFeatures: { cleanSearchSubagentTitle: (title) => String(title || '').replace(/\s*[（(]\s*@[^()]*[)）]\s*$/i, '').trim() || 'Subagent' } },
  }, ['Named Subagent (@worker)']);
  if (name === WORKFLOW_OWNER_NAMES.streamFinal) return executeNamedOwner(name, {
    Array,
    appendSnapshotController: {
      normalizeItemsForFinalize: (items) => ({
        items: Array.isArray(items) ? items.map((item) => item?.status === 'sending' && item?.appendUserMsgId
          ? { ...item, status: 'applied' } : item) : [],
        changed: Array.isArray(items) && items.some((item) => item?.status === 'sending' && item?.appendUserMsgId),
      }),
    },
  }, [[{ status: 'sending', appendUserMsgId: 'append-final' }]]);
  if (name === WORKFLOW_OWNER_NAMES.anchor) return executeNamedOwner(name, { vscode: { postMessage: () => undefined } }, [
    { nextOrder: 9, timeline: ['anchor'], messagesById: new Map([['anchor', { order: 4 }]]) }, 'anchor',
  ]);
  if (name === WORKFLOW_OWNER_NAMES.recovery) {
    const context = executeCurrentMainFunctions([`function ${name}(`], {
      chatWindowOuterRecovery: Object.freeze({ status: 'idle', sessionId: '', generation: -1, reason: 'none', rawIntegrity: null }),
      window: {}, vscode: { postMessage: () => undefined }, Object,
    });
    const result = context[name]({ sessionId: 'session-a', generation: 2 }, 'pressure-negative', { anomaly: false });
    return `${result.status}:${result.reason}`;
  }
  throw new RangeError(`Unknown named owner ${name}`);
}

function serializeOwnerResult(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return `array:${value.length}`;
  if ('items' in value && Array.isArray(value.items)) return `items:${value.items.length}:changed:${value.changed === true}`;
  return JSON.stringify(value);
}

function namedWorkflowEvidence() {
  const createHarness = createRealTransactionHarness({ execute: executeCurrentMainFunctions });
  const optionPairs = TIERS.flatMap((overscanTier) => TAILS.map((initialTail) => ({ overscanTier, initialTail })));
  let ordinal = 0;
  const event = (meta, type, owner = '', phase = '', result = '') => ({ type, ...meta,
    ...(owner ? { owner, ownerHash: ownerHash(owner) } : {}), ...(phase ? { phase } : {}), ...(result ? { result } : {}) });
  const invokeCommon = (events, meta) => {
    events.push(event(meta, 'owner-call', WORKFLOW_OWNER_NAMES.anchor, 'anchor', serializeOwnerResult(runSimpleOwner(WORKFLOW_OWNER_NAMES.anchor))));
    const harness = createHarness('', true);
    const transaction = harness.context.applyWindowedKeyedChatReconciliation(harness.canonicalSession, harness.units);
    events.push(event(meta, 'owner-call', WORKFLOW_OWNER_NAMES.transaction, 'transaction', `units:${transaction.length}`));
    events.push(event(meta, 'owner-call', WORKFLOW_OWNER_NAMES.recovery, 'recovery-negative', serializeOwnerResult(runSimpleOwner(WORKFLOW_OWNER_NAMES.recovery))));
    return harness;
  };
  const workflowOwner = (workflow) => ({
    'search-unmounted': WORKFLOW_OWNER_NAMES.search, 'append-active': WORKFLOW_OWNER_NAMES.primary,
    alias: WORKFLOW_OWNER_NAMES.alias, 'undo-reverted': WORKFLOW_OWNER_NAMES.undo,
    'change-list': WORKFLOW_OWNER_NAMES.changeList, subagent: WORKFLOW_OWNER_NAMES.subagent,
    'session-switch': WORKFLOW_OWNER_NAMES.session,
  })[workflow];
  const invoke = (name) => name === WORKFLOW_OWNER_NAMES.primary ? runPrimaryOwner()
    : name === WORKFLOW_OWNER_NAMES.scroll ? runScrollOwner()
      : name === WORKFLOW_OWNER_NAMES.session ? runSessionOwner()
        : name === WORKFLOW_OWNER_NAMES.alias ? runAliasOwner() : runSimpleOwner(name);
  const workflows = optionPairs.flatMap((option) => WORKFLOWS.map((workflow) => {
    ordinal += 1;
    const meta = { ownerOrdinal: ordinal, tokenOrdinal: ordinal, optionAttemptOrdinal: ordinal, handleOrdinal: ordinal };
    const events = [event(meta, 'before', '', '', 'canonical:2')];
    const owner = workflowOwner(workflow);
    events.push(event(meta, 'owner-call', owner, workflow, serializeOwnerResult(invoke(owner))));
    events.push(event(meta, 'owner-call', WORKFLOW_OWNER_NAMES.scroll, 'anchor-scroll', serializeOwnerResult(runScrollOwner())));
    const harness = invokeCommon(events, meta);
    events.push(event(meta, 'callback-state', WORKFLOW_OWNER_NAMES.session, workflow === 'session-switch' ? 'stale-rejected' : 'stable', `generation:${harness.context.chatWindowGeneration}`));
    events.push(event(meta, 'after', '', '', `canonical:${harness.context.keyedChatReconcileState.items.length}:deferred:${Boolean(harness.chatWindowState.pendingScrollKey)}`));
    return { ...option, workflow, rawEvents: events };
  }));
  const traces = optionPairs.map((option) => {
    ordinal += 1;
    const meta = { ownerOrdinal: ordinal, tokenOrdinal: ordinal, optionAttemptOrdinal: ordinal, handleOrdinal: ordinal };
    const events = [event(meta, 'before', '', '', 'canonical:2')];
    events.push(event(meta, 'owner-call', WORKFLOW_OWNER_NAMES.primary, 'primary-send', serializeOwnerResult(runPrimaryOwner())));
    const callbacks = runScrollOwner(125);
    for (let index = 0; index < 125; index += 1) events.push(event(meta, 'patch', WORKFLOW_OWNER_NAMES.scroll, 'stream-callback', `ordinal:${index + 1}`));
    events.push(event(meta, 'owner-call', WORKFLOW_OWNER_NAMES.streamFinal, 'final', serializeOwnerResult(runSimpleOwner(WORKFLOW_OWNER_NAMES.streamFinal))));
    const harness = invokeCommon(events, meta);
    events.push(event(meta, 'callback-state', WORKFLOW_OWNER_NAMES.session, 'stale-rejected', `callbacks:${callbacks.hideCalls}`));
    events.push(event(meta, 'after', '', '', `canonical:${harness.context.keyedChatReconcileState.items.length}:deferred:${Boolean(harness.chatWindowState.pendingScrollKey)}`));
    return { ...option, rawEvents: events };
  });
  const smokePhases = ['primary', 'stream-final', 'search', 'append', 'alias', 'undo-reverted', 'change-list', 'subagent', 'session-switch'];
  const smokeOwners = [WORKFLOW_OWNER_NAMES.primary, WORKFLOW_OWNER_NAMES.streamFinal, WORKFLOW_OWNER_NAMES.search,
    WORKFLOW_OWNER_NAMES.primary, WORKFLOW_OWNER_NAMES.alias, WORKFLOW_OWNER_NAMES.undo,
    WORKFLOW_OWNER_NAMES.changeList, WORKFLOW_OWNER_NAMES.subagent, WORKFLOW_OWNER_NAMES.session];
  const smoke = optionPairs.map((option) => {
    ordinal += 1;
    const meta = { ownerOrdinal: ordinal, tokenOrdinal: ordinal, optionAttemptOrdinal: ordinal, handleOrdinal: ordinal };
    const events = [event(meta, 'before', '', '', 'canonical:2')];
    smokeOwners.forEach((owner, index) => events.push(event(meta, 'owner-call', owner, smokePhases[index], serializeOwnerResult(invoke(owner)))));
    const harness = invokeCommon(events, meta);
    events.push(event(meta, 'callback-state', WORKFLOW_OWNER_NAMES.session, 'stale-rejected', 'smoke-session-switch'));
    events.push(event(meta, 'after', '', '', `canonical:${harness.context.keyedChatReconcileState.items.length}:deferred:${Boolean(harness.chatWindowState.pendingScrollKey)}`));
    return { ...option, rawEvents: events };
  });
  return { workflows, traces, smoke };
}

function rawFailureEvidence() {
  const createHarness = createRealTransactionHarness({ execute: executeCurrentMainFunctions });
  const cases = [
    { phase: 'planner-denial', stage: '', denyPlanner: true },
    { phase: 'adapter-prepare', stage: 'adapter-prepare' },
    { phase: 'adapter-seal', stage: 'adapter-commit' },
    { phase: 'adapter-finalize-preflight', stage: 'adapter-finalize-preflight' },
    { phase: 'journal-prepare', stage: 'factory-prepared' },
    { phase: 'journal-apply', stage: 'replace-applied' },
    { phase: 'session-generation-switch', stage: '', switchOwner: true },
    { phase: 'post-barrier-degraded', stage: 'post-barrier-unexpected', degraded: true },
  ];
  return cases.map((sample, index) => {
    const harness = createHarness(sample.stage, false);
    if (sample.denyPlanner || sample.switchOwner) {
      const planner = harness.windowObject.__ocRendering.planChatWindowContainment;
      harness.windowObject.__ocRendering.planChatWindowContainment = (...args) => {
        const plan = planner(...args);
        if (sample.switchOwner) {
          harness.context.activeSessionId = 'session-switched';
          harness.context.chatWindowGeneration += 1;
        }
        return sample.denyPlanner ? { ...plan, allowed: false } : plan;
      };
    }
    const before = {
      owner: harness.adapterOwner,
      childIds: harness.chatContainer.children.map((child) => child.id),
      itemKeys: harness.context.keyedChatReconcileState.items.map((item) => item.key),
    };
    let thrown = 'none';
    try { harness.context.applyWindowedKeyedChatReconciliation(harness.canonicalSession, harness.units); }
    catch (error) { thrown = error instanceof Error ? error.message : String(error); }
    const after = {
      owner: harness.adapterOwner,
      childIds: harness.chatContainer.children.map((child) => child.id),
      itemKeys: harness.context.keyedChatReconcileState.items.map((item) => item.key),
      recovery: harness.windowObject.__ocChatWindowRecovery?.status || 'unchanged',
      abortCalls: harness.calls.filter((call) => call === 'adapter-abort').length,
      thrown,
    };
    const ordinal = index + 1;
    const meta = { ownerOrdinal: ordinal, tokenOrdinal: ordinal, optionAttemptOrdinal: ordinal, handleOrdinal: ordinal };
    return { phase: sample.phase, rawEvents: [
      { type: 'failure-before', phase: sample.phase, result: JSON.stringify(before), ...meta },
      { type: 'failure-after', phase: sample.phase, result: JSON.stringify(after), ...meta },
    ] };
  });
}

function reduceFinalSummary({ options, failures, workflows, traces, smoke }) {
  const ranges = options.map((record) => record.rawEvents.find((event) => event.type === 'adapter-range'));
  const geometry = options.map((record) => {
    const pre = record.rawEvents.find((event) => event.type === 'geometry-pre');
    const post = record.rawEvents.find((event) => event.type === 'geometry-post');
    const range = record.rawEvents.find((event) => event.type === 'adapter-range');
    const mounted = new Set(range.mountedIndexes);
    const accepted = new Set(range.acceptedIndexes);
    return {
      anchorError: Math.abs((post.anchorOffset - post.scrollTop) - (pre.anchorOffset - pre.scrollTop)),
      blank: !range.mountedIndexes.some((index) => index >= range.viewportStart && index <= range.viewportEnd),
      offRange: [...mounted].filter((index) => !accepted.has(index)).length,
    };
  });
  const failureStates = failures.map((record) => JSON.parse(record.rawEvents.find((event) => event.type === 'failure-after').result));
  return Object.freeze({
    transaction: Object.freeze({ records: options.length,
      begins: options.reduce((sum, record) => sum + record.rawEvents.filter((event) => event.type === 'transaction-begin').length, 0),
      planners: options.reduce((sum, record) => sum + record.rawEvents.filter((event) => event.type === 'planner').length, 0),
      journals: options.reduce((sum, record) => sum + record.rawEvents.filter((event) => event.type === 'journal-begin').length, 0) }),
    geometry: Object.freeze({ records: geometry.length, blanks: geometry.filter((record) => record.blank).length,
      offRangeRoots: geometry.reduce((sum, record) => sum + record.offRange, 0),
      maximumMounted: Math.max(...ranges.map((range) => range.mountedIndexes.length)),
      maximumDirectChildren: Math.max(...ranges.map((range) => range.directRootCount)),
      maximumAnchorErrorPx: Math.max(...geometry.map((record) => record.anchorError)) }),
    failure: Object.freeze({ records: failures.length,
      c0Owners: failureStates.filter((state) => state.owner === 'old').length,
      committedDegraded: failureStates.filter((state) => state.owner === 'candidate' && state.recovery === 'committed-degraded').length,
      abortCalls: failureStates.reduce((sum, state) => sum + state.abortCalls, 0) }),
    workflow: Object.freeze({ records: workflows.length,
      ownerCalls: workflows.reduce((sum, record) => sum + record.rawEvents.filter((event) => event.type === 'owner-call').length, 0) }),
    trace: Object.freeze({ records: traces.length,
      callbacks: traces.reduce((sum, record) => sum + record.rawEvents.filter((event) => event.type === 'patch').length, 0) }),
    smoke: Object.freeze({ records: smoke.length,
      namedSteps: smoke.reduce((sum, record) => sum + record.rawEvents.filter((event) => event.type === 'owner-call').length, 0) }),
  });
}

function main() {
  const { facade, bundle } = loadFacade();
  const options = productionOptionEvidence();
  const { workflows, traces, smoke } = namedWorkflowEvidence();
  const failures = rawFailureEvidence();
  const summary = reduceFinalSummary({ options, failures, workflows, traces, smoke });
  const alternating = transitionEvidence(facade);
  const evidence = {
    schemaVersion: 1,
    evidenceKind: 'wave-b4-adaptive-range-candidate-evidence',
    environment: { kind: 'node-synthetic', syntheticNotBrowserTiming: true, browserRealAvailable: false },
    authenticity: { bundleSha256: sha256(bundle), hiddenFacadePolicy: true, installedAdapterFacade: true,
      extractedRealMainMatrixTest: 'wave3-main-contract', functionHashes: Object.fromEntries([
        'prepareUnpublishedChatWindowTransaction', 'applyWindowedKeyedChatReconciliation',
        'beginChatPresentationJournal', 'applyKeyedChatReconciliation', 'finalizeChatPresentationJournal',
      ].map((name) => [name, hashNormalizedSource(extractCurrentMainFunction(`function ${name}(`))])) },
    hypotheses: { overscanTiers: TIERS, initialTailOptions: TAILS, mountedCeiling: 140, directChildCeiling: 146 },
    calibration: {
      thresholdSamples: thresholdEvidence(facade),
      intervalCandidates: { consecutive: [1, 2, 3], cooldown: [1, 2, 3] },
      intervalRuns: intervalEvidence(facade),
      alternating,
    },
    options,
    failures,
    workflows,
    traces,
    smoke,
    summary,
    limitations: [
      'Candidate evidence does not select thresholds, tiers, tails, defaults, or rollout.',
      'Node synthetic geometry is not browser timing, paint, memory, or responsiveness evidence.',
      'Browser-real validation is unavailable in this evidence wave.',
    ],
  };
  const bytes = `${JSON.stringify(evidence, null, 2)}\n`;
  fs.writeFileSync(EVIDENCE_FILE, bytes, 'utf8');
  console.log('B4 adaptive range synthetic evidence: PASS');
  console.log(`Evidence: ${EVIDENCE_FILE}`);
  console.log(`Options/samples/blanks: 9/${options.length}/${evidence.summary.geometry.blanks}`);
  console.log(`Anchor denominator/max px: ${evidence.summary.geometry.records}/${evidence.summary.geometry.maximumAnchorErrorPx}`);
  console.log(`Transitions/holds/extreme-flaps: ${alternating.transitions}/${alternating.holds}/${alternating.frameToFrameExtremeFlaps}`);
}

if (require.main === module) main();

module.exports = Object.freeze({ main });
