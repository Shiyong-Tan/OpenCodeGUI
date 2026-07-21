import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

import {
  classifyChatWindowIntegrity,
  planChatWindowContainment,
  type ChatWindowIntegrityInput,
  type ChatWindowContainmentInput,
  type SafeShellFamily,
} from '../rendering/chat-window-budget-plan';

const root = path.resolve(__dirname, '../..');
const limits = { mounted: 140, directChildren: 146 } as const;
const keys = (count: number, prefix = 'k') => Array.from({ length: count }, (_, index) => `${prefix}${index}`);

const baseInput = (requestedKeys: readonly string[]): ChatWindowContainmentInput => ({
  requestedKeys,
  visibleLoadedKeys: requestedKeys,
  viewportKeys: requestedKeys,
  coreKeys: [],
  overscanKeys: [],
  adapterSnapshotKeys: [],
  projectedStructuralRoots: 6,
  limits,
});

describe('planChatWindowContainment boundaries and properties (RED-1)', () => {
  test('accepts mounted 140/direct 146 and truncates mounted 141/direct 147', () => {
    const requested140 = keys(140);
    const atBoundary = planChatWindowContainment(baseInput(requested140));
    expect(atBoundary.allowed).toBe(true);
    expect(atBoundary.acceptedKeys).toEqual(requested140);
    expect(atBoundary.mountedCount).toBe(140);
    expect(atBoundary.directChildCount).toBe(146);

    const requested141 = keys(141);
    const mountedOver = planChatWindowContainment({
      ...baseInput(requested141),
      projectedStructuralRoots: 0,
    });
    expect(mountedOver.acceptedKeys).toEqual(requested141.slice(0, 140));
    expect(mountedOver.mountedCount).toBe(140);

    const directOver = planChatWindowContainment({
      ...baseInput(requested141),
      projectedStructuralRoots: 7,
    });
    expect(directOver.acceptedKeys).toEqual(requested141.slice(0, 139));
    expect(directOver.directChildCount).toBe(146);
  });

  test('denies impossible/malformed structural roots and safely normalizes malformed keys', () => {
    const impossible = planChatWindowContainment({
      ...baseInput(['a']),
      projectedStructuralRoots: 147,
    });
    expect(impossible).toMatchObject({
      allowed: false,
      reason: 'impossible-structural-roots',
      acceptedKeys: [],
      mountedCount: 0,
    });

    const malformed = planChatWindowContainment({
      requestedKeys: ['', 'a', 'a', 3, null, 'b'],
      visibleLoadedKeys: ['a', 'b', 'b', '', {}],
      viewportKeys: ['b', 'a'],
      coreKeys: [],
      overscanKeys: [],
      adapterSnapshotKeys: ['outside'],
      projectedStructuralRoots: Number.NaN,
      limits,
    } as unknown as ChatWindowContainmentInput);
    expect(malformed.acceptedKeys).toEqual(['a', 'b']);
    expect(malformed.directChildCount).toBe(2);
  });

  test('is deterministic, immutable, ordered, and never widens across bounded fuzz cases', () => {
    let seed = 0x2a0f;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };

    for (let run = 0; run < 300; run += 1) {
      const requested = keys(50 + (random() % 300), `r${run}-`);
      const visible = requested.filter(() => random() % 5 !== 0);
      const input: ChatWindowContainmentInput = {
        ...baseInput(requested),
        visibleLoadedKeys: visible,
        viewportKeys: requested.slice(20, 100),
        coreKeys: requested.slice(0, 20),
        overscanKeys: requested.slice(100),
        projectedStructuralRoots: random() % 20,
      };
      const first = planChatWindowContainment(input);
      const second = planChatWindowContainment(input);
      const requestedPositions = first.acceptedKeys.map((key) => requested.indexOf(key));
      expect(first).toEqual(second);
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first.acceptedKeys)).toBe(true);
      expect(first.mountedCount).toBeLessThanOrEqual(140);
      expect(first.directChildCount).toBeLessThanOrEqual(146);
      expect(first.acceptedKeys.every((key) => requested.includes(key) && visible.includes(key))).toBe(true);
      expect(requestedPositions).toEqual([...requestedPositions].sort((a, b) => a - b));
      expect(new Set(first.acceptedKeys).size).toBe(first.acceptedKeys.length);
    }
  });
});

