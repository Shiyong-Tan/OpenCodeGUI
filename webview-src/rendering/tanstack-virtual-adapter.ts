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

export type VirtualAdapterOverscanTier = 20 | 10 | 4;
export type VirtualAdapterInitialTail = 80 | 40 | 24;

export interface VirtualAdapterRangePolicy {
  readonly overscanTier: VirtualAdapterOverscanTier;
  readonly beforeReserve: number;
  readonly afterReserve: number;
  readonly initialTail: VirtualAdapterInitialTail;
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
  readonly initialOwnerMode?: 'active' | 'deferred-transaction';
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
  getInitialOwnerState(): 'deferred' | 'active-pending-completion' | 'active' | 'destroyed';
  getRange(): VirtualRangeSnapshot;
  update(update: VirtualAdapterUpdate): void;
  /** Returns false and queues replay when a shadow transaction is open or prepared. */
  scrollToKey(key: string, options?: { readonly align?: 'start' | 'center' | 'end' | 'auto' }): boolean;
  observeElement(key: string, element: Element): void;
  unobserveElement(key: string): void;
  invalidateMeasurement(key: string): void;
  setPresentationRevision(key: string, revision: string): void;
  migrateKey(oldKey: string, newKey: string): void;
  beginTransaction(update: VirtualAdapterUpdate): VirtualAdapterTransaction | null;
  destroy(): void;
}

export type VirtualAdapterUpdate = Pick<VirtualAdapterOptions, 'keys' | 'kinds' | 'presentationRevisions' | 'keepMountedKeys'> & {
  readonly rangePolicy?: VirtualAdapterRangePolicy;
};

export interface VirtualAdapterTransaction {
  getRange(): VirtualRangeSnapshot;
  update(update: VirtualAdapterUpdate): void;
  observeElement(key: string, element: Element): void;
  unobserveElement(key: string): void;
  invalidateMeasurement(key: string): void;
  setPresentationRevision(key: string, revision: string): void;
  migrateKey(oldKey: string, newKey: string): void;
  prepareCommit(): boolean;
  commit(): boolean;
  finalizeCommit(): boolean;
  retryCompletion(): boolean;
  isFinalized(): boolean;
  isDegraded(): boolean;
  hasPendingCompletion(): boolean;
  abort(): boolean;
}

interface AdapterStateSeed {
  readonly initialTailPending: boolean;
  readonly scrollOffset?: number;
  readonly rangePolicy: ResolvedRangePolicy;
  readonly measured: Map<string, { revision: string; size: number }>;
  readonly elements: Map<string, Element>;
  readonly pendingMeasurementKeys: Set<string>;
}

interface ResolvedRangePolicy {
  readonly overscanTier: number;
  readonly beforeReserve: number;
  readonly afterReserve: number;
  readonly initialTail: number;
}

type SingleAdapterOptions = VirtualAdapterOptions & { readonly rangePolicy?: VirtualAdapterRangePolicy };

interface SingleAdapter extends TanStackVirtualAdapter {
  _preflightFinalize(): VirtualRangeSnapshot;
  _activate(): void;
  _detachObservations(): void;
  _release(): void;
  _exportState(): AdapterStateSeed & { readonly keys: readonly string[] };
  _publish(snapshot: VirtualRangeSnapshot): void;
  _publishMeasurements(): void;
  _setCallbacksSuppressed(suppressed: boolean): void;
}

interface SingleAdapterControl {
  readonly deferred?: boolean;
  readonly seed?: AdapterStateSeed;
}

type ConflictIntent =
  | { kind: 'update'; update: VirtualAdapterUpdate }
  | { kind: 'observe'; key: string; element: Element }
  | { kind: 'unobserve'; key: string }
  | { kind: 'invalidate'; key: string }
  | { kind: 'revision'; key: string; revision: string }
  | { kind: 'migrate'; oldKey: string; newKey: string }
  | { kind: 'scroll'; key: string; options?: { readonly align?: 'start' | 'center' | 'end' | 'auto' } };

interface TransactionEntry {
  phase: 'open' | 'prepared' | 'sealed' | 'failed' | 'aborted' | 'finalized';
  update: VirtualAdapterUpdate;
  candidate: SingleAdapter | null;
  old: SingleAdapter | null;
  conflicts: ConflictIntent[];
  snapshot: VirtualRangeSnapshot | null;
  completion: {
    detachOld: boolean;
    attachNew: boolean;
    releaseOld: boolean;
    rangeCallback: boolean;
    measurementCallback: boolean;
  };
  degraded: boolean;
}

