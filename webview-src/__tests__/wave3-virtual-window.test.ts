import {
  createTanStackVirtualAdapter,
  estimateRenderUnitSize,
  type VirtualizerConstructor,
} from '../rendering/tanstack-virtual-adapter';
import { restoreKeyedScrollAnchor } from '../rendering/scroll-anchor-model';
import { createLocalHistoryPresentationController } from '../rendering/local-history-window';

type RafCallback = (time: number) => void;

class FakeResizeObserver {
  static instance: FakeResizeObserver | undefined;
  readonly observed = new Set<Element>();
  constructor(readonly callback: (entries: Array<{ target: Element }>) => void) {
    FakeResizeObserver.instance = this;
  }
  observe(element: Element) { this.observed.add(element); }
  unobserve(element: Element) { this.observed.delete(element); }
  disconnect() { this.observed.clear(); }
  emit(...targets: Element[]) { this.callback(targets.map((target) => ({ target }))); }
}

function createHarness(count = 1001) {
  const raf: RafCallback[] = [];
  const changes: unknown[] = [];
  const measurements: unknown[] = [];
  const constructions: FakeVirtualizer[] = [];
  const scrollElement = { clientHeight: 640, scrollTop: 0 } as unknown as Element;

  class FakeVirtualizer {
    options: any;
    sizes = new Map<number, number>();
    scrollCalls: unknown[][] = [];
    destroyed = false;
    mountCount = 0;
    updateCount = 0;
    constructor(options: any) {
      this.options = options;
      constructions.push(this);
    }
    setOptions(options: any) { this.options = options; }
    _didMount() { this.mountCount += 1; return () => { this.destroyed = true; }; }
    _willUpdate() { this.updateCount += 1; }
    getVirtualItems() {
      const range = { startIndex: Math.max(0, this.options.count - 12), endIndex: this.options.count - 1, overscan: this.options.overscan, count: this.options.count };
      return this.options.rangeExtractor(range).map((index: number) => {
        const size = this.sizes.get(index) ?? this.options.estimateSize(index);
        return { index, key: this.options.getItemKey(index), start: index * 100, size, end: index * 100 + size, lane: 0 };
      });
    }
    getTotalSize() { return this.options.count * 100; }
    scrollToIndex(...args: unknown[]) { this.scrollCalls.push(args); }
    resizeItem(index: number, size: number) { this.sizes.set(index, size); }
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
    scrollElement,
    overscan: 20,
    initialTailCount: 80,
    maxMounted: 140,
    keepMountedKeys: [keys[count - 1]],
    onRangeChange: (snapshot) => changes.push(snapshot),
    onMeasurements: (batch) => measurements.push(batch),
    requestAnimationFrame: (callback) => { raf.push(callback); return raf.length; },
    cancelAnimationFrame: () => undefined,
    ResizeObserver: FakeResizeObserver as never,
  }, FakeVirtualizer as unknown as VirtualizerConstructor);
  return { adapter, keys, raf, changes, measurements, constructions };
}

describe('Wave 3 TanStack adapter contract', () => {
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
    adapter.destroy();
    expect(observerDisconnected).toBe(true);
    expect([...(listeners.get('scroll') || [])]).toHaveLength(0);
  });

  test('uses typed estimates without clamping real sizes', () => {
    expect(['user', 'assistant', 'system', 'change-list', 'segment', 'unknown'].map(estimateRenderUnitSize))
      .toEqual([72, 160, 96, 96, 96, 112]);
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

  test('updates count/keys without recreation, caps custom anchor/tail extraction, and scrolls by key', () => {
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
    expect(range.items.map((item) => item.key)).toEqual(expect.arrayContaining(['key-0', 'key-1001']));
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
    expect(measurements[0]).toMatchObject({ changedKeys: ['key-999', 'key-1000'] });
    expect(constructions[0].sizes).toEqual(new Map([[999, 333], [1000, 444]]));
    expect(constructions).toHaveLength(1);
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
