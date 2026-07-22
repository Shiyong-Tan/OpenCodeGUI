import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

import {
  CHAT_WINDOW_ADAPTIVE_HYPOTHESES,
  decideChatWindowAdaptivePolicy,
  type ChatWindowAdaptiveInput,
  type ChatWindowAdaptiveResult,
  type ChatWindowAdaptiveState,
  type InitialTailOption,
  type OverscanTier,
} from '../rendering/chat-window-adaptive-policy';
import { planChatWindowContainment } from '../rendering/chat-window-budget-plan';

const root = path.resolve(__dirname, '../..');

const roles = Object.freeze({
  visible: 8,
  core: 2,
  currentStreamingAssistant: 1,
  thinkingAlias: 0,
  pairedActiveUser: 1,
  appendRoot: 0,
  readingAnchor: 1,
  searchTarget: 1,
  overscan: 6,
});

const roleOutcomes = Object.freeze({
  accepted: roles,
  capped: Object.freeze({ ...roles, visible: 0, core: 0, currentStreamingAssistant: 0,
    pairedActiveUser: 0, readingAnchor: 0, searchTarget: 0, overscan: 0 }),
  deferred: Object.freeze({ ...roles, visible: 0, core: 0, currentStreamingAssistant: 0,
    pairedActiveUser: 0, readingAnchor: 0, searchTarget: 0, overscan: 0 }),
});

const config = Object.freeze({
  enabled: true,
  revision: 7,
  pressure: Object.freeze({
    mountedAtLeast: 130,
    directChildrenAtLeast: 140,
    descendantsAtLeast: 900,
    renderCostAtLeast: 80,
    measureCostAtLeast: 70,
  }),
  headroom: Object.freeze({
    mountedAtMost: 90,
    directChildrenAtMost: 96,
    descendantsAtMost: 400,
    renderCostAtMost: 30,
    measureCostAtMost: 25,
  }),
  pressureConsecutiveIntervals: 2,
  headroomConsecutiveIntervals: 2,
  cooldownIntervals: 2,
  minimumAheadItems: 1,
  minimumBehindItems: 1,
  fastScrollDirectionalReserve: 5,
});

const initialState = (sessionGeneration = 1): ChatWindowAdaptiveState => Object.freeze({
  sessionGeneration,
  lastDecisionInterval: 0,
  overscanTier: 20,
  initialTail: 80,
  pressureCount: 0,
  headroomCount: 0,
  cooldownRemaining: 0,
  lastSignal: 'none',
  decisionGeneration: 0,
});

const input = (overrides: Partial<ChatWindowAdaptiveInput> = {}): ChatWindowAdaptiveInput => ({
  config,
  state: initialState(),
  decisionInterval: 1,
  sessionGeneration: 1,
  provenance: { kind: 'external' },
  direction: 'stationary',
  velocity: 'idle',
  measurements: {
    mountedCount: 110,
    directChildCount: 116,
    descendantCount: 600,
    viewportItemDemand: 8,
    renderCost: 50,
    measureCost: 45,
    projectedStructuralRoots: 6,
    currentRequestedCount: 40,
    currentAcceptedCount: 40,
  },
  roleOutcomes,
  syntheticEnvironment: true,
  ...overrides,
});

const pressureMeasurements = Object.freeze({
  ...input().measurements,
  mountedCount: 130,
});

const headroomMeasurements = Object.freeze({
  ...input().measurements,
  mountedCount: 80,
  directChildCount: 86,
  descendantCount: 300,
  renderCost: 20,
  measureCost: 15,
});

const recursivelyFrozen = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value as Record<string, unknown>).every(recursivelyFrozen);
};

const run = (
  state: ChatWindowAdaptiveState,
  decisionInterval: number,
  measurements: ChatWindowAdaptiveInput['measurements'],
  overrides: Partial<ChatWindowAdaptiveInput> = {},
): ChatWindowAdaptiveResult => decideChatWindowAdaptivePolicy(input({
  state,
  decisionInterval,
  measurements,
  ...overrides,
}));