describe('planChatWindowContainment pin admission (RED-2)', () => {
  test('retains viewport/core, then admits exact semantic pin priority before overscan', () => {
    const requested = ['over', 'search', 'anchor', 'append', 'user', 'thinking', 'assistant', 'core', 'view'];
    const result = planChatWindowContainment({
      ...baseInput(requested),
      viewportKeys: ['view'],
      coreKeys: ['core'],
      overscanKeys: ['over'],
      currentTurnAssistantKey: 'assistant',
      thinkingId: 'thinking',
      lastTurnUserId: 'user',
      appendRootUserKey: 'append',
      anchorKey: 'anchor',
      searchTargetKey: 'search',
      limits: { mounted: 5, directChildren: 5 },
      projectedStructuralRoots: 0,
    });

    expect(result.acceptedKeys).toEqual(['user', 'thinking', 'assistant', 'core', 'view']);
    expect(result.deferredPins).toEqual([
      { key: 'append', role: 'append-root', reason: 'capacity' },
      { key: 'anchor', role: 'reading-anchor', reason: 'capacity' },
      { key: 'search', role: 'search-target', reason: 'capacity' },
    ]);
  });

  test('collapses aliases/duplicates and pins never grow either capacity', () => {
    const result = planChatWindowContainment({
      ...baseInput(['same', 'user', 'append', 'anchor', 'search']),
      viewportKeys: [],
      currentTurnAssistantKey: 'same',
      thinkingId: 'same',
      lastTurnUserId: 'user',
      appendRootUserKey: 'append',
      anchorKey: 'anchor',
      searchTargetKey: 'search',
      limits: { mounted: 99, directChildren: 3 },
      projectedStructuralRoots: 1,
    });
    expect(result.acceptedKeys).toEqual(['same', 'user']);
    expect(result.mountedCount).toBe(2);
    expect(result.directChildCount).toBe(3);
    expect(result.deferredPins.map(({ role }) => role)).toEqual([
      'append-root',
      'reading-anchor',
      'search-target',
    ]);
  });

  test('defers unavailable pins truthfully without adding requested or visible keys', () => {
    const result = planChatWindowContainment({
      ...baseInput(['ordinary']),
      currentTurnAssistantKey: 'not-requested',
      lastTurnUserId: 'not-visible',
      visibleLoadedKeys: ['ordinary', 'not-requested'],
    });
    expect(result.acceptedKeys).toEqual(['ordinary']);
    expect(result.deferredPins).toEqual([
      { key: 'not-requested', role: 'current-streaming-assistant', reason: 'not-requested' },
      { key: 'not-visible', role: 'paired-active-user', reason: 'not-visible-loaded' },
    ]);
  });
});

