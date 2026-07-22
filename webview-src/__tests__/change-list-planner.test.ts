import { planChangeListMaterialization } from '../features/change-list/change-list-planner';

describe('change-list materialization planner', () => {
  test('normalizes records, dedupes timeline identity, and inserts after canonical anchors', () => {
    const result = planChangeListMaterialization({
      rawMessages: [
        { id: 'tmp:assistant', role: 'assistant' },
        { id: 'system:changeList:head', role: 'system', text: 'changed', meta: { kind: 'changeList', files: ['src/a.ts', '', null], anchorMessageId: 'tmp:assistant', reverted: true } },
      ],
      messagesById: new Map([['msg_assistant', { id: 'msg_assistant', role: 'assistant', order: 1 }]]),
      timeline: ['msg_assistant'],
      nextOrder: 2,
      toStableMessageKey: (id) => id === 'tmp:assistant' ? 'msg_assistant' : id,
    });

    expect(result.stats).toMatchObject({ seen: 1, materialized: 1, insertedAfter: 1, appended: 0 });
    expect(result.timeline).toEqual(['msg_assistant', 'system:changeList:head']);
    expect(result.messages).toEqual([expect.objectContaining({
      id: 'system:changeList:head', role: 'system', text: 'changed', order: 2,
      meta: expect.objectContaining({ kind: 'changeList', files: ['src/a.ts'], reverted: true }),
    })]);
    expect(result.nextOrder).toBe(3);
  });

  test('keeps an existing timeline record in place and skips empty changelists', () => {
    const result = planChangeListMaterialization({
      rawMessages: [
        { id: 'system:changeList:present', meta: { kind: 'changeList', files: ['a.ts'] } },
        { id: 'system:changeList:empty', meta: { kind: 'changeList', files: [] } },
      ],
      messagesById: new Map([['system:changeList:present', { id: 'system:changeList:present', role: 'system', order: 4, meta: { reverted: true } }]]),
      timeline: ['system:changeList:present'], nextOrder: 5, toStableMessageKey: (id) => id,
    });

    expect(result.stats).toMatchObject({ seen: 2, alreadyTimeline: 1, materialized: 0, skippedNoFiles: 1 });
    expect(result.timeline).toEqual(['system:changeList:present']);
    expect(result.messages[0].meta).toMatchObject({ kind: 'changeList', files: ['a.ts'], reverted: true });
  });
});
