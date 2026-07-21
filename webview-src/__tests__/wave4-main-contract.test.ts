import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { createSessionSearchState } from '../features/search/search-state';
import { createSessionSearchDomController } from '../features/search/search-dom-controller';

const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
const css = fs.readFileSync(path.join(process.cwd(), 'media', 'main.css'), 'utf8');
const searchInteractionSource = fs.readFileSync(
  path.join(process.cwd(), 'webview-src', 'features', 'search', 'search-interaction-controller.ts'),
  'utf8',
);
const searchDomSource = fs.readFileSync(
  path.join(process.cwd(), 'webview-src', 'features', 'search', 'search-dom-controller.ts'),
  'utf8',
);

function extractFunction(marker: string): string {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unclosed function ${marker}`);
}

describe('Wave 4 main-script local older contract', () => {
  test('event dispatcher has one authoritative branch for each state-mutating event', () => {
    for (const type of ['attachmentAdded', 'attachmentError', 'permissionPrompt', 'diffChunk', 'messageAppend']) {
      expect(source.match(new RegExp(`case '${type}':`, 'g')) || []).toHaveLength(1);
    }
    const appendStart = source.indexOf("case 'messageAppend':");
    const appendEnd = source.indexOf("case 'revertedSegment':", appendStart);
    const appendBranch = source.slice(appendStart, appendEnd);
    expect(appendBranch).toContain('session?.canceledActiveTurn');
    expect(appendBranch).toContain('session?.turnFullyFinalized === true');
  });

  test('session-scoped background events cannot render or scroll the active virtual window', () => {
    for (const type of ['addResponse', 'attachmentError', 'revertedSegmentDiscarded', 'restoredSegment',
      'revertedSegmentState', 'segmentRestoreLock', 'error', 'removeMessage']) {
      const start = source.indexOf(`case '${type}':`);
      const nextCase = source.indexOf("\n            case '", start + 1);
      const branch = source.slice(start, nextCase);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(branch).toContain('renderIfActive(sessionId,');
      expect(branch).not.toContain('window.__oc?.renderFromState?.()');
    }
  });

  test('owns one accessible structural root, a persistent button fallback, and optional observer', () => {
    expect(source).toContain('const CHAT_LOCAL_OLDER_BATCH = 40;');
    expect(source).toContain("classifyChatStructuralSurface(surface, 'window:local-older'");
    expect(source).toContain("button.textContent = 'Load older';");
    expect(source).toContain("button.setAttribute('aria-label', 'Load older messages');");
    expect(source).toContain("typeof IntersectionObserver === 'function'");
    expect(source).toContain("button.addEventListener('click'");
    expect(css).toContain('.chat-local-older-surface');
  });

  test('uses presentation-only local units while retaining complete search corpus', () => {
    expect(source).toContain('chatWindowState.allUnits = units;');
    expect(source).toContain('const localWindow = resolveChatLocalHistoryWindow(units);');
    expect(source).toContain('ensureChatWindowAdapter(session, localWindow.visibleUnits)');
    expect(source).toContain('chatLocalHistoryController.revealToKey');
    expect(source).toContain('return chatWindowState.allUnits.map((unit) =>');
  });

  test('captures anchor before reveal, cleans controls on fallback, and preserves accepted caps', () => {
    expect(extractFunction('function activateChatLocalOlder(')).toMatch(/captureChatWindowAnchor\(\);\s+const result = chatLocalHistoryController\.activate/);
    expect(source).toContain('destroyChatLocalOlderSurface();');
    expect(source).toContain('const CHAT_WINDOW_MOUNT_LIMIT = 140;');
    expect(source).toContain('const CHAT_WINDOW_DIRECT_CHILD_LIMIT = 146;');
    expect(source).toContain('const CHAT_STRUCTURAL_SURFACE_LIMIT = 6;');
    expect(source).toContain('if (budget.descendants > 4000)');
    expect(source).toContain('chatLocalHistoryController.complete(reconcileSessionId);');
  });

  test('executable control keeps button without observer and renders terminal states without action', () => {
    const inserted: any[] = [];
    const makeElement = () => ({
      dataset: {}, children: [] as any[], attributes: {} as Record<string, string>,
      replaceChildren() { this.children = []; },
      appendChild(child: any) { this.children.push(child); },
      setAttribute(name: string, value: string) { this.attributes[name] = value; },
      addEventListener(name: string, callback: () => void) { (this as any)[`on${name}`] = callback; },
    });
    const context = vm.createContext({
      chatWindowState: { localOlderSurface: null, localOlderObserver: null, topSpacer: { id: 'top' } },
      document: { createElement: makeElement },
      classifyChatStructuralSurface: (element: any, key: string) => { element.structuralKey = key; return element; },
      chatContainer: { insertBefore: (surface: any) => inserted.push(surface) },
      keyedRoots: () => [], activateChatLocalOlder: () => true,
      reserveChatStructuralRoot: (element: any) => element,
      preflightChatRenderRootAdmission: () => ({ allowed: true }),
      chatStructuralRootReservations: new Set(),
    });
    vm.runInContext(`${extractFunction('function ensureChatLocalOlderSurface(')}\n${extractFunction('function renderChatLocalOlderSurface(')}; globalThis.render = renderChatLocalOlderSurface;`, context);
    const available = { state: 'localOlderAvailable', label: 'Load older', hint: '', actionable: true };
    (context as any).render(available);
    const surface = inserted.at(-1);
    expect(surface.structuralKey).toBe('window:local-older');
    expect(surface.children).toHaveLength(1);
    expect(surface.children[0]).toMatchObject({ textContent: 'Load older', attributes: { 'aria-label': 'Load older messages' } });
    expect(typeof surface.children[0].onclick).toBe('function');

    (context as any).render({ state: 'localStartReached', label: 'Start of loaded history', hint: '', actionable: false });
    expect(surface.children).toHaveLength(1);
    expect(surface.children[0]).toMatchObject({ textContent: 'Start of loaded history', attributes: { role: 'status' } });
    (context as any).render({
      state: 'deltaContinuityUnknown', label: 'Loading history ...', actionable: false,
      hint: '',
    });
    expect(surface.children.map((child: any) => child.textContent)).toEqual(['Loading history ...']);
    expect(surface.children.some((child: any) => child.textContent === 'Load older')).toBe(false);

    (context as any).render({ state: 'deltaContinuityUnknown', label: 'Loading history ...', hint: '', actionable: false }, true);
    expect(surface.children).toHaveLength(0);
  });

  test('executable next/previous search keeps full loaded ordering and jumps unrevealed keys once', () => {
    const jumps: string[] = [];
    const searchState = createSessionSearchState();
    searchState.setTextQuery('needle');
    searchState.setTextMatchKeys(['old-unrevealed', 'middle-unrevealed', 'recent']);
    const sessionSearchDomController = createSessionSearchDomController({
      document: { defaultView: null, querySelector: () => null, getElementById: () => null } as unknown as Document,
      state: searchState,
      onManualScroll: () => undefined,
      collectTextMatchKeys: () => [],
      ensureKeyMounted: (key) => { jumps.push(key); return true; },
    });
    const context = vm.createContext({ sessionSearch: searchState, sessionSearchDomController });
    vm.runInContext(`${extractFunction('function goToSessionSearchMatch(')}; globalThis.go = goToSessionSearchMatch;`, context);
    (context as any).go(1);
    (context as any).go(1);
    (context as any).go(1);
    expect(jumps).toEqual(['old-unrevealed', 'middle-unrevealed', 'recent']);
    expect((context as any).sessionSearch.activeKeyIndex).toBe(2);
  });

  test('text search count remains global when the mounted DOM hit count changes', () => {
    const count = { textContent: '', classList: { toggle: () => undefined } };
    const prev = { disabled: true };
    const next = { disabled: true };
    const smart = { disabled: false, textContent: '', classList: { toggle: () => undefined } };
    const elements: Record<string, any> = {
      'session-search-count': count, 'session-search-prev': prev,
      'session-search-next': next, 'session-search-smart': smart,
    };
    const searchState = createSessionSearchState();
    searchState.setTextQuery('灰屏');
    searchState.setTextMatchKeys(Array.from({ length: 25 }, (_, index) => `key-${index}`), true);
    searchState.navigate(1);
    searchState.matches = Array.from({ length: 8 });
    const sessionSearchDomController = createSessionSearchDomController({
      document: {
        defaultView: null,
        getElementById: (id: string) => elements[id] || null,
        querySelector: () => null,
      } as unknown as Document,
      state: searchState,
      onManualScroll: () => undefined,
      collectTextMatchKeys: () => [],
      ensureKeyMounted: () => false,
    });
    const context = vm.createContext({ sessionSearch: searchState, sessionSearchDomController });
    vm.runInContext(`${extractFunction('function getSessionSearchElements(')}\n${extractFunction('function updateSessionSearchControls(')}; globalThis.update = updateSessionSearchControls;`, context);
    (context as any).update();
    expect(count.textContent).toBe('2/25');
    searchState.matches = Array.from({ length: 13 });
    (context as any).update();
    expect(count.textContent).toBe('2/25');
    expect(prev.disabled).toBe(false);
    expect(next.disabled).toBe(false);
  });

  test('smart search count and navigation use global ids rather than mounted DOM hits', () => {
    const jumps: string[] = [];
    const count = { textContent: '', classList: { toggle: () => undefined } };
    const prev = { disabled: true };
    const next = { disabled: true };
    const smart = { disabled: false, textContent: '', classList: { toggle: () => undefined } };
    const elements: Record<string, any> = {
      'session-search-count': count, 'session-search-prev': prev,
      'session-search-next': next, 'session-search-smart': smart,
    };
    const searchState = createSessionSearchState();
    searchState.setTextQuery('related request');
    searchState.setSmartResults(['old-unmounted', 'middle-unmounted', 'recent-mounted']);
    searchState.matches = [{ dataset: { messageId: 'recent-mounted' } }];
    const sessionSearchDomController = createSessionSearchDomController({
      document: {
        defaultView: null,
        getElementById: (id: string) => elements[id] || null,
        querySelector: () => null,
      } as unknown as Document,
      state: searchState,
      onManualScroll: () => undefined,
      collectTextMatchKeys: () => [],
      ensureKeyMounted: (key) => { jumps.push(key); return true; },
    });
    const context = vm.createContext({
      sessionSearch: searchState,
      sessionSearchDomController,
    });
    vm.runInContext(`${extractFunction('function getSessionSearchElements(')}\n${extractFunction('function updateSessionSearchControls(')}\n${extractFunction('function goToSessionSearchMatch(')}; globalThis.update = updateSessionSearchControls; globalThis.go = goToSessionSearchMatch;`, context);

    (context as any).update();
    expect(count.textContent).toBe('1/3');
    (context as any).go(1);
    (context as any).go(1);
    expect(jumps).toEqual(['middle-unmounted', 'recent-mounted']);
    expect(count.textContent).toBe('3/3');
    expect(prev.disabled).toBe(false);
    expect(next.disabled).toBe(false);
  });

  test('global text results retain one navigation location per canonical unit', () => {
    const context = vm.createContext({
      activeSessionId: 'session-a',
      getSessionState: () => ({ timeline: ['message-a'], messagesById: new Map(), hiddenSet: new Set() }),
      window: { __oc: { getLoadedChatSearchRows: () => [
        { id: 'message-a', text: '灰屏灰屏', matchCount: 2 },
        { id: 'message-b', text: '灰屏', matchCount: 1 },
      ] } },
    });
    vm.runInContext(`${extractFunction('function collectLoadedTextSearchKeys(')}; globalThis.collect = collectLoadedTextSearchKeys;`, context);
    expect((context as any).collect('灰屏')).toEqual(['message-a', 'message-b']);
    expect(source).toContain('createSessionSearchDomController({');
    const syncOwner = extractFunction('function syncActiveTextSearchDomHit(');
    expect(source).toContain('onManualScroll: () => { autoScrollPinnedToBottom = false; }');
    expect(syncOwner).toContain('sessionSearchDomController.syncActiveTextHit(options);');
    expect(syncOwner).not.toContain('chatWindowState');
    expect(searchDomSource).toContain('!keyedRoot(navigation.targetKey) && options.ensureKeyMounted(navigation.targetKey)');
  });

  test('typing computes globally without moving the virtual window and first next selects result zero', () => {
    const syncOwner = extractFunction('function syncActiveTextSearchDomHit(');
    expect(source).toContain('sessionSearchInteractionController.install({');
    expect(searchInteractionSource).toContain("options.state.setTextQuery(elements.input?.value || '');");
    expect(searchInteractionSource).toContain('scheduleRefresh({ jumpToFirst: false });');

    expect(syncOwner).toContain('sessionSearchDomController.syncActiveTextHit(options);');
  });

  test('observer requires false-to-true re-entry and static intersecting callbacks reveal one batch', () => {
    let observerCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;
    let activations = 0;
    class FakeIntersectionObserver {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) { observerCallback = callback; }
      observe() { /* executable observer seam */ }
      disconnect() { /* executable observer seam */ }
    }
    const makeElement = () => ({
      dataset: {}, children: [] as any[], attributes: {} as Record<string, string>,
      replaceChildren() { this.children = []; }, appendChild(child: any) { this.children.push(child); },
      setAttribute(name: string, value: string) { this.attributes[name] = value; },
      addEventListener(name: string, callback: () => void) { (this as any)[`on${name}`] = callback; },
    });
    const context = vm.createContext({
      IntersectionObserver: FakeIntersectionObserver,
      chatWindowState: {
        localOlderSurface: null, localOlderObserver: null, localOlderObserverArmed: true, topSpacer: {},
      },
      document: { createElement: makeElement }, classifyChatStructuralSurface: (element: any) => element,
      chatContainer: { insertBefore: () => undefined }, keyedRoots: () => [],
      activateChatLocalOlder: () => { activations += 1; return true; },
      reserveChatStructuralRoot: (element: any) => element,
      preflightChatRenderRootAdmission: () => ({ allowed: true }),
      chatStructuralRootReservations: new Set(),
    });
    vm.runInContext(`${extractFunction('function ensureChatLocalOlderSurface(')}\n${extractFunction('function renderChatLocalOlderSurface(')}; globalThis.render = renderChatLocalOlderSurface;`, context);
    const available = { state: 'localOlderAvailable', label: 'Load older', hint: '', actionable: true };
    (context as any).render(available);
    observerCallback?.([{ isIntersecting: true }]);
    (context as any).render(available);
    observerCallback?.([{ isIntersecting: true }]);
    observerCallback?.([{ isIntersecting: true }]);
    expect(activations).toBe(1);
    observerCallback?.([{ isIntersecting: false }]);
    observerCallback?.([{ isIntersecting: true }]);
    expect(activations).toBe(2);
  });

  test('transaction-capable windowed fake follows planned journaled prepare/seal/finalize', () => {
    const calls: string[] = [];
    const transaction = {
      prepareCommit: () => { calls.push('prepare'); return true; },
      getRange: () => ({ items: [], totalSize: 0 }),
      setPresentationRevision: () => undefined, unobserveElement: () => undefined, observeElement: () => undefined,
      commit: () => { calls.push('seal'); return true; },
      finalizeCommit: () => { calls.push('finalize'); return true; },
      hasPendingCompletion: () => false, retryCompletion: () => true, isFinalized: () => false,
      abort: () => { calls.push('abort'); return true; },
    };
    const adapter = { beginTransaction: () => { calls.push('begin'); return transaction; } };
    const windowObject: any = { __ocRendering: {
      presentationFingerprint: () => 'revision',
      planChatWindowContainment: () => ({
        allowed: true, acceptedKeys: [], mountedCount: 0, directChildCount: 0, shellSelections: {},
      }),
    } };
    const context = vm.createContext({
      activeSessionId: 'session-a', autoScrollPinnedToBottom: false, Map, Set, Object, Error,
      CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT: Object.freeze({
        ok: false, status: 'window-transaction-unavailable', reason: 'missing-begin-transaction',
      }),
      CHAT_WINDOW_CANDIDATE_STALE_RESULT: Object.freeze({
        ok: false, status: 'window-candidate-stale', reason: 'candidate-owner-stale',
      }),
      CHAT_WINDOW_MOUNT_LIMIT: 140, CHAT_WINDOW_DIRECT_CHILD_LIMIT: 146,
      CHAT_PENDING_SCROLL_MAX_ATTEMPTS: 4, chatWindowGeneration: 1, chatWindowAcceptedPlanRevision: 0,
      chatWindowState: {
        sessionId: 'session-a', adapter, rendering: false, pendingRangeRender: false, allUnits: [], pendingScrollKey: '', mountedKeys: new Set(),
      },
      window: windowObject, chatContainer: { childElementCount: 0, querySelectorAll: () => [] },
      resolveChatLocalHistoryWindow: () => ({ visibleUnits: [], presentation: {} }),
      captureChatWindowAcceptedState: () => ({}),
      beginChatPresentationJournal: () => ({ adapterTransaction: null }),
      finalizeChatPresentationJournal: () => { calls.push('journal-finalize'); calls.push('complete'); return true; },
      abortChatPresentationJournal: () => { calls.push('journal-abort'); return true; },
      captureChatWindowAnchor: () => undefined, reserveChatWindowStructuralRoots: () => undefined,
      ensureChatWindowAdapter: () => adapter,
      getChatWindowUnitKind: () => 'system', getKeyedUnitPresentation: () => ({}), getChatWindowKeepMountedKeys: () => [],
      buildChatWindowContainmentRequest: () => ({ requestedKeys: [], limits: { mounted: 140, directChildren: 146 } }),
      runChatPresentationFailureSeam: () => undefined,
      applyKeyedChatReconciliation: () => calls.push('keyed-planned'),
      updateChatWindowSpacers: () => true, renderChatLocalOlderSurface: () => true,
      isActiveSessionHistoryLoading: () => false,
      keyedRootForKey: () => null, keyedRoots: () => [], getChatStructuralIntegrityRoots: () => [],
      sampleChatRenderDom: () => undefined, recordChatWindowPressureAttribution: () => undefined,
      assertChatWindowDomBudget: (budget: any) => budget, scheduleChatWindowPlanCorrection: () => null,
      tryPendingChatWindowScroll: () => true, scrollToBottom: () => undefined, restoreChatWindowAnchor: () => undefined,
      chatLocalHistoryController: { complete: () => calls.push('unexpected-direct-complete') },
    });
    vm.runInContext(`${extractFunction('function applyWindowedKeyedChatReconciliation(')}; globalThis.apply = applyWindowedKeyedChatReconciliation;`, context);
    expect((context as any).apply({}, [])).toEqual([]);
    expect(calls).toEqual(['begin', 'prepare', 'keyed-planned', 'seal', 'finalize', 'journal-finalize', 'complete']);
    expect((context as any).chatWindowState.rendering).toBe(false);
  });

  test.each([
    ['window-unavailable-retained', 1, 'retained'],
    ['window-unavailable-bootstrap-pending', 0, 'empty'],
  ])('missing beginTransaction routes to %s with exact sentinel and zero mutation', (expectedRoute, rootCount, status) => {
    const calls: string[] = [];
    const sentinel = Object.freeze({
      ok: false, status: 'window-transaction-unavailable', reason: 'missing-begin-transaction',
    });
    const roots = Array.from({ length: rootCount }, (_, index) => ({ dataset: { renderUnitKey: `k${index}` } }));
    const state = { sessionId: 'session-a', adapter: {}, rendering: false, pendingRangeRender: false, allUnits: [], pendingScrollKey: '', mountedKeys: new Set() };
    const context = vm.createContext({
      activeSessionId: 'session-a', Map, Set, Object, Math, Number, Array, Error,
      CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT: sentinel,
      CHAT_WINDOW_CANDIDATE_STALE_RESULT: Object.freeze({
        ok: false, status: 'window-candidate-stale', reason: 'candidate-owner-stale',
      }),
      CHAT_WINDOW_INITIAL_TAIL: 80, CHAT_WINDOW_MOUNT_LIMIT: 140, CHAT_WINDOW_DIRECT_CHILD_LIMIT: 146,
      TANSTACK_CHAT_WINDOW_ENABLED: true, CHAT_WINDOW_CONTAINMENT_POLICY_ENABLED: true, CHAT_WINDOW_RECOVERY_ENABLED: true,
      chatWindowState: state, keyedChatReconcileFailure: null, keyedRoots: () => roots,
      isChatWindowAvailable: () => true, projectChatWindowStructuralRoots: () => 2,
      isActiveSessionHistoryLoading: () => false,
      sessionSearch: { windowTargetKey: '' }, window: { __ocRendering: { planChatWindowContainment: () => null } },
      vscode: { postMessage: () => calls.push('recovery') },
      applyKeyedChatReconciliation: () => calls.push('forbidden-keyed'),
      resolveChatLocalHistoryWindow: () => { calls.push('forbidden-local-window'); return { visibleUnits: [], presentation: {} }; },
      ensureChatWindowAdapter: () => { calls.push('forbidden-adapter-create'); return null; },
      chatLocalHistoryController: { complete: () => calls.push('forbidden-complete') },
    });
    vm.runInContext(`${extractFunction('function applyWindowedKeyedChatReconciliation(')}\n${extractFunction('function applyChatWindowOrWave2(')}; Object.assign(globalThis, { applyWindowedKeyedChatReconciliation, applyChatWindowOrWave2 });`, context);
    const stateIdentity = (context as any).chatWindowState;
    expect((context as any).applyWindowedKeyedChatReconciliation({}, [])).toBe(sentinel);
    expect((context as any).applyChatWindowOrWave2({}, [])).toBe(expectedRoute);
    expect((context as any).window.__ocChatWindowRecovery).toEqual({
      status, reason: 'missing-begin-transaction', retryAttempted: false, retryPending: true, boundedRootCount: rootCount,
    });
    expect(calls).toEqual(['recovery']);
    expect((context as any).chatWindowState).toBe(stateIdentity);
    expect(source).not.toContain('applyKeyedChatReconciliation(session, legacyUnits)');
    expect(extractFunction('function applyChatWindowOrWave2(')).not.toMatch(/renderFromStateLegacy|disableChatWindowForSession|destroyChatWindowAdapter|session\.timeline/);
  });

  test('adapter-creation exception stays unpublished and does not resolve or complete local history', () => {
    const calls: string[] = [];
    const unavailable = Object.freeze({
      ok: false, status: 'window-transaction-unavailable', reason: 'missing-begin-transaction',
    });
    const state: any = {
      sessionId: '', adapter: null, snapshot: { accepted: true }, rendering: false,
      pendingRangeRender: false, allUnits: [], pendingScrollKey: '', mountedKeys: new Set(),
      anchorKey: '', localHistoryPresentation: { accepted: true },
    };
    const context = vm.createContext({
      activeSessionId: 'session-a', chatWindowGeneration: 7, Map, Set, Object, Math,
      CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT: unavailable,
      CHAT_WINDOW_CANDIDATE_STALE_RESULT: Object.freeze({
        ok: false, status: 'window-candidate-stale', reason: 'candidate-owner-stale',
      }),
      CHAT_WINDOW_REQUIRED_TRANSACTION_METHODS: Object.freeze([
        'getRange', 'update', 'observeElement', 'unobserveElement', 'invalidateMeasurement',
        'setPresentationRevision', 'migrateKey', 'prepareCommit', 'commit', 'finalizeCommit',
        'retryCompletion', 'isFinalized', 'isDegraded', 'hasPendingCompletion', 'abort',
      ]),
      disposedUnpublishedChatWindowCandidates: new WeakSet(),
      chatWindowState: state, CHAT_WINDOW_INITIAL_TAIL: 80, CHAT_WINDOW_OVERSCAN: 20,
      CHAT_WINDOW_MOUNT_LIMIT: 140, CHAT_WINDOW_DIRECT_CHILD_LIMIT: 146,
      sessionSearch: { windowTargetKey: '' }, chatContainer: {},
      getSessionState: () => ({ hydrationCoverage: null }), normalizePayloadHydrationCoverage: () => null,
      projectChatWindowStructuralRoots: () => 3, getKeyedUnitPresentation: () => ({}),
      beginChatWindowPressureGeneration: () => calls.push('forbidden-pressure'),
      recordChatWindowStaleCallback: () => calls.push('forbidden-stale'),
      scheduleRenderFromState: () => calls.push('forbidden-schedule'),
      vscode: { postMessage: () => calls.push('forbidden-message') },
      autoScrollPinnedToBottom: false, scrollToBottom: () => calls.push('forbidden-scroll'),
      restoreChatWindowAnchor: () => calls.push('forbidden-anchor'),
      window: { __ocRendering: {
        deriveLocalOlderPresentation: () => { calls.push('derive'); return { state: 'hidden' }; },
        planChatWindowContainment: (request: any) => {
          calls.push('plan');
          return { allowed: true, acceptedKeys: request.requestedKeys, mountedCount: 1, directChildCount: 4, shellSelections: {} };
        },
        presentationFingerprint: () => 'revision',
        createTanStackVirtualAdapter: (options: any) => {
          calls.push(`factory:${options.initialOwnerMode}`);
          throw new Error('adapter-create');
        },
      } },
      resolveChatLocalHistoryWindow: () => { calls.push('forbidden-local-window'); return {}; },
      chatLocalHistoryController: { complete: (sessionId: string) => calls.push(`complete:${sessionId}`) },
    });
    vm.runInContext(`
      ${extractFunction('function getChatWindowKeepMountedKeys(')}
      ${extractFunction('function getChatWindowUnitKind(')}
      ${extractFunction('function getKeyedPresentationIdentity(')}
      ${extractFunction('function disposeUnpublishedChatWindowAdapterCandidate(')}
      ${extractFunction('function prepareUnpublishedChatWindowTransaction(')}
      globalThis.prepare = prepareUnpublishedChatWindowTransaction;
    `, context);
    const stateIdentity = (context as any).chatWindowState;
    const snapshotIdentity = state.snapshot;
    expect((context as any).prepare({}, [{ key: 'unit-a', kind: 'message', value: { message: { role: 'assistant' } } }], [], null))
      .toBe(unavailable);
    expect(calls).toEqual(['derive', 'plan', 'factory:deferred-transaction']);
    expect((context as any).chatWindowState).toBe(stateIdentity);
    expect(state.adapter).toBeNull();
    expect(state.snapshot).toBe(snapshotIdentity);
    expect((context as any).chatWindowGeneration).toBe(7);
  });

  test('pending search key survives two misses, clears on success, and has a bounded terminal path', () => {
    const diagnostics: unknown[] = [];
    let calls = 0;
    const context = vm.createContext({
      CHAT_PENDING_SCROLL_MAX_ATTEMPTS: 4,
      chatWindowState: {
        pendingScrollKey: 'old-key', pendingScrollAttempts: 0,
        allUnits: [{ key: 'old-key' }],
        adapter: { scrollToKey: () => { calls += 1; return calls >= 3; } },
      },
      sessionSearch: { windowTargetKey: 'old-key' },
      keyedRootForKey: () => null,
      vscode: { postMessage: (message: unknown) => diagnostics.push(message) },
    });
    vm.runInContext(`${extractFunction('function clearPendingChatWindowScroll(')}\n${extractFunction('function tryPendingChatWindowScroll(')}; Object.assign(globalThis, { tryPendingChatWindowScroll });`, context);
    expect((context as any).tryPendingChatWindowScroll('first')).toBe(false);
    expect((context as any).chatWindowState.pendingScrollKey).toBe('old-key');
    expect((context as any).tryPendingChatWindowScroll('second')).toBe(false);
    expect((context as any).chatWindowState.pendingScrollKey).toBe('old-key');
    expect((context as any).tryPendingChatWindowScroll('third')).toBe(true);
    expect((context as any).chatWindowState.pendingScrollKey).toBe('');
    expect((context as any).chatWindowState.pendingScrollAttempts).toBe(0);
    expect((context as any).sessionSearch.windowTargetKey).toBe('');
    expect(diagnostics.some((message: any) => message.payload?.[0] === '[WV][CHAT_WINDOW_SEARCH_PENDING_CLEAR]')).toBe(true);

    (context as any).chatWindowState.pendingScrollKey = 'old-key';
    (context as any).chatWindowState.adapter.scrollToKey = () => false;
    for (let attempt = 0; attempt < 4; attempt += 1) (context as any).tryPendingChatWindowScroll(`terminal-${attempt}`);
    expect((context as any).chatWindowState.pendingScrollKey).toBe('');
    expect(diagnostics.some((message: any) => message.payload?.[0] === '[WV][CHAT_WINDOW_SEARCH_PENDING_TERMINAL]')).toBe(true);
  });
});