describe('planChatWindowContainment safe-shell map (RED-3)', () => {
  const families: readonly SafeShellFamily[] = [
    'message-user', 'message-assistant', 'message-tool-meta', 'message-subagent',
    'change-list', 'segment', 'conflict', 'message-image', 'message-code',
    'message-diff', 'message-table', 'message-markdown',
  ];

  test('accepts only caller-requested exact frozen families for accepted matching keys', () => {
    const requested = keys(families.length, 'shell-');
    const shellRequests = families.map((family, index) => ({
      key: requested[index], mode: 'safe-shell' as const, family,
    }));
    const result = planChatWindowContainment({ ...baseInput(requested), shellRequests });
    expect(result.shellSelections).toEqual(Object.fromEntries(shellRequests.map(({ key, mode, family }) => [
      key,
      { mode, family },
    ])));
    expect(result.deniedShellRequests).toEqual([]);
  });

  test('denies unknown family, wrong mode, missing key, and truncated key without guessing', () => {
    const result = planChatWindowContainment({
      ...baseInput(['accepted', 'truncated']),
      limits: { mounted: 1, directChildren: 1 },
      projectedStructuralRoots: 0,
      shellRequests: [
        { key: 'accepted', mode: 'safe-shell', family: 'message-code' },
        { key: 'accepted', mode: 'safe-shell', family: 'invented' },
        { key: 'accepted', mode: 'normal-rich', family: 'message-user' },
        { key: 'missing', mode: 'safe-shell', family: 'message-user' },
        { key: 'truncated', mode: 'safe-shell', family: 'message-user' },
      ],
    } as ChatWindowContainmentInput);
    expect(result.shellSelections).toEqual({ accepted: { mode: 'safe-shell', family: 'message-code' } });
    expect(result.deniedShellRequests).toEqual([
      { key: 'accepted', reason: 'unknown-family' },
      { key: 'accepted', reason: 'invalid-mode' },
      { key: 'missing', reason: 'key-not-accepted' },
      { key: 'truncated', reason: 'key-not-accepted' },
    ]);
  });

  test('does not mutate canonical/request inputs and freezes nested outputs', () => {
    const canonical = { id: 'a', content: { text: 'unchanged' } };
    const input = {
      ...baseInput(['a']),
      shellRequests: [{ key: 'a', mode: 'safe-shell' as const, family: 'message-markdown' as const }],
      canonicalUnits: [canonical],
      searchCorpus: ['unchanged'],
    } as ChatWindowContainmentInput & { canonicalUnits: unknown; searchCorpus: unknown };
    const before = JSON.stringify(input);
    const result = planChatWindowContainment(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(canonical.content.text).toBe('unchanged');
    expect(Object.isFrozen(result.shellSelections)).toBe(true);
    expect(Object.isFrozen(result.shellSelections.a)).toBe(true);
    expect(Object.isFrozen(result.deferredPins)).toBe(true);
  });
});

describe('classifyChatWindowIntegrity closed postconditions (A2.0C RED)', () => {
  const closedCases: readonly ChatWindowIntegrityInput[] = [
    { code: 'duplicate-keyed-root', expected: 1, actual: 2 },
    { code: 'missing-accepted-keyed-root', expected: true, actual: false },
    { code: 'unexpected-keyed-root', expected: false, actual: true },
    { code: 'unclassified-direct-root', expected: 0, actual: 1 },
    { code: 'root-map-dom-mismatch', expected: ['a', 'b'], actual: ['a', 'c'] },
    { code: 'active-spacer-missing-or-duplicated', expected: 1, actual: 0 },
    { code: 'adapter-session-generation-mismatch', expected: 17, actual: 18 },
  ];

  test.each(closedCases)('classifies the closed corruption predicate %#', (input) => {
    expect(classifyChatWindowIntegrity(input)).toEqual({ corrupt: true, code: input.code });
  });

  test('mutation-kills every closed predicate when its exact postcondition is restored', () => {
    const restored: readonly ChatWindowIntegrityInput[] = [
      { code: 'duplicate-keyed-root', expected: 1, actual: 1 },
      { code: 'missing-accepted-keyed-root', expected: true, actual: true },
      { code: 'unexpected-keyed-root', expected: false, actual: false },
      { code: 'unclassified-direct-root', expected: 0, actual: 0 },
      { code: 'root-map-dom-mismatch', expected: ['a', 'b'], actual: ['a', 'b'] },
      { code: 'active-spacer-missing-or-duplicated', expected: 1, actual: 1 },
      { code: 'adapter-session-generation-mismatch', expected: 17, actual: 17 },
    ];

    for (const input of restored) {
      expect(classifyChatWindowIntegrity(input)).toEqual({ corrupt: false });
    }
  });

  test('rejects malformed boundaries, mixed predicates, unknown fields, and unknown codes', () => {
    const negatives: readonly unknown[] = [
      { code: 'duplicate-keyed-root', expected: 0, actual: 2 },
      { code: 'duplicate-keyed-root', expected: 1, actual: 0 },
      { code: 'missing-accepted-keyed-root', expected: 1, actual: 0 },
      { code: 'unexpected-keyed-root', expected: false, actual: 'true' },
      { code: 'unclassified-direct-root', expected: 1, actual: 2 },
      { code: 'root-map-dom-mismatch', expected: ['a', 'a'], actual: ['a'] },
      { code: 'root-map-dom-mismatch', expected: ['a'], actual: ['a'], mismatch: true },
      { code: 'active-spacer-missing-or-duplicated', expected: 0, actual: 2 },
      { code: 'adapter-session-generation-mismatch', expected: 1, actual: '2' },
      { code: 'adapter-session-generation-mismatch', expected: Number.NaN, actual: 2 },
      { code: 'descendant-pressure', expected: 0, actual: 9999 },
      { code: 'mounted-pressure', expected: 140, actual: 141 },
      { code: 'direct-pressure', expected: 146, actual: 147 },
      { code: 'duplicate-keyed-root', expected: 1, actual: 1, corrupt: true },
      { code: 'invented-corruption', expected: false, actual: true },
      {
        code: 'factory-exception',
        expected: 'ok',
        actual: new Error('factory failed'),
        mounted: 999,
      },
      new Error('rich/reconcile/shell failed'),
      { capability: 'unavailable', error: new Error('adapter unavailable'), corrupt: true },
      null,
    ];

    for (const input of negatives) {
      expect(classifyChatWindowIntegrity(input)).toEqual({ corrupt: false });
    }
  });

  test('stays immutable, deterministic, side-effect free, and preserves mixed closed evidence', () => {
    const input = {
      code: 'active-spacer-missing-or-duplicated',
      expected: 1,
      actual: 2,
      error: new Error('irrelevant shell failure'),
      mountedPressure: 999,
    } as const;
    const before = { ...input };
    const first = classifyChatWindowIntegrity(input);
    const second = classifyChatWindowIntegrity(input);

    expect(first).toEqual({ corrupt: true, code: 'active-spacer-missing-or-duplicated' });
    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(input).toEqual(before);
  });
});

describe('A2.1 dormant chat-window facade contract', () => {
  test('exposes only read-only planner/classifier capabilities without selection, DOM, or global effects', () => {
    const bundle = fs.readFileSync(path.join(root, 'media', 'rendering.bundle.js'), 'utf8');
    const windowObject: Record<string, unknown> = {};
    const sandbox: Record<string, unknown> = { window: windowObject };
    Object.defineProperty(sandbox, 'document', {
      configurable: true,
      get: () => { throw new Error('DOM access is forbidden for dormant chat-window planning'); },
    });
    const globalKeysBefore = Reflect.ownKeys(sandbox);

    vm.runInNewContext(bundle, sandbox);

    expect(Reflect.ownKeys(sandbox)).toEqual(globalKeysBefore);
    expect(Reflect.ownKeys(windowObject)).toEqual(['__ocRendering']);
    const facade = windowObject.__ocRendering as Record<string, any>;
    expect(Object.isFrozen(facade)).toBe(true);
    expect(facade.version).toBe(1);
    expect(Object.keys(facade)).toEqual([
      'version',
      'deriveRenderUnits',
      'presentationFingerprint',
      'planReconciliation',
      'restoreScrollAnchor',
      'restoreKeyedScrollAnchor',
      'createTanStackVirtualAdapter',
      'createLocalHistoryPresentationController',
      'deriveLocalOlderPresentation',
      'normalizeHydrationCoverage',
      'throwSourceMapTestError',
      'buildChatPressureAttribution',
    ]);
    expect(Reflect.ownKeys(facade)).toEqual([
      ...Object.keys(facade),
      'getSafeShellSpec',
      'planChatWindowContainment',
      'classifyChatWindowIntegrity',
      'decideChatWindowAdaptivePolicy',
    ]);

    for (const capability of [
      'getSafeShellSpec',
      'planChatWindowContainment',
      'classifyChatWindowIntegrity',
      'decideChatWindowAdaptivePolicy',
    ]) {
      expect(Object.getOwnPropertyDescriptor(facade, capability)).toMatchObject({
        value: expect.any(Function),
        enumerable: false,
        writable: false,
        configurable: false,
      });
    }
    expect(facade.buildChatPressureAttribution).toEqual(expect.any(Function));

    const plannerInput = {
      requestedKeys: ['user', 'assistant'],
      visibleLoadedKeys: ['user', 'assistant'],
      viewportKeys: ['assistant'],
      coreKeys: ['user'],
      overscanKeys: [],
      adapterSnapshotKeys: [],
      projectedStructuralRoots: 2,
      limits,
    };
    const integrityInput = { code: 'duplicate-keyed-root', expected: 1, actual: 2 };
    const shellInput = { mode: 'safe-shell', family: 'message-user', shape: {} };

    for (const [invoke, input] of [
      [facade.planChatWindowContainment, plannerInput],
      [facade.classifyChatWindowIntegrity, integrityInput],
      [facade.getSafeShellSpec, shellInput],
    ] as const) {
      const first = invoke(input);
      const second = invoke(input);
      expect(first).toEqual(second);
      expect(Object.isFrozen(first)).toBe(true);
    }

    expect(facade.planChatWindowContainment(plannerInput).shellSelections).toEqual({});
    expect(Reflect.ownKeys(windowObject)).toEqual(['__ocRendering']);
    expect(Reflect.ownKeys(sandbox)).toEqual(globalKeysBefore);
  });
});
