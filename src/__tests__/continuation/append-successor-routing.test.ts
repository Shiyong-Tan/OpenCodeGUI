jest.mock('vscode', () => ({
  workspace: { workspaceFolders: [{ uri: { fsPath: 'D:\\0.Code\\OpenCodeGUI' } }], getConfiguration: () => ({ get: (_key: string, value: unknown) => value }), asRelativePath: (value: string) => value },
  window: { createOutputChannel: () => ({ appendLine: () => undefined, append: () => undefined, clear: () => undefined, show: () => undefined, hide: () => undefined, dispose: () => undefined }), showInformationMessage: () => undefined, showErrorMessage: () => undefined },
  Uri: { file: (fsPath: string) => ({ fsPath }), joinPath: (...parts: any[]) => ({ fsPath: parts.map((part) => part?.fsPath || String(part)).join('/') }) },
  commands: { executeCommand: async () => undefined }, env: { clipboard: { readText: async () => '' } },
}), { virtual: true });

import { OpenCodeClient } from '../../OpenCodeClient';
import { SidebarProvider } from '../../SidebarProvider';
import { OpenCodeDiffProvider } from '../../OpenCodeDiffProvider';
import { handleSidebarChatEvent } from '../../events/SidebarChatEventHandler';

type PlannedAppendSuccessorTuple = {
  sessionId: string;
  rootUserMsgId: string;
  appendUserMsgId: string;
  successorAssistantMsgId: string;
  generation: number;
  terminal: boolean;
};

const TEST_ONLY_SUCCESSOR_OWNER = 'appendSuccessorStateBySession';
const createdProviders: any[] = [];
const createdClients: any[] = [];

function createClient(): any {
  const client = new OpenCodeClient() as any;
  createdClients.push(client);
  return client;
}

/**
 * Test-only anticipation of the reviewed append-successor owner contract.
 * No production owner exists at this revision. Keep this white-box seed local to
 * the RED fixture: if production adopts this property, this assertion forces the
 * fixture to be reviewed rather than silently using a divergent owner.
 */
function seedPlannedAppendSuccessorTuple(client: any, tuple: PlannedAppendSuccessorTuple): Map<string, PlannedAppendSuccessorTuple> {
  const tuples = new Map<string, PlannedAppendSuccessorTuple>([[tuple.sessionId, tuple]]);
  Object.defineProperty(client, TEST_ONLY_SUCCESSOR_OWNER, { value: tuples, configurable: true, writable: true });
  return tuples;
}

function createProviderWithRealClient(): any {
  const context: any = {
    globalState: { get: () => undefined, update: () => Promise.resolve() },
    extensionUri: { fsPath: 'D:\\0.Code\\OpenCodeGUI' },
  };
  const provider = new SidebarProvider(context, context.extensionUri, {
    updateFromSnapshot: jest.fn(), updateFromPatchSnapshot: jest.fn(), markNextChangeAutoFollow: jest.fn(),
  } as unknown as OpenCodeDiffProvider) as any;
  createdProviders.push(provider);
  return provider;
}

afterEach(async () => {
  await Promise.all(createdProviders.splice(0).map((provider) => provider.dispose()));
  await Promise.all(createdClients.splice(0).map((client) => client.dispose()));
});

