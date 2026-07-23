jest.mock('vscode', () => ({
    workspace: {
        workspaceFolders: [{ uri: { fsPath: 'D:\\0.Code\\OpenCodeGUI' } }],
        getConfiguration: () => ({
            get: (_key: string, defaultValue: unknown) => defaultValue,
        }),
        asRelativePath: (p: string) => p,
    },
    window: {
        createOutputChannel: () => ({
            appendLine: () => undefined,
            append: () => undefined,
            clear: () => undefined,
            show: () => undefined,
            hide: () => undefined,
            dispose: () => undefined,
        }),
        showInformationMessage: () => undefined,
        showErrorMessage: () => undefined,
    },
    Uri: {
        file: (fsPath: string) => ({ fsPath }),
        joinPath: (...parts: any[]) => ({ fsPath: parts.map((p) => p?.fsPath || String(p)).join('/') }),
    },
    commands: {
        executeCommand: async () => undefined,
    },
    env: {
        clipboard: {
            readText: async () => '',
        },
    },
}), { virtual: true });

import { OpenCodeClient } from '../../OpenCodeClient';
import { SidebarProvider } from '../../SidebarProvider';
import { OpenCodeDiffProvider } from '../../OpenCodeDiffProvider';

const createdProviders: Array<{ dispose: () => Promise<void> }> = [];

function createProvider(): any {
    const context: any = {
        globalState: {
            get: () => undefined,
            update: jest.fn().mockResolvedValue(undefined),
        },
        extensionUri: { fsPath: 'D:\\0.Code\\OpenCodeGUI' },
    };
    const diffProvider = {
        updateFromSnapshot: jest.fn(),
        updateFromPatchSnapshot: jest.fn(),
        markNextChangeAutoFollow: jest.fn(),
    } as unknown as OpenCodeDiffProvider;
    const provider = new SidebarProvider(context, context.extensionUri, diffProvider) as any;
    createdProviders.push(provider);
    provider.client = {
        registerSubagentSession: jest.fn(),
        clearSubagentSession: jest.fn(),
        getParentSessionForSubagent: jest.fn().mockReturnValue(undefined),
        getSessionInfo: jest.fn().mockResolvedValue({}),
        queueSubagentChanges: jest.fn(),
        getTurnAssistantMsgId: jest.fn().mockReturnValue('msg_parent_assistant'),
        isInPostFinalWatchWindow: jest.fn().mockReturnValue(false),
        dispose: jest.fn().mockResolvedValue(undefined),
    };
    provider.uiDebugChannel = { appendLine: jest.fn() };
    return provider;
}

afterEach(async () => {
    await Promise.all(createdProviders.splice(0).map((provider) => typeof provider.dispose === 'function' ? provider.dispose() : undefined));
});

describe('subagent session ownership routing', () => {
    it('drops missing-parent session events while active B is in-flight instead of assigning the child to B', async () => {
        const provider = createProvider();
        const webview = { postMessage: jest.fn() } as any;
        provider._view = { webview };
        provider.currentSessionId = 'ses_B';
        provider.userOwnedSessionIds.add('ses_B');
        provider.sendInFlightBySession.add('ses_B');

        await provider.handleChatEvent({ type: 'session', sessionId: 'ses_child' }, webview);

        expect(provider.client.registerSubagentSession).not.toHaveBeenCalled();
        expect(provider.subagentProgressBySession.has('ses_child')).toBe(false);
        expect(webview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'subagentStatus', sessionId: 'ses_B' }));
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('reason=missing-parent'));
    });

    it('uses later explicit parent A for subsequent status even after active session switches to B', async () => {
        const provider = createProvider();
        const webview = { postMessage: jest.fn() } as any;
        provider._view = { webview };
        provider.currentSessionId = 'ses_B';
        provider.userOwnedSessionIds.add('ses_B');

        await provider.handleChatEvent({ type: 'session', sessionId: 'ses_child', parentSessionId: 'ses_A', mode: 'coder' }, webview);
        await provider.handleChatEvent({ type: 'text', sessionId: 'ses_child', text: 'running under A' }, webview);

        expect(provider.client.registerSubagentSession).toHaveBeenCalledWith('ses_child', 'ses_A');
        expect(provider.subagentProgressBySession.get('ses_child')?.parentSessionId).toBe('ses_A');
        const statusPayloads = webview.postMessage.mock.calls.map(([message]: any[]) => message).filter((message: any) => message?.type === 'subagentStatus');
        expect(statusPayloads.length).toBeGreaterThan(0);
        expect(statusPayloads.every((message: any) => message.sessionId === 'ses_A' && message.parentSessionId === 'ses_A')).toBe(true);
        expect(statusPayloads.some((message: any) => message.sessionId === 'ses_B')).toBe(false);
    });

    it('does not overwrite an existing stable parent with ambiguous active-session evidence', async () => {
        const provider = createProvider();
        const webview = { postMessage: jest.fn() } as any;
        provider._view = { webview };
        provider.currentSessionId = 'ses_B';
        provider.userOwnedSessionIds.add('ses_B');
        provider.sendInFlightBySession.add('ses_B');
        provider.subagentProgressBySession.set('ses_child', {
            taskId: 'ses_child',
            parentSessionId: 'ses_A',
            description: 'coder',
            startedAt: Date.now(),
            state: 'running',
        });
        provider.activeSubagentSessionIds.add('ses_child');

        await provider.handleChatEvent({ type: 'session', sessionId: 'ses_child' }, webview);

        expect(provider.subagentProgressBySession.get('ses_child')?.parentSessionId).toBe('ses_A');
        expect(provider.client.registerSubagentSession).toHaveBeenCalledWith('ses_child', 'ses_A');
        expect(provider.client.registerSubagentSession).not.toHaveBeenCalledWith('ses_child', 'ses_B');
    });

    it('routes subagent file/diff status through stable parent A after active session switches to B', async () => {
        const provider = createProvider();
        const webview = { postMessage: jest.fn() } as any;
        provider._view = { webview };
        provider.currentSessionId = 'ses_B';
        provider.userOwnedSessionIds.add('ses_B');
        provider.subagentProgressBySession.set('ses_child', {
            taskId: 'ses_child',
            parentSessionId: 'ses_A',
            description: 'coder',
            startedAt: Date.now(),
            state: 'running',
        });
        provider.activeSubagentSessionIds.add('ses_child');

        await provider.handleChatEvent({
            type: 'files',
            sessionId: 'ses_child',
            files: [{ filePath: 'src/example.ts', before: 'old', after: 'new', type: 'update' }],
        }, webview);

        expect(provider.client.queueSubagentChanges).toHaveBeenCalledWith('ses_A', expect.any(Array));
        expect(webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'segmentRestoreLock',
            sessionId: 'ses_A',
            parentSessionId: 'ses_A',
            agentSessionId: 'ses_child',
            displayTarget: 'parent',
        }));
        expect(webview.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'segmentRestoreLock', sessionId: 'ses_B' }));
    });
});

