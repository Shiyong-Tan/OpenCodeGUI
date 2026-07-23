import {
  createReferenceGlobalState,
  dispatchReferenceGlobal,
  projectReferenceSession,
  ReferenceGlobalEvent,
  runReferenceSingleSession,
  runReferenceTrace,
} from './helpers/session-isolation-reference-model';

const trace: ReferenceGlobalEvent[] = [
  { type: 'turn-started', sessionId: 'A', generation: 1, sequence: 1, userText: 'prompt A', assistantEntityId: 'entity:A:1' },
  { type: 'assistant-chunk', sessionId: 'A', generation: 1, sequence: 2, text: 'A one. ' },
  { type: 'session-selected', sessionId: 'B' },
  { type: 'turn-started', sessionId: 'B', generation: 1, sequence: 1, userText: 'prompt B', assistantEntityId: 'entity:B:1' },
  { type: 'append-added', sessionId: 'A', generation: 1, sequence: 3, appendId: 'append:A:1', text: 'more A' },
  { type: 'assistant-chunk', sessionId: 'B', generation: 1, sequence: 2, text: 'B answer.' },
  { type: 'subagent-status', sessionId: 'A', generation: 1, sequence: 4, subagentId: 'agent:A:1', state: 'running' },
  { type: 'assistant-canonicalized', sessionId: 'A', generation: 1, sequence: 5, canonicalId: 'msg_assistant_A' },
  { type: 'turn-finalized', sessionId: 'A', generation: 1, sequence: 6, canonicalId: 'msg_assistant_A', finalText: 'A one. A final.' },
  { type: 'assistant-canonicalized', sessionId: 'B', generation: 1, sequence: 3, canonicalId: 'msg_assistant_B' },
  { type: 'turn-finalized', sessionId: 'B', generation: 1, sequence: 4, canonicalId: 'msg_assistant_B', finalText: 'B answer.' },
  { type: 'session-selected', sessionId: 'A' },
];

describe('cross-session single-session reference model', () => {
  test('proves interleaving equivalence for independently active sessions', () => {
    const global = runReferenceTrace(trace);

    for (const sessionId of ['A', 'B']) {
      expect(projectReferenceSession(global, sessionId)).toEqual(
        runReferenceSingleSession(sessionId, trace),
      );
    }
    expect(projectReferenceSession(global, 'A')).toMatchObject({
      phase: 'finalized',
      assistantCanonicalId: 'msg_assistant_A',
      assistantText: 'A one. A final.',
      appendPrompts: [{ id: 'append:A:1', text: 'more A', status: 'queued' }],
      subagents: [{ id: 'agent:A:1', state: 'done' }],
    });
    expect(projectReferenceSession(global, 'B')).toMatchObject({
      phase: 'finalized',
      assistantCanonicalId: 'msg_assistant_B',
      assistantText: 'B answer.',
    });
  });

  test('proves non-interference after every event owned by another session', () => {
    let global = runReferenceTrace([
      { type: 'turn-started', sessionId: 'B', generation: 1, sequence: 1, userText: 'B', assistantEntityId: 'entity:B:1' },
      { type: 'assistant-chunk', sessionId: 'B', generation: 1, sequence: 2, text: 'stable B' },
    ]);
    const beforeB = projectReferenceSession(global, 'B');
    const eventsForA = trace.filter((event) => event.type !== 'session-selected' && event.sessionId === 'A');

    for (const event of eventsForA) {
      global = dispatchReferenceGlobal(global, event);
      expect(projectReferenceSession(global, 'B')).toEqual(beforeB);
    }
  });

  test('makes selection render-only and requests bottom scrolling on every return', () => {
    let global = runReferenceTrace(trace.filter((event) => event.type !== 'session-selected'));
    const sessionsBefore = global.sessions;
    const aBefore = projectReferenceSession(global, 'A');
    const bBefore = projectReferenceSession(global, 'B');

    global = dispatchReferenceGlobal(global, { type: 'session-selected', sessionId: 'B' });
    global = dispatchReferenceGlobal(global, { type: 'session-selected', sessionId: 'A' });
    global = dispatchReferenceGlobal(global, { type: 'session-selected', sessionId: 'A' });

    expect(global.sessions).toBe(sessionsBefore);
    expect(projectReferenceSession(global, 'A')).toBe(aBefore);
    expect(projectReferenceSession(global, 'B')).toBe(bBefore);
    expect(global.visibleSessionId).toBe('A');
    expect(global.scrollToBottomRequests).toEqual(new Map([['B', 1], ['A', 2]]));
  });

  test('makes main-assistant finality terminal under delayed same-turn traffic', () => {
    const terminal = runReferenceTrace(trace);
    const before = projectReferenceSession(terminal, 'A');
    const delayed: ReferenceGlobalEvent[] = [
      { type: 'assistant-chunk', sessionId: 'A', generation: 1, sequence: 7, text: 'stale chunk' },
      { type: 'subagent-status', sessionId: 'A', generation: 1, sequence: 8, subagentId: 'agent:A:1', state: 'running' },
      { type: 'assistant-canonicalized', sessionId: 'A', generation: 1, sequence: 9, canonicalId: 'msg_wrong' },
      { type: 'turn-finalized', sessionId: 'A', generation: 1, sequence: 10, canonicalId: 'msg_wrong', finalText: 'wrong' },
    ];
    const after = delayed.reduce(dispatchReferenceGlobal, terminal);

    expect(projectReferenceSession(after, 'A')).toBe(before);
    expect(projectReferenceSession(after, 'A')).toMatchObject({
      phase: 'finalized',
      assistantCanonicalId: 'msg_assistant_A',
      assistantText: 'A one. A final.',
      subagents: [{ id: 'agent:A:1', state: 'done' }],
    });
  });

  test('drops old generations, duplicate sequences, and future events without a turn start', () => {
    const initial = createReferenceGlobalState();
    const started = dispatchReferenceGlobal(initial, {
      type: 'turn-started',
      sessionId: 'A',
      generation: 2,
      sequence: 1,
      userText: 'new',
      assistantEntityId: 'entity:A:2',
    });
    const events: ReferenceGlobalEvent[] = [
      { type: 'assistant-chunk', sessionId: 'A', generation: 1, sequence: 100, text: 'old generation' },
      { type: 'assistant-chunk', sessionId: 'A', generation: 2, sequence: 1, text: 'duplicate sequence' },
      { type: 'assistant-chunk', sessionId: 'A', generation: 3, sequence: 1, text: 'future without start' },
    ];
    const result = events.reduce(dispatchReferenceGlobal, started);

    expect(projectReferenceSession(result, 'A')).toBe(projectReferenceSession(started, 'A'));
    expect(projectReferenceSession(result, 'A').assistantText).toBe('');
  });
});