describe('append successor post-final ownership', () => {
  test('RED: drops an explicit append-parent successor after the original turn finalizes', () => {
    const client = createClient();
    const logs: string[] = [];
    client.logUiDebug = (line: string) => logs.push(line);
    client.startTurn('ses_append', 'local-root');
    client.setCurrentTurnUserMsgId('ses_append', 'msg_root', 'test');
    client.beginAppendPrompt('ses_append', 'append-client', 'append text', 'msg_root');
    client.bindAppendUserMessage('ses_append', 'msg_append');
    client.finishTurn('ses_append');

    const events = client.mapServerEventToChatEvents('message.updated', {
      info: { id: 'msg_successor', sessionID: 'ses_append', role: 'assistant', parentID: 'msg_append' },
    }, 'sse');

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'assistantMessageMeta', sessionId: 'ses_append', assistantMsgId: 'msg_successor' }),
    ]));
    expect(client.turnStateBySession.get('ses_append')).toEqual(expect.objectContaining({ assistantMsgId: 'msg_successor' }));
    expect(logs.some((line) => line.includes('current-session-fallback-disabled'))).toBe(false);
  });

  test('RED: active successor ownership survives provider reset and session switch in its original session', () => {
    const provider = createProviderWithRealClient();
    provider.client.startTurn('ses_reset_A', 'local-reset-A');
    provider.client.finishTurn('ses_reset_A');
    const tuple = seedPlannedAppendSuccessorTuple(provider.client, {
      sessionId: 'ses_reset_A', rootUserMsgId: 'msg_root_A', appendUserMsgId: 'msg_append_A',
      successorAssistantMsgId: 'msg_successor_A', generation: 1, terminal: false,
    });
    provider.sendInFlightBySession.add('ses_reset_A');
    provider.pendingLocalKeyBySession.set('ses_reset_A', 'local-reset-A');
    provider.pendingAssistantTmpKeyBySession.set('ses_reset_A', 'tmp:reset-A');
    provider.pendingAssistantMessageIdBySession.set('ses_reset_A', 'msg_successor_A');
    provider.currentSessionId = 'ses_reset_B';

    provider.resetSessionState();

    expect(provider.currentSessionId).toBe('ses_reset_B');
    expect(provider.sendInFlightBySession.has('ses_reset_A')).toBe(true);
    expect(provider.pendingAssistantTmpKeyBySession.get('ses_reset_A')).toBe('tmp:reset-A');
    expect(tuple.get('ses_reset_A')).toEqual(expect.objectContaining({ sessionId: 'ses_reset_A', appendUserMsgId: 'msg_append_A' }));
    const events = provider.client.mapServerEventToChatEvents('message.updated', {
      info: { id: 'msg_successor_A', sessionID: 'ses_reset_A', role: 'assistant', parentID: 'msg_append_A' },
    }, 'sse');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'assistantMessageMeta', sessionId: 'ses_reset_A', assistantMsgId: 'msg_successor_A' }),
    ]));
  });

  test.each([
    ['finish', (client: any, sessionId: string) => client.finishTurn(sessionId)],
    ['cancel', (client: any, sessionId: string) => client.cancelTurn(sessionId)],
    ['abort', async (client: any, sessionId: string) => {
      client.ensureServer = jest.fn().mockResolvedValue(undefined);
      client.requestJson = jest.fn().mockResolvedValue({});
      await client.abortSession(sessionId);
    }],
    ['session-error', (client: any, sessionId: string) => client.mapServerEventToChatEvents('session.error', {
      sessionID: sessionId, error: { name: 'TerminalError', message: 'terminal test error' },
    }, 'sse')],
    ['replacement', (client: any, sessionId: string) => client.startTurn(sessionId, 'local-replacement')],
    ['global-reset', (client: any) => client.resetSessionState()],
  ])('RED: terminal %s must remove the planned successor owner', async (_kind, terminalAction) => {
    const client = createClient();
    const sessionId = 'ses_terminal_A';
    const tuple = seedPlannedAppendSuccessorTuple(client, {
      sessionId, rootUserMsgId: 'msg_root_A', appendUserMsgId: 'msg_append_A',
      successorAssistantMsgId: 'msg_successor_A', generation: 1, terminal: true,
    });
    await terminalAction(client, sessionId);
    expect(tuple.has(sessionId)).toBe(false);
  });

  test('GREEN: duplicate terminal observation is idempotent after successor cleanup', () => {
    const client = createClient();
    const tuple = seedPlannedAppendSuccessorTuple(client, {
      sessionId: 'ses_duplicate_A', rootUserMsgId: 'msg_root_A', appendUserMsgId: 'msg_append_A',
      successorAssistantMsgId: 'msg_successor_A', generation: 1, terminal: true,
    });
    client.finishTurn('ses_duplicate_A');
    client.finishTurn('ses_duplicate_A');
    expect(tuple.has('ses_duplicate_A')).toBe(false);
  });

  test('RED: real handler/coordinator accepts normal identity then mapped successor reaches no finalizer', async () => {
    const provider = createProviderWithRealClient();
    const client = provider.client as any;
    const webview = { postMessage: jest.fn() } as any;
    provider._view = { webview };
    client.startTurn('ses_control', 'local-control');
    client.recordAssistantMsgId('ses_control', 'msg_control');
    const identitySpy = jest.spyOn(provider, 'buildFinalizeTurnIdentity');
    const commitSpy = jest.spyOn(provider, 'commitPendingTurnChangesFromAuthoritativeFiles');
    const bindingSpy = jest.spyOn(client, 'finalizeTurnBindingFromResolvedAssistant');
    const finishSpy = jest.spyOn(client, 'finishTurn');
    const finalizeSpy = jest.spyOn(provider, 'finalizeResolvedTurn');

    await handleSidebarChatEvent(provider, { type: 'turnResolved', sessionId: 'ses_control', assistantMsgId: 'msg_control' } as any, webview);

    expect(finalizeSpy).toHaveBeenCalledTimes(1);
    expect(identitySpy).toHaveBeenCalledWith('ses_control', expect.objectContaining({ assistantMessageId: 'msg_control', reqId: 'finalizeResolvedTurn' }));
    expect(commitSpy).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'ses_control', assistantMessageId: 'msg_control' }));
    expect(bindingSpy).toHaveBeenCalledWith('ses_control', 'msg_control');
    expect(finishSpy).toHaveBeenCalledWith('ses_control');
    expect(commitSpy.mock.invocationCallOrder[0]).toBeLessThan(bindingSpy.mock.invocationCallOrder[0]);
    expect(bindingSpy.mock.invocationCallOrder[0]).toBeLessThan(finishSpy.mock.invocationCallOrder[0]);
    expect(client.turnStateBySession.has('ses_control')).toBe(false);
    expect(webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'chatDone', sessionId: 'ses_control', assistantMsgId: 'msg_control' }));

    seedPlannedAppendSuccessorTuple(client, {
      sessionId: 'ses_successor_drop', rootUserMsgId: 'msg_root_A', appendUserMsgId: 'msg_append_A',
      successorAssistantMsgId: 'msg_successor_A', generation: 1, terminal: false,
    });
    client.turnFinishedBySession.add('ses_successor_drop');
    let successorHandler: Promise<void> | undefined;
    client.addChatEventListener((event: any) => {
      if (event.type === 'turnResolved' && event.sessionId === 'ses_successor_drop') {
        successorHandler = handleSidebarChatEvent(provider, event, webview);
      }
    });
    client.mapServerEventToChatEvents('message.updated', {
      info: { id: 'msg_successor_A', sessionID: 'ses_successor_drop', role: 'assistant', parentID: 'msg_append_A', finish: 'stop' },
    }, 'sse');
    client.resolveTurnFinal('ses_successor_drop', 'session-idle');
    await successorHandler;
    client.mapServerEventToChatEvents('session.status', {
      sessionID: 'ses_successor_drop', status: { type: 'idle' },
    }, 'sse');

    expect(finalizeSpy).toHaveBeenCalledTimes(2);
  });
});
