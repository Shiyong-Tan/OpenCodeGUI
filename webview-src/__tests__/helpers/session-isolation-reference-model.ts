export type ReferenceTurnPhase = 'idle' | 'streaming' | 'finalized' | 'failed' | 'cancelled';

export type ReferenceAppendPrompt = {
  id: string;
  text: string;
  status: 'queued' | 'applied' | 'failed';
};

export type ReferenceSubagent = {
  id: string;
  state: 'running' | 'done' | 'failed';
};

export type ReferenceSessionState = {
  sessionId: string;
  generation: number;
  lastSequence: number;
  phase: ReferenceTurnPhase;
  userText: string;
  assistantEntityId: string | null;
  assistantCanonicalId: string | null;
  assistantText: string;
  appendPrompts: ReferenceAppendPrompt[];
  subagents: ReferenceSubagent[];
};

type OwnedEventBase = {
  sessionId: string;
  generation: number;
  sequence: number;
};

export type ReferenceSessionEvent =
  | (OwnedEventBase & { type: 'turn-started'; userText: string; assistantEntityId: string })
  | (OwnedEventBase & { type: 'assistant-chunk'; text: string })
  | (OwnedEventBase & { type: 'assistant-canonicalized'; canonicalId: string })
  | (OwnedEventBase & { type: 'append-added'; appendId: string; text: string })
  | (OwnedEventBase & { type: 'append-status'; appendId: string; status: 'applied' | 'failed' })
  | (OwnedEventBase & { type: 'subagent-status'; subagentId: string; state: 'running' | 'done' | 'failed' })
  | (OwnedEventBase & { type: 'turn-finalized'; canonicalId: string; finalText: string })
  | (OwnedEventBase & { type: 'turn-failed' })
  | (OwnedEventBase & { type: 'turn-cancelled' });

export type ReferenceGlobalEvent =
  | ReferenceSessionEvent
  | { type: 'session-selected'; sessionId: string };

export type ReferenceGlobalState = {
  sessions: Map<string, ReferenceSessionState>;
  visibleSessionId: string | null;
  scrollToBottomRequests: Map<string, number>;
};

export function createReferenceSessionState(sessionId: string): ReferenceSessionState {
  return {
    sessionId,
    generation: 0,
    lastSequence: 0,
    phase: 'idle',
    userText: '',
    assistantEntityId: null,
    assistantCanonicalId: null,
    assistantText: '',
    appendPrompts: [],
    subagents: [],
  };
}

export function createReferenceGlobalState(): ReferenceGlobalState {
  return {
    sessions: new Map(),
    visibleSessionId: null,
    scrollToBottomRequests: new Map(),
  };
}

function isTerminal(phase: ReferenceTurnPhase): boolean {
  return phase === 'finalized' || phase === 'failed' || phase === 'cancelled';
}

function copySession(state: ReferenceSessionState): ReferenceSessionState {
  return {
    ...state,
    appendPrompts: state.appendPrompts.map((item) => ({ ...item })),
    subagents: state.subagents.map((item) => ({ ...item })),
  };
}

export function reduceReferenceSingleSession(
  previous: ReferenceSessionState,
  event: ReferenceSessionEvent,
): ReferenceSessionState {
  if (event.sessionId !== previous.sessionId) {
    throw new Error(`reference reducer ownership mismatch: ${event.sessionId} != ${previous.sessionId}`);
  }
  if (event.generation < previous.generation) return previous;
  if (event.generation === previous.generation && event.sequence <= previous.lastSequence) return previous;
  if (event.generation > previous.generation && event.type !== 'turn-started') return previous;
  if (event.generation === previous.generation && isTerminal(previous.phase)) return previous;

  if (event.type === 'turn-started') {
    if (event.generation <= previous.generation) return previous;
    return {
      sessionId: previous.sessionId,
      generation: event.generation,
      lastSequence: event.sequence,
      phase: 'streaming',
      userText: event.userText,
      assistantEntityId: event.assistantEntityId,
      assistantCanonicalId: null,
      assistantText: '',
      appendPrompts: [],
      subagents: [],
    };
  }

  const next = copySession(previous);
  next.lastSequence = event.sequence;
  switch (event.type) {
    case 'assistant-chunk':
      next.assistantText += event.text;
      return next;
    case 'assistant-canonicalized':
      next.assistantCanonicalId = event.canonicalId;
      return next;
    case 'append-added':
      next.appendPrompts.push({ id: event.appendId, text: event.text, status: 'queued' });
      return next;
    case 'append-status': {
      const item = next.appendPrompts.find((candidate) => candidate.id === event.appendId);
      if (item) item.status = event.status;
      return next;
    }
    case 'subagent-status': {
      const existing = next.subagents.find((candidate) => candidate.id === event.subagentId);
      if (existing) existing.state = event.state;
      else next.subagents.push({ id: event.subagentId, state: event.state });
      return next;
    }
    case 'turn-finalized':
      next.phase = 'finalized';
      next.assistantCanonicalId = event.canonicalId;
      next.assistantText = event.finalText;
      next.subagents = next.subagents.map((subagent) =>
        subagent.state === 'running' ? { ...subagent, state: 'done' } : subagent,
      );
      return next;
    case 'turn-failed':
      next.phase = 'failed';
      return next;
    case 'turn-cancelled':
      next.phase = 'cancelled';
      return next;
  }
}

export function dispatchReferenceGlobal(
  state: ReferenceGlobalState,
  event: ReferenceGlobalEvent,
): ReferenceGlobalState {
  if (event.type === 'session-selected') {
    const requests = new Map(state.scrollToBottomRequests);
    requests.set(event.sessionId, (requests.get(event.sessionId) || 0) + 1);
    return {
      sessions: state.sessions,
      visibleSessionId: event.sessionId,
      scrollToBottomRequests: requests,
    };
  }

  const sessions = new Map(state.sessions);
  const previous = sessions.get(event.sessionId) || createReferenceSessionState(event.sessionId);
  sessions.set(event.sessionId, reduceReferenceSingleSession(previous, event));
  return {
    sessions,
    visibleSessionId: state.visibleSessionId,
    scrollToBottomRequests: state.scrollToBottomRequests,
  };
}

export function runReferenceTrace(events: readonly ReferenceGlobalEvent[]): ReferenceGlobalState {
  return events.reduce(dispatchReferenceGlobal, createReferenceGlobalState());
}

export function runReferenceSingleSession(
  sessionId: string,
  events: readonly ReferenceGlobalEvent[],
): ReferenceSessionState {
  const owned = events.filter(
    (event): event is ReferenceSessionEvent => event.type !== 'session-selected' && event.sessionId === sessionId,
  );
  return owned.reduce(
    reduceReferenceSingleSession,
    createReferenceSessionState(sessionId),
  );
}

export function projectReferenceSession(
  state: ReferenceGlobalState,
  sessionId: string,
): ReferenceSessionState {
  return state.sessions.get(sessionId) || createReferenceSessionState(sessionId);
}
