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

  test('non-browser successor OK sequence reaches the media seam without a tmp alias', async () => {
    const posted: any[] = [];
    const webview = { postMessage: (message: any) => posted.push(message) };
    const host: any = {
      smartSearchSessions: { owns: () => false }, currentSessionId: 'ses_f8', activeSubagentSessionIds: new Set(), subagentProgressBySession: new Map(), pendingAssistantTmpKeyBySession: new Map([['ses_f8', 'tmp:predecessor']]), pendingLocalKeyBySession: new Map(), pendingAssistantTmpKeyByLocalKey: new Map(), uiDebugChannel: { appendLine: () => undefined }, markWebviewActiveTurnUpdated: () => undefined, appendAssistantBuffer: () => undefined, isCurrentTurnSynthetic: () => false, getAssistantMetaAllowedSessionIds: () => ['ses_f8'], consumeAppendSuccessorTmpKey: () => undefined,
    };
    const successor = { rootUserMsgId: 'msg_root', appendUserMsgId: 'msg_append', assistantMsgId: 'msg_successor', generation: 1 };
    await handleSidebarChatEvent(host, { type: 'assistantMessageMeta', sessionId: 'ses_f8', assistantMsgId: 'msg_successor', messageId: 'msg_successor', lastText: 'OK', appendSuccessor: successor } as any, webview as any);
    await handleSidebarChatEvent(host, { type: 'text', sessionId: 'ses_f8', assistantMsgId: 'msg_successor', text: 'OK', appendSuccessor: successor } as any, webview as any);
    const meta = posted.filter((message) => message.type === 'assistantMessageMeta');
    expect(meta).toHaveLength(2);
    expect(meta).toEqual(expect.arrayContaining([expect.objectContaining({ assistantMsgId: 'msg_successor', lastText: 'OK' })]));
    expect(meta.every((message) => !Object.prototype.hasOwnProperty.call(message, 'tmpKey'))).toBe(true);
  });
});