function cloneVirtualAdapterUpdate(update: VirtualAdapterUpdate): VirtualAdapterUpdate {
  return {
    keys: [...update.keys],
    kinds: update.kinds ? [...update.kinds] : undefined,
    presentationRevisions: update.presentationRevisions ? [...update.presentationRevisions] : undefined,
    keepMountedKeys: update.keepMountedKeys ? [...update.keepMountedKeys] : undefined,
    rangePolicy: update.rangePolicy === undefined ? undefined : cloneRangePolicy(update.rangePolicy),
  };
}

const RANGE_POLICY_KEYS = ['afterReserve', 'beforeReserve', 'initialTail', 'overscanTier'] as const;

function cloneRangePolicy(value: VirtualAdapterRangePolicy): VirtualAdapterRangePolicy {
  const candidate = value as unknown as Record<string, unknown>;
  const keys = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(candidate).sort()
    : [];
  const overscanTier = candidate?.overscanTier;
  const beforeReserve = candidate?.beforeReserve;
  const afterReserve = candidate?.afterReserve;
  const initialTail = candidate?.initialTail;
  const valid = keys.length === RANGE_POLICY_KEYS.length
    && keys.every((key, index) => key === RANGE_POLICY_KEYS[index])
    && (overscanTier === 20 || overscanTier === 10 || overscanTier === 4)
    && Number.isSafeInteger(beforeReserve) && Number(beforeReserve) > 0
    && Number.isSafeInteger(afterReserve) && Number(afterReserve) > 0
    && Number(beforeReserve) + Number(afterReserve) === overscanTier
    && (initialTail === 80 || initialTail === 40 || initialTail === 24);
  if (!valid) throw new RangeError('Invalid virtual adapter range policy');
  return Object.freeze({
    overscanTier,
    beforeReserve: Number(beforeReserve),
    afterReserve: Number(afterReserve),
    initialTail,
  }) as VirtualAdapterRangePolicy;
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
      getInitialOwnerState: () => 'active',
      getRange: () => plainSnapshot(legacy),
      update: () => undefined,
      scrollToKey: () => false,
      observeElement: () => undefined,
      unobserveElement: () => undefined,
      invalidateMeasurement: () => undefined,
      setPresentationRevision: () => undefined,
      migrateKey: () => undefined,
      beginTransaction: () => null,
      destroy: () => undefined,
    };
  }

  const deferredInitialOwner = options.initialOwnerMode === 'deferred-transaction';
  let active: SingleAdapter | null = deferredInitialOwner ? null : createSingleAdapter(options, VirtualizerClass);
  let open: TransactionEntry | null = null;
  let initialTransactionStarted = false;
  let initialEntry: TransactionEntry | null = null;
  let destroyed = false;
  const emptySnapshot = (): VirtualRangeSnapshot => ({ items: [], totalSize: 0 });

  const completeFinalization = (entry: TransactionEntry) => {
    if (entry.phase !== 'finalized' || !entry.candidate || !entry.snapshot) return false;
    const attempt = (key: keyof TransactionEntry['completion'], work: () => void) => {
      if (entry.completion[key]) return;
      try {
        work();
        entry.completion[key] = true;
      } catch {
        entry.degraded = true;
        // The aggregate owner barrier has already crossed. Leave only this task
        // unfinished so a bounded retry cannot repeat completed side effects.
      }
    };
    attempt('detachOld', () => entry.old?._detachObservations());
    attempt('attachNew', () => entry.candidate?._activate());
    attempt('releaseOld', () => entry.old?._release());
    const cleanupComplete = entry.completion.detachOld && entry.completion.attachNew && entry.completion.releaseOld;
    if (cleanupComplete && !entry.completion.rangeCallback) {
      try {
        entry.candidate._publish(entry.snapshot);
        entry.completion.rangeCallback = true;
      } catch { entry.degraded = true; }
    }
    if (cleanupComplete && !entry.completion.measurementCallback) {
      try {
        entry.candidate._publishMeasurements();
        entry.completion.measurementCallback = true;
      } catch { entry.degraded = true; }
    }
    return Object.values(entry.completion).every(Boolean);
  };

  const transaction = (entry: TransactionEntry): VirtualAdapterTransaction => ({
    getRange() {
      if (!entry.candidate || entry.phase !== 'prepared') return active?.getRange() || emptySnapshot();
      return entry.candidate.getRange();
    },
    update(update) {
      const staged = cloneVirtualAdapterUpdate(update);
      if (entry.phase === 'open') entry.update = staged;
      else if (entry.phase === 'prepared') {
        if (staged.rangePolicy !== undefined) throw new Error('Virtual adapter range policy is immutable after prepare');
        entry.candidate?.update(staged);
      }
    },
    observeElement(key, element) {
      if (entry.phase === 'prepared') entry.candidate?.observeElement(key, element);
    },
    unobserveElement(key) {
      if (entry.phase === 'prepared') entry.candidate?.unobserveElement(key);
    },
    invalidateMeasurement(key) {
      if (entry.phase === 'prepared') entry.candidate?.invalidateMeasurement(key);
    },
    setPresentationRevision(key, revision) {
      if (entry.phase === 'prepared') entry.candidate?.setPresentationRevision(key, revision);
    },
    migrateKey(oldKey, newKey) {
      if (entry.phase === 'prepared') entry.candidate?.migrateKey(oldKey, newKey);
    },
    prepareCommit() {
      if (entry.phase !== 'open' || open !== entry) return false;
      try {
        const activeSeed = active?._exportState();
        entry.candidate = createSingleAdapter({ ...options, ...entry.update }, VirtualizerClass, {
          deferred: true,
          seed: activeSeed ? { ...activeSeed, initialTailPending: false } : undefined,
        });
        entry.phase = 'prepared';
        return true;
      } catch {
        entry.candidate?.destroy();
        entry.phase = 'failed';
        return false;
      }
    },
    commit() {
      if (entry.phase !== 'prepared' || open !== entry || entry.conflicts.length || !entry.candidate) return false;
      entry.phase = 'sealed';
      return true;
    },
    finalizeCommit() {
      if (entry.phase !== 'sealed' || open !== entry || !entry.candidate || entry.conflicts.length) return false;
      try {
        entry.snapshot = entry.candidate._preflightFinalize();
      } catch {
        return false;
      }

      // No throwable work belongs between these assignments. `active` is the
      // complete public-owner tuple; callbacks stay suppressed on both owners
      // until the aggregate ownership barrier is consistent.
      entry.old = active;
      entry.old?._setCallbacksSuppressed(true);
      active = entry.candidate;
      entry.phase = 'finalized';
      open = null;
      completeFinalization(entry);
      return true;
    },
    retryCompletion() {
      if (entry.phase !== 'finalized') return false;
      return completeFinalization(entry);
    },
    isFinalized() {
      return entry.phase === 'finalized';
    },
    isDegraded() {
      return entry.phase === 'finalized' && entry.degraded;
    },
    hasPendingCompletion() {
      return entry.phase === 'finalized' && !Object.values(entry.completion).every(Boolean);
    },
    abort() {
      if (open !== entry || entry.phase === 'aborted' || entry.phase === 'finalized') return false;
      entry.candidate?.destroy();
      entry.phase = 'aborted';
      open = null;
      for (const intent of entry.conflicts) {
        if (intent.kind === 'update') active?.update(intent.update);
        else if (intent.kind === 'observe') active?.observeElement(intent.key, intent.element);
        else if (intent.kind === 'unobserve') active?.unobserveElement(intent.key);
        else if (intent.kind === 'invalidate') active?.invalidateMeasurement(intent.key);
        else if (intent.kind === 'revision') active?.setPresentationRevision(intent.key, intent.revision);
        else if (intent.kind === 'migrate') active?.migrateKey(intent.oldKey, intent.newKey);
        else active?.scrollToKey(intent.key, intent.options);
      }
      return true;
    },
  });

  // Public live-owner mutations conflict with an open candidate: stage one mixed-order
  // log, deny commit, and replay only after abort has restored the retained owner.
  const conflicts = () => open && (open.phase === 'open' || open.phase === 'prepared' || open.phase === 'sealed') ? open : null;
  return {
    getInitialOwnerState() {
      if (destroyed) return 'destroyed';
      if (!active) return 'deferred';
      if (initialEntry?.phase === 'finalized' && !Object.values(initialEntry.completion).every(Boolean)) {
        return 'active-pending-completion';
      }
      return 'active';
    },
    getRange: () => active?.getRange() || emptySnapshot(),
    update(update) {
      if (update.rangePolicy !== undefined) {
        cloneRangePolicy(update.rangePolicy);
        throw new Error('Virtual adapter range policy requires a transaction');
      }
      if (!active) return;
      const entry = conflicts();
      if (entry) {
        const staged = cloneVirtualAdapterUpdate(update);
        entry.conflicts.push({ kind: 'update', update: staged });
      } else active.update(update);
    },
    scrollToKey(key, scrollOptions) {
      if (!active) return false;
      const entry = conflicts();
      if (!entry) return active.scrollToKey(key, scrollOptions);
      entry.conflicts.push({ kind: 'scroll', key, options: scrollOptions });
      return false;
    },
    observeElement(key, element) {
      if (!active) return;
      const entry = conflicts();
      if (entry) entry.conflicts.push({ kind: 'observe', key, element });
      else active.observeElement(key, element);
    },
    unobserveElement(key) {
      if (!active) return;
      const entry = conflicts();
      if (entry) entry.conflicts.push({ kind: 'unobserve', key });
      else active.unobserveElement(key);
    },
    invalidateMeasurement(key) {
      if (!active) return;
      const entry = conflicts();
      if (entry) entry.conflicts.push({ kind: 'invalidate', key });
      else active.invalidateMeasurement(key);
    },
    setPresentationRevision(key, revision) {
      if (!active) return;
      const entry = conflicts();
      if (entry) entry.conflicts.push({ kind: 'revision', key, revision });
      else active.setPresentationRevision(key, revision);
    },
    migrateKey(oldKey, newKey) {
      if (!active) return;
      const entry = conflicts();
      if (entry) {
        entry.conflicts.push({ kind: 'migrate', oldKey, newKey });
      } else active.migrateKey(oldKey, newKey);
    },
    beginTransaction(update) {
      if (destroyed || open || (!active && initialTransactionStarted)) return null;
      const initialAttempt = active === null;
      if (initialAttempt) initialTransactionStarted = true;
      const entry: TransactionEntry = {
        phase: 'open', update: cloneVirtualAdapterUpdate(update), candidate: null, old: null, conflicts: [], snapshot: null,
        completion: {
          detachOld: initialAttempt, attachNew: false, releaseOld: initialAttempt,
          rangeCallback: false, measurementCallback: false,
        },
        degraded: false,
      };
      if (initialAttempt) initialEntry = entry;
      open = entry;
      return transaction(entry);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      if (open) {
        open.candidate?.destroy();
        open.old?.destroy();
        open = null;
      }
      active?.destroy();
      active = null;
    },
  };
}

