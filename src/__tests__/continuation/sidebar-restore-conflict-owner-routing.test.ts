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
        showErrorMessage: jest.fn(),
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

import { SidebarProvider } from '../../SidebarProvider';
import { OpenCodeDiffProvider } from '../../OpenCodeDiffProvider';

const createdProviders: Array<{ dispose: () => Promise<void> }> = [];

function createProvider(): any {
    const context: any = {
        globalState: {
            get: () => undefined,
            update: () => Promise.resolve(),
        },
        extensionUri: { fsPath: 'D:\\0.Code\\OpenCodeGUI' },
    };
    const diffProvider = { updateFromSnapshot: jest.fn() } as unknown as OpenCodeDiffProvider;
    const provider = new SidebarProvider(context, context.extensionUri, diffProvider) as any;
    createdProviders.push(provider);
    provider.client = {
        restoreAll: jest.fn().mockResolvedValue({ conflicts: [], touchedFiles: ['a.ts'], applied: true }),
        restoreFromMessage: jest.fn().mockResolvedValue({ conflicts: [], touchedFiles: ['a.ts'], applied: true }),
        getRevertedSegment: jest.fn().mockReturnValue({
            isActive: true,
            startMessageId: 'msg_anchor',
            endMessageId: 'msg_tail',
            messageIds: ['msg_anchor', 'msg_tail'],
            startCommits: ['abc'],
        }),
        discardRevertedSegment: jest.fn(),
        dispose: jest.fn().mockResolvedValue(undefined),
        shutdownServer: jest.fn().mockResolvedValue(undefined),
        setSessionId: jest.fn(),
        setStorage: jest.fn(),
        setUiDebugChannel: jest.fn(),
        setServerStatusHandler: jest.fn(),
        addChatEventListener: jest.fn(),
        getWorkspaceRoot: jest.fn().mockReturnValue('D:\\0.Code\\OpenCodeGUI'),
    };
    provider.uiDebugChannel = { appendLine: jest.fn() };
    provider.gitUndoEnabled = true;
    provider.baselineReady = true;
    provider.currentSessionId = 'ses_B_current';
    provider.resolveChangeListCommits = jest.fn().mockResolvedValue(['abc']);
    provider.setChangeListReverted = jest.fn().mockResolvedValue(undefined);
    provider.clearPersistedSegment = jest.fn().mockResolvedValue(undefined);
    provider.buildRestoreMessageScope = jest.fn().mockReturnValue({
        restoreMessageIds: ['msg_anchor', 'msg_tail'],
        activeRestoreMessageIds: ['msg_anchor', 'msg_tail'],
        invalidMessageIds: [],
    });
    provider.refreshDiffIfTouched = jest.fn();
    return provider;
}

function attachWebview(provider: any): { postMessage: jest.Mock; receive: (data: any) => Promise<void> } {
    let receive: ((data: any) => Promise<void>) | undefined;
    const webview: any = {
        options: {},
        html: '',
        cspSource: 'vscode-webview:',
        asWebviewUri: (uri: any) => uri,
        postMessage: jest.fn(),
        onDidReceiveMessage: (callback: (data: any) => Promise<void>) => {
            receive = callback;
            return { dispose: jest.fn() };
        },
    };
    provider.resolveWebviewView({
        webview,
        visible: true,
        onDidChangeVisibility: (_callback: () => void) => ({ dispose: jest.fn() }),
    } as any);
    if (!receive) throw new Error('webview receive callback was not registered');
    return { postMessage: webview.postMessage, receive };
}

afterEach(async () => {
    await Promise.all(createdProviders.splice(0).map((provider) => typeof provider.dispose === 'function' ? provider.dispose() : undefined));
});

