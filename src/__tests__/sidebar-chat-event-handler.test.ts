import * as fs from 'fs';
import * as path from 'path';
import { handleSidebarChatEvent } from '../events/SidebarChatEventHandler';

describe('SidebarChatEventHandler', () => {
  test('SidebarProvider shadows around a single compatibility delegation', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'SidebarProvider.ts'), 'utf8');
    const start = source.indexOf('private async handleChatEvent(');
    const end = source.indexOf('private async observeTurnRuntimeShadow(', start);
    const method = source.slice(start, end);
    expect(method).toContain('const shadowObservation = this.observeTurnRuntimeShadow(event);');
    expect(method).toContain('await handleSidebarChatEvent(this, event, webview);');
    expect(method).toContain('this.reportTurnRuntimeShadow(event, await shadowObservation);');
    expect(method.match(/handleSidebarChatEvent\(this, event, webview\)/g)).toHaveLength(1);
    expect(source).toContain('void this.chatEventActorRouter.route(event);');
  });

  test('temporary Smart Search sessions never reach the Webview pipeline', async () => {
    const webview = { postMessage: jest.fn() };
    const host = { smartSearchSessions: { owns: () => true } };
    await handleSidebarChatEvent(host, { type: 'assistant', sessionId: 'search-session' } as any, webview as any);
    expect(webview.postMessage).not.toHaveBeenCalled();
  });

  test('routes parent-owned todos with their stable anchor metadata', async () => {
    const webview = { postMessage: jest.fn() };
    const host = {
      smartSearchSessions: { owns: () => false },
      isUserOwnedSession: () => true,
    };
    await handleSidebarChatEvent(host, {
      type: 'todoUpdate', sessionId: 'session-a', todos: [{ content: 'keep order' }],
      assistantMsgId: 'assistant-a', parentSessionId: 'parent-a', agentSessionId: 'agent-a', displayTarget: 'parent',
    } as any, webview as any);
    expect(webview.postMessage).toHaveBeenCalledWith({
      type: 'todoUpdate', todos: [{ content: 'keep order' }], anchorMessageId: 'assistant-a',
      sessionId: 'session-a', parentSessionId: 'parent-a', agentSessionId: 'agent-a', displayTarget: 'parent',
    });
  });

  test('routes background assistant metadata by event owner, not visible session', async () => {
    const webview = { postMessage: jest.fn() };
    const host = {
      smartSearchSessions: { owns: () => false },
      currentSessionId: 'session-B',
      _view: { webview },
      pendingAssistantTmpKeyBySession: new Map([['session-A', 'tmp:A']]),
      pendingLocalKeyBySession: new Map(),
      pendingAssistantTmpKeyByLocalKey: new Map(),
      activeSubagentSessionIds: new Set(),
      subagentProgressBySession: new Map(),
      uiDebugChannel: { appendLine: jest.fn() },
      markWebviewActiveTurnUpdated: jest.fn(),
      isCurrentTurnSynthetic: () => false,
      getAssistantMetaAllowedSessionIds: jest.fn((sessionId: string) => [sessionId]),
    };

    await handleSidebarChatEvent(host as any, {
      type: 'assistantMessageMeta',
      sessionId: 'session-A',
      assistantMsgId: 'msg_A',
      messageIndex: 12,
      lastText: 'A is still running',
    }, webview as any);

    expect(host.getAssistantMetaAllowedSessionIds).toHaveBeenCalledWith('session-A');
    expect(webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'assistantMessageMeta',
      sessionId: 'session-A',
      assistantMsgId: 'msg_A',
      allowedSessionIds: ['session-A'],
    }));
  });

  test('drops ownerless asynchronous assistant events instead of using visible session', async () => {
    const webview = { postMessage: jest.fn() };
    const host = {
      smartSearchSessions: { owns: () => false },
      currentSessionId: 'session-B',
      _view: { webview },
      uiDebugChannel: { appendLine: jest.fn() },
    };

    await handleSidebarChatEvent(host as any, {
      type: 'assistantMessageMeta',
      assistantMsgId: 'msg_unknown',
    }, webview as any);
    await handleSidebarChatEvent(host as any, {
      type: 'text',
      text: 'ownerless',
    }, webview as any);

    expect(webview.postMessage).not.toHaveBeenCalled();
    expect(host.uiDebugChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('reason=missing-event-session'),
    );
  });

  test.each([
    { type: 'error', text: 'failed' },
    { type: 'message', text: 'msg_user' },
    { type: 'files', files: [{ path: 'a.ts' }] },
  ])('drops ownerless $type events before any state mutation', async (event) => {
    const webview = { postMessage: jest.fn() };
    const host = {
      smartSearchSessions: { owns: () => false },
      currentSessionId: 'visible-session',
      _view: { webview },
      uiDebugChannel: { appendLine: jest.fn() },
    };
    await handleSidebarChatEvent(host as any, event as any, webview as any);
    expect(webview.postMessage).not.toHaveBeenCalled();
    expect(host.uiDebugChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('reason=missing-event-session'),
    );
  });

  test('anchors plan files to the event owner while another session is visible', async () => {
    const webview = { postMessage: jest.fn() };
    const host = {
      smartSearchSessions: { owns: () => false },
      currentSessionId: 'session-B',
      _view: { webview },
      activeSubagentSessionIds: new Set(),
      uiDebugChannel: { appendLine: jest.fn() },
      pickActiveFile: () => ({ file: { filePath: 'docs/plan.md' }, index: 0 }),
      tryOpenDiffForEventFile: jest.fn(),
      client: {
        isInLateDiffGrace: () => false,
        wasTurnFinishedRecently: () => false,
        getTurnAssistantMsgId: jest.fn((sessionId: string) => sessionId === 'session-A' ? 'msg_A' : 'msg_B'),
      },
    };

    await handleSidebarChatEvent(host as any, {
      type: 'files',
      sessionId: 'session-A',
      files: ['docs/plan.md'],
    } as any, webview as any);

    expect(host.client.getTurnAssistantMsgId).toHaveBeenCalledWith('session-A');
    expect(webview.postMessage).toHaveBeenCalledWith({
      type: 'planFileCard',
      files: ['docs/plan.md'],
      anchorMessageId: 'msg_A',
      sessionId: 'session-A',
    });
  });

  test('binds a user acknowledgement to its session-local pending identity', async () => {
    const webview = { postMessage: jest.fn() };
    const host = {
      smartSearchSessions: { owns: () => false },
      currentSessionId: 'session-B',
      _view: { webview },
      activeSubagentSessionIds: new Set(),
      pendingLocalKeyBySession: new Map([
        ['session-A', 'local-A'],
        ['session-B', 'local-B'],
      ]),
      clientMessageIdMap: new Map([
        ['local-A', 'internal-A'],
        ['local-B', 'internal-B'],
      ]),
      rawUserTextByLocalKey: new Map([['local-A', 'prompt A']]),
      rawUserTextByMsgId: new Map(),
      uiDebugChannel: { appendLine: jest.fn() },
      client: {
        getMessageIndex: jest.fn(() => 4),
        registerMessage: jest.fn(),
        aliasMessageId: jest.fn(),
      },
    };

    await handleSidebarChatEvent(host as any, {
      type: 'message',
      sessionId: 'session-A',
      text: 'msg_user_A',
    } as any, webview as any);

    expect(webview.postMessage).toHaveBeenCalledWith({
      type: 'userAckBind',
      sessionId: 'session-A',
      localKey: 'local-A',
      msgId: 'msg_user_A',
    });
    expect(host.pendingLocalKeyBySession.get('session-A')).toBeUndefined();
    expect(host.pendingLocalKeyBySession.get('session-B')).toBe('local-B');
    expect(host.rawUserTextByMsgId.get('msg_user_A')).toBe('prompt A');
    expect(host.client.aliasMessageId).not.toHaveBeenCalledWith('local-B', 'msg_user_A');
  });

  test('does not treat a background transport session event as user selection', async () => {
    const webview = { postMessage: jest.fn() };
    const host = {
      smartSearchSessions: { owns: () => false },
      currentSessionId: 'session-B',
      _view: { webview },
      isUserOwnedSession: (sessionId: string) => sessionId === 'session-A' || sessionId === 'session-B',
      activeSubagentSessionIds: new Set(),
      pendingBaselineTurnKey: undefined,
      uiDebugChannel: { appendLine: jest.fn() },
      client: { setSessionId: jest.fn() },
    };

    await handleSidebarChatEvent(host as any, {
      type: 'session',
      sessionId: 'session-A',
    } as any, webview as any);

    expect(host.currentSessionId).toBe('session-B');
    expect(host.client.setSessionId).not.toHaveBeenCalled();
    expect(webview.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'sessionId' }),
    );
    expect(host.uiDebugChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('selectionMutation=false'),
    );
  });
});
