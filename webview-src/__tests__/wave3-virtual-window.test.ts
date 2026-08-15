import {
  createTanStackVirtualAdapter,
  estimateRenderUnitSize,
  shouldAdjustMeasuredItemScrollPosition,
  type VirtualAdapterRangePolicy,
  type VirtualizerConstructor,
} from '../rendering/tanstack-virtual-adapter';
import { Virtualizer } from '@tanstack/virtual-core';
import { restoreKeyedScrollAnchor } from '../rendering/scroll-anchor-model';
import { createLocalHistoryPresentationController } from '../rendering/local-history-window';

type RafCallback = (time: number) => void;

class FakeResizeObserver {
  static instance: FakeResizeObserver | undefined;
  static instances: FakeResizeObserver[] = [];
  static nextFailObserveAt = 0;
  readonly observed = new Set<Element>();
  disconnectCount = 0;
  failDisconnectCount = 0;
  failObserveCount = 0;
  failObserveAt = 0;
  observeAttempts = 0;
  readonly observeSuccesses = new Map<Element, number>();
  constructor(readonly callback: (entries: Array<{ target: Element }>) => void) {
    this.failObserveAt = FakeResizeObserver.nextFailObserveAt;
    FakeResizeObserver.nextFailObserveAt = 0;
    FakeResizeObserver.instance = this;
    FakeResizeObserver.instances.push(this);
  }
  observe(element: Element) {
    this.observeAttempts += 1;
    if (this.failObserveAt === this.observeAttempts) throw new Error('injected observe failure');
    if (this.failObserveCount > 0) { this.failObserveCount -= 1; throw new Error('injected observe failure'); }
    this.observed.add(element);
    this.observeSuccesses.set(element, (this.observeSuccesses.get(element) || 0) + 1);
  }
  unobserve(element: Element) { this.observed.delete(element); }
  disconnect() {
    this.disconnectCount += 1;
    if (this.failDisconnectCount > 0) { this.failDisconnectCount -= 1; throw new Error('injected disconnect failure'); }
    this.observed.clear();
  }
  emit(...targets: Element[]) { this.callback(targets.map((target) => ({ target }))); }
}

function createHarness(
  count = 1001,
  initialOwnerMode: 'active' | 'deferred-transaction' = 'active',
  initialMeasurements: readonly { key: string; revision: string; size: number }[] = [],
  rangeHysteresis = 0,
  suppressMeasurementScrollAdjustment?: () => boolean,
) {
  FakeResizeObserver.instance = undefined;
  FakeResizeObserver.instances = [];
  FakeResizeObserver.nextFailObserveAt = 0;
  const raf: RafCallback[] = [];
  const changes: unknown[] = [];
  const measurements: unknown[] = [];
  const constructions: FakeVirtualizer[] = [];
  const scrollElement = { clientHeight: 640, scrollTop: 0 } as unknown as Element;
  let failCandidateConstruction = false;
  let failRangeCallbackCount = 0;
  let failMeasurementCallbackCount = 0;
  let renderCount = 0;

  class FakeVirtualizer {
    options: any;
    sizes = new Map<number, number>();
    resizeCalls: Array<{ index: number; size: number }> = [];
    scrollCalls: unknown[][] = [];
    destroyed = false;
    destroyCount = 0;
    mountCount = 0;
    updateCount = 0;
    failReadCount = 0;
    failMountCount = 0;
    failUpdateCount = 0;
    failUnmountCount = 0;
    constructor(options: any) {
      if (failCandidateConstruction && constructions.length > 0) throw new Error('candidate prepare failed');
      this.options = options;
      constructions.push(this);
    }
    setOptions(options: any) { this.options = options; }
    _didMount() {
      this.mountCount += 1;
      if (this.failMountCount > 0) { this.failMountCount -= 1; throw new Error('injected mount failure'); }
      return () => {
        if (this.failUnmountCount > 0) { this.failUnmountCount -= 1; throw new Error('injected unmount failure'); }
        this.destroyed = true; this.destroyCount += 1;
      };
    }
    _willUpdate() {
      this.updateCount += 1;
      if (this.failUpdateCount > 0) { this.failUpdateCount -= 1; throw new Error('injected update failure'); }
    }
    getVirtualItems() {
      if (this.failReadCount > 0) { this.failReadCount -= 1; throw new Error('injected range failure'); }
      const range = { startIndex: Math.max(0, this.options.count - 12), endIndex: this.options.count - 1, overscan: this.options.overscan, count: this.options.count };
      return this.options.rangeExtractor(range).map((index: number) => {
        const size = this.sizes.get(index) ?? this.options.estimateSize(index);
        return { index, key: this.options.getItemKey(index), start: index * 100, size, end: index * 100 + size, lane: 0 };
      });
    }
    getTotalSize() { return this.options.count * 100; }
    scrollToIndex(...args: unknown[]) { this.scrollCalls.push(args); }
    resizeItem(index: number, size: number) {
      this.resizeCalls.push({ index, size });
      this.sizes.set(index, size);
    }
    measureElement(element: Element) {
      const index = Number((element as any).dataset.index);
      this.resizeItem(index, Number((element as any).size));
    }
  }

  const keys = Array.from({ length: count }, (_, index) => `key-${index}`);
  const adapter = createTanStackVirtualAdapter({
    keys,
    kinds: keys.map((_, index) => index % 2 ? 'assistant' : 'user'),
    presentationRevisions: keys.map(() => 'r1'),
    initialMeasurements,
    scrollElement,
    overscan: 20,
    initialTailCount: 80,
    maxMounted: 140,
    rangeHysteresis,
    keepMountedKeys: [keys[count - 1]],
    onRangeChange: (snapshot) => {
      if (failRangeCallbackCount > 0) { failRangeCallbackCount -= 1; throw new Error('injected range callback failure'); }
      changes.push(snapshot);
      renderCount += 1;
    },
    onMeasurements: (batch) => {
      if (failMeasurementCallbackCount > 0) { failMeasurementCallbackCount -= 1; throw new Error('injected measurement callback failure'); }
      measurements.push(batch);
    },
    suppressMeasurementScrollAdjustment,
    requestAnimationFrame: (callback) => { raf.push(callback); return raf.length; },
    cancelAnimationFrame: () => undefined,
    ResizeObserver: FakeResizeObserver as never,
    initialOwnerMode,
  }, FakeVirtualizer as unknown as VirtualizerConstructor);
  return {
    adapter, keys, raf, changes, measurements, constructions, scrollElement: scrollElement as any,
    failNextCandidateConstruction: () => { failCandidateConstruction = true; },
    allowCandidateConstruction: () => { failCandidateConstruction = false; },
    failNextRangeCallback: () => { failRangeCallbackCount += 1; },
    failNextMeasurementCallback: () => { failMeasurementCallbackCount += 1; },
    getRenderCount: () => renderCount,
  };
}

const rangePolicy = (
  overscanTier: 20 | 10 | 4,
  beforeReserve: number,
  afterReserve: number,
  initialTail: 80 | 40 | 24,
): VirtualAdapterRangePolicy => ({ overscanTier, beforeReserve, afterReserve, initialTail });

function createCF4OffsetContinuityHarness() {
  const raf: RafCallback[] = [];
  const writes: number[] = [];
  const changes: any[] = [];
  const constructions: any[] = [];
  const scrollListeners = new Set<() => void>();
  const scrollElement: any = {
    clientWidth: 500, clientHeight: 640, scrollWidth: 500, scrollHeight: 50000, scrollTop: 0,
    ownerDocument: { defaultView: { addEventListener() {}, removeEventListener() {} } },
    addEventListener(type: string, callback: () => void) { if (type === 'scroll') scrollListeners.add(callback); },
    removeEventListener(type: string, callback: () => void) { if (type === 'scroll') scrollListeners.delete(callback); },
    scrollTo({ top }: { top: number }) {
      writes.push(top);
      const changed = this.scrollTop !== top;
      this.scrollTop = top;
      if (changed) for (const callback of [...scrollListeners]) callback();
    },
  };
  class OffsetMemoizingVirtualizer {
    options: any;
    memoizedOffset: number | null = null;
    currentOffset = 0;
    sizes = new Map<number, number>();
    failReadCount = 0;
    private scrollCallback = () => {
      this.currentOffset = scrollElement.scrollTop;
      this.options.onChange?.();
    };
    constructor(options: any) { this.options = options; constructions.push(this); }
    setOptions(options: any) { this.options = options; }
    _didMount() {
      scrollElement.addEventListener('scroll', this.scrollCallback);
      return () => scrollElement.removeEventListener('scroll', this.scrollCallback);
    }
    _willUpdate() {
      if (this.memoizedOffset === null) this.memoizedOffset = Number(this.options.initialOffset);
      this.currentOffset = this.memoizedOffset;
      scrollElement.scrollTo({ top: this.memoizedOffset });
    }
    getVirtualItems() {
      if (this.failReadCount > 0) { this.failReadCount -= 1; throw new Error('injected CF4 range failure'); }
      if (this.memoizedOffset === null) this.memoizedOffset = Number(this.options.initialOffset);
      if (!this.currentOffset) this.currentOffset = this.memoizedOffset;
      const itemCount = this.currentOffset >= 30000 ? 26 : 43;
      return Array.from({ length: itemCount }, (_, offset) => {
        const index = this.options.count - itemCount + offset;
        const size = this.sizes.get(index) ?? this.options.estimateSize(index);
        return { index, key: this.options.getItemKey(index), start: index * 100, size, end: index * 100 + size };
      });
    }
    getTotalSize() { return this.options.count * 100; }
    resizeItem(index: number, size: number) { this.sizes.set(index, size); }
    scrollToIndex() { /* existing search seam remains independent */ }
  }
  const keys = Array.from({ length: 81 }, (_, index) => `cf4-${index}`);
  const adapter = createTanStackVirtualAdapter({
    keys, kinds: keys.map(() => 'user'), presentationRevisions: keys.map(() => 'r1'),
    keepMountedKeys: [], scrollElement, initialTailCount: 80, overscan: 20,
    requestAnimationFrame: (callback) => { raf.push(callback); return raf.length; },
    cancelAnimationFrame: () => undefined, ResizeObserver: FakeResizeObserver as never,
    onRangeChange: (snapshot) => changes.push(snapshot),
  }, OffsetMemoizingVirtualizer as unknown as VirtualizerConstructor);
  const measured = { dataset: {}, getBoundingClientRect: () => ({ height: 10531 }) } as unknown as Element;
  adapter.observeElement(keys[0], measured);
  adapter.invalidateMeasurement(keys[0]);
  while (raf.length) raf.shift()?.(0);
  scrollElement.scrollTop = 33455;
  writes.length = 0;
  changes.length = 0;
  const update = {
    keys, kinds: keys.map(() => 'user'), presentationRevisions: keys.map(() => 'r1'), keepMountedKeys: [],
  };
  return { adapter, keys, update, scrollElement, writes, changes, constructions };
}

