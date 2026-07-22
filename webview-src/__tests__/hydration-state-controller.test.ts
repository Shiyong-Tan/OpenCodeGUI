import { createHydrationStateController } from '../continuation/hydration-state-controller';
import { createSessionState } from '../continuation/session-store';

const controller = createHydrationStateController({
  toStableMessageKey: (session, key) => session.clientKeyToServerId?.get(key) || null,
  now: () => 1_000,
});

describe('hydration volatile state controller', () => {
  test('restores missing live messages while excluding persistence artifacts', () => {
    const before: any = createSessionState();
    before.timeline = ['local-user', 'system:changeList:one'];
    before.messagesById.set('local-user', { id: 'local-user', role: 'user', text: 'live' });
    before.messagesById.set('system:changeList:one', { id: 'system:changeList:one', role: 'system', meta: { kind: 'changeList' } });
    before.backendTurnInFlight = true;
    before.turnFullyFinalized = false;
    const preserved = controller.capture(before);
    const hydrated: any = createSessionState();
    const result = controller.restore(hydrated, preserved);
    expect(hydrated.timeline).toEqual(['local-user']);
    expect(hydrated.messagesById.has('system:changeList:one')).toBe(false);
    expect(hydrated.backendTurnInFlight).toBe(true);
    expect(hydrated.turnFullyFinalized).toBe(false);
    expect(result).toMatchObject({
      missingIds: ['local-user'],
      skippedArtifacts: { timeline: 1, backing: 1 },
    });
  });

  test('does not resurrect local active-turn aliases already hydrated canonically', () => {
    const before: any = createSessionState();
    before.timeline = ['local-user', 'tmp:assistant'];
    before.messagesById.set('local-user', { id: 'local-user', role: 'user', text: 'prompt' });
    before.messagesById.set('tmp:assistant', { id: 'tmp:assistant', role: 'assistant', text: 'stream' });
    before.clientKeyToServerId.set('local-user', 'msg_user');
    before.pendingAssistantUpgrade = { tmpKey: 'tmp:assistant', assistantMsgId: 'msg_assistant' };
    before.currentTurnAssistantKey = 'tmp:assistant';
    before.backendTurnInFlight = true;
    before.turnFullyFinalized = false;
    const preserved = controller.capture(before);

    const hydrated: any = createSessionState();
    hydrated.timeline = ['msg_user', 'msg_assistant'];
    hydrated.messagesById.set('msg_user', { id: 'msg_user', role: 'user' });
    hydrated.messagesById.set('msg_assistant', { id: 'msg_assistant', role: 'assistant' });
    hydrated.clientKeyToServerId.set('local-user', 'msg_user');
    const result = controller.restore(hydrated, preserved);

    expect(hydrated.timeline).toEqual(['msg_user', 'msg_assistant']);
    expect(hydrated.messagesById.has('local-user')).toBe(false);
    expect(hydrated.messagesById.has('tmp:assistant')).toBe(false);
    expect(hydrated.backendTurnInFlight).toBe(false);
    expect(result.skippedCanonicalizedVolatile).toEqual({ timeline: 2, backing: 2, fields: 3 });
  });
});