describe('SidebarProvider restore owner routing', () => {
    it('routes full-scope restoreSegment by payload owner session, operation id, and segment range', async () => {
        const provider = createProvider();
        const { postMessage, receive } = attachWebview(provider);

        await receive({
            type: 'restoreSegment',
            sessionId: 'ses_A_payload',
            operationId: 'op_restore_full_segment',
            noticeKey: 'system:undo:msg_anchor',
            anchorMsgId: 'msg_anchor',
            endMsgId: 'msg_tail',
        });

        expect(provider.client.restoreAll).not.toHaveBeenCalled();
        expect(provider.buildRestoreMessageScope).toHaveBeenCalledWith('ses_A_payload', 'system:undo:msg_anchor', ['msg_anchor', 'msg_tail'], undefined);
        expect(provider.client.restoreFromMessage).toHaveBeenCalledWith('msg_anchor', 'msg_tail', expect.objectContaining({
            sessionId: 'ses_A_payload',
            messageIds: ['msg_anchor', 'msg_tail'],
        }));
        expect(provider.resolveChangeListCommits).toHaveBeenCalledWith('ses_A_payload', ['msg_anchor', 'msg_tail'], ['abc']);
        expect(provider.setChangeListReverted).toHaveBeenCalledWith('ses_A_payload', 'abc', false, expect.anything());
        expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'restoredSegment',
            sessionId: 'ses_A_payload',
            operationId: 'op_restore_full_segment',
        }));
        expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'revertedSegmentDiscarded',
            sessionId: 'ses_A_payload',
            operationId: 'op_restore_full_segment',
        }));
        expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'addResponse',
            sessionId: 'ses_A_payload',
            meta: expect.objectContaining({ operationId: 'op_restore_full_segment', sessionId: 'ses_A_payload' }),
        }));
    });

    it('routes restoreSegment by payload owner session, operation id, and anchors', async () => {
        const provider = createProvider();
        const { postMessage, receive } = attachWebview(provider);

        await receive({
            type: 'restoreSegment',
            sessionId: 'ses_A_payload',
            operationId: 'op_restore_segment',
            noticeKey: 'system:undo:msg_anchor',
            anchorMsgId: 'msg_anchor',
            endMsgId: 'msg_tail',
        });

        expect(provider.buildRestoreMessageScope).toHaveBeenCalledWith('ses_A_payload', 'system:undo:msg_anchor', ['msg_anchor', 'msg_tail'], undefined);
        expect(provider.client.restoreFromMessage).toHaveBeenCalledWith('msg_anchor', 'msg_tail', expect.objectContaining({
            sessionId: 'ses_A_payload',
            messageIds: ['msg_anchor', 'msg_tail'],
        }));
        expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'restoredSegment',
            sessionId: 'ses_A_payload',
            operationId: 'op_restore_segment',
            noticeKey: 'system:undo:msg_anchor',
        }));
        expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'addResponse',
            sessionId: 'ses_A_payload',
            meta: expect.objectContaining({ operationId: 'op_restore_segment', sessionId: 'ses_A_payload' }),
        }));
    });

    it('drops restore messages missing required owner fields', async () => {
        const provider = createProvider();
        const { receive } = attachWebview(provider);

        await receive({ type: 'restoreAll', sessionId: 'ses_A_payload' });
        await receive({ type: 'restoreSegment', sessionId: 'ses_A_payload', operationId: 'op_missing_anchor' });

        expect(provider.client.restoreAll).not.toHaveBeenCalled();
        expect(provider.client.restoreFromMessage).not.toHaveBeenCalled();
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('[EXT][RESTORE_DROP] type=restoreAll'));
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('[EXT][RESTORE_DROP] type=restoreSegment'));
    });
});

describe('SidebarProvider conflictDecision owner validation', () => {
    it('drops missing and mismatched decisions without clearing pending conflict', async () => {
        const provider = createProvider();
        const { receive } = attachWebview(provider);
        provider.pendingConflict = {
            kind: 'restore',
            sessionId: 'ses_A_payload',
            operationId: 'op_conflict',
            conflictId: 'conflict_1',
        };

        await receive({ type: 'conflictDecision', decision: 'override', sessionId: 'ses_A_payload', operationId: 'op_conflict', kind: 'restore' });
        expect(provider.pendingConflict).toEqual(expect.objectContaining({ conflictId: 'conflict_1' }));

        await receive({ type: 'conflictDecision', decision: 'override', sessionId: 'ses_B_wrong', operationId: 'op_conflict', conflictId: 'conflict_1', kind: 'restore' });
        expect(provider.pendingConflict).toEqual(expect.objectContaining({ conflictId: 'conflict_1' }));
        expect(provider.client.restoreAll).not.toHaveBeenCalled();
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('[EXT][CONFLICT_DROP] reason=missing-conflictId'));
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('[EXT][CONFLICT_DROP] reason=owner-mismatch'));
    });

    it('applies matching restore conflict decision to captured owner session', async () => {
        const provider = createProvider();
        const { postMessage, receive } = attachWebview(provider);
        provider.pendingConflict = {
            kind: 'restore',
            sessionId: 'ses_A_payload',
            operationId: 'op_conflict',
            conflictId: 'conflict_1',
        };

        await receive({ type: 'conflictDecision', decision: 'override', sessionId: 'ses_A_payload', operationId: 'op_conflict', conflictId: 'conflict_1', kind: 'restore' });

        expect(provider.pendingConflict).toBeUndefined();
        expect(provider.client.restoreAll).toHaveBeenCalledWith(expect.objectContaining({ force: true, sessionId: 'ses_A_payload' }));
        expect(provider.clearPersistedSegment).toHaveBeenCalledWith('ses_A_payload');
        expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'addResponse',
            sessionId: 'ses_A_payload',
            meta: expect.objectContaining({ operationId: 'op_conflict', sessionId: 'ses_A_payload' }),
        }));
    });
});
