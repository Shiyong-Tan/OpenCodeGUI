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
});
