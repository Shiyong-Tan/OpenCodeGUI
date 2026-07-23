export type WebviewTurnPhase =
  | 'idle'
  | 'active'
  | 'main-final'
  | 'effects-finalized'
  | 'failed'
  | 'cancelled';

export type WebviewTurnLifecycle = Readonly<{
  generation: number;
  phase: WebviewTurnPhase;
  backendInFlight: boolean;
  canonicalAssistantId: string | null;
}>;

export type TurnLifecycleSession = {
  turnLifecycle?: WebviewTurnLifecycle;
  backendTurnInFlight?: boolean;
  turnFullyFinalized?: boolean;
  finalAssistantLock?: { assistantMsgId: string; ts: number } | null;
};

export type FinalAcceptance =
  | Readonly<{ accepted: true; idempotent: boolean; state: WebviewTurnLifecycle }>
  | Readonly<{
    accepted: false;
    reason: 'invalid-canonical-id' | 'different-terminal-assistant';
    state: WebviewTurnLifecycle;
  }>;

function isCanonicalId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('msg_');
}

function infer(session: TurnLifecycleSession): WebviewTurnLifecycle {
  if (session.turnLifecycle) return session.turnLifecycle;
  const canonicalAssistantId = isCanonicalId(session.finalAssistantLock?.assistantMsgId)
    ? session.finalAssistantLock!.assistantMsgId
    : null;
  const backendInFlight = session.backendTurnInFlight === true;
  const phase: WebviewTurnPhase = session.turnFullyFinalized === true
    ? 'effects-finalized'
    : canonicalAssistantId
      ? 'main-final'
      : backendInFlight
        ? 'active'
        : 'idle';
  return {
    generation: 0,
    phase,
    backendInFlight,
    canonicalAssistantId,
  };
}

function project(session: TurnLifecycleSession, state: WebviewTurnLifecycle, now: number): void {
  session.turnLifecycle = state;
  session.backendTurnInFlight = state.backendInFlight;
  session.turnFullyFinalized = state.phase === 'effects-finalized'
    || state.phase === 'failed'
    || state.phase === 'cancelled';
  session.finalAssistantLock = state.canonicalAssistantId
    ? { assistantMsgId: state.canonicalAssistantId, ts: now }
    : null;
}

export function createTurnLifecycleController(options: { now?(): number } = {}) {
  const now = options.now || (() => Date.now());

  return Object.freeze({
    read(session: TurnLifecycleSession): WebviewTurnLifecycle {
      return infer(session);
    },

    start(session: TurnLifecycleSession): WebviewTurnLifecycle {
      const current = infer(session);
      const next: WebviewTurnLifecycle = {
        generation: current.generation + 1,
        phase: 'active',
        backendInFlight: false,
        canonicalAssistantId: null,
      };
      project(session, next, now());
      return next;
    },

    setBackendInFlight(
      session: TurnLifecycleSession,
      inFlight: boolean,
    ): WebviewTurnLifecycle {
      const current = infer(session);
      if (
        inFlight
        && (
          current.phase === 'main-final'
          || current.phase === 'effects-finalized'
          || current.phase === 'failed'
          || current.phase === 'cancelled'
        )
      ) {
        return current;
      }
      const next: WebviewTurnLifecycle = {
        ...current,
        phase: current.phase === 'idle' && inFlight ? 'active' : current.phase,
        backendInFlight: inFlight,
      };
      project(session, next, now());
      return next;
    },

    acceptMainFinal(
      session: TurnLifecycleSession,
      assistantId: string,
    ): FinalAcceptance {
      const current = infer(session);
      if (!isCanonicalId(assistantId)) {
        return { accepted: false, reason: 'invalid-canonical-id', state: current };
      }
      if (current.canonicalAssistantId) {
        if (current.canonicalAssistantId === assistantId) {
          return { accepted: true, idempotent: true, state: current };
        }
        return {
          accepted: false,
          reason: 'different-terminal-assistant',
          state: current,
        };
      }
      const next: WebviewTurnLifecycle = {
        ...current,
        phase: 'main-final',
        canonicalAssistantId: assistantId,
      };
      project(session, next, now());
      return { accepted: true, idempotent: false, state: next };
    },

    completeEffects(session: TurnLifecycleSession): WebviewTurnLifecycle {
      const current = infer(session);
      const next: WebviewTurnLifecycle = {
        ...current,
        phase: 'effects-finalized',
        backendInFlight: false,
      };
      project(session, next, now());
      return next;
    },

    cancel(session: TurnLifecycleSession): WebviewTurnLifecycle {
      const current = infer(session);
      const next: WebviewTurnLifecycle = {
        ...current,
        phase: 'cancelled',
        backendInFlight: false,
      };
      project(session, next, now());
      return next;
    },

    fail(session: TurnLifecycleSession): WebviewTurnLifecycle {
      const current = infer(session);
      const next: WebviewTurnLifecycle = {
        ...current,
        phase: 'failed',
        backendInFlight: false,
      };
      project(session, next, now());
      return next;
    },

    canAcceptAssistantActivity(
      session: TurnLifecycleSession,
      assistantId?: string | null,
    ): boolean {
      const current = infer(session);
      if (
        current.phase !== 'main-final'
        && current.phase !== 'effects-finalized'
        && current.phase !== 'failed'
        && current.phase !== 'cancelled'
      ) {
        return true;
      }
      return false;
    },
  });
}