describe('B0-RED-1 closed hypotheses, validation, immutability, and timeline independence', () => {
  test('centralizes only the reviewed options, validation ceilings, and disabled 20/80 initial model', () => {
    expect(CHAT_WINDOW_ADAPTIVE_HYPOTHESES).toEqual({
      overscanTiers: [20, 10, 4],
      initialTailOptions: [80, 40, 24],
      validationCeilings: { mounted: 140, directChildren: 146 },
      initial: { enabled: false, overscanTier: 20, initialTail: 80 },
    });
    expect(recursivelyFrozen(CHAT_WINDOW_ADAPTIVE_HYPOTHESES)).toBe(true);
    expect(CHAT_WINDOW_ADAPTIVE_HYPOTHESES).not.toHaveProperty('threshold');
    expect(CHAT_WINDOW_ADAPTIVE_HYPOTHESES).not.toHaveProperty('rollout');
  });

  test('has no timeline-length type and hostile extra timeline fields cannot influence bytes', () => {
    const typed = input();
    // @ts-expect-error Timeline length is intentionally absent from the closed input contract.
    typed.timelineLength = 999999;
    const clean = input();
    const hostile = { ...clean, timelineLength: 1, totalTimelineLength: Number.MAX_SAFE_INTEGER,
      messages: new Array(100).fill('hostile') } as unknown as ChatWindowAdaptiveInput;
    expect(JSON.stringify(decideChatWindowAdaptivePolicy(hostile)))
      .toBe(JSON.stringify(decideChatWindowAdaptivePolicy(clean)));
  });

  test.each([
    null,
    {},
    input({ decisionInterval: Number.NaN }),
    input({ sessionGeneration: -1 }),
    input({ config: { ...config, pressureConsecutiveIntervals: 0 } }),
    input({ measurements: { ...input().measurements, mountedCount: 1_000_001 } }),
    input({ measurements: { ...input().measurements, currentAcceptedCount: 8 } }),
  ] as readonly unknown[])('returns a deterministic frozen denied hold for malformed input %#', (candidate) => {
    const first = decideChatWindowAdaptivePolicy(candidate);
    const second = decideChatWindowAdaptivePolicy(candidate);
    expect(first.allowed).toBe(false);
    expect(first.reason).toBe('invalid-input');
    expect(first.decision).toBe('hold');
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(recursivelyFrozen(first)).toBe(true);
  });
});

describe('B0-RED-2 sustained transitions, cooldown, monotonic intervals, and reset', () => {
  test('requires sustained pressure/headroom, moves one tier, and observes cooldown', () => {
    const p1 = run(initialState(), 1, pressureMeasurements);
    expect(p1.decision).toBe('hold');
    expect(p1.state.pressureCount).toBe(1);
    const p2 = run(p1.state, 2, pressureMeasurements);
    expect(p2).toMatchObject({ decision: 'shrink', priorOverscanTier: 20, newOverscanTier: 10,
      priorInitialTail: 80, newInitialTail: 40 });
    expect(p2.state.cooldownRemaining).toBe(2);

    const cooldown1 = run(p2.state, 3, headroomMeasurements);
    const cooldown2 = run(cooldown1.state, 4, headroomMeasurements);
    expect([cooldown1.reason, cooldown2.reason]).toEqual(['cooldown', 'cooldown']);
    expect(cooldown2.state.cooldownRemaining).toBe(0);
    const h1 = run(cooldown2.state, 5, headroomMeasurements);
    const h2 = run(h1.state, 6, headroomMeasurements);
    expect(h2).toMatchObject({ decision: 'grow', priorOverscanTier: 10, newOverscanTier: 20,
      priorInitialTail: 40, newInitialTail: 80 });
  });

  test('duplicate/stale intervals and stale sessions hold without advancing; a newer session resets', () => {
    const first = run(initialState(), 5, pressureMeasurements);
    const duplicate = run(first.state, 5, pressureMeasurements);
    const stale = run(first.state, 4, pressureMeasurements);
    const staleSession = run(first.state, 6, pressureMeasurements, { sessionGeneration: 0 });
    for (const result of [duplicate, stale, staleSession]) {
      expect(result.decision).toBe('hold');
      expect(result.state.pressureCount).toBe(1);
    }
    const reset = run(first.state, 1, pressureMeasurements, { sessionGeneration: 2 });
    expect(reset.reason).toBe('session-reset');
    expect(reset.state).toEqual(initialState(2));
  });

  test('alternating pressure/headroom cannot flap and one interval makes at most one step', () => {
    let state = initialState();
    for (let interval = 1; interval <= 8; interval += 1) {
      const result = run(state, interval, interval % 2 ? pressureMeasurements : headroomMeasurements);
      expect(result.decision).toBe('hold');
      state = result.state;
    }
    expect(state.overscanTier).toBe(20);
    const p1 = run(state, 9, pressureMeasurements);
    const p2 = run(p1.state, 10, pressureMeasurements);
    expect(p2.state.overscanTier).toBe(10);
    expect(p2.state.initialTail).toBe(40);
  });
});

