import { planAppendRoot, planAppendItemUpsert, planFinalizedItems, planAssistantParentSeen } from '../continuation/append-alias-planner';

describe('append root and status planner', () => {
  const root = (id: string, items: any[] = []) => ({ id, role: 'user', items });

  test('uses direct client match before ordered canonical alias fallbacks and fails closed on ambiguity', () => {
    expect(planAppendRoot({ messages: [root('msg_direct', [{ clientMessageId: 'c1' }]), root('msg_fallback')], message: { clientMessageId: 'c1' }, aliases: [] }))
      .toMatchObject({ rootId: 'msg_direct', reason: 'client-match' });
    expect(planAppendRoot({ messages: [root('msg_root')], message: { rootUserMsgId: 'local-root' }, appendRootUserKey: '', lastTurnUserId: '', aliases: [['local-root', 'msg_root']] }))
      .toMatchObject({ rootId: 'msg_root', reason: 'root-user-msg-id' });
    expect(planAppendRoot({ messages: [root('msg_a', [{ clientMessageId: 'c1' }]), root('msg_b', [{ clientMessageId: 'c1' }])], message: { clientMessageId: 'c1' }, aliases: [] }))
      .toMatchObject({ rootId: null, reason: 'ambiguous-client-match' });
  });

  test('keeps status monotonic, preserves terminals, collapses duplicates, and transitions only the assistant-parent prefix', () => {
    const queued = [{ clientMessageId: 'c1', appendUserMsgId: 'msg_a', status: 'queued' }, { clientMessageId: 'c2', appendUserMsgId: 'msg_b', status: 'sending' }];
    expect(planAppendItemUpsert(queued, { clientMessageId: 'c1', status: 'sending' }).items[0].status).toBe('queued');
    expect(planAppendItemUpsert([{ clientMessageId: 'c1', status: 'failed' }], { clientMessageId: 'c1', status: 'seen' }).items[0].status).toBe('failed');
    expect(planAssistantParentSeen([root('msg_root', queued)], 'msg_b')).toMatchObject({ rootId: 'msg_root', items: [expect.objectContaining({ status: 'seen' }), expect.objectContaining({ status: 'seen' })] });
    expect(planFinalizedItems([{ status: 'queued' }, { status: 'seen' }, { status: 'rejected' }]).items.map((item: any) => item.status)).toEqual(['failed', 'applied', 'rejected']);
  });
});
