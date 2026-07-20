/* eslint-disable no-console */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.cwd();
const MAIN_FILE = path.join(ROOT, 'media', 'main.js');
const BUNDLE_FILE = path.join(ROOT, 'media', 'rendering.bundle.js');

function hashNormalizedSource(value) {
  return crypto.createHash('sha256').update(value.replace(/\r\n/g, '\n')).digest('hex');
}

function extractCurrentMainFunction(marker, endMarker = '') {
  const source = fs.readFileSync(MAIN_FILE, 'utf8');
  const matches = source.split(marker).length - 1;
  if (matches !== 1) throw new Error(`Expected one current-main marker ${marker}; received ${matches}`);
  const start = source.indexOf(marker);
  if (endMarker) {
    const end = source.indexOf(endMarker, start + marker.length);
    if (end < 0) throw new Error(`Unclosed current-main exact-end marker ${marker}`);
    return source.slice(start, end);
  }
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unclosed current-main function ${marker}`);
}

function loadInstalledRenderingFacade() {
  const bundle = fs.readFileSync(BUNDLE_FILE, 'utf8');
  const window = {};
  vm.runInNewContext(bundle, { window });
  if (typeof window.__ocRendering?.createTanStackVirtualAdapter !== 'function') {
    throw new Error('Installed rendering facade is missing createTanStackVirtualAdapter');
  }
  return window.__ocRendering;
}

function createAtomicOperations(harness) {
  let ordinal = 0;
  const snapshot = () => Object.freeze({
    itemsLength: harness.context.keyedChatReconcileState.items.length,
    pendingKey: harness.chatWindowState.pendingScrollKey,
    activeOwner: harness.context.activeSessionId,
    generation: harness.context.chatWindowGeneration,
  });
  const operate = (operation, input = {}) => {
    if (!['route', 'alias', 'callback', 'owner-state', 'snapshot'].includes(operation)) {
      throw new RangeError(`Unknown atomic operation ${operation}`);
    }
    if ('owner' in input || 'handle' in input || 'events' in input || 'expected' in input) {
      throw new TypeError('Atomic operation rejects supplied execution ownership');
    }
    const before = snapshot();
    let value;
    if (operation === 'snapshot') {
      value = before;
    } else if (operation === 'route') {
      value = harness.context.applyChatWindowOrWave2(input.session, input.units || harness.units);
    } else if (operation === 'alias') {
      value = harness.adapter.migrateKey(input.oldKey, input.newKey);
    } else if (operation === 'callback') {
      const callback = harness.actualConstructions.at(-1)?.options?.onChange;
      if (typeof callback === 'function') callback();
      value = typeof callback === 'function';
    } else {
      harness.context.activeSessionId = input.sessionId;
      harness.chatWindowState.sessionId = input.sessionId;
      harness.context.chatWindowGeneration += input.generationDelta;
      value = undefined;
    }
    return Object.freeze({ ordinal: ++ordinal, operation, value, before, after: snapshot() });
  };
  return Object.freeze({ operate, snapshot });
}

function createRealTransactionHarness(dependencies) {
  if (!dependencies || typeof dependencies.execute !== 'function') {
    throw new TypeError('B4 harness requires an injected generic executor');
  }
  const execute = dependencies.execute;
  const makeSpy = typeof dependencies.makeSpy === 'function' ? dependencies.makeSpy : () => function neutralSpy() {};
  const facade = dependencies.renderingFacade || loadInstalledRenderingFacade();
  const createAdapter = dependencies.createAdapter || facade.createTanStackVirtualAdapter;
  const planContainment = dependencies.planContainment || facade.planChatWindowContainment;
  const classifyIntegrity = dependencies.classifyIntegrity || facade.classifyChatWindowIntegrity;
  const safeShellSpec = dependencies.safeShellSpec || facade.getSafeShellSpec;
  if (typeof createAdapter !== 'function' || typeof planContainment !== 'function'
    || typeof classifyIntegrity !== 'function' || typeof safeShellSpec !== 'function') {
    throw new TypeError('B4 harness received an incomplete rendering facade');
  }

  return function realTransactionHarness(failStage = '', useRealAdapter = false, harnessOptions = {}) {
    const disposed = [];
    const calls = [];
    let createdRootCount = 0;
    let factoryPreparedCount = 0;
    const failureStageCounts = new Map();
    const preparedAttemptRoots = [];
    const scheduledFrames = [];
    const containmentRequests = [];
    const transactionUnitCounts = [];
    const canonicalSession = { id: 'session-a', timeline: [{ id: 'canonical' }] };
    const makeNode = (key = '', id = key) => {
      const listeners = new Map();
      const node = {
        id, dataset: key ? { renderUnitKey: key, retained: `data-${key}` } : {}, style: {},
        parentElement: null, childNodes: [], attributes: {},
        appendChild(child) { if (child.parentElement) child.remove(); this.childNodes.push(child); child.parentElement = this; return child; },
        insertBefore(child, before) {
          if (child.parentElement) child.remove();
          const index = before ? this.childNodes.indexOf(before) : this.childNodes.length;
          this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, child); child.parentElement = this; return child;
        },
        replaceChildren(...children) { for (const child of this.childNodes) child.parentElement = null; this.childNodes = []; for (const child of children) this.appendChild(child); },
        remove() { const index = this.parentElement?.childNodes.indexOf(this) ?? -1; if (index >= 0) this.parentElement.childNodes.splice(index, 1); this.parentElement = null; },
        removeChild(child) { child.remove(); return child; },
        replaceWith(next) { const parent = this.parentElement; const index = parent.childNodes.indexOf(this); if (next.parentElement) next.remove(); parent.childNodes[index] = next; next.parentElement = parent; this.parentElement = null; },
        setAttribute(name, value) {
          this.attributes[name] = String(value);
          if (name === 'style') this.style.height = /height:\s*([^;]+)/.exec(String(value))?.[1] || '';
        },
        getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; },
        removeAttribute(name) { delete this.attributes[name]; },
        addEventListener(type, listener) {
          if (!listeners.has(type)) listeners.set(type, []);
          listeners.get(type).push(listener);
        },
        dispatch(type) {
          for (const listener of listeners.get(type) || []) listener({ preventDefault() {}, stopPropagation() {} });
        },
        querySelector(selector) {
          const role = /^\[data-safe-shell-role="([^"]+)"\]$/.exec(selector)?.[1];
          const visit = (root) => {
            for (const child of root.childNodes || []) {
              if (role && child.dataset?.safeShellRole === role) return child;
              const nested = visit(child);
              if (nested) return nested;
            }
            return null;
          };
          return visit(this);
        },
        querySelectorAll: () => [], matches: () => false, focus: makeSpy(),
      };
      Object.defineProperty(node, 'children', { get: () => node.childNodes });
      Object.defineProperty(node, 'childElementCount', { get: () => node.childNodes.length });
      Object.defineProperty(node, 'isConnected', {
        get: () => {
          let current = node;
          while (current) { if (current === chatContainer) return true; current = current.parentElement; }
          return false;
        },
      });
      return node;
    };
    const chatContainer = makeNode('', 'chat');
    chatContainer.scrollTop = 31; chatContainer.clientHeight = 400; chatContainer.classList = { add: () => undefined, remove: () => undefined };

    const oldRemove = makeNode('remove'); const oldKeep = makeNode('keep');
    oldRemove._safeShellDispose = () => disposed.push('old-remove');
    oldKeep._safeShellDispose = () => disposed.push('old-keep');
    const top = makeNode('', 'top'); top.setAttribute('style', 'height: 11px');
    const local = makeNode('', 'local'); local.appendChild(makeNode('', 'old-local-child'));
    const oldObserver = { disconnect: makeSpy(), observe: makeSpy() };
    const attemptedObserver = { disconnect: makeSpy(), observe: makeSpy() };
    chatContainer.appendChild(local); chatContainer.appendChild(top); chatContainer.appendChild(oldRemove); chatContainer.appendChild(oldKeep);
    const originalChildren = [...chatContainer.children];
    const oldItems = [{ key: 'remove', fingerprint: 'old-remove' }, { key: 'keep', fingerprint: 'old-keep' }];
    const oldRoots = new Map([['remove', oldRemove], ['keep', oldKeep]]);
    const oldSnapshot = { items: [{ key: 'remove', start: 0, end: 50 }, { key: 'keep', start: 50, end: 100 }], totalSize: 100 };
    const oldRecovery = Object.freeze({ status: 'old' });
    let adapterOwner = 'old';
    let adapterFinalized = false;
    const retainedAdapterConfig = { keys: ['remove', 'keep'], revisions: ['old-remove', 'old-keep'] };
    const retainedObservations = new Set([oldRemove, oldKeep]);
    let adapterUpdateKeys = null;
    const adapterTransaction = {
      prepareCommit: () => { calls.push('prepare'); return failStage !== 'adapter-prepare'; },
      getRange: () => {
        const keys = harnessOptions.units && harnessOptions.units.length > 80 && adapterUpdateKeys
          ? adapterUpdateKeys
          : ['new', 'keep'];
        return {
          items: keys.map((key, index) => ({ key, start: index * 50, end: (index + 1) * 50 })),
          totalSize: keys.length * 50,
        };
      },
      setPresentationRevision: () => undefined, unobserveElement: () => undefined, observeElement: () => undefined,
      commit: () => { calls.push('commit'); return failStage !== 'adapter-commit'; },
      finalizeCommit: () => {
        calls.push('adapter-finalize');
        if (failStage === 'adapter-finalize-preflight') return false;
        adapterOwner = 'candidate'; adapterFinalized = true;
        if (failStage === 'post-barrier-unexpected') throw new Error('injected:post-barrier-unexpected');
        return true;
      },
      retryCompletion: () => true, hasPendingCompletion: () => false,
      isFinalized: () => adapterFinalized,
      abort: () => { calls.push('adapter-abort'); adapterOwner = 'old'; return true; },
    };
    const fakeAdapter = {
      beginTransaction: (update) => { adapterUpdateKeys = update.keys; return adapterTransaction; },
      scrollToKey: () => true,
    };
    if (harnessOptions.missingBeginTransaction) delete fakeAdapter.beginTransaction;
    const actualConstructions = [];
    const actualObservers = [];
    class ActualVirtualizer {
      constructor(options) { this.options = options; this.destroyed = false; this.mountCount = 0; this.updateCount = 0; actualConstructions.push(this); }
      setOptions(options) { this.options = options; }
      _didMount() { this.mountCount += 1; return () => { this.destroyed = true; }; }
      _willUpdate() { this.updateCount += 1; }
      getVirtualItems() {
        const startIndex = Math.max(0, Math.min(this.options.count - 1,
          harnessOptions.viewportStart ?? Math.max(0, this.options.count - 12)));
        const endIndex = Math.min(this.options.count - 1, startIndex + 11);
        const indexes = this.options.rangeExtractor({
          startIndex, endIndex, overscan: this.options.overscan, count: this.options.count,
        });
        return indexes.map((index) => ({
          index, key: this.options.getItemKey(index), start: index * 50, size: 50, end: (index + 1) * 50,
        }));
      }
      getTotalSize() { return this.options.count * 50; }
      scrollToIndex() { /* controlled main integration seam */ }
    }
    class ActualResizeObserver {
      constructor(callback) { this.observed = new Set(); this.disconnected = false; this.callback = callback; actualObservers.push(this); }
      observe(element) { this.observed.add(element); }
      unobserve(element) { this.observed.delete(element); }
      disconnect() { this.disconnected = true; this.observed.clear(); }
      emit(...targets) { this.callback(targets.map((target) => ({ target }))); }
    }
    const adapter = useRealAdapter ? createAdapter({
      keys: ['remove', 'keep'], kinds: ['system', 'system'], presentationRevisions: ['old-remove', 'old-keep'],
      keepMountedKeys: ['keep'], scrollElement: chatContainer,
      ResizeObserver: ActualResizeObserver,
      requestAnimationFrame: () => 1, cancelAnimationFrame: () => undefined,
      initialOwnerMode: harnessOptions.noLiveAdapter ? 'deferred-transaction' : 'active',
    }, ActualVirtualizer) : fakeAdapter;
    const chatWindowState = {
      sessionId: harnessOptions.noLiveAdapter ? '' : 'session-a', adapter: harnessOptions.noLiveAdapter ? null : adapter,
      snapshot: oldSnapshot, allUnits: [{ key: 'old' }], mountedKeys: new Set(['remove', 'keep']),
      topSpacer: top, bottomSpacer: null, anchorKey: 'keep', visualOffset: 7, programmaticScroll: false,
      activityBelow: true, rendering: false, pendingRangeRender: true, failedSessionId: '', localOlderSurface: local,
      localOlderObserver: oldObserver, localOlderObserverArmed: true, pendingScrollKey: 'keep', pendingScrollAttempts: 2,
      localHistoryPresentation: { state: 'old' },
    };
    const windowObject = {
      __ocKeyedChatLastReconcile: { old: 'reconcile' }, __ocChatWindowLastBudget: { old: 'budget' },
      __ocChatWindowDomBudgetAudit: { old: 'audit' }, __ocChatWindowRecovery: oldRecovery,
    };
    const rendering = {
      presentationFingerprint: (value) => JSON.stringify(value),
      planReconciliation: (previous, next) => [
        ...previous.filter((item) => !next.some((candidate) => candidate.key === item.key)).map((item) => ({ type: 'remove', key: item.key })),
        ...[...next].reverse().map((item) => ({ type: previous.some((candidate) => candidate.key === item.key) ? 'replace' : 'create', key: item.key })),
      ],
      planChatWindowContainment: (request) => {
        containmentRequests.push(request);
        return planContainment(request);
      },
      classifyChatWindowIntegrity: classifyIntegrity,
      deriveLocalOlderPresentation: () => ({ state: 'next', actionable: false }),
      restoreKeyedScrollAnchor: () => ({ scrollTop: 31 }),
      getSafeShellSpec: safeShellSpec,
      createTanStackVirtualAdapter: () => adapter,
    };
    windowObject.__ocRendering = rendering;
    windowObject.__ocChatPresentationFailureSeam = (stage, detail) => {
      calls.push(stage);
      const occurrence = (failureStageCounts.get(stage) || 0) + 1;
      failureStageCounts.set(stage, occurrence);
      if (stage === 'factory-prepared' && detail?.root) preparedAttemptRoots.push(detail.root);
      if (stage === 'factory-prepared') factoryPreparedCount += 1;
      if (failStage === 'factory-prepared-multiple' && stage === 'factory-prepared' && factoryPreparedCount === 2) {
        throw new Error('injected:factory-prepared-multiple');
      }
      const shouldFail = stage === failStage
        && (!harnessOptions.failOnce || occurrence === 1);
      if (shouldFail) throw new Error(`injected:${stage}`);
    };
    const markers = [
      'function captureChatWindowAcceptedState(', 'function restoreChatContainerChildren(',
      'function restoreChatWindowAcceptedState(', 'function beginChatPresentationJournal(',
      'function disposePreparedChatRoot(', 'function disposeSupersededChatRoot(',
      'function abortChatPresentationJournal(', 'function finalizeChatPresentationJournal(',
      'function runChatPresentationFailureSeam(', 'function getKeyedPresentationIdentity(',
      'function getKeyedStreamStablePresentation(', 'function renderDetachedKeyedUnit(',
      'function scanSafeShellConflictDiffPage(', 'function renderSafeShellConflictCard(',
      'function renderConflictCard(', 'function isChatWindowAvailable(',
      'function keyedRoots(', 'function keyedRootForKey(', 'function applyKeyedChatReconciliation(',
      'function applyWindowedKeyedChatReconciliation(', 'function applyAcceptedOuterTransactionalBootstrap(',
      'function applyChatWindowOrWave2(', 'function recordChatWindowOuterRecovery(',
      'function completeChatWindowOuterRecovery(', 'function createChatWindowEmergencyDiagnostic(',
      'function retryChatWindowEmergency(', 'function enterChatWindowEmergency(',
      'function consumeChatWindowIntegrityAudit(',
      ...(harnessOptions.noLiveAdapter ? [
        'function disposeUnpublishedChatWindowAdapterCandidate(',
        'function prepareUnpublishedChatWindowTransaction(',
        'function ensureChatWindowAdapter(',
      ] : []),
    ];
    const pressureLifecycle = { current: { generation: 2, accepted: true }, closures: [] };
    const context = execute(markers, {
      activeSessionId: 'session-a', chatContainer, chatWindowState, window: windowObject, document: {
        getElementById: (id) => id === 'chat' ? chatContainer : null,
        createDocumentFragment: () => makeNode('', 'fragment'), createElement: (tagName) => {
          const root = makeNode('', `created-${++createdRootCount}`);
          root.tagName = String(tagName || '').toUpperCase();
          root._safeShellDispose = () => disposed.push(`new:${root.id}`);
          return root;
        },
      },
      keyedChatReconcileState: { sessionId: 'session-a', items: oldItems, roots: new Map(oldRoots) },
      chatStructuralRootReservations: new Set([top, local]), chatWindowAcceptedPlanRevision: 4,
      chatWindowPlanCorrection: { sessionId: 'session-a', generation: 2, planRevision: 3 },
      keyedChatReconcileFailure: { key: 'old-failure', operation: 'old' }, conflictCardEl: oldKeep,
      conflictShellPresentationGeneration: 17, lastConflictPayload: null,
      keyedChatRenderCapture: null, keyedPresentationSelectionOverride: null, keyedUnitKeyOverride: null, keyedFollowingTurnDividerOverride: null,
      renderSafeShellSegment: () => null, renderSafeShellChangeList: () => null, renderSafeShellImageMessage: () => null,
      renderSafeShellDiffMessage: () => null, renderSafeShellCodeMessage: () => null, renderSafeShellTableMessage: () => null,
      renderSafeShellMarkdownMessage: () => null, renderSafeShellUserMessage: () => null, renderSafeShellAssistantMessage: () => null,
      renderSafeShellSubagentMessage: () => null, renderSafeShellToolMetaMessage: () => null,
      renderSegmentElement: () => undefined, renderMessageElement: () => undefined,
      getKeyedUnitPresentation: (_session, unit) => ({ key: unit.key, revision: unit.revision || 'next' }),
      getSessionOrNull: () => canonicalSession,
      resolveChatLocalHistoryWindow: (units) => {
        transactionUnitCounts.push(units.length);
        return { visibleUnits: units, presentation: { state: 'next', actionable: false, label: 'next', hint: '' } };
      },
      reserveChatWindowStructuralRoots: () => undefined,
      ...(harnessOptions.noLiveAdapter ? {} : { ensureChatWindowAdapter: () => adapter }),
      getChatWindowUnitKind: () => 'system', getChatWindowKeepMountedKeys: () => ['keep'],
      buildChatWindowContainmentRequest: (_session, units, snapshot, shellRequests) => {
        const requestedKeys = snapshot.items.map((item) => item.key);
        return {
          requestedKeys, visibleLoadedKeys: units.map((unit) => unit.key), viewportKeys: requestedKeys,
          coreKeys: [], overscanKeys: [], adapterSnapshotKeys: requestedKeys,
          projectedStructuralRoots: 2, limits: { mounted: 140, directChildren: 146 }, shellRequests,
        };
      },
      updateChatWindowSpacers: () => { top.setAttribute('style', 'height: 99px'); chatContainer.appendChild(top); return true; },
      renderChatLocalOlderSurface: () => {
        oldObserver.disconnect(); chatWindowState.localOlderObserver = attemptedObserver;
        local.replaceChildren(makeNode('', 'new-local-child')); chatContainer.insertBefore(local, top); return true;
      },
      scheduleChatWindowPlanCorrection: () => null, sampleChatRenderDom: () => undefined,
      recordChatWindowPressureAttribution: () => undefined, assertChatWindowDomBudget: (budget) => {
        windowObject.__ocChatWindowDomBudgetAudit = budget;
        return budget;
      },
      getChatStructuralIntegrityRoots: () => [], captureChatWindowAnchor: () => { chatWindowState.anchorKey = 'attempt-anchor'; },
      restoreChatWindowAnchor: () => undefined, scrollToBottom: () => undefined, autoScrollPinnedToBottom: false,
      tryPendingChatWindowScroll: () => { chatWindowState.pendingScrollKey = ''; return true; },
      chatLocalHistoryController: { complete: () => calls.push('local-complete') },
      recordChatWindowCleanupCheckpoint: () => calls.push('cleanup'), chatWindowGeneration: 2,
      chatWindowPressureLifecycle: pressureLifecycle,
      beginChatWindowPressureGeneration: (generation) => {
        pressureLifecycle.current = { generation, reserved: true };
        calls.push('pressure-reserve');
      },
      recordChatWindowStaleCallback: () => calls.push('stale-callback'),
      getSessionState: () => ({ hydrationCoverage: null }), normalizePayloadHydrationCoverage: () => null,
      CHAT_WINDOW_MOUNT_LIMIT: 140, CHAT_WINDOW_DIRECT_CHILD_LIMIT: 146, CHAT_PENDING_SCROLL_MAX_ATTEMPTS: 4,
      CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT: Object.freeze({
        ok: false, status: 'window-transaction-unavailable', reason: 'missing-begin-transaction',
      }),
      TANSTACK_CHAT_WINDOW_ENABLED: true, CHAT_WINDOW_CONTAINMENT_POLICY_ENABLED: true,
      CHAT_WINDOW_RECOVERY_ENABLED: true, CHAT_WINDOW_INITIAL_TAIL: 80, CHAT_WINDOW_OVERSCAN: 20,
      projectChatWindowStructuralRoots: () => 2, sessionSearch: { windowTargetKey: 'keep' },
      vscode: { postMessage: () => calls.push('diagnostic') },
      scheduleRenderFromState: (reason) => calls.push(`schedule:${reason}`),
      CHAT_WINDOW_EMERGENCY_ENABLED: true,
      chatWindowEmergencyState: Object.freeze({ status: 'idle', sessionId: '', generation: -1, root: null, codes: [] }),
      chatWindowOuterRecovery: Object.freeze({ status: 'idle', sessionId: '', generation: -1, reason: 'none', rawIntegrity: null }),
      requestAnimationFrame: (callback) => { scheduledFrames.push(callback); return scheduledFrames.length; },
      cancelAnimationFrame: () => undefined, setTimeout: () => 1, clearTimeout: () => undefined,
      writeTextToClipboard: () => true, postOpenGitDiff: () => undefined,
      Map, Set, Array, Object, Math, Number, Boolean, Error,
    });
    for (const marker of markers) {
      const name = marker.match(/function\s+([^\s(]+)/)?.[1];
      if (name && typeof context[name] !== 'function') throw new TypeError(`B4 executor omitted production export ${name}`);
    }
    const units = harnessOptions.units || [{ key: 'keep', kind: 'greeting', value: null }, { key: 'new', kind: 'greeting', value: null }];
    const result = {
      context, units, chatContainer, chatWindowState, windowObject, originalChildren, oldItems, oldRoots,
      oldSnapshot, oldRecovery, disposed, calls, top, local, oldObserver, attemptedObserver,
      retainedAdapterConfig, retainedObservations, get adapterOwner() { return adapterOwner; },
      adapter, actualConstructions, actualObservers, pressureLifecycle, preparedAttemptRoots, scheduledFrames, makeNode,
      failureStageCounts, containmentRequests, transactionUnitCounts, canonicalSession,
    };
    result.atomic = createAtomicOperations(result);
    return result;
  };
}

function createAtomicScenarioExecutor(dependencies) {
  const createHarness = createRealTransactionHarness(dependencies);
  return Object.freeze({
    create(failStage = '', useRealAdapter = false, options = {}) {
      const harness = createHarness(failStage, useRealAdapter, options);
      return harness.atomic;
    },
  });
}

module.exports = Object.freeze({
  createAtomicScenarioExecutor,
  createRealTransactionHarness,
  extractCurrentMainFunction,
  hashNormalizedSource,
});