describe('B0-RED-3 self churn provenance', () => {
  test('does not advance either counter/cooldown or retrigger, while later external pressure may', () => {
    const external1 = run(initialState(), 1, pressureMeasurements);
    const self1 = run(external1.state, 2, pressureMeasurements, {
      provenance: { kind: 'self', decisionGeneration: external1.state.decisionGeneration },
    });
    const self2 = run(self1.state, 3, headroomMeasurements, {
      provenance: { kind: 'self', decisionGeneration: self1.state.decisionGeneration },
    });
    expect(self1.reason).toBe('self-churn');
    expect(self2.reason).toBe('self-churn');
    expect(self2.state.pressureCount).toBe(1);
    expect(self2.state.headroomCount).toBe(0);
    const external2 = run(self2.state, 4, pressureMeasurements);
    expect(external2.decision).toBe('shrink');
  });
});

describe('B0-RED-4 directional coverage across closed tier/tail options', () => {
  const tiers: readonly OverscanTier[] = [20, 10, 4];
  const tails: readonly InitialTailOption[] = [80, 40, 24];

  test.each(tiers.flatMap((overscanTier) => tails.flatMap((initialTail) => [
    { overscanTier, initialTail, direction: 'forward' as const },
    { overscanTier, initialTail, direction: 'backward' as const },
  ])))('retains viewport and nonzero two-sided coverage without growing demand %#', (sample) => {
    const state = Object.freeze({ ...initialState(), overscanTier: sample.overscanTier,
      initialTail: sample.initialTail });
    const result = run(state, 1, input().measurements, { direction: sample.direction, velocity: 'fast' });
    expect(result.allowed).toBe(true);
    expect(result.range.viewportItems).toBe(input().measurements.viewportItemDemand);
    expect(result.range.aheadItems).toBeGreaterThan(0);
    expect(result.range.behindItems).toBeGreaterThan(0);
    expect(result.range.totalDemand).toBeLessThanOrEqual(input().measurements.currentRequestedCount);
    expect(result.range.totalDemand).toBeLessThanOrEqual(input().measurements.currentAcceptedCount);
    expect(result.range.totalDemand).toBeLessThanOrEqual(140);
    if (sample.direction === 'forward') expect(result.range.aheadItems).toBeGreaterThan(result.range.behindItems);
    else expect(result.range.behindItems).toBeGreaterThan(result.range.aheadItems);
  });

  test.each([
    { minimumAheadItems: 1, minimumBehindItems: 2, allowed: true, boundary: 'below tier 4' },
    { minimumAheadItems: 1, minimumBehindItems: 3, allowed: true, boundary: 'equal to tier 4' },
    { minimumAheadItems: 2, minimumBehindItems: 3, allowed: false, boundary: 'above tier 4' },
    { minimumAheadItems: 3, minimumBehindItems: 1, allowed: true, boundary: 'ahead individual edge' },
    { minimumAheadItems: 1, minimumBehindItems: 3, allowed: true, boundary: 'behind individual edge' },
  ])('validates combined and individual minimum boundary: $boundary', (sample) => {
    const prior = Object.freeze({ ...initialState(), pressureCount: 1, lastSignal: 'pressure' as const });
    const candidateConfig = Object.freeze({
      ...config,
      minimumAheadItems: sample.minimumAheadItems,
      minimumBehindItems: sample.minimumBehindItems,
    });
    const result = run(prior, 1, pressureMeasurements, { config: candidateConfig });
    expect(result.allowed).toBe(sample.allowed);
    if (sample.allowed) {
      expect(result.range.aheadItems).toBeGreaterThanOrEqual(sample.minimumAheadItems);
      expect(result.range.behindItems).toBeGreaterThanOrEqual(sample.minimumBehindItems);
    } else {
      expect(result).toMatchObject({ decision: 'hold', reason: 'invalid-input' });
      expect(result.state).toEqual(prior);
      expect(recursivelyFrozen(result)).toBe(true);
    }
  });

  test.each([
    { field: 'minimumAheadItems', value: 0 },
    { field: 'minimumAheadItems', value: -1 },
    { field: 'minimumAheadItems', value: 1.5 },
    { field: 'minimumAheadItems', value: 141 },
    { field: 'minimumAheadItems', value: Number.MAX_SAFE_INTEGER },
    { field: 'minimumBehindItems', value: 0 },
    { field: 'minimumBehindItems', value: -1 },
    { field: 'minimumBehindItems', value: 1.5 },
    { field: 'minimumBehindItems', value: 141 },
    { field: 'minimumBehindItems', value: Number.MAX_SAFE_INTEGER },
    { field: 'fastScrollDirectionalReserve', value: -1 },
    { field: 'fastScrollDirectionalReserve', value: 0.5 },
    { field: 'fastScrollDirectionalReserve', value: 141 },
    { field: 'fastScrollDirectionalReserve', value: Number.MAX_SAFE_INTEGER },
  ] as const)('rejects hostile numeric range config $field=$value without state advance', ({ field, value }) => {
    const prior = Object.freeze({ ...initialState(), pressureCount: 1, lastSignal: 'pressure' as const });
    const hostileConfig = { ...config, [field]: value } as ChatWindowAdaptiveInput['config'];
    const first = run(prior, 1, pressureMeasurements, { config: hostileConfig });
    const second = run(prior, 1, pressureMeasurements, { config: hostileConfig });
    expect(first).toMatchObject({ allowed: false, decision: 'hold', reason: 'invalid-input' });
    expect(first.state).toEqual(prior);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(recursivelyFrozen(first)).toBe(true);
  });

  test.each(([20, 10, 4] as readonly OverscanTier[]).flatMap((overscanTier) => (
    ['forward', 'backward'] as const
  ).flatMap((direction) => {
    const remaining = overscanTier - 2;
    return [
      { overscanTier, direction, reserve: 0, reserveBoundary: 'zero' },
      { overscanTier, direction, reserve: remaining, reserveBoundary: 'equal remaining' },
      { overscanTier, direction, reserve: remaining + 1, reserveBoundary: 'above remaining' },
    ];
  })))('bounds fast reserve at $reserveBoundary for tier $overscanTier $direction', (sample) => {
    const state = Object.freeze({ ...initialState(), overscanTier: sample.overscanTier });
    const candidateConfig = Object.freeze({
      ...config,
      minimumAheadItems: 1,
      minimumBehindItems: 1,
      fastScrollDirectionalReserve: sample.reserve,
    });
    const result = run(state, 1, input().measurements, {
      config: candidateConfig,
      direction: sample.direction,
      velocity: 'fast',
    });
    const optionalDemand = result.range.aheadItems + result.range.behindItems;
    expect(result.allowed).toBe(true);
    expect(result.range.aheadItems).toBeGreaterThanOrEqual(candidateConfig.minimumAheadItems);
    expect(result.range.behindItems).toBeGreaterThanOrEqual(candidateConfig.minimumBehindItems);
    expect(optionalDemand).toBeLessThanOrEqual(sample.overscanTier);
    expect(result.range.totalDemand).toBeLessThanOrEqual(input().measurements.currentAcceptedCount);
    expect(result.range.totalDemand).toBeLessThanOrEqual(input().measurements.currentRequestedCount);
    expect(result.range.totalDemand).toBeLessThanOrEqual(140);
    expect(result.range.totalDemand + input().measurements.projectedStructuralRoots).toBeLessThanOrEqual(146);
    if (sample.reserve === 0) {
      expect(result.range.aheadItems).toBe(result.range.behindItems);
    } else if (sample.direction === 'forward') {
      expect(result.range.aheadItems).toBeGreaterThan(result.range.behindItems);
    } else {
      expect(result.range.behindItems).toBeGreaterThan(result.range.aheadItems);
    }
  });

  test('preserves every valid tier-4 minimum pair across closed tiers, directions, velocities, and reserve edges', () => {
    const minimumPairs = [
      [1, 1], [1, 2], [1, 3], [2, 1], [2, 2], [3, 1],
    ] as const;
    const directions = ['stationary', 'forward', 'backward'] as const;
    const velocities = ['idle', 'slow', 'fast'] as const;
    const reserves = [0, 2, 140] as const;

    for (const overscanTier of [20, 10, 4] as const) {
      for (const [minimumAheadItems, minimumBehindItems] of minimumPairs) {
        for (const direction of directions) {
          for (const velocity of velocities) {
            for (const fastScrollDirectionalReserve of reserves) {
              const candidateConfig = Object.freeze({
                ...config,
                minimumAheadItems,
                minimumBehindItems,
                fastScrollDirectionalReserve,
              });
              const result = run(Object.freeze({ ...initialState(), overscanTier }), 1,
                input().measurements, { config: candidateConfig, direction, velocity });
              const optionalDemand = result.range.aheadItems + result.range.behindItems;
              expect(result.allowed).toBe(true);
              expect(result.range.aheadItems).toBeGreaterThanOrEqual(minimumAheadItems);
              expect(result.range.behindItems).toBeGreaterThanOrEqual(minimumBehindItems);
              expect(optionalDemand).toBeLessThanOrEqual(overscanTier);
              expect(result.range.totalDemand).toBeLessThanOrEqual(input().measurements.currentAcceptedCount);
              expect(result.range.totalDemand).toBeLessThanOrEqual(input().measurements.currentRequestedCount);
              expect(result.range.totalDemand).toBeLessThanOrEqual(140);
              expect(result.range.totalDemand + input().measurements.projectedStructuralRoots)
                .toBeLessThanOrEqual(146);
            }
          }
        }
      }
    }
  });
});

