import {
  Virtualizer,
  elementScroll,
  observeElementOffset,
  type VirtualizerOptions,
} from '@tanstack/virtual-core';

export type RenderUnitEstimateKind = 'user' | 'assistant' | 'system' | 'change-list' | 'segment' | string;

export interface PlainVirtualItem {
  readonly key: string;
  readonly index: number;
  readonly start: number;
  readonly end: number;
  readonly size: number;
}

export interface VirtualRangeSnapshot {
  readonly items: readonly PlainVirtualItem[];
  readonly totalSize: number;
}

export interface MeasurementBatch {
  readonly changedKeys: readonly string[];
  readonly totalSize: number;
}

interface ResizeObserverLike {
  observe(element: Element): void;
  unobserve(element: Element): void;
  disconnect(): void;
}

interface ResizeObserverConstructorLike {
  new(callback: (entries: ArrayLike<{ readonly target: Element }>) => void): ResizeObserverLike;
}

export interface VirtualAdapterOptions {
  readonly keys: readonly string[];
  readonly kinds?: readonly RenderUnitEstimateKind[];
  readonly presentationRevisions?: readonly string[];
  readonly scrollElement: Element;
  readonly overscan?: number;
  readonly initialTailCount?: number;
  readonly maxMounted?: number;
  readonly gap?: number;
  readonly keepMountedKeys?: readonly string[];
  readonly onRangeChange?: (snapshot: VirtualRangeSnapshot) => void;
  readonly onMeasurements?: (batch: MeasurementBatch) => void;
  readonly requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelAnimationFrame?: (handle: number) => void;
  readonly ResizeObserver?: ResizeObserverConstructorLike;
}

interface CoreVirtualizer {
  getVirtualItems(): Array<{ key: string | number | bigint; index: number; start: number; end: number; size: number }>;
  getTotalSize(): number;
  setOptions?(options: unknown): void;
  scrollToIndex?(index: number, options?: unknown): void;
  resizeItem?(index: number, size: number): void;
  _didMount?(): () => void;
  _willUpdate?(): void;
}

/** Test seam only; TanStack options and instances never cross the runtime facade. */
export type VirtualizerConstructor = new (options: any) => CoreVirtualizer;

export interface TanStackVirtualAdapter {
  getRange(): VirtualRangeSnapshot;
  update(update: Pick<VirtualAdapterOptions, 'keys' | 'kinds' | 'presentationRevisions' | 'keepMountedKeys'>): void;
  scrollToKey(key: string, options?: { readonly align?: 'start' | 'center' | 'end' | 'auto' }): boolean;
  observeElement(key: string, element: Element): void;
  unobserveElement(key: string): void;
  invalidateMeasurement(key: string): void;
  setPresentationRevision(key: string, revision: string): void;
  migrateKey(oldKey: string, newKey: string): void;
  destroy(): void;
}

const DefaultVirtualizer = Virtualizer as unknown as VirtualizerConstructor;

export function estimateRenderUnitSize(kind: RenderUnitEstimateKind): number {
  if (kind === 'user') return 72;
  if (kind === 'assistant') return 160;
  if (kind === 'system' || kind === 'change-list' || kind === 'segment') return 96;
  return 112;
}

function isWave3Options(options: VirtualAdapterOptions | VirtualizerOptions<Element, Element>): options is VirtualAdapterOptions {
  return Array.isArray((options as VirtualAdapterOptions).keys);
}

/**
 * Owns the TanStack lifecycle and exposes only stable keys and numeric layout data.
 * The legacy overload is retained for the accepted Wave 1 dormant seam.
 */
