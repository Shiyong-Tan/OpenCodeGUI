import {
  decideEnvelopeAcceptance,
  type EnvelopeAcceptance,
  type SessionClock,
  type SessionEnvelope,
} from '../../src/session-runtime/protocol';

export type SessionViewTransition<TState> = Readonly<{
  state: TState;
}>;

export type SessionViewUpdate<TState, TEvent extends SessionEnvelope> = Readonly<{
  sessionId: string;
  state: TState;
  event: TEvent;
  clock: SessionClock;
}>;

export type SessionViewApplyResult =
  | Extract<EnvelopeAcceptance, { accepted: true }>
  | Extract<EnvelopeAcceptance, { accepted: false }>;

export type SessionViewStoreOptions<TState, TEvent extends SessionEnvelope> = Readonly<{
  createInitialState(sessionId: string, sessionEpoch: number): TState;
  reduce(state: TState, event: TEvent): SessionViewTransition<TState>;
}>;

type SessionViewEntry<TState> = {
  state: TState;
  clock: SessionClock | null;
};

export function createSessionViewStore<TState, TEvent extends SessionEnvelope>(
  options: SessionViewStoreOptions<TState, TEvent>,
) {
  const entries = new Map<string, SessionViewEntry<TState>>();
  const listeners = new Set<(update: SessionViewUpdate<TState, TEvent>) => void>();

  function getOrCreateEntry(sessionId: string, sessionEpoch: number): SessionViewEntry<TState> {
    const existing = entries.get(sessionId);
    if (existing) return existing;
    const created = {
      state: options.createInitialState(sessionId, sessionEpoch),
      clock: null,
    };
    entries.set(sessionId, created);
    return created;
  }

  function apply(event: TEvent): SessionViewApplyResult {
    const entry = getOrCreateEntry(event.sessionId, event.sessionEpoch);
    const acceptance = decideEnvelopeAcceptance(entry.clock, event);
    if (!acceptance.accepted) return acceptance;

    const baseState = acceptance.reason === 'new-epoch'
      ? options.createInitialState(event.sessionId, event.sessionEpoch)
      : entry.state;
    const transition = options.reduce(baseState, event);
    entry.state = transition.state;
    entry.clock = acceptance.clock;

    const update = {
      sessionId: event.sessionId,
      state: entry.state,
      event,
      clock: acceptance.clock,
    };
    for (const listener of listeners) listener(update);
    return acceptance;
  }

  return Object.freeze({
    apply,
    get(sessionId: string): TState | undefined {
      return entries.get(sessionId)?.state;
    },
    getClock(sessionId: string): SessionClock | null {
      return entries.get(sessionId)?.clock || null;
    },
    getOrCreate(sessionId: string, sessionEpoch = 1): TState {
      return getOrCreateEntry(sessionId, sessionEpoch).state;
    },
    entries(): IterableIterator<[string, TState]> {
      return Array.from(entries, ([sessionId, entry]) => [sessionId, entry.state] as [string, TState]).values();
    },
    subscribe(listener: (update: SessionViewUpdate<TState, TEvent>) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}
