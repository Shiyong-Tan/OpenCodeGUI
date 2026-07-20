import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

import {
  MAX_ATTRIBUTION_COUNT,
  MAX_ATTRIBUTION_UNITS,
  TOP_CONTRIBUTOR_LIMIT,
  buildChatPressureAttribution,
  type ChatPressureAttributionInput,
} from '../rendering/chat-pressure-attribution';

const root = path.resolve(__dirname, '../..');

const cleanCleanup = (generation = 7) => ({
  available: true,
  generation,
  ownedUnmount: true,
  residualRoots: 0,
  postUnmountDescendantDelta: 0,
  staleRejections: 0,
});

const ordinaryUnits = [
  { unitIndex: 0, kind: 'message', role: 'user', descendants: 18, directChildren: 2 },
  { unitIndex: 1, kind: 'message', role: 'assistant', descendants: 17, directChildren: 2 },
  { unitIndex: 2, kind: 'segment', role: 'assistant', descendants: 17, directChildren: 2 },
  { unitIndex: 3, kind: 'change-list', role: 'assistant', descendants: 16, directChildren: 2 },
  { unitIndex: 4, kind: 'greeting', role: 'system', descendants: 16, directChildren: 2 },
  { unitIndex: 5, kind: 'conflict', role: 'system', descendants: 16, directChildren: 2 },
];

const input = (
  units: ChatPressureAttributionInput['units'],
  totalDescendants: number,
  cleanup: ChatPressureAttributionInput['cleanup'] = cleanCleanup(),
): ChatPressureAttributionInput => ({
  generation: 7,
  auditAvailable: true,
  coverageAvailable: true,
  totalDescendants,
  units,
  cleanup,
});

