import { createSessionEventRouter } from '../continuation/session-event-router';

function createHarness(activeSessionId = 'active') {
  const sessions = new Map<string, any>();
  const debug: unknown[][] = [];
  const renders: string[] = [];
  const scrolls: boolean[] = [];
  const router = createSessionEventRouter({
    entries: () => sessions.entries(),
    getActiveSessionId: () => activeSessionId,
    postDebug: (payload) => debug.push(payload),
    warn: () => undefined,
    render: (reason) => renders.push(reason),
    scroll: (force) => scrolls.push(force),
    singleInFlightFallbackEvents: new Set(),
  });
  return { router, sessions, debug, renders, scrolls };
}

describe('cross-session event router', () => {
  test('routes background events to state-only handling and never renders current DOM', () => {
    const { router, renders, scrolls } = createHarness();
    expect(router.resolveEventRoute({ sessionId: 'background' }, 'chatChunk')).toMatchObject({
      sessionId: 'background', isActive: false, shouldRender: false,
    });
    expect(router.renderIfActive('background', 'chatChunk', { scroll: true })).toBe(false);
    expect(renders).toEqual([]);
    expect(scrolls).toEqual([]);
  });

  test('renders and scrolls only for the active session', () => {
    const { router, renders, scrolls } = createHarness();
    expect(router.renderIfActive('active', 'chatDone', { scroll: true, forceScroll: true })).toBe(true);
    expect(renders).toEqual(['chatDone']);
    expect(scrolls).toEqual([true]);
  });

  test('uses agentSessionId as authoritative for agent-lane events', () => {
    const { router } = createHarness('agent-a');
    expect(router.resolveContentRoute({
      sessionId: 'parent-a',
      parentSessionId: 'parent-a',
      agentSessionId: 'agent-a',
      displayTarget: 'agent-lane',
    }, 'messageAppend')).toMatchObject({
      sessionId: 'agent-a', parentSessionId: 'parent-a', isActive: true, shouldRender: true,
    });
  });

  test('never guesses a session when fallback is not explicitly proven', () => {
    const { router, sessions } = createHarness();
    sessions.set('active', { backendTurnInFlight: true });
    expect(router.resolveEventRoute({}, 'chatChunk', { allowSingleInFlightFallback: true })).toBeNull();
  });
});