describe('OpenCodeClient subagent lane classification', () => {
    it('drops unknown current-session pulse instead of using current-session fallback ownership', () => {
        const client = new OpenCodeClient() as any;
        const logs: string[] = [];
        client.logUiDebug = (message: string) => logs.push(message);
        client.currentSessionId = 'ses_B';

        const events = client.mapServerEventToChatEvents('session.status', { sessionID: 'ses_B', status: { type: 'busy' } }, 'sse');

        expect(events).toEqual([]);
        expect(logs.some((line) => line.includes('current-session-fallback-disabled'))).toBe(true);
        expect(logs.some((line) => line.includes('current-session-fallback-deferred-main-smoke'))).toBe(false);
    });

    it('preserves stable child-to-parent mapping and routes subsequent pulse/text to parent A while active B', () => {
        const client = new OpenCodeClient() as any;
        const logs: string[] = [];
        client.logUiDebug = (message: string) => logs.push(message);
        client.currentSessionId = 'ses_B';
        client.registerSubagentSession('ses_child', 'ses_A');
        client.registerSubagentSession('ses_child', 'ses_B');

        const events = client.mapServerEventToChatEvents('message.part.updated', {
            part: { sessionID: 'ses_child', messageID: 'msg_child', type: 'text', text: 'hello' },
        }, 'sse');

        expect(client.getParentSessionForSubagent('ses_child')).toBe('ses_A');
        expect(logs.some((line) => line.includes('reason=parent-conflict') && line.includes('existingParentSessionId=ses_A'))).toBe(true);
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'backgroundActivityPulse', sessionId: 'ses_A', parentSessionId: 'ses_A', agentSessionId: 'ses_child', displayTarget: 'parent' }),
            expect.objectContaining({ type: 'text', sessionId: 'ses_child', parentSessionId: 'ses_A', agentSessionId: 'ses_child', displayTarget: 'agent-lane' }),
        ]));
    });

    it('retains only an allowlisted coherent child route across active-parent switch reset', () => {
        const client = new OpenCodeClient() as any;
        client.currentSessionId = 'ses_B';
        client.registerSubagentSession('ses_child', 'ses_A');
        client.resetSessionState({ preserveInFlightSessionIds: new Set(['ses_A']) });
        client.currentSessionId = 'ses_B';
        const events = client.mapServerEventToChatEvents('message.part.updated', { part: { sessionID: 'ses_child', messageID: 'msg_child', type: 'text', text: 'still under A' } }, 'sse');
        expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'backgroundActivityPulse', sessionId: 'ses_A', agentSessionId: 'ses_child' }), expect.objectContaining({ type: 'text', parentSessionId: 'ses_A', agentSessionId: 'ses_child' })]));
    });

    it('clears orphan, mismatch, stable-only, and non-allowlisted child routes on reset', () => {
        const client = new OpenCodeClient() as any;
        client.subagentToParentSessionMap.set('orphan', 'ses_A'); client.subagentToParentSessionMap.set('mismatch', 'ses_A'); client.stablePulseRootSessionBySubagent.set('mismatch', 'ses_B'); client.stablePulseRootSessionBySubagent.set('stable-only', 'ses_A'); client.registerSubagentSession('not-allowed', 'ses_A');
        client.resetSessionState({ preserveInFlightSessionIds: new Set(['ses_other']) });
        for (const child of ['orphan', 'mismatch', 'stable-only', 'not-allowed']) expect(client.getParentSessionForSubagent(child)).toBeUndefined();
    });

    it('carries backend parentID as explicit parent evidence on session events', () => {
        const client = new OpenCodeClient() as any;
        client.logUiDebug = jest.fn();

        const events = client.mapServerEventToChatEvents('session.created', {
            info: { id: 'ses_child', parentID: 'ses_A', mode: 'coder' },
        }, 'sse');

        expect(events).toEqual([expect.objectContaining({
            type: 'session',
            sessionId: 'ses_child',
            parentSessionId: 'ses_A',
            mode: 'coder',
        })]);
    });
});
