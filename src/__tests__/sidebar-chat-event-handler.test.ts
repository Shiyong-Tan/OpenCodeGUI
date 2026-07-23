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
});
