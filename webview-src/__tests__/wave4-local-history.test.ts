import {
  createLocalHistoryPresentationController,
  deriveLocalOlderPresentation,
} from '../rendering/local-history-window';

const keys = (count: number, prefix = 'key') => Array.from({ length: count }, (_, index) => `${prefix}-${index}`);

describe('Wave 4 local history presentation state', () => {
  test('distinguishes local availability, proven local start, and conservative remote unknown', () => {
    expect(deriveLocalOlderPresentation({ totalUnits: 1001, revealStart: 921, localStartKnown: false })).toEqual({
      state: 'localOlderAvailable', revealStart: 921, localOlderCount: 921,
      label: 'Load older', hint: '', actionable: true,
    });
    expect(deriveLocalOlderPresentation({ totalUnits: 80, revealStart: 0, localStartKnown: true })).toEqual({
      state: 'localStartReached', revealStart: 0, localOlderCount: 0,
      label: 'Start of loaded history', hint: '', actionable: false,
    });
    const unknown = deriveLocalOlderPresentation({ totalUnits: 80, revealStart: 0, localStartKnown: false });
    expect(unknown).toEqual({
      state: 'remoteOlderUnknown', revealStart: 0, localOlderCount: 0,
      label: 'No more loaded messages',
      hint: 'Earlier server history is unknown or unavailable until cursor support is available.',
      actionable: false,
    });
    expect(`${unknown.label} ${unknown.hint}`).not.toMatch(/server has no|start of (all|server) history/i);
  });

  test('reveals 1001 canonical units in accepted 40-unit batches with a final partial batch', () => {
    const canonical = keys(1001);
    const before = [...canonical];
    const controller = createLocalHistoryPresentationController({ initialTailCount: 80, batchSize: 40 });
    expect(controller.resolve('a', canonical).visibleKeys).toHaveLength(80);
    const accepted: number[] = [];
    while (controller.resolve('a', canonical).presentation.actionable) {
      const result = controller.activate('a', canonical);
      expect(result.accepted).toBe(true);
      accepted.push(result.revealedCount);
      controller.complete('a');
    }
    expect(accepted.slice(0, -1).every((count) => count === 40)).toBe(true);
    expect(accepted.at(-1)).toBe(1);
    expect(controller.resolve('a', canonical)).toMatchObject({
      revealStart: 0, visibleKeys: canonical,
      presentation: { state: 'remoteOlderUnknown', actionable: false },
    });
    expect(canonical).toEqual(before);
  });

  test('dedupes click/intersection/in-flight triggers and leaves activation independent of observer support', () => {
    const controller = createLocalHistoryPresentationController({ initialTailCount: 80, batchSize: 40 });
    const canonical = keys(200);
    expect(controller.activate('a', canonical, 'click')).toMatchObject({ accepted: true, revealedCount: 40 });
    expect(controller.activate('a', canonical, 'intersection')).toMatchObject({ accepted: false, reason: 'in-flight' });
    expect(controller.resolve('a', canonical).visibleKeys).toHaveLength(120);
    controller.complete('a');
    expect(controller.activate('a', canonical, 'button-without-observer')).toMatchObject({ accepted: true, revealedCount: 40 });
  });

  test('search reveals any local key in one action and session boundaries restore without leakage', () => {
    const controller = createLocalHistoryPresentationController({ initialTailCount: 80, batchSize: 40 });
    const a = keys(1001, 'a');
    const b = keys(300, 'b');
    expect(controller.revealToKey('a', a, 'a-10')).toBe(true);
    expect(controller.resolve('a', a)).toMatchObject({ revealStart: 10 });
    expect(controller.resolve('a', a).visibleKeys[0]).toBe('a-10');
    expect(controller.resolve('b', b)).toMatchObject({ revealStart: 220 });
    expect(controller.revealToKey('b', b, 'b-100')).toBe(true);
    expect(controller.resolve('a', a)).toMatchObject({ revealStart: 10 });
    expect(controller.revealToKey('a', a, 'missing')).toBe(false);
  });

  test('bounds the presentation-only session cache with deterministic inactive LRU eviction', () => {
    const controller = createLocalHistoryPresentationController({ initialTailCount: 80, batchSize: 40, maxSessions: 3 });
    const canonical = keys(200);
    controller.resolve('oldest', canonical);
    controller.activate('oldest', canonical, 'click');
    controller.complete('oldest');
    expect(controller.resolve('oldest', canonical).visibleKeys).toHaveLength(120);
    controller.resolve('middle', canonical);
    controller.resolve('recent', canonical);
    controller.resolve('middle', canonical); // refresh LRU order
    controller.resolve('newest', canonical);
    expect(controller.getPresentationCacheSize()).toBe(3);
    expect(controller.resolve('oldest', canonical).visibleKeys).toHaveLength(80); // evicted, safely defaults
    expect(controller.getPresentationCacheSize()).toBe(3);
  });

  test('does not evict an in-flight presentation entry during another session operation', () => {
    const controller = createLocalHistoryPresentationController({ initialTailCount: 80, batchSize: 40, maxSessions: 1 });
    const canonical = keys(200);
    controller.activate('active', canonical, 'click');
    controller.resolve('other', canonical);
    expect(controller.resolve('active', canonical).visibleKeys).toHaveLength(120);
    controller.complete('active');
    expect(controller.getPresentationCacheSize()).toBe(1);
  });
});