describe('B0-RED-5 real A2 planner composition', () => {
  test.each([20, 10, 4] as readonly OverscanTier[])('never widens accepted demand or changes pin priority at tier %s', (tier) => {
    const allKeys = Array.from({ length: 180 }, (_, index) => `k${index}`);
    const state = Object.freeze({ ...initialState(), overscanTier: tier });
    const policy = run(state, 1, input().measurements);
    const requested = allKeys.slice(0, policy.range.totalDemand);
    const plan = planChatWindowContainment({
      requestedKeys: requested,
      visibleLoadedKeys: allKeys,
      viewportKeys: requested.slice(0, 8),
      coreKeys: requested.slice(8, 10),
      overscanKeys: requested.slice(10),
      currentTurnAssistantKey: 'k10',
      thinkingId: 'k11',
      lastTurnUserId: 'k12',
      appendRootUserKey: 'k13',
      anchorKey: 'k170',
      searchTargetKey: 'k171',
      projectedStructuralRoots: 6,
      limits: { mounted: 140, directChildren: 146 },
    });
    expect(plan.mountedCount).toBeLessThanOrEqual(policy.range.totalDemand);
    expect(plan.mountedCount).toBeLessThanOrEqual(140);
    expect(plan.directChildCount).toBeLessThanOrEqual(146);
    expect(plan.deferredPins.map(({ role }) => role)).toEqual(tier === 4
      ? ['paired-active-user', 'append-root', 'reading-anchor', 'search-target']
      : ['reading-anchor', 'search-target']);
    expect(plan.acceptedKeys.slice(0, 13)).toContain('k10');
    expect(plan.acceptedKeys.slice(0, 13)).toContain('k11');
    if (tier !== 4) expect(plan.acceptedKeys.slice(0, 13)).toContain('k12');
  });
});

