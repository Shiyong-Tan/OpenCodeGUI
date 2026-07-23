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

  test('keeps richer colliding assistant content and append metadata during an active turn', () => {
    const before: any = createSessionState();
    before.timeline = ['msg_root', 'msg_assistant'];
    before.messagesById.set('msg_root', {
      id: 'msg_root', role: 'user', text: 'root',
      meta: { appendedPrompts: [{ appendUserMsgId: 'msg_append', text: 'more' }] },
    });
    before.messagesById.set('msg_assistant', {
      id: 'msg_assistant', role: 'assistant', text: 'streamed answer',
      meta: { isThinking: true, subagents: [{ sessionId: 'agent-a', state: 'running' }] },
    });
    before.lastTurnUserId = 'msg_root';
    before.currentTurnAssistantKey = 'msg_assistant';
    before.currentTurnAssistantMsgId = 'msg_assistant';
    before.appendRootUserKey = 'msg_root';
    before.backendTurnInFlight = true;
    before.turnFullyFinalized = false;
    const preserved = controller.capture(before);

    const hydrated: any = createSessionState();
    hydrated.timeline = ['msg_root', 'msg_assistant', 'msg_append'];
    hydrated.messagesById.set('msg_root', { id: 'msg_root', role: 'user', text: 'root', meta: {} });
    hydrated.messagesById.set('msg_assistant', { id: 'msg_assistant', role: 'assistant', text: '', meta: {} });
    hydrated.messagesById.set('msg_append', { id: 'msg_append', role: 'user', text: 'more', meta: {} });

    const result = controller.restore(hydrated, preserved);

    expect(hydrated.messagesById.get('msg_root').meta.appendedPrompts).toEqual([
      { appendUserMsgId: 'msg_append', text: 'more' },
    ]);
    expect(hydrated.messagesById.get('msg_assistant')).toMatchObject({
      text: 'streamed answer',
      meta: { isThinking: true, subagents: [{ sessionId: 'agent-a', state: 'running' }] },
    });
    expect(result.mergedIds).toEqual(['msg_root', 'msg_assistant']);
  });

  test('does not let active metadata shorten newer hydrated assistant text', () => {
    const before: any = createSessionState();
    before.timeline = ['msg_assistant'];
    before.messagesById.set('msg_assistant', {
      id: 'msg_assistant', role: 'assistant', text: 'short', meta: { subagents: [{ sessionId: 'agent-a' }] },
    });
    before.currentTurnAssistantMsgId = 'msg_assistant';
    before.backendTurnInFlight = true;
    before.turnFullyFinalized = false;
    const preserved = controller.capture(before);

    const hydrated: any = createSessionState();
    hydrated.timeline = ['msg_assistant'];
    hydrated.messagesById.set('msg_assistant', {
      id: 'msg_assistant', role: 'assistant', text: 'a newer and longer answer', meta: { parentId: 'msg_root' },
    });
    const result = controller.restore(hydrated, preserved);

    expect(hydrated.messagesById.get('msg_assistant')).toMatchObject({
      text: 'a newer and longer answer',
      meta: { parentId: 'msg_root', subagents: [{ sessionId: 'agent-a' }] },
    });
    expect(result.mergedIds).toEqual(['msg_assistant']);
  });

  test('does not merge colliding volatile records after the turn finalized', () => {
    const before: any = createSessionState();
    before.timeline = ['msg_assistant'];
    before.messagesById.set('msg_assistant', { id: 'msg_assistant', role: 'assistant', text: 'stale live text' });
    before.currentTurnAssistantMsgId = 'msg_assistant';
    before.backendTurnInFlight = false;
    before.turnFullyFinalized = true;
    const preserved = controller.capture(before);

    const hydrated: any = createSessionState();
    hydrated.timeline = ['msg_assistant'];
    hydrated.messagesById.set('msg_assistant', { id: 'msg_assistant', role: 'assistant', text: 'authoritative history' });
    const result = controller.restore(hydrated, preserved);

    expect(hydrated.messagesById.get('msg_assistant').text).toBe('authoritative history');
    expect(result.mergedIds).toEqual([]);
  });
});
