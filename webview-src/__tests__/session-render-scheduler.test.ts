import { createSessionRenderScheduler } from '../continuation/session-render-scheduler';

describe('session render scheduler', () => {
  test('coalesces active-session metadata and renders the latest reason', () => {
    let activeSessionId = 'session-a';
    let now = 1_000;
    const renders: string[] = [];
    const callbacks: Array<() => void> = [];
    const scheduler = createSessionRenderScheduler({
      getActiveSessionId: () => activeSessionId,
      render: (reason) => renders.push(reason),
      onInactive: () => undefined,
      setTimeout: (callback) => { callbacks.push(callback); return callbacks.length; },
      clearTimeout: () => undefined,
      now: () => now,
      intervalMs: 250,
    });
    expect(scheduler.schedule('session-a', 'first')).toBe(true);
    expect(scheduler.schedule('session-a', 'latest')).toBe(true);
    expect(callbacks).toHaveLength(1);
    callbacks[0]();
    expect(renders).toEqual(['latest']);
    now += 10;
    scheduler.schedule('session-a', 'terminal', { immediate: true });
    expect(renders).toEqual(['latest', 'terminal']);
    activeSessionId = 'session-b';
  });

  test('never schedules rendering for a background session', () => {
    const inactive: string[] = [];
    const setTimeout = jest.fn();
    const scheduler = createSessionRenderScheduler({
      getActiveSessionId: () => 'session-a',
      render: jest.fn(),
      onInactive: (sessionId) => inactive.push(sessionId),
      setTimeout,
      clearTimeout: jest.fn(),
      now: () => 100,
      intervalMs: 250,
    });
    expect(scheduler.schedule('session-b', 'background')).toBe(false);
    expect(inactive).toEqual(['session-b']);
    expect(setTimeout).not.toHaveBeenCalled();
  });
});