export function createTanStackVirtualAdapter(
  options: VirtualAdapterOptions | VirtualizerOptions<Element, Element>,
  VirtualizerClass: VirtualizerConstructor = DefaultVirtualizer,
): TanStackVirtualAdapter {
  if (!isWave3Options(options)) {
    const legacy = new VirtualizerClass(options);
    return {
      getRange: () => plainSnapshot(legacy),
      update: () => undefined,
      scrollToKey: () => false,
      observeElement: () => undefined,
      unobserveElement: () => undefined,
      invalidateMeasurement: () => undefined,
      setPresentationRevision: () => undefined,
      migrateKey: () => undefined,
      destroy: () => undefined,
    };
  }

  let current = options;
  let keys = [...current.keys];
  let kinds = [...(current.kinds || [])];
  let revisions = [...(current.presentationRevisions || [])];
  let keepMountedKeys = [...(current.keepMountedKeys || [])];
  let destroyed = false;
  let initialTailPending = true;
  let generation = 1;
  let rafHandle: number | null = null;
  const elementByKey = new Map<string, Element>();
  const keyByElement = new Map<Element, string>();
  const measured = new Map<string, { revision: string; size: number }>();
  const pendingMeasurementKeys = new Set<string>();
  const requestFrame = current.requestAnimationFrame || ((callback) => window.requestAnimationFrame(callback));
  const cancelFrame = current.cancelAnimationFrame || ((handle) => window.cancelAnimationFrame(handle));
  const ResizeObserverClass = current.ResizeObserver || globalThis.ResizeObserver;
  const overscan = current.overscan ?? 20;
  const initialTailCount = current.initialTailCount ?? 80;
  const maxMounted = current.maxMounted ?? 140;
  const gap = current.gap ?? 0;
  let virtualizer: CoreVirtualizer;

  const indexForKey = (key: string) => keys.indexOf(key);
  const estimateAt = (index: number) => {
    const key = keys[index];
    const cached = key ? measured.get(key) : undefined;
    if (cached && cached.revision === (revisions[index] || '')) return cached.size;
    return estimateRenderUnitSize(kinds[index] || 'unknown');
  };
  const extractRange = (range: { startIndex: number; endIndex: number; overscan: number; count: number }) => {
    if (range.count <= 0) return [];
    if (initialTailPending) {
      const start = Math.max(0, range.count - initialTailCount);
      return Array.from({ length: range.count - start }, (_, offset) => start + offset);
    }
    const start = Math.max(0, range.startIndex - range.overscan);
    const end = Math.min(range.count - 1, range.endIndex + range.overscan);
    const indexes = new Set<number>();
    for (let index = start; index <= end; index += 1) indexes.add(index);
    for (const key of keepMountedKeys) {
      const index = indexForKey(key);
      if (index >= 0) indexes.add(index);
    }
    let ordered = [...indexes].sort((a, b) => a - b);
    if (ordered.length > maxMounted) {
      const required = new Set(keepMountedKeys.map(indexForKey).filter((index) => index >= 0));
      const center = Math.floor((range.startIndex + range.endIndex) / 2);
      ordered = ordered
        .sort((a, b) => Number(required.has(b)) - Number(required.has(a)) || Math.abs(a - center) - Math.abs(b - center) || a - b)
        .slice(0, maxMounted)
        .sort((a, b) => a - b);
    }
    return ordered;
  };

  const publishRange = (expectedGeneration = generation) => {
    if (destroyed || expectedGeneration !== generation) return;
    current.onRangeChange?.(plainSnapshot(virtualizer));
  };
  const coreOptions = () => ({
    count: keys.length,
    getScrollElement: () => current.scrollElement,
    estimateSize: estimateAt,
    getItemKey: (index: number) => keys[index],
    overscan,
    gap,
    initialRect: {
      width: Number((current.scrollElement as HTMLElement).clientWidth || 0),
      height: Number((current.scrollElement as HTMLElement).clientHeight || 0),
    },
    initialOffset: Math.max(0, keys.slice(0, Math.max(0, keys.length - initialTailCount)).reduce((sum, _key, index) => sum + estimateAt(index), 0)),
    rangeExtractor: extractRange,
    scrollToFn: elementScroll,
    observeElementRect: (_instance: unknown, callback: (rect: { width: number; height: number }) => void) => {
      const publish = () => callback({
        width: Number((current.scrollElement as HTMLElement).clientWidth || 0),
        height: Number((current.scrollElement as HTMLElement).clientHeight || 0),
      });
      publish();
      const ownerWindow = (current.scrollElement as HTMLElement).ownerDocument?.defaultView;
      ownerWindow?.addEventListener('resize', publish);
      return () => ownerWindow?.removeEventListener('resize', publish);
    },
    observeElementOffset,
    onChange: () => publishRange(),
  });
  virtualizer = new VirtualizerClass(coreOptions());
  const unmount = virtualizer._didMount?.() || (() => undefined);
  virtualizer._willUpdate?.();

  const flushMeasurements = (expectedGeneration: number) => {
    rafHandle = null;
    if (destroyed || expectedGeneration !== generation) return;
    const changedKeys = [...pendingMeasurementKeys];
    pendingMeasurementKeys.clear();
    for (const key of changedKeys) {
      const element = elementByKey.get(key);
      const index = indexForKey(key);
      if (!element || index < 0) continue;
      const rectSize = typeof (element as HTMLElement).getBoundingClientRect === 'function'
        ? (element as HTMLElement).getBoundingClientRect().height
        : Number((element as unknown as { size?: number }).size);
      const size = Number.isFinite(rectSize) ? rectSize : estimateAt(index);
      measured.set(key, { revision: revisions[index] || '', size });
      virtualizer.resizeItem?.(index, size);
    }
    current.onMeasurements?.({ changedKeys, totalSize: virtualizer.getTotalSize() });
    publishRange(expectedGeneration);
  };
  const observer = ResizeObserverClass ? new ResizeObserverClass((entries) => {
    if (destroyed) return;
    for (const entry of Array.from(entries)) {
      const key = keyByElement.get(entry.target);
      if (key) pendingMeasurementKeys.add(key);
    }
    if (pendingMeasurementKeys.size && rafHandle === null) {
      const expectedGeneration = generation;
      rafHandle = requestFrame(() => flushMeasurements(expectedGeneration));
    }
  }) : null;

  return {
    getRange() {
      const snapshot = plainSnapshot(virtualizer);
      initialTailPending = false;
      return snapshot;
    },
    update(update) {
      if (destroyed) return;
      const previousRevision = new Map(keys.map((key, index) => [key, revisions[index] || '']));
      keys = [...update.keys];
      kinds = [...(update.kinds || [])];
      revisions = [...(update.presentationRevisions || [])];
      keepMountedKeys = [...(update.keepMountedKeys || [])];
      for (const [key, cached] of measured) {
        const index = indexForKey(key);
        if (index < 0 || previousRevision.get(key) !== (revisions[index] || '')) {
          measured.delete(key);
          if (index >= 0) virtualizer.resizeItem?.(index, estimateRenderUnitSize(kinds[index] || 'unknown'));
        }
        else measured.set(key, cached);
      }
      virtualizer.setOptions?.(coreOptions());
      virtualizer._willUpdate?.();
      publishRange();
    },
    scrollToKey(key, scrollOptions = {}) {
      if (destroyed) return false;
      const index = indexForKey(key);
      if (index < 0) return false;
      virtualizer.scrollToIndex?.(index, { align: scrollOptions.align || 'auto', behavior: 'auto' });
      return true;
    },
    observeElement(key, element) {
      if (destroyed) return;
      const old = elementByKey.get(key);
      if (old && old !== element) {
        observer?.unobserve(old);
        keyByElement.delete(old);
      }
      elementByKey.set(key, element);
      keyByElement.set(element, key);
      const index = indexForKey(key);
      if ((element as HTMLElement).dataset && index >= 0) (element as HTMLElement).dataset.index = String(index);
      observer?.observe(element);
    },
    unobserveElement(key) {
      const element = elementByKey.get(key);
      if (!element) return;
      observer?.unobserve(element);
      elementByKey.delete(key);
      keyByElement.delete(element);
      pendingMeasurementKeys.delete(key);
    },
    invalidateMeasurement(key) {
      if (destroyed || !elementByKey.has(key)) return;
      measured.delete(key);
      pendingMeasurementKeys.add(key);
      if (rafHandle === null) {
        const expectedGeneration = generation;
        rafHandle = requestFrame(() => flushMeasurements(expectedGeneration));
      }
    },
    setPresentationRevision(key, revision) {
      if (destroyed) return;
      const index = indexForKey(key);
      if (index < 0) return;
      revisions[index] = revision;
      const cached = measured.get(key);
      if (cached) measured.set(key, { ...cached, revision });
    },
    migrateKey(oldKey, newKey) {
      keys = keys.map((key) => key === oldKey ? newKey : key);
      const cached = measured.get(oldKey);
      measured.delete(oldKey);
      if (cached) measured.set(newKey, cached);
      const element = elementByKey.get(oldKey);
      elementByKey.delete(oldKey);
      if (element) {
        elementByKey.set(newKey, element);
        keyByElement.set(element, newKey);
      }
      if (pendingMeasurementKeys.delete(oldKey)) pendingMeasurementKeys.add(newKey);
      keepMountedKeys = keepMountedKeys.map((key) => key === oldKey ? newKey : key);
      virtualizer.setOptions?.(coreOptions());
      virtualizer._willUpdate?.();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      generation += 1;
      if (rafHandle !== null) cancelFrame(rafHandle);
      rafHandle = null;
      pendingMeasurementKeys.clear();
      observer?.disconnect();
      elementByKey.clear();
      keyByElement.clear();
      unmount();
    },
  };
}

function plainSnapshot(virtualizer: CoreVirtualizer): VirtualRangeSnapshot {
  return {
    items: virtualizer.getVirtualItems().map(({ key, index, start, end, size }) => ({
      key: String(key), index, start, end, size,
    })),
    totalSize: virtualizer.getTotalSize(),
  };
}
