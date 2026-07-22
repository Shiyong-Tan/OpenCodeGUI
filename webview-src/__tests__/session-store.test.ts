import { createSessionState, createSessionStore } from '../continuation/session-store';

describe('Webview session store', () => {
  test('creates independent canonical session state containers', () => {
    const first = createSessionState();
    const second = createSessionState();
    first.timeline.push('msg_a');
    first.messagesById.set('msg_a', { id: 'msg_a' });
    expect(second.timeline).toEqual([]);
    expect(second.messagesById.size).toBe(0);
    expect(first).toMatchObject({
      hydrationCoverage: 'deltaContinuityUnknown',
      backendTurnInFlight: false,
      turnFullyFinalized: true,
      snapshotFinalizeReady: false,
    });
  });

  test('creates only when requested and reports registry ownership', () => {
    const store = createSessionStore();
    expect(store.get('background')).toBeNull();
    const background = store.get('background', true);
    const active = store.get('active', true);
    expect(store.get('background')).toBe(background);
    expect(active).not.toBe(background);
    expect(store.getRegistryInfo('background')).toEqual({ size: 2, hasSession: true });
    expect(store.getRegistryInfo('missing')).toEqual({ size: 2, hasSession: false });
    expect(Array.from(store.entries()).map(([id]) => id)).toEqual(['background', 'active']);
  });
});