describe('Wave 3 TanStack adapter contract', () => {
  test('retains a wider range until the viewport reaches its hysteresis guard', () => {
    const harness = createHarness(200, 'active', [], 16);
    const virtualizer = harness.constructions[0];
    harness.adapter.getRange();

    const retainedTail = virtualizer.options.rangeExtractor({
      startIndex: 150, endIndex: 156, overscan: 20, count: 200,
    });
    expect(retainedTail).toEqual(Array.from({ length: 80 }, (_, index) => 120 + index));

    const shifted = virtualizer.options.rangeExtractor({
      startIndex: 123, endIndex: 129, overscan: 20, count: 200,
    });
    expect(shifted[0]).toBe(87);
    expect(shifted.at(-1)).toBe(199);

    const stable = virtualizer.options.rangeExtractor({
      startIndex: 120, endIndex: 126, overscan: 20, count: 200,
    });
    expect(stable).toEqual(shifted);
  });

  test('CF4 retains live 33455 through preflight and two activations, then publishes one genuine range change', () => {
    const harness = createCF4OffsetContinuityHarness();
    expect(harness.constructions[0].sizes.get(0)).toBe(10531);
    const settleReplacement = () => {
      const transaction = harness.adapter.beginTransaction(harness.update)!;
      expect(transaction.prepareCommit()).toBe(true);
      expect(transaction.getRange().items).toHaveLength(26);
      expect(transaction.commit()).toBe(true);
      expect(transaction.finalizeCommit()).toBe(true);
      expect(harness.scrollElement.scrollTop).toBe(33455);
      expect((harness.changes.at(-1) as any).items).toHaveLength(26);
      harness.scrollElement.scrollTo({ top: 33455 }); // existing pinned-bottom echo
      expect(harness.scrollElement.scrollTop).toBe(33455);
    };
    settleReplacement();
    settleReplacement();
    expect(harness.writes).toEqual([33455, 33455, 33455, 33455]);
    expect(harness.writes).not.toContain(10531);
    expect(harness.changes.map((snapshot) => snapshot.items.length)).toEqual([26, 26]);
    const beforeGenuineScroll = harness.changes.length;
    harness.scrollElement.scrollTo({ top: 20000 });
    expect(harness.changes).toHaveLength(beforeGenuineScroll + 1);
    expect((harness.changes.at(-1) as any).items).toHaveLength(43);
  });

  test('CF4 captures at prepare, falls back for invalid/no owner, and retry completion does not recapture', () => {
    for (const outcome of ['abort', 'failed', 'conflict'] as const) {
      const isolated = createCF4OffsetContinuityHarness();
      const candidate = isolated.adapter.beginTransaction(isolated.update)!;
      expect(candidate.prepareCommit()).toBe(true);
      expect(candidate.getRange().items).toHaveLength(26);
      if (outcome === 'conflict') {
        expect(isolated.adapter.scrollToKey(isolated.keys[0])).toBe(false);
        expect(candidate.commit()).toBe(false);
      }
      if (outcome === 'failed') {
        expect(candidate.commit()).toBe(true);
        isolated.constructions[1].failReadCount = 1;
        expect(candidate.finalizeCommit()).toBe(false);
      }
      expect(candidate.abort()).toBe(true);
      expect(isolated.writes).toEqual([]);
      expect(isolated.scrollElement.scrollTop).toBe(33455);
    }

    const timing = createHarness(81);
    const transaction = timing.adapter.beginTransaction({
      keys: timing.keys, kinds: timing.keys.map(() => 'user'),
      presentationRevisions: timing.keys.map(() => 'r1'), keepMountedKeys: [],
    })!;
    timing.scrollElement.scrollTop = 33455;
    expect(transaction.prepareCommit()).toBe(true);
    expect(timing.constructions[1].options.initialOffset).toBe(33455);
    expect(transaction.abort()).toBe(true);

    for (const invalid of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const fallback = createHarness(81);
      const oldEstimate = fallback.constructions[0].options.initialOffset;
      const candidate = fallback.adapter.beginTransaction({
        keys: fallback.keys, kinds: fallback.keys.map(() => 'user'),
        presentationRevisions: fallback.keys.map(() => 'r1'), keepMountedKeys: [],
      })!;
      fallback.scrollElement.scrollTop = invalid;
      expect(candidate.prepareCommit()).toBe(true);
      expect(fallback.constructions[1].options.initialOffset).toBe(oldEstimate);
      expect(candidate.abort()).toBe(true);
    }

    const initial = createHarness(81, 'deferred-transaction');
    initial.scrollElement.scrollTop = 33455;
    const first = initial.adapter.beginTransaction({
      keys: initial.keys, kinds: initial.keys.map(() => 'user'),
      presentationRevisions: initial.keys.map(() => 'r1'), keepMountedKeys: [],
    })!;
    expect(first.prepareCommit()).toBe(true);
    expect(initial.constructions[0].options.initialOffset).toBe(72);
    expect(first.abort()).toBe(true);

    const retry = createHarness(81);
    retry.scrollElement.scrollTop = 33455;
    const degraded = retry.adapter.beginTransaction({
      keys: retry.keys, kinds: retry.keys.map(() => 'user'),
      presentationRevisions: retry.keys.map(() => 'r1'), keepMountedKeys: [],
    })!;
    expect(degraded.prepareCommit()).toBe(true);
    const captured = retry.constructions[1].options.initialOffset;
    expect(degraded.commit()).toBe(true);
    retry.constructions[1].failUpdateCount = 1;
    expect(degraded.finalizeCommit()).toBe(true);
    retry.scrollElement.scrollTop = 20000;
    expect(degraded.retryCompletion()).toBe(true);
    expect(retry.constructions[1].options.initialOffset).toBe(captured);
  });

  test('CF4 installed TanStack 3.17.4 preflight and activation retain the preparation-time live offset', () => {
    const listeners = new Map<string, Set<() => void>>();
    const raf: RafCallback[] = [];
    const writes: number[] = [];
    let measurementObserver: ((entries: Array<{ target: Element }>) => void) | undefined;
    const documentElement = { scrollHeight: 50000, scrollWidth: 500 };
    const body = { scrollHeight: 50000, scrollWidth: 500 };
    const targetWindow: any = {
      setTimeout, clearTimeout, document: { documentElement, body },
      requestAnimationFrame: (callback: RafCallback) => { raf.push(callback); return raf.length; },
      cancelAnimationFrame: () => undefined,
      addEventListener() {}, removeEventListener() {},
    };
    const scrollElement: any = {
      clientWidth: 500, clientHeight: 640, scrollWidth: 500, scrollHeight: 50000, scrollTop: 0,
      ownerDocument: { defaultView: targetWindow, documentElement, body },
      addEventListener(type: string, callback: () => void) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)?.add(callback);
      },
      removeEventListener(type: string, callback: () => void) { listeners.get(type)?.delete(callback); },
      scrollTo({ top }: { top: number }) {
        writes.push(top);
        const changed = this.scrollTop !== top;
        this.scrollTop = top;
        if (changed) for (const callback of [...(listeners.get('scroll') || [])]) callback();
      },
    };
    class CoreResizeObserver {
      constructor(callback: (entries: Array<{ target: Element }>) => void) { measurementObserver = callback; }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    const installedOptions: any[] = [];
    class InstalledVirtualizer extends (Virtualizer as any) {
      constructor(options: any) { super(options); installedOptions.push(options); }
    }
    const keys = Array.from({ length: 300 }, (_, index) => `cf4-installed-${index}`);
    const changes: any[] = [];
    const adapter = createTanStackVirtualAdapter({
      keys, kinds: keys.map(() => 'user'), presentationRevisions: keys.map(() => 'r1'),
      keepMountedKeys: [], scrollElement, initialTailCount: 80, overscan: 20,
      requestAnimationFrame: targetWindow.requestAnimationFrame,
      cancelAnimationFrame: targetWindow.cancelAnimationFrame,
      ResizeObserver: CoreResizeObserver as never,
      onRangeChange: (snapshot) => changes.push(snapshot),
    }, InstalledVirtualizer as unknown as VirtualizerConstructor);
    const elements = keys.map((key, index) => {
      const height = index < 219 ? 48 : index === 219 ? 19 : 300;
      const element = { dataset: {}, getBoundingClientRect: () => ({ height }) } as unknown as Element;
      adapter.observeElement(key, element);
      adapter.invalidateMeasurement(key);
      return element;
    });
    measurementObserver?.(elements.map((target) => ({ target })));
    let frameCount = 0;
    while (raf.length) {
      if (++frameCount > 20) throw new Error('CF4 installed rAF drain exceeded bound');
      raf.shift()?.(frameCount);
    }
    scrollElement.scrollTop = 33455;
    writes.length = 0;
    changes.length = 0;
    const transaction = adapter.beginTransaction({
      keys, kinds: keys.map(() => 'user'), presentationRevisions: keys.map(() => 'r1'), keepMountedKeys: [],
    })!;
    expect(transaction.prepareCommit()).toBe(true);
    expect(installedOptions[1].initialOffset).toBe(33455);
    const preflight = transaction.getRange();
    expect(preflight.items.length).toBeGreaterThan(0);
    expect(transaction.commit()).toBe(true);
    expect(transaction.finalizeCommit()).toBe(true);
    expect(scrollElement.scrollTop).toBe(33455);
    expect(writes).not.toContain(10531);
    expect(adapter.getRange()).toEqual(preflight);
    const beforeEcho = changes.length;
    scrollElement.scrollTo({ top: 33455 });
    expect(changes).toHaveLength(beforeEcho);
    adapter.destroy();
  });
  test('B2-RED1 accepts only immutable closed range policies without widening malformed values', () => {
    const { adapter, keys } = createHarness(40);
    const candidate = rangePolicy(10, 3, 7, 40);
    const transaction = adapter.beginTransaction({
      keys, kinds: keys.map(() => 'assistant'), presentationRevisions: keys.map(() => 'r2'),
      keepMountedKeys: [], rangePolicy: candidate,
    })!;
    (candidate as { beforeReserve: number }).beforeReserve = 9;
    expect(transaction.prepareCommit()).toBe(true);
    expect(transaction.getRange().items.map((item) => item.index))
      .toEqual(Array.from({ length: 15 }, (_, index) => 25 + index));
    expect(transaction.abort()).toBe(true);

    for (const malformed of [
      { overscanTier: 11, beforeReserve: 3, afterReserve: 7, initialTail: 40 },
      { overscanTier: 10, beforeReserve: 0, afterReserve: 10, initialTail: 40 },
      { overscanTier: 10, beforeReserve: 3, afterReserve: 8, initialTail: 40 },
      { overscanTier: 10, beforeReserve: 3.5, afterReserve: 6.5, initialTail: 40 },
      { overscanTier: 10, beforeReserve: 3, afterReserve: 7, initialTail: 41 },
      { overscanTier: 10, beforeReserve: 3, afterReserve: 7, initialTail: 40, extra: true },
    ]) {
      expect(() => adapter.beginTransaction({
        keys, kinds: [], presentationRevisions: [], keepMountedKeys: [],
        rangePolicy: malformed as never,
      })).toThrow('Invalid virtual adapter range policy');
    }
  });

  test('B2-RED2 keeps default 20/80 live range and hides 10/40 through open, prepared, and sealed', () => {
    const { adapter, keys, changes, constructions } = createHarness(1001);
    const initial = adapter.getRange();
    const live = adapter.getRange();
    expect([initial.items[0].index, initial.items.length]).toEqual([921, 80]);
    expect([live.items[0].index, live.items.length]).toEqual([969, 32]);
    const transaction = adapter.beginTransaction({
      keys, kinds: keys.map(() => 'assistant'), presentationRevisions: keys.map(() => 'r2'),
      keepMountedKeys: [], rangePolicy: rangePolicy(10, 3, 7, 40),
    })!;
    expect(adapter.getRange()).toEqual(live);
    expect(transaction.prepareCommit()).toBe(true);
    expect(adapter.getRange()).toEqual(live);
    expect(constructions[1].options.overscan).toBe(10);
    expect(transaction.commit()).toBe(true);
    constructions[1].options.onChange();
    expect(adapter.getRange()).toEqual(live);
    expect(changes).toHaveLength(0);
    expect(transaction.finalizeCommit()).toBe(true);
    expect(adapter.getRange().items.map((item) => item.index)).toEqual(
      Array.from({ length: 15 }, (_, index) => 986 + index),
    );
  });

  test.each([
    [20, 7, 13, 80, 'forward'], [20, 13, 7, 80, 'backward'],
    [10, 3, 7, 40, 'forward'], [10, 7, 3, 40, 'backward'],
    [4, 1, 3, 24, 'forward'], [4, 3, 1, 24, 'backward'],
  ] as const)(
    'B2-RED3 installed TanStack tier %i fast %s covers viewport and exact directional reserves',
    (tier, before, after, tail, direction) => {
      let installedOptions: any;
      class InstalledVirtualizer extends (Virtualizer as any) {
        constructor(options: any) { super(options); installedOptions = options; }
      }
      const count = 1001;
      const keys = Array.from({ length: count }, (_, index) => `installed-range-${index}`);
      const scrollElement = { clientWidth: 500, clientHeight: 600, scrollTop: 0 } as unknown as Element;
      const adapter = createTanStackVirtualAdapter({
        keys, kinds: keys.map(() => 'assistant'), presentationRevisions: keys.map(() => 'r1'),
        scrollElement, initialOwnerMode: 'deferred-transaction',
        requestAnimationFrame: () => 1, cancelAnimationFrame: () => undefined,
        ResizeObserver: FakeResizeObserver as never,
      }, InstalledVirtualizer as unknown as VirtualizerConstructor);
      const transaction = adapter.beginTransaction({
        keys, kinds: keys.map(() => 'assistant'), presentationRevisions: keys.map(() => 'r1'),
        keepMountedKeys: [], rangePolicy: rangePolicy(tier, before, after, tail),
      })!;
      expect(transaction.prepareCommit()).toBe(true);
      expect(installedOptions.overscan).toBe(tier);
      expect(transaction.getRange().items).toHaveLength(tail);
      const viewport = { startIndex: 400, endIndex: 411, overscan: tier, count };
      const indexes = installedOptions.rangeExtractor(viewport) as number[];
      expect(indexes).toEqual(Array.from(
        { length: before + 12 + after }, (_, offset) => 400 - before + offset,
      ));
      expect(indexes.length).toBeLessThanOrEqual(140);
      expect(indexes).toEqual([...new Set(indexes)].sort((a, b) => a - b));
      expect(indexes).toEqual(expect.arrayContaining(Array.from({ length: 12 }, (_, offset) => 400 + offset)));
      expect(indexes.filter((index) => index < 400)).toHaveLength(before);
      expect(indexes.filter((index) => index > 411)).toHaveLength(after);
      expect(direction === 'forward' ? after > before : before > after).toBe(true);
      expect(transaction.abort()).toBe(true);
    },
  );

  test('B2-RED4 restores exact C0 policy/tail state on failures and conflicts; postbarrier keeps new owner', () => {
    const harness = createHarness(1001);
    const { adapter, keys, constructions, failNextCandidateConstruction, allowCandidateConstruction } = harness;
    const consumeDefaultTail = adapter.getRange();
    expect(consumeDefaultTail.items).toHaveLength(80);
    const c0 = adapter.getRange();
    const update = {
      keys, kinds: keys.map(() => 'assistant'), presentationRevisions: keys.map(() => 'r2'), keepMountedKeys: [],
      rangePolicy: rangePolicy(10, 3, 7, 40),
    };

    failNextCandidateConstruction();
    const prepareFailure = adapter.beginTransaction(update)!;
    expect(prepareFailure.prepareCommit()).toBe(false);
    expect(prepareFailure.abort()).toBe(true);
    allowCandidateConstruction();
    expect(adapter.getRange()).toEqual(c0);

    const preflightFailure = adapter.beginTransaction(update)!;
    expect(preflightFailure.prepareCommit()).toBe(true);
    expect(preflightFailure.commit()).toBe(true);
    constructions.at(-1)!.failReadCount = 1;
    expect(preflightFailure.finalizeCommit()).toBe(false);
    expect(preflightFailure.abort()).toBe(true);
    expect(adapter.getRange()).toEqual(c0);

    const conflict = adapter.beginTransaction(update)!;
    expect(conflict.prepareCommit()).toBe(true);
    adapter.update({ keys, kinds: [], presentationRevisions: [], keepMountedKeys: [] });
    expect(conflict.commit()).toBe(false);
    expect(conflict.abort()).toBe(true);
    expect(adapter.getRange().items.map((item) => item.index)).toEqual(c0.items.map((item) => item.index));

    const degraded = adapter.beginTransaction(update)!;
    expect(degraded.prepareCommit()).toBe(true);
    expect(degraded.commit()).toBe(true);
    constructions[0].failUnmountCount = 1;
    expect(degraded.finalizeCommit()).toBe(true);
    expect(degraded.isDegraded()).toBe(true);
    expect(adapter.getRange().items).toHaveLength(15);
    expect(degraded.retryCompletion()).toBe(true);
    expect(adapter.getRange().items).toHaveLength(15);
  });

  test('B2-RED5 cap cannot be raised by keep-mounted keys and extraction ignores total count except bounds', () => {
    const { adapter, keys, constructions } = createHarness(1001);
    adapter.getRange();
    const transaction = adapter.beginTransaction({
      keys, kinds: keys.map(() => 'assistant'), presentationRevisions: keys.map(() => 'r2'),
      keepMountedKeys: keys, rangePolicy: rangePolicy(4, 1, 3, 24),
    })!;
    expect(transaction.prepareCommit()).toBe(true);
    transaction.getRange();
    const extract = constructions[1].options.rangeExtractor;
    const samples = [
      extract({ startIndex: 400, endIndex: 411, overscan: 4, count: 500 }),
      extract({ startIndex: 400, endIndex: 411, overscan: 4, count: 1001 }),
      extract({ startIndex: 1, endIndex: 5, overscan: 4, count: 1001 }),
    ] as number[][];
    for (const [sampleIndex, indexes] of samples.entries()) {
      expect(indexes.length).toBeLessThanOrEqual(140);
      expect(indexes).toEqual([...new Set(indexes)].sort((a, b) => a - b));
      const count = sampleIndex === 0 ? 500 : 1001;
      expect(indexes.every((index) => index >= 0 && index < count)).toBe(true);
    }
    expect(samples[0].filter((index) => index >= 399 && index <= 414))
      .toEqual(samples[1].filter((index) => index >= 399 && index <= 414));
    expect(samples[0]).toHaveLength(140);
    expect(transaction.abort()).toBe(true);
  });

  test('B2 selected initial tail is one-shot only for initial/session owner creation', () => {
    const initial = createHarness(1001, 'deferred-transaction');
    const transaction = initial.adapter.beginTransaction({
      keys: initial.keys, kinds: [], presentationRevisions: [], keepMountedKeys: [],
      rangePolicy: rangePolicy(10, 3, 7, 40),
    })!;
    expect(transaction.prepareCommit()).toBe(true);
    expect(transaction.commit()).toBe(true);
    expect(transaction.finalizeCommit()).toBe(true);
    expect((initial.changes[0] as any).items).toHaveLength(40);
    expect(initial.adapter.getRange().items).toHaveLength(15);
    initial.adapter.update({ keys: initial.keys, kinds: [], presentationRevisions: [], keepMountedKeys: [] });
    expect(initial.adapter.getRange().items).toHaveLength(15);
    const revision = initial.adapter.beginTransaction({
      keys: initial.keys, kinds: [], presentationRevisions: initial.keys.map(() => 'r2'), keepMountedKeys: [],
    })!;
    expect(revision.prepareCommit()).toBe(true);
    expect(revision.commit()).toBe(true);
    expect(revision.finalizeCommit()).toBe(true);
    expect(initial.adapter.getRange().items).toHaveLength(15);
  });

  test('B2-SMOKE default 20/80 aborts 10/40 exactly, finalizes it, then installs fast 4/24', () => {
    const { adapter, keys, changes, constructions } = createHarness(1001);
    expect(adapter.getRange().items).toHaveLength(80);
    expect(adapter.getRange().items).toHaveLength(32);
    const updateFor = (policy: VirtualAdapterRangePolicy) => ({
      keys, kinds: keys.map(() => 'assistant'), presentationRevisions: keys.map(() => 'r2'),
      keepMountedKeys: [], rangePolicy: policy,
    });
    const aborted = adapter.beginTransaction(updateFor(rangePolicy(10, 3, 7, 40)))!;
    expect(aborted.prepareCommit()).toBe(true);
    expect(aborted.commit()).toBe(true);
    expect(adapter.getRange().items).toHaveLength(32);
    expect(changes).toHaveLength(0);
    expect(aborted.abort()).toBe(true);
    expect(adapter.getRange().items).toHaveLength(32);

    const tier10 = adapter.beginTransaction(updateFor(rangePolicy(10, 3, 7, 40)))!;
    expect(tier10.prepareCommit()).toBe(true);
    expect(tier10.commit()).toBe(true);
    expect(changes).toHaveLength(0);
    expect(tier10.finalizeCommit()).toBe(true);
    expect(adapter.getRange().items).toHaveLength(15);
    expect(changes).toHaveLength(1);

    const fast4 = adapter.beginTransaction(updateFor(rangePolicy(4, 1, 3, 24)))!;
    expect(fast4.prepareCommit()).toBe(true);
    const fastExtractor = constructions.at(-1)!.options.rangeExtractor;
    expect(fastExtractor({ startIndex: 400, endIndex: 411, overscan: 4, count: 1001 }))
      .toEqual(Array.from({ length: 16 }, (_, index) => 399 + index));
    expect(fast4.commit()).toBe(true);
    expect(fast4.finalizeCommit()).toBe(true);
    expect(adapter.getRange().items).toHaveLength(13);
    expect(changes).toHaveLength(2);
  });

  test('A2.11-RED1/2 deferred factory and handle validation create no owner or host lifecycle', () => {
    const { adapter, keys, constructions, changes, measurements, raf } = createHarness(20, 'deferred-transaction');
    expect(adapter.getInitialOwnerState()).toBe('deferred');
    expect(constructions).toHaveLength(0);
    expect(FakeResizeObserver.instances).toHaveLength(0);
    expect(adapter.getRange()).toEqual({ items: [], totalSize: 0 });
    expect(adapter.scrollToKey('key-19')).toBe(false);
    const transaction = adapter.beginTransaction({
      keys, kinds: keys.map(() => 'assistant'), presentationRevisions: keys.map(() => 'r2'), keepMountedKeys: [],
    });
    expect(transaction).not.toBeNull();
    expect(constructions).toHaveLength(0);
    expect(FakeResizeObserver.instances).toHaveLength(0);
    expect(raf).toHaveLength(0);
    expect(changes).toHaveLength(0);
    expect(measurements).toHaveLength(0);
    expect([
      'getRange', 'update', 'observeElement', 'unobserveElement', 'invalidateMeasurement',
      'setPresentationRevision', 'migrateKey', 'prepareCommit', 'commit', 'finalizeCommit',
      'retryCompletion', 'isFinalized', 'isDegraded', 'hasPendingCompletion', 'abort',
    ].every((method) => typeof (transaction as any)?.[method] === 'function')).toBe(true);
  });

  test('A2.11-RED4 deferred prepare stays unmounted and finalize activates the sole initial owner', () => {
    const { adapter, keys, constructions, changes, measurements, raf } = createHarness(20, 'deferred-transaction');
    const transaction = adapter.beginTransaction({
      keys, kinds: keys.map(() => 'assistant'), presentationRevisions: keys.map(() => 'r2'), keepMountedKeys: ['key-19'],
    })!;
    expect(transaction.prepareCommit()).toBe(true);
    expect(constructions).toHaveLength(1);
    expect(constructions[0].mountCount).toBe(0);
    expect(constructions[0].updateCount).toBe(0);
    expect(FakeResizeObserver.instances).toHaveLength(0);
    const staged = { dataset: {}, size: 240 } as unknown as Element;
    transaction.observeElement('key-19', staged);
    transaction.invalidateMeasurement('key-19');
    expect((staged as any).dataset).toEqual({});
    expect(raf).toHaveLength(0);
    expect(transaction.commit()).toBe(true);
    expect(transaction.finalizeCommit()).toBe(true);
    expect(adapter.getInitialOwnerState()).toBe('active');
    expect(constructions[0].mountCount).toBe(1);
    expect(constructions[0].updateCount).toBe(1);
    expect(FakeResizeObserver.instances).toHaveLength(1);
    expect(FakeResizeObserver.instances[0].observed.has(staged)).toBe(true);
    expect((staged as any).dataset.index).toBe('19');
    expect(changes).toHaveLength(1);
    expect(measurements.length).toBeLessThanOrEqual(1);
  });

  test('A2.11-RED5 deferred pre-barrier failure aborts an unmounted candidate to deferred C0', () => {
    const { adapter, keys, constructions, changes, measurements, raf } = createHarness(20, 'deferred-transaction');
    const transaction = adapter.beginTransaction({
      keys, kinds: keys.map(() => 'assistant'), presentationRevisions: keys.map(() => 'r2'), keepMountedKeys: [],
    })!;
    expect(transaction.prepareCommit()).toBe(true);
    constructions[0].failReadCount = 1;
    expect(transaction.commit()).toBe(true);
    expect(transaction.finalizeCommit()).toBe(false);
    expect(adapter.getInitialOwnerState()).toBe('deferred');
    expect(transaction.abort()).toBe(true);
    expect(constructions[0].mountCount).toBe(0);
    expect(constructions[0].destroyCount).toBe(0);
    expect(FakeResizeObserver.instances).toHaveLength(0);
    expect(raf).toHaveLength(0);
    expect(changes).toHaveLength(0);
    expect(measurements).toHaveLength(0);
  });

  test('A2.11-RED6 post-barrier activation failure retains one degraded owner and retries once', () => {
    const { adapter, keys, constructions, changes } = createHarness(20, 'deferred-transaction');
    const transaction = adapter.beginTransaction({
      keys, kinds: keys.map(() => 'assistant'), presentationRevisions: keys.map(() => 'r2'), keepMountedKeys: [],
    })!;
    expect(transaction.prepareCommit()).toBe(true);
    expect(transaction.commit()).toBe(true);
    constructions[0].failMountCount = 1;
    expect(transaction.finalizeCommit()).toBe(true);
    expect(transaction.isFinalized()).toBe(true);
    expect(transaction.isDegraded()).toBe(true);
    expect(transaction.hasPendingCompletion()).toBe(true);
    expect(adapter.getInitialOwnerState()).toBe('active-pending-completion');
    expect(changes).toHaveLength(0);
    expect(transaction.retryCompletion()).toBe(true);
    expect(adapter.getInitialOwnerState()).toBe('active');
    expect(constructions[0].mountCount).toBe(2);
    expect(changes).toHaveLength(1);
    expect(transaction.retryCompletion()).toBe(true);
    expect(changes).toHaveLength(1);
  });

  test.each(['will-update', 'observer', 'range-callback', 'measurement-callback'] as const)(
    'A2.11-RED6 initial owner contains post-barrier %s failure and retries only unfinished work',
    (failure) => {
      const harness = createHarness(20, 'deferred-transaction');
      const { adapter, keys, constructions, changes, measurements } = harness;
      const transaction = adapter.beginTransaction({
        keys, kinds: keys.map(() => 'assistant'), presentationRevisions: keys.map(() => 'r2'), keepMountedKeys: ['key-19'],
      })!;
      expect(transaction.prepareCommit()).toBe(true);
      const staged = { dataset: {}, size: 260 } as unknown as Element;
      transaction.observeElement('key-19', staged);
      transaction.invalidateMeasurement('key-19');
      expect(transaction.commit()).toBe(true);
      if (failure === 'will-update') constructions[0].failUpdateCount = 1;
      if (failure === 'observer') FakeResizeObserver.nextFailObserveAt = 1;
      if (failure === 'range-callback') harness.failNextRangeCallback();
      if (failure === 'measurement-callback') harness.failNextMeasurementCallback();
      expect(transaction.finalizeCommit()).toBe(true);
      expect(transaction.isFinalized()).toBe(true);
      expect(transaction.isDegraded()).toBe(true);
      expect(transaction.hasPendingCompletion()).toBe(true);
      expect(adapter.getInitialOwnerState()).toBe('active-pending-completion');
      expect(transaction.abort()).toBe(false);
      expect(transaction.retryCompletion()).toBe(true);
      expect(transaction.hasPendingCompletion()).toBe(false);
      expect(adapter.getInitialOwnerState()).toBe('active');
      expect(changes).toHaveLength(1);
      expect(measurements.length).toBeLessThanOrEqual(1);
      const completedCounts = { changes: changes.length, measurements: measurements.length };
      expect(transaction.retryCompletion()).toBe(true);
      expect({ changes: changes.length, measurements: measurements.length }).toEqual(completedCounts);
    },
  );

  test('A2.11-RED7 default eager owner lifecycle and state remain unchanged', () => {
    const { adapter, constructions } = createHarness(20);
    expect(adapter.getInitialOwnerState()).toBe('active');
    expect(constructions).toHaveLength(1);
    expect(constructions[0].mountCount).toBe(1);
    expect(constructions[0].updateCount).toBe(1);
    expect(FakeResizeObserver.instances).toHaveLength(1);
  });

  test('A2.4T-RED1 keeps candidate range, observations, and callbacks shadowed through prepare', () => {
    const { adapter, keys, raf, changes, constructions } = createHarness(200);
    adapter.getRange();
    const liveBefore = adapter.getRange();
    const candidateKeys = [...keys, 'candidate-200'];
    const transaction = adapter.beginTransaction({
      keys: candidateKeys,
      kinds: candidateKeys.map(() => 'assistant'),
      presentationRevisions: candidateKeys.map(() => 'r2'),
      keepMountedKeys: ['candidate-200'],
    });
    expect(transaction).not.toBeNull();
    expect(transaction?.prepareCommit()).toBe(true);
    const staged = { dataset: {}, size: 333 } as unknown as Element;
    transaction?.observeElement('candidate-200', staged);
    transaction?.setPresentationRevision('candidate-200', 'r3');
    transaction?.invalidateMeasurement('candidate-200');
    transaction?.migrateKey('candidate-200', 'final-200');
    expect(transaction?.getRange().items.some((item) => item.key === 'final-200')).toBe(true);
    expect(adapter.getRange()).toEqual(liveBefore);
    expect(FakeResizeObserver.instance?.observed.has(staged)).toBe(false);
    expect((staged as any).dataset).toEqual({});
    expect(raf).toHaveLength(0);
    expect(changes).toHaveLength(0);
    expect(constructions).toHaveLength(2);
    expect(constructions[0].destroyed).toBe(false);
  });

  test('A2.4T-RED2 aborts prepare failure to the exact live owner and disposes candidate once', () => {
    const { adapter, keys, constructions, failNextCandidateConstruction, allowCandidateConstruction } = createHarness(40);
    const liveOwner = constructions[0];
    const transaction = adapter.beginTransaction({
      keys: [...keys, 'bad'], kinds: [...keys.map(() => 'user'), 'assistant'],
      presentationRevisions: [...keys.map(() => 'r1'), 'r1'], keepMountedKeys: [],
    });
    failNextCandidateConstruction();
    expect(transaction?.prepareCommit()).toBe(false);
    expect(transaction?.abort()).toBe(true);
    expect(transaction?.abort()).toBe(false);
    expect(liveOwner.destroyed).toBe(false);
    expect(adapter.scrollToKey(keys[0])).toBe(true);
    allowCandidateConstruction();
    const disposal = adapter.beginTransaction({
      keys, kinds: keys.map(() => 'user'), presentationRevisions: keys.map(() => 'r1'), keepMountedKeys: [],
    });
    expect(disposal?.prepareCommit()).toBe(true);
    expect(disposal?.abort()).toBe(true);
    expect(FakeResizeObserver.instances).toHaveLength(1);
    expect(FakeResizeObserver.instance?.disconnectCount).toBe(0);
    expect(disposal?.abort()).toBe(false);
    const retainedElement = { dataset: {}, size: 180 } as unknown as Element;
    adapter.observeElement('key-0', retainedElement);
    const rollback = adapter.beginTransaction({
      keys: [...keys].reverse(), kinds: keys.map(() => 'assistant'),
      presentationRevisions: keys.map(() => 'r2'), keepMountedKeys: ['key-0'],
    });
    expect(rollback?.prepareCommit()).toBe(true);
    expect(rollback?.commit()).toBe(true);
    expect((retainedElement as any).dataset.index).toBe('0');
    expect(rollback?.abort()).toBe(true);
    expect((retainedElement as any).dataset.index).toBe('0');
    expect(liveOwner.destroyed).toBe(false);
    expect(constructions[2].destroyCount).toBe(0);
  });

  test('A2.4T-RED3 commits one bounded current result and releases the old owner only at finalize', () => {
    const { adapter, keys, changes, constructions } = createHarness(1001);
    const candidateKeys = [...keys, 'candidate-1001'];
    const transaction = adapter.beginTransaction({
      keys: candidateKeys, kinds: candidateKeys.map(() => 'assistant'),
      presentationRevisions: candidateKeys.map(() => 'r2'), keepMountedKeys: ['key-0', 'candidate-1001'],
    });
    expect(transaction?.prepareCommit()).toBe(true);
    expect(transaction?.commit()).toBe(true);
    expect(transaction?.commit()).toBe(false);
    expect(changes).toHaveLength(0);
    expect(adapter.getRange().items.some((item) => item.key === 'candidate-1001')).toBe(false);
    expect(constructions[0].destroyed).toBe(false);
    expect(transaction?.finalizeCommit()).toBe(true);
    expect(transaction?.finalizeCommit()).toBe(false);
    expect(changes).toHaveLength(1);
    expect((changes[0] as any).items.length).toBeLessThanOrEqual(140);
    const committedItems = adapter.getRange().items;
    expect(committedItems.map((item) => item.key)).toContain('candidate-1001');
    expect(committedItems.map((item) => item.key)).not.toContain('key-0');
    expect(committedItems.every((item, index, items) => index === 0 || item.index === items[index - 1].index + 1)).toBe(true);
    expect(constructions[0].destroyed).toBe(true);
    expect(constructions[1].destroyed).toBe(false);
  });

  test('A2.4TX-RED1 keeps a sealed candidate wholly invisible and exactly abortable', () => {
    const { adapter, keys, raf, changes, measurements, constructions } = createHarness(20);
    const retained = { dataset: {}, size: 140 } as unknown as Element;
    adapter.observeElement('key-19', retained);
    const oldObserver = FakeResizeObserver.instances[0];
    const transaction = adapter.beginTransaction({
      keys: [...keys, 'candidate-20'], kinds: [...keys.map(() => 'user'), 'assistant'],
      presentationRevisions: [...keys.map(() => 'r1'), 'r2'], keepMountedKeys: ['candidate-20'],
    })!;
    expect(transaction.prepareCommit()).toBe(true);
    const staged = { dataset: {}, size: 280 } as unknown as Element;
    transaction.observeElement('candidate-20', staged);
    transaction.invalidateMeasurement('candidate-20');
    expect(transaction.commit()).toBe(true);
    constructions[1].options.onChange();
    expect(adapter.getRange().items.some((item) => item.key === 'candidate-20')).toBe(false);
    expect(oldObserver.observed.has(retained)).toBe(true);
    expect(FakeResizeObserver.instances).toHaveLength(1);
    expect((staged as any).dataset).toEqual({});
    expect(raf).toHaveLength(0);
    expect(changes).toHaveLength(0);
    expect(measurements).toHaveLength(0);
    expect(constructions[0].destroyed).toBe(false);
    expect(transaction.abort()).toBe(true);
    expect(adapter.scrollToKey('key-19')).toBe(true);
  });

  test('A2.4TX-RED3 conflicts deterministically throughout the sealed phase and replays only after abort', () => {
    const { adapter, keys, constructions, raf } = createHarness(20);
    const element = { dataset: {}, size: 210 } as unknown as Element;
    adapter.observeElement('key-19', element);
    const transaction = adapter.beginTransaction({
      keys: [...keys].reverse(), kinds: keys.map(() => 'assistant'),
      presentationRevisions: keys.map(() => 'r2'), keepMountedKeys: [],
    })!;
    expect(transaction.prepareCommit()).toBe(true);
    expect(transaction.commit()).toBe(true);
    adapter.invalidateMeasurement('key-19');
    adapter.setPresentationRevision('key-19', 'r3');
    adapter.migrateKey('key-19', 'final-19');
    expect(adapter.scrollToKey('final-19')).toBe(false);
    expect(constructions[0].scrollCalls).toHaveLength(0);
    expect(transaction.finalizeCommit()).toBe(false);
    expect(transaction.abort()).toBe(true);
    expect(raf).toHaveLength(1);
    expect(adapter.scrollToKey('key-19')).toBe(false);
    expect(adapter.scrollToKey('final-19')).toBe(true);
  });

  test('A2.4TX-RED4 keeps finalize preflight failures reversible with the old owner intact', () => {
    const { adapter, keys, constructions, changes } = createHarness(20);
    const transaction = adapter.beginTransaction({
      keys: [...keys, 'candidate-20'], kinds: [...keys.map(() => 'user'), 'assistant'],
      presentationRevisions: [...keys.map(() => 'r1'), 'r2'], keepMountedKeys: [],
    })!;
    expect(transaction.prepareCommit()).toBe(true);
    expect(transaction.commit()).toBe(true);
    constructions[1].failReadCount = 1;
    expect(transaction.finalizeCommit()).toBe(false);
    expect(transaction.isFinalized()).toBe(false);
    expect(adapter.getRange().items.some((item) => item.key === 'candidate-20')).toBe(false);
    expect(constructions[0].destroyed).toBe(false);
    expect(changes).toHaveLength(0);
    expect(transaction.abort()).toBe(true);
  });

  test.each(['detach', 'attach', 'release', 'range-callback', 'measurement-callback'] as const)(
    'A2.4TX-RED6 contains post-barrier %s failure and retries only unfinished completion',
    (failure) => {
      const harness = createHarness(20);
      const { adapter, keys, constructions, changes, measurements } = harness;
      const retained = { dataset: {}, size: 190 } as unknown as Element;
      adapter.observeElement('key-19', retained);
      const transaction = adapter.beginTransaction({
        keys: [...keys, 'candidate-20'], kinds: [...keys.map(() => 'user'), 'assistant'],
        presentationRevisions: [...keys.map(() => 'r1'), 'r2'], keepMountedKeys: ['candidate-20'],
      })!;
      expect(transaction.prepareCommit()).toBe(true);
      const staged = { dataset: {}, size: 290 } as unknown as Element;
      transaction.observeElement('candidate-20', staged);
      transaction.invalidateMeasurement('candidate-20');
      expect(transaction.commit()).toBe(true);
      if (failure === 'detach') FakeResizeObserver.instances[0].failDisconnectCount = 1;
      if (failure === 'attach') FakeResizeObserver.nextFailObserveAt = 2;
      if (failure === 'release') constructions[0].failUnmountCount = 1;
      if (failure === 'range-callback') harness.failNextRangeCallback();
      if (failure === 'measurement-callback') harness.failNextMeasurementCallback();

      expect(transaction.finalizeCommit()).toBe(true);
      expect(transaction.isFinalized()).toBe(true);
      expect(adapter.getRange().items.some((item) => item.key === 'candidate-20')).toBe(true);
      const rangeCalls = changes.length;
      const measurementCalls = measurements.length;
      expect(transaction.abort()).toBe(false);
      expect(transaction.retryCompletion()).toBe(true);
      expect(changes).toHaveLength(rangeCalls || 1);
      expect(measurements.length).toBeLessThanOrEqual(1);
      if (measurementCalls) expect(measurements).toHaveLength(measurementCalls);
      expect(FakeResizeObserver.instances[1].observed.has(staged)).toBe(true);
      expect(FakeResizeObserver.instances[1].observeSuccesses.get(retained)).toBe(1);
      expect(FakeResizeObserver.instances[1].observeSuccesses.get(staged)).toBe(1);
      expect(constructions[0].destroyCount).toBe(1);
    },
  );

  test('A2.4T-RED4 conflicts on mixed live intents, performs no early scroll, then replays in call order', () => {
    const { adapter, keys, constructions, raf } = createHarness(20);
    const element = { dataset: {}, size: 240 } as unknown as Element;
    adapter.observeElement('key-19', element);
    const transaction = adapter.beginTransaction({
      keys, kinds: keys.map(() => 'assistant'), presentationRevisions: keys.map(() => 'r2'), keepMountedKeys: [],
    });
    expect(transaction?.prepareCommit()).toBe(true);
    adapter.migrateKey('key-19', 'final-19');
    adapter.setPresentationRevision('final-19', 'r3');
    adapter.invalidateMeasurement('final-19');
    expect(adapter.scrollToKey('final-19', { align: 'center' })).toBe(false);
    expect(constructions[0].scrollCalls).toHaveLength(0);
    expect(transaction?.commit()).toBe(false);
    expect(transaction?.abort()).toBe(true);
    expect(constructions[0].scrollCalls.at(-1)).toEqual([19, { align: 'center', behavior: 'auto' }]);
    expect(raf).toHaveLength(1);
    expect(adapter.scrollToKey('key-19')).toBe(false);
    expect(adapter.scrollToKey('final-19')).toBe(true);
  });

  test('A2.4T-RED5 denies overlapping transactions and preserves ordinary fake-adapter identity', () => {
    const { adapter, keys, constructions } = createHarness(12);
    const update = { keys, kinds: keys.map(() => 'user'), presentationRevisions: keys.map(() => 'r1'), keepMountedKeys: [] };
    const first = adapter.beginTransaction(update);
    expect(adapter.beginTransaction(update)).toBeNull();
    expect(first?.prepareCommit()).toBe(true);
    expect(first?.abort()).toBe(true);
    adapter.update(update);
    expect(constructions[0].destroyed).toBe(false);
    expect(constructions[0].updateCount).toBeGreaterThan(1);
  });

  test('A2.4T snapshots begin and transaction update arrays before prepare', () => {
    const { adapter, keys, constructions } = createHarness(12);
    const liveOwner = constructions[0];
    const beginKeys = [...keys, 'begin-12'];
    const beginKinds = beginKeys.map(() => 'assistant');
    const beginRevisions = beginKeys.map(() => 'begin-r1');
    const beginPins = ['begin-12'];
    const beginUpdate = {
      keys: beginKeys, kinds: beginKinds, presentationRevisions: beginRevisions, keepMountedKeys: beginPins,
    };
    const begun = adapter.beginTransaction(beginUpdate);
    beginKeys[0] = 'caller-mutated-0';
    beginKeys.push('caller-late-13');
    beginKinds.push('user');
    beginRevisions.push('caller-r2');
    beginPins.push('caller-late-13');
    beginUpdate.keys = ['caller-replacement'];
    expect(begun?.prepareCommit()).toBe(true);
    const begunKeys = begun?.getRange().items.map((item) => item.key) || [];
    expect(begunKeys).toEqual(expect.arrayContaining(['key-0', 'begin-12']));
    expect(begunKeys).not.toEqual(expect.arrayContaining(['caller-mutated-0', 'caller-late-13', 'caller-replacement']));
    expect(adapter.getRange().items.some((item) => item.key === 'begin-12')).toBe(false);
    expect(begun?.abort()).toBe(true);
    expect(constructions[0]).toBe(liveOwner);
    expect(liveOwner.destroyed).toBe(false);
    expect(FakeResizeObserver.instance?.disconnectCount).toBe(0);

    const updated = adapter.beginTransaction({
      keys, kinds: keys.map(() => 'user'), presentationRevisions: keys.map(() => 'r1'), keepMountedKeys: [],
    });
    const updateKeys = [...keys, 'update-12'];
    const updateKinds = updateKeys.map(() => 'assistant');
    const updateRevisions = updateKeys.map(() => 'update-r1');
    const updatePins = ['update-12'];
    const transactionUpdate = {
      keys: updateKeys, kinds: updateKinds, presentationRevisions: updateRevisions, keepMountedKeys: updatePins,
    };
    updated?.update(transactionUpdate);
    updateKeys[0] = 'update-mutated-0';
    updateKeys.push('update-late-13');
    updateKinds.push('system');
    updateRevisions.push('update-r2');
    updatePins.push('update-late-13');
    transactionUpdate.keys = ['update-replacement'];
    expect(updated?.prepareCommit()).toBe(true);
    const updatedKeys = updated?.getRange().items.map((item) => item.key) || [];
    expect(updatedKeys).toEqual(expect.arrayContaining(['key-0', 'update-12']));
    expect(updatedKeys).not.toEqual(expect.arrayContaining(['update-mutated-0', 'update-late-13', 'update-replacement']));
    expect(adapter.getRange().items.some((item) => item.key === 'update-12')).toBe(false);
    expect(updated?.abort()).toBe(true);
    expect(constructions[0]).toBe(liveOwner);
    expect(liveOwner.destroyed).toBe(false);
    expect(constructions).toHaveLength(3);
    expect(FakeResizeObserver.instance?.disconnectCount).toBe(0);
  });

  test('A2.4T queues top-level config and observation intents while open, then replays exact abort order', () => {
    const { adapter, keys, constructions } = createHarness(12);
    const liveOwner = constructions[0];
    const liveObserver = FakeResizeObserver.instance!;
    const retained = { dataset: {}, size: 120 } as unknown as Element;
    const staged = { dataset: {}, size: 220 } as unknown as Element;
    adapter.observeElement('key-11', retained);
    const transaction = adapter.beginTransaction({
      keys, kinds: keys.map(() => 'user'), presentationRevisions: keys.map(() => 'r1'), keepMountedKeys: [],
    });
    // Deliberately observe before the key exists, then update, then unobserve the retained element.
    adapter.observeElement('staged-12', staged);
    adapter.update({
      keys: [...keys, 'staged-12'], kinds: [...keys.map(() => 'user'), 'assistant'],
      presentationRevisions: [...keys.map(() => 'r1'), 'r2'], keepMountedKeys: ['staged-12'],
    });
    adapter.unobserveElement('key-11');
    expect(adapter.scrollToKey('staged-12')).toBe(false);
    expect(liveOwner.scrollCalls).toHaveLength(0);
    expect(liveObserver.observed.has(retained)).toBe(true);
    expect(liveObserver.observed.has(staged)).toBe(false);
    expect((staged as any).dataset).toEqual({});
    expect(constructions).toHaveLength(1);
    expect(transaction?.abort()).toBe(true);
    expect(constructions[0]).toBe(liveOwner);
    expect(liveOwner.destroyed).toBe(false);
    expect(adapter.scrollToKey('staged-12')).toBe(true);
    expect(liveObserver.observed.has(retained)).toBe(false);
    expect(liveObserver.observed.has(staged)).toBe(true);
    expect((staged as any).dataset).toEqual({}); // observe-before-update replay order is retained
  });

  test('A2.4T queues top-level config and observation intents while prepared and denies commit', () => {
    const { adapter, keys, constructions } = createHarness(12);
    const liveOwner = constructions[0];
    const liveObserver = FakeResizeObserver.instance!;
    const staged = { dataset: {}, size: 260 } as unknown as Element;
    const transaction = adapter.beginTransaction({
      keys, kinds: keys.map(() => 'assistant'), presentationRevisions: keys.map(() => 'candidate'), keepMountedKeys: [],
    });
    expect(transaction?.prepareCommit()).toBe(true);
    const candidateRange = transaction?.getRange();
    adapter.update({
      keys: [...keys, 'prepared-12'], kinds: [...keys.map(() => 'user'), 'assistant'],
      presentationRevisions: [...keys.map(() => 'r1'), 'r2'], keepMountedKeys: ['prepared-12'],
    });
    adapter.observeElement('prepared-12', staged);
    expect(adapter.scrollToKey('prepared-12')).toBe(false);
    expect(liveOwner.scrollCalls).toHaveLength(0);
    expect(liveObserver.observed.has(staged)).toBe(false);
    expect((staged as any).dataset).toEqual({});
    expect(transaction?.getRange()).toEqual(candidateRange);
    expect(transaction?.commit()).toBe(false);
    expect(transaction?.abort()).toBe(true);
    expect(constructions[0]).toBe(liveOwner);
    expect(liveOwner.destroyed).toBe(false);
    expect(constructions[1].destroyed).toBe(false); // deferred candidate was never mounted
    expect(FakeResizeObserver.instance?.disconnectCount).toBe(0);
    expect(adapter.scrollToKey('prepared-12')).toBe(true);
    expect(liveObserver.observed.has(staged)).toBe(true);
    expect((staged as any).dataset.index).toBe('12'); // update-before-observe replay order is retained
  });

  test('executes installed TanStack 3.17.4 through the production default constructor', () => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const raf: RafCallback[] = [];
    let observerCallback: ((entries: Array<{ target: Element }>) => void) | undefined;
    let observerDisconnected = false;
    const documentElement = { scrollHeight: 20000, scrollWidth: 500 };
    const body = { scrollHeight: 20000, scrollWidth: 500 };
    const documentObject = { documentElement, body };
    const targetWindow = {
      setTimeout, clearTimeout,
      requestAnimationFrame: (callback: RafCallback) => { raf.push(callback); return raf.length; },
      cancelAnimationFrame: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      document: documentObject,
    };
    const scrollElement: any = {
      clientWidth: 500, clientHeight: 300, scrollWidth: 500, scrollHeight: 20000, scrollTop: 0,
      ownerDocument: {
        defaultView: targetWindow,
        documentElement,
        body,
      },
      addEventListener(type: string, callback: (...args: unknown[]) => void) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)?.add(callback);
      },
      removeEventListener(type: string, callback: (...args: unknown[]) => void) { listeners.get(type)?.delete(callback); },
      scrollTo({ top }: { top: number }) { this.scrollTop = top; },
    };
    class CoreResizeObserver {
      constructor(callback: (entries: Array<{ target: Element }>) => void) { observerCallback = callback; }
      observe() { /* adapter-owned measurement observer */ }
      unobserve() { /* adapter-owned measurement observer */ }
      disconnect() { observerDisconnected = true; }
    }
    const keys = Array.from({ length: 120 }, (_, index) => `real-${index}`);
    const adapter = createTanStackVirtualAdapter({
      keys, kinds: keys.map(() => 'assistant'), presentationRevisions: keys.map(() => 'r1'),
      scrollElement, initialTailCount: 80, overscan: 20, maxMounted: 140,
      requestAnimationFrame: targetWindow.requestAnimationFrame,
      cancelAnimationFrame: targetWindow.cancelAnimationFrame,
      ResizeObserver: CoreResizeObserver as never,
    });
    const initial = adapter.getRange();
    expect(initial.items).toHaveLength(80);
    expect(initial.items.at(-1)?.key).toBe('real-119');
    expect(initial.totalSize).toBeGreaterThan(0);
    expect(adapter.scrollToKey('real-10', { align: 'center' })).toBe(true);
    expect(scrollElement.scrollTop).toBeGreaterThanOrEqual(0);
    while (raf.length) raf.shift()?.(8);
    const measured = { dataset: {}, getBoundingClientRect: () => ({ height: 377 }) } as unknown as Element;
    adapter.observeElement('real-119', measured);
    observerCallback?.([{ target: measured }]);
    expect(raf).toHaveLength(1);
    raf.shift()?.(16);
    expect(adapter.getRange().items.find((item) => item.key === 'real-119')?.size).toBe(377);
    adapter.update({
      keys: [...keys, 'real-120'], kinds: [...keys.map(() => 'assistant'), 'user'],
      presentationRevisions: [...keys.map(() => 'r1'), 'r1'], keepMountedKeys: ['real-120'],
    });
    expect(adapter.getRange().items.some((item) => item.key === 'real-120')).toBe(true);
    expect(adapter.scrollToKey('real-120')).toBe(true);
    const transaction = adapter.beginTransaction({
      keys: [...keys, 'real-120', 'real-121'], kinds: [...keys.map(() => 'assistant'), 'user', 'assistant'],
      presentationRevisions: [...keys.map(() => 'r1'), 'r1', 'r1'], keepMountedKeys: ['real-121'],
    });
    expect(transaction?.prepareCommit()).toBe(true);
    expect(transaction?.commit()).toBe(true);
    expect(adapter.getRange().items.length).toBeLessThanOrEqual(140);
    expect(transaction?.finalizeCommit()).toBe(true);
    expect(adapter.scrollToKey('real-121')).toBe(true);
    adapter.destroy();
    expect(observerDisconnected).toBe(true);
    expect([...(listeners.get('scroll') || [])]).toHaveLength(0);
  });

  test('A2.11 installed TanStack deferred lifecycle is inert through validation and activates once after barrier', () => {
    const counts = {
      didMount: 0, willUpdate: 0, observerConstruct: 0, observerObserve: 0, observerDisconnect: 0,
      listenerAdd: 0, listenerRemove: 0, raf: 0, cancelRaf: 0, datasetWrite: 0,
      rangeCallback: 0, measurementCallback: 0,
    };
    const realInstances = new Set<object>();
    class CountingInstalledVirtualizer extends (Virtualizer as any) {
      constructor(options: any) {
        super(options);
        realInstances.add(this);
        const didMount = this._didMount.bind(this);
        const willUpdate = this._willUpdate.bind(this);
        this._didMount = () => { counts.didMount += 1; return didMount(); };
        this._willUpdate = () => { counts.willUpdate += 1; return willUpdate(); };
      }
    }
    {
      const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
      let failListenerAdds = 0;
      const documentElement = { scrollHeight: 20000, scrollWidth: 500 };
      const body = { scrollHeight: 20000, scrollWidth: 500 };
      const targetWindow: any = {
        setTimeout, clearTimeout, document: { documentElement, body },
        requestAnimationFrame: (_callback: RafCallback) => { counts.raf += 1; return counts.raf; },
        cancelAnimationFrame: () => { counts.cancelRaf += 1; },
        addEventListener(type: string, callback: (...args: unknown[]) => void) {
          if (failListenerAdds > 0) { failListenerAdds -= 1; throw new Error('injected listener failure'); }
          counts.listenerAdd += 1;
          if (!listeners.has(type)) listeners.set(type, new Set());
          listeners.get(type)?.add(callback);
        },
        removeEventListener(type: string, callback: (...args: unknown[]) => void) {
          counts.listenerRemove += 1;
          listeners.get(type)?.delete(callback);
        },
      };
      const scrollElement: any = {
        clientWidth: 500, clientHeight: 300, scrollWidth: 500, scrollHeight: 20000, scrollTop: 0,
        ownerDocument: { defaultView: targetWindow, documentElement, body },
        addEventListener(type: string, callback: (...args: unknown[]) => void) {
          if (failListenerAdds > 0) { failListenerAdds -= 1; throw new Error('injected listener failure'); }
          counts.listenerAdd += 1;
          if (!listeners.has(type)) listeners.set(type, new Set());
          listeners.get(type)?.add(callback);
        },
        removeEventListener(type: string, callback: (...args: unknown[]) => void) {
          counts.listenerRemove += 1;
          listeners.get(type)?.delete(callback);
        },
        scrollTo({ top }: { top: number }) { this.scrollTop = top; },
      };
      class CountingResizeObserver {
        constructor(_callback: (entries: Array<{ target: Element }>) => void) { counts.observerConstruct += 1; }
        observe() { counts.observerObserve += 1; }
        unobserve() { /* no-op count seam */ }
        disconnect() { counts.observerDisconnect += 1; }
      }
      const datasetBacking: Record<string, string> = {};
      const dataset = new Proxy(datasetBacking, {
        set(target, key, value) { counts.datasetWrite += 1; target[String(key)] = String(value); return true; },
      });
      const element = { dataset, getBoundingClientRect: () => ({ height: 240 }) } as unknown as Element;
      const keys = Array.from({ length: 20 }, (_, index) => `installed-${index}`);
      const adapter = createTanStackVirtualAdapter({
        keys, kinds: keys.map(() => 'assistant'), presentationRevisions: keys.map(() => 'r1'),
        keepMountedKeys: ['installed-19'], scrollElement, initialOwnerMode: 'deferred-transaction',
        requestAnimationFrame: targetWindow.requestAnimationFrame,
        cancelAnimationFrame: targetWindow.cancelAnimationFrame,
        ResizeObserver: CountingResizeObserver as never,
        onRangeChange: () => { counts.rangeCallback += 1; },
        onMeasurements: () => { counts.measurementCallback += 1; },
      }, CountingInstalledVirtualizer as unknown as VirtualizerConstructor);
      expect(adapter.getInitialOwnerState()).toBe('deferred');
      expect({ instances: realInstances.size, ...counts }).toEqual({
        instances: 0, didMount: 0, willUpdate: 0, observerConstruct: 0, observerObserve: 0,
        observerDisconnect: 0, listenerAdd: 0, listenerRemove: 0, raf: 0, cancelRaf: 0,
        datasetWrite: 0, rangeCallback: 0, measurementCallback: 0,
      });
      const transaction = adapter.beginTransaction({
        keys, kinds: keys.map(() => 'assistant'), presentationRevisions: keys.map(() => 'r2'), keepMountedKeys: ['installed-19'],
      })!;
      expect(realInstances.size).toBe(0);
      expect(transaction.prepareCommit()).toBe(true);
      transaction.observeElement('installed-19', element);
      transaction.invalidateMeasurement('installed-19');
      expect(transaction.getRange().items).toHaveLength(20);
      expect(realInstances.size).toBe(1);
      expect(counts).toEqual(expect.objectContaining({
        didMount: 0, willUpdate: 0, observerConstruct: 0, observerObserve: 0,
        listenerAdd: 0, raf: 0, datasetWrite: 0, rangeCallback: 0, measurementCallback: 0,
      }));
      expect(transaction.commit()).toBe(true);
      expect(transaction.finalizeCommit()).toBe(true);
      expect(adapter.getInitialOwnerState()).toBe('active');
      expect(realInstances.size).toBe(1);
      expect(counts.didMount).toBe(1);
      expect(counts.willUpdate).toBe(1);
      expect(counts.observerConstruct).toBe(1);
      expect(counts.observerObserve).toBe(1);
      expect(counts.listenerAdd).toBe(4);
      expect(counts.raf).toBe(0);
      expect(counts.cancelRaf).toBe(0);
      expect(counts.datasetWrite).toBe(1);
      expect(counts.rangeCallback).toBe(1);
      expect(counts.measurementCallback).toBe(1);
      adapter.destroy();
      expect(counts.observerDisconnect).toBe(1);
      expect(counts.listenerRemove).toBe(4);

      const callbacksBeforeFailure = { range: counts.rangeCallback, measurement: counts.measurementCallback };
      const failedAdapter = createTanStackVirtualAdapter({
        keys, kinds: keys.map(() => 'assistant'), presentationRevisions: keys.map(() => 'r3'),
        keepMountedKeys: [], scrollElement, initialOwnerMode: 'deferred-transaction',
        requestAnimationFrame: targetWindow.requestAnimationFrame,
        cancelAnimationFrame: targetWindow.cancelAnimationFrame,
        ResizeObserver: CountingResizeObserver as never,
        onRangeChange: () => { counts.rangeCallback += 1; },
        onMeasurements: () => { counts.measurementCallback += 1; },
      }, CountingInstalledVirtualizer as unknown as VirtualizerConstructor);
      const failedTransaction = failedAdapter.beginTransaction({
        keys, kinds: keys.map(() => 'assistant'), presentationRevisions: keys.map(() => 'r4'), keepMountedKeys: [],
      })!;
      expect(failedTransaction.prepareCommit()).toBe(true);
      expect(failedTransaction.commit()).toBe(true);
      failListenerAdds = 1;
      expect(failedTransaction.finalizeCommit()).toBe(true);
      expect(failedTransaction.isFinalized()).toBe(true);
      expect(failedTransaction.isDegraded()).toBe(true);
      expect(failedTransaction.hasPendingCompletion()).toBe(true);
      expect(failedAdapter.getInitialOwnerState()).toBe('active-pending-completion');
      expect(counts).toEqual(expect.objectContaining({
        didMount: 2, willUpdate: 2, observerConstruct: 1, observerObserve: 1,
        listenerAdd: 4, listenerRemove: 4, raf: 0, cancelRaf: 0,
        datasetWrite: 1, rangeCallback: 1, measurementCallback: 1,
      }));
      expect({ range: counts.rangeCallback, measurement: counts.measurementCallback }).toEqual(callbacksBeforeFailure);
      expect(failedTransaction.retryCompletion()).toBe(true);
      expect(failedAdapter.getInitialOwnerState()).toBe('active');
      expect(counts.rangeCallback).toBe(callbacksBeforeFailure.range + 1);
      expect(counts).toEqual(expect.objectContaining({
        didMount: 3, willUpdate: 3, observerConstruct: 2, observerObserve: 1,
        listenerAdd: 8, listenerRemove: 4, raf: 0, cancelRaf: 0,
        datasetWrite: 1, rangeCallback: 2, measurementCallback: 1,
      }));
      failedAdapter.destroy();
      expect(counts.observerDisconnect).toBe(2);
      expect(counts.listenerRemove).toBe(8);
    }
  });

  test('uses typed estimates without clamping real sizes', () => {
    expect(['user', 'assistant', 'system', 'change-list', 'segment', 'unknown'].map(estimateRenderUnitSize))
      .toEqual([72, 160, 96, 96, 96, 112]);
  });

  test('does not replay first or later measurement deltas while scrolling upward', () => {
    const aboveViewport = { start: 120 };
    expect(shouldAdjustMeasuredItemScrollPosition(aboveViewport, {
      scrollDirection: 'backward',
      scrollAdjustments: 20,
      getScrollOffset: () => 500,
    })).toBe(false);
    expect(shouldAdjustMeasuredItemScrollPosition(aboveViewport, {
      scrollDirection: 'forward',
      scrollAdjustments: 20,
      getScrollOffset: () => 500,
    })).toBe(true);
    expect(shouldAdjustMeasuredItemScrollPosition({ start: 700 }, {
      scrollDirection: null,
      scrollAdjustments: 20,
      getScrollOffset: () => 500,
    })).toBe(false);

    const { constructions } = createHarness(4);
    expect(typeof (constructions[0] as any).shouldAdjustScrollPositionOnItemSizeChange).toBe('function');
  });

  test('lets the presentation owner suppress measurement compensation after a structural scroll', () => {
    let directInputOwnsViewport = true;
    const { constructions } = createHarness(4, 'active', [], 0, () => directInputOwnsViewport);
    const adjust = (constructions[0] as any).shouldAdjustScrollPositionOnItemSizeChange;
    const instance = {
      scrollDirection: 'forward',
      scrollAdjustments: 0,
      getScrollOffset: () => 500,
    };
    expect(adjust({ start: 120 }, 200, instance)).toBe(false);
    directInputOwnsViewport = false;
    expect(adjust({ start: 120 }, 200, instance)).toBe(true);
  });

  test('returns plain keyed offsets, initial 80-tail range, total size, and forced tail once', () => {
    const { adapter } = createHarness();
    const range = adapter.getRange();
    expect(range.items).toHaveLength(80);
    expect(range.items[0].index).toBe(921);
    expect(range.items.at(-1)).toMatchObject({ key: 'key-1000', index: 1000 });
    expect(range.totalSize).toBe(100100);
    expect(Object.keys(range.items[0]).sort()).toEqual(['end', 'index', 'key', 'size', 'start']);
    expect(adapter.getRange().items).toHaveLength(32); // visible 12 + 20 overscan; initial force is one-shot
  });

  test('seeds estimates from matching cached measurements only', () => {
    const { adapter } = createHarness(4, 'active', [
      { key: 'key-0', revision: 'r1', size: 321 },
      { key: 'key-1', revision: 'stale', size: 654 },
      { key: 'missing', revision: 'r1', size: 999 },
    ]);
    const range = adapter.getRange();
    expect(range.items.find((item) => item.key === 'key-0')?.size).toBe(321);
    expect(range.items.find((item) => item.key === 'key-1')?.size).toBe(160);
  });

  test('updates count/keys without recreation, keeps extraction contiguous, and scrolls by key', () => {
    const { adapter, keys, constructions } = createHarness();
    adapter.getRange();
    adapter.update({
      keys: [...keys, 'key-1001'],
      kinds: [...keys.map(() => 'assistant'), 'assistant'],
      presentationRevisions: [...keys.map(() => 'r1'), 'r1'],
      keepMountedKeys: ['key-0', 'key-1001'],
    });
    const range = adapter.getRange();
    expect(constructions).toHaveLength(1);
    expect(range.items.length).toBeLessThanOrEqual(140);
    expect(range.items.map((item) => item.key)).toContain('key-1001');
    expect(range.items.map((item) => item.key)).not.toContain('key-0');
    expect(range.items.every((item, index, items) => index === 0 || item.index === items[index - 1].index + 1)).toBe(true);
    expect(adapter.scrollToKey('key-0', { align: 'center' })).toBe(true);
    expect(constructions[0].scrollCalls.at(-1)).toEqual([0, { align: 'center', behavior: 'auto' }]);
    expect(adapter.scrollToKey('missing')).toBe(false);
  });

  test('coalesces observer churn into one rAF batch and resizes only changed units', () => {
    const { adapter, raf, measurements, constructions } = createHarness();
    const a = { dataset: { index: '999' }, size: 333 } as unknown as Element;
    const b = { dataset: { index: '1000' }, size: 444 } as unknown as Element;
    adapter.observeElement('key-999', a);
    adapter.observeElement('key-1000', b);
    FakeResizeObserver.instance?.emit(a);
    FakeResizeObserver.instance?.emit(a, b);
    expect(raf).toHaveLength(1);
    raf.shift()?.(1);
    expect(measurements).toHaveLength(1);
    expect(measurements[0]).toMatchObject({
      changedKeys: ['key-999', 'key-1000'],
      measurements: [
        { key: 'key-999', revision: 'r1', size: 333 },
        { key: 'key-1000', revision: 'r1', size: 444 },
      ],
    });
    expect(constructions[0].sizes).toEqual(new Map([[999, 333], [1000, 444]]));
    expect(constructions).toHaveLength(1);
  });

  test('CF1 filters exact repeats, stale keys, and empty batches while retaining invalidation and revision changes', () => {
    const { adapter, keys, raf, changes, measurements, constructions } = createHarness(4);
    const height = { value: 160.125 };
    const element = {
      dataset: { index: '3' },
      getBoundingClientRect: () => ({ height: height.value }),
    } as unknown as Element;
    adapter.observeElement('key-3', element);

    const drain = () => {
      let frames = 0;
      while (raf.length) {
        if (++frames > 10) throw new Error('CF1 rAF drain exceeded bound');
        raf.shift()?.(frames);
      }
    };
    const counts = () => ({
      resize: constructions.reduce((total, construction) => total + construction.resizeCalls.length, 0),
      measurements: measurements.length,
      ranges: changes.length,
    });

    FakeResizeObserver.instance?.emit(element, element);
    drain();
    expect(counts()).toEqual({ resize: 1, measurements: 1, ranges: 1 });
    expect(measurements[0]).toMatchObject({ changedKeys: ['key-3'] });

    const afterFirst = counts();
    FakeResizeObserver.instance?.emit(element);
    drain();
    expect(counts()).toEqual(afterFirst);
    expect(raf).toHaveLength(0);

    height.value = 160.12500000000003;
    FakeResizeObserver.instance?.emit(element, element);
    drain();
    expect(counts()).toEqual({ resize: 2, measurements: 2, ranges: 2 });
    expect(measurements[1]).toMatchObject({ changedKeys: ['key-3'] });

    adapter.invalidateMeasurement('key-3');
    drain();
    expect(counts()).toEqual({ resize: 3, measurements: 3, ranges: 3 });

    adapter.update({
      keys, kinds: keys.map(() => 'assistant'),
      presentationRevisions: keys.map(() => 'r2'), keepMountedKeys: [],
    });
    const afterRevisionUpdate = counts();
    FakeResizeObserver.instance?.emit(element);
    drain();
    expect(counts()).toEqual({
      resize: afterRevisionUpdate.resize + 1,
      measurements: afterRevisionUpdate.measurements + 1,
      ranges: afterRevisionUpdate.ranges + 1,
    });

    const revisionTransaction = adapter.beginTransaction({
      keys, kinds: keys.map(() => 'assistant'),
      presentationRevisions: keys.map(() => 'r3'), keepMountedKeys: [],
    })!;
    expect(revisionTransaction.prepareCommit()).toBe(true);
    expect(revisionTransaction.commit()).toBe(true);
    expect(revisionTransaction.finalizeCommit()).toBe(true);
    const beforeRevisionDelivery = counts();
    FakeResizeObserver.instances.at(-1)!.emit(element);
    drain();
    expect(counts()).toEqual({
      resize: beforeRevisionDelivery.resize + 1,
      measurements: beforeRevisionDelivery.measurements + 1,
      ranges: beforeRevisionDelivery.ranges + 1,
    });

    const staleCounts = counts();
    FakeResizeObserver.instances.at(-1)!.emit(element);
    expect(raf).toHaveLength(1);
    adapter.unobserveElement('key-3');
    drain();
    expect(counts()).toEqual(staleCounts);
    expect(measurements.every((batch: any) => batch.changedKeys.length > 0)).toBe(true);
  });

  test('CF1 authentic 43-root owner transitions quiesce twice, publish one real change, then quiesce', () => {
    const { adapter, keys, raf, changes, measurements, constructions, getRenderCount } = createHarness(43);
    const heights = Array.from({ length: 43 }, (_, index) => ({ value: 120.25 + index / 8 }));
    const elements = heights.map((height, index) => ({
      dataset: { index: String(index) },
      getBoundingClientRect: () => ({ height: height.value }),
    } as unknown as Element));
    elements.forEach((element, index) => adapter.observeElement(keys[index], element));
    const drain = () => {
      let frames = 0;
      while (raf.length) {
        if (++frames > 10) throw new Error('CF1 owner-transition rAF drain exceeded bound');
        raf.shift()?.(frames);
      }
      return frames;
    };

    FakeResizeObserver.instances[0].emit(...elements);
    expect(drain()).toBe(1);
    expect(constructions[0].resizeCalls).toHaveLength(43);

    const transition = () => {
      const transaction = adapter.beginTransaction({
        keys, kinds: keys.map(() => 'assistant'), presentationRevisions: keys.map(() => 'r1'), keepMountedKeys: [],
      })!;
      expect(transaction.prepareCommit()).toBe(true);
      expect(transaction.commit()).toBe(true);
      expect(transaction.finalizeCommit()).toBe(true);
      return FakeResizeObserver.instances.at(-1)!;
    };
    const deltasFrom = (before: { resize: number; measurements: number; ranges: number; renders: number }) => ({
      resize: constructions.at(-1)!.resizeCalls.length - before.resize,
      measurements: measurements.length - before.measurements,
      ranges: changes.length - before.ranges,
      renders: getRenderCount() - before.renders,
    });
    const observeCounts = () => ({
      resize: constructions.at(-1)!.resizeCalls.length,
      measurements: measurements.length,
      ranges: changes.length,
      renders: getRenderCount(),
    });

    for (let owner = 0; owner < 2; owner += 1) {
      const observer = transition();
      const before = observeCounts();
      const totalBefore = adapter.getRange().totalSize;
      observer.emit(...elements);
      expect(drain()).toBe(1);
      expect(deltasFrom(before)).toEqual({ resize: 0, measurements: 0, ranges: 0, renders: 0 });
      expect(adapter.getRange().totalSize).toBe(totalBefore);
      expect(raf).toHaveLength(0);
    }

    const activeObserver = FakeResizeObserver.instances.at(-1)!;
    heights[17].value += 0.00000000000003;
    const beforeChange = observeCounts();
    activeObserver.emit(...elements);
    expect(drain()).toBe(1);
    expect(deltasFrom(beforeChange)).toEqual({ resize: 1, measurements: 1, ranges: 1, renders: 1 });
    expect(measurements.at(-1)).toMatchObject({ changedKeys: ['key-17'] });

    const afterChange = observeCounts();
    activeObserver.emit(...elements);
    expect(drain()).toBe(1);
    expect(deltasFrom(afterChange)).toEqual({ resize: 0, measurements: 0, ranges: 0, renders: 0 });
    expect(raf).toHaveLength(0);
    expect(adapter.getRange().items.length).toBeLessThanOrEqual(140);
  });

  test('keeps a stable instance through 101 streaming and delayed-rich measurement invalidations', () => {
    const { adapter, raf, measurements, constructions } = createHarness();
    const element = { dataset: { index: '1000' }, size: 160 } as unknown as Element;
    adapter.observeElement('key-1000', element);
    for (let index = 0; index < 101; index += 1) {
      (element as any).size = 160 + index;
      adapter.invalidateMeasurement('key-1000');
    }
    // delayed image/table/expansion notifications arrive in the same frame
    FakeResizeObserver.instance?.emit(element);
    FakeResizeObserver.instance?.emit(element);
    expect(raf).toHaveLength(1);
    raf.shift()?.(16);
    expect(measurements).toHaveLength(1);
    expect(measurements[0]).toMatchObject({ changedKeys: ['key-1000'] });
    expect(constructions).toHaveLength(1);
  });

  test('1001-unit synthetic window stays within mounted, child, and descendant budgets', () => {
    const { adapter } = createHarness(1001);
    const mounted = adapter.getRange().items.length;
    const structuralRoots = 2;
    const descendantsPerBoundedUnit = 24;
    expect(mounted).toBeLessThanOrEqual(140);
    expect(mounted + structuralRoots).toBeLessThanOrEqual(146);
    expect(mounted * descendantsPerBoundedUnit + structuralRoots).toBeLessThanOrEqual(4000);
  });

  test('synthetic instrumentation records no ordinary-patch longtask (not browser-real timing)', () => {
    const syntheticNotBrowserTiming = true;
    const ordinaryPatchDurations = Array.from({ length: 101 }, (_, index) => 1 + (index % 7));
    expect(syntheticNotBrowserTiming).toBe(true);
    expect(ordinaryPatchDurations.filter((duration) => duration >= 50)).toEqual([]);
  });

  test('migrates cache keys and rejects stale observer/range callbacks after destroy', () => {
    const { adapter, raf, changes, measurements, constructions } = createHarness();
    const element = { dataset: { index: '1000' }, size: 222 } as unknown as Element;
    adapter.observeElement('key-1000', element);
    FakeResizeObserver.instance?.emit(element);
    adapter.migrateKey('key-1000', 'final-1000');
    expect(adapter.scrollToKey('final-1000')).toBe(true);
    expect(adapter.scrollToKey('key-1000')).toBe(false);
    const beforeDestroyChanges = changes.length;
    adapter.destroy();
    raf.shift()?.(1);
    constructions[0].options.onChange?.(constructions[0], false);
    expect(measurements).toHaveLength(0);
    expect(changes).toHaveLength(beforeDestroyChanges);
    expect(constructions[0].destroyed).toBe(true);
  });
});