function createSingleAdapter(
  options: SingleAdapterOptions,
  VirtualizerClass: VirtualizerConstructor,
  control: SingleAdapterControl = {},
): SingleAdapter {

  let current = options;
  let keys = [...current.keys];
  let kinds = [...(current.kinds || [])];
  let revisions = [...(current.presentationRevisions || [])];
  let keepMountedKeys = [...(current.keepMountedKeys || [])];
  let destroyed = false;
  let initialTailPending = control.seed?.initialTailPending ?? true;
  let generation = 1;
  let rafHandle: number | null = null;
  const elementByKey = new Map<string, Element>(control.seed?.elements);
  const keyByElement = new Map<Element, string>();
  for (const [key, element] of elementByKey) keyByElement.set(element, key);
  const measured = new Map<string, { revision: string; size: number }>(control.seed?.measured);
  const pendingMeasurementKeys = new Set<string>(control.seed?.pendingMeasurementKeys);
  const requestFrame = current.requestAnimationFrame || ((callback) => window.requestAnimationFrame(callback));
  const cancelFrame = current.cancelAnimationFrame || ((handle) => window.cancelAnimationFrame(handle));
  const ResizeObserverClass = current.ResizeObserver || globalThis.ResizeObserver;
  const inheritedPolicy = control.seed?.rangePolicy;
  const selectedPolicy = current.rangePolicy;
  const rangePolicy: ResolvedRangePolicy = Object.freeze(selectedPolicy ? {
    overscanTier: selectedPolicy.overscanTier,
    beforeReserve: selectedPolicy.beforeReserve,
    afterReserve: selectedPolicy.afterReserve,
    initialTail: selectedPolicy.initialTail,
  } : inheritedPolicy || {
    overscanTier: current.overscan ?? 20,
    beforeReserve: current.overscan ?? 20,
    afterReserve: current.overscan ?? 20,
    initialTail: current.initialTailCount ?? 80,
  });
  const overscan = rangePolicy.overscanTier;
  const initialTailCount = rangePolicy.initialTail;
  const maxMounted = current.maxMounted ?? 140;
  const gap = current.gap ?? 0;
  const inheritedScrollOffset = Number.isFinite(control.seed?.scrollOffset) && Number(control.seed?.scrollOffset) >= 0
    ? Number(control.seed?.scrollOffset) : undefined;
  let virtualizer: CoreVirtualizer;
  let mounted = false;
  let coreMounted = false;
  let coreUpdated = false;
  let observationsDetached = false;
  let released = false;
  const attachedElements = new Set<Element>();
  let observer: ResizeObserverLike | null = null;
  let callbacksSuppressed = Boolean(control.deferred);
  let suppressedMeasurementBatch: MeasurementBatch | null = null;

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
    const start = Math.max(0, range.startIndex - rangePolicy.beforeReserve);
    const end = Math.min(range.count - 1, range.endIndex + rangePolicy.afterReserve);
    const requiredIndexes: number[] = [];
    const indexes = new Set<number>();
    for (let index = start; index <= end; index += 1) {
      requiredIndexes.push(index);
      indexes.add(index);
    }
    for (const key of keepMountedKeys) {
      const index = indexForKey(key);
      if (index >= 0 && index < range.count) indexes.add(index);
    }
    let ordered = [...indexes].sort((a, b) => a - b);
    if (ordered.length > maxMounted) {
      const center = Math.floor((range.startIndex + range.endIndex) / 2);
      const required = new Set(requiredIndexes);
      const retainedRequired = requiredIndexes.length <= maxMounted
        ? requiredIndexes
        : [...requiredIndexes]
          .sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b)
          .slice(0, maxMounted);
      const optionalCapacity = Math.max(0, maxMounted - retainedRequired.length);
      const optional = ordered
        .filter((index) => !required.has(index))
        .sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b)
        .slice(0, optionalCapacity);
      ordered = [...retainedRequired, ...optional]
        .sort((a, b) => a - b);
    }
    return ordered;
  };

  const publishRange = (expectedGeneration = generation) => {
    if (destroyed || callbacksSuppressed || expectedGeneration !== generation) return;
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
    initialOffset: inheritedScrollOffset ?? Math.max(0, keys.slice(0, Math.max(0, keys.length - initialTailCount)).reduce((sum, _key, index) => sum + estimateAt(index), 0)),
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
  let unmount: () => void = () => undefined;
  const activate = () => {
    if (destroyed || mounted) return;
    if (!coreMounted) {
      unmount = virtualizer._didMount?.() || (() => undefined);
      coreMounted = true;
    }
    if (!coreUpdated) {
      try {
        virtualizer._willUpdate?.();
        coreUpdated = true;
      } catch (error) {
        if (coreMounted) {
          try { unmount(); } finally {
            coreMounted = false;
            unmount = () => undefined;
          }
        }
        throw error;
      }
    }
    const measurementObserver = ensureObserver();
    for (const [key, element] of elementByKey) {
      if (attachedElements.has(element)) continue;
      const index = indexForKey(key);
      const htmlElement = element as HTMLElement;
      if (htmlElement.dataset && index >= 0) htmlElement.dataset.index = String(index);
      measurementObserver?.observe(element);
      attachedElements.add(element);
    }
    if (pendingMeasurementKeys.size) flushMeasurements(generation);
    mounted = true;
  };
  const flushMeasurements = (expectedGeneration: number) => {
    rafHandle = null;
    if (destroyed || expectedGeneration !== generation) return;
    const pendingKeys = [...pendingMeasurementKeys];
    pendingMeasurementKeys.clear();
    const changedKeys: string[] = [];
    for (const key of pendingKeys) {
      const element = elementByKey.get(key);
      const index = indexForKey(key);
      if (!element || index < 0) continue;
      const rectSize = typeof (element as HTMLElement).getBoundingClientRect === 'function'
        ? (element as HTMLElement).getBoundingClientRect().height
        : Number((element as unknown as { size?: number }).size);
      const size = Number.isFinite(rectSize) ? rectSize : estimateAt(index);
      const revision = revisions[index] || '';
      const cached = measured.get(key);
      if (cached?.revision === revision && cached.size === size) continue;
      changedKeys.push(key);
      measured.set(key, { revision, size });
      virtualizer.resizeItem?.(index, size);
    }
    if (!changedKeys.length) return;
    const batch = { changedKeys, totalSize: virtualizer.getTotalSize() };
    if (!callbacksSuppressed) current.onMeasurements?.(batch);
    else suppressedMeasurementBatch = batch;
    publishRange(expectedGeneration);
  };
  const ensureObserver = () => {
    if (!observer && ResizeObserverClass) {
      observer = new ResizeObserverClass((entries) => {
        if (destroyed || callbacksSuppressed) return;
        for (const entry of Array.from(entries)) {
          const key = keyByElement.get(entry.target);
          if (key) pendingMeasurementKeys.add(key);
        }
        if (pendingMeasurementKeys.size && rafHandle === null) {
          const expectedGeneration = generation;
          rafHandle = requestFrame(() => flushMeasurements(expectedGeneration));
        }
      });
    }
    return observer;
  };
  if (!control.deferred) activate();

  return {
    getInitialOwnerState: () => destroyed ? 'destroyed' : 'active',
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
      if (mounted && (element as HTMLElement).dataset && index >= 0) (element as HTMLElement).dataset.index = String(index);
      if (mounted) observer?.observe(element);
    },
    unobserveElement(key) {
      const element = elementByKey.get(key);
      if (!element) return;
      if (mounted) observer?.unobserve(element);
      elementByKey.delete(key);
      keyByElement.delete(element);
      pendingMeasurementKeys.delete(key);
    },
    invalidateMeasurement(key) {
      if (destroyed || !elementByKey.has(key)) return;
      measured.delete(key);
      pendingMeasurementKeys.add(key);
      if (mounted && rafHandle === null) {
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
    beginTransaction: () => null,
    _activate() {
      activate();
    },
    _preflightFinalize() {
      if (destroyed || mounted || typeof virtualizer.getVirtualItems !== 'function' || typeof virtualizer.getTotalSize !== 'function') {
        throw new Error('Virtual adapter candidate is not ready to finalize');
      }
      return this.getRange();
    },
    _detachObservations() {
      if (observationsDetached) return;
      observer?.disconnect();
      observationsDetached = true;
    },
    _release() {
      if (released) return;
      if (!destroyed) {
        destroyed = true;
        generation += 1;
        if (rafHandle !== null) cancelFrame(rafHandle);
        rafHandle = null;
        pendingMeasurementKeys.clear();
      }
      if (coreMounted) {
        unmount();
        coreMounted = false;
      }
      elementByKey.clear();
      keyByElement.clear();
      attachedElements.clear();
      released = true;
    },
    _exportState() {
      let scrollOffset: number | undefined;
      try {
        const liveOffset = Number((current.scrollElement as HTMLElement).scrollTop);
        if (Number.isFinite(liveOffset) && liveOffset >= 0) scrollOffset = liveOffset;
      } catch { /* unavailable live DOM offset retains the tail-derived fallback */ }
      return {
        keys: [...keys],
        initialTailPending,
        scrollOffset,
        rangePolicy,
        measured: new Map(measured),
        elements: new Map(elementByKey),
        pendingMeasurementKeys: new Set(pendingMeasurementKeys),
      };
    },
    _publish(snapshot) {
      if (!destroyed) {
        callbacksSuppressed = false;
        current.onRangeChange?.(snapshot);
      }
    },
    _publishMeasurements() {
      if (destroyed || !suppressedMeasurementBatch) return;
      const batch = suppressedMeasurementBatch;
      suppressedMeasurementBatch = null;
      current.onMeasurements?.(batch);
    },
    _setCallbacksSuppressed(suppressed) {
      callbacksSuppressed = suppressed;
    },
    destroy() {
      if (released) return;
      try { observer?.disconnect(); } finally { observationsDetached = true; }
      this._release();
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
