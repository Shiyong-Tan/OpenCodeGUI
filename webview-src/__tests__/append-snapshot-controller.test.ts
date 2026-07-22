import { createAppendSnapshotController } from '../continuation/append-snapshot-controller';

function createHarness() {
  const posted: any[] = [];
  const sessions = new Map<string, any>();
  const controller = createAppendSnapshotController({
    resolveMessageKey: (session, key) => typeof key === 'string' ? session.aliases?.get(key) || key : null,
    getSession: (sessionId) => sessions.get(sessionId),
    postMessage: (message) => posted.push(message),
  });
  return { controller, posted, sessions };
}

describe('append snapshot controller', () => {
  test('normalizes acknowledged and unacknowledged append states without rewriting terminal states', () => {
    const { controller } = createHarness();
    expect(controller.normalizeItemsForFinalize([
      { status: 'seen', text: 'a' },
      { status: 'sending', appendUserMsgId: 'msg_append', text: 'b' },
      { status: 'queued', text: 'c' },
      { status: 'rejected', text: 'd' },
    ])).toEqual({
      changed: true,
      items: [
        { status: 'applied', text: 'a' },
        { status: 'applied', appendUserMsgId: 'msg_append', text: 'b' },
        { status: 'failed', reason: 'append-not-acknowledged', text: 'c' },
        { status: 'rejected', text: 'd' },
      ],
    });
  });

  test('collects canonical roots and emits bounded snapshot metadata', () => {
    const { controller, posted, sessions } = createHarness();
    const session = {
      aliases: new Map([['local-root', 'msg_root'], ['local-append', 'msg_append']]),
      messagesById: new Map([
        ['local-root', {
          id: 'local-root',
          role: 'user',
          meta: { appendedPrompts: [{ clientMessageId: 'c1', appendUserMsgId: 'local-append', text: 'append' }] },
        }],
      ]),
    };
    sessions.set('session-a', session);
    controller.sync('session-a', 'test');
    expect(posted[0]).toMatchObject({
      type: 'appendSnapshotMeta',
      sessionId: 'session-a',
      roots: [{
        rootMessageId: 'msg_root',
        meta: { appendedPrompts: [{ clientMessageId: 'c1', appendUserMsgId: 'msg_append', text: 'append' }] },
      }],
    });
  });

  test('hydration does not replace a protected in-flight append root', () => {
    const { controller } = createHarness();
    const session = {
      backendTurnInFlight: true,
      turnFullyFinalized: false,
      canceledActiveTurn: false,
      appendRootUserKey: 'msg_live',
      messagesById: new Map([
        ['msg_live', { id: 'msg_live', role: 'user', meta: {} }],
        ['msg_snapshot', { id: 'msg_snapshot', role: 'user', meta: { appendedPrompts: [{ status: 'seen', text: 'old' }] } }],
      ]),
      clientKeyToServerId: new Map(),
      serverIdToClientKey: new Map(),
    };
    expect(controller.restore('session-a', session)).toMatchObject({ rootCount: 1, appendCount: 1 });
    expect(session.appendRootUserKey).toBe('msg_live');
  });

  test('append status progression is monotonic and assistant parent marks the prefix seen', () => {
    const { controller } = createHarness();
    const root = { id: 'msg_root', role: 'user', meta: { appendedPrompts: [
      { clientMessageId: 'c1', appendUserMsgId: 'msg_a', status: 'queued' },
      { clientMessageId: 'c2', appendUserMsgId: 'msg_b', status: 'sending' },
    ] } };
    const session = { messagesById: new Map([['msg_root', root]]) };
    expect(controller.markSeenByAssistantParent(session, 'msg_b')).toBe(true);
    expect(root.meta.appendedPrompts.map((item) => item.status)).toEqual(['seen', 'seen']);
    controller.upsertItem(root, { clientMessageId: 'c1', status: 'sending' });
    expect(root.meta.appendedPrompts[0].status).toBe('seen');
  });

  test('resolves append roots by client id before mapped turn anchors', () => {
    const { controller } = createHarness();
    const direct = { id: 'msg_direct', role: 'user', meta: { appendedPrompts: [{ clientMessageId: 'c1' }] } };
    const fallback = { id: 'msg_fallback', role: 'user', meta: {} };
    const session = {
      messagesById: new Map([['msg_direct', direct], ['msg_fallback', fallback]]),
      appendRootUserKey: 'local-fallback',
      clientKeyToServerId: new Map([['local-fallback', 'msg_fallback']]),
      serverIdToClientKey: new Map(),
      serverIdToKey: new Map(),
    };
    expect(controller.resolveRootMessage(session, { clientMessageId: 'c1' })).toBe(direct);
    expect(controller.resolveRootMessage(session, {})).toBe(fallback);
  });
});
