import { createMessageIdentityStore } from '../session-runtime/message-identity';
import { createMessageRekeyController } from '../session-runtime/message-rekey-controller';

function session() {
  return {
    messagesById: new Map<string, any>(),
    timeline: [] as string[],
    segmentsByNoticeKey: new Map<string, any>(),
    clientKeyToServerId: new Map<string, string>(),
    serverIdToClientKey: new Map<string, string>(),
    appendComposerDrafts: new Map<string, string>(),
  };
}

describe('message rekey controller', () => {
  const identity = createMessageIdentityStore({ nextEntityId: () => 'entity:one' });
  const rebindTurnCanonical = jest.fn();
  const controller = createMessageRekeyController({
    bindCanonical: (message, canonicalId) => identity.bindCanonical(message, canonicalId),
    rebindTurnCanonical,
    now: () => 100,
  });

  test('preserves entity identity and updates all session-local references', () => {
    const state: any = session();
    const message = { id: 'tmp:a', role: 'assistant', text: 'answer', meta: {} };
    identity.ensure(message);
    state.messagesById.set('tmp:a', message);
    state.timeline = ['msg_user', 'tmp:a', 'tmp:a'];
    state.segmentsByNoticeKey.set('seg', {
      memberMsgIds: ['tmp:a'],
      anchorMsgId: 'tmp:a',
      endMsgId: 'tmp:a',
    });
    state.thinkingId = 'tmp:a';
    state.currentTurnAssistantKey = 'tmp:a';
    state.appendComposerDrafts.set('tmp:a', 'draft');

    expect(controller.rekey(state, 'tmp:a', 'msg_a', 'A')).toMatchObject({
      accepted: true,
      timelineIndex: 1,
      timelineReplaced: true,
      deduped: true,
    });
    expect(state.timeline).toEqual(['msg_user', 'msg_a']);
    expect(state.messagesById.get('msg_a').meta.identity).toEqual({
      entityId: 'entity:one',
      canonicalId: 'msg_a',
    });
    expect(state.thinkingId).toBe('msg_a');
    expect(state.currentTurnAssistantKey).toBe('msg_a');
    expect(state.segmentsByNoticeKey.get('seg')).toMatchObject({
      memberMsgIds: ['msg_a'],
      anchorMsgId: 'msg_a',
      endMsgId: 'msg_a',
    });
    expect(rebindTurnCanonical).toHaveBeenCalledWith(state, 'tmp:a', 'msg_a');
  });

  test('rejects a user local key being rebound to the active assistant ID', () => {
    const state: any = session();
    state.currentTurnAssistantMsgId = 'msg_assistant';
    expect(controller.rekey(state, 'local-user', 'msg_assistant', 'A')).toEqual({
      accepted: false,
      reason: 'user-to-assistant-id',
    });
  });
});
