export type SessionSearchMode = 'text' | 'smart';

export type SessionSearchSnapshot = Readonly<{
  open: boolean;
  query: string;
  mode: SessionSearchMode;
  activeIndex: number;
  smartMessageIds: readonly string[];
  smartRequestId: string;
  smartInFlight: boolean;
  fullMatchKeys: readonly string[];
  activeKeyIndex: number;
  windowTargetKey: string;
}>;

export type SessionSearchNavigation = Readonly<{
  mode: SessionSearchMode;
  index: number;
  total: number;
  targetKey: string;
}>;

function uniqueKeys(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string' || !value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function wrapIndex(index: number, delta: number, total: number): number {
  const current = Number.isSafeInteger(index) ? index : -1;
  const step = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  return (current + step + total) % total;
}

export function createSessionSearchState() {
  let open = false;
  let query = '';
  let mode: SessionSearchMode = 'text';
  let activeIndex = -1;
  let smartMessageIds: string[] = [];
  let smartRequestId = '';
  let smartInFlight = false;
  let fullMatchKeys: string[] = [];
  let activeKeyIndex = -1;
  let windowTargetKey = '';

  const snapshot = (): SessionSearchSnapshot => Object.freeze({
    open,
    query,
    mode,
    activeIndex,
    smartMessageIds: Object.freeze([...smartMessageIds]),
    smartRequestId,
    smartInFlight,
    fullMatchKeys: Object.freeze([...fullMatchKeys]),
    activeKeyIndex,
    windowTargetKey,
  });

  const reset = (): void => {
    query = '';
    mode = 'text';
    activeIndex = -1;
    smartMessageIds = [];
    smartRequestId = '';
    smartInFlight = false;
    fullMatchKeys = [];
    activeKeyIndex = -1;
    windowTargetKey = '';
  };

  return {
    snapshot,
    open(): void {
      open = true;
    },
    close(): void {
      open = false;
      reset();
    },
    setTextQuery(value: unknown): void {
      query = typeof value === 'string' ? value : '';
      mode = 'text';
      smartRequestId = '';
      smartInFlight = false;
      activeIndex = -1;
      activeKeyIndex = -1;
      windowTargetKey = '';
    },
    setTextMatchKeys(values: unknown, jumpToFirst = false): void {
      fullMatchKeys = uniqueKeys(values);
      if (jumpToFirst) activeKeyIndex = fullMatchKeys.length ? 0 : -1;
      if (activeKeyIndex >= fullMatchKeys.length) activeKeyIndex = fullMatchKeys.length ? fullMatchKeys.length - 1 : -1;
    },
    clearTextMatches(): void {
      fullMatchKeys = [];
      activeKeyIndex = -1;
      activeIndex = -1;
    },
    setMountedActiveIndex(index: number): void {
      activeIndex = Number.isSafeInteger(index) ? index : -1;
    },
    beginSmartSearch(requestId: string): boolean {
      if (!query.trim() || smartInFlight || !requestId) return false;
      mode = 'smart';
      smartRequestId = requestId;
      smartMessageIds = [];
      smartInFlight = true;
      activeIndex = -1;
      return true;
    },
    completeSmartSearch(requestId: string, messageIds: unknown): boolean {
      if (!requestId || requestId !== smartRequestId) return false;
      const previousIndex = activeIndex;
      mode = 'smart';
      smartInFlight = false;
      smartMessageIds = uniqueKeys(messageIds);
      activeIndex = smartMessageIds.length
        ? Math.min(Math.max(previousIndex, 0), smartMessageIds.length - 1)
        : -1;
      windowTargetKey = activeIndex >= 0 ? smartMessageIds[activeIndex] : '';
      return true;
    },
    failSmartSearch(requestId: string): boolean {
      if (!requestId || requestId !== smartRequestId) return false;
      mode = 'smart';
      smartInFlight = false;
      smartMessageIds = [];
      activeIndex = -1;
      windowTargetKey = '';
      return true;
    },
    navigate(delta: number): SessionSearchNavigation | null {
      const keys = mode === 'text' ? fullMatchKeys : smartMessageIds;
      if (!keys.length) return null;
      if (mode === 'text') {
        activeKeyIndex = wrapIndex(activeKeyIndex, delta, keys.length);
        windowTargetKey = keys[activeKeyIndex];
        return Object.freeze({ mode, index: activeKeyIndex, total: keys.length, targetKey: windowTargetKey });
      }
      activeIndex = wrapIndex(activeIndex, delta, keys.length);
      windowTargetKey = keys[activeIndex];
      return Object.freeze({ mode, index: activeIndex, total: keys.length, targetKey: windowTargetKey });
    },
    setWindowTargetKey(key: unknown): void {
      windowTargetKey = typeof key === 'string' ? key : '';
    },
    clearWindowTargetKey(expectedKey?: string): boolean {
      if (typeof expectedKey === 'string' && expectedKey !== windowTargetKey) return false;
      windowTargetKey = '';
      return true;
    },
    rekey(oldKey: string, newKey: string): void {
      if (!oldKey || !newKey || oldKey === newKey) return;
      smartMessageIds = smartMessageIds.map((key) => key === oldKey ? newKey : key);
      fullMatchKeys = fullMatchKeys.map((key) => key === oldKey ? newKey : key);
      if (windowTargetKey === oldKey) windowTargetKey = newKey;
    },
  };
}

export type SessionSearchState = ReturnType<typeof createSessionSearchState>;
