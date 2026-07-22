import { createUndoRequestController } from '../undo/undo-request-controller';

function createHarness() {
  const posts: any[] = [];
  const sessions = new Map<string, any>();
  const render = jest.fn();
  let now = 100;
  const controller = createUndoRequestController({
    getSession: (id) => sessions.get(id),
    getActiveSessionId: () => 'session-a',
    getSessionRegistryInfo: (id) => ({ size: sessions.size, hasSession: sessions.has(id) }),
    isPersistenceArtifact: (_id, message) => message?.meta?.kind === 'changeList',
    upsertMessage: (session, message) => session.messagesById.set(message.id, message),
    assertInvariants: jest.fn(),
    render,
    postMessage: (message) => posts.push(message),
    setTimeout: (callback) => ({ callback }),
    clearTimeout: jest.fn(),
    now: () => now,
    random: () => 0.5,
    timeoutMs: 10_000,
  });
  return { posts, sessions, render, controller, setNow: (value: number) => { now = value; } };
}

function session(timeline: string[]): any {
  return {
    timeline,
    messagesById: new Map(timeline.map((id) => [id, { id, meta: id.startsWith('system:') ? { kind: 'changeList' } : {} }])),
    hiddenSet: new Set<string>(),
    undoNoticeKeyByOpId: new Map(),
    pendingUndoByNoticeKey: new Map(),
    segmentsByNoticeKey: new Map(),
    pendingUndo: null,
  };
}

describe('undo request controller', () => {
  test('sends the anchor-forward visible range with the owning session id', () => {
    const harness = createHarness();
    const state = session(['msg_pre', 'system:change', 'msg_anchor', 'msg_tail']);
    harness.sessions.set('session-a', state);
    harness.controller.handleUndoToMessage('session-a', 'msg_anchor');
    expect(harness.posts).toContainEqual(expect.objectContaining({
      type: 'undoToMessage',
      sessionId: 'session-a',
      messageId: 'msg_anchor',
      visibleMessageIds: ['msg_pre', 'msg_anchor', 'msg_tail'],
      anchorIndex: 1,
      forwardMessageIdsFromAnchor: ['msg_anchor', 'msg_tail'],
    }));
    expect(state.pendingUndo.noticeKey).toBe('system:undo:msg_anchor');
  });

  test('suspends a matching undo timeout while conflict resolution owns the operation', () => {
    const harness = createHarness();
    const state = session(['msg_anchor']);
    state.pendingUndo = { clientOpId: 'op_1', timeoutId: {}, status: 'waiting-response' };
    harness.sessions.set('session-a', state);
    expect(harness.controller.suspendTimeoutForConflictCard({ sessionId: 'session-a', operationId: 'op_1', conflictId: 'conflict', kind: 'undo' })).toBe(true);
    expect(state.pendingUndo).toMatchObject({ status: 'waiting-conflict-decision', conflictId: 'conflict', timeoutId: null });
  });

  test('times out only the still-matching pending operation', () => {
    const harness = createHarness();
    const state = session(['msg_anchor']);
    state.pendingUndo = { clientOpId: 'op_1', anchorKey: 'msg_anchor', ts: 100, status: 'waiting-response' };
    harness.sessions.set('session-a', state);
    harness.setNow(10_101);
    harness.controller.handleTimeout('session-a', 'op_1');
    expect(state.messagesById.get('system:undo-timeout:op_1')).toBeDefined();
    expect(state.pendingUndo).toBeNull();
    expect(harness.render).toHaveBeenCalledTimes(1);
  });

  test('routes restore with a fresh operation id and exact segment bounds', () => {
    const harness = createHarness();
    const state = session([]);
    state.segmentsByNoticeKey.set('system:undo:msg_a', { noticeKey: 'system:undo:msg_a', anchorMsgId: 'msg_a', endMsgId: 'msg_b' });
    harness.sessions.set('session-a', state);
    harness.controller.handleRestoreSegment('session-a', 'seg:system:undo:msg_a');
    expect(harness.posts).toContainEqual(expect.objectContaining({
      type: 'restoreSegment', sessionId: 'session-a', noticeKey: 'system:undo:msg_a', anchorMsgId: 'msg_a', endMsgId: 'msg_b',
    }));
  });
});
