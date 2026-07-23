import { createMessageIdentityStore } from '../session-runtime/message-identity';
import { createMessageRekeyController } from '../session-runtime/message-rekey-controller';
import { createSegmentTopology } from '../features/segments/segment-topology';

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
    handoffCanonical: (message, canonicalId) => identity.handoffCanonical(message, canonicalId),
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

  test('moves a same-turn aggregate to the final canonical ID and keeps undo references resolvable', () => {
    const state: any = session();
    state.serverIdToKey = new Map<string, string>();
    const message = { id: 'msg_first', role: 'assistant', text: 'final answer', meta: {} };
    identity.ensure(message);
    state.messagesById.set('msg_user', { id: 'msg_user', role: 'user', text: 'request', meta: {} });
    state.messagesById.set('msg_first', message);
    state.timeline = ['msg_user', 'msg_first'];
    state.currentTurnAssistantKey = 'msg_first';
    state.currentTurnAssistantMsgId = 'msg_final';
    state.segmentsByNoticeKey.set('seg', {
      memberMsgIds: ['msg_user', 'msg_first'],
      anchorMsgId: 'msg_user',
      endMsgId: 'msg_first',
    });

    expect(controller.rekey(state, 'msg_first', 'msg_final', 'A', {
      allowCanonicalHandoff: true,
    })).toMatchObject({
      accepted: true,
      timelineIndex: 1,
      timelineReplaced: true,
    });
    expect(state.timeline).toEqual(['msg_user', 'msg_final']);
    expect(state.messagesById.get('msg_final')).toMatchObject({
      id: 'msg_final',
      text: 'final answer',
      meta: {
        identity: {
          canonicalId: 'msg_final',
          canonicalAliases: ['msg_first'],
        },
      },
    });
    expect(state.segmentsByNoticeKey.get('seg')).toMatchObject({
      memberMsgIds: ['msg_user', 'msg_final'],
      anchorMsgId: 'msg_user',
      endMsgId: 'msg_final',
    });
    expect(state.serverIdToClientKey.get('msg_first')).toBe('msg_final');
    expect(state.serverIdToKey.get('msg_first')).toBe('msg_final');

    const topology = createSegmentTopology({ debug: () => undefined, now: () => 100 });
    const normalized = topology.normalizeMembers(
      state,
      'msg_user',
      'msg_final',
      ['msg_user', 'msg_final'],
      'undo:msg_user',
    );
    expect(normalized).toEqual({
      anchorMsgId: 'msg_user',
      endMsgId: 'msg_final',
      memberMsgIds: ['msg_user', 'msg_final'],
    });
    expect(normalized.memberMsgIds.filter((id) => state.messagesById.has(id))).toHaveLength(2);
  });
});
