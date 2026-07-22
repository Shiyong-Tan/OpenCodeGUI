import { planAppendRoot, planAppendItemUpsert, planFinalizedItems, planAssistantParentSeen } from '../continuation/append-alias-planner';

describe('append root and status planner', () => {
  const root = (id: string, items: any[] = []) => ({ id, role: 'user', items });
  test('uses direct client match and ordered alias fallback while failing ambiguity closed', () => {
    expect(planAppendRoot({ messages: [root('msg_direct', [{ clientMessageId: 'c1' }]), root('msg_other')], message: { clientMessageId: 'c1' }, aliases: [] })).toMatchObject({ rootId: 'msg_direct', reason: 'client-match' });
    expect(planAppendRoot({ messages: [root('msg_root')], message: { rootUserMsgId: 'local-root' }, aliases: [['local-root', 'msg_root']] })).toMatchObject({ rootId: 'msg_root' });
    expect(planAppendRoot({ messages: [root('a', [{ clientMessageId: 'c1' }]), root('b', [{ clientMessageId: 'c1' }])], message: { clientMessageId: 'c1' }, aliases: [] })).toMatchObject({ rootId: null, reason: 'ambiguous-client-match' });
  });
  test('preserves monotonic and terminal statuses and transitions assistant-parent prefix', () => {
    expect(planAppendItemUpsert([{ clientMessageId: 'c1', status: 'seen' }], { clientMessageId: 'c1', status: 'sending' }).items[0].status).toBe('seen');
    expect(planFinalizedItems([{ status: 'queued' }, { status: 'seen' }, { status: 'rejected' }]).items.map((item: any) => item.status)).toEqual(['failed', 'applied', 'rejected']);
    expect(planAssistantParentSeen([root('r', [{ appendUserMsgId: 'a', status: 'queued' }, { appendUserMsgId: 'b', status: 'sending' }])], 'b').items.map((item: any) => item.status)).toEqual(['seen', 'seen']);
  });
  test('keeps the later appendUserMsgId-matched update and removes earlier stale client duplicate', () => {
    const result = planAppendItemUpsert([{ clientMessageId: 'c1', appendUserMsgId: 'stale', status: 'queued', text: 'stale' }, { clientMessageId: 'c1', appendUserMsgId: 'msg_target', status: 'seen', text: 'current', createdAt: 2 }, { clientMessageId: 'c2', status: 'queued' }], { clientMessageId: 'c1', appendUserMsgId: 'msg_target', status: 'applied', updatedAt: 3 });
    expect(result.items).toEqual([expect.objectContaining({ clientMessageId: 'c1', appendUserMsgId: 'msg_target', status: 'applied', text: 'current', createdAt: 2, updatedAt: 3 }), expect.objectContaining({ clientMessageId: 'c2', status: 'queued' })]);
  });
});
