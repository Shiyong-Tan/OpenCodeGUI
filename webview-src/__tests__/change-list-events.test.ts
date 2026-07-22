import { createChangeListEventController } from '../features/change-list/change-list-events';

function createHarness() {
  const session: any = { messagesById: new Map() };
  const calls = {
    discarded: [] as any[],
    placed: [] as any[],
    rendered: [] as any[],
    debug: [] as string[][],
  };
  const controller = createChangeListEventController({
    getSession: () => session,
    discardAllSegments: (...args) => calls.discarded.push(args),
    toStableMessageKey: (_session, id) => id === 'tmp:assistant' ? 'msg_assistant' : null,
    upsertMessage: (target, message) => target.messagesById.set(message.id, message),
    placeMessageAfterAnchor: (_session, ...args) => calls.placed.push(args),
    renderIfActive: (...args) => calls.rendered.push(args),
    postDebug: (payload) => calls.debug.push(payload),
    now: () => 123,
  });
  return { session, calls, controller };
}

describe('change-list event controller', () => {
  test('replaces files, filters stats and places the record after its stable anchor', () => {
    const { session, calls, controller } = createHarness();
    session.messagesById.set('list-1', {
      id: 'list-1',
      meta: { kind: 'changeList', files: ['old.ts'], anchorMessageId: 'old-anchor' },
    });

    expect(controller.handleDiffFileList('session-a', {
      changeListId: 'list-1',
      files: ['new.ts', '', null],
      statsByPath: { 'new.ts': { additions: 2 }, 'old.ts': { deletions: 3 } },
      anchorMessageId: 'tmp:assistant',
      commitHead: 'head',
      commitBase: 'base',
    }, 'build')).toBe(true);

    expect(session.messagesById.get('list-1').meta).toMatchObject({
      files: ['new.ts'],
      statsByPath: { 'new.ts': { additions: 2 } },
      anchorMessageId: 'tmp:assistant',
      stableAnchorMessageId: 'msg_assistant',
    });
    expect(calls.discarded).toEqual([['session-a', 'file-change-detected', 'build']]);
    expect(calls.placed).toEqual([['list-1', 'msg_assistant', 'diffFileList']]);
    expect(calls.rendered).toEqual([['session-a', 'diffFileList', { scroll: true }]]);
  });

  test('keeps the prior anchor when an update omits it and generates the legacy fallback id', () => {
    const { session, controller } = createHarness();
    session.messagesById.set('changes:123', {
      id: 'changes:123',
      meta: { kind: 'changeList', files: ['old.ts'], anchorMessageId: 'msg_a', stableAnchorMessageId: 'msg_a' },
    });
    controller.handleDiffFileList('session-a', { files: ['new.ts'] }, '');
    expect(session.messagesById.get('changes:123').meta).toMatchObject({
      files: ['new.ts'], anchorMessageId: 'msg_a', stableAnchorMessageId: 'msg_a',
    });
  });

  test('updates reverted state only for matching commit heads', () => {
    const { session, calls, controller } = createHarness();
    session.messagesById.set('a', { meta: { kind: 'changeList', commitHead: 'head-a', reverted: false } });
    session.messagesById.set('b', { meta: { kind: 'changeList', commitHead: 'head-b', reverted: false } });
    expect(controller.handleChangeListUpdate('session-a', { commitHead: 'head-a', reverted: true })).toBe(true);
    expect(session.messagesById.get('a').meta.reverted).toBe(true);
    expect(session.messagesById.get('b').meta.reverted).toBe(false);
    expect(calls.rendered).toEqual([['session-a', 'changeListUpdate']]);
  });

  test('still discards segments before rejecting an empty file event', () => {
    const { calls, controller } = createHarness();
    expect(controller.handleDiffFileList('session-a', { files: [] }, 'plan')).toBe(false);
    expect(calls.discarded).toEqual([['session-a', 'file-change-detected', 'plan']]);
    expect(calls.rendered).toEqual([]);
  });
});
