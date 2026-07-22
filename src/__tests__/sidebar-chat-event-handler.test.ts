import * as fs from 'fs';
import * as path from 'path';
import { handleSidebarChatEvent } from '../events/SidebarChatEventHandler';

describe('SidebarChatEventHandler', () => {
  test('SidebarProvider keeps a single compatibility delegation', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'SidebarProvider.ts'), 'utf8');
    expect(source).toMatch(/private async handleChatEvent\([\s\S]*?return handleSidebarChatEvent\(this, event, webview\);\s*}/);
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

  test('does not forward a predecessor tmp key for canonical successor text', async () => {
    const webview = { postMessage: jest.fn() };
    const host: any = { smartSearchSessions: { owns: () => false }, _view: { webview }, currentSessionId: 'other', activeSubagentSessionIds: new Set(), subagentProgressBySession: new Map(), markWebviewActiveTurnUpdated: jest.fn(), appendAssistantBuffer: jest.fn(), isCurrentTurnSynthetic: () => false, getAssistantMetaAllowedSessionIds: () => ['ses'], pendingAssistantTmpKeyBySession: new Map([['ses', 'tmp:old']]) };
    await handleSidebarChatEvent(host, { type: 'text', sessionId: 'ses', assistantMsgId: 'msg_successor', text: 'canonical', appendSuccessor: { rootUserMsgId: 'msg_root', appendUserMsgId: 'msg_append', assistantMsgId: 'msg_successor', generation: 1, startedAt: 1 } } as any, webview as any);
    expect(webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ assistantMsgId: 'msg_successor', lastText: 'canonical' }));
    expect(webview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ tmpKey: 'tmp:old' }));
  });
});
