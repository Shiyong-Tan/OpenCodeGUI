export type HydrationCoverage =
  | 'authoritativeHistoryComplete'
  | 'deltaContinuityUnknown'
  | 'repairInProgress'
  | 'repairError';

export type LocalOlderState =
  | 'localOlderAvailable'
  | 'localStartReached'
  | 'deltaContinuityUnknown'
  | 'repairInProgress'
  | 'repairError';

export interface LocalOlderPresentation {
  readonly state: LocalOlderState;
  readonly revealStart: number;
  readonly localOlderCount: number;
  readonly label: string;
  readonly hint: string;
  readonly actionable: boolean;
}

export interface LocalHistoryResolution {
  readonly revealStart: number;
  readonly visibleKeys: readonly string[];
  readonly presentation: LocalOlderPresentation;
}

export function deriveLocalOlderPresentation(input: {
  readonly totalUnits: number;
  readonly revealStart: number;
  readonly hydrationCoverage: HydrationCoverage;
}): LocalOlderPresentation {
  const totalUnits = Math.max(0, Math.floor(input.totalUnits));
  const revealStart = Math.min(totalUnits, Math.max(0, Math.floor(input.revealStart)));
  if (revealStart > 0) {
    return {
      state: 'localOlderAvailable', revealStart, localOlderCount: revealStart,
      label: 'Load older', hint: '', actionable: true,
    };
  }
  if (input.hydrationCoverage === 'authoritativeHistoryComplete') {
    return {
      state: 'localStartReached', revealStart: 0, localOlderCount: 0,
      label: 'Start of loaded history', hint: '', actionable: false,
    };
  }
  const terminalByCoverage: Record<Exclude<HydrationCoverage, 'authoritativeHistoryComplete'>, Pick<LocalOlderPresentation, 'state' | 'label' | 'hint'>> = {
    deltaContinuityUnknown: {
      state: 'deltaContinuityUnknown',
      label: 'History synchronization pending',
      hint: 'Loaded local history is shown while continuity is being verified.',
    },
    repairInProgress: {
      state: 'repairInProgress',
      label: 'Synchronizing loaded history',
      hint: 'Checking continuity of loaded history.',
    },
    repairError: {
      state: 'repairError',
      label: 'History synchronization incomplete',
      hint: 'Loaded local history remains available, but continuity could not be verified.',
    },
  };
  return {
    ...terminalByCoverage[normalizeHydrationCoverage(input.hydrationCoverage) as Exclude<HydrationCoverage, 'authoritativeHistoryComplete'>],
    revealStart: 0, localOlderCount: 0, actionable: false,
  };
}

export function normalizeHydrationCoverage(value: unknown): HydrationCoverage {
  if (
    value === 'authoritativeHistoryComplete'
    || value === 'deltaContinuityUnknown'
    || value === 'repairInProgress'
    || value === 'repairError'
  ) return value;
  return 'deltaContinuityUnknown';
}

export function createLocalHistoryPresentationController(options: {
  readonly initialTailCount?: number;
  readonly batchSize?: number;
  readonly maxSessions?: number;
} = {}) {
  const initialTailCount = Math.max(1, Math.floor(options.initialTailCount ?? 80));
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 40));
  const maxSessions = Math.max(1, Math.floor(options.maxSessions ?? 32));
  // Bounded presentation cache only. Canonical messages/history never live here.
  const sessions = new Map<string, { firstRevealedKey: string; inFlight: boolean }>();

  const trimInactiveLru = (protectedSessionId = '') => {
    while (sessions.size > maxSessions) {
      const victim = [...sessions].find(([id, state]) => id !== protectedSessionId && !state.inFlight)?.[0];
      if (!victim) break;
      sessions.delete(victim);
    }
  };

  const touch = (sessionId: string, state: { firstRevealedKey: string; inFlight: boolean }) => {
    sessions.delete(sessionId);
    sessions.set(sessionId, state);
    trimInactiveLru(sessionId);
  };

  const locate = (sessionId: string, keys: readonly string[]) => {
    let state = sessions.get(sessionId);
    let revealStart = state?.firstRevealedKey ? keys.indexOf(state.firstRevealedKey) : -1;
    if (!state || revealStart < 0) {
      revealStart = Math.max(0, keys.length - initialTailCount);
      state = { firstRevealedKey: keys[revealStart] || '', inFlight: false };
    }
    touch(sessionId, state);
    return { state, revealStart };
  };

  return Object.freeze({
    resolve(
      sessionId: string,
      keys: readonly string[],
      hydrationCoverage: HydrationCoverage = 'deltaContinuityUnknown',
    ): LocalHistoryResolution {
      const { revealStart } = locate(sessionId, keys);
      const resolution = {
        revealStart,
        visibleKeys: keys.slice(revealStart),
        presentation: deriveLocalOlderPresentation({ totalUnits: keys.length, revealStart, hydrationCoverage }),
      };
      trimInactiveLru();
      return resolution;
    },
    activate(sessionId: string, keys: readonly string[], _source = 'unknown') {
      const { state, revealStart } = locate(sessionId, keys);
      if (state.inFlight) return { accepted: false, reason: 'in-flight', revealedCount: 0 } as const;
      if (revealStart <= 0) return { accepted: false, reason: 'terminal', revealedCount: 0 } as const;
      const nextStart = Math.max(0, revealStart - batchSize);
      state.firstRevealedKey = keys[nextStart] || '';
      state.inFlight = true;
      touch(sessionId, state);
      trimInactiveLru();
      return { accepted: true, reason: 'accepted', revealedCount: revealStart - nextStart } as const;
    },
    complete(sessionId: string) {
      const state = sessions.get(sessionId);
      if (state) {
        state.inFlight = false;
        touch(sessionId, state);
      }
      trimInactiveLru();
    },
    revealToKey(sessionId: string, keys: readonly string[], key: string) {
      const targetIndex = keys.indexOf(key);
      if (targetIndex < 0) return false;
      const { state, revealStart } = locate(sessionId, keys);
      if (targetIndex < revealStart) state.firstRevealedKey = key;
      touch(sessionId, state);
      trimInactiveLru();
      return true;
    },
    getPresentationCacheSize() {
      return sessions.size;
    },
  });
}