describe('chat pressure attribution privacy schema and bounds', () => {
  test('constructs an exact fresh allowlisted schema and omits content, IDs, and unknown fields', () => {
    const hostile = {
      ...input([
        {
          unitIndex: 4,
          kind: 'not-a-kind',
          role: 'not-a-role',
          descendants: 12,
          directChildren: 3,
          text: 'PRIVATE_TEXT_SENTINEL',
          html: '<b>PRIVATE_HTML_SENTINEL</b>',
          code: 'PRIVATE_CODE_SENTINEL',
          filePath: 'C:/PRIVATE_PATH_SENTINEL',
          path: 'C:/PRIVATE_GENERIC_PATH_SENTINEL',
          payload: { private: 'PRIVATE_PAYLOAD_SENTINEL' },
          searchTerm: 'PRIVATE_SEARCH_SENTINEL',
          copiedContent: 'PRIVATE_COPIED_SENTINEL',
          unitId: 'PRIVATE_UNIT_ID_SENTINEL',
          unitKey: 'PRIVATE_UNIT_KEY_SENTINEL',
          messageId: 'PRIVATE_MESSAGE_ID_SENTINEL',
          aliasId: 'PRIVATE_ALIAS_ID_SENTINEL',
          searchTargetKey: 'PRIVATE_SEARCH_TARGET_SENTINEL',
        },
      ] as unknown as ChatPressureAttributionInput['units'], 12),
      sessionId: 'PRIVATE_SESSION_ID_SENTINEL',
      activeSessionId: 'PRIVATE_ACTIVE_SESSION_ID_SENTINEL',
      failedSessionId: 'PRIVATE_FAILED_SESSION_ID_SENTINEL',
      acceptanceBlocker: { sessionId: 'PRIVATE_BLOCKER_SESSION_ID_SENTINEL' },
      raw: 'PRIVATE_RAW_SENTINEL',
      unknown: 'PRIVATE_UNKNOWN_SENTINEL',
    } as ChatPressureAttributionInput;

    const result = buildChatPressureAttribution(hostile);

    expect(Object.keys(result)).toEqual([
      'generation',
      'audit',
      'cleanup',
      'topContributors',
      'dominance',
      'classification',
    ]);
    expect(Object.keys(result.audit)).toEqual([
      'available',
      'coverageAvailable',
      'totalDescendants',
      'attributedDescendants',
      'reconciled',
      'observedUnitCount',
    ]);
    expect(Object.keys(result.topContributors[0])).toEqual([
      'unitIndex',
      'kind',
      'role',
      'descendants',
      'directChildren',
      'mounted',
      'visible',
      'pinned',
    ]);
    expect(Object.keys(result.cleanup)).toEqual([
      'available',
      'generationMatches',
      'ownedUnmount',
      'residualRoots',
      'postUnmountDescendantDelta',
      'staleRejections',
    ]);
    expect(Object.keys(result.dominance)).toEqual([
      'available', 'topUnitBasisPoints', 'topThreeBasisPoints',
    ]);
    expect(Object.keys(result.classification)).toEqual([
      'value', 'missingDiscriminators',
    ]);
    expect(result.topContributors[0].kind).toBe('unknown');
    expect(result.topContributors[0].role).toBe('unknown');

    const serialized = JSON.stringify(result);
    for (const forbidden of [
      'PRIVATE_', 'sessionId', 'activeSessionId', 'failedSessionId', 'messageId',
      'unitId', 'unitKey', 'aliasId', 'searchTargetKey', 'acceptanceBlocker',
      'text', 'html', 'code', 'filePath', 'path', 'payload', 'searchTerm',
      'copiedContent', 'raw',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('normalizes finite non-negative integers, clamps counts, and reports unavailable values', () => {
    const result = buildChatPressureAttribution({
      generation: Number.POSITIVE_INFINITY,
      auditAvailable: true,
      coverageAvailable: false,
      totalDescendants: Number.NaN,
      units: [{
        unitIndex: -2,
        kind: 'message',
        role: 'assistant',
        descendants: Number.POSITIVE_INFINITY,
        directChildren: MAX_ATTRIBUTION_COUNT + 99,
        mounted: 1 as unknown as boolean,
      }],
      cleanup: { available: false },
    });

    expect(result.generation).toBe(0);
    expect(result.audit).toEqual({
      available: true,
      coverageAvailable: false,
      totalDescendants: null,
      attributedDescendants: 0,
      reconciled: false,
      observedUnitCount: 1,
    });
    expect(result.topContributors[0]).toMatchObject({
      unitIndex: 0,
      descendants: 0,
      directChildren: MAX_ATTRIBUTION_COUNT,
      mounted: false,
    });
    expect(result.cleanup).toEqual({
      available: false,
      generationMatches: null,
      ownedUnmount: null,
      residualRoots: null,
      postUnmountDescendantDelta: null,
      staleRejections: null,
    });
    expect(result.classification).toEqual({
      value: 'unknown',
      missingDiscriminators: ['attributed-total-reconciliation', 'cleanup-evidence', 'coverage'],
    });
  });

  test('retains only top eight contributors with deterministic metric/index ordering', () => {
    const units = Array.from({ length: MAX_ATTRIBUTION_UNITS + 20 }, (_, unitIndex) => ({
      unitIndex,
      kind: 'message',
      role: 'assistant',
      descendants: unitIndex < 10 ? 10 : 1,
      directChildren: 1,
    }));
    const result = buildChatPressureAttribution(input(units, 1490));

    expect(TOP_CONTRIBUTOR_LIMIT).toBe(8);
    expect(result.topContributors).toHaveLength(8);
    expect(result.topContributors.map((unit: { unitIndex: number }) => unit.unitIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(result.audit.observedUnitCount).toBe(MAX_ATTRIBUTION_UNITS);
  });
});

describe('aggregation and generation ownership', () => {
  test('aggregates duplicate unit indices and reconciles the attributed total exactly', () => {
    const result = buildChatPressureAttribution(input([
      { unitIndex: 2, kind: 'message', role: 'assistant', descendants: 20, directChildren: 2 },
      { unitIndex: 1, kind: 'message', role: 'user', descendants: 25, directChildren: 1 },
      { unitIndex: 2, kind: 'message', role: 'assistant', descendants: 15, directChildren: 3 },
      { unitIndex: 3, kind: 'segment', role: 'assistant', descendants: 40, directChildren: 4 },
    ], 100));

    expect(result.audit).toMatchObject({
      totalDescendants: 100,
      attributedDescendants: 100,
      reconciled: true,
      observedUnitCount: 3,
    });
    expect(result.topContributors).toEqual([
      expect.objectContaining({ unitIndex: 3, descendants: 40 }),
      expect.objectContaining({ unitIndex: 2, descendants: 35, directChildren: 5 }),
      expect.objectContaining({ unitIndex: 1, descendants: 25 }),
    ]);
    expect(result.classification.value).toBe('exceptional-unit');
  });

  test('does not merge cleanup evidence from another generation', () => {
    const result = buildChatPressureAttribution(input(ordinaryUnits, 100, {
      available: true,
      generation: 6,
      ownedUnmount: true,
      residualRoots: 9,
      postUnmountDescendantDelta: 20,
      staleRejections: 3,
    }));

    expect(result.cleanup).toEqual({
      available: true,
      generationMatches: false,
      ownedUnmount: null,
      residualRoots: null,
      postUnmountDescendantDelta: null,
      staleRejections: null,
    });
    expect(result.classification).toEqual({
      value: 'unknown',
      missingDiscriminators: ['cleanup-generation-match'],
    });
  });
});

describe('deterministic classification', () => {
  const cases: Array<[string, ChatPressureAttributionInput]> = [
    ['cumulative-ordinary', input(ordinaryUnits, 100)],
    ['exceptional-unit', input([
      { unitIndex: 0, kind: 'message', role: 'assistant', descendants: 35 },
      { unitIndex: 1, kind: 'message', role: 'user', descendants: 25 },
      { unitIndex: 2, kind: 'segment', role: 'assistant', descendants: 15 },
      { unitIndex: 3, kind: 'system', role: 'system', descendants: 15 },
      { unitIndex: 4, kind: 'greeting', role: 'system', descendants: 10 },
    ], 100)],
    ['suspected-cleanup-drift', input([], 0, {
      ...cleanCleanup(), residualRoots: 1,
    })],
    ['mixed', input(ordinaryUnits, 100, {
      ...cleanCleanup(), postUnmountDescendantDelta: 1,
    })],
    ['unknown', {
      ...input(ordinaryUnits, 100), coverageAvailable: false,
    }],
  ];

  test.each(cases)('classifies %s and produces byte-identical normalized output twice', (expected, value) => {
    const first = JSON.stringify(buildChatPressureAttribution(value));
    const second = JSON.stringify(buildChatPressureAttribution(value));
    expect(first).toBe(second);
    expect(JSON.parse(first).classification.value).toBe(expected);
  });

  test('uses inclusive 35% single and 60% top-three exceptional boundaries', () => {
    const singleBoundary = buildChatPressureAttribution(input([
      { unitIndex: 0, descendants: 35 }, { unitIndex: 1, descendants: 25 },
      { unitIndex: 2, descendants: 20 }, { unitIndex: 3, descendants: 20 },
    ], 100));
    const topThreeBoundary = buildChatPressureAttribution(input([
      { unitIndex: 0, descendants: 20 }, { unitIndex: 1, descendants: 20 },
      { unitIndex: 2, descendants: 20 }, { unitIndex: 3, descendants: 20 },
      { unitIndex: 4, descendants: 20 },
    ], 100));
    const strictlyBelow = buildChatPressureAttribution(input(ordinaryUnits, 100));

    expect(singleBoundary.dominance).toMatchObject({ topUnitBasisPoints: 3500 });
    expect(singleBoundary.classification.value).toBe('exceptional-unit');
    expect(topThreeBoundary.dominance).toMatchObject({ topThreeBasisPoints: 6000 });
    expect(topThreeBoundary.classification.value).toBe('exceptional-unit');
    expect(strictlyBelow.dominance).toMatchObject({
      topUnitBasisPoints: 1800,
      topThreeBasisPoints: 5200,
    });
    expect(strictlyBelow.classification.value).toBe('cumulative-ordinary');
  });

  test('reports missing discriminators explicitly instead of inventing evidence', () => {
    const result = buildChatPressureAttribution({
      generation: 1,
      auditAvailable: false,
      coverageAvailable: false,
      units: [],
      cleanup: { available: false },
    });

    expect(result.dominance).toEqual({
      available: false,
      topUnitBasisPoints: null,
      topThreeBasisPoints: null,
    });
    expect(result.classification).toEqual({
      value: 'unknown',
      missingDiscriminators: [
        'attributed-total-reconciliation', 'audit-sample', 'cleanup-evidence', 'coverage',
      ],
    });
  });
});

describe('frozen rendering facade contract', () => {
  test('bundle exposes only the dormant attribution builder and has no DOM or global side effects', () => {
    const bundle = fs.readFileSync(path.join(root, 'media', 'rendering.bundle.js'), 'utf8');
    const windowObject: Record<string, unknown> = {};
    const sandbox: Record<string, unknown> = { window: windowObject };
    Object.defineProperty(sandbox, 'document', {
      configurable: true,
      get: () => { throw new Error('DOM access is forbidden for dormant attribution'); },
    });
    const globalKeysBefore = Reflect.ownKeys(sandbox);

    vm.runInNewContext(bundle, sandbox);

    expect(Reflect.ownKeys(sandbox)).toEqual(globalKeysBefore);
    expect(Reflect.ownKeys(windowObject)).toEqual(['__ocRendering']);
    const facade = windowObject.__ocRendering as Record<string, unknown>;
    expect(Object.isFrozen(facade)).toBe(true);
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
    expect(facade).not.toHaveProperty('aggregateUnits');
    expect(facade).not.toHaveProperty('normalizeInteger');
    expect(facade).not.toHaveProperty('normalizeKind');
    expect(facade).not.toHaveProperty('normalizeRole');
    expect(facade).not.toHaveProperty('TOP_CONTRIBUTOR_LIMIT');
    expect(facade).not.toHaveProperty('MAX_ATTRIBUTION_UNITS');
    expect(facade).not.toHaveProperty('MAX_ATTRIBUTION_COUNT');
    expect(facade).not.toHaveProperty('MAX_ATTRIBUTION_GENERATION');

    const build = facade.buildChatPressureAttribution as typeof buildChatPressureAttribution;
    const synthetic = input(ordinaryUnits, 100);
    const first = build(synthetic);
    const second = build(synthetic);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.classification.value).toBe('cumulative-ordinary');
    expect(JSON.stringify(first)).not.toMatch(/PRIVATE_|sessionId|messageId|unitKey|text|html|payload/);
    expect(Reflect.ownKeys(windowObject)).toEqual(['__ocRendering']);
    expect(Reflect.ownKeys(sandbox)).toEqual(globalKeysBefore);
  });
});