describe('B0-RED-6 closed privacy-safe result and telemetry', () => {
  test('has recursively frozen bounded records, no arrays, identifiers, content, or dynamic strings', () => {
    const result = decideChatWindowAdaptivePolicy({
      ...input(),
      sessionId: 'secret-session', unitKey: 'secret-key', content: '<script>secret</script>',
      searchText: 'needle', path: 'C:/secret', payload: { identifier: 'secret' },
    } as unknown as ChatWindowAdaptiveInput);
    const forbidden = /^(sessionId|unitKey|content|searchText|path|html|payload|messageText|identifier)$/i;
    const visit = (value: unknown): void => {
      expect(Array.isArray(value)).toBe(false);
      if (typeof value !== 'object' || value === null) {
        if (typeof value === 'string') expect(value.length).toBeLessThanOrEqual(32);
        return;
      }
      expect(Object.isFrozen(value)).toBe(true);
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        expect(key).not.toMatch(forbidden);
        if (typeof child === 'number') expect(Number.isSafeInteger(child)).toBe(true);
        visit(child);
      }
    };
    visit(result);
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});

describe('B0-SMOKE deterministic sequence', () => {
  const sequence = (): string => {
    let state = initialState();
    const output: ChatWindowAdaptiveResult[] = [];
    const step = (interval: number, measurements: ChatWindowAdaptiveInput['measurements'],
      overrides: Partial<ChatWindowAdaptiveInput> = {}) => {
      const result = run(state, interval, measurements, overrides);
      output.push(result);
      state = result.state;
    };
    step(1, pressureMeasurements);
    step(2, pressureMeasurements);
    step(3, headroomMeasurements);
    step(4, headroomMeasurements);
    step(5, headroomMeasurements);
    step(6, headroomMeasurements);
    step(1, pressureMeasurements, { sessionGeneration: 2 });
    return JSON.stringify(output);
  };

  test('pressure to cooldown to headroom to reset is byte-identical twice', () => {
    expect(sequence()).toBe(sequence());
  });
});

describe('B1-RED-1 dormant non-enumerable facade contract', () => {
  test('preserves facade version/members and exposes only the reviewed frozen pure function', () => {
    const bundle = fs.readFileSync(path.join(root, 'media', 'rendering.bundle.js'), 'utf8');
    const indexSource = fs.readFileSync(path.join(root, 'webview-src', 'rendering', 'index.ts'), 'utf8');
    const windowObject: Record<string, unknown> = {};
    const sandbox: Record<string, unknown> = { window: windowObject };
    for (const forbiddenGlobal of ['document', 'localStorage', 'sessionStorage', 'fetch', 'main']) {
      Object.defineProperty(sandbox, forbiddenGlobal, {
        configurable: true,
        get: () => { throw new Error(`${forbiddenGlobal} access is forbidden for dormant B1`); },
      });
    }
    const sandboxKeysBefore = Reflect.ownKeys(sandbox);

    vm.runInNewContext(bundle, sandbox);

    expect(Reflect.ownKeys(sandbox)).toEqual(sandboxKeysBefore);
    expect(Reflect.ownKeys(windowObject)).toEqual(['__ocRendering']);
    const facade = windowObject.__ocRendering as Record<string, any>;
    const enumerableMembers = [
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
    ];
    const existingHiddenMembers = [
      'getSafeShellSpec',
      'planChatWindowContainment',
      'classifyChatWindowIntegrity',
    ];

    expect(facade.version).toBe(1);
    expect(Object.isFrozen(facade)).toBe(true);
    expect(Object.keys(facade)).toEqual(enumerableMembers);
    expect(Reflect.ownKeys(facade)).toEqual([
      ...enumerableMembers,
      ...existingHiddenMembers,
      'decideChatWindowAdaptivePolicy',
      'createMarkdownController',
      'renderMessageElement',
    ]);
    for (const member of [...existingHiddenMembers, 'decideChatWindowAdaptivePolicy', 'createMarkdownController', 'renderMessageElement']) {
      expect(Object.getOwnPropertyDescriptor(facade, member)).toMatchObject({
        value: expect.any(Function),
        enumerable: false,
        writable: false,
        configurable: false,
      });
    }
    for (const member of enumerableMembers) {
      expect(Object.getOwnPropertyDescriptor(facade, member)).toMatchObject({
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    expect(facade).not.toHaveProperty('CHAT_WINDOW_ADAPTIVE_HYPOTHESES');
    expect(indexSource).not.toMatch(/decideChatWindowAdaptivePolicy\s*\(/);

    const first = facade.decideChatWindowAdaptivePolicy(input());
    const second = facade.decideChatWindowAdaptivePolicy(input());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(recursivelyFrozen(first)).toBe(true);
    expect(Reflect.ownKeys(sandbox)).toEqual(sandboxKeysBefore);
    expect(Reflect.ownKeys(windowObject)).toEqual(['__ocRendering']);
  });
});