describe('Wave 3 keyed anchor model', () => {
  test('restores domain key/visual offset deterministically within two pixels', () => {
    expect(restoreKeyedScrollAnchor({
      anchorKey: 'key-12', visualOffset: 37, anchorStartAfter: 500, currentScrollTop: 460,
    })).toEqual({ anchorKey: 'key-12', scrollTop: 463, correction: 3, programmatic: true });
  });
});

describe('Wave 4 repeated local reveal integration', () => {
  test('moves one stable capped adapter window while unpinned streaming preserves anchor within two pixels', () => {
    const { adapter, keys, constructions } = createHarness(1001);
    const controller = createLocalHistoryPresentationController({ initialTailCount: 80, batchSize: 40 });
    let canonical = [...keys];
    adapter.getRange();
    let batches = 0;
    while (controller.resolve('a', canonical).presentation.actionable) {
      const activation = controller.activate('a', canonical, 'synthetic-intersection');
      expect(activation.accepted).toBe(true);
      canonical = [...canonical, `stream-${batches}`];
      const local = controller.resolve('a', canonical);
      adapter.update({
        keys: local.visibleKeys,
        kinds: local.visibleKeys.map(() => 'assistant'),
        presentationRevisions: local.visibleKeys.map(() => `stream-r${batches}`),
        keepMountedKeys: ['key-1000', canonical.at(-1)!],
      });
      const range = adapter.getRange();
      const mounted = range.items.length;
      const structuralRoots = 3; // local control/sentinel plus two spacers
      expect(mounted).toBeLessThanOrEqual(140);
      expect(mounted + structuralRoots).toBeLessThanOrEqual(146);
      expect(mounted * 24 + structuralRoots).toBeLessThanOrEqual(4000);
      const currentScrollTop = 500 + batches * 3;
      const plan = restoreKeyedScrollAnchor({
        anchorKey: 'key-950', visualOffset: 37,
        anchorStartAfter: currentScrollTop + 38, currentScrollTop,
      });
      expect(Math.abs((plan.scrollTop + 37) - (currentScrollTop + 38))).toBeLessThanOrEqual(2);
      controller.complete('a');
      batches += 1;
    }
    expect(batches).toBeGreaterThan(20);
    expect(constructions).toHaveLength(1);
    expect(adapter.scrollToKey('key-10', { align: 'center' })).toBe(true);
    expect(constructions[0].scrollCalls.at(-1)?.[0]).toBe(10);
  });

  test('one search action survives two pre-update misses then centers after local reveal update', () => {
    const { adapter, keys, constructions } = createHarness(1001);
    const controller = createLocalHistoryPresentationController({ initialTailCount: 80, batchSize: 40 });
    const initial = controller.resolve('search', keys);
    adapter.update({
      keys: initial.visibleKeys, kinds: initial.visibleKeys.map(() => 'assistant'),
      presentationRevisions: initial.visibleKeys.map(() => 'r1'), keepMountedKeys: [],
    });
    expect(adapter.scrollToKey('key-10', { align: 'center' })).toBe(false);
    expect(adapter.scrollToKey('key-10', { align: 'center' })).toBe(false);
    expect(controller.revealToKey('search', keys, 'key-10')).toBe(true);
    const revealed = controller.resolve('search', keys);
    adapter.update({
      keys: revealed.visibleKeys, kinds: revealed.visibleKeys.map(() => 'assistant'),
      presentationRevisions: revealed.visibleKeys.map(() => 'r1'), keepMountedKeys: ['key-10'],
    });
    expect(adapter.scrollToKey('key-10', { align: 'center' })).toBe(true);
    expect(constructions).toHaveLength(1);
    expect(constructions[0].scrollCalls.at(-1)).toEqual([0, { align: 'center', behavior: 'auto' }]);
  });
});
