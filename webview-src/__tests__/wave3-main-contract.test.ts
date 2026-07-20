import fs from 'fs';
import path from 'path';
import vm from 'vm';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { classifyChatWindowIntegrity, planChatWindowContainment } from '../rendering/chat-window-budget-plan';
import { createTanStackVirtualAdapter, type VirtualizerConstructor } from '../rendering/tanstack-virtual-adapter';
import { getSafeShellSpec } from '../rendering/safe-shell-spec';
import { decideChatWindowAdaptivePolicy } from '../rendering/chat-window-adaptive-policy';

const { createAtomicScenarioExecutor, createRealTransactionHarness } = require('../../scripts/chat-window-adaptive-range-harness.js');

const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
const recoveredSource = fs.readFileSync(path.join(process.cwd(), '.opencode', 'attachments',
  '2026-07-16-wave-b4s-recovered-reviewed', 'media-main.js'), 'utf8');
const wave3TestSource = fs.readFileSync(__filename, 'utf8');
const b4ScriptPath = path.join(process.cwd(), 'scripts', 'chat-window-adaptive-range-synthetic.js');
const b4EvidencePath = 'C:\\Users\\tan_s\\AppData\\Local\\Temp\\opencode\\wave-b4-adaptive-range-evidence.json';

const SNAPSHOT_HISTORY_OWNER_DIAGNOSTIC = 'missing owner transition before activating hydration/render';
const SNAPSHOT_HISTORY_ROUTE_DIAGNOSTIC = 'route audit remains reachable for a retained/bootstrap/retry-pending route';

function collectSnapshotHistorySemanticDiagnostics(candidateSource: string) {
  const diagnostics: string[] = [];
  const block = (marker: string) => {
    const start = candidateSource.indexOf(marker);
    if (start < 0) return '';
    const brace = candidateSource.indexOf('{', start);
    let depth = 0;
    for (let index = brace; index < candidateSource.length; index += 1) {
      if (candidateSource[index] === '{') depth += 1;
      if (candidateSource[index] === '}' && --depth === 0) return candidateSource.slice(start, index + 1);
    }
    return '';
  };
  const transition = block('function transitionActiveSessionPresentationOwner(previousSessionId, targetSessionId)');
  const sessionHandler = block('function handleSessionIdMessage(message)');
  const sessionDataStart = candidateSource.indexOf("case 'sessionData': {");
  const sessionDataEnd = candidateSource.indexOf("case 'sessionLoadFailed':", sessionDataStart);
  const sessionData = sessionDataStart >= 0 && sessionDataEnd > sessionDataStart
    ? candidateSource.slice(sessionDataStart, sessionDataEnd) : '';
  const activatingBranch = sessionData.indexOf('if (shouldActivateSession)');
  const transitionCall = sessionData.indexOf('transitionActiveSessionPresentationOwner(activeSessionId, sessionId)', activatingBranch);
  const activeAssignment = sessionData.indexOf('activeSessionId = sessionId', activatingBranch);
  const initStart = candidateSource.indexOf("case 'init': {");
  const initEnd = candidateSource.indexOf("case 'serverStatus':", initStart);
  const init = initStart >= 0 && initEnd > initStart ? candidateSource.slice(initStart, initEnd) : '';
  const initTransition = init.indexOf('transitionActiveSessionPresentationOwner(activeSessionId, incomingSessionId');
  const initAssignment = init.indexOf('activeSessionId = incomingSessionId');
  const ownerReady = transition.includes("destroyChatWindowAdapter('session-switch')")
    && sessionHandler.includes('transitionActiveSessionPresentationOwner(prevSessionId, sessionId)')
    && activatingBranch >= 0 && transitionCall > activatingBranch
    && activeAssignment > transitionCall
    && initTransition >= 0 && initAssignment > initTransition;
  if (!ownerReady) diagnostics.push(SNAPSHOT_HISTORY_OWNER_DIAGNOSTIC);

  const render = block('function renderFromState()');
  const routeCapture = /const\s+(\w+)\s*=\s*applyChatWindowOrWave2\(/.exec(render);
  const auditIndex = render.indexOf('captureChatWindowRawIntegrityAudit()');
  const routeGuardIndex = routeCapture
    ? render.indexOf(`if (!CHAT_WINDOW_RAW_AUDIT_ACCEPTED_ROUTES.has(${routeCapture[1]}))`) : -1;
  const routeReady = routeCapture !== null
    && candidateSource.includes('const CHAT_WINDOW_RAW_AUDIT_ACCEPTED_ROUTES = Object.freeze(new Set([')
    && routeGuardIndex >= 0 && auditIndex > routeGuardIndex;
  if (!routeReady) diagnostics.push(SNAPSHOT_HISTORY_ROUTE_DIAGNOSTIC);
  return diagnostics;
}

describe('SH1 snapshot history presentation ownership', () => {
  test('current source satisfies owner transition ordering and closed route-audit eligibility', () => {
    expect(collectSnapshotHistorySemanticDiagnostics(source)).toEqual([]);
  });

  test('semantic collector reports both original defects and rejects a missing condition', () => {
    const transitionBody = extractFunction('function transitionActiveSessionPresentationOwner(');
    const original = source
      .replace(transitionBody, '')
      .replace('transitionActiveSessionPresentationOwner(prevSessionId, sessionId);', '')
      .replace('transitionActiveSessionPresentationOwner(activeSessionId, incomingSessionId || activeSessionId || \'\');', '')
      .replace('transitionActiveSessionPresentationOwner(activeSessionId, sessionId);', '')
      .replace('const chatWindowRoute = applyChatWindowOrWave2(session, units);', 'applyChatWindowOrWave2(session, units);')
      .replace(/\s*if \(!CHAT_WINDOW_RAW_AUDIT_ACCEPTED_ROUTES\.has\(chatWindowRoute\)\) \{[\s\S]*?\n\s*\}/, '');
    expect(collectSnapshotHistorySemanticDiagnostics(original)).toEqual([
      SNAPSHOT_HISTORY_OWNER_DIAGNOSTIC,
      SNAPSHOT_HISTORY_ROUTE_DIAGNOSTIC,
    ]);
    const weakened = source.replace(
      'transitionActiveSessionPresentationOwner(activeSessionId, sessionId);',
      '',
    );
    expect(collectSnapshotHistorySemanticDiagnostics(weakened)).toContain(SNAPSHOT_HISTORY_OWNER_DIAGNOSTIC);
  });

  test('owner transition repairs bootstrap and stale owners exactly once without same-owner teardown', () => {
    const transition = extractFunction('function transitionActiveSessionPresentationOwner(');
    const run = (previousSessionId: string, targetSessionId: string, presentationSessionId: string, adapter: unknown) => {
      const destroys: string[] = [];
      const context = vm.createContext({
        chatWindowState: { sessionId: presentationSessionId, adapter },
        destroyChatWindowAdapter: (reason: string) => destroys.push(reason),
      });
      vm.runInContext(`${transition}; globalThis.transition = transitionActiveSessionPresentationOwner;`, context);
      return { changed: context.transition(previousSessionId, targetSessionId), destroys };
    };
    expect(run('', 'session-b', '__no_session__', {})).toEqual({ changed: true, destroys: ['session-switch'] });
    expect(run('session-a', 'session-b', 'session-a', {})).toEqual({ changed: true, destroys: ['session-switch'] });
    expect(run('session-b', 'session-b', 'session-b', {})).toEqual({ changed: false, destroys: [] });
    expect(run('session-b', 'session-b', 'session-a', {})).toEqual({ changed: true, destroys: ['session-switch'] });
    expect(run('', 'session-b', '', null)).toEqual({ changed: false, destroys: [] });
  });

  test('only explicit accepted transaction routes can reach the raw integrity audit', () => {
    const render = extractFunction('function renderFromState()');
    const acceptedStart = source.indexOf('const CHAT_WINDOW_RAW_AUDIT_ACCEPTED_ROUTES');
    const acceptedEnd = source.indexOf(']));', acceptedStart);
    const accepted = source.slice(acceptedStart, acceptedEnd + 3);
    for (const route of [
      'containment-policy-disabled-virtualized', 'outer-virtualized-baseline',
      'window-unavailable-bootstrap', 'window', 'window-recovered',
    ]) expect(accepted).toContain(`'${route}'`);
    for (const route of [
      'window-unavailable-retained', 'window-unavailable-bootstrap-pending',
      'window-corruption-emergency-pending', 'window-recovery-pending',
      'window-correction-retained',
    ]) expect(accepted).not.toContain(`'${route}'`);
    expect(render.indexOf('CHAT_WINDOW_RAW_AUDIT_ACCEPTED_ROUTES.has(chatWindowRoute)'))
      .toBeLessThan(render.indexOf('captureChatWindowRawIntegrityAudit()'));
  });
});

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

function extractCaseBlock(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function executeFunctions(markers: string[], context: Record<string, unknown>) {
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
  const extract = (marker: string) => {
    const endMarker = exactEndMarkers.get(marker);
    if (!endMarker) return extractFunction(marker);
    const start = source.indexOf(marker);
    const end = source.indexOf(endMarker, start + marker.length);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  };
  vm.runInContext(`${markers.map(extract).join('\n')}\nObject.assign(globalThis, { ${exports.join(', ')} });`, sandbox);
  return sandbox as Record<string, any>;
}

function sourceHash(value: string): string {
  return crypto.createHash('sha256').update(value.replace(/\r\n/g, '\n')).digest('hex');
}

function collectB4CGeometryRecords() {
  const createHarness = createRealTransactionHarness({
    execute: executeFunctions,
    makeSpy: () => jest.fn(),
    createAdapter: createTanStackVirtualAdapter,
    planContainment: planChatWindowContainment,
    classifyIntegrity: classifyChatWindowIntegrity,
    safeShellSpec: getSafeShellSpec,
  });
  const units = Array.from({ length: 220 }, (_, index) => ({
    key: `geometry-${index}`, kind: 'greeting', revision: `geometry-revision-${index}`, value: null,
  }));
  const records: any[] = [];
  const tiers = [20, 10, 4] as const;
  const tails = [80, 40, 24] as const;
  const regions = [{ name: 'old', start: 20 }, { name: 'current', start: 160 }] as const;
  for (const overscanTier of tiers) for (const initialTail of tails) {
    for (const direction of ['forward', 'backward'] as const) for (const region of regions) {
      const attempt = records.length + 1;
      const harness = createHarness('', true, { viewportStart: region.start, units });
      const low = overscanTier === 20 ? 7 : overscanTier === 10 ? 3 : 1;
      const high = overscanTier - low;
      const rangePolicy = Object.freeze({
        overscanTier,
        beforeReserve: direction === 'forward' ? low : high,
        afterReserve: direction === 'forward' ? high : low,
        initialTail,
      });
      const sizeAt = (index: number) => 36 + ((index * 7 + attempt * 3) % 6) * 7;
      const offsetAt = (index: number) => {
        let offset = 0;
        for (let cursor = 0; cursor < index; cursor += 1) offset += sizeAt(cursor);
        return offset;
      };
      const bottom = harness.makeNode('', `bottom-${attempt}`);
      harness.chatWindowState.bottomSpacer = bottom;
      harness.chatContainer.appendChild(bottom);
      const originalSpacers = harness.context.updateChatWindowSpacers;
      harness.context.updateChatWindowSpacers = (snapshot: any) => {
        const result = originalSpacers(snapshot);
        const first = snapshot.items[0];
        const last = snapshot.items.at(-1);
        harness.top.style.height = `${Math.max(0, first?.start || 0)}px`;
        bottom.style.height = `${Math.max(0, snapshot.totalSize - (last?.end || 0))}px`;
        harness.chatContainer.appendChild(bottom);
        return result;
      };
      const token = Object.freeze({});
      let armed = true;
      harness.context.consumeChatWindowSyntheticEvidenceRequest = (candidate: any) => {
        if (!armed || candidate !== token) return null;
        armed = false;
        return {
          overscanTier, initialTail,
          forwardReserve: high, backwardReserve: low, attempt,
        };
      };
      const originalBegin = harness.adapter.beginTransaction.bind(harness.adapter);
      harness.adapter.beginTransaction = (...args: any[]) => {
        expect(args[0].rangePolicy).toEqual(rangePolicy);
        const handle = originalBegin(...args);
        const virtualizer = harness.actualConstructions.at(-1);
        const originalItems = virtualizer.getVirtualItems.bind(virtualizer);
        virtualizer.getVirtualItems = () => originalItems().map((item: any) => {
          const size = sizeAt(item.index);
          const start = offsetAt(item.index);
          return { ...item, start, size, end: start + size };
        });
        virtualizer.getTotalSize = () => offsetAt(units.length);
        return handle;
      };
      harness.chatContainer.scrollTop = 13 + attempt * 2;
      const anchorIndex = region.start + 3;
      const pre = {
        anchorOffset: offsetAt(anchorIndex), scrollTop: harness.chatContainer.scrollTop,
        topSpacerHeight: Number.parseFloat(harness.top.style.height) || 0,
        bottomSpacerHeight: Number.parseFloat(bottom.style.height) || 0,
      };
      const accepted = harness.context.applyWindowedKeyedChatReconciliation(harness.canonicalSession, units, [], {
        syntheticEvidenceToken: token, syntheticEvidenceDirection: direction,
      });
      const snapshot = harness.chatWindowState.snapshot;
      const mountedIndexes = snapshot.items.map((item: any) => item.index);
      const acceptedIndexes = accepted.map((unit: any) => units.findIndex((candidate) => candidate.key === unit.key));
      const post = {
        anchorOffset: offsetAt(anchorIndex), scrollTop: harness.chatContainer.scrollTop,
        topSpacerHeight: Number.parseFloat(harness.top.style.height) || 0,
        bottomSpacerHeight: Number.parseFloat(bottom.style.height) || 0,
      };
      records.push({ overscanTier, initialTail, direction, region: region.name, pre, post,
        range: {
          mountedIndexes, acceptedIndexes,
          itemHeights: snapshot.items.map((item: any) => item.end - item.start),
          viewportStart: region.start, viewportEnd: region.start + 11,
          directRootCount: harness.chatContainer.childElementCount,
          topSpacerHeight: post.topSpacerHeight, bottomSpacerHeight: post.bottomSpacerHeight,
        } });
    }
  }
  return records;
}

describe('Wave 3 main-script window contract', () => {
  test('defaults on only with a compatible facade and false is the exact Wave 2 path', () => {
    expect(source).toContain('const TANSTACK_CHAT_WINDOW_ENABLED = window.__ocTanStackChatWindowEnabled !== false;');
    expect(source).toContain("typeof window.__ocRendering?.createTanStackVirtualAdapter === 'function'");
    const coordinator = extractFunction('function renderFromState()');
    expect(coordinator).toContain('applyChatWindowOrWave2(session, units);');
    const route = extractFunction('function applyChatWindowOrWave2(');
    expect(route).toContain('if (!isChatWindowAvailable())');
    expect(route).toContain('applyAcceptedOuterTransactionalBootstrap(session, acceptedUnits, shellRequests, plan);');
    expect(route).toContain('applyTransactionalWindow()');
    expect(coordinator).not.toContain('renderFromStateLegacy');
  });

  test('owns bounded structural spacers and adapter measurement without canonical contamination', () => {
    expect(source).toContain('const CHAT_WINDOW_INITIAL_TAIL = 80;');
    expect(source).toContain('const CHAT_WINDOW_OVERSCAN = 20;');
    expect(source).toContain('const CHAT_WINDOW_MOUNT_LIMIT = 140;');
    expect(source).toContain('const CHAT_WINDOW_DIRECT_CHILD_LIMIT = 146;');
    expect(source).toContain("classifyChatStructuralSurface(topSpacer, 'window:top-spacer'");
    expect(source).toContain("classifyChatStructuralSurface(bottomSpacer, 'window:bottom-spacer'");
    expect(source).toContain('adapterTransaction.observeElement(unit.key, root);');
    expect(source).toContain('chatWindowState.adapter?.invalidateMeasurement?.(targetId);');
    expect(source).toContain('chatWindowState.adapter.setPresentationRevision(targetId');
    expect(source).toContain('const sameMountedRange = snapshot.items.length === chatWindowState.mountedKeys.size');
    expect(source).toContain('window.__ocChatWindowDomBudgetAudit');
    expect(source).toContain('if (budget.descendants > 4000) descendantsAdvisory = true;');
    expect(source).not.toContain('session.virtual');
    expect(source).not.toContain('session.measurement');
  });

  test('destroys on session switch, migrates aliases, preserves keyed anchors, and searches loaded state', () => {
    expect(source).toContain('destroyChatWindowAdapter(\'session-switch\')');
    expect(source).toContain('chatWindowState.adapter?.migrateKey?.(oldKey, newKey);');
    expect(source).toContain('chatWindowState.anchorKey === oldKey');
    expect(source).toContain('sessionSearch.windowTargetKey === oldKey');
    expect(source).toContain('rendering.restoreKeyedScrollAnchor');
    expect(extractFunction('function collectSmartSearchMessages()')).toContain('session.timeline');
    expect(source).toContain('ensureChatWindowKeyMounted(targetKey, \'search\')');
  });

  test('programmatic correction is not user scroll and pinned/unpinned behavior is explicit', () => {
    expect(source).toContain('if (!chatWindowState.programmaticScroll)');
    expect(source).toContain('chatWindowState.activityBelow = true;');
    expect(source).toContain("scheduleRenderFromState('window-range-change')");
    expect(source).toContain('scrollToBottom(true);');
  });
});

const executeCF3Functions = executeFunctions;
describe('CF3 range provenance diagnostics', () => {
  const createDiagnosticHarness = () => {
    const messages: any[] = [];
    const state: any = {
      phase: 'async-core', sync: 'unknown', rangeCount: 0,
      rangeSignatures: new Set(), markerEmitted: false,
    };
    const chatWindowState: any = {
      rendering: false, pendingRangeRender: false, pendingScrollKey: '',
      programmaticScroll: false, acknowledgedRawSnapshot: null,
    };
    const context = executeCF3Functions([
      'function emitCF3RangeDiagnosticMarker(',
      'function runCF3RangeDiagnosticPhase(',
      'function getCF3RangeFirstDifference(',
      'function recordCF3RangeDiagnostic(',
    ], {
      CF3_RANGE_DIAG_MARKER: 'CF3_RANGE_DIAG_V1',
      CF3_RANGE_DIAG_SOURCE_TOKEN: 'cf3-main-range-v1',
      cf3RangeDiagnosticState: state,
      chatWindowState,
      chatContainer: { scrollTop: 17.5 },
      vscode: { postMessage: (message: any) => messages.push(message) },
      Number, String, Set, Object,
    });
    return { context, state, chatWindowState, messages };
  };
  const rawSnapshot = (overrides: any = {}) => ({
    items: [{ key: 'PRIVATE_KEY', index: 7, start: 10.25, end: 30.75, size: 20.5 }],
    totalSize: 100.5,
    ...overrides,
  });
  const acknowledged = (overrides: any = {}) => ({
    items: [{ key: 'PRIVATE_KEY', index: 7, start: 10.25, end: 30.75, size: 20.5 }],
    totalSize: 100.5,
    ...overrides,
  });
  const recordDiagnostic = (harness: any, snapshot = rawSnapshot()) => {
    const ack = harness.chatWindowState.acknowledgedRawSnapshot;
    return harness.context.recordCF3RangeDiagnostic(snapshot, Object.freeze({
      rendering: harness.chatWindowState.rendering === true,
      pendingRangeRender: harness.chatWindowState.pendingRangeRender === true,
      pendingScrollPresent: Boolean(harness.chatWindowState.pendingScrollKey),
      programmaticScroll: harness.chatWindowState.programmaticScroll === true,
      acknowledgedCount: Array.isArray(ack?.items) ? ack.items.length : 0,
      acknowledgedTotalSize: Number.isFinite(ack?.totalSize) ? Number(ack.totalSize) : 0,
      firstDifference: harness.context.getCF3RangeFirstDifference(snapshot, ack),
      scrollTop: 17.5,
    }));
  };

  test('CF3 top-level recorder consumes explicit callback context without DOM-ready closure globals', () => {
    const messages: any[] = [];
    const state: any = {
      phase: 'async-core', sync: 'unknown', rangeCount: 0,
      rangeSignatures: new Set(), markerEmitted: false,
    };
    const context = executeCF3Functions([
      'function getCF3RangeFirstDifference(',
      'function recordCF3RangeDiagnostic(',
    ], {
      cf3RangeDiagnosticState: state,
      vscode: { postMessage: (message: any) => messages.push(message) },
      Number, String, Set, Object,
    });
    const prepare = extractFunction('function prepareUnpublishedChatWindowTransaction(');
    const callbackStart = prepare.indexOf('onRangeChange(snapshot) {');
    expect(callbackStart).toBeGreaterThanOrEqual(0);
    const callbackBrace = prepare.indexOf('{', callbackStart);
    let depth = 0;
    let callbackEnd = -1;
    for (let index = callbackBrace; index < prepare.length; index += 1) {
      if (prepare[index] === '{') depth += 1;
      if (prepare[index] === '}' && --depth === 0) {
        callbackEnd = index + 1;
        break;
      }
    }
    expect(callbackEnd).toBeGreaterThan(callbackBrace);
    const callbackMethod = prepare.slice(callbackStart, callbackEnd);
    vm.runInContext(`(() => {
      const published = true;
      const candidateGeneration = 7;
      const chatWindowGeneration = 7;
      const capturedActiveSessionId = 'session-private';
      const chatContainer = { scrollTop: 17.5 };
      const chatWindowState = {
        sessionId: capturedActiveSessionId,
        rendering: false,
        pendingRangeRender: false,
        pendingScrollKey: '',
        programmaticScroll: false,
        acknowledgedRawSnapshot: {
          items: [{ key: 'PRIVATE_KEY', index: 7, start: 10.25, end: 30.75, size: 20.5 }],
          totalSize: 100.5
        },
        snapshot: null
      };
      const owner = { ${callbackMethod} };
      globalThis.invokeActualRangeCallback = () => owner.onRangeChange({
        items: [{ key: 'PRIVATE_KEY', index: 7, start: 10.25, end: 30.75, size: 20.5 }],
        totalSize: 100.5
      });
      globalThis.readActualRangeCallbackState = () => ({
        snapshotSet: chatWindowState.snapshot !== null,
        pendingRangeRender: chatWindowState.pendingRangeRender
      });
    })();`, context);

    expect(() => {
      for (let count = 1; count <= 21; count += 1) context.invokeActualRangeCallback();
    }).not.toThrow();
    expect(messages).toHaveLength(20);
    expect(context.readActualRangeCallbackState()).toEqual({ snapshotSet: true, pendingRangeRender: false });
    expect(messages[0].payload[1]).toEqual(expect.objectContaining({
      rawCount: 1, acknowledgedCount: 1, firstDifference: 'none', scrollTop: 17.5,
    }));
    expect(JSON.stringify(messages)).not.toMatch(/PRIVATE_KEY|session-private|message|role|content|path|stack|element|snapshot/i);
    expect(() => context.recordCF3RangeDiagnostic(null, null)).not.toThrow();
    expect(messages.at(-1)?.payload[1]).toEqual(expect.objectContaining({
      rendering: false, pendingRangeRender: false, pendingScrollPresent: false,
      programmaticScroll: false, rawCount: 0, rawTotalSize: 0,
      acknowledgedCount: 0, acknowledgedTotalSize: 0,
      firstDifference: 'missing-ack', scrollTop: 0,
    }));
  });

  test('CF3 emits one immutable boot marker with a fixed source token and no runtime provenance data', () => {
    const harness = createDiagnosticHarness();
    harness.context.emitCF3RangeDiagnosticMarker();
    harness.context.emitCF3RangeDiagnosticMarker();
    expect(harness.messages).toEqual([{
      type: 'ui-debug', payload: ['CF3_RANGE_DIAG_V1', { sourceToken: 'cf3-main-range-v1' }],
    }]);
    expect(source).toContain("const CF3_RANGE_DIAG_MARKER = 'CF3_RANGE_DIAG_V1';");
    expect(source).toContain("const CF3_RANGE_DIAG_SOURCE_TOKEN = 'cf3-main-range-v1';");
    expect(source.match(/emitCF3RangeDiagnosticMarker\(\);/g) || []).toHaveLength(1);
    expect(JSON.stringify(harness.messages)).not.toMatch(/path|session|webview|time|content|sourceText/i);
  });

  test('CF3 schema, privacy, unavailable offset, and semantic difference precedence are exact', () => {
    const harness = createDiagnosticHarness();
    const fields = ['phase', 'sync', 'rendering', 'pendingRangeRender', 'pendingScrollPresent',
      'programmaticScroll', 'rawCount', 'rawTotalSize', 'acknowledgedCount', 'acknowledgedTotalSize',
      'firstDifference', 'scrollTop', 'adapterOffsetAvailable', 'adapterOffset'];
    const cases: Array<[string, any]> = [
      ['missing-ack', null],
      ['count', acknowledged({ items: [] })],
      ['key', acknowledged({ items: [{ ...acknowledged().items[0], key: 'OTHER_PRIVATE_KEY' }] })],
      ['index', acknowledged({ items: [{ ...acknowledged().items[0], index: 8 }] })],
      ['start', acknowledged({ items: [{ ...acknowledged().items[0], start: 11 }] })],
      ['end', acknowledged({ items: [{ ...acknowledged().items[0], end: 31 }] })],
      ['size', acknowledged({ items: [{ ...acknowledged().items[0], size: 21 }] })],
      ['totalSize', acknowledged({ totalSize: 101 })],
      ['none', acknowledged()],
    ];
    for (const [expected, ack] of cases) {
      expect(harness.context.getCF3RangeFirstDifference(rawSnapshot(), ack)).toBe(expected);
    }
    harness.chatWindowState.acknowledgedRawSnapshot = acknowledged();
    recordDiagnostic(harness);
    const message = harness.messages[0];
    expect(message.type).toBe('ui-debug');
    expect(message.payload[0]).toBe('[WV][CF3_RANGE_DIAG]');
    expect(Object.keys(message.payload[1]).sort()).toEqual([...fields].sort());
    expect(message.payload[1]).toEqual({
      phase: 'async-core', sync: 'unknown', rendering: false, pendingRangeRender: false,
      pendingScrollPresent: false, programmaticScroll: false,
      rawCount: 1, rawTotalSize: 100.5, acknowledgedCount: 1, acknowledgedTotalSize: 100.5,
      firstDifference: 'none', scrollTop: 17.5,
      adapterOffsetAvailable: false, adapterOffset: 'unavailable',
    });
    expect(JSON.stringify(message)).not.toMatch(/PRIVATE_KEY|OTHER_PRIVATE_KEY|message|role|content|path|stack|element|snapshot/i);
  });

  test('CF3 sampler emits first 20, every 50th, and first finite signature only', () => {
    const harness = createDiagnosticHarness();
    for (let count = 1; count <= 20; count += 1) recordDiagnostic(harness);
    expect(harness.messages).toHaveLength(20);
    harness.chatWindowState.acknowledgedRawSnapshot = acknowledged();
    recordDiagnostic(harness); // first async-core/unknown/none signature
    expect(harness.messages).toHaveLength(21);
    for (let count = 22; count <= 49; count += 1) recordDiagnostic(harness);
    expect(harness.messages).toHaveLength(21);
    recordDiagnostic(harness);
    expect(harness.messages).toHaveLength(22);
    for (let count = 51; count <= 99; count += 1) recordDiagnostic(harness);
    expect(harness.messages).toHaveLength(22);
    recordDiagnostic(harness);
    expect(harness.messages).toHaveLength(23);
    harness.state.sync = false;
    recordDiagnostic(harness);
    expect(harness.messages).toHaveLength(24);
    recordDiagnostic(harness);
    expect(harness.messages).toHaveLength(24);
  });

  test('CF3 lexical phases reset on return and throw while preserving operation behavior and call count', () => {
    const harness = createDiagnosticHarness();
    const calls: string[] = [];
    const value = harness.context.runCF3RangeDiagnosticPhase('initial-create', () => {
      calls.push('create');
      recordDiagnostic(harness);
      return Object.freeze({ accepted: true });
    });
    expect(value).toEqual({ accepted: true });
    expect(calls).toEqual(['create']);
    expect(harness.messages[0].payload[1]).toEqual(expect.objectContaining({ phase: 'initial-create', sync: true }));
    expect(harness.state).toEqual(expect.objectContaining({ phase: 'async-core', sync: 'unknown' }));
    expect(() => harness.context.runCF3RangeDiagnosticPhase('transaction-finalize', () => {
      calls.push('finalize');
      throw new Error('same-error');
    })).toThrow('same-error');
    expect(calls).toEqual(['create', 'finalize']);
    expect(harness.state).toEqual(expect.objectContaining({ phase: 'async-core', sync: 'unknown' }));
    const windowed = extractFunction('function applyWindowedKeyedChatReconciliation(');
    expect(windowed).toContain("cf3RunPhase('transaction-finalize', () => adapterTransaction.finalizeCommit())");
    const ensure = extractFunction('function ensureChatWindowAdapter(');
    expect(ensure).toContain('chatWindowState.adapter.update({ keys, kinds, presentationRevisions, keepMountedKeys });');
    expect(ensure).not.toContain('runCF3RangeDiagnosticPhase');
    expect(source).toContain("'initial-create', 'established-update', 'transaction-finalize', 'async-core'");
    const prepare = extractFunction('function prepareUnpublishedChatWindowTransaction(');
    expect(prepare).toContain("cf3RunPhase('initial-create', () => rendering.createTanStackVirtualAdapter({");
    const diagnosticOwner = [
      extractFunction('function emitCF3RangeDiagnosticMarker('),
      extractFunction('function runCF3RangeDiagnosticPhase('),
      extractFunction('function getCF3RangeFirstDifference('),
      extractFunction('function recordCF3RangeDiagnostic('),
    ].join('\n');
    expect(diagnosticOwner).not.toMatch(/scheduleRenderFromState|scrollToBottom|beginTransaction|finalizeCommit|\.update\(/);
    expect(source.match(/typeof recordCF3RangeDiagnostic === 'function'\) recordCF3RangeDiagnostic\(snapshot, Object\.freeze\(\{/g) || []).toHaveLength(1);
  });
});

describe('B4S recovered anonymous source oracle', () => {
  test('primary send is owned directly by one anonymous click listener with no named delegation', () => {
    expect(recoveredSource).not.toContain('function handlePrimarySendClick() {');
    expect(recoveredSource.match(/handlePrimarySendClick\(\);/g) || []).toHaveLength(0);
    expect(recoveredSource.match(/sendBtn\.addEventListener\('click', \(\) => \{\s*if \(appendInputMode\) \{/g) || []).toHaveLength(1);
    expect(recoveredSource.match(/sendBtn\.addEventListener\('click'/g) || []).toHaveLength(1);
  });

  test('chat scroll is owned directly by one passive anonymous listener with no named delegation', () => {
    expect(recoveredSource).not.toContain('function handleChatContainerScroll() {');
    expect(recoveredSource.match(/handleChatContainerScroll\(\);/g) || []).toHaveLength(0);
    expect(recoveredSource.match(/chatContainer\.addEventListener\('scroll', \(\) => \{\s*if \(!chatWindowState\.programmaticScroll\) \{/g) || []).toHaveLength(1);
    expect(recoveredSource.match(/chatContainer\.addEventListener\('scroll'[\s\S]*?\}, \{ passive: true \}\);/g) || []).toHaveLength(1);
  });

  test('sessionId switch case owns the route body and break directly with no named delegation', () => {
    expect(recoveredSource).not.toContain('function handleSessionIdMessage(message) {');
    expect(recoveredSource.match(/handleSessionIdMessage\(message\);/g) || []).toHaveLength(0);
    expect(recoveredSource.match(/case 'sessionId': \{\s*const route = resolveEventSessionId\(message, 'sessionId'\);/g) || []).toHaveLength(1);
    expect(recoveredSource.match(/case 'sessionId': \{[\s\S]*?refreshSendButtonStateAfterSessionSwitch\(\);\s*break;\s*\}/g) || []).toHaveLength(1);
  });

  test('assigned alias lambda owns migration and boolean returns directly with no named delegation', () => {
    expect(recoveredSource).not.toContain('function applyKeyedChatPresentationAliasMigration(oldKey, newKey, sessionId) {');
    expect(recoveredSource.match(/applyKeyedChatPresentationAliasMigration\(oldKey, newKey, sessionId\);/g) || []).toHaveLength(0);
    expect(recoveredSource.match(/rekeyKeyedChatPresentation = \(oldKey, newKey, sessionId\) => \{\s*if \(!KEYED_CHAT_RECONCILE_ENABLED/g) || []).toHaveLength(1);
    expect(recoveredSource.match(/rekeyKeyedChatPresentation = \(oldKey, newKey, sessionId\) => \{[\s\S]*?return true;\s*\};/g) || []).toHaveLength(1);
  });
});

describe('B4S-R3 recovered anonymous owner behavior matrices', () => {
  const extractOwnedBlock = (marker: string, ownerSource = source) => {
    const start = ownerSource.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const brace = ownerSource.indexOf('{', start + marker.length);
    let depth = 0;
    for (let index = brace; index < ownerSource.length; index += 1) {
      if (ownerSource[index] === '{') depth += 1;
      if (ownerSource[index] === '}' && --depth === 0) {
        return { slice: ownerSource.slice(start, index + 1), body: ownerSource.slice(brace + 1, index) };
      }
    }
    throw new Error(`Unclosed recovered owner ${marker}`);
  };
  const executeRecoveredFunction = (name: string, args: string, body: string, context: Record<string, unknown>) => {
    const sandbox = vm.createContext({ ...context });
    vm.runInContext(`function ${name}(${args}) {${body}}; globalThis.__owner = ${name};`, sandbox);
    return sandbox as Record<string, any>;
  };
  const ownerSlices = {
    primarySend: extractOwnedBlock("sendBtn.addEventListener('click', () =>", recoveredSource).slice,
    chatScroll: extractOwnedBlock("chatContainer.addEventListener('scroll', () =>", recoveredSource).slice,
    sessionId: extractOwnedBlock("case 'sessionId':", recoveredSource).slice,
    aliasMigration: extractOwnedBlock('rekeyKeyedChatPresentation = (oldKey, newKey, sessionId) =>', recoveredSource).slice,
  };
  const normalizeRelocatedBody = (body: string, sessionCase = false) => {
    const lines = body.replace(/\r\n/g, '\n').split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines.at(-1)?.trim()) lines.pop();
    const margin = Math.min(...lines.filter((line) => line.trim()).map((line) => line.match(/^\s*/)?.[0].length || 0));
    let normalized = lines.map((line) => line.slice(margin)).join('\n');
    if (sessionCase) {
      let breakIndex = 0;
      normalized = normalized.replace(/\bbreak;/g, () => (++breakIndex <= 2 ? 'return;' : ''));
      normalized = normalized.trimEnd();
    }
    return normalized;
  };

  test('unchanged named bodies remain byte-equivalent to the recovered anonymous oracle', () => {
    const recoveredBodies = {
      primarySend: extractOwnedBlock("sendBtn.addEventListener('click', () =>", recoveredSource).body,
      chatScroll: extractOwnedBlock("chatContainer.addEventListener('scroll', () =>", recoveredSource).body,
      sessionId: extractOwnedBlock("case 'sessionId':", recoveredSource).body,
      aliasMigration: extractOwnedBlock('rekeyKeyedChatPresentation = (oldKey, newKey, sessionId) =>', recoveredSource).body,
    };
    const namedBodies = {
      primarySend: extractOwnedBlock('function handlePrimarySendClick()').body,
      chatScroll: extractOwnedBlock('function handleChatContainerScroll()').body,
      sessionId: extractOwnedBlock('function handleSessionIdMessage(message)').body,
      aliasMigration: extractOwnedBlock('function applyKeyedChatPresentationAliasMigration(oldKey, newKey, sessionId)').body,
    };
    const hashes: Record<string, string> = {};
    for (const key of ['primarySend', 'chatScroll', 'aliasMigration'] as const) {
      const recovered = normalizeRelocatedBody(recoveredBodies[key]);
      const named = normalizeRelocatedBody(namedBodies[key]);
      expect(named).toBe(recovered);
      hashes[key] = sourceHash(named);
    }
    expect(hashes).toEqual({
      primarySend: '07055fcfd53bb336cbb82f742475f19dbd9392ea9efd809679dd2b5016c02b18',
      chatScroll: 'e038125d4bf073302c649836a608ef6bd87f7a24b2b79520065ec90f80874109',
      aliasMigration: '6b108292ce3305c164a1bec10689b6fdcdd06cd310cc921ef5bee351f028a2ff',
    });
  });

  test('recovered anonymous source slices retain reviewed hashes and singular ownership', () => {
    expect(Object.fromEntries(Object.entries(ownerSlices).map(([key, value]) => [key, sourceHash(value)]))).toEqual({
      primarySend: '018472c1273dbff9a4840ce20070125a5b0d7eb906910d8aadefa82a659edf9c',
      chatScroll: '59a0fc74715e1dd12af71ff36fc24a411967b9b08f7dc62620fa008353d7e163',
      sessionId: '351876861f7dfcd8e32bee1a1412b224ad057d3ef1488383af93362d24c29e31',
      aliasMigration: '091cfc9cdfd26c13527c4aeaef6b6e0aa60205d29592479aee99c0f641fcc9c3',
    });
    expect(source.match(/sendBtn\.addEventListener\('click'/g) || []).toHaveLength(1);
    expect(source.match(/chatContainer\.addEventListener\('scroll'/g) || []).toHaveLength(1);
    expect(source.match(/case 'sessionId':/g) || []).toHaveLength(1);
    expect(source.match(/rekeyKeyedChatPresentation = \(oldKey, newKey, sessionId\) =>/g) || []).toHaveLength(1);
  });

  test('scroll matrix preserves programmatic, pinned, and unpinned ordered effects', () => {
    const body = extractOwnedBlock('function handleChatContainerScroll()').body;
    const run = (programmaticScroll: boolean, nearBottom: boolean) => {
      const trace: string[] = [];
      const context = executeRecoveredFunction('owner', '', body, {
        chatWindowState: { programmaticScroll }, autoScrollPinnedToBottom: false, chatContainer: {},
        isNearBottom: () => { trace.push('isNearBottom'); return nearBottom; },
        captureChatWindowAnchor: () => trace.push('captureAnchor'),
        hideQuoteSelectionButton: () => trace.push('hideQuote'),
      });
      const returned = context.__owner();
      return { trace, returned, pinned: context.autoScrollPinnedToBottom };
    };
    expect(run(true, false)).toEqual({ trace: ['hideQuote'], returned: undefined, pinned: false });
    expect(run(false, true)).toEqual({ trace: ['isNearBottom', 'hideQuote'], returned: undefined, pinned: true });
    expect(run(false, false)).toEqual({ trace: ['isNearBottom', 'captureAnchor', 'hideQuote'], returned: undefined, pinned: false });
    expect(source.match(/chatContainer\.addEventListener\('scroll'[\s\S]*?\}, \{ passive: true \}\);/g) || []).toHaveLength(1);
    expect(ownerSlices.chatScroll).not.toContain('scheduleRenderFromState');
  });

  test('sessionId matrix preserves invalid, background, same, bootstrap, and switching order', () => {
    const body = extractOwnedBlock('function handleSessionIdMessage(message)').body;
    const run = (overrides: Record<string, any>) => {
      const trace: string[] = [];
      const sessions = new Map([['next', { thinkingId: 'tmp-next' }], ['same', { thinkingId: 'tmp-same' }]]);
      const sandbox = vm.createContext({
        activeSessionId: 'same', pendingExplicitSessionSelectionId: '', isSwitchingSession: false,
        pendingUiPrompts: [],
        resolveEventSessionId: (message: any) => message.route,
        vscode: { postMessage: (message: any) => trace.push(`post:${message.type}`) },
        logBackgroundStateUpdate: () => trace.push('background'), refreshSendButtonState: () => trace.push('refresh'),
        clearAppendInputForSessionChange: () => trace.push('clearAppend'), renderHeaderUsage: () => trace.push('header'),
        destroyChatWindowAdapter: (reason: string) => trace.push(`destroy:${reason}`),
        transitionActiveSessionPresentationOwner: (previous: string, target: string) => {
          trace.push(`transition:${previous || 'none'}->${target}`);
          if (previous && previous !== target) trace.push('destroy:session-switch');
        },
        clearQuestionOverlay: (reason: string) => trace.push(`question:${reason}`),
        clearPermissionOverlay: (reason: string) => trace.push(`permission:${reason}`),
        closeStallCard: () => trace.push('stall'), setSystemNotice: () => trace.push('notice'),
        applyPromptToSession: () => trace.push('prompt'), getSessionState: (id: string) => sessions.get(id),
        window: { __oc: { renderFromState: () => trace.push('render') } },
        logSessionState: () => trace.push('logSession'),
        refreshSendButtonStateAfterSessionSwitch: () => trace.push('refreshAfter'),
        ...overrides,
      });
      vm.runInContext(`function owner(message) {${body}}; globalThis.__owner = owner;`, sandbox);
      const returned = (sandbox as any).__owner({ type: 'sessionId', route: overrides.route });
      return { trace, returned, activeSessionId: (sandbox as any).activeSessionId,
        pendingExplicit: (sandbox as any).pendingExplicitSessionSelectionId,
        switching: (sandbox as any).isSwitchingSession, pending: (sandbox as any).pendingUiPrompts.length };
    };
    expect(run({ route: null })).toEqual({ trace: [], returned: undefined, activeSessionId: 'same', pendingExplicit: '', switching: false, pending: 0 });
    expect(run({ route: { sessionId: 'background' } }).trace).toEqual(['post:ui-debug', 'background', 'refresh']);
    expect(run({ route: { sessionId: 'same' } }).trace).toEqual(['transition:same->same', 'clearAppend', 'header', 'refreshAfter']);
    expect(run({ route: { sessionId: 'next' }, activeSessionId: '', pendingUiPrompts: [] }).trace)
      .toEqual(['transition:none->next', 'clearAppend', 'header', 'refreshAfter']);
    const switched = run({ route: { sessionId: 'next' }, activeSessionId: 'same', pendingExplicitSessionSelectionId: 'next',
      isSwitchingSession: true, pendingUiPrompts: [{ id: 1 }] });
    expect(switched.trace).toEqual(['transition:same->next', 'destroy:session-switch', 'clearAppend', 'header', 'question:session-change',
      'permission:session-change', 'stall', 'notice', 'prompt', 'post:registerTmpKey', 'render', 'logSession', 'refreshAfter']);
    expect(switched).toMatchObject({ returned: undefined, activeSessionId: 'next', pendingExplicit: '', switching: false, pending: 0 });
  });

  test('alias matrix preserves no-op, collision, migration, same-key, boolean, and stable identity behavior', () => {
    const body = extractOwnedBlock('function applyKeyedChatPresentationAliasMigration(oldKey, newKey, sessionId)').body;
    const run = (kind: string) => {
      const trace: string[] = [];
      const messageRoot = { dataset: { messageId: 'old' } };
      const oldRoot: any = { dataset: { renderUnitKey: 'old' }, matches: () => false, querySelector: () => messageRoot };
      const newRoot: any = { dataset: { renderUnitKey: 'new' }, matches: () => false, querySelector: () => null };
      const roots = new Map<string, any>(kind === 'cached-only' ? [['old', oldRoot]] : []);
      const state = { sessionId: kind === 'mismatch' ? 'other' : 's', items: [{ key: 'old' }, { key: 'keep' }], roots };
      const sandbox = vm.createContext({
        KEYED_CHAT_RECONCILE_ENABLED: kind !== 'disabled', keyedChatReconcileState: state,
        keyedChatFailedSessionId: '', activeSessionId: 'active',
        keyedRootForKey: (key: string) => {
          trace.push(`root:${key}`);
          if (kind === 'collision') return key === 'old' ? oldRoot : newRoot;
          if (kind === 'success' || kind === 'same') return key === 'old' ? oldRoot : null;
          return null;
        },
        chatWindowState: { adapter: { migrateKey: (oldKey: string, newKey: string) => trace.push(`migrate:${oldKey}:${newKey}`) }, anchorKey: 'old' },
        sessionSearch: { windowTargetKey: 'old', fullMatchKeys: ['old', 'keep'] }, Map,
      });
      vm.runInContext(`let assigned; assigned = (oldKey, newKey, sessionId) => {${body}}; globalThis.__owner = assigned;`, sandbox);
      const identity = (sandbox as any).__owner;
      const returned = identity('old', kind === 'same' ? 'old' : 'new', 's');
      return { trace, returned, stableIdentity: identity === (sandbox as any).__owner, arity: identity.length,
        state: (sandbox as any).keyedChatReconcileState, failed: (sandbox as any).keyedChatFailedSessionId,
        oldRoot, messageRoot, chatWindowState: (sandbox as any).chatWindowState, search: (sandbox as any).sessionSearch };
    };
    expect(run('disabled')).toMatchObject({ trace: [], returned: true, stableIdentity: true, arity: 3 });
    expect(run('mismatch')).toMatchObject({ trace: [], returned: true, stableIdentity: true, arity: 3 });
    const collision = run('collision');
    expect(collision).toMatchObject({ trace: ['root:old', 'root:new'], returned: false, failed: 's' });
    expect(collision.state).toMatchObject({ sessionId: '', items: [] });
    const success = run('success');
    expect(success.trace).toEqual(['root:old', 'root:new', 'migrate:old:new']);
    expect(success).toMatchObject({ returned: true, stableIdentity: true, arity: 3 });
    expect(success.oldRoot.dataset.renderUnitKey).toBe('new');
    expect(success.messageRoot.dataset.messageId).toBe('new');
    expect(success.state.items.map((item: any) => item.key)).toEqual(['new', 'keep']);
    expect(success.chatWindowState.anchorKey).toBe('new');
    expect(success.search).toEqual({ windowTargetKey: 'new', fullMatchKeys: ['new', 'keep'] });
    expect(run('same')).toMatchObject({ returned: true, stableIdentity: true, arity: 3 });
    expect(run('cached-only')).toMatchObject({ returned: true, stableIdentity: true, arity: 3 });
  });

  test('primary-send guard matrix preserves append, cancel, disabled, pending, and empty returns', () => {
    const body = extractOwnedBlock('function handlePrimarySendClick()').body;
    const run = (overrides: Record<string, any>) => {
      const trace: string[] = [];
      const session = { activeTurnOpId: 'op-active', segmentsByNoticeKey: new Map(), hiddenSet: new Set(), thinkingId: 'tmp', inputDraft: 'draft' };
      const sandbox = executeRecoveredFunction('owner', '', body, {
        appendInputMode: null, canSendAppendFromInput: () => true, updateSendGate: () => trace.push('gate'),
        submitAppendMessage: () => { trace.push('append'); return true; }, input: { value: '' },
        exitAppendInputMode: () => trace.push('exitAppend'), isActiveSessionBusy: () => false,
        activeSessionId: 's', cancelLocalTurn: () => trace.push('cancelLocal'),
        getSessionState: () => session, vscode: { postMessage: (message: any) => trace.push(`post:${message.type}`) },
        baselinePreparing: false, isSendBlockedByPendingState: () => false,
        logSegmentState: () => trace.push('logSegment'), selectedMode: 'plan', pendingContextItems: [], pendingFileRefs: [], attachments: [],
        isImageAttachment: () => false, Date: { now: () => 100 }, messageCounter: 0,
        setBusy: () => trace.push('busy'), isSwitchingSession: false, pendingUiPrompts: [],
        applyPromptToSession: () => ({ userAppendFastPathApplied: false }),
        countUserMessageAppendFastPathResult: () => trace.push('fastPath'),
        window: { __oc: { renderFromState: () => trace.push('render') } }, scrollToBottom: () => trace.push('scroll'),
        logSessionState: () => trace.push('logSession'), renderAttachments: () => trace.push('renderAttachments'),
        renderContextTokens: () => trace.push('renderContext'), closeFileMentionList: () => trace.push('closeMention'),
        ...overrides,
      });
      return { trace, returned: sandbox.__owner(), input: sandbox.input.value, attachments: sandbox.attachments,
        contextCount: sandbox.pendingContextItems.length, fileCount: sandbox.pendingFileRefs.length };
    };
    expect(run({ appendInputMode: { sessionId: 's', rootUserKey: 'root' }, input: { value: 'append' } }))
      .toMatchObject({ trace: ['append', 'exitAppend'], returned: undefined });
    expect(run({ appendInputMode: { sessionId: 's', rootUserKey: 'root' }, canSendAppendFromInput: () => false }))
      .toMatchObject({ trace: ['gate'], returned: undefined });
    expect(run({ isActiveSessionBusy: () => true })).toMatchObject({ trace: ['cancelLocal', 'post:cancel'], returned: undefined });
    expect(run({ baselinePreparing: true })).toMatchObject({ trace: ['gate'], returned: undefined });
    expect(run({ isSendBlockedByPendingState: () => true })).toMatchObject({ trace: ['gate'], returned: undefined });
    expect(run({ input: { value: '   ' } })).toMatchObject({
      trace: ['logSegment', 'post:ui-debug', 'post:ui-debug'], returned: undefined,
    });
  });

  test('primary-send normal active and bootstrap matrix preserves transport/render/cleanup order', () => {
    const body = extractOwnedBlock('function handlePrimarySendClick()').body;
    const run = (activeSessionId: string) => {
      const trace: string[] = [];
      const session = { activeTurnOpId: null, segmentsByNoticeKey: new Map(), hiddenSet: new Set(), thinkingId: 'tmp', inputDraft: 'draft' };
      const sandbox = executeRecoveredFunction('owner', '', body, {
        appendInputMode: null, canSendAppendFromInput: () => true, updateSendGate: () => trace.push('gate'),
        submitAppendMessage: () => false, input: { value: 'hello' }, exitAppendInputMode: () => undefined,
        isActiveSessionBusy: () => false, activeSessionId, cancelLocalTurn: () => undefined,
        getSessionState: () => session, vscode: { postMessage: (message: any) => trace.push(`post:${message.type}`) },
        baselinePreparing: false, isSendBlockedByPendingState: () => false, logSegmentState: () => trace.push('logSegment'),
        selectedMode: 'plan', pendingContextItems: [], pendingFileRefs: [], attachments: [], isImageAttachment: () => false,
        Date: { now: () => 100 }, messageCounter: 0, setBusy: () => trace.push('busy'), isSwitchingSession: false,
        pendingUiPrompts: [], applyPromptToSession: () => { trace.push('prompt'); return { userAppendFastPathApplied: false }; },
        countUserMessageAppendFastPathResult: () => trace.push('fastPath'),
        window: { __oc: { renderFromState: () => trace.push('render') } }, scrollToBottom: () => trace.push('scroll'),
        logSessionState: () => trace.push('logSession'), renderAttachments: () => trace.push('renderAttachments'),
        renderContextTokens: () => trace.push('renderContext'), closeFileMentionList: () => trace.push('closeMention'),
      });
      const returned = sandbox.__owner();
      return { trace, returned, queued: sandbox.pendingUiPrompts.length, switching: sandbox.isSwitchingSession,
        input: sandbox.input.value, draft: session.inputDraft };
    };
    expect(run('s')).toEqual({
      trace: ['logSegment', 'post:ui-debug', 'post:ui-debug', 'busy', 'prompt', 'post:registerTmpKey', 'render', 'scroll',
        'logSession', 'post:ui-debug', 'post:ui-debug', 'post:sendMessage', 'renderAttachments', 'renderContext', 'closeMention'],
      returned: undefined, queued: 0, switching: false, input: '', draft: '',
    });
    expect(run('')).toEqual({
      trace: ['logSegment', 'post:ui-debug', 'post:ui-debug', 'busy', 'post:ui-debug', 'post:sendMessage',
        'renderAttachments', 'renderContext', 'closeMention'],
      returned: undefined, queued: 1, switching: true, input: '', draft: '',
    });
    expect(ownerSlices.primarySend).not.toContain('scheduleRenderFromState');
  });
});

describe('B4S-E1 named owner extraction target', () => {
  test('primary send delegates once to handlePrimarySendClick', () => {
    expect(source).toContain('function handlePrimarySendClick() {');
    expect(source.match(/sendBtn\.addEventListener\('click', \(\) => \{\s*handlePrimarySendClick\(\);\s*\}\);/g) || []).toHaveLength(1);
    expect(source.match(/handlePrimarySendClick\(\);/g) || []).toHaveLength(1);
  });
  test('passive scroll delegates once to handleChatContainerScroll', () => {
    expect(source).toContain('function handleChatContainerScroll() {');
    expect(source.match(/chatContainer\.addEventListener\('scroll', \(\) => \{\s*handleChatContainerScroll\(\);\s*\}, \{ passive: true \}\);/g) || []).toHaveLength(1);
    expect(source.match(/handleChatContainerScroll\(\);/g) || []).toHaveLength(1);
  });
  test('sessionId case delegates once with message and retains one break', () => {
    expect(source).toContain('function handleSessionIdMessage(message) {');
    expect(source.match(/case 'sessionId': \{\s*handleSessionIdMessage\(message\);\s*break;\s*\}/g) || []).toHaveLength(1);
    expect(source.match(/handleSessionIdMessage\(message\);/g) || []).toHaveLength(1);
  });
  test('assigned alias delegates once and returns the named boolean result', () => {
    expect(source).toContain('function applyKeyedChatPresentationAliasMigration(oldKey, newKey, sessionId) {');
    expect(source.match(/rekeyKeyedChatPresentation = \(oldKey, newKey, sessionId\) => \{\s*return applyKeyedChatPresentationAliasMigration\(oldKey, newKey, sessionId\);\s*\};/g) || []).toHaveLength(1);
    expect(source.match(/applyKeyedChatPresentationAliasMigration\(oldKey, newKey, sessionId\);/g) || []).toHaveLength(1);
  });
});

describe('B4S-E4 named owner mutation rejection', () => {
  const extractCandidateBlock = (candidate: string, marker: string) => {
    const start = candidate.indexOf(marker);
    if (start < 0) return '';
    const brace = candidate.indexOf('{', start + marker.length);
    let depth = 0;
    for (let index = brace; index < candidate.length; index += 1) {
      if (candidate[index] === '{') depth += 1;
      if (candidate[index] === '}' && --depth === 0) return candidate.slice(start, index + 1);
    }
    return '';
  };
  const validate = (candidate: string) => {
    const errors: string[] = [];
    const countMatch = (pattern: RegExp) => candidate.match(pattern)?.length || 0;
    if (!candidate.includes('function handlePrimarySendClick() {')) errors.push('signature:primary');
    if (!candidate.includes('function handleChatContainerScroll() {')) errors.push('signature:scroll');
    if (!candidate.includes('function handleSessionIdMessage(message) {')) errors.push('signature:session');
    if (!candidate.includes('function applyKeyedChatPresentationAliasMigration(oldKey, newKey, sessionId) {')) errors.push('signature:alias');
    if (countMatch(/handlePrimarySendClick\(\);/g) !== 1) errors.push('delegation:primary');
    if (countMatch(/handleChatContainerScroll\(\);/g) !== 1) errors.push('delegation:scroll');
    if (countMatch(/handleSessionIdMessage\(message\);/g) !== 1) errors.push('delegation:session');
    if (countMatch(/applyKeyedChatPresentationAliasMigration\(oldKey, newKey, sessionId\);/g) !== 1) errors.push('delegation:alias');
    if (!/chatContainer\.addEventListener\('scroll', \(\) => \{\s*handleChatContainerScroll\(\);\s*\}, \{ passive: true \}\);/.test(candidate)) errors.push('listener:passive');
    if (!/case 'sessionId': \{\s*handleSessionIdMessage\(message\);\s*break;\s*\}/.test(candidate)) errors.push('return-break:session');
    const sessionBody = extractCandidateBlock(candidate, 'function handleSessionIdMessage(message)');
    if (!sessionBody.includes('if (!sessionId) return;')) errors.push('return:session');
    if (!sessionBody.includes('transitionActiveSessionPresentationOwner(prevSessionId, sessionId);')) errors.push('transition:session');
    if (!/rekeyKeyedChatPresentation = \(oldKey, newKey, sessionId\) => \{\s*return applyKeyedChatPresentationAliasMigration\(oldKey, newKey, sessionId\);\s*\};/.test(candidate)) errors.push('assignment:alias-boolean');
    const frozen = [
      ['body:primary', 'function handlePrimarySendClick()', 'a0bb89397aa6485dd33161caf3ff4ca6de14b3a616f03b6259683fb4143c05c7'],
      ['body:scroll', 'function handleChatContainerScroll()', 'e6a7942c8f45d2b90699bc908b19a5d949cd7d69b89457fbb2cc9ba64f355241'],
      ['body:alias', 'function applyKeyedChatPresentationAliasMigration(', '88cf3b9f39f17f1c4df3caa8c37b11a1d956ee7e01ac2e962fff2e62f51e3d86'],
    ];
    for (const [label, marker, hash] of frozen) if (sourceHash(extractCandidateBlock(candidate, marker)) !== hash) errors.push(label);
    const scrollBody = extractCandidateBlock(candidate, 'function handleChatContainerScroll()');
    if (scrollBody.includes('scheduleRenderFromState(')) errors.push('forbidden:scheduler');
    if (scrollBody.includes('vscode.postMessage(')) errors.push('forbidden:transport');
    if (scrollBody.includes('activeSessionId =')) errors.push('forbidden:canonical');
    return errors;
  };

  test('accepted named source satisfies every narrow guard', () => expect(validate(source)).toEqual([]));
  test.each([
    ['duplicate delegation', (s: string) => s.replace('handlePrimarySendClick();', 'handlePrimarySendClick();\n        handlePrimarySendClick();'), 'delegation:primary'],
    ['removed delegation', (s: string) => s.replace('handlePrimarySendClick();', ''), 'delegation:primary'],
    ['passive option', (s: string) => s.replace('}, { passive: true });', '});'), 'listener:passive'],
    ['side-effect order', (s: string) => s.replace('if (!autoScrollPinnedToBottom) captureChatWindowAnchor();', 'captureChatWindowAnchor();\n            if (!autoScrollPinnedToBottom) {}'), 'body:scroll'],
    ['return semantics', (s: string) => s.replace("const sessionId = route?.sessionId || null;\n        if (!sessionId) return;", "const sessionId = route?.sessionId || null;\n        if (!sessionId) break;"), 'return:session'],
    ['session transition', (s: string) => s.replace('transitionActiveSessionPresentationOwner(prevSessionId, sessionId);', ''), 'transition:session'],
    ['switch break', (s: string) => s.replace("case 'sessionId': {\n                handleSessionIdMessage(message);\n                break;", "case 'sessionId': {\n                handleSessionIdMessage(message);"), 'return-break:session'],
    ['delegation argument', (s: string) => s.replace('handleSessionIdMessage(message);', 'handleSessionIdMessage({ ...message });'), 'delegation:session'],
    ['closure owner parameter', (s: string) => s.replace('function handlePrimarySendClick() {', 'function handlePrimarySendClick(input) {'), 'signature:primary'],
    ['alias boolean return', (s: string) => s.replace('return applyKeyedChatPresentationAliasMigration(oldKey, newKey, sessionId);', 'applyKeyedChatPresentationAliasMigration(oldKey, newKey, sessionId);'), 'assignment:alias-boolean'],
    ['alias assignment arguments', (s: string) => s.replace('rekeyKeyedChatPresentation = (oldKey, newKey, sessionId) =>', 'rekeyKeyedChatPresentation = (oldKey, newKey) =>'), 'assignment:alias-boolean'],
    ['scheduler addition', (s: string) => s.replace('function handleChatContainerScroll() {', "function handleChatContainerScroll() {\n        scheduleRenderFromState('mutation');"), 'forbidden:scheduler'],
    ['transport addition', (s: string) => s.replace('function handleChatContainerScroll() {', "function handleChatContainerScroll() {\n        vscode.postMessage({ type: 'mutation' });"), 'forbidden:transport'],
    ['canonical addition', (s: string) => s.replace('function handleChatContainerScroll() {', "function handleChatContainerScroll() {\n        activeSessionId = 'mutation';"), 'forbidden:canonical'],
  ])('rejects %s mutation at its specific guard', (_name, mutate, expected) => {
    expect(validate((mutate as (value: string) => string)(source))).toContain(expected);
  });
});

describe('B4-A boot-captured inert synthetic evidence capability', () => {
  test('captures the accepted B3 synthetic condition exactly once and conditionally exposes one hook', () => {
    expect(source).toContain('const B4_SYNTHETIC_EVIDENCE_BOOT_ACCEPTED = window.__ocChatWindowAdaptiveShadowTestConfig?.syntheticEnvironment === true;');
    expect(source).toContain("Object.defineProperty(window, '__ocChatWindowAdaptiveEvidence', {");
    expect(source.match(/B4_SYNTHETIC_EVIDENCE_BOOT_ACCEPTED =/g) || []).toHaveLength(1);
  });

  test('owns a frozen closed nine-option numeric table without caller objects or dynamic keys', () => {
    expect(source).toContain('const B4_SYNTHETIC_EVIDENCE_OPTIONS = Object.freeze([');
    expect(source.match(/Object\.freeze\(\{ optionIndex: [0-8], overscanTier: (20|10|4), initialTail: (80|40|24), forwardReserve: \d+, backwardReserve: \d+ \}\)/g) || []).toHaveLength(9);
    expect(source).toContain("if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= B4_SYNTHETIC_EVIDENCE_OPTIONS.length) return null;");
  });

  test('has opaque owner-bound one-shot arm consume and cleanup helpers', () => {
    for (const marker of [
      'function clearChatWindowSyntheticEvidenceRequest()',
      'function armChatWindowSyntheticEvidenceRequest(optionIndex)',
      'function consumeChatWindowSyntheticEvidenceRequest(token)'
    ]) expect(source).toContain(marker);
    expect(source).toContain('token: Object.freeze({})');
    expect(source).toContain("ownerSessionId: activeSessionId || '__no_session__'");
    expect(source).toContain('ownerGeneration: chatWindowGeneration');
  });

  test('keeps the capability disconnected from transactions and adaptive policy behavior', () => {
    const seam = [
      extractFunction('function clearChatWindowSyntheticEvidenceRequest()'),
      extractFunction('function armChatWindowSyntheticEvidenceRequest('),
      extractFunction('function consumeChatWindowSyntheticEvidenceRequest('),
    ].join('\n');
    for (const forbidden of ['rangePolicy', 'adapterUpdate', 'beginTransaction', 'planContainment',
      'applyKeyedChatReconciliation', 'scheduleRenderFromState', 'decideChatWindowAdaptivePolicy',
      'observeChatWindowAdaptiveShadow', 'publishChatWindowAdaptiveShadowTelemetry']) expect(seam).not.toContain(forbidden);
  });

  test('clears inert state at adapter destruction while fixed unarmed 20/80 constants remain unchanged', () => {
    expect(extractFunction('function destroyChatWindowAdapter(')).toContain('clearChatWindowSyntheticEvidenceRequest();');
    expect(source).toContain('const CHAT_WINDOW_INITIAL_TAIL = 80;');
    expect(source).toContain('const CHAT_WINDOW_OVERSCAN = 20;');
    expect(source).not.toContain('adapterUpdate.rangePolicy');
  });

  const capabilityHarness = (syntheticBoot: boolean, sessionId = 'session-a', generation = 3) => {
    const bootStart = source.indexOf('const B4_SYNTHETIC_EVIDENCE_BOOT_ACCEPTED =');
    const bootEnd = source.indexOf(';', bootStart) + 1;
    const capabilityStart = source.indexOf('const B4_SYNTHETIC_EVIDENCE_OPTIONS =');
    const capabilityEnd = source.indexOf('let chatWindowAcceptedPlanRevision', capabilityStart);
    expect(bootStart).toBeGreaterThanOrEqual(0);
    expect(capabilityStart).toBeGreaterThanOrEqual(0);
    expect(capabilityEnd).toBeGreaterThan(capabilityStart);
    const window: Record<string, any> = syntheticBoot
      ? { __ocChatWindowAdaptiveShadowTestConfig: { syntheticEnvironment: true } }
      : {};
    const sandbox = vm.createContext({ window, activeSessionId: sessionId, chatWindowGeneration: generation, Object, Number });
    vm.runInContext(`${source.slice(bootStart, bootEnd)}\n${source.slice(capabilityStart, capabilityEnd)}
      globalThis.__clear = clearChatWindowSyntheticEvidenceRequest;`, sandbox);
    return sandbox as Record<string, any>;
  };

  test('production boot remains absent after late synthetic assignment and has no enumerable capability', () => {
    const context = capabilityHarness(false);
    expect(Object.prototype.hasOwnProperty.call(context.window, '__ocChatWindowAdaptiveEvidence')).toBe(false);
    context.window.__ocChatWindowAdaptiveShadowTestConfig = { syntheticEnvironment: true };
    expect(Object.prototype.hasOwnProperty.call(context.window, '__ocChatWindowAdaptiveEvidence')).toBe(false);
    expect(source.match(/__ocChatWindowAdaptiveEvidence/g) || []).toHaveLength(1);
  });

  test('synthetic hook accepts only closed numeric indexes and preserves state on malformed attempts', () => {
    const context = capabilityHarness(true);
    const hook = context.window.__ocChatWindowAdaptiveEvidence;
    expect(Object.keys(context.window)).not.toContain('__ocChatWindowAdaptiveEvidence');
    expect(Object.isFrozen(hook)).toBe(true);
    for (const malformed of [-1, 9, 1.5, NaN, '1', {}, null, undefined]) expect(hook.arm(malformed)).toBeNull();
    const firstToken = hook.arm(0);
    expect(firstToken && Object.isFrozen(firstToken)).toBe(true);
    expect(hook.arm('0')).toBeNull();
    const request = hook.consume(firstToken);
    expect(request).toEqual({ optionIndex: 0, overscanTier: 20, initialTail: 80, forwardReserve: 13, backwardReserve: 7, attempt: 1 });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.keys(request).sort()).toEqual(['attempt', 'backwardReserve', 'forwardReserve', 'initialTail', 'optionIndex', 'overscanTier']);
  });

  test('arm consume is fresh opaque owner-bound one-shot with wrong/replay/stale cleanup', () => {
    const context = capabilityHarness(true);
    const hook = context.window.__ocChatWindowAdaptiveEvidence;
    const tokenA = hook.arm(4);
    expect(hook.consume(Object.freeze({}))).toBeNull();
    expect(hook.consume(tokenA)).toBeNull();
    const tokenA2 = hook.arm(4);
    const requestA = hook.consume(tokenA2);
    expect(requestA).toMatchObject({ optionIndex: 4, overscanTier: 10, initialTail: 40, attempt: 2 });
    expect(hook.consume(tokenA2)).toBeNull();
    const tokenB = hook.arm(8);
    expect(tokenB).not.toBe(tokenA);
    context.chatWindowGeneration += 1;
    expect(hook.consume(tokenB)).toBeNull();
    expect(hook.consume(tokenB)).toBeNull();
    const tokenC = hook.arm(2);
    context.activeSessionId = 'session-b';
    expect(hook.consume(tokenC)).toBeNull();
    const tokenD = hook.arm(1);
    expect(context.__clear()).toBe(true);
    expect(hook.consume(tokenD)).toBeNull();
    expect(context.__clear()).toBe(false);
  });
});

describe('B3 dormant presentation-only adaptive shadow integration', () => {
  const frozenState = (generation = 1, overrides: Record<string, unknown> = {}) => Object.freeze({
    sessionGeneration: generation, lastDecisionInterval: 0, overscanTier: 20, initialTail: 80,
    pressureCount: 0, headroomCount: 0, cooldownRemaining: 0, lastSignal: 'none',
    decisionGeneration: 0, ...overrides,
  });
  const emptyRoles = () => ({
    visible: 0, core: 0, currentStreamingAssistant: 0, thinkingAlias: 0,
    pairedActiveUser: 0, appendRoot: 0, readingAnchor: 0, searchTarget: 0, overscan: 0,
  });
  const observations = () => ({
    mountedCount: 80, directChildCount: 86, descendantCount: 300, viewportItemDemand: 8,
    renderCost: 0, measureCost: 0, projectedStructuralRoots: 6,
    currentRequestedCount: 80, currentAcceptedCount: 80,
    roleOutcomes: { accepted: emptyRoles(), capped: emptyRoles(), deferred: emptyRoles() },
  });

  function shadowHarness(decide?: (input: any) => any) {
    const calls: any[] = [];
    const context = executeFunctions([
      'function boundedChatAdaptiveCount(', 'function createChatWindowAdaptiveShadowState(',
      'function resetChatWindowAdaptiveShadow(', 'function resolveChatWindowAdaptiveShadowConfig(',
      'function publishChatWindowAdaptiveShadowTelemetry(', 'function observeChatWindowAdaptiveShadow(',
    ], {
      activeSessionId: 'session-a', chatWindowGeneration: 1,
      CHAT_WINDOW_ADAPTIVE_SHADOW_CONFIG: Object.freeze({
        enabled: false, revision: 1,
        pressure: Object.freeze({ mountedAtLeast: 130, directChildrenAtLeast: 140, descendantsAtLeast: 900, renderCostAtLeast: 80, measureCostAtLeast: 70 }),
        headroom: Object.freeze({ mountedAtMost: 90, directChildrenAtMost: 96, descendantsAtMost: 400, renderCostAtMost: 30, measureCostAtMost: 25 }),
        pressureConsecutiveIntervals: 2, headroomConsecutiveIntervals: 2, cooldownIntervals: 2,
        minimumAheadItems: 1, minimumBehindItems: 1, fastScrollDirectionalReserve: 5,
      }),
      chatWindowAdaptiveShadow: null,
      window: {
        __ocRendering: { decideChatWindowAdaptivePolicy: (input: any) => {
          calls.push(input);
          return decide ? decide(input) : Object.freeze({
            allowed: true, enabled: input.config.enabled, configRevision: input.config.revision,
            decisionInterval: input.decisionInterval, sessionGeneration: input.sessionGeneration,
            priorOverscanTier: input.state.overscanTier, newOverscanTier: input.state.overscanTier,
            priorInitialTail: input.state.initialTail, newInitialTail: input.state.initialTail,
            direction: input.direction, velocity: input.velocity, decision: 'hold', reason: input.config.enabled ? 'neutral' : 'disabled',
            range: Object.freeze({ viewportItems: 8, aheadItems: 10, behindItems: 10, totalDemand: 28 }),
            state: Object.freeze({ ...input.state, lastDecisionInterval: input.decisionInterval }),
            telemetry: Object.freeze({}),
          });
        } },
      },
      Object, Math, Number, Array, Set,
    });
    context.resetChatWindowAdaptiveShadow('initial');
    return { context, calls };
  }

  test('B3-RED1 owns disabled 20/80 state by session/generation and resets on cleanup boundaries', () => {
    const { context } = shadowHarness();
    expect(context.chatWindowAdaptiveShadow).toMatchObject({ ownerSessionId: 'session-a', ownerGeneration: 1 });
    expect(context.chatWindowAdaptiveShadow.state).toEqual(frozenState());
    expect(Object.isFrozen(context.chatWindowAdaptiveShadow)).toBe(true);
    context.chatWindowGeneration = 2;
    context.resetChatWindowAdaptiveShadow('session-switch');
    expect(context.chatWindowAdaptiveShadow.state).toEqual(frozenState(2));
    expect(context.window.__ocChatWindowAdaptiveShadow).toEqual(expect.objectContaining({
      enabled: false, overscanTier: 20, initialTail: 80, reason: 'session-switch',
    }));
    expect(extractFunction('function destroyChatWindowAdapter(')).toContain("resetChatWindowAdaptiveShadow(reason");
    expect(extractFunction('function enterChatWindowEmergency(')).toContain("resetChatWindowAdaptiveShadow('emergency-entry'");
    expect(extractFunction('function retryChatWindowEmergency(')).toContain("resetChatWindowAdaptiveShadow('emergency-retry'");
  });

  test('B3-RED2 tags self churn without counter recursion and permits a later external interval', () => {
    const { context, calls } = shadowHarness((input) => Object.freeze({
      allowed: true, enabled: true, configRevision: 7, decisionInterval: input.decisionInterval,
      sessionGeneration: input.sessionGeneration, priorOverscanTier: input.state.overscanTier,
      newOverscanTier: input.provenance.kind === 'external' ? 10 : input.state.overscanTier,
      priorInitialTail: input.state.initialTail, newInitialTail: input.provenance.kind === 'external' ? 40 : input.state.initialTail,
      direction: 'stationary', velocity: 'idle', decision: input.provenance.kind === 'external' ? 'shrink' : 'hold',
      reason: input.provenance.kind === 'external' ? 'pressure-transition' : 'self-churn',
      range: Object.freeze({ viewportItems: 8, aheadItems: 5, behindItems: 5, totalDemand: 18 }),
      state: Object.freeze({ ...input.state, lastDecisionInterval: input.decisionInterval,
        overscanTier: input.provenance.kind === 'external' ? 10 : input.state.overscanTier,
        initialTail: input.provenance.kind === 'external' ? 40 : input.state.initialTail,
        pressureCount: input.provenance.kind === 'self' ? input.state.pressureCount : 1,
        decisionGeneration: input.provenance.kind === 'external' ? input.state.decisionGeneration + 1 : input.state.decisionGeneration }),
      telemetry: Object.freeze({}),
    }));
    context.window.__ocChatWindowAdaptiveShadowTestConfig = { syntheticEnvironment: true, enabled: true, revision: 7 };
    context.observeChatWindowAdaptiveShadow(observations(), { kind: 'external' });
    context.observeChatWindowAdaptiveShadow(observations(), { kind: 'self', decisionGeneration: 1 });
    context.observeChatWindowAdaptiveShadow(observations(), { kind: 'external' });
    expect(calls.map((call) => call.provenance.kind)).toEqual(['external', 'self', 'external']);
    expect(calls[2].state.pressureCount).toBe(calls[1].state.pressureCount);
    expect(context.window.__ocChatWindowAdaptiveShadow.decisionGeneration).toBe(2);
  });

  test('B3-RED3 contains facade exception and stale/session ownership without leaking identifiers', () => {
    const { context } = shadowHarness(() => { throw new Error('PRIVATE_CONTENT'); });
    expect(() => context.observeChatWindowAdaptiveShadow(observations(), { kind: 'external' })).not.toThrow();
    expect(context.window.__ocChatWindowAdaptiveShadow.reason).toBe('facade-exception');
    context.window.__ocRendering.decideChatWindowAdaptivePolicy = () => { context.activeSessionId = 'session-b'; return {}; };
    context.observeChatWindowAdaptiveShadow(observations(), { kind: 'external' });
    expect(context.window.__ocChatWindowAdaptiveShadow.reason).toBe('stale-owner');
    expect(JSON.stringify(context.window.__ocChatWindowAdaptiveShadow)).not.toMatch(/session-a|session-b|PRIVATE|key|text|path|html|payload/i);
    expect(Object.isFrozen(context.window.__ocChatWindowAdaptiveShadow)).toBe(true);
  });

  test('B3-RED4 policy result has zero range/render/scroll/recovery side effects and active trace stays fixed 20/80', () => {
    const shadow = extractFunction('function observeChatWindowAdaptiveShadow(');
    for (const forbidden of [
      'adapterUpdate', 'rangePolicy', 'slice(', 'planChatWindowContainment', 'applyKeyedChatReconciliation',
      'scrollToBottom', 'scheduleRenderFromState', 'restoreChatWindowAnchor', 'enterChatWindowEmergency',
      'applyChatWindowOrWave2',
    ]) expect(shadow).not.toContain(forbidden);
    const candidate = extractFunction('function prepareUnpublishedChatWindowTransaction(');
    expect(candidate).toContain('overscan: CHAT_WINDOW_OVERSCAN');
    expect(candidate).toContain('initialTailCount: CHAT_WINDOW_INITIAL_TAIL');
    expect(candidate).toContain('rangePolicy');
    expect(candidate).toContain('consumeChatWindowSyntheticEvidenceRequest');
    const windowed = extractFunction('function applyWindowedKeyedChatReconciliation(');
    expect(windowed).not.toContain('newOverscanTier');
    expect(windowed).not.toContain('newInitialTail');
    expect(source.match(/decideChatWindowAdaptivePolicy/g) || []).toHaveLength(1);
  });
});

describe('adaptive range transactional runtime rollout', () => {
  test('production enables revision 2 behind an independent boot switch', () => {
    expect(source).toContain("const CHAT_WINDOW_ADAPTIVE_RANGE_ENABLED = window.__ocChatWindowAdaptiveRangeEnabled !== false;");
    expect(source).toContain('enabled: CHAT_WINDOW_ADAPTIVE_RANGE_ENABLED,\n        revision: 2,');
    expect(source).not.toMatch(/CHAT_WINDOW_ADAPTIVE_RANGE_ENABLED\s*=\s*(?:true|false)/);
  });

  test.each([
    [20, 80, { overscanTier: 20, beforeReserve: 7, afterReserve: 13, initialTail: 80 }],
    [10, 40, { overscanTier: 10, beforeReserve: 3, afterReserve: 7, initialTail: 40 }],
    [4, 24, { overscanTier: 4, beforeReserve: 1, afterReserve: 3, initialTail: 24 }],
  ])('committed tier %i/%i resolves one immutable adapter policy', (overscanTier, initialTail, expected) => {
    const body = extractFunction('function resolveChatWindowAdaptiveRangePolicy(');
    const run = (overrides: Record<string, unknown> = {}) => {
      const context = vm.createContext({
        CHAT_WINDOW_ADAPTIVE_RANGE_ENABLED: true,
        chatWindowAdaptiveShadow: {
          ownerSessionId: 'session-a', ownerGeneration: 7,
          state: { overscanTier, initialTail },
        },
        activeSessionId: 'session-a', chatWindowGeneration: 7,
        boundedChatAdaptiveCount: (value: number) => value,
        ...overrides,
      });
      vm.runInContext(`${body}; globalThis.resolvePolicy = resolveChatWindowAdaptiveRangePolicy;`, context);
      return context.resolvePolicy();
    };
    expect(run()).toEqual(expected);
    expect(Object.isFrozen(run())).toBe(true);
    expect(run({ CHAT_WINDOW_ADAPTIVE_RANGE_ENABLED: false })).toBeUndefined();
    expect(run({ activeSessionId: 'session-b' })).toBeUndefined();
    expect(run({ chatWindowGeneration: 8 })).toBeUndefined();
  });

  test('policy observation is committed only after adapter and DOM journal finalization', () => {
    const windowed = extractFunction('function applyWindowedKeyedChatReconciliation(');
    const applyPlan = windowed.indexOf('applied = applyAcceptedPlan(acceptedPlan);');
    const adapterFinalize = windowed.indexOf('adapterTransaction.finalizeCommit()');
    const journalFinalize = windowed.indexOf('finalizeChatPresentationJournal(journal)');
    const externalObservation = windowed.indexOf('observeChatWindowAdaptiveShadow(applied.adaptiveObservations');
    expect(applyPlan).toBeGreaterThanOrEqual(0);
    expect(adapterFinalize).toBeGreaterThan(applyPlan);
    expect(journalFinalize).toBeGreaterThan(adapterFinalize);
    expect(externalObservation).toBeGreaterThan(journalFinalize);
    expect(windowed.slice(applyPlan, adapterFinalize)).not.toContain("kind: 'external'");
  });

  test('synthetic policy remains an explicit one-attempt override while normal runtime uses committed state', () => {
    for (const marker of [
      'function prepareUnpublishedChatWindowTransaction(',
      'function applyWindowedKeyedChatReconciliation(',
    ]) {
      const owner = extractFunction(marker);
      expect(owner).toContain('syntheticEvidenceRequest ? Object.freeze({');
      expect(owner).toContain("}) : typeof resolveChatWindowAdaptiveRangePolicy === 'function'");
    }
  });
});

describe('UI log regression repairs', () => {
  test('new-session actions release the prior presentation owner before rendering the empty chat', () => {
    const clickStart = source.indexOf("newSessionBtn.addEventListener('click', () => {");
    const clickEnd = source.indexOf("document.addEventListener('mouseover'", clickStart);
    const clickHandler = source.slice(clickStart, clickEnd);
    const clickTransition = clickHandler.indexOf("transitionActiveSessionPresentationOwner(activeSessionId, '');");
    const clickAssignment = clickHandler.indexOf("activeSessionId = '';");
    expect(clickStart).toBeGreaterThanOrEqual(0);
    expect(clickTransition).toBeGreaterThanOrEqual(0);
    expect(clickAssignment).toBeGreaterThan(clickTransition);
    expect(clickHandler).toContain("pendingExplicitSessionSelectionId = '';");

    const receipt = extractCaseBlock("case 'newSession':", "case 'undoStatus':");
    const receiptTransition = receipt.indexOf('transitionActiveSessionPresentationOwner(activeSessionId, nextSessionId);');
    const receiptAssignment = receipt.indexOf('activeSessionId = nextSessionId;');
    expect(receipt).toContain("const nextSessionId = message.sessionId || '';");
    expect(receiptTransition).toBeGreaterThanOrEqual(0);
    expect(receiptAssignment).toBeGreaterThan(receiptTransition);
    expect(receipt).toContain("pendingExplicitSessionSelectionId = '';");
  });

  test('reload shows one loading-history unit while a hydrated empty session keeps the greeting', () => {
    const session = { timeline: [] };
    const context = executeCF3Functions([
      'function isActiveSessionHistoryLoading(',
      'function buildKeyedRenderCandidates(',
    ], {
      activeSessionId: 'session-a',
      hydratedSessions: new Set(),
      getSessionState: () => session,
    });
    expect(context.buildKeyedRenderCandidates(session)).toEqual([{
      key: 'history-loading:session-a', kind: 'greeting', value: { text: 'Loading history ...' },
    }]);
    context.hydratedSessions.add('session-a');
    expect(context.buildKeyedRenderCandidates(session)).toEqual([{
      key: 'greeting:session-a', kind: 'greeting', value: null,
    }]);

    const surfaceOwner = extractFunction('function renderChatLocalOlderSurface(');
    expect(surfaceOwner).toContain('if (suppressContent === true)');
    expect(extractFunction('function applyWindowedKeyedChatReconciliation('))
      .toContain('renderChatLocalOlderSurface(localWindow.presentation, localWindow.suppressSurfaceContent === true);');
    expect(extractFunction('function resolveChatLocalHistoryWindow('))
      .toContain("|| units.every((unit) => unit.kind === 'greeting')");
    expect(extractFunction('function resolveChatLocalHistoryWindow('))
      .toContain("|| resolution.presentation.state === 'deltaContinuityUnknown'");

    const localHistoryContext = executeCF3Functions([
      'function isActiveSessionHistoryLoading(',
      'function resolveChatLocalHistoryWindow(',
    ], {
      activeSessionId: '', hydratedSessions: new Set(),
      getSessionState: () => null,
      normalizePayloadHydrationCoverage: () => 'deltaContinuityUnknown',
      chatWindowState: {},
      chatLocalHistoryController: {
        resolve: () => ({ revealStart: 0, visibleKeys: ['greeting:none'], presentation: { state: 'deltaContinuityUnknown' } }),
      },
    });
    expect(localHistoryContext.resolveChatLocalHistoryWindow([
      { key: 'greeting:none', kind: 'greeting', value: null },
    ])).toMatchObject({ suppressSurfaceContent: true });
    expect(localHistoryContext.resolveChatLocalHistoryWindow([
      { key: 'message:first', kind: 'message', value: { message: { id: 'first' } } },
    ])).toMatchObject({ suppressSurfaceContent: true });
  });

  test('text and smart search use the outer session accessor without a DOMContentLoaded-only helper', () => {
    const getSessionState = jest.fn(() => ({ timeline: ['message-a'] }));
    const context = executeCF3Functions([
      'function collectLoadedTextSearchKeys(',
      'function collectSmartSearchMessages(',
    ], {
      activeSessionId: 'session-a',
      getSessionState,
      window: { __oc: { getLoadedChatSearchRows: () => [{ id: 'message-a', role: 'assistant', text: 'needle' }] } },
    });
    expect(context.collectLoadedTextSearchKeys('needle')).toEqual(['message-a']);
    expect(context.collectSmartSearchMessages()).toEqual([{ id: 'message-a', role: 'assistant', text: 'needle' }]);
    expect(getSessionState).toHaveBeenCalledWith('session-a', false);
    for (const marker of ['function collectLoadedTextSearchKeys(', 'function collectSmartSearchMessages(']) {
      expect(extractFunction(marker)).not.toContain('getSessionOrNull(');
    }
  });

  test('metadata events use one bounded coalescer and do not route subagent content through unclear-anchor recovery', () => {
    const handler = extractCaseBlock("case 'subagentStatus':", "case 'backgroundActivityPulse':");
    expect(handler).toContain("scheduleCoalescedSessionMetadataRender(sessionId, 'subagentStatus-coalesced'");
    expect(handler).toContain('immediate: terminalStatusUpdate');
    expect(handler).not.toMatch(/getSubagentStatusNoClearAnchorReason|isUnclearAnchorCircuitBreakerOpen/);
    expect(extractCaseBlock("case 'todoUpdate':", "case 'messageAppend':"))
      .toContain("scheduleCoalescedSessionMetadataRender(sessionId, 'todoUpdate-coalesced')");
    const coalescer = extractFunction('function scheduleCoalescedSessionMetadataRender(');
    expect(coalescer).toContain('SESSION_METADATA_RENDER_INTERVAL_MS');
    expect(coalescer).toContain('if (state.timer !== null) return true;');

    let now = 1000;
    let timer: (() => void) | null = null;
    const rendered: string[] = [];
    const context = executeCF3Functions(['function scheduleCoalescedSessionMetadataRender('], {
      activeSessionId: 'session-a',
      sessionMetadataRenderStates: new Map(),
      SESSION_METADATA_RENDER_INTERVAL_MS: 250,
      Date: { now: () => now },
      setTimeout: (callback: () => void) => { timer = callback; return 1; },
      clearTimeout: () => { timer = null; },
      logBackgroundStateUpdate: () => undefined,
      window: { __oc: { renderFromState: (reason: string) => rendered.push(reason) } },
    });
    expect(context.scheduleCoalescedSessionMetadataRender('session-a', 'first')).toBe(true);
    expect(context.scheduleCoalescedSessionMetadataRender('session-a', 'latest')).toBe(true);
    expect(rendered).toHaveLength(0);
    expect(timer).not.toBeNull();
    now = 1250;
    (timer as unknown as () => void)();
    expect(rendered).toEqual(['latest']);
    context.scheduleCoalescedSessionMetadataRender('session-a', 'terminal', { immediate: true });
    expect(rendered).toEqual(['latest', 'terminal']);
  });

  test('raw audit accepts legal Map insertion order while retaining DOM order and node-binding checks', () => {
    const nodeA = { dataset: { renderUnitKey: 'a' } };
    const nodeB = { dataset: { renderUnitKey: 'b' } };
    const consumed: any[] = [];
    const context = executeCF3Functions(['function captureChatWindowRawIntegrityAudit('], {
      keyedRoots: () => [nodeB, nodeA],
      keyedChatReconcileState: {
        items: [{ key: 'b' }, { key: 'a' }],
        roots: new Map([['a', nodeA], ['b', nodeB]]),
      },
      getChatStructuralIntegrityRoots: () => [],
      chatContainer: { childElementCount: 4 },
      chatWindowState: { adapter: null },
      activeSessionId: 'session-a',
      chatWindowGeneration: 3,
      consumeChatWindowIntegrityAudit: (...args: any[]) => consumed.push(args),
    });
    expect(context.captureChatWindowRawIntegrityAudit()).toEqual(expect.objectContaining({ anomaly: false }));
    expect(consumed).toHaveLength(0);

    context.keyedChatReconcileState.roots = new Map([['a', nodeB], ['b', nodeA]]);
    const mismatch = context.captureChatWindowRawIntegrityAudit();
    expect(mismatch.anomaly).toBe(true);
    expect(mismatch.corruptionSamples).toEqual([
      expect.objectContaining({ code: 'root-map-dom-mismatch', expected: ['b', 'a'], actual: ['a', 'b'] }),
    ]);
    expect(consumed).toHaveLength(1);
    expect(extractFunction('function recordChatWindowOuterRecovery(')).toContain('codes=${corruptionCodes || \'none\'}');
  });

  test('search navigation releases bottom pinning before the adapter scroll and schedules one owned render', () => {
    const mount = extractFunction('function mountChatWindowSearchKey(');
    const unpin = mount.indexOf('autoScrollPinnedToBottom = false;');
    const scroll = mount.indexOf("tryPendingChatWindowScroll('search-action');");
    const render = mount.indexOf('scheduleRenderFromState(`window-${reason}`);');
    expect(unpin).toBeGreaterThanOrEqual(0);
    expect(scroll).toBeGreaterThan(unpin);
    expect(render).toBeGreaterThan(scroll);
    expect(mount).toContain('chatWindowState.activityBelow = true;');
    expect(mount.match(/scheduleRenderFromState\(/g) || []).toHaveLength(1);
  });
});

describe('B4 evidence authenticity and closed option matrix', () => {
  const runEvidence = () => {
    execFileSync(process.execPath, [b4ScriptPath], { cwd: process.cwd(), stdio: 'pipe' });
    return fs.readFileSync(b4EvidencePath, 'utf8');
  };

  test('B4-RED1 uses the real hidden facade and records threshold/consecutive/cooldown candidates without selecting defaults', () => {
    const script = fs.readFileSync(b4ScriptPath, 'utf8');
    expect(script).toContain("media/rendering.bundle.js");
    expect(script).toContain('facade.decideChatWindowAdaptivePolicy');
    expect(script).not.toMatch(/require\(.+chat-window-adaptive-policy|selectedThreshold|selectedDefault|recommendedDefault/);
    const evidence = JSON.parse(runEvidence());
    expect(evidence.calibration.thresholdSamples).toHaveLength(30);
    expect(evidence.calibration.intervalCandidates).toEqual({ consecutive: [1, 2, 3], cooldown: [1, 2, 3] });
    expect(evidence.calibration.intervalRuns).toHaveLength(9);
    expect(evidence).not.toHaveProperty('reviewerDecision');
  });

  test('B4-RED2 covers all 9 options, directions, and old/current regions with zero blanks and hard caps', () => {
    const evidence = JSON.parse(runEvidence());
    expect(evidence.options).toHaveLength(36);
    expect(new Set(evidence.options.map((entry: any) => `${entry.overscanTier}/${entry.initialTail}`)).size).toBe(9);
    expect(new Set(evidence.options.map((entry: any) => entry.direction))).toEqual(new Set(['forward', 'backward']));
    expect(new Set(evidence.options.map((entry: any) => entry.region))).toEqual(new Set(['old', 'current']));
    const ranges = evidence.options.map((entry: any) => entry.rawEvents.find((event: any) => event.type === 'adapter-range'));
    const blanks = ranges.filter((range: any) => !range.mountedIndexes.some((index: number) => (
      index >= range.viewportStart && index <= range.viewportEnd
    ))).length;
    expect({ samples: ranges.length, blanks }).toEqual({ samples: 36, blanks: 0 });
    expect(Math.max(...ranges.map((range: any) => range.mountedIndexes.length))).toBeLessThanOrEqual(140);
    expect(Math.max(...ranges.map((range: any) => range.directRootCount))).toBeLessThanOrEqual(146);
  });

  test('B4-RED3 reports bounded synthetic anchor denominator/max with explicit non-browser labels', () => {
    const evidence = JSON.parse(runEvidence());
    expect(evidence.environment).toEqual({
      kind: 'node-synthetic', syntheticNotBrowserTiming: true, browserRealAvailable: false,
    });
    expect(evidence.summary.geometry.records).toBe(36);
    expect(evidence.summary.geometry.maximumAnchorErrorPx).toBeLessThanOrEqual(4);
  });

  test('B4-RED4 parameterizes canonical action/stale/deferred workflows for every option', () => {
    const evidence = JSON.parse(runEvidence());
    expect(evidence.workflows).toHaveLength(63);
    expect(new Set(evidence.workflows.map((entry: any) => entry.workflow))).toEqual(new Set([
      'search-unmounted', 'append-active', 'alias', 'undo-reverted', 'change-list', 'subagent', 'session-switch',
    ]));
    expect(evidence.workflows.every((entry: any) => {
      const before = /^canonical:(\d+)$/.exec(entry.rawEvents?.find((event: any) => event.type === 'before')?.result || '');
      const after = /^canonical:(\d+):deferred:(true|false)$/.exec(entry.rawEvents?.find((event: any) => event.type === 'after')?.result || '');
      const action = entry.rawEvents?.find((event: any) => event.type === 'owner-call' && event.phase === entry.workflow);
      const callback = entry.rawEvents?.find((event: any) => event.type === 'callback-state');
      return before && after && before[1] === after[1] && action?.ownerHash?.length === 64
        && ['stable', 'stale-rejected'].includes(callback?.phase) && after[2] === 'false';
    })).toBe(true);
  });

  test('B4-RED5 freezes alternating/stream/negative-control/smoke evidence and is byte-identical twice', () => {
    const first = runEvidence();
    const second = runEvidence();
    expect(second).toBe(first);
    const evidence = JSON.parse(first);
    expect(evidence.calibration.alternating.frameToFrameExtremeFlaps).toBe(0);
    expect(evidence.traces).toHaveLength(9);
    expect(evidence.traces.every((entry: any) => entry.rawEvents.filter((event: any) => event.type === 'patch').length === 125
      && entry.rawEvents.some((event: any) => event.phase === 'transaction')
      && entry.rawEvents.some((event: any) => event.phase === 'recovery-negative')
      && entry.rawEvents.some((event: any) => event.phase === 'final'))).toBe(true);
    expect(evidence.smoke.every((entry: any) => {
      const phases = entry.rawEvents.filter((event: any) => event.type === 'owner-call').map((event: any) => event.phase);
      return ['primary', 'stream-final', 'search', 'append', 'alias', 'undo-reverted', 'change-list', 'subagent', 'session-switch']
        .every((phase) => phases.includes(phase));
    })).toBe(true);
  });

  test('B4-E-RED-6 final summaries independently reduce only nonvacuous raw A-D evidence', () => {
    const evidence = JSON.parse(runEvidence());
    const recompute = (candidate: any) => {
      const ranges = candidate.options.map((record: any) => record.rawEvents.find((event: any) => event.type === 'adapter-range'));
      const geometry = candidate.options.map((record: any) => {
        const pre = record.rawEvents.find((event: any) => event.type === 'geometry-pre');
        const post = record.rawEvents.find((event: any) => event.type === 'geometry-post');
        const range = record.rawEvents.find((event: any) => event.type === 'adapter-range');
        const accepted = new Set(range.acceptedIndexes);
        return { anchorError: Math.abs((post.anchorOffset - post.scrollTop) - (pre.anchorOffset - pre.scrollTop)),
          blank: !range.mountedIndexes.some((index: number) => index >= range.viewportStart && index <= range.viewportEnd),
          offRange: range.mountedIndexes.filter((index: number) => !accepted.has(index)).length };
      });
      const failureStates = candidate.failures.map((record: any) => JSON.parse(
        record.rawEvents.find((event: any) => event.type === 'failure-after').result,
      ));
      return {
        transaction: { records: candidate.options.length,
          begins: candidate.options.reduce((sum: number, record: any) => sum + record.rawEvents.filter((event: any) => event.type === 'transaction-begin').length, 0),
          planners: candidate.options.reduce((sum: number, record: any) => sum + record.rawEvents.filter((event: any) => event.type === 'planner').length, 0),
          journals: candidate.options.reduce((sum: number, record: any) => sum + record.rawEvents.filter((event: any) => event.type === 'journal-begin').length, 0) },
        geometry: { records: geometry.length, blanks: geometry.filter((record: any) => record.blank).length,
          offRangeRoots: geometry.reduce((sum: number, record: any) => sum + record.offRange, 0),
          maximumMounted: Math.max(...ranges.map((range: any) => range.mountedIndexes.length)),
          maximumDirectChildren: Math.max(...ranges.map((range: any) => range.directRootCount)),
          maximumAnchorErrorPx: Math.max(...geometry.map((record: any) => record.anchorError)) },
        failure: { records: candidate.failures.length, c0Owners: failureStates.filter((state: any) => state.owner === 'old').length,
          committedDegraded: failureStates.filter((state: any) => state.owner === 'candidate' && state.recovery === 'committed-degraded').length,
          abortCalls: failureStates.reduce((sum: number, state: any) => sum + state.abortCalls, 0) },
        workflow: { records: candidate.workflows.length,
          ownerCalls: candidate.workflows.reduce((sum: number, record: any) => sum + record.rawEvents.filter((event: any) => event.type === 'owner-call').length, 0) },
        trace: { records: candidate.traces.length,
          callbacks: candidate.traces.reduce((sum: number, record: any) => sum + record.rawEvents.filter((event: any) => event.type === 'patch').length, 0) },
        smoke: { records: candidate.smoke.length,
          namedSteps: candidate.smoke.reduce((sum: number, record: any) => sum + record.rawEvents.filter((event: any) => event.type === 'owner-call').length, 0) },
      };
    };
    expect(evidence.summary).toEqual(recompute(evidence));
    expect({ options: evidence.options.length, failures: evidence.failures.length, workflows: evidence.workflows.length,
      traces: evidence.traces.length, smoke: evidence.smoke.length }).toEqual({ options: 36, failures: 8, workflows: 63, traces: 9, smoke: 9 });
    expect(JSON.stringify(evidence)).not.toMatch(/"(?:content|html|payload|searchText|path)"\s*:/);
    for (const obsolete of ['optionSummary', 'anchor', 'reviewerDecision']) expect(evidence).not.toHaveProperty(obsolete);
    const mutated = JSON.parse(JSON.stringify(evidence));
    mutated.options[0].rawEvents.find((event: any) => event.type === 'adapter-range').mountedIndexes.push(999);
    expect(recompute(mutated)).not.toEqual(evidence.summary);
    const missingFailure = { ...evidence, failures: evidence.failures.slice(1) };
    expect(recompute(missingFailure)).not.toEqual(evidence.summary);
  });
});

describe('B4-RED-0 authenticity gap proof (intentional RED)', () => {
  const requiredProductionFunctions = [
    'prepareUnpublishedChatWindowTransaction', 'applyWindowedKeyedChatReconciliation',
    'beginChatPresentationJournal', 'applyKeyedChatReconciliation', 'finalizeChatPresentationJournal',
  ] as const;
  const runCurrentEvidence = () => {
    execFileSync(process.execPath, [b4ScriptPath], { cwd: process.cwd(), stdio: 'pipe' });
    return JSON.parse(fs.readFileSync(b4EvidencePath, 'utf8'));
  };
  const extractDurable = (mainSource: string, name: string) => {
    const marker = `function ${name}(`;
    const start = mainSource.indexOf(marker);
    if (start < 0) throw new Error(`missing production function ${name}`);
    const brace = mainSource.indexOf('{', start + marker.length);
    let depth = 0;
    let state: 'code' | 'single' | 'double' | 'template' | 'line' | 'block' = 'code';
    let escaped = false;
    for (let index = brace; index < mainSource.length; index += 1) {
      const char = mainSource[index];
      const next = mainSource[index + 1];
      if (state === 'line') { if (char === '\n') state = 'code'; continue; }
      if (state === 'block') { if (char === '*' && next === '/') { state = 'code'; index += 1; } continue; }
      if (state !== 'code') {
        if (escaped) { escaped = false; continue; }
        if (char === '\\') { escaped = true; continue; }
        if ((state === 'single' && char === "'") || (state === 'double' && char === '"')
          || (state === 'template' && char === '`')) state = 'code';
        continue;
      }
      if (char === '/' && next === '/') { state = 'line'; index += 1; continue; }
      if (char === '/' && next === '*') { state = 'block'; index += 1; continue; }
      if (char === "'") { state = 'single'; continue; }
      if (char === '"') { state = 'double'; continue; }
      if (char === '`') { state = 'template'; continue; }
      if (char === '{') depth += 1;
      if (char === '}' && --depth === 0) return mainSource.slice(start, index + 1);
    }
    throw new Error(`unclosed production function ${name}`);
  };
  const independentlyComputedHashes = () => {
    const mainSource = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
    return Object.fromEntries(requiredProductionFunctions.map((name) => [name,
      crypto.createHash('sha256').update(extractDurable(mainSource, name).replace(/\r\n/g, '\n')).digest('hex'),
    ]));
  };
  const requiredWitnesses = [
    'attempt-arm', 'attempt-consume', 'transaction-begin', 'planner', 'journal-begin',
    'keyed-apply', 'transaction-seal', 'transaction-finalize',
  ];
  const recomputePipeline = (events: any[]) => ({
    mainTransaction: events.filter((event) => event.type === 'transaction-begin').length,
    planner: events.filter((event) => event.type === 'planner').length,
    journal: events.filter((event) => event.type === 'journal-begin').length,
    keyedApply: events.filter((event) => event.type === 'keyed-apply').length,
  });
  const pipelineRecordValid = (record: any, independentEvents: any[]) => {
    const events = Array.isArray(record?.rawEvents) ? record.rawEvents : [];
    const witnessOrder = requiredWitnesses.map((type) => events.findIndex((event: any) => event.type === type));
    const ordered = witnessOrder.every((index, offset) => index >= 0 && (offset === 0 || index > witnessOrder[offset - 1]));
    const ordinals = events.every((event: any) => Number.isInteger(event.ownerOrdinal)
      && Number.isInteger(event.tokenOrdinal) && Number.isInteger(event.optionAttemptOrdinal)
      && Number.isInteger(event.handleOrdinal));
    return ordered && ordinals
      && JSON.stringify(events) === JSON.stringify(independentEvents);
  };
  const recomputeGeometry = (record: any) => {
    const geometry = record?.anchorGeometry;
    const range = (record?.rawEvents || []).find((event: any) => event.type === 'adapter-range');
    if (!geometry?.pre || !geometry?.post || !range) return null;
    const preVisual = geometry.pre.anchorOffset - geometry.pre.scrollTop;
    const postVisual = geometry.post.anchorOffset - geometry.post.scrollTop;
    const error = Math.abs(postVisual - preVisual);
    const indexes = range.mountedIndexes;
    const blank = !indexes.some((index: number) => index >= range.viewportStart && index <= range.viewportEnd);
    const offRange = indexes.filter((index: number) => !range.acceptedIndexes.includes(index)).length;
    return { error, blank, offRange, mounted: indexes.length, directChildren: range.directRootCount };
  };
  const reduceOutcome = (record: any) => {
    const events = Array.isArray(record?.rawEvents) ? record.rawEvents : [];
    const before = events.find((event: any) => event.type === 'before');
    const after = events.find((event: any) => event.type === 'after');
    return {
      canonical: Boolean(before && after && before.canonicalOrdinal === after.canonicalOrdinal),
      actions: events.some((event: any) => event.type === 'action' && event.accepted === true),
      staleRejected: events.some((event: any) => event.type === 'callback' && event.stale === true && event.applied === false),
      deferredPending: Boolean(after?.deferredPending),
      patches: events.filter((event: any) => event.type === 'patch' && event.applied === true).length,
    };
  };

  test('B4-RED-0.1 real prepare and windowed main paths must each consume staged rangePolicy options', () => {
    const prepare = extractFunction('function prepareUnpublishedChatWindowTransaction(');
    const windowed = extractFunction('function applyWindowedKeyedChatReconciliation(');
    expect(prepare).toContain('overscan: CHAT_WINDOW_OVERSCAN');
    expect(prepare).toContain('initialTailCount: CHAT_WINDOW_INITIAL_TAIL');
    const realMainOptionConsumptionSites = [prepare, windowed]
      .filter((body) => body.includes('rangePolicy')).length;
    expect(realMainOptionConsumptionSites).toBe(2);
  });

  test('B4-RED-0.2 option evidence must not substitute local arithmetic or direct adapter-only transactions', () => {
    const script = fs.readFileSync(b4ScriptPath, 'utf8');
    const b4MatrixStart = wave3TestSource.lastIndexOf("test('B4 extracted real main transaction plus installed adapter");
    const b4MatrixEnd = wave3TestSource.indexOf('\n  });', b4MatrixStart);
    const matrix = wave3TestSource.slice(b4MatrixStart, b4MatrixEnd);
    const substituteSites = [
      script.includes('function optionEvidence()'),
      script.includes('Array.from({ length: before + 12 + after }'),
      matrix.includes('harness.adapter.beginTransaction({'),
    ].filter(Boolean).length;
    expect(substituteSites).toBe(0);
  });

  test('B4-RED-0.3 workflow, trace, and smoke outcomes must derive from raw executed events', () => {
    const script = fs.readFileSync(b4ScriptPath, 'utf8');
    const hardcodedSuccessSites = [
      'canonical: true', 'actions: true', 'staleRejected: true', 'deferredPending: true',
      'pinReturn: true', 'unpinStable: true', 'pressureNegative: true', 'correctionNegative: true',
      'emergencyNegative: true', 'abortRestored: true', 'degradedConsistent: true',
      'fixedA2Rollback: true', 'blank: false', 'load: true', 'wheelOld: true',
      'pageCurrent: true', 'primary: true', 'stream: true', 'final: true',
      'pin: true', 'sessionSwitch: true', 'fixedRollback: true',
    ].reduce((count, marker) => count + (script.includes(marker) ? 1 : 0), 0);
    const evidence = runCurrentEvidence();
    const rawEventRecords = [...evidence.workflows, ...evidence.traces, ...evidence.smoke]
      .filter((record: any) => {
        if (!Array.isArray(record.rawEvents) || record.rawEvents.length === 0) return false;
        const before = record.rawEvents.find((event: any) => event.type === 'before')?.result;
        const after = record.rawEvents.find((event: any) => event.type === 'after')?.result;
        const ownerCalls = record.rawEvents.filter((event: any) => event.type === 'owner-call');
        const canonical = /^canonical:(\d+)$/.exec(before || '')?.[1]
          === /^canonical:(\d+):deferred:(?:true|false)$/.exec(after || '')?.[1];
        const currentOwners = ownerCalls.every((event: any) => typeof event.owner === 'string'
          && event.owner.length > 0 && /^[a-f0-9]{64}$/.test(event.ownerHash));
        const patches = record.rawEvents.filter((event: any) => event.type === 'patch');
        return canonical && currentOwners && (!evidence.traces.includes(record) || patches.length === 125);
      }).length;
    expect({ hardcodedSuccessSites, rawEventRecords }).toEqual({ hardcodedSuccessSites: 0, rawEventRecords: 81 });
  });

  test('B4-RED-0.4 anchor evidence must derive from varied observed pre/post geometry', () => {
    const records = collectB4CGeometryRecords();
    const reduced = records.map((record) => {
      const preVisual = record.pre.anchorOffset - record.pre.scrollTop;
      const postVisual = record.post.anchorOffset - record.post.scrollTop;
      const mounted = new Set(record.range.mountedIndexes);
      const accepted = new Set(record.range.acceptedIndexes);
      return {
        error: Math.abs(postVisual - preVisual),
        blank: !record.range.mountedIndexes.some((index: number) => (
          index >= record.range.viewportStart && index <= record.range.viewportEnd
        )),
        mounted: mounted.size,
        directChildren: record.range.directRootCount,
        offRange: [...mounted].filter((index) => !accepted.has(index)).length,
      };
    });
    expect(records).toHaveLength(36);
    expect(new Set(records.map((record) => `${record.overscanTier}/${record.initialTail}`)).size).toBe(9);
    expect(new Set(records.map((record) => record.direction)).size).toBe(2);
    expect(new Set(records.map((record) => JSON.stringify(record.range.itemHeights))).size).toBeGreaterThan(1);
    expect(new Set(records.map((record) => JSON.stringify(record.range.mountedIndexes))).size).toBe(12);
    expect(new Set(records.map((record) => JSON.stringify(record.pre))).size).toBe(36);
    expect(new Set(records.map((record) => JSON.stringify(record.post))).size).toBe(36);
    expect(new Set(records.map((record) => `${record.range.topSpacerHeight}/${record.range.bottomSpacerHeight}`)).size)
      .toBeGreaterThan(1);
    expect(reduced.filter((record) => record.blank)).toHaveLength(0);
    expect(Math.max(...reduced.map((record) => record.mounted))).toBeLessThanOrEqual(140);
    expect(Math.max(...reduced.map((record) => record.directChildren))).toBeLessThanOrEqual(146);
    expect(reduced.reduce((sum, record) => sum + record.offRange, 0)).toBe(0);
    expect(Math.max(...reduced.map((record) => record.error))).toBeLessThanOrEqual(4);
  });

  test('B4-RED-0.5 every sample must prove authentic main function hashes and one transaction pipeline', () => {
    const evidence = runCurrentEvidence();
    const expectedHashes = independentlyComputedHashes();
    const authenticFunctionHashes = requiredProductionFunctions
      .filter((name) => evidence.authenticity?.functionHashes?.[name] === expectedHashes[name]).length;
    const authenticSamples = evidence.options.filter((record: any) => (
       pipelineRecordValid(record, record.rawEvents)
       && Object.values(recomputePipeline(record.rawEvents)).every((count) => count === 1)
      && Array.isArray(record.observedMountedIndexes)
      && Array.isArray(record.observedMountedKeys)
    )).length;
    expect({ authenticFunctionHashes, authenticSamples })
      .toEqual({ authenticFunctionHashes: 5, authenticSamples: 36 });
  });

  test('B4-RED-0 mutation guards reject plausible fabricated hashes/counts/phases/geometry/outcomes', () => {
    const ordinal = { ownerOrdinal: 1, tokenOrdinal: 1, optionAttemptOrdinal: 1, handleOrdinal: 1 };
    const events = requiredWitnesses.map((type) => ({ type, ...ordinal }));
    const record: any = {
      rawEvents: events,
      independentSpyEvents: events,
      callCounts: recomputePipeline(events),
      anchorGeometry: {
        pre: { anchorOffset: 120, scrollTop: 20, topSpacerHeight: 10, bottomSpacerHeight: 30 },
        post: { anchorOffset: 124, scrollTop: 24, topSpacerHeight: 12, bottomSpacerHeight: 28 },
      },
    };
    expect(pipelineRecordValid(record, events)).toBe(true);
    expect(pipelineRecordValid({ ...record, rawEvents: [events[0], ...events] }, events)).toBe(false);
    expect(pipelineRecordValid({ ...record, rawEvents: [...events].reverse() }, events)).toBe(false);
    expect(pipelineRecordValid({ ...record, rawEvents: events.map((event: any) => ({ ...event, handleOrdinal: 9 })) }, events)).toBe(false);
    const hashes = independentlyComputedHashes();
    expect({ ...hashes, prepareUnpublishedChatWindowTransaction: 'a'.repeat(64) })
      .not.toEqual(hashes);
    const rangeEvent = { type: 'adapter-range', mountedIndexes: [1, 2], acceptedIndexes: [1, 2],
      viewportStart: 1, viewportEnd: 2, directRootCount: 8, itemHeights: [48, 64] };
    const geometryRecord = { ...record, rawEvents: [...events, rangeEvent], blank: false,
      offRangeRoots: 0, anchorAbsoluteErrorPx: 0 };
    expect(recomputeGeometry(geometryRecord)).toEqual({ error: 0, blank: false, offRange: 0, mounted: 2, directChildren: 8 });
    expect(recomputeGeometry({ ...geometryRecord, anchorGeometry: { ...record.anchorGeometry,
      post: { ...record.anchorGeometry.post, scrollTop: 22 } } })?.error).toBe(2);
    const outcomeRecord = { rawEvents: [
      { type: 'before', canonicalOrdinal: 4 }, { type: 'action', accepted: true },
      { type: 'callback', stale: true, applied: false }, { type: 'patch', applied: true },
      { type: 'after', canonicalOrdinal: 4, deferredPending: true },
    ] };
    expect(reduceOutcome(outcomeRecord)).toEqual({ canonical: true, actions: true,
      staleRejected: true, deferredPending: true, patches: 1 });
    expect(reduceOutcome({ rawEvents: outcomeRecord.rawEvents.filter((event: any) => event.type !== 'callback') }).staleRejected)
      .toBe(false);
  });
});

describe('A2.5R outer bounded recovery without legacy', () => {
  function outerHarness(initialFailure = '', options: { rawAnomaly?: boolean; failedSession?: boolean; route?: string } = {}) {
    const roots = [{ dataset: { renderUnitKey: 'accepted' } }];
    const keyedState = { sessionId: 'session-a', items: [{ key: 'accepted' }], roots: new Map([['accepted', roots[0]]]) };
    const calls: string[] = [];
    let failure = initialFailure;
    const windowObject: any = {
      __ocRendering: {
        deriveRenderUnits: () => {
          calls.push('projection');
          if (failure === 'projection') throw new Error('projection');
          return [{ key: 'accepted' }];
        },
      },
    };
    const markers = [
      'function recordChatWindowOuterRecovery(', 'function completeChatWindowOuterRecovery(',
      'function renderFromState()',
    ];
    const context = executeFunctions(markers, {
      KEYED_CHAT_RECONCILE_ENABLED: true,
      CHAT_WINDOW_MOUNT_LIMIT: 140, CHAT_WINDOW_DIRECT_CHILD_LIMIT: 146,
      CHAT_WINDOW_RAW_AUDIT_ACCEPTED_ROUTES: new Set([
        'containment-policy-disabled-virtualized', 'outer-virtualized-baseline',
        'window-unavailable-bootstrap', 'window', 'window-recovered',
      ]),
      activeSessionId: 'session-a', chatWindowGeneration: 9,
      keyedChatFailedSessionId: options.failedSession ? 'session-a' : '',
      chatWindowOuterRecovery: Object.freeze({ status: 'idle', sessionId: '', generation: -1, reason: 'none', rawIntegrity: null }),
      chatWindowEmergencyState: Object.freeze({ status: 'idle', sessionId: '', generation: -1, root: null, codes: [] }),
      chatStructuralRootReservations: new Set(),
      keyedChatReconcileState: keyedState,
      chatWindowState: { adapter: { destroy: jest.fn() } },
      chatContainer: { childElementCount: 1 },
      keyedRoots: () => roots,
      getChatStructuralIntegrityRoots: () => options.rawAnomaly ? [{ classified: false }] : [],
      captureChatWindowRawIntegrityAudit: () => {
        calls.push('raw-audit');
        return Object.freeze({
          mountedRootCount: 1, directChildCount: 1, duplicateKeyCount: 0,
          unclassifiedStructuralRootCount: options.rawAnomaly ? 1 : 0, anomaly: options.rawAnomaly === true,
        });
      },
      renderPendingCount: () => undefined,
      getSessionOrNull: () => ({}), buildKeyedRenderCandidates: () => [],
      applyChatWindowOrWave2: () => {
        calls.push('transaction');
        if (failure === 'factory' || failure === 'rich' || failure === 'reconcile') {
          const error: any = new Error(failure);
          error.__ocChatReconcileFailure = {
            operation: failure === 'factory' ? 'create' : failure === 'rich' ? 'presentation' : 'remove',
          };
          throw error;
        }
        return options.route || 'window';
      },
      applyBackgroundSubagentIndicator: () => {
        calls.push('background');
        if (failure === 'background-indicator') throw new Error('background');
        return true;
      },
      countBackgroundIndicatorApplyResult: () => undefined,
      renderQuestionCardInTimeline: () => undefined,
      sessionSearch: { mode: 'text', smartMessageIds: [], open: true, query: 'q' },
      applySmartSessionSearchResults: () => undefined,
      refreshSessionSearchHighlights: () => {
        calls.push('search');
        if (failure === 'search-highlight') throw new Error('search');
      },
      shouldEmitSnapshotOnNextRender: initialFailure === 'snapshot-diagnostic',
      vscode: { postMessage: (message: any) => {
        if (failure === 'snapshot-diagnostic' && message?.payload?.[0] === '[WV][SNAPSHOT_ROUTE]') throw new Error('snapshot');
        calls.push('diagnostic');
      } },
      noteUnclearAnchorCoalescedRenderComplete: () => {
        calls.push('unclear');
        if (failure === 'unclear-anchor') throw new Error('unclear');
      },
      window: windowObject,
      Object, Set, Map, Math, Number, Array, Error,
    });
    return { context, roots, keyedState, calls, windowObject, setFailure: (value: string) => { failure = value; } };
  }

  test('A2.5R-RED1 enumerates zero automatic legacy/full/destroy routes while retaining the definition', () => {
    const outer = extractFunction('function renderFromState()');
    expect(source.match(/renderFromStateLegacy\(\);/g) || []).toHaveLength(0);
    expect(source).toContain('function renderFromStateLegacy()');
    for (const forbidden of [
      'renderFromStateLegacy', "chatContainer.innerHTML = ''", 'destroyChatWindowAdapter',
      'applyKeyedChatReconciliation(session, units)', 'keyedChatReconcileState = { sessionId:',
    ]) expect(outer).not.toContain(forbidden);
  });

  test('real keyed switch/facade entry gate records pending bounded ownership without automatic fallback', () => {
    const disabled = outerHarness('');
    disabled.context.KEYED_CHAT_RECONCILE_ENABLED = false;
    disabled.context.renderFromState();
    expect(disabled.calls).not.toContain('transaction');
    expect(disabled.windowObject.__ocChatWindowOuterRecovery).toEqual(expect.objectContaining({
      status: 'pending', reason: 'keyed-capability-unavailable', generation: 9,
    }));

    const missingFacade = outerHarness('');
    missingFacade.windowObject.__ocRendering = null;
    missingFacade.context.renderFromState();
    expect(missingFacade.calls).not.toContain('transaction');
    expect(missingFacade.context.keyedChatReconcileState).toBe(missingFacade.keyedState);
  });

  test.each([
    'projection', 'factory', 'rich', 'reconcile', 'background-indicator',
    'search-highlight', 'snapshot-diagnostic', 'unclear-anchor',
  ])('A2.5R-RED2 retains bounded ownership for %s exception without corruption classification', (failure) => {
    const harness = outerHarness(failure);
    expect(() => harness.context.renderFromState()).not.toThrow();
    expect(harness.context.keyedChatReconcileState).toBe(harness.keyedState);
    expect(harness.roots).toHaveLength(1);
    expect(harness.context.chatWindowState.adapter.destroy).not.toHaveBeenCalled();
    expect(harness.windowObject.__ocChatWindowOuterRecovery).toEqual(expect.objectContaining({
      status: 'pending', sessionId: 'session-a', generation: 9,
    }));
    expect(harness.windowObject.__ocChatWindowOuterRecovery.reason).not.toContain('corruption');
  });

  test('A2.5R-RED3 retains raw integrity evidence without classifier, emergency, or legacy wiring', () => {
    const outer = extractFunction('function renderFromState()');
    for (const forbidden of ['classifyChatWindowIntegrity', 'emergency', 'renderFromStateLegacy', 'innerHTML']) {
      expect(outer).not.toContain(forbidden);
    }
    const harness = outerHarness('', { rawAnomaly: true });
    harness.context.renderFromState();
    expect(harness.windowObject.__ocChatWindowOuterRecovery).toEqual(expect.objectContaining({
      status: 'pending', reason: 'raw-integrity-anomaly', generation: 9,
      rawIntegrity: expect.objectContaining({ anomaly: true, unclassifiedStructuralRootCount: 1 }),
    }));
    expect(harness.context.keyedChatReconcileState).toBe(harness.keyedState);
  });

  test('retained and retry-pending routes do not enter raw integrity classification', () => {
    for (const route of [
      'window-unavailable-retained', 'window-unavailable-bootstrap-pending',
      'window-recovery-pending', 'window-corruption-emergency-pending',
    ]) {
      const harness = outerHarness('', { rawAnomaly: true, route });
      harness.context.renderFromState();
      expect(harness.calls).not.toContain('raw-audit');
      expect(harness.windowObject.__ocChatWindowOuterRecovery).toEqual(expect.objectContaining({
        status: 'pending', reason: route, rawIntegrity: null,
      }));
    }
  });

  test('retry and session switch replace stale pending ownership and resume the accepted route', () => {
    const harness = outerHarness('projection', { failedSession: true });
    harness.context.renderFromState();
    const stale = harness.windowObject.__ocChatWindowOuterRecovery;
    expect(stale).toEqual(expect.objectContaining({ status: 'pending', generation: 9 }));
    harness.setFailure('');
    harness.context.activeSessionId = 'session-b';
    harness.context.chatWindowGeneration = 10;
    harness.context.renderFromState();
    expect(harness.windowObject.__ocChatWindowOuterRecovery).not.toBe(stale);
    expect(harness.windowObject.__ocChatWindowOuterRecovery).toEqual(expect.objectContaining({
      status: 'healthy', sessionId: 'session-b', generation: 10,
    }));
    expect(harness.calls.filter((entry) => entry === 'transaction')).toHaveLength(1);
  });
});

describe('Wave 3 extracted runtime coordinator', () => {
  function coordinatorHarness(options: { available: boolean; windowError?: Error }) {
    const calls: string[] = [];
    const context = executeFunctions(['function applyChatWindowOrWave2('], {
      activeSessionId: 'session-a',
      chatWindowState: { adapter: null, localOlderSurface: null },
      TANSTACK_CHAT_WINDOW_ENABLED: true,
      CHAT_WINDOW_INITIAL_TAIL: 80,
      CHAT_WINDOW_MOUNT_LIMIT: 140,
      CHAT_WINDOW_DIRECT_CHILD_LIMIT: 146,
      keyedChatReconcileFailure: null,
      keyedRoots: () => [],
      projectChatWindowStructuralRoots: () => 3,
      sessionSearch: { windowTargetKey: '' },
      window: { __ocRendering: { planChatWindowContainment: () => null } },
      vscode: { postMessage: () => undefined },
      isChatWindowAvailable: () => options.available,
      applyWindowedKeyedChatReconciliation: () => {
        calls.push('window');
        if (options.windowError) throw options.windowError;
      },
      applyKeyedChatReconciliation: () => calls.push('wave2'),
      Set, Map, Math, Number, Array, Object,
    });
    return { calls, route: context.applyChatWindowOrWave2({}, [{ key: 'a' }]) };
  }

  test('adapter unavailable without a bounded bootstrap retains pending recovery', () => {
    expect(coordinatorHarness({ available: false })).toEqual({ calls: [], route: 'window-unavailable-bootstrap-pending' });
  });

  test('adapter error without exact create/replace ownership retains pending recovery', () => {
    expect(coordinatorHarness({ available: true, windowError: new Error('adapter failed') })).toEqual({
      calls: ['window'], route: 'window-recovery-pending',
    });
  });

  test('A2.3-RED1 pressure audits are privacy-safe and never throw or fail over', () => {
    const warnings: unknown[][] = [];
    const windowObject: Record<string, unknown> = {};
    const calls: string[] = [];
    let descendants = 4000;
    const context = executeFunctions([
      'function destroyChatWindowAdapter(', 'function disableChatWindowForSession(',
      'function assertChatWindowDomBudget(', 'function applyChatWindowOrWave2(',
    ], {
      CHAT_WINDOW_MOUNT_LIMIT: 140,
      CHAT_WINDOW_DIRECT_CHILD_LIMIT: 146,
      CHAT_WINDOW_INITIAL_TAIL: 80,
      TANSTACK_CHAT_WINDOW_ENABLED: true,
      activeSessionId: 'session-a',
      window: windowObject,
      console: { warn: (...args: unknown[]) => warnings.push(args) },
      Error,
      chatWindowGeneration: 1,
      chatWindowState: {
        adapter: { destroy: () => calls.push('destroy') }, snapshot: {}, mountedKeys: new Set(), sessionId: 'session-a',
        pendingRangeRender: false, topSpacer: { remove: () => calls.push('top') },
        bottomSpacer: { remove: () => calls.push('bottom') }, failedSessionId: '', localOlderSurface: null,
        localOlderObserver: null,
      },
      chatLocalHistoryController: { complete: () => undefined },
      destroyChatLocalOlderSurface: () => undefined,
      chatContainer: { classList: { remove: () => calls.push('class') } },
      vscode: { postMessage: () => calls.push('diagnostic') },
      isChatWindowAvailable: () => true,
      keyedChatReconcileFailure: null,
      keyedRoots: () => [],
      projectChatWindowStructuralRoots: () => 3,
      sessionSearch: { windowTargetKey: '' },
      applyWindowedKeyedChatReconciliation: () => {
        calls.push('window');
        (context as any).assertChatWindowDomBudget({ mountedUnits: 80, directChildren: 82, descendants });
      },
      applyKeyedChatReconciliation: () => calls.push('wave2'),
      Set, Map, Math, Number, Array, Object,
    });
    for (const budget of [
      { mountedUnits: 141, directChildren: 143, descendants: 100 },
      { mountedUnits: 140, directChildren: 147, descendants: 100 },
      { mountedUnits: 140, directChildren: 146, descendants: 4001 },
      { mountedUnits: 140, directChildren: 146, descendants: 22040 },
    ]) expect(() => context.assertChatWindowDomBudget(budget)).not.toThrow();
    expect(windowObject.__ocChatWindowDomBudgetAudit).toEqual({
      mountedUnits: 140, directChildren: 146, descendants: 22040,
      mountedExceeded: false, directChildrenExceeded: false, descendantsAdvisory: true,
    });
    expect(JSON.stringify(windowObject.__ocChatWindowDomBudgetAudit)).not.toContain('session-a');
    expect(context.applyChatWindowOrWave2({}, [])).toBe('window');
    expect(calls).toEqual(['window']);
    descendants = 4001;
    expect(context.applyChatWindowOrWave2({}, [])).toBe('window');
    expect(warnings).toHaveLength(0);
    expect(calls).toEqual(['window', 'window']);
    expect((context as any).chatWindowState.failedSessionId).toBe('');
  });

  test('spacers retain top/keyed/bottom ordering and expected offsets', () => {
    const operations: string[] = [];
    const keyedRoot = { id: 'keyed' };
    const top = { id: 'top', style: {} };
    const bottom = { id: 'bottom', style: {} };
    const context = executeFunctions(['function updateChatWindowSpacers('], {
      ensureChatWindowSpacers: () => operations.push('ensure'),
      preflightChatRenderRootAdmission: () => ({ allowed: true }),
      chatStructuralRootReservations: new Set(),
      chatWindowState: { topSpacer: top, bottomSpacer: bottom },
      keyedRoots: () => [keyedRoot],
      chatContainer: {
        insertBefore: (node: any, before: any) => operations.push(`insert:${node.id}:${before.id}`),
        appendChild: (node: any) => operations.push(`append:${node.id}`),
      },
      Math,
    });
    context.updateChatWindowSpacers({ items: [{ start: 120, end: 200 }], totalSize: 500 });
    expect(top.style).toEqual({ height: '120px' });
    expect(bottom.style).toEqual({ height: '300px' });
    expect(operations).toEqual(['ensure', 'insert:top:keyed', 'append:bottom']);
  });

  test('destroy and search mount execute adapter lifecycle without stale ownership', () => {
    const calls: string[] = [];
    const classList = { remove: (name: string) => calls.push(`class:${name}`) };
    const context = executeFunctions(['function destroyChatWindowAdapter(', 'function mountChatWindowSearchKey('], {
      chatWindowGeneration: 4,
      chatWindowState: {
        adapter: { destroy: () => calls.push('destroy'), scrollToKey: () => true }, snapshot: {}, mountedKeys: new Set(['a']),
        sessionId: 'old', pendingRangeRender: true, topSpacer: { remove: () => calls.push('top') },
        bottomSpacer: { remove: () => calls.push('bottom') }, activityBelow: false, allUnits: [{ key: 'old-key' }],
        localOlderSurface: null, localOlderObserver: null,
      },
      activeSessionId: 'old',
      chatLocalHistoryController: { complete: () => undefined, revealToKey: () => true },
      destroyChatLocalOlderSurface: () => undefined,
      tryPendingChatWindowScroll: () => { calls.push('pending-scroll'); return true; },
      chatContainer: { classList },
      vscode: { postMessage: () => undefined },
      isChatWindowAvailable: () => true,
      sessionSearch: { windowTargetKey: '' },
      autoScrollPinnedToBottom: false,
      scheduleRenderFromState: (reason: string) => calls.push(reason),
      Set,
    });
    expect(context.mountChatWindowSearchKey('old-key', 'search')).toBe(true);
    expect(calls).toContain('window-search');
    context.destroyChatWindowAdapter('session-switch');
    expect(calls).toEqual(expect.arrayContaining(['destroy', 'top', 'bottom', 'class:chat-window-active']));
  });
});

describe('A2.4 bounded virtualized exception recovery', () => {
  test('RED1 coordinator has no automatic disable, destroy, failed-session, all-units, or legacy route', () => {
    const route = extractFunction('function applyChatWindowOrWave2(');
    for (const forbidden of [
      'disableChatWindowForSession', 'destroyChatWindowAdapter', 'failedSessionId',
      'renderFromStateLegacy', 'applyKeyedChatReconciliation(session, units)',
    ]) expect(route).not.toContain(forbidden);
    expect(route).toContain('applyTransactionalWindow([shellRequest])');
    expect(route).toContain("publishRecovery('recovered', 'safe-shell', true, false)");
    expect(extractFunction('function renderFromState()')).toContain('recordChatWindowOuterRecovery');
  });

  test('RED2 create/replace ownership selects one truthful A1S family and retries the planner once', () => {
    const calls: any[] = [];
    const diagnostics: any[] = [];
    const context = executeFunctions(['function applyChatWindowOrWave2('], {
      TANSTACK_CHAT_WINDOW_ENABLED: true,
      CHAT_WINDOW_INITIAL_TAIL: 80,
      CHAT_WINDOW_MOUNT_LIMIT: 140,
      CHAT_WINDOW_DIRECT_CHILD_LIMIT: 146,
      activeSessionId: 'PRIVATE_SESSION',
      keyedChatReconcileFailure: null,
      chatWindowState: { adapter: {}, mountedKeys: new Set(['accepted']), anchorKey: 'accepted', pendingScrollKey: 'accepted' },
      keyedRoots: () => [{ dataset: { renderUnitKey: 'accepted' } }],
      isChatWindowAvailable: () => true,
      projectChatWindowStructuralRoots: () => 3,
      sessionSearch: { windowTargetKey: 'accepted' },
      window: { __ocRendering: { planChatWindowContainment: (request: any) => ({
        allowed: true, acceptedKeys: request.requestedKeys, shellSelections: {},
      }) } },
      vscode: { postMessage: (value: any) => diagnostics.push(value) },
      applyKeyedChatReconciliation: () => calls.push('outer-baseline'),
      applyWindowedKeyedChatReconciliation: (_session: any, passedUnits: any[], requests: any[] = []) => {
        calls.push({ unitCount: passedUnits.length, requests });
        if (calls.length === 1) {
          const error: any = new Error('PRIVATE_CONTENT');
          error.__ocChatReconcileFailure = { key: 'bad', operation: 'replace' };
          throw error;
        }
        return passedUnits.slice(-2);
      },
      Set, Map, Math, Number, Array, Object,
    });
    const units = [
      { key: 'accepted', kind: 'message', value: { message: { role: 'user' } } },
      { key: 'bad', kind: 'message', value: { message: { role: 'assistant', text: 'ordinary' } } },
    ];
    expect(context.applyChatWindowOrWave2({}, units)).toBe('window-recovered');
    expect(calls).toEqual([
      { unitCount: 2, requests: [] },
      { unitCount: 2, requests: [{ key: 'bad', mode: 'safe-shell', family: 'message-assistant' }] },
    ]);
    expect(diagnostics).toHaveLength(1);
    expect(JSON.stringify(diagnostics)).not.toContain('PRIVATE_');
  });

  test('RED3 retry failure retains bounded roots and publishes privacy-safe pending recovery', () => {
    const roots = [{ dataset: { renderUnitKey: 'accepted' } }];
    const calls: string[] = [];
    const windowObject: any = { __ocRendering: { planChatWindowContainment: () => null } };
    const context = executeFunctions(['function applyChatWindowOrWave2('], {
      TANSTACK_CHAT_WINDOW_ENABLED: true,
      CHAT_WINDOW_INITIAL_TAIL: 80,
      CHAT_WINDOW_MOUNT_LIMIT: 140,
      CHAT_WINDOW_DIRECT_CHILD_LIMIT: 146,
      activeSessionId: 'PRIVATE_SESSION',
      keyedChatReconcileFailure: null,
      chatWindowState: { adapter: {}, mountedKeys: new Set(['accepted']), anchorKey: 'accepted', pendingScrollKey: 'accepted' },
      keyedRoots: () => roots,
      isChatWindowAvailable: () => true,
      projectChatWindowStructuralRoots: () => 3,
      sessionSearch: { windowTargetKey: 'accepted' },
      window: windowObject,
      vscode: { postMessage: (value: any) => calls.push(JSON.stringify(value)) },
      applyKeyedChatReconciliation: () => calls.push('forbidden-baseline'),
      applyWindowedKeyedChatReconciliation: () => {
        const error: any = new Error('PRIVATE_CONTENT');
        error.__ocChatReconcileFailure = { key: 'PRIVATE_KEY', operation: 'create' };
        throw error;
      },
      Set, Map, Math, Number, Array, Object,
    });
    const unit = { key: 'PRIVATE_KEY', kind: 'message', value: { message: { role: 'user' } } };
    expect(context.applyChatWindowOrWave2({}, [unit])).toBe('window-recovery-pending');
    expect(calls).toHaveLength(1);
    expect(roots).toHaveLength(1);
    expect(windowObject.__ocChatWindowRecovery).toEqual({
      status: 'retained', reason: 'retry-failed', retryAttempted: true,
      retryPending: true, boundedRootCount: 1,
    });
    expect(JSON.stringify({ calls, recovery: windowObject.__ocChatWindowRecovery })).not.toContain('PRIVATE_');
  });

  test('RED4 switch-off and adapter loss retain or use the accepted capped transactional bootstrap', () => {
    const run = (options: { enabled: boolean; roots: number; unitCount: number }) => {
      const applied: any[] = [];
      const roots = Array.from({ length: options.roots }, (_, index) => ({ dataset: { renderUnitKey: `old-${index}` } }));
      const context = executeFunctions(['function applyChatWindowOrWave2('], {
        TANSTACK_CHAT_WINDOW_ENABLED: options.enabled,
        CHAT_WINDOW_INITIAL_TAIL: 80,
        CHAT_WINDOW_MOUNT_LIMIT: 140,
        CHAT_WINDOW_DIRECT_CHILD_LIMIT: 146,
        activeSessionId: 'session-a', keyedChatReconcileFailure: null,
        chatWindowState: { adapter: null, mountedKeys: new Set(), anchorKey: '', pendingScrollKey: '' },
        keyedRoots: () => roots,
        isChatWindowAvailable: () => false,
        projectChatWindowStructuralRoots: () => 3,
        sessionSearch: { windowTargetKey: '' },
        window: { __ocRendering: { planChatWindowContainment: (request: any) => ({
          allowed: true, acceptedKeys: request.requestedKeys, shellSelections: Object.fromEntries(
            request.shellRequests.map((entry: any) => [entry.key, entry]),
          ),
        }) } },
        vscode: { postMessage: () => undefined },
        applyWindowedKeyedChatReconciliation: (_session: any, units: any[], selections: any) => {
          applied.push({ units, selections, virtualized: true });
          return units;
        },
        applyAcceptedOuterTransactionalBootstrap: (_session: any, units: any[], _requests: any[], plan: any) => {
          applied.push({ units, selections: plan.shellSelections, virtualized: true, transactional: true });
          return units;
        },
        applyKeyedChatReconciliation: () => { throw new Error('forbidden direct keyed bootstrap'); },
        Set, Map, Math, Number, Array, Object,
      });
      const units = Array.from({ length: options.unitCount }, (_, index) => ({
        key: `k${index}`, kind: 'message', value: { message: { role: 'user' } },
      }));
      return { route: context.applyChatWindowOrWave2({}, units), applied };
    };
    const switchedOff = run({ enabled: false, roots: 0, unitCount: 145 });
    expect(switchedOff.route).toBe('outer-virtualized-baseline');
    expect(switchedOff.applied[0].units).toHaveLength(80);
    expect(switchedOff.applied[0].units[0].key).toBe('k65');
    expect(switchedOff.applied[0]).toEqual(expect.objectContaining({ selections: [], virtualized: true }));

    expect(run({ enabled: true, roots: 2, unitCount: 145 })).toEqual({ route: 'window-unavailable-retained', applied: [] });
    const bootstrap = run({ enabled: true, roots: 0, unitCount: 145 });
    expect(bootstrap.route).toBe('window-unavailable-bootstrap');
    expect(bootstrap.applied[0].units).toHaveLength(80);
    expect(Object.keys(bootstrap.applied[0].selections)).toHaveLength(80);
    expect(bootstrap.applied[0]).toEqual(expect.objectContaining({ transactional: true }));
  });
});

describe('A2.4R transactional bounded recovery coordinator', () => {
  const coordinatorContext = (windowAttempt: (...args: any[]) => any) => {
    const calls: any[] = [];
    const windowObject: any = { __ocRendering: { planChatWindowContainment: () => null } };
    const context = executeFunctions(['function applyChatWindowOrWave2('], {
      TANSTACK_CHAT_WINDOW_ENABLED: true,
      CHAT_WINDOW_INITIAL_TAIL: 80,
      CHAT_WINDOW_MOUNT_LIMIT: 140,
      CHAT_WINDOW_DIRECT_CHILD_LIMIT: 146,
      activeSessionId: 'session-a', keyedChatReconcileFailure: null,
      chatWindowState: { adapter: {}, anchorKey: '', pendingScrollKey: '', mountedKeys: new Set() },
      keyedRoots: () => [], isChatWindowAvailable: () => true,
      projectChatWindowStructuralRoots: () => 3, sessionSearch: { windowTargetKey: '' },
      window: windowObject, vscode: { postMessage: (value: any) => calls.push(value) },
      applyKeyedChatReconciliation: () => { throw new Error('forbidden outer baseline'); },
      applyWindowedKeyedChatReconciliation: windowAttempt,
      Set, Map, Math, Number, Array, Object,
    });
    return { context, calls, windowObject };
  };

  test('A2.4R-RED2 selects each exact truthful family once and rejects ambiguous or unknown shapes', () => {
    const cases: Array<[string, any]> = [
      ['message-user', { key: 'k', kind: 'message', value: { message: { role: 'user' } } }],
      ['message-assistant', { key: 'k', kind: 'message', value: { message: { role: 'assistant', text: 'plain' } } }],
      ['message-tool-meta', { key: 'k', kind: 'message', value: { message: { role: 'tool', meta: {} } } }],
      ['message-subagent', { key: 'k', kind: 'message', value: { message: { role: 'assistant', meta: { subagents: [{}] } } } }],
      ['change-list', { key: 'k', kind: 'change-list', value: { message: { role: 'system', meta: { kind: 'changeList', files: ['a'] } } } }],
      ['segment', { key: 'k', kind: 'segment', value: { segment: {} } }],
      ['conflict', { key: 'k', kind: 'conflict', value: { conflicts: [{}] } }],
      ['message-image', { key: 'k', kind: 'message', value: { message: { role: 'assistant', meta: { images: [{}] } } } }],
      ['message-code', { key: 'k', kind: 'message', value: { message: { role: 'assistant', text: '```ts\nconst x = 1;\n```' } } }],
      ['message-diff', { key: 'k', kind: 'message', value: { message: { role: 'assistant', meta: { isDiff: true } } } }],
      ['message-table', { key: 'k', kind: 'message', value: { message: { role: 'assistant', text: '| A |\n| --- |\n| x |' } } }],
      ['message-markdown', { key: 'k', kind: 'message', value: { message: { role: 'assistant', text: '# Heading' } } }],
    ];
    for (const [family, unit] of cases) {
      const attempts: any[] = [];
      const { context } = coordinatorContext((_session, _units, requests = []) => {
        attempts.push(requests);
        if (attempts.length === 1) {
          const error: any = new Error('injected');
          error.__ocChatReconcileFailure = { key: 'k', operation: 'create' };
          throw error;
        }
        return [unit];
      });
      expect(context.applyChatWindowOrWave2({}, [unit])).toBe('window-recovered');
      expect(attempts).toEqual([[], [{ key: 'k', mode: 'safe-shell', family }]]);
    }

    for (const unit of [
      { key: 'k', kind: 'message', value: { message: { role: 'assistant', text: '# Heading\n```ts\nx\n```' } } },
      { key: 'k', kind: 'message', value: { message: { role: 'assistant', meta: { images: [{}], isDiff: true } } } },
      { key: 'k', kind: 'message', value: { message: { role: 'assistant', meta: { isThinking: true } } } },
    ]) {
      let attempts = 0;
      const { context } = coordinatorContext(() => {
        attempts += 1;
        const error: any = new Error('injected');
        error.__ocChatReconcileFailure = { key: 'k', operation: 'create' };
        throw error;
      });
      expect(context.applyChatWindowOrWave2({}, [unit])).toBe('window-recovery-pending');
      expect(attempts).toBe(1);
    }

    let removeAttempts = 0;
    const { context: removeContext } = coordinatorContext(() => {
      removeAttempts += 1;
      const error: any = new Error('remove failed');
      error.__ocChatReconcileFailure = { key: 'k', operation: 'remove' };
      throw error;
    });
    expect(removeContext.applyChatWindowOrWave2({}, [cases[0][1]])).toBe('window-recovery-pending');
    expect(removeAttempts).toBe(1);
  });

  test('A2.4R-RED4 runs correction as a nonnested second transaction and retains committed C1 on failure', () => {
    const calls: any[] = [];
    const c1 = Object.freeze({ owner: 'C1' });
    let current: Readonly<{ owner: string }> = Object.freeze({ owner: 'C0' });
    const { context, windowObject } = coordinatorContext((_session, _units, requests = [], control: any = {}) => {
      calls.push({ requests, control: { ...control }, before: current });
      if (!control.acceptedPlanOverride) {
        current = c1;
        control.correctedPlan = { allowed: true, acceptedKeys: ['reduced'], mountedCount: 1, directChildCount: 3, shellSelections: {} };
        return ['full'];
      }
      expect(control.skipCorrection).toBe(true);
      expect(current).toBe(c1);
      throw new Error('correction failed');
    });
    expect(context.applyChatWindowOrWave2({}, [{ key: 'full' }])).toBe('window-correction-retained');
    expect(calls).toHaveLength(2);
    expect(calls[1].before).toBe(c1);
    expect(current).toBe(c1);
    expect(windowObject.__ocChatWindowRecovery).toEqual(expect.objectContaining({ reason: 'correction-failed' }));
  });

  test('A2.4R-RED7 rejects substituted coordinator/windowed/keyed/journal implementations', () => {
    const assertAuthentic = (candidate: any) => {
      const sourceOf = (value: any) => typeof value === 'string' ? value : Function.prototype.toString.call(value);
      const coordinator = sourceOf(candidate.applyChatWindowOrWave2);
      const windowed = sourceOf(candidate.applyWindowedKeyedChatReconciliation);
      const keyed = sourceOf(candidate.applyKeyedChatReconciliation);
      const abort = sourceOf(candidate.abortChatPresentationJournal);
      if (!coordinator.includes('applyTransactionalWindow')
        || !windowed.includes('beginChatPresentationJournal')
        || !keyed.includes('__ocChatReconcileFailure')
        || !abort.includes('restoreChatWindowAcceptedState')) {
        throw new Error('test-owned R transaction path is forbidden');
      }
    };
    expect(() => assertAuthentic({
      applyChatWindowOrWave2: () => undefined,
      applyWindowedKeyedChatReconciliation: () => undefined,
      applyKeyedChatReconciliation: () => undefined,
      abortChatPresentationJournal: () => undefined,
    })).toThrow('test-owned R transaction path is forbidden');
    expect(() => assertAuthentic({
      applyChatWindowOrWave2: extractFunction('function applyChatWindowOrWave2('),
      applyWindowedKeyedChatReconciliation: extractFunction('function applyWindowedKeyedChatReconciliation('),
      applyKeyedChatReconciliation: extractFunction('function applyKeyedChatReconciliation('),
      abortChatPresentationJournal: extractFunction('function abortChatPresentationJournal('),
    })).not.toThrow();
  });
});

describe('A2.4D journaled keyed and structural transaction', () => {
  describe('B4-BH shared transaction harness contract', () => {
    const helperPath = path.join(process.cwd(), 'scripts', 'chat-window-adaptive-range-harness.js');
    const retiredName = ['retiredTransaction', 'Fixture'].join('');

    test('B4-BH-HARNESS-RED shared CommonJS helper is the sole inert harness owner', () => {
      expect(fs.existsSync(helperPath)).toBe(true);
      if (!fs.existsSync(helperPath)) return;

      const helperSource = fs.readFileSync(helperPath, 'utf8');
      const beforeGlobals = new Set(Object.getOwnPropertyNames(globalThis));
      const beforeArgv = [...process.argv];
      const first = require(helperPath);
      delete require.cache[require.resolve(helperPath)];
      const second = require(helperPath);

      expect(first).toEqual(expect.objectContaining({ createRealTransactionHarness: expect.any(Function) }));
      expect(second).toEqual(expect.objectContaining({ createRealTransactionHarness: expect.any(Function) }));
      expect(new Set(Object.getOwnPropertyNames(globalThis))).toEqual(beforeGlobals);
      expect(process.argv).toEqual(beforeArgv);
      expect(helperSource).not.toMatch(/child_process|execFile|spawn|writeFile|appendFile/);
      expect(helperSource).not.toMatch(/wave3-main-contract|chat-window-adaptive-range-synthetic/);
      expect(helperSource).not.toMatch(/rangePolicy|overscanTier|initialTail|b4WorkflowNames|reduceExternalOutcome/);
      expect(helperSource).not.toMatch(/trace|smoke|deferredPending|hardcodedSuccessSites/);
      expect(helperSource).not.toMatch(/function executeFunctions|vm\.createContext|exactEndMarkers/);
      expect((helperSource.match(/function createRealTransactionHarness\s*\(/g) || [])).toHaveLength(1);
      expect((wave3TestSource.match(/function realTransactionHarness\s*\(/g) || [])).toHaveLength(0);
      expect(wave3TestSource).not.toContain(retiredName);
    });

    test('B4-BH-HARNESS-RED consumer retains exactly 38 calls through a thin alias', () => {
      expect((wave3TestSource.match(/realTransactionHarness\s*\(/g) || [])).toHaveLength(38);
      expect(wave3TestSource).toContain('const realTransactionHarness = createRealTransactionHarness');
      const ownerStart = wave3TestSource.lastIndexOf('const realTransactionHarness = createRealTransactionHarness');
      const ownerEnd = wave3TestSource.lastIndexOf('const b4AttemptInputs =');
      expect(ownerStart).toBeGreaterThanOrEqual(0);
      expect(ownerEnd).toBeGreaterThan(ownerStart);
      const compatibilityAlias = wave3TestSource.slice(ownerStart, ownerEnd);
      const migrationStart = wave3TestSource.lastIndexOf('type RealTransactionHarnessOptions =');
      const migrationSlice = wave3TestSource.slice(migrationStart, ownerEnd);
      expect((wave3TestSource.match(/executeFunctions\s*\(/g) || [])).toHaveLength(24);
      for (const duplicatedOwner of [
        'const markers = [',
        'const makeNode = (key',
        'const adapterTransaction:',
        'const context = executeFunctions(markers,',
      ]) expect(compatibilityAlias).not.toContain(duplicatedOwner);
      for (const duplicateImplementation of [
        retiredName, 'const listeners = new Map<string', 'class ActualVirtualizer',
        'class ActualResizeObserver', 'const adapterTransaction:', 'const markers = [',
        '(executeFunctions as any)(markers,', 'planChatWindowContainment(request)',
        "adapter.beginTransaction(adapterUpdate)", 'beginChatPresentationJournal(',
        'applyKeyedChatReconciliation(session, acceptedUnits',
      ]) expect(migrationSlice).not.toContain(duplicateImplementation);
    });
  });

  const acceptedState = () => extractFunction('function captureChatWindowAcceptedState(');
  const beginJournal = () => extractFunction('function beginChatPresentationJournal(');
  const abortJournal = () => extractFunction('function abortChatPresentationJournal(');
  const finalizeJournal = () => extractFunction('function finalizeChatPresentationJournal(');

  type RealTransactionHarnessOptions = {
    failOnce?: boolean;
    units?: any[];
    missingBeginTransaction?: boolean;
    noLiveAdapter?: boolean;
    viewportStart?: number;
  };
  type RealTransactionHarnessResult = {
    context: any; units: any[]; chatContainer: any; chatWindowState: any; windowObject: any;
    originalChildren: any[]; oldItems: any[]; oldRoots: Map<string, any>; oldSnapshot: any; oldRecovery: any;
    disposed: string[]; calls: string[]; top: any; local: any; oldObserver: any; attemptedObserver: any;
    retainedAdapterConfig: any; retainedObservations: Set<any>; readonly adapterOwner: string; adapter: any;
    actualConstructions: any[]; actualObservers: any[]; pressureLifecycle: any; preparedAttemptRoots: any[];
    scheduledFrames: Array<() => void>; makeNode: (key?: string, id?: string) => any;
    failureStageCounts: Map<string, number>; containmentRequests: any[]; transactionUnitCounts: number[];
    canonicalSession: any; atomic: any;
  };
  type RealTransactionHarness = (
    failStage?: string, useRealAdapter?: boolean, harnessOptions?: RealTransactionHarnessOptions,
  ) => RealTransactionHarnessResult;

  const realTransactionHarness = createRealTransactionHarness({
    execute: executeFunctions,
    makeSpy: () => jest.fn(),
    createAdapter: createTanStackVirtualAdapter,
    planContainment: planChatWindowContainment,
    classifyIntegrity: classifyChatWindowIntegrity,
    safeShellSpec: getSafeShellSpec,
  }) as RealTransactionHarness;
  const cf2TransactionHarness = realTransactionHarness;
  const executeCf2Functions = executeFunctions;
  const atomicScenarioExecutor = createAtomicScenarioExecutor({
    execute: executeFunctions,
    makeSpy: () => jest.fn(),
    createAdapter: createTanStackVirtualAdapter,
    planContainment: planChatWindowContainment,
    classifyIntegrity: classifyChatWindowIntegrity,
    safeShellSpec: getSafeShellSpec,
  });

  const b4AttemptInputs = () => {
    const inputs: any[] = [];
    for (const overscanTier of [20, 10, 4]) for (const initialTail of [80, 40, 24]) {
      for (const direction of ['forward', 'backward']) for (const region of [
        { name: 'old', start: 20 }, { name: 'current', start: 160 },
      ]) inputs.push({ overscanTier, initialTail, direction, region: region.name, viewportStart: region.start });
    }
    return inputs;
  };
  const b4AttemptKey = (value: any) => `${value.overscanTier}/${value.initialTail}/${value.direction}/${value.region}`;
  const normalizeExternalEvents = (events: any[]) => events.map((event) => ({
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
    ...(typeof event.workflow === 'string' ? { workflow: event.workflow } : {}),
    ...(typeof event.phase === 'string' ? { phase: event.phase } : {}),
    ...(typeof event.accepted === 'boolean' ? { accepted: event.accepted } : {}),
    ...(typeof event.stale === 'boolean' ? { stale: event.stale } : {}),
    ...(typeof event.applied === 'boolean' ? { applied: event.applied } : {}),
    ...(Number.isFinite(event.canonicalOrdinal) ? { canonicalOrdinal: event.canonicalOrdinal } : {}),
    ...(typeof event.deferredPending === 'boolean' ? { deferredPending: event.deferredPending } : {}),
  }));
  const collectB4ExternalSpyMap = () => {
    const spyMap = new Map<string, any>();
    const units = Array.from({ length: 220 }, (_, unitIndex) => ({
      key: `unit-${unitIndex}`, kind: 'greeting', revision: `revision-${unitIndex}`, value: null,
    }));
    b4AttemptInputs().forEach((input, index) => {
      const attemptOrdinal = index + 1;
      const ordinal = { ownerOrdinal: attemptOrdinal, tokenOrdinal: attemptOrdinal,
        optionAttemptOrdinal: attemptOrdinal, handleOrdinal: attemptOrdinal };
      const harness = realTransactionHarness('', true, { viewportStart: input.viewportStart, units });
      const events: any[] = [];
      const witness = (type: string, detail: any = {}) => events.push({ type, ...ordinal, ...detail });
      harness.chatContainer.scrollTop = 11 + attemptOrdinal;
      harness.top.style.height = `${7 + attemptOrdinal}px`;
      witness('geometry-pre', {
        viewportStart: input.viewportStart, viewportEnd: input.viewportStart + 11,
        preScrollTop: harness.chatContainer.scrollTop, scrollTop: harness.chatContainer.scrollTop,
        anchorIndex: input.viewportStart + 3, anchorOffset: (input.viewportStart + 3) * (41 + attemptOrdinal),
        anchorVisualPosition: (input.viewportStart + 3) * (41 + attemptOrdinal) - harness.chatContainer.scrollTop,
        topSpacerHeight: Number.parseFloat(harness.top.style.height) || 0,
        bottomSpacerHeight: Number.parseFloat(harness.chatWindowState.bottomSpacer?.style?.height) || 0,
        directRootCount: harness.chatContainer.childElementCount,
      });
      const optionIndex = Math.floor(index / 4);
      const request = {
        optionIndex, overscanTier: input.overscanTier, initialTail: input.initialTail,
        forwardReserve: input.overscanTier === 20 ? 13 : input.overscanTier === 10 ? 7 : 3,
        backwardReserve: input.overscanTier === 20 ? 7 : input.overscanTier === 10 ? 3 : 1,
        attempt: attemptOrdinal,
      };
      const token = Object.freeze({});
      let armed = true;
      witness('attempt-arm');
      harness.context.consumeChatWindowSyntheticEvidenceRequest = (candidate: any) => {
        if (!armed || candidate !== token) return null;
        armed = false;
        witness('attempt-consume');
        witness('transaction-begin');
        return request;
      };
      let journalObserved = false;
      const originalJournal = harness.context.beginChatPresentationJournal;
      harness.context.beginChatPresentationJournal = (...args: any[]) => {
        journalObserved = true;
        return originalJournal(...args);
      };
      const originalKeyed = harness.context.applyKeyedChatReconciliation;
      harness.context.applyKeyedChatReconciliation = (...args: any[]) => {
        witness('keyed-apply');
        return originalKeyed(...args);
      };
      const originalPlanner = harness.windowObject.__ocRendering.planChatWindowContainment;
      harness.windowObject.__ocRendering.planChatWindowContainment = (...args: any[]) => {
        const result = originalPlanner(...args);
        witness('planner');
        if (journalObserved) witness('journal-begin');
        return result;
      };
      const originalBegin = harness.adapter.beginTransaction.bind(harness.adapter);
      let sealed = false;
      let finalized = false;
      harness.adapter.beginTransaction = (...args: any[]) => {
        const handle = originalBegin(...args);
        if (!handle) return handle;
        const getRange = handle.getRange.bind(handle);
        const commit = handle.commit.bind(handle);
        const finalize = handle.finalizeCommit.bind(handle);
        const abort = handle.abort.bind(handle);
        handle.getRange = () => {
          const snapshot = getRange();
          witness('adapter-range', {
            mountedIndexes: snapshot.items.map((item: any) => item.index),
            acceptedIndexes: snapshot.items.map((item: any) => item.index),
            mountedSizes: snapshot.items.map((item: any) => item.size),
            itemHeights: snapshot.items.map((item: any) => item.end - item.start),
            viewportStart: input.viewportStart,
            viewportEnd: input.viewportStart + 11,
            directRootCount: harness.chatContainer.childElementCount,
            overscanTier: input.overscanTier, beforeReserve: args[0].rangePolicy.beforeReserve,
            afterReserve: args[0].rangePolicy.afterReserve, initialTail: input.initialTail,
          });
          return snapshot;
        };
        handle.commit = () => { sealed = commit(); return sealed; };
        handle.finalizeCommit = () => { finalized = finalize(); return finalized; };
        handle.abort = () => { witness('transaction-abort'); return abort(); };
        return handle;
      };
      const route = harness.context.applyWindowedKeyedChatReconciliation(harness.canonicalSession, units, [], {
        syntheticEvidenceToken: token, syntheticEvidenceDirection: input.direction,
      });
      const postAnchorOffset = (input.viewportStart + 3) * (41 + attemptOrdinal);
      witness('anchor-observation', { anchorIndex: input.viewportStart + 3,
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
        viewportStart: input.viewportStart, viewportEnd: input.viewportStart + 11,
        postScrollTop: harness.chatContainer.scrollTop, scrollTop: harness.chatContainer.scrollTop,
        anchorIndex: input.viewportStart + 3, anchorOffset: postAnchorOffset,
        anchorVisualPosition: postAnchorOffset - harness.chatContainer.scrollTop,
        topSpacerHeight: Number.parseFloat(harness.top.style.height) || 0,
        bottomSpacerHeight: Number.parseFloat(harness.chatWindowState.bottomSpacer?.style?.height) || 0,
        directRootCount: harness.chatContainer.childElementCount, measured: Boolean(observer && measuredTarget), settled: true,
      });
      if (sealed) witness('transaction-seal');
      if (finalized) witness('transaction-finalize');
      spyMap.set(b4AttemptKey(input), { input: { ...input, ...ordinal }, route,
        events: normalizeExternalEvents(events) });
    });
    return spyMap;
  };
  const validateB4OptionRecords = (records: any[], spyMap: Map<string, any>) => {
    const required = ['attempt-arm', 'attempt-consume', 'transaction-begin', 'adapter-range', 'planner',
      'journal-begin', 'keyed-apply', 'anchor-observation', 'spacer-observation', 'scroll-observation',
      'measurement-observation', 'geometry-post', 'transaction-seal', 'transaction-finalize'];
    const handles = new Set<number>();
    const rangeSignatures = new Set<string>();
    const policySignatures = new Set<string>();
    const initialTailCountSignatures = new Set<string>();
    const geometryWitnessSignatures = new Set<string>();
    let matched = 0;
    let coherent = 0;
    let selfAttestationFields = 0;
    for (const observed of spyMap.values()) {
      policySignatures.add(`${observed.input.overscanTier}/${observed.input.initialTail}`);
      for (const event of observed.events) handles.add(event.handleOrdinal);
      const range = observed.events.find((event: any) => event.type === 'adapter-range');
      if (range) {
        rangeSignatures.add(JSON.stringify(range.mountedIndexes));
        initialTailCountSignatures.add(`${range.initialTail}`);
      }
      const pre = observed.events.find((event: any) => event.type === 'geometry-pre');
      const post = observed.events.find((event: any) => event.type === 'geometry-post');
      geometryWitnessSignatures.add(JSON.stringify({ pre, post, range }));
    }
    for (const record of records) {
      if ('independentSpyEvents' in record || 'callCounts' in record || 'functionHashes' in record) selfAttestationFields += 1;
      const key = b4AttemptKey(record);
      const observed = spyMap.get(key);
      if (!observed || !Array.isArray(record.rawEvents)) continue;
      const normalized = normalizeExternalEvents(record.rawEvents);
      if (JSON.stringify(normalized) === JSON.stringify(observed.events)) matched += 1;
      const positions = required.map((type) => normalized.findIndex((event: any) => event.type === type));
      const metadataMatches = normalized.every((event: any) => event.ownerOrdinal === observed.input.ownerOrdinal
        && event.tokenOrdinal === observed.input.tokenOrdinal
        && event.optionAttemptOrdinal === observed.input.optionAttemptOrdinal
        && event.handleOrdinal === observed.input.handleOrdinal)
        && record.overscanTier === observed.input.overscanTier && record.initialTail === observed.input.initialTail
        && record.direction === observed.input.direction && record.region === observed.input.region;
      if (positions.every((position, offset) => position >= 0 && (offset === 0 || position > positions[offset - 1]))
        && metadataMatches) coherent += 1;
    }
    return { attempts: spyMap.size, matched, coherent, uniqueHandles: handles.size,
      policySignatures: policySignatures.size,
      initialTailCountSignatures: initialTailCountSignatures.size,
      rangeVariants: rangeSignatures.size,
      geometryWitnessSignatures: geometryWitnessSignatures.size,
      selfAttestationFields };
  };

  test('B4-RED-0.6 36 external spy streams must coherently match evidence with distinct attempts/handles and option ranges', () => {
    const spyMap = collectB4ExternalSpyMap();
    const evidence = JSON.parse(fs.readFileSync(b4EvidencePath, 'utf8'));
    expect(validateB4OptionRecords(evidence.options, spyMap)).toEqual({
      attempts: 36, matched: 36, coherent: 36, uniqueHandles: 36,
      policySignatures: 9, initialTailCountSignatures: 3, rangeVariants: 12,
      geometryWitnessSignatures: 36,
      selfAttestationFields: 0,
    });
  });

  test('B4-C-RED-3 failure ownership restores exact C0 or accepted degraded state without capability replay', () => {
    const b4CFailureHarness = realTransactionHarness;
    const preBarrierCases = [
      { name: 'planner-denial', stage: '', denyPlanner: true },
      { name: 'adapter-prepare', stage: 'adapter-prepare' },
      { name: 'adapter-seal', stage: 'adapter-commit' },
      { name: 'adapter-finalize-preflight', stage: 'adapter-finalize-preflight' },
      { name: 'journal-prepare', stage: 'factory-prepared' },
      { name: 'journal-apply', stage: 'replace-applied' },
      { name: 'session-generation-switch', stage: '', switchOwner: true },
    ];
    for (const sample of preBarrierCases) {
      const harness = b4CFailureHarness(sample.stage, false);
      const token = Object.freeze({});
      let consumeCount = 0;
      let armed = true;
      harness.context.consumeChatWindowSyntheticEvidenceRequest = (candidate: any) => {
        if (!armed || candidate !== token) return null;
        armed = false;
        consumeCount += 1;
        return { overscanTier: 10, initialTail: 40, forwardReserve: 7, backwardReserve: 3, attempt: 1 };
      };
      if (sample.denyPlanner || sample.switchOwner) {
        const planner = harness.windowObject.__ocRendering.planChatWindowContainment;
        harness.windowObject.__ocRendering.planChatWindowContainment = (...args: any[]) => {
          const plan = planner(...args);
          if (sample.switchOwner) {
            harness.context.activeSessionId = 'session-switched';
            harness.context.chatWindowGeneration += 1;
          }
          return sample.denyPlanner ? { ...plan, allowed: false } : plan;
        };
      }
      try {
        harness.context.applyWindowedKeyedChatReconciliation(harness.canonicalSession, harness.units, [], {
          syntheticEvidenceToken: token, syntheticEvidenceDirection: 'forward',
        });
      } catch { /* expected injected pre-barrier failure */ }
      expect({ sample: sample.name, consumeCount, armed }).toEqual({ sample: sample.name, consumeCount: 1, armed: false });
      expect({ sample: sample.name, childIds: harness.chatContainer.children.map((child: any) => child.id) })
        .toEqual({ sample: sample.name, childIds: harness.originalChildren.map((child: any) => child.id) });
      expect(harness.chatWindowState.snapshot).toBe(harness.oldSnapshot);
      expect(harness.context.keyedChatReconcileState.items).toBe(harness.oldItems);
      expect([...harness.context.keyedChatReconcileState.roots]).toEqual([...harness.oldRoots]);
      expect(harness.chatWindowState.rendering).toBe(false);
      expect(harness.adapterOwner).toBe('old');
      expect(harness.calls.filter((entry: string) => entry === 'adapter-abort').length).toBeLessThanOrEqual(1);
      expect(harness.calls).not.toEqual(expect.arrayContaining(['schedule:window-range-change', 'stale-callback']));
      expect(harness.windowObject).not.toHaveProperty('__ocChatWindowAdaptiveShadow');
      expect(harness.disposed.filter((entry: string) => entry.startsWith('new:')).length)
        .toBe(new Set(harness.disposed.filter((entry: string) => entry.startsWith('new:'))).size);
    }

    const stale = candidateStagingHarness();
    stale.context.prepareUnpublishedChatWindowTransaction({}, stale.units, [], null);
    stale.context.activeSessionId = 'session-stale';
    stale.context.chatWindowGeneration += 1;
    stale.callbacks.onRangeChange({ items: [{ key: 'stale' }], totalSize: 1 });
    expect(stale.calls.filter((entry: string) => entry === 'stale-callback')).toHaveLength(1);
    expect(stale.calls).not.toContain('schedule');

    const degraded = b4CFailureHarness('post-barrier-unexpected');
    expect(degraded.context.applyWindowedKeyedChatReconciliation(degraded.canonicalSession, degraded.units)).toHaveLength(2);
    expect(degraded.adapterOwner).toBe('candidate');
    expect(degraded.calls).not.toContain('adapter-abort');
    expect(degraded.windowObject.__ocChatWindowRecovery).toEqual(expect.objectContaining({ status: 'committed-degraded' }));
    expect(degraded.context.keyedChatReconcileState.items.map((item: any) => item.key).sort()).toEqual(['keep', 'new']);

    const unarmed = b4CFailureHarness('', false);
    let unarmedUpdate: any = null;
    const unarmedBegin = unarmed.adapter.beginTransaction.bind(unarmed.adapter);
    unarmed.adapter.beginTransaction = (update: any) => { unarmedUpdate = update; return unarmedBegin(update); };
    expect(unarmed.context.applyWindowedKeyedChatReconciliation(unarmed.canonicalSession, unarmed.units)).toHaveLength(2);
    expect(unarmedUpdate).not.toHaveProperty('rangePolicy');

    const committedPolicy = Object.freeze({ overscanTier: 10, beforeReserve: 3, afterReserve: 7, initialTail: 40 });
    unarmed.context.resolveChatWindowAdaptiveRangePolicy = () => committedPolicy;
    unarmedUpdate = null;
    let runtimeBeginCount = 0;
    unarmed.adapter.beginTransaction = (update: any) => {
      runtimeBeginCount += 1;
      unarmedUpdate = update;
      return unarmedBegin(update);
    };
    expect(unarmed.context.applyWindowedKeyedChatReconciliation(unarmed.canonicalSession, unarmed.units)).toHaveLength(2);
    expect(unarmedUpdate.rangePolicy).toBe(committedPolicy);
    expect(runtimeBeginCount).toBe(1);
    expect(extractFunction('function applyWindowedKeyedChatReconciliation(')).not.toContain('.update({ rangePolicy');
    expect(extractFunction('function prepareUnpublishedChatWindowTransaction(')).toEqual(expect.stringContaining('overscan: CHAT_WINDOW_OVERSCAN'));
    expect(extractFunction('function prepareUnpublishedChatWindowTransaction(')).toEqual(expect.stringContaining('initialTailCount: CHAT_WINDOW_INITIAL_TAIL'));
  });

  test('B4-RED-0 stream mutations reject swaps, trace reuse, missing ranges, and altered metadata/handles', () => {
    const inputs = b4AttemptInputs();
    const spyMap = new Map<string, any>();
    const records = inputs.map((input, index) => {
      const ordinal = index + 1;
      const base = { ownerOrdinal: ordinal, tokenOrdinal: ordinal, optionAttemptOrdinal: ordinal, handleOrdinal: ordinal };
      const events: any[] = ['attempt-arm', 'attempt-consume', 'transaction-begin'].map((type) => ({ type, ...base }));
      events.push({ type: 'adapter-range', ...base, mountedIndexes: [ordinal, ordinal + 1],
        acceptedIndexes: [ordinal, ordinal + 1], mountedSizes: [48, 64], itemHeights: [48, 64],
        viewportStart: ordinal, viewportEnd: ordinal + 1, directRootCount: 8,
        overscanTier: input.overscanTier, initialTail: input.initialTail,
        beforeReserve: 1, afterReserve: 1 });
      for (const type of ['planner', 'journal-begin', 'keyed-apply', 'anchor-observation', 'spacer-observation',
        'scroll-observation', 'measurement-observation',
        'transaction-seal', 'transaction-finalize']) events.push({ type, ...base });
      events.splice(events.length - 2, 0, { type: 'geometry-post', ...base, scrollTop: ordinal,
        anchorIndex: ordinal, anchorOffset: ordinal * 50, anchorVisualPosition: ordinal * 49,
        topSpacerHeight: ordinal, bottomSpacerHeight: ordinal + 2, measured: true, settled: true });
      const normalized = normalizeExternalEvents(events);
      spyMap.set(b4AttemptKey(input), { input: { ...input, ...base }, route: 'window', events: normalized });
      return { ...input, rawEvents: normalized };
    });
    const valid = validateB4OptionRecords(records, spyMap);
    expect(valid).toEqual({ attempts: 36, matched: 36, coherent: 36, uniqueHandles: 36,
      policySignatures: 9, initialTailCountSignatures: 3, rangeVariants: 36,
      geometryWitnessSignatures: 36, selfAttestationFields: 0 });
    const swapped = records.map((record) => ({ ...record, rawEvents: [...record.rawEvents] }));
    [swapped[0].rawEvents, swapped[1].rawEvents] = [swapped[1].rawEvents, swapped[0].rawEvents];
    expect(validateB4OptionRecords(swapped, spyMap).matched).toBe(34);
    const reused = records.map((record) => ({ ...record, rawEvents: records[0].rawEvents }));
    expect(validateB4OptionRecords(reused, spyMap).matched).toBe(1);
    const missingRange = records.map((record) => ({ ...record,
      rawEvents: record.rawEvents.filter((event: any) => event.type !== 'adapter-range') }));
    expect(validateB4OptionRecords(missingRange, spyMap).coherent).toBe(0);
    const altered = records.map((record, index) => index === 0 ? { ...record, direction: 'altered',
      rawEvents: record.rawEvents.map((event: any) => ({ ...event, handleOrdinal: 99 })) } : record);
    expect(validateB4OptionRecords(altered, spyMap).matched).toBe(35);
    const mutateFirstEvent = (type: string, mutation: Record<string, unknown>) => records.map((record, index) => index
      ? record
      : { ...record, rawEvents: record.rawEvents.map((event: any) => event.type === type ? { ...event, ...mutation } : event) });
    for (const mutation of [
      mutateFirstEvent('adapter-range', { viewportStart: 999 }),
      mutateFirstEvent('adapter-range', { acceptedIndexes: [999] }),
      mutateFirstEvent('adapter-range', { directRootCount: 999 }),
      mutateFirstEvent('adapter-range', { itemHeights: [1, 1] }),
      mutateFirstEvent('geometry-post', { scrollTop: 999 }),
      mutateFirstEvent('geometry-post', { anchorOffset: 999 }),
      mutateFirstEvent('geometry-post', { anchorIndex: 999 }),
    ]) expect(validateB4OptionRecords(mutation, spyMap).matched).toBe(35);
  });

  const b4WorkflowNames = ['search-unmounted', 'append-active', 'alias', 'undo-reverted',
    'change-list', 'subagent', 'session-switch'] as const;
  const b4CollectorProvenance = new Map<string, Array<{ provenance: 'helper-raw'; rawOrdinal: number } | { provenance: 'consumer-constructed' }>>();
  const b4AtomicOperationCounts = { scenarios: 0, route: 0, alias: 0, callback: 0, ownerState: 0 };
  const collectB4WorkflowTraceSmokeSpies = () => {
    const records = new Map<string, any>();
    const optionPairs = b4AttemptInputs().filter((input) => input.direction === 'forward' && input.region === 'old');
    let ordinal = 0;
    for (const option of optionPairs) for (const workflow of b4WorkflowNames) {
      ordinal += 1;
      const meta = { ownerOrdinal: ordinal, tokenOrdinal: ordinal, optionAttemptOrdinal: ordinal, handleOrdinal: ordinal };
      const atomic = (realTransactionHarness('', true, { viewportStart: option.viewportStart }) as any).atomic;
      b4AtomicOperationCounts.scenarios += 1;
      const beforeRaw = atomic.operate('snapshot');
      const events: any[] = [{ type: 'before', workflow, canonicalOrdinal: beforeRaw.value.itemsLength, ...meta }];
      const provenance: Array<{ provenance: 'helper-raw'; rawOrdinal: number } | { provenance: 'consumer-constructed' }> = [
        { provenance: 'helper-raw', rawOrdinal: beforeRaw.ordinal },
      ];
      let accepted = false;
      let actionRaw: any;
      if (workflow === 'alias') {
        actionRaw = atomic.operate('alias', { oldKey: 'keep', newKey: `alias-${ordinal}` });
        b4AtomicOperationCounts.alias += 1;
        accepted = actionRaw.value === undefined;
      }
      else {
        if (workflow === 'session-switch') {
          atomic.operate('owner-state', { sessionId: `switched-${ordinal}`, generationDelta: 1 });
          b4AtomicOperationCounts.ownerState += 1;
        }
        actionRaw = atomic.operate('route', { session: { id: 'session-a', timeline: [{ id: 'canonical' }], phase: workflow } });
        b4AtomicOperationCounts.route += 1;
        accepted = typeof actionRaw.value === 'string' && actionRaw.value.includes('window');
      }
      events.push({ type: 'action', workflow, accepted, ...meta });
      provenance.push({ provenance: 'helper-raw', rawOrdinal: actionRaw.ordinal });
      events.push({ type: 'callback', workflow, stale: workflow === 'session-switch',
        applied: workflow !== 'session-switch', ...meta });
      provenance.push({ provenance: 'helper-raw', rawOrdinal: actionRaw.ordinal });
      const afterRaw = atomic.operate('snapshot');
      events.push({ type: 'after', workflow, canonicalOrdinal: afterRaw.value.itemsLength,
        deferredPending: Boolean(afterRaw.value.pendingKey), ...meta });
      provenance.push({ provenance: 'helper-raw', rawOrdinal: afterRaw.ordinal });
      const recordKey = `workflow/${b4AttemptKey(option)}/${workflow}`;
      records.set(recordKey, { option, workflow, events: normalizeExternalEvents(events) });
      b4CollectorProvenance.set(recordKey, provenance);
    }
    for (const option of optionPairs) {
      ordinal += 1;
      const meta = { ownerOrdinal: ordinal, tokenOrdinal: ordinal, optionAttemptOrdinal: ordinal, handleOrdinal: ordinal };
      const atomic = (realTransactionHarness('', true, { viewportStart: option.viewportStart }) as any).atomic;
      b4AtomicOperationCounts.scenarios += 1;
      const beforeRaw = atomic.operate('snapshot');
      const events: any[] = [{ type: 'before', workflow: 'trace', canonicalOrdinal: 2, ...meta }];
      const provenance: Array<{ provenance: 'helper-raw'; rawOrdinal: number } | { provenance: 'consumer-constructed' }> = [
        { provenance: 'helper-raw', rawOrdinal: beforeRaw.ordinal },
      ];
      const send = atomic.operate('route', { session: { id: 'session-a', timeline: [{ id: 'canonical' }], phase: 'send' } });
      b4AtomicOperationCounts.route += 1;
      events.push({ type: 'action', workflow: 'trace', phase: 'send', accepted: send.value === 'window', ...meta });
      provenance.push({ provenance: 'helper-raw', rawOrdinal: send.ordinal });
      for (let patch = 0; patch < 125; patch += 1) {
        const callback = atomic.operate('callback');
        b4AtomicOperationCounts.callback += 1;
        events.push({ type: 'patch', workflow: 'trace', applied: callback.value, ...meta });
        provenance.push({ provenance: 'helper-raw', rawOrdinal: callback.ordinal });
      }
      const final = atomic.operate('route', { session: { id: 'session-a', timeline: [{ id: 'canonical' }], phase: 'final' } });
      b4AtomicOperationCounts.route += 1;
      events.push({ type: 'action', workflow: 'trace', phase: 'final', accepted: final.value === 'window', ...meta });
      provenance.push({ provenance: 'helper-raw', rawOrdinal: final.ordinal });
      for (const phase of ['pin', 'unpin', 'pressure-negative', 'correction-negative', 'emergency-negative',
        'abort', 'degraded', 'fixed-rollback']) {
        events.push({ type: 'action', workflow: 'trace', phase, accepted: true, ...meta });
        provenance.push({ provenance: 'consumer-constructed' });
      }
      events.push({ type: 'callback', workflow: 'trace', stale: true, applied: false, ...meta });
      provenance.push({ provenance: 'helper-raw', rawOrdinal: final.ordinal });
      const afterRaw = atomic.operate('snapshot');
      events.push({ type: 'after', workflow: 'trace', canonicalOrdinal: 2,
        deferredPending: Boolean(afterRaw.value.pendingKey), ...meta });
      provenance.push({ provenance: 'helper-raw', rawOrdinal: afterRaw.ordinal });
      const recordKey = `trace/${b4AttemptKey(option)}`;
      records.set(recordKey, { option, workflow: 'trace', events: normalizeExternalEvents(events) });
      b4CollectorProvenance.set(recordKey, provenance);
    }
    for (const option of optionPairs) {
      ordinal += 1;
      const meta = { ownerOrdinal: ordinal, tokenOrdinal: ordinal, optionAttemptOrdinal: ordinal, handleOrdinal: ordinal };
      const atomic = (realTransactionHarness('', true, { viewportStart: option.viewportStart }) as any).atomic;
      b4AtomicOperationCounts.scenarios += 1;
      const beforeRaw = atomic.operate('snapshot');
      const events: any[] = [{ type: 'before', workflow: 'smoke', canonicalOrdinal: 2, ...meta }];
      const provenance: Array<{ provenance: 'helper-raw'; rawOrdinal: number } | { provenance: 'consumer-constructed' }> = [
        { provenance: 'helper-raw', rawOrdinal: beforeRaw.ordinal },
      ];
      for (const phase of ['load', 'wheel-old', 'page-current', 'primary', 'stream', 'final', 'pin', 'session-switch', 'fixed-rollback']) {
        const result = atomic.operate('route', { session: { id: 'session-a', timeline: [{ id: 'canonical' }], phase } });
        b4AtomicOperationCounts.route += 1;
        events.push({ type: 'action', workflow: 'smoke', phase, accepted: result.value === 'window', ...meta });
        provenance.push({ provenance: 'helper-raw', rawOrdinal: result.ordinal });
      }
      const afterRaw = atomic.operate('snapshot');
      events.push({ type: 'callback', workflow: 'smoke', stale: true, applied: false, ...meta });
      provenance.push({ provenance: 'helper-raw', rawOrdinal: afterRaw.ordinal });
      events.push({ type: 'after', workflow: 'smoke', canonicalOrdinal: 2,
        deferredPending: Boolean(afterRaw.value.pendingKey), ...meta });
      provenance.push({ provenance: 'helper-raw', rawOrdinal: afterRaw.ordinal });
      const recordKey = `smoke/${b4AttemptKey(option)}`;
      records.set(recordKey, { option, workflow: 'smoke', events: normalizeExternalEvents(events) });
      b4CollectorProvenance.set(recordKey, provenance);
    }
    return records;
  };
  const b4DWorkflowOwners: Record<string, string> = {
    'search-unmounted': 'collectBoundedSmartSearchText', 'append-active': 'handlePrimarySendClick',
    alias: 'applyKeyedChatPresentationAliasMigration', 'undo-reverted': 'isUndoRestoreStatusText',
    'change-list': 'isChangeListSessionMessage', subagent: 'cleanSubagentTitle', 'session-switch': 'handleSessionIdMessage',
  };
  const b4DCurrentOwnerHashes = Object.fromEntries([
    'handlePrimarySendClick', 'handleChatContainerScroll', 'handleSessionIdMessage',
    'applyKeyedChatPresentationAliasMigration', 'collectBoundedSmartSearchText', 'isUndoRestoreStatusText',
    'isChangeListSessionMessage', 'cleanSubagentTitle', 'normalizeAppendItemsForFinalize', 'getAnchorOrder',
    'applyWindowedKeyedChatReconciliation', 'recordChatWindowOuterRecovery',
  ].map((name) => [name, sourceHash(extractFunction(`function ${name}(`))]));
  const reduceB4DOutcome = (record: any) => {
    const events = record.rawEvents || [];
    const before = /^canonical:(\d+)$/.exec(events.find((event: any) => event.type === 'before')?.result || '');
    const after = /^canonical:(\d+):deferred:(true|false)$/.exec(events.find((event: any) => event.type === 'after')?.result || '');
    return {
      canonical: Boolean(before && after && before[1] === after[1]),
      actionObserved: events.some((event: any) => event.type === 'owner-call' && typeof event.result === 'string' && event.result.length > 0),
      staleRejected: events.find((event: any) => event.type === 'callback-state')?.phase === 'stale-rejected',
      deferredPending: after?.[2] === 'true',
      patchCount: events.filter((event: any) => event.type === 'patch').length,
    };
  };
  const validateWorkflowEvidence = (evidence: any) => {
    const groups = [['workflow', evidence.workflows], ['trace', evidence.traces], ['smoke', evidence.smoke]] as const;
    let matched = 0;
    let reducerMatched = 0;
    let selfAttested = 0;
    let expectedOrdinal = 0;
    for (const [kind, group] of groups) for (const record of group) {
      expectedOrdinal += 1;
      if ('independentSpyEvents' in record || 'callCounts' in record
        || ['canonical', 'actions', 'staleRejected', 'deferredPending', 'send', 'streamNotifications',
          'final', 'pinReturn', 'unpinStable', 'pressureNegative', 'correctionNegative',
          'emergencyNegative', 'abortRestored', 'degradedConsistent', 'fixedA2Rollback',
          'steps', 'blank', 'load', 'wheelOld', 'pageCurrent', 'primary', 'stream', 'pin',
          'sessionSwitch', 'fixedRollback'].some((field) => field in record)) selfAttested += 1;
      if (!Array.isArray(record.rawEvents)) continue;
      const events = record.rawEvents;
      const metadataMatches = events.every((event: any) => event.ownerOrdinal === expectedOrdinal
        && event.tokenOrdinal === expectedOrdinal && event.optionAttemptOrdinal === expectedOrdinal && event.handleOrdinal === expectedOrdinal);
      const hashesMatch = events.filter((event: any) => event.owner)
        .every((event: any) => b4DCurrentOwnerHashes[event.owner] === event.ownerHash);
      const phases = events.filter((event: any) => event.type === 'owner-call').map((event: any) => event.phase);
      const common = ['anchor', 'transaction', 'recovery-negative'].every((phase) => phases.includes(phase));
      const patches = events.filter((event: any) => event.type === 'patch');
      const shapeMatches = kind === 'workflow'
        ? common && phases.includes(record.workflow) && phases.includes('anchor-scroll')
        : kind === 'trace'
          ? common && phases.includes('primary-send') && phases.includes('final') && patches.length === 125
            && patches.every((event: any, index: number) => event.owner === 'handleChatContainerScroll'
              && event.ownerHash === b4DCurrentOwnerHashes.handleChatContainerScroll
              && event.phase === 'stream-callback' && event.result === `ordinal:${index + 1}`)
          : common && ['primary', 'stream-final', 'search', 'append', 'alias', 'undo-reverted',
            'change-list', 'subagent', 'session-switch'].every((phase) => phases.includes(phase));
      const workflowOwnerMatches = kind !== 'workflow' || events.some((event: any) => event.type === 'owner-call'
        && event.phase === record.workflow && event.owner === b4DWorkflowOwners[record.workflow]);
      const valid = metadataMatches && hashesMatch && shapeMatches && workflowOwnerMatches;
      if (valid) matched += 1;
      const reduced = reduceB4DOutcome(record);
      const expectedStale = kind !== 'workflow' || record.workflow === 'session-switch';
      if (valid && reduced.canonical && reduced.actionObserved && reduced.staleRejected === expectedStale
        && reduced.deferredPending === false && reduced.patchCount === (kind === 'trace' ? 125 : 0)) reducerMatched += 1;
    }
    return { attempts: expectedOrdinal, matched, reducerMatched, selfAttested };
  };

  test('B4-RED-0.7 63 workflow + 9 trace + 9 smoke streams must exactly match external execution reducers', () => {
    expect(b4WorkflowNames).toHaveLength(7); // 7 workflows x 9 options = 63; traces/smoke add 18 => 81.
    const evidence = JSON.parse(fs.readFileSync(b4EvidencePath, 'utf8'));
    expect(validateWorkflowEvidence(evidence)).toEqual({
      attempts: 81, matched: 81, reducerMatched: 81, selfAttested: 0,
    });
    expect(new Set([...evidence.workflows, ...evidence.traces, ...evidence.smoke]
      .map((record: any) => record.rawEvents[0].handleOrdinal)).size).toBe(81);
  });

  test('B4-RED-0 workflow mutations reject 125-count, stale callback, action metadata, swap, and reuse', () => {
    const evidence = JSON.parse(fs.readFileSync(b4EvidencePath, 'utf8'));
    const synthetic: any = JSON.parse(JSON.stringify({ workflows: evidence.workflows, traces: evidence.traces, smoke: evidence.smoke }));
    expect(validateWorkflowEvidence(synthetic)).toEqual({ attempts: 81, matched: 81, reducerMatched: 81, selfAttested: 0 });
    const trace = synthetic.traces[0];
    const fewerPatches = { ...synthetic, traces: synthetic.traces.map((record: any, index: number) => index ? record : {
      ...record, rawEvents: record.rawEvents.filter((event: any, eventIndex: number) => event.type !== 'patch' || eventIndex !== record.rawEvents.findIndex((entry: any) => entry.type === 'patch')),
    }) };
    expect(validateWorkflowEvidence(fewerPatches).matched).toBe(80);
    const noStale = { ...synthetic, traces: synthetic.traces.map((record: any, index: number) => index ? record : {
      ...record, rawEvents: record.rawEvents.filter((event: any) => event.type !== 'callback-state'),
    }) };
    expect(validateWorkflowEvidence(noStale).reducerMatched).toBe(80);
    const changedAction = { ...synthetic, traces: synthetic.traces.map((record: any, index: number) => index ? record : {
      ...record, rawEvents: record.rawEvents.map((event: any) => event.type === 'owner-call' ? { ...event, ownerHash: '0'.repeat(64) } : event),
    }) };
    expect(validateWorkflowEvidence(changedAction).matched).toBe(80);
    const swapped = { ...synthetic, workflows: synthetic.workflows.map((record: any) => ({ ...record, rawEvents: [...record.rawEvents] })) };
    [swapped.workflows[0].rawEvents, swapped.workflows[1].rawEvents] = [swapped.workflows[1].rawEvents, swapped.workflows[0].rawEvents];
    expect(validateWorkflowEvidence(swapped).matched).toBe(79);
    const reused = { ...synthetic, workflows: synthetic.workflows.map((record: any) => ({ ...record, rawEvents: synthetic.workflows[0].rawEvents })) };
    expect(validateWorkflowEvidence(reused).matched).toBe(19);
    expect(reduceB4DOutcome(trace).patchCount).toBe(125);
  });

  test('B4-BH atomic delegation preserves exact collector counts and out-of-band provenance', () => {
    const before = { ...b4AtomicOperationCounts };
    const records = collectB4WorkflowTraceSmokeSpies();
    expect({
      scenarios: b4AtomicOperationCounts.scenarios - before.scenarios,
      route: b4AtomicOperationCounts.route - before.route,
      alias: b4AtomicOperationCounts.alias - before.alias,
      callback: b4AtomicOperationCounts.callback - before.callback,
      ownerState: b4AtomicOperationCounts.ownerState - before.ownerState,
    }).toEqual({ scenarios: 81, route: 153, alias: 9, callback: 1125, ownerState: 9 });
    expect(records.size).toBe(81);
    let constructed = 0;
    for (const [key, record] of records) {
      const provenance = b4CollectorProvenance.get(key)!;
      expect(provenance).toHaveLength(record.events.length);
      for (const entry of provenance) {
        if (entry.provenance === 'consumer-constructed') {
          constructed += 1;
          expect(entry).not.toHaveProperty('rawOrdinal');
        } else {
          expect(entry.rawOrdinal).toBeGreaterThan(0);
        }
      }
    }
    expect(constructed).toBe(9 * 8);
    const helperSource = fs.readFileSync(path.join(process.cwd(), 'scripts', 'chat-window-adaptive-range-harness.js'), 'utf8');
    for (const consumerOwned of [
      'search-unmounted', 'append-active', 'undo-reverted', 'change-list', 'subagent', 'session-switch',
      "'trace'", "'smoke'", 'deferredPending', 'reduceExternalOutcome', '125', '63',
    ]) expect(helperSource).not.toContain(consumerOwned);
    const atomic = atomicScenarioExecutor.create();
    expect(() => atomic.operate('route', { owner: {} })).toThrow('Atomic operation rejects supplied execution ownership');
    expect(() => atomic.operate('unknown')).toThrow(RangeError);
  });

  test('B4 extracted real main transaction plus installed adapter covers all option/direction/region samples', () => {
    const ownershipProbe = realTransactionHarness();
    expect(Function.prototype.toString.call(ownershipProbe.context.applyWindowedKeyedChatReconciliation))
      .toContain('beginChatPresentationJournal');
    const spyMap = collectB4ExternalSpyMap();
    let blanks = 0;
    for (const observed of spyMap.values()) {
      const range = observed.events.find((event: any) => event.type === 'adapter-range');
      expect(range).toBeDefined();
      const indexes: number[] = range.mountedIndexes;
      if (!indexes.some((item) => item >= range.viewportStart && item <= range.viewportEnd)) blanks += 1;
      expect(indexes).toEqual([...new Set(indexes)].sort((a, b) => a - b));
      expect(indexes.length).toBeLessThanOrEqual(140);
      expect(range.directRootCount).toBeLessThanOrEqual(146);
    }
    expect({ denominator: spyMap.size, blanks }).toEqual({ denominator: 36, blanks: 0 });
  });

  test('A2.4D-RED1 captures C0 before detached preparation and owns new-root disposal', () => {
    expect(acceptedState()).toContain('const directChildren = Array.from(chatContainer.children);');
    expect(beginJournal()).toContain('acceptedState');
    expect(abortJournal()).toContain('disposePreparedChatRoot');
    const keyed = extractFunction('function applyKeyedChatReconciliation(');
    expect(keyed).toContain("runChatPresentationFailureSeam('factory-prepared'");
    expect(keyed).toContain('journal.preparedRoots.add(root);');
  });

  test('A2.4D-RED2 journals replace/remove/move and restores exact roots, maps, datasets, owner, and scroll', () => {
    const keyed = extractFunction('function applyKeyedChatReconciliation(');
    for (const stage of ['remove-applied', 'replace-applied', 'move-applied']) {
      expect(keyed).toContain(`runChatPresentationFailureSeam('${stage}'`);
    }
    expect(abortJournal()).toContain('restoreChatContainerChildren(journal.acceptedState.directChildren);');
    expect(abortJournal()).toContain('restoreChatWindowAcceptedState(journal.acceptedState);');
  });

  test('A2.4D-RED3 journals spacer and local surface mutation and defers local completion', () => {
    const windowed = extractFunction('function applyWindowedKeyedChatReconciliation(');
    expect(windowed).toContain("runChatPresentationFailureSeam('spacer-applied'");
    expect(windowed).toContain("runChatPresentationFailureSeam('local-surface-applied'");
    expect(windowed).not.toContain('chatLocalHistoryController.complete(reconcileSessionId);\n        }');
    expect(finalizeJournal()).toContain('chatLocalHistoryController.complete(journal.reconcileSessionId);');
  });

  test('A2.4D-RED4 uses dormant adapter prepare/commit and aborts after DOM apply', () => {
    const windowed = extractFunction('function applyWindowedKeyedChatReconciliation(');
    expect(windowed).toContain('adapter.beginTransaction(adapterUpdate)');
    expect(windowed).toContain('adapterTransaction.prepareCommit()');
    expect(windowed).toContain("runChatPresentationFailureSeam('adapter-prepared'");
    expect(windowed).toContain('adapterTransaction.commit()');
    expect(windowed).toContain("runChatPresentationFailureSeam('adapter-sealed-pre-finalize'");
    expect(windowed).toContain('abortChatPresentationJournal(journal);');
  });

  test('A2.4D-RED5 crosses one immediate finalization barrier before deferred effects', () => {
    const windowed = extractFunction('function applyWindowedKeyedChatReconciliation(');
    const commitAt = windowed.indexOf('adapterTransaction.commit()');
    const adapterFinalizeAt = windowed.indexOf('adapterTransaction.finalizeCommit()');
    const journalFinalizeAt = windowed.indexOf('finalizeChatPresentationJournal(journal)');
    const pendingScrollAt = windowed.indexOf("tryPendingChatWindowScroll('after-transaction-finalize')");
    expect(commitAt).toBeGreaterThanOrEqual(0);
    expect(adapterFinalizeAt).toBeGreaterThan(commitAt);
    expect(journalFinalizeAt).toBeGreaterThan(adapterFinalizeAt);
    expect(pendingScrollAt).toBeGreaterThan(journalFinalizeAt);
    expect(finalizeJournal()).toContain('disposeSupersededChatRoot');
  });

  test('A2.4D-RED6 captures enumerated behavioral state and committed diagnostic globals', () => {
    const capture = acceptedState();
    for (const token of [
      'chatStructuralRootReservations', 'chatWindowAcceptedPlanRevision', 'chatWindowPlanCorrection',
      'keyedChatReconcileFailure', '__ocKeyedChatLastReconcile', '__ocChatWindowLastBudget',
      '__ocChatWindowDomBudgetAudit', '__ocChatWindowRecovery', 'conflictCardEl',
      'conflictShellPresentationGeneration',
    ]) expect(capture).toContain(token);
  });

  test('A2.4D conflict safe-shell preparation restores generation, DOM, ID, and ownership deterministically', () => {
    const harness = realTransactionHarness('factory-prepared');
    const { context } = harness;
    const assertAuthenticConflictPath = (candidate: any) => {
      const safeRenderer = Function.prototype.toString.call(candidate.renderSafeShellConflictCard);
      const conflictRenderer = Function.prototype.toString.call(candidate.renderConflictCard);
      const detachedRenderer = Function.prototype.toString.call(candidate.renderDetachedKeyedUnit);
      if (!safeRenderer.includes('++conflictShellPresentationGeneration')
        || !conflictRenderer.includes('renderSafeShellConflictCard(payload, options, conflictOwner)')
        || !detachedRenderer.includes('directRoot = renderConflictCard(unit.value')) {
        throw new Error('test-owned conflict presentation path is forbidden');
      }
    };
    expect(() => assertAuthenticConflictPath({
      renderSafeShellConflictCard: () => null,
      renderConflictCard: () => null,
      renderDetachedKeyedUnit: () => null,
    })).toThrow('test-owned conflict presentation path is forbidden');
    expect(() => assertAuthenticConflictPath(context)).not.toThrow();

    const oldConflictRoot = harness.oldRoots.get('keep');
    const oldOwnership = Object.freeze({ sessionId: 'session-a', unitKey: 'keep', generation: 17, disposed: false });
    oldConflictRoot.id = 'accepted-conflict-root';
    oldConflictRoot.dataset.safeShellFamily = 'conflict';
    oldConflictRoot.dataset.safeShellGeneration = '17';
    oldConflictRoot._conflictShellOwnership = oldOwnership;
    context.conflictCardEl = oldConflictRoot;
    context.conflictShellPresentationGeneration = 17;
    const conflictUnit = {
      key: 'conflict-attempt', kind: 'conflict', value: {
        sessionId: 'session-a', operationId: 'operation-a', conflictId: 'conflict-a', kind: 'restore', source: 'test',
        conflicts: [{ path: 'src/a.ts', expectedExists: true, currentExists: true, diffText: '-old\n+new' }],
      },
    };
    const selections = { 'conflict-attempt': { mode: 'safe-shell', family: 'conflict' } };
    const attempt = () => {
      const journal = context.beginChatPresentationJournal();
      expect(() => context.applyKeyedChatReconciliation({}, [conflictUnit], selections, journal))
        .toThrow('injected:factory-prepared');
      const root = harness.preparedAttemptRoots.at(-1);
      expect(root).toBeTruthy();
      expect(context.conflictShellPresentationGeneration).toBe(18);
      expect(root.dataset.safeShellGeneration).toBe('18');
      const viewerId = root.querySelector('[data-safe-shell-role="viewer-region"]')?.id;
      expect(viewerId).toBe('safe-shell-conflict-viewer-conflict-attempt-18');
      const ownership = root._conflictShellOwnership;
      expect(ownership).toEqual(expect.objectContaining({ sessionId: 'session-a', unitKey: 'conflict-attempt', generation: 18, disposed: false }));
      expect(context.abortChatPresentationJournal(journal)).toBe(true);
      expect(context.conflictShellPresentationGeneration).toBe(17);
      expect(context.conflictCardEl).toBe(oldConflictRoot);
      expect(harness.chatContainer.children).toEqual(harness.originalChildren);
      expect(oldConflictRoot.id).toBe('accepted-conflict-root');
      expect(oldConflictRoot._conflictShellOwnership).toBe(oldOwnership);
      expect(ownership.disposed).toBe(true);
      return { root, viewerId, ownership };
    };

    const first = attempt();
    const callsBeforeStaleAction = [...harness.calls];
    first.root.querySelector('[data-safe-shell-role="open-full"]')?.dispatch('click');
    expect(harness.calls).toEqual(callsBeforeStaleAction);
    expect(first.ownership.frames.size).toBe(0);
    const second = attempt();
    expect(second.root).not.toBe(first.root);
    expect(second.viewerId).toBe(first.viewerId);
    expect(second.ownership).not.toBe(first.ownership);
    expect(context.conflictShellPresentationGeneration).toBe(17);
    expect(context.conflictCardEl).toBe(oldConflictRoot);
  });

  test('A2.4D intentionally excludes sessionSearch because the pre-barrier D path only reads it', () => {
    const capture = acceptedState();
    const windowed = extractFunction('function applyWindowedKeyedChatReconciliation(');
    const preBarrier = windowed.slice(0, windowed.indexOf('adapterTransaction.finalizeCommit()'));
    expect(capture).not.toContain('sessionSearch');
    expect(preBarrier).not.toMatch(/sessionSearch\.[A-Za-z]+\s*=/);
  });

  test('A2.4D-RED7 real path names are wired; coordinator remains policy-owned and unsubstituted', () => {
    const coordinator = extractFunction('function applyChatWindowOrWave2(');
    const windowed = extractFunction('function applyWindowedKeyedChatReconciliation(');
    const keyed = extractFunction('function applyKeyedChatReconciliation(');
    expect(coordinator).toContain('applyTransactionalWindow()');
    expect(windowed).toContain('applyKeyedChatReconciliation(session, acceptedUnits, acceptedPlan.shellSelections, journal);');
    expect(keyed).toContain('beginChatPresentationJournal');
    for (const fn of [acceptedState(), beginJournal(), abortJournal(), finalizeJournal()]) {
      expect(fn).not.toContain('applyChatWindowOrWave2 =');
      expect(fn).not.toContain('applyWindowedKeyedChatReconciliation =');
      expect(fn).not.toContain('applyKeyedChatReconciliation =');
    }

    const normal = realTransactionHarness();
    expect(normal.context.applyChatWindowOrWave2({}, normal.units)).toBe('window');
    expect(normal.calls).toEqual(expect.arrayContaining(['prepare', 'commit', 'adapter-finalize', 'local-complete']));
    expect(normal.calls.indexOf('adapter-finalize')).toBeLessThan(normal.calls.indexOf('local-complete'));

    for (const stage of [
      'factory-prepared', 'factory-prepared-multiple', 'remove-applied', 'replace-applied', 'move-applied',
      'spacer-applied', 'local-surface-applied', 'adapter-prepare', 'adapter-prepared', 'adapter-commit', 'adapter-sealed-pre-finalize',
    ]) {
      const failed = realTransactionHarness(stage);
      const expectedError = stage === 'adapter-prepare'
        ? 'Chat window adapter transaction prepare failed'
        : stage === 'adapter-commit'
          ? 'Chat window adapter transaction commit failed'
          : `injected:${stage}`;
      expect(() => failed.context.applyWindowedKeyedChatReconciliation({}, failed.units)).toThrow(expectedError);
      expect(failed.chatContainer.children).toEqual(failed.originalChildren);
      expect(failed.chatWindowState.snapshot).toBe(failed.oldSnapshot);
      expect(failed.chatWindowState.anchorKey).toBe('keep');
      expect(failed.chatWindowState.pendingScrollKey).toBe('keep');
      expect(failed.chatWindowState.localOlderObserver).toBe(failed.oldObserver);
      expect(failed.top.style.height).toBe('11px');
      expect(failed.local.childNodes[0]?.id).toBe('old-local-child');
      expect(failed.oldRoots.get('keep').dataset).toEqual({ renderUnitKey: 'keep', retained: 'data-keep' });
      expect(failed.windowObject.__ocChatWindowRecovery).toBe(failed.oldRecovery);
      expect(failed.context.keyedChatReconcileState.items).toBe(failed.oldItems);
      expect([...failed.context.keyedChatReconcileState.roots]).toEqual([...failed.oldRoots]);
      expect(failed.adapterOwner).toBe('old');
      expect(failed.retainedAdapterConfig).toEqual({ keys: ['remove', 'keep'], revisions: ['old-remove', 'old-keep'] });
      expect([...failed.retainedObservations]).toEqual([failed.oldRoots.get('remove'), failed.oldRoots.get('keep')]);
      expect(failed.attemptedObserver.disconnect).toHaveBeenCalledTimes(stage === 'local-surface-applied' || failed.calls.includes('local-surface-applied') ? 1 : 0);
      expect(failed.disposed).not.toEqual(expect.arrayContaining(['old-remove', 'old-keep']));
      const newDisposals = failed.disposed.filter((entry) => entry.startsWith('new:'));
      expect(new Set(newDisposals).size).toBe(newDisposals.length);
      if (failed.calls.includes('factory-prepared')) expect(newDisposals.length).toBeGreaterThan(0);
    }
  });

  test('A2.4TX-RED2 uses the actual adapter and restores exact C0 at the sealed pre-finalize seam', () => {
    const failed = realTransactionHarness('adapter-sealed-pre-finalize', true);
    expect(() => failed.context.applyWindowedKeyedChatReconciliation({}, failed.units))
      .toThrow('injected:adapter-sealed-pre-finalize');
    expect(failed.chatContainer.children).toEqual(failed.originalChildren);
    expect(failed.chatWindowState.snapshot).toBe(failed.oldSnapshot);
    expect(failed.context.keyedChatReconcileState.items).toBe(failed.oldItems);
    expect([...failed.context.keyedChatReconcileState.roots]).toEqual([...failed.oldRoots]);
    expect(failed.adapter.getRange().items.map((item: any) => item.key)).toEqual(['remove', 'keep']);
    expect(failed.actualConstructions[0].destroyed).toBe(false);
    expect(failed.actualConstructions[1].destroyed).toBe(false);
    expect(failed.disposed.filter((entry: string) => entry.startsWith('new:')).length).toBeGreaterThan(0);
    expect(failed.disposed).not.toEqual(expect.arrayContaining(['old-remove', 'old-keep']));
  });

  test('A2.4TX-RED7 classifies an escaped post-barrier error as committed-degraded and never aborts', () => {
    const degraded = realTransactionHarness('post-barrier-unexpected');
    expect(degraded.context.applyWindowedKeyedChatReconciliation({}, degraded.units).map((unit: any) => unit.key).sort())
      .toEqual(['keep', 'new']);
    expect(degraded.adapterOwner).toBe('candidate');
    expect(degraded.calls).not.toContain('adapter-abort');
    expect(degraded.windowObject.__ocChatWindowRecovery).toEqual(expect.objectContaining({ status: 'committed-degraded' }));
    expect(degraded.chatContainer.children).not.toEqual(degraded.originalChildren);
    expect(degraded.disposed).toEqual(expect.arrayContaining(['old-remove']));
  });

  test.each([
    'factory-prepared', 'remove-applied', 'replace-applied',
    'spacer-applied', 'local-surface-applied', 'adapter-prepared', 'adapter-sealed-pre-finalize',
  ])('A2.4R-RED1 real coordinator aborts %s exactly to pre-attempt C0', (stage) => {
    const failed = realTransactionHarness(stage, true);
    expect(failed.context.applyChatWindowOrWave2({}, failed.units)).toBe('window-recovery-pending');
    expect(failed.chatContainer.children).toEqual(failed.originalChildren);
    expect(failed.chatWindowState.snapshot).toBe(failed.oldSnapshot);
    expect(failed.context.keyedChatReconcileState.items).toBe(failed.oldItems);
    expect([...failed.context.keyedChatReconcileState.roots]).toEqual([...failed.oldRoots]);
    expect(failed.actualConstructions[0].destroyed).toBe(false);
    expect(failed.disposed).not.toEqual(expect.arrayContaining(['old-remove', 'old-keep']));
    expect(failed.calls).not.toEqual(expect.arrayContaining(['local-complete']));
  });

  test('A2.4R-RED2/3 real coordinator uses one new truthful conflict transaction and restores C0 if it fails', () => {
    const conflictUnits = [
      { key: 'keep', kind: 'greeting', value: null },
      {
        key: 'new', kind: 'conflict', value: {
          sessionId: 'session-a', operationId: 'op', conflictId: 'conflict', kind: 'restore', source: 'test',
          conflicts: [{ path: 'src/a.ts', expectedExists: true, currentExists: true, diffText: '' }],
        },
      },
    ];
    const recovered = realTransactionHarness('factory-prepared', true, { failOnce: true, units: conflictUnits });
    expect(recovered.context.applyChatWindowOrWave2({}, recovered.units)).toBe('window-recovered');
    expect(recovered.failureStageCounts.get('factory-prepared')).toBeGreaterThan(1);
    const committedConflict = recovered.context.keyedChatReconcileState.roots.get('new');
    expect(committedConflict.dataset).toMatchObject({ renderUnitKey: 'new', safeShellFamily: 'conflict' });
    expect(recovered.calls.filter((entry: string) => entry === 'adapter-sealed-pre-finalize')).toHaveLength(1);

    const failed = realTransactionHarness('factory-prepared', true, { units: conflictUnits });
    expect(failed.context.applyChatWindowOrWave2({}, failed.units)).toBe('window-recovery-pending');
    expect(failed.failureStageCounts.get('factory-prepared')).toBe(2);
    expect(failed.chatContainer.children).toEqual(failed.originalChildren);
    expect(failed.context.keyedChatReconcileState.items).toBe(failed.oldItems);
    expect([...failed.context.keyedChatReconcileState.roots]).toEqual([...failed.oldRoots]);
    expect(failed.actualConstructions[0].destroyed).toBe(false);
    expect(failed.disposed).not.toEqual(expect.arrayContaining(['old-remove', 'old-keep']));
  });

  const corruptionSamples = [
    { code: 'duplicate-keyed-root', expected: 1, actual: 2 },
    { code: 'missing-accepted-keyed-root', expected: true, actual: false },
    { code: 'unexpected-keyed-root', expected: false, actual: true },
    { code: 'unclassified-direct-root', expected: 0, actual: 1 },
    { code: 'root-map-dom-mismatch', expected: ['keep'], actual: ['new'] },
    { code: 'active-spacer-missing-or-duplicated', expected: 1, actual: 0 },
    { code: 'adapter-session-generation-mismatch', expected: 2, actual: 1 },
  ];
  const emergencyUnits = () => Array.from({ length: 96 }, (_, index) => ({
    key: index === 0 ? 'keep' : index === 1 ? 'new' : `conflict-${index}`,
    kind: 'conflict',
    value: {
      sessionId: 'session-a', operationId: `op-${index}`, conflictId: `conflict-${index}`,
      kind: 'restore', source: 'test',
      conflicts: [{ path: `src/${index}.ts`, expectedExists: true, currentExists: true, diffText: '' }],
    },
  }));

  test.each(corruptionSamples)('A2.5E-RED1 real facade classifies $code and matching pending ownership precedes emergency', (sample) => {
    const units = emergencyUnits();
    const harness = cf2TransactionHarness('', false, { units });
    harness.chatWindowState.allUnits = units;
    const raw = Object.freeze({
      sessionId: 'session-a', generation: 2, anomaly: true,
      corruptionSamples: Object.freeze([Object.freeze(sample)]),
    });
    expect(classifyChatWindowIntegrity(sample)).toEqual({ corrupt: true, code: sample.code });
    expect(harness.context.consumeChatWindowIntegrityAudit({ sessionId: 'session-a', generation: 2 }, raw)).toBe(true);
    expect(harness.context.chatWindowOuterRecovery).toEqual(expect.objectContaining({
      status: 'emergency', sessionId: 'session-a', generation: 2, reason: 'classified-corruption',
    }));
    expect(harness.context.chatWindowEmergencyState).toEqual(expect.objectContaining({
      status: 'active', sessionId: 'session-a', generation: 2, codes: [sample.code],
    }));
    expect(harness.calls.indexOf('diagnostic')).toBeLessThan(harness.calls.indexOf('prepare'));
  });

  test.each([
    ['different closed codes', [corruptionSamples[0], corruptionSamples[1]]],
    ['duplicate closed code', [corruptionSamples[0], { ...corruptionSamples[0] }]],
  ])('A2.5E reviewer repair rejects multiple valid samples: %s', (_label, samples) => {
    const units = emergencyUnits();
    const harness = realTransactionHarness('', false, { units });
    harness.chatWindowState.allUnits = units;
    const canonicalIdentity = harness.canonicalSession;
    const canonicalTimeline = harness.canonicalSession.timeline;
    const acceptedItems = harness.context.keyedChatReconcileState.items;
    const acceptedRoots = harness.context.keyedChatReconcileState.roots;
    const acceptedChildren = [...harness.chatContainer.children];
    for (const sample of samples as any[]) {
      expect(classifyChatWindowIntegrity(sample)).toEqual({ corrupt: true, code: sample.code });
    }
    const owner = { sessionId: 'session-a', generation: 2 };
    const raw = { sessionId: 'session-a', generation: 2, anomaly: true, corruptionSamples: samples };

    expect(harness.context.consumeChatWindowIntegrityAudit(
      owner,
      raw,
    )).toBe(false);
    expect(harness.context.chatWindowOuterRecovery.status).toBe('idle');
    expect(harness.context.chatWindowOuterRecovery.reason).not.toBe('classified-corruption');
    expect(harness.context.chatWindowEmergencyState.status).toBe('idle');
    expect(harness.calls.filter((call: string) => call === 'prepare')).toHaveLength(0);
    expect(harness.containmentRequests).toHaveLength(0);
    expect(harness.context.recordChatWindowOuterRecovery(owner, 'raw-integrity-anomaly', raw)).toEqual(expect.objectContaining({
      status: 'pending', reason: 'raw-integrity-anomaly', sessionId: 'session-a', generation: 2,
    }));
    expect(harness.context.chatWindowOuterRecovery.reason).not.toBe('classified-corruption');
    expect(harness.canonicalSession).toBe(canonicalIdentity);
    expect(harness.canonicalSession.timeline).toBe(canonicalTimeline);
    expect(harness.context.keyedChatReconcileState.items).toBe(acceptedItems);
    expect(harness.context.keyedChatReconcileState.roots).toBe(acceptedRoots);
    expect(harness.chatContainer.children).toEqual(acceptedChildren);
  });

  test('A2.5E-RED2 pressure, audit mismatch, unknown evidence, and recoverable throws never enter emergency', () => {
    const harness = realTransactionHarness();
    const owner = { sessionId: 'session-a', generation: 2 };
    expect(harness.context.consumeChatWindowIntegrityAudit(owner, {
      sessionId: 'session-a', generation: 1, corruptionSamples: [corruptionSamples[0]],
    })).toBe(false);
    for (const raw of [
      { sessionId: 'session-a', generation: 2, descendants: 4001, corruptionSamples: [] },
      { sessionId: 'session-a', generation: 2, descendants: 22040, mountedRootCount: 141, directChildCount: 147, corruptionSamples: [] },
      { sessionId: 'session-a', generation: 2, corruptionSamples: [{ code: 'unknown', expected: true, actual: false }] },
      { sessionId: 'session-a', generation: 2, corruptionSamples: [{ code: 'duplicate-keyed-root', expected: 1, actual: 1 }] },
    ]) expect(harness.context.consumeChatWindowIntegrityAudit(owner, raw)).toBe(false);
    harness.windowObject.__ocRendering.classifyChatWindowIntegrity = () => { throw new Error('classifier seam'); };
    expect(harness.context.consumeChatWindowIntegrityAudit(owner, {
      sessionId: 'session-a', generation: 2, corruptionSamples: [corruptionSamples[0]],
    })).toBe(false);
    harness.windowObject.__ocRendering.classifyChatWindowIntegrity = () => ({ corrupt: true, code: 'unknown' });
    expect(harness.context.consumeChatWindowIntegrityAudit(owner, {
      sessionId: 'session-a', generation: 2, corruptionSamples: [corruptionSamples[0]],
    })).toBe(false);
    harness.context.CHAT_WINDOW_EMERGENCY_ENABLED = false;
    harness.windowObject.__ocRendering.classifyChatWindowIntegrity = classifyChatWindowIntegrity;
    expect(harness.context.consumeChatWindowIntegrityAudit(owner, {
      sessionId: 'session-a', generation: 2, corruptionSamples: [corruptionSamples[0]],
    })).toBe(false);
    expect(harness.context.chatWindowEmergencyState.status).toBe('idle');
    expect(harness.context.chatWindowOuterRecovery).toEqual(expect.objectContaining({
      status: 'pending', reason: 'classified-corruption', generation: 2,
    }));
    for (const failure of ['factory-prepared', 'replace-applied', 'local-surface-applied']) {
      const failed = realTransactionHarness(failure);
      expect(failed.context.applyChatWindowOrWave2({}, failed.units)).toBe('window-recovery-pending');
      expect(failed.context.chatWindowEmergencyState.status).toBe('idle');
    }
  });

  test('A2.5E-RED3 real planner/coordinator hard-cap safe shells and preserve canonical identity with accessible diagnostics', () => {
    const units = emergencyUnits();
    const harness = realTransactionHarness('', false, { units });
    harness.chatWindowState.allUnits = units;
    const canonicalIdentity = harness.canonicalSession;
    expect(harness.context.consumeChatWindowIntegrityAudit(
      { sessionId: 'session-a', generation: 2 },
      { sessionId: 'session-a', generation: 2, anomaly: true, corruptionSamples: [corruptionSamples[0]] },
    )).toBe(true);
    expect(harness.canonicalSession).toBe(canonicalIdentity);
    expect(harness.canonicalSession.timeline).toEqual([{ id: 'canonical' }]);
    expect(Math.max(...harness.transactionUnitCounts)).toBeLessThanOrEqual(80);
    const emergencyRequest = harness.containmentRequests.find((request: any) => request.shellRequests?.length > 1);
    expect(emergencyRequest.shellRequests).toHaveLength(80);
    expect(emergencyRequest.limits).toEqual({ mounted: 140, directChildren: 146 });
    const state = harness.context.chatWindowEmergencyState;
    expect(state.root.className).toBe('message system error');
    expect(state.root.getAttribute('role')).toBe('alert');
    expect(state.root.querySelector('[data-safe-shell-role="retry-corruption"]')).toBeTruthy();
    expect(state.root.childNodes.some((child: any) => child.tagName === 'DETAILS')).toBe(true);
    expect(harness.chatContainer.childElementCount).toBeLessThanOrEqual(146);
    expect(harness.context.keyedChatReconcileState.items).toHaveLength(80);
    expect(harness.context.keyedChatReconcileState.items.every((item: any) => item.presentationSelection?.mode === 'safe-shell')).toBe(true);
  });

  test('A2.5E-RED4 retry consumes exact owner into normal planner; stale session/generation/DOM callbacks no-op', () => {
    const active = realTransactionHarness('', false, { units: emergencyUnits() });
    active.chatWindowState.allUnits = active.units;
    active.context.consumeChatWindowIntegrityAudit(
      { sessionId: 'session-a', generation: 2 },
      { sessionId: 'session-a', generation: 2, anomaly: true, corruptionSamples: [corruptionSamples[1]] },
    );
    const activeButton = active.context.chatWindowEmergencyState.root.querySelector('[data-safe-shell-role="retry-corruption"]');
    expect(active.context.completeChatWindowOuterRecovery({ sessionId: 'session-a', generation: 2 })).toBe(true);
    expect(active.context.chatWindowOuterRecovery.status).toBe('emergency');
    activeButton.dispatch('click');
    expect(active.calls).toContain('schedule:chat-window-corruption-retry');
    expect(active.context.chatWindowEmergencyState.status).toBe('idle');
    expect(active.context.chatWindowOuterRecovery.status).toBe('consumed');

    const stale = realTransactionHarness('', false, { units: emergencyUnits() });
    stale.chatWindowState.allUnits = stale.units;
    stale.context.consumeChatWindowIntegrityAudit(
      { sessionId: 'session-a', generation: 2 },
      { sessionId: 'session-a', generation: 2, anomaly: true, corruptionSamples: [corruptionSamples[1]] },
    );
    const staleButton = stale.context.chatWindowEmergencyState.root.querySelector('[data-safe-shell-role="retry-corruption"]');
    stale.context.activeSessionId = 'session-b';
    stale.context.chatWindowGeneration = 3;
    staleButton.dispatch('click');
    expect(stale.calls).not.toContain('schedule:chat-window-corruption-retry');
    stale.context.activeSessionId = 'session-a';
    stale.context.chatWindowGeneration = 2;
    stale.context.chatWindowEmergencyState.root.remove();
    staleButton.dispatch('click');
    expect(stale.calls).not.toContain('schedule:chat-window-corruption-retry');
    const outer = extractFunction('function renderFromState()');
    const emergency = [
      extractFunction('function enterChatWindowEmergency('),
      extractFunction('function consumeChatWindowIntegrityAudit('),
      extractFunction('function retryChatWindowEmergency('),
    ].join('\n');
    expect(outer).not.toMatch(/classifyChatWindowIntegrity|corruption-emergency|enterChatWindowEmergency/);
    expect(emergency).not.toMatch(/renderFromStateLegacy|destroyChatWindowAdapter|innerHTML|applyKeyedChatReconciliation|session\.timeline/);
    expect(emergency).toContain("scheduleRenderFromState('chat-window-corruption-retry')");
    expect(extractFunction('function applyChatWindowOrWave2(')).toContain('units.slice(-CHAT_WINDOW_INITIAL_TAIL)');
  });

  test('A2.6-RED1 real switch/session/coordinator matrix stays planner-owned and hard capped', () => {
    expect(source).toContain('const CHAT_WINDOW_CONTAINMENT_POLICY_ENABLED = window.__ocChatWindowContainmentPolicyEnabled !== false;');
    expect(source).toContain('const CHAT_WINDOW_RECOVERY_ENABLED = window.__ocChatWindowRecoveryEnabled !== false;');
    expect(source).toContain('const CHAT_WINDOW_EMERGENCY_ENABLED = window.__ocChatWindowEmergencyEnabled !== false;');
    const normal = realTransactionHarness();
    expect(normal.context.applyChatWindowOrWave2(normal.canonicalSession, normal.units)).toBe('window');
    expect(normal.transactionUnitCounts).toEqual([2]);

    const rollbackUnits = emergencyUnits();
    const policyOff = realTransactionHarness('', false, { units: rollbackUnits });
    policyOff.context.CHAT_WINDOW_CONTAINMENT_POLICY_ENABLED = false;
    expect(policyOff.context.applyChatWindowOrWave2(policyOff.canonicalSession, rollbackUnits))
      .toBe('containment-policy-disabled-virtualized');
    expect(Math.max(...policyOff.transactionUnitCounts)).toBeLessThanOrEqual(80);
    expect(policyOff.context.keyedChatReconcileState.items).toHaveLength(80);
    expect(policyOff.chatContainer.childElementCount).toBeLessThanOrEqual(146);

    const rollback = realTransactionHarness('', false, { units: rollbackUnits });
    rollback.context.TANSTACK_CHAT_WINDOW_ENABLED = false;
    expect(rollback.context.applyChatWindowOrWave2(rollback.canonicalSession, rollbackUnits))
      .toBe('outer-virtualized-baseline');
    expect(Math.max(...rollback.transactionUnitCounts)).toBeLessThanOrEqual(80);
    expect(rollback.context.keyedChatReconcileState.items).toHaveLength(80);

    const capability = realTransactionHarness();
    delete capability.windowObject.__ocRendering.createTanStackVirtualAdapter;
    expect(capability.context.applyChatWindowOrWave2(capability.canonicalSession, capability.units))
      .toBe('window-unavailable-retained');
    expect(capability.transactionUnitCounts).toHaveLength(0);
    expect(capability.chatContainer.children).toEqual(capability.originalChildren);

    const priorFailure = realTransactionHarness();
    priorFailure.chatWindowState.failedSessionId = 'session-a';
    expect(priorFailure.context.applyChatWindowOrWave2(priorFailure.canonicalSession, priorFailure.units))
      .toBe('window-unavailable-retained');
    expect(priorFailure.transactionUnitCounts).toHaveLength(0);
    expect(priorFailure.chatContainer.children).toEqual(priorFailure.originalChildren);

    const recoveryOff = realTransactionHarness('factory-prepared', true, { units: rollbackUnits });
    recoveryOff.context.CHAT_WINDOW_RECOVERY_ENABLED = false;
    expect(recoveryOff.context.applyChatWindowOrWave2(recoveryOff.canonicalSession, rollbackUnits))
      .toBe('window-recovery-disabled-retained');
    expect(recoveryOff.failureStageCounts.get('factory-prepared')).toBe(1);
    expect(recoveryOff.chatContainer.children).toEqual(recoveryOff.originalChildren);
    expect(recoveryOff.context.keyedChatReconcileState.items).toBe(recoveryOff.oldItems);

    const emergencyOff = realTransactionHarness('', false, { units: rollbackUnits });
    emergencyOff.chatWindowState.allUnits = rollbackUnits;
    emergencyOff.context.CHAT_WINDOW_EMERGENCY_ENABLED = false;
    expect(emergencyOff.context.consumeChatWindowIntegrityAudit(
      { sessionId: 'session-a', generation: 2 },
      { sessionId: 'session-a', generation: 2, anomaly: true, corruptionSamples: [corruptionSamples[0]] },
    )).toBe(false);
    expect(emergencyOff.context.chatWindowOuterRecovery).toEqual(expect.objectContaining({
      status: 'pending', reason: 'classified-corruption', generation: 2,
    }));
    expect(emergencyOff.context.chatWindowEmergencyState.status).toBe('idle');
    expect(emergencyOff.transactionUnitCounts).toHaveLength(0);
  });

  test('A2.6-RED2 switch and rollback routes cannot reopen destructive or full-history paths', () => {
    const coordinator = extractFunction('function applyChatWindowOrWave2(');
    const outer = extractFunction('function renderFromState()');
    for (const forbidden of [
      'disableChatWindowForSession', 'destroyChatWindowAdapter', 'renderFromStateLegacy',
      'applyKeyedChatReconciliation(session, units)', "chatContainer.innerHTML = ''",
      'keyedChatFailedSessionId', 'session.timeline', 'throw new Error',
    ]) expect(coordinator).not.toContain(forbidden);
    expect(outer).not.toContain('renderFromStateLegacy');
    expect(outer).not.toContain('destroyChatWindowAdapter');
    expect(source.match(/renderFromStateLegacy\(\);/g) || []).toHaveLength(0);
    expect(coordinator).toContain('const boundedUnits = units.slice(-CHAT_WINDOW_INITIAL_TAIL);');
    expect(coordinator).toContain('limits: { mounted: CHAT_WINDOW_MOUNT_LIMIT, directChildren: CHAT_WINDOW_DIRECT_CHILD_LIMIT }');
    expect(extractFunction('function assertChatWindowDomBudget(')).not.toContain('throw ');
  });

  test('A2.6-RED3 keeps adaptive rollout isolated from stream/final/scheduler ownership', () => {
    expect(source).toContain('const CHAT_WINDOW_OVERSCAN = 20;');
    expect(source).toContain('const CHAT_WINDOW_INITIAL_TAIL = 80;');
    expect(source.match(/const\s+CHAT_WINDOW_[A-Z0-9_]*ADAPTIVE[A-Z0-9_]*\s*=/g) || [])
      .toEqual([
        'const CHAT_WINDOW_ADAPTIVE_RANGE_ENABLED =',
        'const CHAT_WINDOW_ADAPTIVE_SHADOW_CONFIG =',
      ]);
    expect(source).not.toMatch(/const\s+CHAT_WINDOW_[A-Z0-9_]*(EXCEPTIONAL|RICH)[A-Z0-9_]*\s*=/);
    const a2Switches = [...source.matchAll(/window\.(__ocChatWindow[A-Za-z0-9]*Enabled)/g)]
      .map((match) => match[1]);
    expect([...new Set(a2Switches)].sort()).toEqual([
      '__ocChatWindowAdaptiveRangeEnabled',
      '__ocChatWindowContainmentPolicyEnabled',
      '__ocChatWindowEmergencyEnabled',
      '__ocChatWindowRecoveryEnabled',
    ]);
    const adaptiveResolver = extractFunction('function resolveChatWindowAdaptiveRangePolicy(');
    expect(adaptiveResolver).not.toMatch(/scheduleRenderFromState|scrollToBottom|applyChatWindowOrWave2|renderFromStateLegacy/);
    expect(sourceHash(extractFunction('function tryPatchAssistantStreamingBubble(')))
      .toBe('285abb29f2dc5dabf8eb1d7b4f55805cd009789d99d543fa0c9ca0000f9b8457');
    expect(sourceHash(extractFunction('function attemptAssistantUpgrade(')))
      .toBe('99871bc6c811d5498c419005cae64443643351c39332b2a83923e04c0b886715');
    expect(sourceHash(extractFunction('function scheduleRenderFromState(')))
      .toBe('b2977c0a62af34a61c73fa241bfe685c3efdb8823718665e5c040e6dd44d8ded');
    expect(sourceHash(extractFunction('function noteFullRenderRequest(')))
      .toBe('a71bab2243fadd3aa6282053598225d5a9ce58dc016dba0e6bad4b79eceb1f8b');
  });

  test('A2.6-SMOKE load, primary route, off/on, session switch, send/stream/final stay virtualized', () => {
    expect(source).toContain('function applyChatWindowOrWave2(');
    const units = emergencyUnits();
    const harness = realTransactionHarness('', false, { units });
    const routes: string[] = [];
    routes.push(harness.context.applyChatWindowOrWave2(harness.canonicalSession, units));
    harness.context.CHAT_WINDOW_CONTAINMENT_POLICY_ENABLED = false;
    routes.push(harness.context.applyChatWindowOrWave2(harness.canonicalSession, units));
    harness.context.CHAT_WINDOW_CONTAINMENT_POLICY_ENABLED = true;
    routes.push(harness.context.applyChatWindowOrWave2(harness.canonicalSession, units));
    harness.context.activeSessionId = 'session-b';
    harness.chatWindowState.sessionId = 'session-b';
    harness.context.chatWindowGeneration = 3;
    for (const phase of ['send', 'stream', 'final']) {
      routes.push(harness.context.applyChatWindowOrWave2({ id: 'session-b', phase }, units));
    }
    expect(routes).toEqual([
      'window', 'containment-policy-disabled-virtualized', 'window',
      'window', 'window', 'window',
    ]);
    expect(harness.transactionUnitCounts.length).toBeGreaterThanOrEqual(6);
    expect(Math.max(...harness.transactionUnitCounts)).toBeLessThanOrEqual(140);
    expect(harness.transactionUnitCounts).toContain(80);
    expect(harness.chatContainer.childElementCount).toBeLessThanOrEqual(146);
    expect(harness.context.keyedChatReconcileState.items.length).toBeLessThanOrEqual(140);
    expect(harness.calls).not.toContain('destroy');
    expect(extractFunction('function tryPatchAssistantStreamingBubble(')).toContain('acknowledgeKeyedStreamPatch');
    expect(extractFunction('function attemptAssistantUpgrade(')).toContain('replaceKeyEverywhere');
  });

  test('A2.8-RED1/2 removes the nontransactional escape and returns the exact frozen sentinel before mutation', () => {
    const windowed = extractFunction('function applyWindowedKeyedChatReconciliation(');
    expect(source).toContain('const CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT = Object.freeze({');
    expect(source).toContain("status: 'window-transaction-unavailable'");
    expect(source).toContain("reason: 'missing-begin-transaction'");
    expect(windowed).not.toContain('legacyUnits');
    expect(windowed).not.toContain('applyKeyedChatReconciliation(session, legacyUnits)');

    const harness = realTransactionHarness('', false, { missingBeginTransaction: true });
    const acceptedItems = harness.context.keyedChatReconcileState.items;
    const acceptedRoots = harness.context.keyedChatReconcileState.roots;
    const acceptedChildren = [...harness.chatContainer.children];
    const acceptedSnapshot = harness.chatWindowState.snapshot;
    const acceptedSession = harness.canonicalSession;
    const result = harness.context.applyWindowedKeyedChatReconciliation(acceptedSession, harness.units);
    expect(result).toBe(harness.context.CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.keys(result)).toEqual(['ok', 'status', 'reason']);
    expect(result).toEqual({
      ok: false, status: 'window-transaction-unavailable', reason: 'missing-begin-transaction',
    });
    expect(harness.calls).toEqual([]);
    expect(harness.containmentRequests).toEqual([]);
    expect(harness.transactionUnitCounts).toEqual([]);
    expect(harness.context.keyedChatReconcileState.items).toBe(acceptedItems);
    expect(harness.context.keyedChatReconcileState.roots).toBe(acceptedRoots);
    expect(harness.chatContainer.children).toEqual(acceptedChildren);
    expect(harness.chatWindowState.snapshot).toBe(acceptedSnapshot);
    expect(harness.canonicalSession).toBe(acceptedSession);
  });

  test('A2.8-RED3 enumerates only planned capped keyed applies with transaction/journal provenance', () => {
    const invocations = [...source.matchAll(/applyKeyedChatReconciliation\(/g)]
      .map((match) => source.slice(match.index!, source.indexOf('\n', match.index!)))
      .filter((line) => !line.includes('presentationSelections = null, externalJournal = null'));
    expect(invocations).toHaveLength(1);
    const allInvocationsAreBounded = invocations.every((line) => (
      !line.includes('legacyUnits') && !line.includes('session, units)')
    ));
    expect(allInvocationsAreBounded).toBe(true);
    expect(invocations).toEqual(expect.arrayContaining([
      expect.stringContaining('session, acceptedUnits, acceptedPlan.shellSelections, journal'),
    ]));

    const windowed = extractFunction('function applyWindowedKeyedChatReconciliation(');
    const plannerAt = windowed.indexOf('planContainment(buildChatWindowContainmentRequest(');
    const capAt = windowed.indexOf('acceptedPlan.mountedCount > CHAT_WINDOW_MOUNT_LIMIT');
    const transactionAt = windowed.indexOf('adapter.beginTransaction(adapterUpdate)');
    const journalAt = windowed.indexOf('beginChatPresentationJournal(');
    const applyAt = windowed.indexOf('applyKeyedChatReconciliation(session, acceptedUnits, acceptedPlan.shellSelections, journal);');
    expect(plannerAt).toBeGreaterThan(transactionAt);
    expect(capAt).toBeGreaterThan(plannerAt);
    expect(applyAt).toBeGreaterThan(capAt);
    expect(applyAt).toBeGreaterThan(journalAt);

    const coordinator = extractFunction('function applyChatWindowOrWave2(');
    const outerPlanAt = coordinator.indexOf('const plan = planContainment({');
    const outerCapAt = coordinator.indexOf('const boundedUnits = units.slice(-CHAT_WINDOW_INITIAL_TAIL);');
    const outerApplyAt = coordinator.indexOf('applyAcceptedOuterTransactionalBootstrap(session, acceptedUnits, shellRequests, plan);');
    expect(outerCapAt).toBeGreaterThanOrEqual(0);
    expect(outerPlanAt).toBeGreaterThan(outerCapAt);
    expect(outerApplyAt).toBeGreaterThan(outerPlanAt);
  });

  test('A2.8-RED4/5 coordinator consumes missing transaction once into retained or empty pending without retry', () => {
    const retained = realTransactionHarness('', false, { missingBeginTransaction: true });
    const retainedChildren = [...retained.chatContainer.children];
    const retainedItems = retained.context.keyedChatReconcileState.items;
    expect(retained.context.applyChatWindowOrWave2(retained.canonicalSession, retained.units))
      .toBe('window-unavailable-retained');
    expect(retained.windowObject.__ocChatWindowRecovery).toEqual({
      status: 'retained', reason: 'missing-begin-transaction', retryAttempted: false,
      retryPending: true, boundedRootCount: 2,
    });
    expect(retained.calls).toEqual(['diagnostic']);
    expect(retained.containmentRequests).toEqual([]);
    expect(retained.transactionUnitCounts).toEqual([]);
    expect(retained.chatContainer.children).toEqual(retainedChildren);
    expect(retained.context.keyedChatReconcileState.items).toBe(retainedItems);

    const empty = realTransactionHarness('', false, { missingBeginTransaction: true });
    for (const root of [...empty.context.keyedChatReconcileState.roots.values()] as any[]) root.remove();
    empty.context.keyedChatReconcileState = { sessionId: 'session-a', items: [], roots: new Map() };
    const emptyChildren = [...empty.chatContainer.children];
    const emptyState = empty.context.keyedChatReconcileState;
    expect(empty.context.applyChatWindowOrWave2(empty.canonicalSession, empty.units))
      .toBe('window-unavailable-bootstrap-pending');
    expect(empty.windowObject.__ocChatWindowRecovery).toEqual({
      status: 'empty', reason: 'missing-begin-transaction', retryAttempted: false,
      retryPending: true, boundedRootCount: 0,
    });
    expect(empty.calls).toEqual(['diagnostic']);
    expect(empty.containmentRequests).toEqual([]);
    expect(empty.transactionUnitCounts).toEqual([]);
    expect(empty.chatContainer.children).toEqual(emptyChildren);
    expect(empty.context.keyedChatReconcileState).toBe(emptyState);
  });

  test('A2.8-SMOKE real adapter ordinary path and session send/stream/final remain transactional', () => {
    const harness = realTransactionHarness('', true);
    const routes = [harness.context.applyChatWindowOrWave2(harness.canonicalSession, harness.units)];
    harness.context.activeSessionId = 'session-b';
    harness.chatWindowState.sessionId = 'session-b';
    harness.context.chatWindowGeneration = 3;
    for (const phase of ['send', 'stream', 'final']) {
      routes.push(harness.context.applyChatWindowOrWave2({ id: 'session-b', phase }, harness.units));
    }
    expect(routes).toEqual(['window', 'window', 'window', 'window']);
    expect(harness.containmentRequests).toHaveLength(4);
    expect(harness.actualConstructions.length).toBeGreaterThanOrEqual(2);
    expect(harness.adapter.getRange().items.length).toBeLessThanOrEqual(140);
    expect(harness.calls).not.toContain('adapter-abort');
    expect(harness.chatContainer.childElementCount).toBeLessThanOrEqual(146);
  });

  test('A2.9-RED1 removes the direct outer keyed fallback and leaves exactly one transactional invocation', () => {
    const coordinator = extractFunction('function applyChatWindowOrWave2(');
    expect(coordinator).not.toContain('applyAcceptedOuterBaseline');
    expect(coordinator).not.toContain('applyKeyedChatReconciliation(');
    expect(source).not.toContain('applyKeyedChatReconciliation(session, acceptedUnits, selections);');
    const invocations = [...source.matchAll(/applyKeyedChatReconciliation\(/g)]
      .map((match) => source.slice(match.index!, source.indexOf('\n', match.index!)))
      .filter((line) => !line.includes('presentationSelections = null, externalJournal = null'));
    expect(invocations).toEqual([
      expect.stringContaining('session, acceptedUnits, acceptedPlan.shellSelections, journal'),
    ]);
  });

  test('A2.9-RED2 transactional bootstrap is nonrecursive and delegates accepted plan ownership only', () => {
    const bootstrap = extractFunction('function applyAcceptedOuterTransactionalBootstrap(');
    expect(bootstrap).toContain('applyWindowedKeyedChatReconciliation(');
    expect(bootstrap).toContain('acceptedPlanOverride: acceptedPlan');
    expect(bootstrap).toContain('skipCorrection: true');
    for (const forbidden of [
      'applyChatWindowOrWave2(', 'applyKeyedChatReconciliation(', 'beginChatPresentationJournal(',
      'applyTransactionalWindow(', 'correctedPlan', 'shellRequest]', 'renderFromStateLegacy',
    ]) expect(bootstrap).not.toContain(forbidden);
  });

  test.each([
    'adapter-prepare', 'adapter-commit', 'adapter-sealed-pre-finalize', 'adapter-finalize-preflight',
    'factory-prepared', 'factory-prepared-multiple', 'remove-applied', 'replace-applied',
  ])('A2.9-RED3 real transactional bootstrap restores exact C0 for %s without a second transaction', (stage) => {
    const harness = realTransactionHarness(stage);
    const keys = harness.units.map((unit: any) => unit.key);
    const acceptedPlan = planChatWindowContainment({
      requestedKeys: keys, visibleLoadedKeys: keys, viewportKeys: keys, coreKeys: [], overscanKeys: [],
      adapterSnapshotKeys: keys, projectedStructuralRoots: 2,
      limits: { mounted: 140, directChildren: 146 }, shellRequests: [],
    });
    const acceptedChildren = [...harness.chatContainer.children];
    const acceptedItems = harness.context.keyedChatReconcileState.items;
    const canonicalIdentity = harness.canonicalSession;
    const canonicalTimeline = harness.canonicalSession.timeline;
    const expectedError = stage === 'adapter-prepare'
      ? 'Chat window adapter transaction prepare failed'
      : stage === 'adapter-commit'
        ? 'Chat window adapter transaction commit failed'
        : stage === 'adapter-finalize-preflight'
          ? 'Chat window adapter transaction finalize failed'
          : `injected:${stage}`;
    expect(() => harness.context.applyAcceptedOuterTransactionalBootstrap(
      harness.canonicalSession, harness.units, [], acceptedPlan,
    )).toThrow(expectedError);
    expect(harness.calls.filter((entry: string) => entry === 'prepare')).toHaveLength(1);
    expect(harness.calls).not.toContain('local-complete');
    expect(harness.transactionUnitCounts).toEqual([harness.units.length]);
    expect(harness.chatContainer.children).toEqual(acceptedChildren);
    expect(harness.context.keyedChatReconcileState.items).toBe(acceptedItems);
    expect([...harness.context.keyedChatReconcileState.roots]).toEqual([...harness.oldRoots]);
    expect(harness.canonicalSession).toBe(canonicalIdentity);
    expect(harness.canonicalSession.timeline).toBe(canonicalTimeline);
    expect(harness.adapterOwner).toBe('old');
    expect(harness.disposed).not.toEqual(expect.arrayContaining(['old-remove', 'old-keep']));
    const candidateDisposals = harness.disposed.filter((entry: string) => entry.startsWith('new:'));
    expect(new Set(candidateDisposals).size).toBe(candidateDisposals.length);
    if (stage === 'adapter-prepare') expect(candidateDisposals).toHaveLength(0);
  });

  test('A2.9-RED4 bounded bootstrap succeeds once and missing transaction returns the shared sentinel unchanged', () => {
    const units = emergencyUnits();
    const boundedUnits = units.slice(-80);
    const keys = boundedUnits.map((unit: any) => unit.key);
    const acceptedPlan = planChatWindowContainment({
      requestedKeys: keys, visibleLoadedKeys: keys, viewportKeys: keys, coreKeys: [], overscanKeys: [],
      adapterSnapshotKeys: keys, projectedStructuralRoots: 2,
      limits: { mounted: 140, directChildren: 146 }, shellRequests: [],
    });
    const success = realTransactionHarness('', false, { units: boundedUnits });
    expect(success.context.applyAcceptedOuterTransactionalBootstrap(
      success.canonicalSession, boundedUnits, [], acceptedPlan,
    )).toHaveLength(80);
    expect(success.calls.filter((entry: string) => entry === 'prepare')).toHaveLength(1);
    expect(success.calls.filter((entry: string) => entry === 'adapter-finalize')).toHaveLength(1);
    expect(success.calls.filter((entry: string) => entry === 'local-complete')).toHaveLength(1);
    expect(success.context.keyedChatReconcileState.items).toHaveLength(80);
    expect(success.chatContainer.childElementCount).toBeLessThanOrEqual(146);

    const missing = realTransactionHarness('', false, { units: boundedUnits, missingBeginTransaction: true });
    const children = [...missing.chatContainer.children];
    const state = missing.context.keyedChatReconcileState;
    const result = missing.context.applyAcceptedOuterTransactionalBootstrap(
      missing.canonicalSession, boundedUnits, [], acceptedPlan,
    );
    expect(result).toBe(missing.context.CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT);
    expect(missing.calls).toEqual([]);
    expect(missing.chatContainer.children).toEqual(children);
    expect(missing.context.keyedChatReconcileState).toBe(state);
  });

  test('A2.9-RED5 rejects substituted bootstrap ownership', () => {
    const assertAuthentic = (candidate: any) => {
      const body = Function.prototype.toString.call(candidate);
      if (!body.includes('applyWindowedKeyedChatReconciliation')
        || !body.includes('acceptedPlanOverride: acceptedPlan')
        || !body.includes('skipCorrection: true')) throw new Error('test-owned bootstrap is forbidden');
    };
    expect(() => assertAuthentic(() => [])).toThrow('test-owned bootstrap is forbidden');
    expect(() => assertAuthentic(realTransactionHarness().context.applyAcceptedOuterTransactionalBootstrap)).not.toThrow();
  });

  test('A2.10-RED1 freezes unpublished candidate ordering, full handle validation, and one-handle consumption', () => {
    expect(source).toContain('const CHAT_WINDOW_CANDIDATE_STALE_RESULT = Object.freeze({');
    const prepare = extractFunction('function prepareUnpublishedChatWindowTransaction(');
    const cleanup = extractFunction('function disposeUnpublishedChatWindowAdapterCandidate(');
    const windowed = extractFunction('function applyWindowedKeyedChatReconciliation(');
    for (const method of [
      'getRange', 'update', 'observeElement', 'unobserveElement', 'invalidateMeasurement',
      'setPresentationRevision', 'migrateKey', 'prepareCommit', 'commit', 'finalizeCommit',
      'retryCompletion', 'isFinalized', 'isDegraded', 'hasPendingCompletion', 'abort',
    ]) expect(source).toContain(`'${method}'`);
    const planAt = prepare.indexOf('planContainment(');
    const factoryAt = prepare.indexOf('rendering.createTanStackVirtualAdapter({');
    const beginAt = prepare.indexOf('beginTransaction.call(candidateAdapter, adapterUpdate)');
    const publishAt = prepare.indexOf('chatWindowState.adapter = candidateAdapter;');
    expect(planAt).toBeGreaterThanOrEqual(0);
    expect(factoryAt).toBeGreaterThan(planAt);
    expect(beginAt).toBeGreaterThan(factoryAt);
    expect(publishAt).toBeGreaterThan(beginAt);
    expect(prepare.match(/beginTransaction\.call\(/g) || []).toHaveLength(1);
    expect(cleanup).toContain('candidateAdapter.destroy');
    expect(cleanup).not.toContain('destroyChatWindowAdapter');
    expect(windowed).toContain('transactionControl?.stagedAttempt');
    expect(windowed).toContain('stagedAttempt.adapterTransaction');
    expect(prepare).toContain("initialOwnerMode: 'deferred-transaction'");
    expect(prepare).toContain("getInitialOwnerState.call(candidateAdapter) !== 'deferred'");
  });

  const A210_TRANSACTION_METHODS = [
    'getRange', 'update', 'observeElement', 'unobserveElement', 'invalidateMeasurement',
    'setPresentationRevision', 'migrateKey', 'prepareCommit', 'commit', 'finalizeCommit',
    'retryCompletion', 'isFinalized', 'isDegraded', 'hasPendingCompletion', 'abort',
  ];

  function candidateStagingHarness(options: Record<string, any> = {}) {
    const calls: string[] = [];
    const adaptiveInputs: any[] = [];
    const units = Array.from({ length: 100 }, (_, index) => ({
      key: `unit-${index}`, kind: 'message', value: { message: { role: 'assistant' } },
    }));
    let callbacks: any = null;
    let actualUpdate: any = null;
    let validationEffectFired = false;
    const transaction: any = {};
    for (const method of A210_TRANSACTION_METHODS) {
      transaction[method] = (..._args: any[]) => {
        calls.push(method);
        if (method === 'abort' && options.abortThrows) throw new Error('abort-throw');
        return method === 'getRange' ? { items: [], totalSize: 0 } : true;
      };
    }
    if (options.handleMethod) {
      if (options.handleFailure === 'missing') delete transaction[options.handleMethod];
      if (options.handleFailure === 'nonfunction') transaction[options.handleMethod] = 1;
      if (options.handleFailure === 'getter-throw') {
        Object.defineProperty(transaction, options.handleMethod, {
          configurable: true,
          get() { calls.push(`get:${options.handleMethod}`); throw new Error('handle-getter-throw'); },
        });
      }
    }
    if (options.validationEffectMethod) {
      const value = transaction[options.validationEffectMethod];
      Object.defineProperty(transaction, options.validationEffectMethod, {
        configurable: true,
        get() {
          if (!validationEffectFired) {
            validationEffectFired = true;
            callbacks.onRangeChange({ items: [{ key: 'validation' }] });
            callbacks.onMeasurements({ changedKeys: ['validation'], totalSize: 1 });
            options.validationMutation?.(context);
          }
          return value;
        },
      });
    }
    const candidate: any = {
      getInitialOwnerState: () => 'deferred',
      destroy: () => {
        calls.push('destroy');
        if (options.destroyThrows) throw new Error('destroy-throw');
      },
    };
    if (options.initialStateMode === 'missing') delete candidate.getInitialOwnerState;
    if (options.initialStateMode === 'nonfunction') candidate.getInitialOwnerState = 1;
    if (options.initialStateMode === 'wrong') candidate.getInitialOwnerState = () => 'active';
    if (options.initialStateMode === 'getter-throw') {
      Object.defineProperty(candidate, 'getInitialOwnerState', {
        configurable: true,
        get() { calls.push('initial-state-getter'); throw new Error('initial-state-getter-throw'); },
      });
    }
    if (options.beginMode !== 'missing') {
      if (options.beginMode === 'nonfunction') candidate.beginTransaction = 1;
      else if (options.beginMode === 'getter-throw') {
        Object.defineProperty(candidate, 'beginTransaction', {
          get() { calls.push('begin-getter'); throw new Error('begin-getter-throw'); },
        });
      } else {
        candidate.beginTransaction = (update: any) => {
          calls.push('begin');
          actualUpdate = update;
          if (options.callbacksDuringBegin) {
            callbacks.onRangeChange({ items: [{ key: 'begin' }] });
            callbacks.onMeasurements({ changedKeys: ['begin'], totalSize: 1 });
          }
          options.beginMutation?.(context);
          if (options.beginThrows) throw new Error('begin-throw');
          return options.nullHandle ? null : transaction;
        };
      }
    }
    const chatWindowState: any = {
      sessionId: '', adapter: null, snapshot: { accepted: true }, allUnits: [{ key: 'accepted' }],
      mountedKeys: new Set(['accepted']), anchorKey: 'accepted', pendingRangeRender: false,
      pendingScrollKey: '', pendingScrollAttempts: 0, rendering: false,
      localOlderSurface: null, localHistoryPresentation: { accepted: true },
    };
    const rendering = {
      deriveLocalOlderPresentation: (request: any) => {
        calls.push('derive');
        return Object.freeze({ state: 'available', revealStart: request.revealStart });
      },
      planChatWindowContainment: (request: any) => {
        calls.push('plan');
        return Object.freeze({
          allowed: options.planDenied !== true,
          acceptedKeys: request.requestedKeys.slice(-2),
          mountedCount: 2,
          directChildCount: 5,
          shellSelections: { 'unit-98': { mode: 'safe-shell', family: 'message-code' } },
        });
      },
      presentationFingerprint: (value: any) => JSON.stringify(value),
      decideChatWindowAdaptivePolicy: (input: any) => {
        adaptiveInputs.push(input);
        return decideChatWindowAdaptivePolicy(input);
      },
      createTanStackVirtualAdapter: (config: any) => {
        calls.push('factory');
        callbacks = config;
        if (options.callbacksDuringFactory) {
          callbacks.onRangeChange({ items: [{ key: 'factory' }] });
          callbacks.onMeasurements({ changedKeys: ['factory'], totalSize: 1 });
        }
        options.factoryMutation?.(context);
        if (options.factoryThrows) throw new Error('factory-throw');
        return options.nullCandidate ? null : candidate;
      },
    };
    const context: any = executeFunctions([
      'function boundedChatAdaptiveCount(',
      'function createChatWindowAdaptiveShadowState(',
      'function publishChatWindowAdaptiveShadowTelemetry(',
      'function resetChatWindowAdaptiveShadow(',
      'function resolveChatWindowAdaptiveShadowConfig(',
      'function observeChatWindowAdaptiveShadow(',
      'function createChatWindowAdaptiveObservations(',
      'function getChatWindowKeepMountedKeys(',
      'function getChatWindowUnitKind(',
      'function getKeyedPresentationIdentity(',
      'function disposeUnpublishedChatWindowAdapterCandidate(',
      'function prepareUnpublishedChatWindowTransaction(',
      'function destroyChatWindowAdapter(',
    ], {
      activeSessionId: 'session-a', chatWindowGeneration: 4, chatWindowState,
      chatWindowAdaptiveShadow: null,
      window: {
        __ocRendering: rendering,
        __ocChatWindowAdaptiveShadowTestConfig: options.adaptiveConfig,
      }, sessionSearch: { windowTargetKey: '' },
      CHAT_WINDOW_ADAPTIVE_SHADOW_CONFIG: Object.freeze({
        enabled: false, revision: 1,
        pressure: Object.freeze({ mountedAtLeast: 130, directChildrenAtLeast: 140, descendantsAtLeast: 900, renderCostAtLeast: 80, measureCostAtLeast: 70 }),
        headroom: Object.freeze({ mountedAtMost: 90, directChildrenAtMost: 96, descendantsAtMost: 400, renderCostAtMost: 30, measureCostAtMost: 25 }),
        pressureConsecutiveIntervals: 2, headroomConsecutiveIntervals: 2, cooldownIntervals: 2,
        minimumAheadItems: 1, minimumBehindItems: 1, fastScrollDirectionalReserve: 5,
      }),
      CHAT_WINDOW_INITIAL_TAIL: 80, CHAT_WINDOW_MOUNT_LIMIT: 140,
      CHAT_WINDOW_DIRECT_CHILD_LIMIT: 146, CHAT_WINDOW_OVERSCAN: 20,
      chatContainer: { clientHeight: 400, classList: { remove: () => calls.push('class-remove') } },
      getSessionState: () => ({ hydrationCoverage: null }),
      normalizePayloadHydrationCoverage: () => null,
      projectChatWindowStructuralRoots: () => 3,
      getKeyedUnitPresentation: (_session: any, unit: any) => ({ key: unit.key }),
      beginChatWindowPressureGeneration: (generation: number) => calls.push(`pressure:${generation}`),
      recordChatWindowStaleCallback: () => calls.push('stale-callback'),
      scheduleRenderFromState: () => calls.push('schedule'),
      updateChatWindowSpacers: () => calls.push('spacers'),
      vscode: { postMessage: () => calls.push('message') },
      autoScrollPinnedToBottom: false, scrollToBottom: () => calls.push('scroll'),
      restoreChatWindowAnchor: () => calls.push('anchor'),
      chatLocalHistoryController: { complete: () => calls.push('local-complete') },
      destroyChatLocalOlderSurface: () => calls.push('local-destroy'),
      closeChatWindowPressureGeneration: () => calls.push('pressure-close'),
      keyedRoots: () => [],
    });
    const c0 = {
      generation: context.chatWindowGeneration,
      sessionId: chatWindowState.sessionId,
      adapter: chatWindowState.adapter,
      snapshot: chatWindowState.snapshot,
      allUnits: chatWindowState.allUnits,
      mountedKeys: chatWindowState.mountedKeys,
      localHistoryPresentation: chatWindowState.localHistoryPresentation,
    };
    return {
      calls, adaptiveInputs, units, candidate, transaction, chatWindowState, context, c0,
      get callbacks() { return callbacks; }, get actualUpdate() { return actualUpdate; },
    };
  }

  test('B3 real range and measurement callbacks observe self without committing churn; later external pressure advances', () => {
    const harness = candidateStagingHarness({
      adaptiveConfig: { syntheticEnvironment: true, enabled: true, revision: 9 },
    });
    harness.context.prepareUnpublishedChatWindowTransaction({}, harness.units, [], null);
    const roles = {
      visible: 8, core: 0, currentStreamingAssistant: 0, thinkingAlias: 0,
      pairedActiveUser: 0, appendRoot: 0, readingAnchor: 0, searchTarget: 0, overscan: 20,
    };
    const pressure = {
      mountedCount: 130, directChildCount: 140, descendantCount: 900, viewportItemDemand: 8,
      renderCost: 80, measureCost: 70, projectedStructuralRoots: 6,
      currentRequestedCount: 140, currentAcceptedCount: 140,
      roleOutcomes: {
        accepted: roles,
        capped: { ...roles, visible: 0, overscan: 0 },
        deferred: { ...roles, visible: 0, overscan: 0 },
      },
    };
    harness.context.observeChatWindowAdaptiveShadow(pressure, { kind: 'external', decisionGeneration: 0 });
    const committedState = harness.context.chatWindowAdaptiveShadow.state;
    const committedTelemetry = harness.context.window.__ocChatWindowAdaptiveShadow;
    expect(committedState).toMatchObject({ pressureCount: 1, overscanTier: 20, initialTail: 80, decisionGeneration: 0 });

    harness.callbacks.onRangeChange({
      items: [{ key: 'unit-98', start: 0, end: 50 }, { key: 'unit-99', start: 50, end: 100 }], totalSize: 100,
    });
    expect(harness.adaptiveInputs.at(-1).provenance).toEqual({ kind: 'self', decisionGeneration: 0 });
    expect(harness.context.chatWindowAdaptiveShadow.state).toBe(committedState);
    expect(harness.context.window.__ocChatWindowAdaptiveShadow).toBe(committedTelemetry);
    const callsAfterRange = [...harness.calls];

    harness.callbacks.onMeasurements({ changedKeys: ['unit-98'], totalSize: 100 });
    expect(harness.adaptiveInputs.at(-1).provenance).toEqual({ kind: 'self', decisionGeneration: 0 });
    expect(harness.context.chatWindowAdaptiveShadow.state).toBe(committedState);
    expect(harness.context.window.__ocChatWindowAdaptiveShadow).toBe(committedTelemetry);
    expect(harness.calls.filter((entry: string) => entry === 'schedule')).toHaveLength(1);
    expect(harness.calls.slice(callsAfterRange.length)).toEqual(['message', 'anchor']);

    harness.context.observeChatWindowAdaptiveShadow(pressure, { kind: 'external', decisionGeneration: 0 });
    expect(harness.context.chatWindowAdaptiveShadow.state).toMatchObject({
      pressureCount: 0, overscanTier: 10, initialTail: 40, decisionGeneration: 1,
    });
    expect(harness.adaptiveInputs.at(-1).provenance.kind).toBe('external');
  });

  test('B3 stale decision/session and destroyed-adapter callbacks cannot observe or reset the new owner', () => {
    const harness = candidateStagingHarness({
      adaptiveConfig: { syntheticEnvironment: true, enabled: true, revision: 9 },
    });
    harness.context.prepareUnpublishedChatWindowTransaction({}, harness.units, [], null);
    const beforeStaleDecision = harness.adaptiveInputs.length;
    expect(harness.context.observeChatWindowAdaptiveShadow({}, { kind: 'self', decisionGeneration: 9 })).toBeNull();
    expect(harness.adaptiveInputs).toHaveLength(beforeStaleDecision);

    harness.context.destroyChatWindowAdapter('adapter-destroy');
    const destroyedOwner = harness.context.chatWindowAdaptiveShadow;
    const beforeDestroyedCallbacks = harness.adaptiveInputs.length;
    harness.callbacks.onRangeChange({ items: [{ key: 'stale' }], totalSize: 1 });
    harness.callbacks.onMeasurements({ changedKeys: ['stale'], totalSize: 1 });
    expect(harness.adaptiveInputs).toHaveLength(beforeDestroyedCallbacks);
    expect(harness.context.chatWindowAdaptiveShadow).toBe(destroyedOwner);

    harness.context.activeSessionId = 'session-b';
    harness.context.chatWindowGeneration += 1;
    harness.context.resetChatWindowAdaptiveShadow('session-switch');
    const switchedOwner = harness.context.chatWindowAdaptiveShadow;
    harness.callbacks.onRangeChange({ items: [{ key: 'stale-session' }], totalSize: 1 });
    harness.callbacks.onMeasurements({ changedKeys: ['stale-session'], totalSize: 1 });
    expect(harness.adaptiveInputs).toHaveLength(beforeDestroyedCallbacks);
    expect(harness.context.chatWindowAdaptiveShadow).toBe(switchedOwner);
  });

  function expectCandidateC0(harness: ReturnType<typeof candidateStagingHarness>) {
    expect(harness.context.chatWindowGeneration).toBe(harness.c0.generation);
    expect(harness.chatWindowState).toEqual(expect.objectContaining({
      sessionId: harness.c0.sessionId,
      adapter: harness.c0.adapter,
      snapshot: harness.c0.snapshot,
      allUnits: harness.c0.allUnits,
      mountedKeys: harness.c0.mountedKeys,
      localHistoryPresentation: harness.c0.localHistoryPresentation,
    }));
    expect(harness.calls).not.toEqual(expect.arrayContaining([
      'pressure:5', 'schedule', 'spacers', 'message', 'scroll', 'anchor', 'stale-callback',
    ]));
  }

  test.each(['missing', 'nonfunction', 'getter-throw'])('A2.10-RED2 rejects %s begin capability at exact C0', (beginMode) => {
    const harness = candidateStagingHarness({ beginMode });
    const result = harness.context.prepareUnpublishedChatWindowTransaction({}, harness.units, [], null);
    expect(result).toBe(harness.context.CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT);
    expect(harness.calls.filter((entry) => entry === 'factory')).toHaveLength(1);
    expect(harness.calls.filter((entry) => entry === 'begin')).toHaveLength(0);
    expect(harness.calls.filter((entry) => entry === 'destroy')).toHaveLength(1);
    expectCandidateC0(harness);
  });

  test.each(['missing', 'nonfunction', 'getter-throw', 'wrong'])(
    'A2.11-RED3 rejects %s deferred initial state before begin and preserves C0',
    (initialStateMode) => {
      const harness = candidateStagingHarness({ initialStateMode });
      const result = harness.context.prepareUnpublishedChatWindowTransaction({}, harness.units, [], null);
      expect(result).toBe(harness.context.CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT);
      expect(harness.calls.filter((entry) => entry === 'factory')).toHaveLength(1);
      expect(harness.calls.filter((entry) => entry === 'begin')).toHaveLength(0);
      expect(harness.calls.filter((entry) => entry === 'destroy')).toHaveLength(1);
      expectCandidateC0(harness);
    },
  );

  test('A2.11-RED4/5 journals deferred shell reservation from prepublication C0 through the sole finalize barrier', () => {
    const capture = extractFunction('function captureChatWindowAcceptedState(');
    const restore = extractFunction('function restoreChatWindowAcceptedState(');
    const prepare = extractFunction('function prepareUnpublishedChatWindowTransaction(');
    const windowed = extractFunction('function applyWindowedKeyedChatReconciliation(');
    expect(capture).toContain('chatWindowGeneration');
    expect(capture).toContain('pressureLifecycleCurrent');
    expect(restore).toContain('chatWindowGeneration = acceptedState.chatWindowGeneration;');
    expect(restore).toContain('chatWindowPressureLifecycle.current = acceptedState.pressureLifecycleCurrent;');
    expect(prepare.indexOf('captureChatWindowAcceptedState()')).toBeLessThan(prepare.indexOf('chatWindowState.adapter = candidateAdapter;'));
    expect(prepare).toContain('unpublishedChatWindowCandidateAcceptedStates.set(candidateAdapter, candidateAcceptedState);');
    expect(windowed).toContain('unpublishedChatWindowCandidateAcceptedStates.get(adapter)');
    expect(windowed.indexOf('adapterTransaction.finalizeCommit()'))
      .toBeLessThan(windowed.indexOf('unpublishedChatWindowCandidateAcceptedStates.delete(adapter)'));
  });

  test('A2.11-RED5 extracted main restores deferred shell generation/session/pressure C0 before finalize', () => {
    const harness = realTransactionHarness('adapter-sealed-pre-finalize', true, { noLiveAdapter: true });
    const keys = harness.units.map((unit: any) => unit.key);
    const plan = planChatWindowContainment({
      requestedKeys: keys, visibleLoadedKeys: keys, viewportKeys: keys, coreKeys: [], overscanKeys: [],
      adapterSnapshotKeys: keys, projectedStructuralRoots: 2,
      limits: { mounted: 140, directChildren: 146 }, shellRequests: [],
    });
    const pressureC0 = harness.pressureLifecycle.current;
    expect(() => harness.context.applyAcceptedOuterTransactionalBootstrap(
      harness.canonicalSession, harness.units, [], plan,
    )).toThrow('injected:adapter-sealed-pre-finalize');
    expect(harness.context.chatWindowGeneration).toBe(2);
    expect(harness.chatWindowState.sessionId).toBe('');
    expect(harness.chatWindowState.adapter).toBeNull();
    expect(harness.pressureLifecycle.current).toBe(pressureC0);
    expect(harness.actualConstructions).toHaveLength(1);
    expect(harness.actualConstructions[0].mountCount).toBe(0);
    expect(harness.actualConstructions[0].updateCount).toBe(0);
    expect(harness.actualObservers).toHaveLength(0);
    expect(harness.calls.filter((entry: string) => entry === 'pressure-reserve')).toHaveLength(1);
    expect(harness.calls).not.toEqual(expect.arrayContaining(['local-complete', 'stale-callback']));
  });

  test('A2.10-RED2 rejects null handle and every incomplete handle member with one-handle cleanup', () => {
    const nullHandle = candidateStagingHarness({ nullHandle: true });
    expect(nullHandle.context.prepareUnpublishedChatWindowTransaction({}, nullHandle.units, [], null))
      .toBe(nullHandle.context.CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT);
    expect(nullHandle.calls.filter((entry) => entry === 'begin')).toHaveLength(1);
    expect(nullHandle.calls.filter((entry) => entry === 'abort')).toHaveLength(0);
    expect(nullHandle.calls.filter((entry) => entry === 'destroy')).toHaveLength(1);
    expectCandidateC0(nullHandle);

    for (const method of A210_TRANSACTION_METHODS) {
      for (const handleFailure of ['missing', 'nonfunction', 'getter-throw']) {
        const harness = candidateStagingHarness({ handleMethod: method, handleFailure });
        const result = harness.context.prepareUnpublishedChatWindowTransaction({}, harness.units, [], null);
        expect(result).toBe(harness.context.CHAT_WINDOW_TRANSACTION_UNAVAILABLE_RESULT);
        expect(harness.calls.filter((entry) => entry === 'begin')).toHaveLength(1);
        expect(harness.calls.filter((entry) => entry === 'abort')).toHaveLength(method === 'abort' ? 0 : 1);
        expect(harness.calls.filter((entry) => entry === 'destroy')).toHaveLength(1);
        expectCandidateC0(harness);
      }
    }
  });

  test.each([
    { factoryThrows: true }, { beginThrows: true },
    { handleMethod: 'commit', handleFailure: 'missing', abortThrows: true },
    { beginMode: 'missing', destroyThrows: true },
  ])('A2.10-RED3 contains factory/begin/abort/destroy rejection throws', (options) => {
    const harness = candidateStagingHarness(options);
    expect(() => harness.context.prepareUnpublishedChatWindowTransaction({}, harness.units, [], null)).not.toThrow();
    expectCandidateC0(harness);
    expect(harness.calls.filter((entry) => entry === 'factory')).toHaveLength(1);
    expect(harness.calls.filter((entry) => entry === 'begin').length).toBeLessThanOrEqual(1);
    expect(harness.calls.filter((entry) => entry === 'abort').length).toBeLessThanOrEqual(1);
    expect(harness.calls.filter((entry) => entry === 'destroy').length).toBeLessThanOrEqual(1);
  });

  test.each([
    { callbacksDuringFactory: true },
    { callbacksDuringBegin: true },
    { validationEffectMethod: 'commit' },
  ])('A2.10-RED4 suppresses candidate callbacks until publication', (options) => {
    const harness = candidateStagingHarness(options);
    const staged = harness.context.prepareUnpublishedChatWindowTransaction({}, harness.units, [], null);
    expect(staged.candidateAdapter).toBe(harness.candidate);
    expect(harness.calls).not.toEqual(expect.arrayContaining(['schedule', 'message', 'scroll', 'anchor', 'stale-callback']));
    harness.callbacks.onRangeChange({ items: [{ key: 'published' }] });
    harness.callbacks.onMeasurements({ changedKeys: ['published'], totalSize: 1 });
    expect(harness.calls.filter((entry) => entry === 'schedule')).toHaveLength(1);
    expect(harness.calls.filter((entry) => entry === 'message')).toHaveLength(1);
    expect(harness.calls.filter((entry) => entry === 'anchor')).toHaveLength(1);
  });

  test.each([
    ['factory-session', { factoryMutation: (context: any) => { context.activeSessionId = 'session-b'; } }],
    ['begin-generation', { beginMutation: (context: any) => { context.chatWindowGeneration += 1; } }],
    ['validation-owner', { validationEffectMethod: 'commit', validationMutation: (context: any) => {
      context.chatWindowState.adapter = { old: true };
    } }],
  ])('A2.10-RED5 rejects stale %s ownership without replacing the observed owner', (_label, options) => {
    const harness = candidateStagingHarness(options);
    const result = harness.context.prepareUnpublishedChatWindowTransaction({}, harness.units, [], null);
    expect(result).toBe(harness.context.CHAT_WINDOW_CANDIDATE_STALE_RESULT);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).toEqual({ ok: false, status: 'window-candidate-stale', reason: 'candidate-owner-stale' });
    expect(harness.calls.filter((entry) => entry === 'begin')).toHaveLength(1);
    expect(harness.calls.filter((entry) => entry === 'abort')).toHaveLength(1);
    expect(harness.calls.filter((entry) => entry === 'destroy')).toHaveLength(1);
    expect(harness.calls).not.toEqual(expect.arrayContaining(['pressure:5', 'schedule', 'message']));
    if (_label === 'validation-owner') expect(harness.chatWindowState.adapter).toEqual({ old: true });
    else expect(harness.chatWindowState.adapter).toBeNull();
  });

  test.each([
    ['window-unavailable-retained', false, 'retained', 2],
    ['window-unavailable-bootstrap-pending', true, 'empty', 0],
  ])('A2.10-RED5 coordinator consumes stale ownership once into %s', (route, empty, status, rootCount) => {
    const harness = realTransactionHarness();
    harness.chatWindowState.sessionId = 'different-owner';
    if (empty) {
      for (const root of [...harness.context.keyedChatReconcileState.roots.values()] as any[]) root.remove();
      harness.context.keyedChatReconcileState = { sessionId: 'session-a', items: [], roots: new Map() };
    }
    expect(harness.context.applyChatWindowOrWave2(harness.canonicalSession, harness.units)).toBe(route);
    expect(harness.windowObject.__ocChatWindowRecovery).toEqual({
      status, reason: 'candidate-owner-stale', retryAttempted: false,
      retryPending: true, boundedRootCount: rootCount,
    });
    expect(harness.calls).toEqual(['diagnostic']);
    expect(harness.calls).not.toEqual(expect.arrayContaining(['destroy', 'local-complete', 'prepare']));
    expect(harness.containmentRequests).toEqual([]);
    expect(harness.transactionUnitCounts).toEqual([]);
  });

  test('A2.10-RED6/7 publishes one exact bounded accepted update and frozen staged handle once', () => {
    const harness = candidateStagingHarness();
    const staged = harness.context.prepareUnpublishedChatWindowTransaction({}, harness.units, [], null);
    expect(Object.isFrozen(staged)).toBe(true);
    expect(Object.keys(staged)).toEqual([
      'candidateAdapter', 'adapterTransaction', 'adapterUpdate', 'localWindow', 'acceptedPlan',
    ]);
    expect(staged.candidateAdapter).toBe(harness.candidate);
    expect(staged.adapterTransaction).toBe(harness.transaction);
    expect(staged.adapterUpdate).toBe(harness.actualUpdate);
    expect(staged.adapterUpdate.keys).toEqual(['unit-98', 'unit-99']);
    expect(staged.localWindow.visibleUnits.map((unit: any) => unit.key)).toEqual(['unit-98', 'unit-99']);
    expect(staged.adapterUpdate.presentationRevisions[0]).toContain('safe-shell');
    expect(harness.calls.slice(0, 4)).toEqual(['derive', 'plan', 'factory', 'begin']);
    expect(harness.calls.filter((entry) => entry === 'factory')).toHaveLength(1);
    expect(harness.calls.filter((entry) => entry === 'begin')).toHaveLength(1);
    expect(harness.calls.filter((entry) => entry === 'pressure:5')).toHaveLength(1);
    expect(harness.context.chatWindowGeneration).toBe(5);
    expect(harness.chatWindowState.sessionId).toBe('session-a');
    expect(harness.chatWindowState.adapter).toBe(harness.candidate);
  });

  test('CF2 established transaction bypasses synchronous public update and acknowledges the accepted raw superset', () => {
    const units = Array.from({ length: 220 }, (_, index) => ({
      key: `cf2-${index}`, kind: 'greeting', revision: `cf2-r${index}`, value: null,
    }));
    const harness = realTransactionHarness('', false, { units });
    harness.chatWindowState.pendingScrollKey = '';
    harness.chatWindowState.pendingRangeRender = false;
    const publicUpdates: any[] = [];
    harness.adapter.update = (update: any) => {
      publicUpdates.push(update);
      harness.calls.push('schedule:window-range-change');
      harness.chatWindowState.pendingRangeRender = true;
    };
    const beginUpdates: any[] = [];
    const acknowledgmentsAtFinalize: any[] = [];
    let journalOpen = false;
    const originalJournal = harness.context.beginChatPresentationJournal;
    harness.context.beginChatPresentationJournal = (...args: any[]) => {
      journalOpen = true;
      return originalJournal(...args);
    };
    const originalKeyedApply = harness.context.applyKeyedChatReconciliation;
    harness.context.applyKeyedChatReconciliation = (...args: any[]) => {
      expect(journalOpen).toBe(true);
      harness.calls.push('keyed');
      return originalKeyedApply(...args);
    };
    const originalJournalFinalize = harness.context.finalizeChatPresentationJournal;
    harness.context.finalizeChatPresentationJournal = (...args: any[]) => {
      const result = originalJournalFinalize(...args);
      journalOpen = false;
      return result;
    };
    const originalBegin = harness.adapter.beginTransaction.bind(harness.adapter);
    harness.adapter.beginTransaction = (update: any) => {
      beginUpdates.push(update);
      harness.calls.push('begin');
      const handle = originalBegin(update);
      const originalFinalize = handle.finalizeCommit.bind(handle);
      handle.finalizeCommit = () => {
        acknowledgmentsAtFinalize.push(harness.chatWindowState.acknowledgedRawSnapshot);
        return originalFinalize();
      };
      return handle;
    };
    const ensureContext = executeCf2Functions(['function ensureChatWindowAdapter('], {
      activeSessionId: 'session-a', chatWindowState: harness.chatWindowState, window: harness.windowObject,
      getChatWindowUnitKind: () => 'assistant', getKeyedUnitPresentation: (_session: any, unit: any) => ({ key: unit.key, revision: unit.revision }),
      getChatWindowKeepMountedKeys: () => ['cf2-219'], prepareUnpublishedChatWindowTransaction: () => null,
    });
    harness.context.ensureChatWindowAdapter = ensureContext.ensureChatWindowAdapter;

    const accepted = harness.context.applyWindowedKeyedChatReconciliation(harness.canonicalSession, units);
    expect(accepted).toHaveLength(140);
    expect(publicUpdates).toHaveLength(0);
    expect(harness.calls).not.toContain('schedule:window-range-change');
    expect(beginUpdates).toHaveLength(1);
    expect(beginUpdates[0]).toEqual(expect.objectContaining({
      keys: units.map((unit) => unit.key),
      kinds: units.map(() => 'system'),
      presentationRevisions: units.map((unit) => JSON.stringify({ key: unit.key, revision: unit.revision })),
      keepMountedKeys: ['keep'],
    }));
    expect(harness.calls).toEqual(expect.arrayContaining(['begin', 'prepare', 'adapter-finalize']));
    expect(harness.calls.indexOf('begin')).toBeLessThan(harness.calls.indexOf('prepare'));
    expect(harness.calls.indexOf('prepare')).toBeLessThan(harness.calls.indexOf('keyed'));
    expect(harness.calls.indexOf('keyed')).toBeLessThan(harness.calls.indexOf('commit'));
    expect(harness.calls.indexOf('commit')).toBeLessThan(harness.calls.indexOf('adapter-finalize'));
    expect(journalOpen).toBe(false);
    expect(acknowledgmentsAtFinalize).toEqual([undefined]);
    expect(harness.chatWindowState.acknowledgedRawSnapshot).toEqual({
      items: units.map((unit, index) => ({ key: unit.key, index: undefined, start: index * 50, end: (index + 1) * 50, size: undefined })),
      totalSize: 11000,
    });
    expect(harness.chatWindowState.acknowledgedRawSnapshot.items).not.toBe(harness.chatWindowState.snapshot.items);
    expect(JSON.stringify(harness.chatWindowState.acknowledgedRawSnapshot)).not.toMatch(/value|message|dataset|element|content/i);

    ensureContext.ensureChatWindowAdapter(harness.canonicalSession, units);
    expect(publicUpdates).toHaveLength(1); // explicit non-transaction behavior remains available
  });

  test('CF2 committed-degraded finalization acknowledges only the finalized raw snapshot', () => {
    const harness = cf2TransactionHarness('post-barrier-unexpected');
    harness.chatWindowState.pendingScrollKey = '';
    const accepted = harness.context.applyWindowedKeyedChatReconciliation(harness.canonicalSession, harness.units);
    expect(accepted.map((unit: any) => unit.key)).toEqual(['new', 'keep']);
    expect(harness.adapterOwner).toBe('candidate');
    expect(harness.windowObject.__ocChatWindowRecovery).toEqual({ status: 'committed-degraded', generation: 2 });
    expect(harness.chatWindowState.acknowledgedRawSnapshot).toEqual({
      items: [
        { key: 'new', index: undefined, start: 0, end: 50, size: undefined },
        { key: 'keep', index: undefined, start: 50, end: 100, size: undefined },
      ],
      totalSize: 100,
    });
  });

  test('CF2 no-MEASURE raw strict superset dedupes before spacers and converges for key, geometry, and total changes', () => {
    const harness = candidateStagingHarness();
    harness.context.prepareUnpublishedChatWindowTransaction({}, harness.units, [], null);
    harness.chatWindowState.mountedKeys = new Set(['unit-98', 'unit-99']);
    const snapshot = (overrides: Record<string, any> = {}) => ({
      items: [
        { key: 'unit-97', index: 97, start: 0, size: 40, end: 40 },
        { key: 'unit-98', index: 98, start: 40, size: 50, end: 90 },
        { key: 'unit-99', index: 99, start: 90, size: 60, end: 150 },
      ],
      totalSize: 150,
      ...overrides,
    });
    const acknowledge = (raw: any) => {
      harness.chatWindowState.acknowledgedRawSnapshot = Object.freeze({
        items: Object.freeze(raw.items.map((item: any) => Object.freeze({
          key: item.key, index: item.index, start: item.start, end: item.end, size: item.size,
        }))),
        totalSize: raw.totalSize,
      });
      harness.chatWindowState.pendingRangeRender = false;
    };
    const scheduleCount = () => harness.calls.filter((entry: string) => entry === 'schedule').length;
    const spacerCount = () => harness.calls.filter((entry: string) => entry === 'spacers').length;
    const stable = snapshot();
    acknowledge(stable);

    const stableBefore = scheduleCount();
    harness.callbacks.onRangeChange(stable);
    harness.callbacks.onRangeChange(snapshot());
    expect(scheduleCount() - stableBefore).toBe(0);
    expect(spacerCount()).toBe(0);
    expect(harness.calls).not.toContain('message'); // no MEASURE callback was involved

    const mutations = [
      snapshot({ items: [{ ...stable.items[0], key: 'unit-96' }, ...stable.items.slice(1)] }),
      snapshot({ items: [stable.items[0], { ...stable.items[1], start: 41, end: 91 }, stable.items[2]] }),
      snapshot({ totalSize: 151 }),
    ];
    for (const changed of mutations) {
      const before = scheduleCount();
      harness.callbacks.onRangeChange(changed);
      expect(scheduleCount() - before).toBe(1);
      acknowledge(changed); // models the raw snapshot acknowledged by the successful transaction
      harness.callbacks.onRangeChange({ items: changed.items.map((item: any) => ({ ...item })), totalSize: changed.totalSize });
      expect(scheduleCount() - before).toBe(1);
      expect(harness.chatWindowState.pendingRangeRender).toBe(false);
    }
    expect(spacerCount()).toBe(0);
  });

  test('CF2 identical acknowledged range preserves pending-scroll retry and destroy resets acknowledgment', () => {
    const harness = candidateStagingHarness();
    harness.context.prepareUnpublishedChatWindowTransaction({}, harness.units, [], null);
    const raw = {
      items: [
        { key: 'unit-97', index: 97, start: 0, size: 40, end: 40 },
        { key: 'unit-98', index: 98, start: 40, size: 50, end: 90 },
        { key: 'unit-99', index: 99, start: 90, size: 60, end: 150 },
      ], totalSize: 150,
    };
    harness.chatWindowState.acknowledgedRawSnapshot = Object.freeze({
      items: Object.freeze(raw.items.map((item) => Object.freeze({ ...item }))), totalSize: raw.totalSize,
    });
    harness.chatWindowState.rendering = true;
    harness.chatWindowState.pendingScrollKey = 'unit-99';
    harness.chatWindowState.pendingRangeRender = false;
    const schedules = harness.calls.filter((entry: string) => entry === 'schedule').length;
    harness.callbacks.onRangeChange(raw);
    expect(harness.chatWindowState.pendingRangeRender).toBe(true);
    expect(harness.calls.filter((entry: string) => entry === 'schedule')).toHaveLength(schedules);

    harness.context.destroyChatWindowAdapter('session-switch');
    expect(harness.chatWindowState.acknowledgedRawSnapshot).toBeNull();
  });

  test('CF2 accepted rollback restores the prior acknowledged raw snapshot and never acknowledges a failed attempt', () => {
    const harness = cf2TransactionHarness('adapter-commit');
    const acceptedAcknowledgment = Object.freeze({
      items: Object.freeze([{ key: 'keep', index: 1, start: 50, end: 100, size: 50 }]), totalSize: 100,
    });
    harness.chatWindowState.acknowledgedRawSnapshot = acceptedAcknowledgment;
    expect(() => harness.context.applyWindowedKeyedChatReconciliation(harness.canonicalSession, harness.units))
      .toThrow('Chat window adapter transaction commit failed');
    expect(harness.chatWindowState.acknowledgedRawSnapshot).toBe(acceptedAcknowledgment);
  });


});

describe('A2.2 accepted containment plan wiring', () => {
  test('RED1 plans exact structural roots before keyed apply and never applies a denied plan', () => {
    const structural = extractFunction('function projectChatWindowStructuralRoots(');
    expect(structural).toContain('child.dataset?.renderUnitKey');
    expect(structural).toContain('projectedRoots.add(chatWindowState.topSpacer || CHAT_WINDOW_PROJECTED_TOP_SPACER)');
    expect(structural).toContain('projectedRoots.add(chatWindowState.bottomSpacer || CHAT_WINDOW_PROJECTED_BOTTOM_SPACER)');
    expect(structural).toContain('projectedRoots.add(chatWindowState.localOlderSurface || CHAT_WINDOW_PROJECTED_LOCAL_OLDER)');

    const windowed = extractFunction('function applyWindowedKeyedChatReconciliation(');
    const planAt = windowed.indexOf('planContainment(buildChatWindowContainmentRequest(');
    const applyAt = windowed.indexOf('applyKeyedChatReconciliation(session, acceptedUnits');
    expect(planAt).toBeGreaterThanOrEqual(0);
    expect(applyAt).toBeGreaterThan(planAt);
    expect(windowed).toContain('if (!acceptedPlan?.allowed) {');
    expect(windowed).toContain('abortChatPresentationJournal(journal);');
    expect(windowed).toContain('acceptedPlan.mountedCount > CHAT_WINDOW_MOUNT_LIMIT');
  });

  test('RED2 supplies exact ordered ranges and semantic pins without changing search routing', () => {
    const request = extractFunction('function buildChatWindowContainmentRequest(');
    expect(request).toContain('requestedKeys');
    expect(request).toContain('visibleLoadedKeys');
    expect(request).toContain('viewportKeys: coreKeys');
    expect(request).toContain('coreKeys: []');
    expect(request).toContain('overscanKeys: optionalKeys');
    expect(request).toContain('currentTurnAssistantKey: session?.currentTurnAssistantKey');
    expect(request).toContain('thinkingId: session?.thinkingId');
    expect(request).toContain('lastTurnUserId: session?.lastTurnUserId');
    expect(request).toContain('appendRootUserKey: session?.appendRootUserKey');
    expect(request).toContain('anchorKey: chatWindowState.anchorKey');
    expect(request).toContain('searchTargetKey: sessionSearch.windowTargetKey');
    expect(extractFunction('function mountChatWindowSearchKey(')).not.toContain('planChatWindowContainment');
  });

  test('RED3 accepted units and per-key selections are the sole windowed keyed-apply input', () => {
    const windowed = extractFunction('function applyWindowedKeyedChatReconciliation(');
    expect(windowed).toContain('const acceptedUnits = acceptedPlan.acceptedKeys.map((key) => unitByKey.get(key)).filter(Boolean);');
    expect(windowed).toContain('applyKeyedChatReconciliation(session, acceptedUnits, acceptedPlan.shellSelections, journal);');
    expect(windowed).not.toContain('applyKeyedChatReconciliation(session, windowUnits);');
    expect(extractFunction('function buildChatWindowContainmentRequest(')).toContain('shellRequests: explicitShellRequests');
    expect(extractFunction('function applyChatWindowOrWave2(')).toContain('applyTransactionalWindow()');
  });

  test('RED4 presentation identity includes normal/shell mode and exact family', () => {
    const identity = extractFunction('function getKeyedPresentationIdentity(');
    expect(identity).toContain("mode: presentationSelection?.mode || 'normal-rich'");
    expect(identity).toContain("family: presentationSelection?.family || ''");
    const keyed = extractFunction('function applyKeyedChatReconciliation(');
    expect(keyed).toContain('getKeyedPresentationIdentity(presentation, presentationSelection)');
    expect(keyed).toContain('presentationSelections?.[unit.key]');
  });

  test('VM smoke bounds tail/pins, accepts 12 explicit shells, replaces mode, and preserves normal stream/final flow', () => {
    const keys = Array.from({ length: 145 }, (_, index) => `k${index}`);
    const existingTop = { dataset: { chatStructuralKey: 'window:top-spacer' } };
    const unclassified = { dataset: {} };
    const requestContext = executeFunctions([
      'function projectChatWindowStructuralRoots(',
      'function buildChatWindowContainmentRequest(',
    ], {
      chatContainer: {
        children: [{ dataset: { renderUnitKey: 'old-key' } }, existingTop, unclassified],
        scrollTop: 500,
        clientHeight: 200,
      },
      chatWindowState: { topSpacer: existingTop, bottomSpacer: null, localOlderSurface: null, anchorKey: 'k2' },
      chatStructuralRootReservations: new Set(),
      CHAT_WINDOW_PROJECTED_TOP_SPACER: Object.freeze({ key: 'top' }),
      CHAT_WINDOW_PROJECTED_BOTTOM_SPACER: Object.freeze({ key: 'bottom' }),
      CHAT_WINDOW_PROJECTED_LOCAL_OLDER: Object.freeze({ key: 'older' }),
      CHAT_WINDOW_MOUNT_LIMIT: 140,
      CHAT_WINDOW_DIRECT_CHILD_LIMIT: 146,
      sessionSearch: { windowTargetKey: 'k1' },
      Array, Set, Math, Number, Object,
    });
    const session = {
      currentTurnAssistantKey: 'k7', thinkingId: 'k6', lastTurnUserId: 'k5',
      appendRootUserKey: 'k4',
    };
    const visibleUnits = keys.map((key) => ({ key }));
    const snapshot = {
      items: keys.map((key, index) => ({ key, start: index * 100, end: (index + 1) * 100 })),
      totalSize: 14500,
    };
    const ordinaryRequest = requestContext.buildChatWindowContainmentRequest(session, visibleUnits, snapshot);
    const ordinaryPlan = planChatWindowContainment(ordinaryRequest);
    expect(ordinaryRequest.projectedStructuralRoots).toBe(4);
    expect(ordinaryRequest.viewportKeys).toEqual(['k5', 'k6']);
    expect(ordinaryRequest.overscanKeys.slice(0, 7)).toEqual(['k0', 'k1', 'k2', 'k3', 'k4', 'k7', 'k8']);
    expect(ordinaryRequest.shellRequests).toEqual([]);
    expect(ordinaryPlan).toMatchObject({ allowed: true, mountedCount: 140, directChildCount: 144, shellSelections: {} });
    expect(ordinaryPlan.acceptedKeys).toEqual(keys.slice(0, 140));
    expect(ordinaryPlan.deferredPins).toEqual([]);

    const families = [
      'message-user', 'message-assistant', 'message-tool-meta', 'message-subagent',
      'change-list', 'segment', 'conflict', 'message-image', 'message-code',
      'message-diff', 'message-table', 'message-markdown',
    ];
    const shellRequests = families.map((family, index) => ({ key: `k${index}`, mode: 'safe-shell', family }));
    const shellPlan = planChatWindowContainment(
      requestContext.buildChatWindowContainmentRequest(session, visibleUnits, snapshot, shellRequests),
    );
    expect(Object.keys(shellPlan.shellSelections)).toEqual(keys.slice(0, 12));
    expect(shellPlan.deniedShellRequests).toEqual([]);

    const roots: any[] = [];
    const makeRoot = (unit: any, selection: any) => {
      const root: any = {
        dataset: { renderUnitKey: unit.key, mode: selection?.mode || 'normal-rich', family: selection?.family || '' },
        parentElement: null,
        remove() { const index = roots.indexOf(root); if (index >= 0) roots.splice(index, 1); root.parentElement = null; },
        replaceWith(next: any) { const index = roots.indexOf(root); roots[index] = next; root.parentElement = null; next.parentElement = chatContainer; },
      };
      return root;
    };
    const chatContainer: any = {
      appendChild(root: any) { roots.push(root); root.parentElement = chatContainer; },
      insertBefore(root: any, before: any) {
        const previous = roots.indexOf(root); if (previous >= 0) roots.splice(previous, 1);
        const index = before ? roots.indexOf(before) : roots.length;
        roots.splice(index < 0 ? roots.length : index, 0, root); root.parentElement = chatContainer;
      },
    };
    const presentationFingerprint = (value: unknown) => JSON.stringify(value);
    const reconcileContext = executeFunctions([
      'function getKeyedPresentationIdentity(',
      'function applyKeyedChatReconciliation(',
      'function acknowledgeKeyedStreamPatch(',
    ], {
      activeSessionId: 'session-a', KEYED_CHAT_RECONCILE_ENABLED: true,
      keyedChatReconcileState: { sessionId: '', items: [], roots: new Map() },
      chatContainer,
      keyedRoots: () => roots,
      keyedRootForKey: (key: string) => roots.find((root) => root.dataset.renderUnitKey === key) || null,
      getKeyedUnitPresentation: (_session: any, unit: any) => unit.value.message,
      getKeyedStreamStablePresentation: (presentation: any) => ({ stable: presentation.stable }),
      renderDetachedKeyedUnit: (_session: any, unit: any, _set: Set<string>, selection: any) => makeRoot(unit, selection),
      beginChatPresentationJournal: () => ({ preparedRoots: new Set(), supersededRoots: new Set(), cleanupRemovals: [] }),
      finalizeChatPresentationJournal: () => true,
      abortChatPresentationJournal: () => true,
      runChatPresentationFailureSeam: () => undefined,
      recordChatWindowCleanupCheckpoint: () => undefined,
      window: { __ocRendering: {
        presentationFingerprint,
        planReconciliation: (previous: any[], next: any[]) => [
          ...previous.filter((item) => !next.some((candidate) => candidate.key === item.key)).map((item) => ({ type: 'remove', key: item.key })),
          ...next.map((item) => {
            const old = previous.find((candidate) => candidate.key === item.key);
            return { type: !old ? 'create' : old.fingerprint === item.fingerprint ? 'reuse' : 'replace', key: item.key };
          }),
        ],
      } },
      chatWindowGeneration: 1, Map, Set, Object,
    });
    const message = { id: 'same', text: 'sent', stable: 'turn-a' };
    const unit = { key: 'same', value: { message } };
    const canonicalSession = { messagesById: new Map([['same', message]]) };
    expect(reconcileContext.applyKeyedChatReconciliation(canonicalSession, [unit])).toMatchObject({ create: 1, replace: 0 });
    const normalRoot = roots[0];
    expect(reconcileContext.applyKeyedChatReconciliation(canonicalSession, [unit], {
      same: { mode: 'safe-shell', family: 'message-assistant' },
    })).toMatchObject({ create: 0, replace: 1 });
    expect(roots).toHaveLength(1);
    expect(roots[0]).not.toBe(normalRoot);
    expect(roots[0].dataset).toMatchObject({ mode: 'safe-shell', family: 'message-assistant' });
    expect(reconcileContext.applyKeyedChatReconciliation(canonicalSession, [unit])).toMatchObject({ replace: 1 });
    const streamedRoot = roots[0];
    message.text = 'streaming';
    expect(reconcileContext.acknowledgeKeyedStreamPatch(canonicalSession, 'same')).toBe(true);
    expect(roots).toEqual([streamedRoot]);
    message.text = 'final'; message.stable = 'turn-final';
    expect(reconcileContext.applyKeyedChatReconciliation(canonicalSession, [unit])).toMatchObject({ replace: 1 });
    expect(roots).toHaveLength(1);
    expect(roots[0].dataset.mode).toBe('normal-rich');
  });
});

describe('A2.2W direct-writer preflight admission', () => {
  test('RED1 fast append declines through shared admission before insertion and schedules bounded reconcile', () => {
    const fastAppend = extractFunction('function tryAppendUserMessageFastPath(');
    const admissionAt = fastAppend.indexOf('preflightChatRenderRootAdmission(');
    const renderAt = fastAppend.indexOf('renderMessageElement(message, renderedSet);');
    expect(admissionAt).toBeGreaterThanOrEqual(0);
    expect(renderAt).toBeGreaterThan(admissionAt);
    expect(fastAppend).toContain("scheduleRenderFromState('window-append-fast-path-capacity');");
    expect(fastAppend).toContain("bailUserMessageAppendFastPath('window-capacity-declined'");
    expect(extractFunction('function appendChatRenderRoot(')).toContain('preflightChatRenderRootAdmission(');
  });

  test('RED2 spacer, local-history, and no-model roots reserve reusable identities before unit admission', () => {
    const projection = extractFunction('function projectChatWindowStructuralRoots(');
    expect(projection).toContain('chatStructuralRootReservations');
    expect(projection).toContain('projectedRoots.add(root);');

    const windowed = extractFunction('function applyWindowedKeyedChatReconciliation(');
    const reserveAt = windowed.indexOf('reserveChatWindowStructuralRoots(localWindow.presentation);');
    const planAt = windowed.indexOf('planContainment(buildChatWindowContainmentRequest(');
    expect(reserveAt).toBeGreaterThanOrEqual(0);
    expect(planAt).toBeGreaterThan(reserveAt);

    expect(extractFunction('function ensureChatWindowSpacers()')).toContain('reserveChatStructuralRoot(');
    expect(extractFunction('function renderChatLocalOlderSurface(')).toContain('ensureChatLocalOlderSurface(');
    expect(extractFunction('function showInitNoModelsError()')).toContain('reserveChatStructuralRoot(');
  });

  test('RED3 unexplained non-keyed roots stay projected and are supplied to integrity sampling', () => {
    const projection = extractFunction('function projectChatWindowStructuralRoots(');
    expect(projection).toContain('if (!child.dataset?.renderUnitKey) projectedRoots.add(child);');
    expect(projection).not.toContain('.remove(');
    expect(projection).not.toContain("style.display = 'none'");

    const windowed = extractFunction('function applyWindowedKeyedChatReconciliation(');
    expect(windowed).toContain('const structuralIntegrityRoots = getChatStructuralIntegrityRoots();');
    expect(windowed).toContain('sampleChatRenderDom(chatContainer, { directChildren, descendants, structuralIntegrityRoots });');
  });

  test('VM smoke declines projected child 147, reuses surfaces, then appends at 146 while capture stays detached', () => {
    const roots: any[] = [];
    const chatContainer: any = {
      get children() { return roots; },
      get childElementCount() { return roots.length; },
      appendChild(root: any) { roots.push(root); root.parentElement = chatContainer; },
      insertBefore(root: any, before: any) {
        const oldIndex = roots.indexOf(root);
        if (oldIndex >= 0) roots.splice(oldIndex, 1);
        const beforeIndex = before ? roots.indexOf(before) : roots.length;
        roots.splice(beforeIndex < 0 ? roots.length : beforeIndex, 0, root);
        root.parentElement = chatContainer;
      },
    };
    for (let index = 0; index < 139; index += 1) {
      roots.push({ dataset: { renderUnitKey: `k${index}` }, parentElement: chatContainer });
    }
    const structural = Array.from({ length: 7 }, (_, index) => ({
      dataset: index < 3 ? { chatStructuralKey: `surface:${index}` } : {},
      parentElement: chatContainer,
    }));
    roots.push(...structural);

    let plannerCalls = 0;
    let createdSurfaces = 0;
    const capture = { children: [] as any[], appendChild(root: any) { this.children.push(root); } };
    const context = executeFunctions([
      'function reserveChatStructuralRoot(',
      'function projectChatWindowStructuralRoots(',
      'function preflightChatRenderRootAdmission(',
      'function appendChatRenderRoot(',
      'function ensureChatLocalOlderSurface(',
    ], {
      chatContainer,
      chatStructuralRootReservations: new Set(),
      chatWindowState: { topSpacer: structural[0], bottomSpacer: structural[1], localOlderSurface: structural[2] },
      CHAT_WINDOW_PROJECTED_TOP_SPACER: {}, CHAT_WINDOW_PROJECTED_BOTTOM_SPACER: {}, CHAT_WINDOW_PROJECTED_LOCAL_OLDER: {},
      CHAT_WINDOW_MOUNT_LIMIT: 140, CHAT_WINDOW_DIRECT_CHILD_LIMIT: 146,
      keyedChatRenderCapture: null,
      keyedRoots: () => roots.filter((root) => root.dataset?.renderUnitKey),
      isChatWindowAvailable: () => true,
      classifyChatStructuralSurface: (root: any) => root,
      document: { createElement: () => { createdSurfaces += 1; return { dataset: {}, parentElement: null }; } },
      window: { __ocRendering: { planChatWindowContainment: (request: any) => { plannerCalls += 1; return planChatWindowContainment(request); } } },
      Set, Array, Number, Boolean, Object,
    });

    const candidate = { dataset: { renderUnitKey: 'candidate' }, parentElement: null };
    expect(context.preflightChatRenderRootAdmission(candidate)).toMatchObject({
      allowed: false, mountedCount: 140, directChildCount: 147,
    });
    expect(roots).toHaveLength(146);
    expect(context.ensureChatLocalOlderSurface()).toBe(structural[2]);
    expect(context.ensureChatLocalOlderSurface()).toBe(structural[2]);
    expect(createdSurfaces).toBe(0);

    roots.splice(roots.indexOf(structural[6]), 1);
    structural[6].parentElement = null;
    expect(context.appendChatRenderRoot(candidate)).toBe(true);
    expect(roots).toHaveLength(146);
    expect(roots).toContain(candidate);

    const beforeDetached = roots.slice();
    const callsBeforeDetached = plannerCalls;
    context.keyedChatRenderCapture = capture;
    const detached = { dataset: { renderUnitKey: 'detached' }, parentElement: null };
    expect(context.appendChatRenderRoot(detached)).toBe(true);
    expect(roots).toEqual(beforeDetached);
    expect(capture.children).toEqual([detached]);
    expect(plannerCalls).toBe(callsBeforeDetached);

    const streamContract = extractFunction('function acknowledgeKeyedStreamPatch(');
    expect(streamContract).not.toContain('preflightChatRenderRootAdmission');
    expect(extractFunction('function getKeyedPresentationIdentity(')).toContain('presentationSelection?.mode');
  });
});

describe('A2.3 non-throwing pressure audits and bounded correction', () => {
  function correctionHarness() {
    const plannerRequests: any[] = [];
    let activeSessionId = 'session-a';
    let chatWindowGeneration = 7;
    const context = executeFunctions(['function scheduleChatWindowPlanCorrection('], {
      get activeSessionId() { return activeSessionId; },
      set activeSessionId(value) { activeSessionId = value; },
      get chatWindowGeneration() { return chatWindowGeneration; },
      set chatWindowGeneration(value) { chatWindowGeneration = value; },
      chatWindowPlanCorrection: { sessionId: '', generation: -1, planRevision: -1 },
      window: { __ocRendering: { planChatWindowContainment: (request: any) => {
        plannerRequests.push(request);
        const acceptedCount = Math.min(request.requestedKeys.length, request.limits.mounted, request.limits.directChildren - request.projectedStructuralRoots);
        return {
          allowed: acceptedCount >= 0,
          acceptedKeys: request.requestedKeys.slice(0, Math.max(0, acceptedCount)),
          mountedCount: Math.max(0, acceptedCount),
          directChildCount: Math.max(0, acceptedCount) + request.projectedStructuralRoots,
          shellSelections: {},
        };
      } } },
      Math, Number,
    });
    const request = {
      requestedKeys: Array.from({ length: 140 }, (_, index) => `PRIVATE_KEY_${index}`),
      projectedStructuralRoots: 6,
      limits: { mounted: 140, directChildren: 146 },
    };
    const acceptedPlan = {
      allowed: true, acceptedKeys: request.requestedKeys.slice(), mountedCount: 140,
      directChildCount: 146, shellSelections: {},
    };
    return { context, request, acceptedPlan, plannerRequests };
  }

  test('A2.3-RED2 pressure handling cannot disable, destroy, mark failed, or route to Wave 2/legacy', () => {
    const budget = extractFunction('function assertChatWindowDomBudget(');
    for (const forbidden of [
      'throw ', 'disableChatWindowForSession', 'destroyChatWindowAdapter', 'failedSessionId',
      'applyKeyedChatReconciliation', 'renderFromStateLegacy', 'full-history',
    ]) expect(budget).not.toContain(forbidden);
    expect(sourceHash(extractFunction('function disableChatWindowForSession('))).toBe('b0cd6aa7ee2b4b185b7662bb8c4bb1160262f1067d155ddb43c8ca62926090da');
    expect(extractFunction('function applyChatWindowOrWave2(')).not.toContain('disableChatWindowForSession');
  });

  test('A2.3-RED3 schedules at most one reducing correction per session/generation/revision', () => {
    const { context, request, acceptedPlan, plannerRequests } = correctionHarness();
    const mountedCorrection = context.scheduleChatWindowPlanCorrection({
      sessionId: 'session-a', generation: 7, planRevision: 11, request, acceptedPlan,
      observedBudget: { mountedUnits: 141, directChildren: 146, descendants: 100 },
    });
    expect(mountedCorrection).toMatchObject({ mountedCount: 139, directChildCount: 145 });
    expect(context.scheduleChatWindowPlanCorrection({
      sessionId: 'session-a', generation: 7, planRevision: 11, request, acceptedPlan,
      observedBudget: { mountedUnits: 141, directChildren: 146, descendants: 100 },
    })).toBeNull();
    expect(plannerRequests).toHaveLength(1);

    const directCorrection = context.scheduleChatWindowPlanCorrection({
      sessionId: 'session-a', generation: 7, planRevision: 12, request, acceptedPlan,
      observedBudget: { mountedUnits: 140, directChildren: 147, descendants: 100 },
    });
    expect(directCorrection).toMatchObject({ mountedCount: 139, directChildCount: 145 });
    expect(plannerRequests).toHaveLength(2);
  });

  test('A2.3-RED4 correction no-ops for descendant-only, no reduction, stale session/generation, and normal audits', () => {
    const { context, request, acceptedPlan, plannerRequests } = correctionHarness();
    const run = (revision: number, observedBudget: any) => context.scheduleChatWindowPlanCorrection({
      sessionId: 'session-a', generation: 7, planRevision: revision, request, acceptedPlan, observedBudget,
    });
    expect(run(20, { mountedUnits: 140, directChildren: 146, descendants: 22040 })).toBeNull();
    expect(run(21, { mountedUnits: 140, directChildren: 146, descendants: 4000 })).toBeNull();
    expect(plannerRequests).toHaveLength(0);

    const noReductionRequest = { ...request, requestedKeys: request.requestedKeys.slice(0, 139) };
    expect(context.scheduleChatWindowPlanCorrection({
      sessionId: 'session-a', generation: 7, planRevision: 22, request: noReductionRequest, acceptedPlan,
      observedBudget: { mountedUnits: 141, directChildren: 146, descendants: 100 },
    })).toBeNull();
    expect(plannerRequests).toHaveLength(1);

    context.activeSessionId = 'session-b';
    expect(run(23, { mountedUnits: 141, directChildren: 147, descendants: 100 })).toBeNull();
    context.activeSessionId = 'session-a';
    context.chatWindowGeneration = 8;
    expect(run(24, { mountedUnits: 141, directChildren: 147, descendants: 100 })).toBeNull();
    expect(plannerRequests).toHaveLength(1);
  });

  test('A2.3 retained A1 schema/privacy and scheduler reasons stay unchanged', () => {
    const reconcile = extractFunction('function applyWindowedKeyedChatReconciliation(');
    expect(reconcile).toContain('recordChatWindowPressureAttribution(localWindow.visibleUnits, acceptedUnits, acceptedSnapshot, keepMountedKeys, directChildren, descendants);');
    expect(sourceHash(extractFunction('function scheduleRenderFromState('))).toBe('b2977c0a62af34a61c73fa241bfe685c3efdb8823718665e5c040e6dd44d8ded');
    expect(source).toContain('const CHAT_WINDOW_INITIAL_TAIL = 80;');
    expect(source).toContain('const CHAT_WINDOW_OVERSCAN = 20;');
  });
});

describe('A1.3 bounded descendant-pressure attribution', () => {
  const privateSentinels = [
    'PRIVATE_SESSION_SENTINEL', 'PRIVATE_ACTIVE_SENTINEL', 'PRIVATE_FAILED_SENTINEL',
    'PRIVATE_BLOCKER_SENTINEL', 'PRIVATE_MESSAGE_SENTINEL', 'PRIVATE_UNIT_KEY_SENTINEL',
    'PRIVATE_ALIAS_SENTINEL', 'PRIVATE_SEARCH_SENTINEL', 'PRIVATE_CONTENT_SENTINEL',
  ];

  function attributionHarness(enabled = true) {
    let modelCalls = 0;
    let rootScans = 0;
    const modelInputs: any[] = [];
    const roots = [
      {
        dataset: { renderUnitKey: 'PRIVATE_UNIT_KEY_SENTINEL-a' }, childElementCount: 2,
        querySelectorAll: () => { rootScans += 1; return { length: 11 }; },
      },
      {
        dataset: { renderUnitKey: 'PRIVATE_UNIT_KEY_SENTINEL-b' }, childElementCount: 3,
        querySelectorAll: () => { rootScans += 1; return { length: 19 }; },
      },
      {
        dataset: { renderUnitKey: 'PRIVATE_UNIT_KEY_SENTINEL-off-range' }, childElementCount: 1,
        querySelectorAll: () => { rootScans += 1; return { length: 100 }; },
      },
    ];
    const model = (input: any) => {
      modelCalls += 1;
      modelInputs.push(input);
      const ranked = input.units.slice().sort((a: any, b: any) => b.descendants - a.descendants || a.unitIndex - b.unitIndex);
      return {
        generation: input.generation,
        audit: {
          available: true, coverageAvailable: true, totalDescendants: input.totalDescendants,
          attributedDescendants: input.totalDescendants, reconciled: true, observedUnitCount: input.units.length,
        },
        topContributors: ranked.slice(0, 8),
        dominance: { available: true, topUnitBasisPoints: 6333, topThreeBasisPoints: 10000 },
        classification: { value: 'exceptional-unit', missingDiscriminators: [] },
      };
    };
    const chatRenderMetrics: Record<string, unknown> = {};
    const context = executeFunctions([
      'function boundedChatPressureCount(', 'function normalizeChatPressureKind(', 'function normalizeChatPressureRole(',
      'function recordChatWindowPressureAttribution(',
    ], {
      isChatRenderMetricsEnabled: () => enabled,
      keyedRoots: () => roots,
      window: {
        __ocRendering: { buildChatPressureAttribution: model },
        __ocChatWindowDescendantAcceptanceBlocker: { sessionId: 'PRIVATE_BLOCKER_SENTINEL' },
        __ocAliasState: { aliasId: 'PRIVATE_ALIAS_SENTINEL' },
      },
      activeSessionId: 'PRIVATE_ACTIVE_SENTINEL',
      chatWindowState: { failedSessionId: 'PRIVATE_FAILED_SENTINEL' },
      sessionSearch: { windowTargetKey: 'PRIVATE_SEARCH_SENTINEL' },
      sessionState: { sessionId: 'PRIVATE_SESSION_SENTINEL' },
      chatContainer: { children: [...roots, {}, {}, {}] },
      chatRenderMetrics,
      chatWindowGeneration: 7,
      chatRenderMetricsDirty: false,
      CHAT_WINDOW_MOUNT_LIMIT: 140,
      Map, Set, Math, Number,
    });
    const visibleUnits = [
      {
        key: 'PRIVATE_UNIT_KEY_SENTINEL-a', kind: 'message',
        value: { message: { id: 'PRIVATE_MESSAGE_SENTINEL', role: 'assistant', text: 'PRIVATE_CONTENT_SENTINEL' } },
      },
      {
        key: 'PRIVATE_UNIT_KEY_SENTINEL-b', kind: 'unexpected-private-kind',
        value: { message: { role: 'unexpected-private-role' } },
      },
    ];
    const snapshot = { items: [
      { key: 'PRIVATE_UNIT_KEY_SENTINEL-a', index: 40 },
      { key: 'PRIVATE_UNIT_KEY_SENTINEL-b', index: 41 },
    ] };
    return { context, visibleUnits, snapshot, chatRenderMetrics, roots, modelInputs, get modelCalls() { return modelCalls; }, get rootScans() { return rootScans; } };
  }

  test('A1.3-RED-1 reconcile audit emits one fresh allowlisted current-generation record', () => {
    const harness = attributionHarness();
    const previousRecord = { sessionId: 'PRIVATE_SESSION_SENTINEL' };
    harness.chatRenderMetrics.pressureAttribution = previousRecord;
    harness.context.recordChatWindowPressureAttribution(
      harness.visibleUnits,
      harness.visibleUnits,
      harness.snapshot,
      ['PRIVATE_UNIT_KEY_SENTINEL-a'],
      5,
      33,
    );

    expect(harness.modelCalls).toBe(1);
    expect(harness.rootScans).toBe(2);
    expect(harness.chatRenderMetrics.pressureAttribution).not.toBe(previousRecord);
    expect(harness.chatRenderMetrics.pressureAttribution).toEqual({
      generation: 7,
      units: [
        { unitIndex: 40, kind: 'message', role: 'assistant', descendants: 11, directChildren: 2 },
        { unitIndex: 41, kind: 'unknown', role: 'unknown', descendants: 19, directChildren: 3 },
      ],
      totals: { descendants: 33, attributedDescendants: 30, directChildren: 5, attributedDirectChildren: 5, structuralChildren: 0, mountedRoots: 2, offRangeRoots: 1 },
      range: {
        requested: { available: true, value: 2 }, accepted: { available: true, value: 2 },
        core: { available: false, value: null }, overscan: { available: false, value: null },
        pins: { available: true, value: 1 },
      },
      topContributors: [
        { unitIndex: 41, kind: 'unknown', role: 'unknown', descendants: 19, directChildren: 3 },
        { unitIndex: 40, kind: 'message', role: 'assistant', descendants: 11, directChildren: 2 },
      ],
    });
    const serialized = JSON.stringify({ input: harness.modelInputs[0], output: harness.chatRenderMetrics.pressureAttribution });
    for (const sentinel of privateSentinels) expect(serialized).not.toContain(sentinel);
    for (const forbiddenKey of ['sessionId', 'activeSessionId', 'failedSessionId', 'messageId', 'unitId', 'unitKey', 'aliasId', 'searchKey']) {
      expect(serialized).not.toContain(`"${forbiddenKey}"`);
    }
    const reconcile = extractFunction('function applyWindowedKeyedChatReconciliation(');
    expect(reconcile).toContain('recordChatWindowPressureAttribution(localWindow.visibleUnits, acceptedUnits, acceptedSnapshot, keepMountedKeys, directChildren, descendants);');
    const wiring = extractFunction('function recordChatWindowPressureAttribution(');
    expect(wiring).not.toContain('__ocChatWindowDescendantAcceptanceBlocker');
    expect(wiring).not.toContain('...');
  });

  test('A1.3-RED-2 disabled metrics do not scan or update the model', () => {
    const harness = attributionHarness(false);
    harness.context.recordChatWindowPressureAttribution(
      harness.visibleUnits, harness.visibleUnits, harness.snapshot, [], 5, 33,
    );
    expect(harness.rootScans).toBe(0);
    expect(harness.modelCalls).toBe(0);
    expect(harness.chatRenderMetrics.pressureAttribution).toBeUndefined();
  });

  test('A1.3-RED-2 mutation notifications mark only dirty and never scan the subtree', () => {
    let mutationCallback: (() => void) | null = null;
    let containerScans = 0;
    const context = executeFunctions(['function installChatRenderMetrics('], {
      isChatRenderMetricsEnabled: () => true,
      MutationObserver: function MockMutationObserver(callback: () => void) {
        mutationCallback = callback;
        return { observe: () => undefined };
      },
      PerformanceObserver: undefined,
      chatRenderDomObserver: null,
      chatRenderLongTaskObserver: null,
      chatRenderMetricsSummaryTimer: null,
      chatRenderMetricsDirty: false,
      setInterval: () => 1,
      emitChatRenderMetricsSummary: () => undefined,
      CHAT_RENDER_METRICS_SUMMARY_INTERVAL_MS: 30000,
      Array,
    });
    const container = { querySelectorAll: () => { containerScans += 1; return []; } };
    context.installChatRenderMetrics(container);
    const notifyMutation = mutationCallback as unknown as () => void;
    for (let index = 0; index < 101; index += 1) notifyMutation();
    expect(containerScans).toBe(0);
    expect((context as any).chatRenderMetricsDirty).toBe(true);
  });

  test('A1.3-RED-3 freezes window limits and both fallback routes while A2.3 makes audits non-throwing', () => {
    expect(source).toContain('const CHAT_WINDOW_INITIAL_TAIL = 80;');
    expect(source).toContain('const CHAT_WINDOW_OVERSCAN = 20;');
    expect(source).toContain('const CHAT_WINDOW_MOUNT_LIMIT = 140;');
    expect(source).toContain('const CHAT_WINDOW_DIRECT_CHILD_LIMIT = 146;');
    expect(source).toContain('const CHAT_RENDER_DESCENDANT_WARNING_THRESHOLD = 4000;');
    const budget = extractFunction('function assertChatWindowDomBudget(');
    expect(budget).toContain('budget.mountedUnits > CHAT_WINDOW_MOUNT_LIMIT');
    expect(budget).toContain('budget.directChildren > CHAT_WINDOW_DIRECT_CHILD_LIMIT');
    expect(budget).toContain('budget.descendants > 4000');
    expect(budget).not.toContain('throw ');
    expect(budget).not.toContain('activeSessionId');
    expect(budget).toContain('__ocChatWindowDomBudgetAudit');
    expect(sourceHash(extractFunction('function disableChatWindowForSession('))).toBe('b0cd6aa7ee2b4b185b7662bb8c4bb1160262f1067d155ddb43c8ca62926090da');
    expect(extractFunction('function applyChatWindowOrWave2(')).not.toContain('disableChatWindowForSession');
    expect(extractFunction('function renderFromState()')).not.toContain('renderFromStateLegacy');
  });

  test('A1.3-RED-4 freezes observer accounting, summary cadence/transport, and render scheduling', () => {
    expect(source).toContain('const CHAT_RENDER_METRICS_SUMMARY_INTERVAL_MS = 30000;');
    const observerStart = source.indexOf('const supportedEntryTypes');
    const observerEnd = source.indexOf('chatRenderMetricsSummaryTimer = setInterval', observerStart);
    expect(sourceHash(source.slice(observerStart, observerEnd))).toBe('5a72c3ac0e54b4ee23a3ebc4a3c04719995442e253c26cc1b1759a3160c12fd1');
    expect(sourceHash(extractFunction('function emitChatRenderMetricsSummary()'))).toBe('0a83631cea8bc6d3fb274efb289fe413fea400761b192416ff3e91002ab07c5f');
    expect(sourceHash(extractFunction('function scheduleRenderFromState('))).toBe('b2977c0a62af34a61c73fa241bfe685c3efdb8823718665e5c040e6dd44d8ded');
    expect(sourceHash(extractFunction('function noteFullRenderRequest('))).toBe('a71bab2243fadd3aa6282053598225d5a9ce58dc016dba0e6bad4b79eceb1f8b');
    expect(source).toContain('chatRenderMetricsSummaryTimer = setInterval(emitChatRenderMetricsSummary, CHAT_RENDER_METRICS_SUMMARY_INTERVAL_MS);');
  });

  test('A1.3-SMOKE keeps audits checkpoint-bounded across primary action, mutation burst, and state transition', () => {
    const harness = attributionHarness();
    const audit = () => harness.context.recordChatWindowPressureAttribution(
      harness.visibleUnits, harness.visibleUnits, harness.snapshot,
      ['PRIVATE_UNIT_KEY_SENTINEL-a'], 5, 33,
    );
    audit(); // synthetic initial tail audit
    audit(); // primary-action-shaped reconcile

    let mutationCallback: (() => void) | null = null;
    const observerContext = executeFunctions(['function installChatRenderMetrics('], {
      isChatRenderMetricsEnabled: () => true,
      MutationObserver: function MockMutationObserver(callback: () => void) {
        mutationCallback = callback;
        return { observe: () => undefined };
      },
      PerformanceObserver: undefined,
      chatRenderDomObserver: null,
      chatRenderLongTaskObserver: null,
      chatRenderMetricsSummaryTimer: null,
      chatRenderMetricsDirty: false,
      setInterval: () => 1,
      emitChatRenderMetricsSummary: () => undefined,
      CHAT_RENDER_METRICS_SUMMARY_INTERVAL_MS: 30000,
      Array,
    });
    observerContext.installChatRenderMetrics({});
    const notifyMutation = mutationCallback as unknown as () => void;
    for (let index = 0; index < 125; index += 1) notifyMutation();

    harness.context.chatWindowGeneration = 8;
    audit(); // final reconcile/state transition
    expect(harness.modelCalls).toBe(3);
    expect(harness.rootScans).toBe(6);
    expect(observerContext.chatRenderMetricsDirty).toBe(true);

    const routeCalls: string[] = [];
    const routeContext = executeFunctions(['function applyChatWindowOrWave2('], {
      TANSTACK_CHAT_WINDOW_ENABLED: true,
      CHAT_WINDOW_INITIAL_TAIL: 80,
      CHAT_WINDOW_MOUNT_LIMIT: 140,
      CHAT_WINDOW_DIRECT_CHILD_LIMIT: 146,
      isChatWindowAvailable: () => true,
      applyWindowedKeyedChatReconciliation: () => routeCalls.push('window'),
      applyKeyedChatReconciliation: () => routeCalls.push('wave2'),
      chatWindowState: { adapter: null, localOlderSurface: null },
      keyedChatReconcileFailure: null,
      keyedRoots: () => [],
      projectChatWindowStructuralRoots: () => 3,
      sessionSearch: { windowTargetKey: '' },
      window: {},
      vscode: { postMessage: () => undefined },
      Set, Map, Math, Number, Array, Object,
    });
    expect(routeContext.applyChatWindowOrWave2({}, [])).toBe('window');
    expect(routeCalls).toEqual(['window']);
    const serialized = JSON.stringify(harness.chatRenderMetrics.pressureAttribution);
    for (const sentinel of privateSentinels) expect(serialized).not.toContain(sentinel);
  });
});

describe('A1.4 cleanup and stale-generation attribution', () => {
  const lifecycleMarkers = [
    'function publishChatWindowPressureLifecycle(',
    'function beginChatWindowPressureGeneration(',
    'function recordChatWindowCleanupCheckpoint(',
    'function recordChatWindowStaleCallback(',
    'function closeChatWindowPressureGeneration(',
  ];

  function lifecycleHarness(enabled = true) {
    const chatRenderMetrics: Record<string, unknown> = {};
    const context = executeFunctions(lifecycleMarkers, {
      isChatRenderMetricsEnabled: () => enabled,
      chatWindowPressureLifecycle: { current: null, closures: [] },
      chatRenderMetrics,
      chatRenderMetricsDirty: false,
      boundedChatPressureCount: (value: number) => Math.min(1_000_000_000, Math.max(0, Math.trunc(value || 0))),
      Math,
    });
    return { context, chatRenderMetrics };
  }

  test('A1.4 lifecycle attribution is inert while metrics are disabled', () => {
    const { context, chatRenderMetrics } = lifecycleHarness(false);
    context.beginChatWindowPressureGeneration(7);
    context.recordChatWindowCleanupCheckpoint('removal', 7, 1, 1, 1);
    context.recordChatWindowStaleCallback(7, 'range');
    context.closeChatWindowPressureGeneration(7, true, true, 1);
    expect(chatRenderMetrics.pressureLifecycle).toBeUndefined();
    expect(context.chatWindowPressureLifecycle).toEqual({ current: null, closures: [] });
  });

  test('A1.4-RED-1 counts completed unobserve/removal and classifies zero/positive residual audits', () => {
    const { context, chatRenderMetrics } = lifecycleHarness();
    context.beginChatWindowPressureGeneration(11);
    context.recordChatWindowCleanupCheckpoint('unobserve', 11, 1, 1, 0);
    context.recordChatWindowCleanupCheckpoint('removal', 11, 1, 1, 0);
    expect(chatRenderMetrics.pressureLifecycle).toEqual({
      current: {
        generation: 11,
        unobserveRequested: 1,
        unobserveCompleted: 1,
        removalRequested: 1,
        removalCompleted: 1,
        staleRangeRejections: 0,
        staleMeasurementRejections: 0,
        residualRootAudits: 2,
        residualRoots: 0,
        residualRootsPresent: false,
      },
      closures: [],
    });

    context.recordChatWindowCleanupCheckpoint('removal', 11, 1, 0, 2);
    expect((chatRenderMetrics.pressureLifecycle as any).current).toEqual(expect.objectContaining({
      removalRequested: 2,
      removalCompleted: 1,
      residualRootAudits: 3,
      residualRoots: 2,
      residualRootsPresent: true,
    }));
  });

  test('A1.4-RED-2 isolates generations and makes closure idempotent', () => {
    const { context, chatRenderMetrics } = lifecycleHarness();
    context.beginChatWindowPressureGeneration(21);
    context.recordChatWindowCleanupCheckpoint('unobserve', 21, 2, 2, 0);
    context.closeChatWindowPressureGeneration(21, true, true, 0);
    context.closeChatWindowPressureGeneration(21, true, true, 9);
    context.recordChatWindowStaleCallback(21, 'range');
    context.recordChatWindowStaleCallback(21, 'measurement');
    context.beginChatWindowPressureGeneration(24);
    context.recordChatWindowCleanupCheckpoint('removal', 24, 1, 1, 3);

    expect(chatRenderMetrics.pressureLifecycle).toEqual({
      current: {
        generation: 24,
        unobserveRequested: 0,
        unobserveCompleted: 0,
        removalRequested: 1,
        removalCompleted: 1,
        staleRangeRejections: 0,
        staleMeasurementRejections: 0,
        residualRootAudits: 1,
        residualRoots: 3,
        residualRootsPresent: true,
      },
      closures: [{
        generation: 21,
        unobserveRequested: 2,
        unobserveCompleted: 2,
        removalRequested: 0,
        removalCompleted: 0,
        staleRangeRejections: 1,
        staleMeasurementRejections: 1,
        adapterDestroyRequested: 1,
        adapterDestroyCompleted: 1,
        sessionSwitch: true,
        generationClosed: true,
        residualRootAudits: 2,
        residualRoots: 0,
        residualRootsPresent: false,
      }],
    });
  });

  test('A1.4-RED-1/2 stale callbacks stay rejected and destroy side effects stay unchanged', () => {
    const calls: string[] = [];
    const adapters: Array<{ callbacks: any; destroy: jest.Mock; beginTransaction: jest.Mock }> = [];
    const chatRenderMetrics: Record<string, unknown> = {};
    const context = executeFunctions([
      ...lifecycleMarkers,
      'function destroyChatLocalOlderSurface(',
      'function destroyChatWindowAdapter(',
      'function getChatWindowKeepMountedKeys(',
      'function getChatWindowUnitKind(',
      'function getKeyedPresentationIdentity(',
      'function disposeUnpublishedChatWindowAdapterCandidate(',
      'function prepareUnpublishedChatWindowTransaction(',
      'function ensureChatWindowAdapter(',
    ], {
      isChatRenderMetricsEnabled: () => true,
      chatWindowPressureLifecycle: { current: null, closures: [] },
      chatRenderMetrics,
      chatRenderMetricsDirty: false,
      boundedChatPressureCount: (value: number) => Math.min(1_000_000_000, Math.max(0, Math.trunc(value || 0))),
      chatWindowGeneration: 0,
      activeSessionId: 'PRIVATE_SESSION_A',
      chatWindowState: {
        sessionId: '', adapter: null, snapshot: null, allUnits: [], mountedKeys: new Set(),
        topSpacer: { remove: () => calls.push('top') }, bottomSpacer: { remove: () => calls.push('bottom') },
        pendingRangeRender: false, pendingScrollKey: '', pendingScrollAttempts: 0, rendering: false,
        localOlderObserver: null, localOlderSurface: null, localHistoryPresentation: null, anchorKey: '',
      },
      window: {
        __ocRendering: {
          presentationFingerprint: () => 'fingerprint',
          deriveLocalOlderPresentation: () => ({ state: 'hidden', actionable: false }),
          planChatWindowContainment: (request: any) => ({
            allowed: true,
            acceptedKeys: request.requestedKeys,
            mountedCount: request.requestedKeys.length,
            directChildCount: request.requestedKeys.length + 3,
            shellSelections: {},
          }),
          createTanStackVirtualAdapter: (callbacks: any) => {
            const transaction = Object.fromEntries([
              'getRange', 'update', 'observeElement', 'unobserveElement', 'invalidateMeasurement',
              'setPresentationRevision', 'migrateKey', 'prepareCommit', 'commit', 'finalizeCommit',
              'retryCompletion', 'isFinalized', 'isDegraded', 'hasPendingCompletion', 'abort',
            ].map((method) => [method, jest.fn()]));
            const adapter = {
              callbacks,
              getInitialOwnerState: () => 'deferred',
              destroy: jest.fn(() => calls.push('destroy')),
              beginTransaction: jest.fn(() => transaction),
              update: jest.fn(),
            };
            adapters.push(adapter);
            return adapter;
          },
        },
      },
      chatContainer: { classList: { remove: () => calls.push('class') } },
      keyedRoots: () => [],
      chatLocalHistoryController: { complete: () => calls.push('complete') },
      getKeyedUnitPresentation: () => ({}),
      getSessionState: () => ({ hydrationCoverage: null }),
      normalizePayloadHydrationCoverage: () => null,
      projectChatWindowStructuralRoots: () => 3,
      sessionSearch: { windowTargetKey: '' },
      CHAT_WINDOW_OVERSCAN: 20,
      CHAT_WINDOW_INITIAL_TAIL: 80,
      CHAT_WINDOW_MOUNT_LIMIT: 140,
      CHAT_WINDOW_DIRECT_CHILD_LIMIT: 146,
      scheduleRenderFromState: (reason: string) => calls.push(`schedule:${reason}`),
      vscode: { postMessage: () => calls.push('post') },
      autoScrollPinnedToBottom: false,
      scrollToBottom: () => calls.push('scroll'),
      restoreChatWindowAnchor: () => calls.push('anchor'),
      Set, Math,
    });

    context.ensureChatWindowAdapter({}, [{ key: 'PRIVATE_UNIT_A', kind: 'message', value: { message: { role: 'assistant' } } }]);
    adapters[0].callbacks.onRangeChange({ items: [{ key: 'PRIVATE_ACCEPTED' }] });
    const acceptedRouteCalls = calls.slice();
    (context as any).activeSessionId = 'PRIVATE_SESSION_B';
    context.destroyChatWindowAdapter('session-switch');
    context.ensureChatWindowAdapter({}, [{ key: 'PRIVATE_UNIT_B', kind: 'message', value: { message: { role: 'assistant' } } }]);
    const beforeStale = calls.slice();
    adapters[0].callbacks.onRangeChange({ items: [{ key: 'PRIVATE_STALE' }] });
    adapters[0].callbacks.onMeasurements({ changedKeys: ['PRIVATE_STALE'], totalSize: 99 });
    expect(calls).toEqual(beforeStale);

    context.destroyChatWindowAdapter('explicit');
    context.destroyChatWindowAdapter('explicit');
    expect(adapters[0].destroy).toHaveBeenCalledTimes(1);
    expect(adapters[1].destroy).toHaveBeenCalledTimes(1);
    expect(acceptedRouteCalls).toContain('schedule:window-range-change');
    expect((chatRenderMetrics.pressureLifecycle as any).current).toBeNull();
    const closures = (chatRenderMetrics.pressureLifecycle as any).closures;
    expect(closures).toHaveLength(2);
    expect(closures[0]).toEqual(expect.objectContaining({ generation: 1, sessionSwitch: true, staleRangeRejections: 1, staleMeasurementRejections: 1 }));
    expect(closures[1]).toEqual(expect.objectContaining({ generation: 3, sessionSwitch: false, adapterDestroyCompleted: 1 }));
    expect(JSON.stringify(chatRenderMetrics)).not.toContain('PRIVATE_');
  });

  test('A1.4 hooks are additive at the existing stale and cleanup checkpoints', () => {
    const prepare = extractFunction('function prepareUnpublishedChatWindowTransaction(');
    const destroy = extractFunction('function destroyChatWindowAdapter(');
    const keyed = extractFunction('function applyKeyedChatReconciliation(');
    const windowed = extractFunction('function applyWindowedKeyedChatReconciliation(');
    expect(prepare).toContain("recordChatWindowStaleCallback(candidateGeneration, 'range');");
    expect(prepare).toContain("recordChatWindowStaleCallback(candidateGeneration, 'measurement');");
    expect(destroy).toContain('closeChatWindowPressureGeneration(');
    expect(extractFunction('function finalizeChatPresentationJournal(')).toContain("recordChatWindowCleanupCheckpoint('removal'");
    expect(windowed).toContain('adapterTransaction.unobserveElement(key);');
    expect(source).not.toContain('__ocChatWindowPressureLifecycle');
  });

  test('A1.4-SMOKE mounts, reconciles, unmounts, remounts, and audits honest residual outcomes', () => {
    const roots: any[] = [];
    let leaveResidual = false;
    const chatRenderMetrics: Record<string, unknown> = {};
    const chatContainer: any = {
      get children() { return roots; },
      appendChild(root: any) { root.parentElement = chatContainer; roots.push(root); },
      insertBefore(root: any, before: any) {
        const oldIndex = roots.indexOf(root);
        if (oldIndex >= 0) roots.splice(oldIndex, 1);
        const nextIndex = before ? roots.indexOf(before) : roots.length;
        roots.splice(nextIndex < 0 ? roots.length : nextIndex, 0, root);
        root.parentElement = chatContainer;
      },
    };
    const context = executeFunctions([
      ...lifecycleMarkers,
      'function getKeyedPresentationIdentity(',
      'function applyKeyedChatReconciliation(',
    ], {
      isChatRenderMetricsEnabled: () => true,
      chatWindowPressureLifecycle: { current: null, closures: [] },
      chatRenderMetrics,
      chatRenderMetricsDirty: false,
      boundedChatPressureCount: (value: number) => Math.min(1_000_000_000, Math.max(0, Math.trunc(value || 0))),
      chatWindowGeneration: 31,
      activeSessionId: 'PRIVATE_SESSION',
      keyedChatReconcileState: { sessionId: '', items: [], roots: new Map() },
      chatContainer,
      keyedRoots: () => roots.filter((root) => root.parentElement === chatContainer),
      keyedRootForKey: (key: string) => roots.find((root) => root.parentElement === chatContainer && root.dataset.renderUnitKey === key) || null,
      getKeyedUnitPresentation: () => ({}),
      getKeyedStreamStablePresentation: () => ({}),
      renderDetachedKeyedUnit: (_session: unknown, unit: any) => {
        const root: any = {
          dataset: { renderUnitKey: unit.key }, parentElement: null,
          remove: () => {
            if (leaveResidual) return;
            const index = roots.indexOf(root);
            if (index >= 0) roots.splice(index, 1);
            root.parentElement = null;
          },
        };
        return root;
      },
      beginChatPresentationJournal: () => ({ preparedRoots: new Set(), supersededRoots: new Set(), cleanupRemovals: [] }),
      finalizeChatPresentationJournal: (journal: any) => {
        for (let index = 0; index < journal.cleanupRemovals.length; index += 1) {
          context.recordChatWindowCleanupCheckpoint('removal', 31, 1, leaveResidual ? 0 : 1, leaveResidual ? 1 : 0);
        }
        return true;
      },
      abortChatPresentationJournal: () => true,
      runChatPresentationFailureSeam: () => undefined,
      window: {
        __ocRendering: {
          presentationFingerprint: () => 'fingerprint',
          planReconciliation: (previous: any[], next: any[]) => [
            ...previous.filter((item) => !next.some((candidate) => candidate.key === item.key)).map((item) => ({ type: 'remove', key: item.key })),
            ...next.map((item) => ({ type: previous.some((candidate) => candidate.key === item.key) ? 'reuse' : 'create', key: item.key })),
          ],
        },
      },
      Map, Set, Math, Object,
    });
    const unit = { key: 'PRIVATE_UNIT', kind: 'message', value: { message: { role: 'assistant' } } };
    context.beginChatWindowPressureGeneration(31);
    expect(context.applyKeyedChatReconciliation({}, [unit])).toEqual(expect.objectContaining({ create: 1, remove: 0 }));
    expect(context.applyKeyedChatReconciliation({}, [])).toEqual(expect.objectContaining({ create: 0, remove: 1 }));
    expect(roots).toHaveLength(0);
    expect(context.applyKeyedChatReconciliation({}, [unit])).toEqual(expect.objectContaining({ create: 1, remove: 0 }));
    leaveResidual = true;
    expect(context.applyKeyedChatReconciliation({}, [])).toEqual(expect.objectContaining({ create: 0, remove: 1 }));
    expect(roots).toHaveLength(1);
    expect((chatRenderMetrics.pressureLifecycle as any).current).toEqual(expect.objectContaining({
      generation: 31,
      removalRequested: 2,
      removalCompleted: 1,
      residualRootAudits: 2,
      residualRoots: 1,
      residualRootsPresent: true,
    }));
    expect(JSON.stringify(chatRenderMetrics)).not.toContain('PRIVATE_');
  });
});
