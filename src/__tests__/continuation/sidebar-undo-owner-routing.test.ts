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
        undoFromMessage: jest.fn().mockResolvedValue({ conflicts: [], touchedFiles: [], applied: true }),
        getRevertedSegment: jest.fn().mockReturnValue({
            isActive: true,
            startMessageId: 'msg_anchor',
            startMessageIndex: 0,
            endMessageId: 'msg_tail',
            endMessageIndex: 1,
            collapsed: true,
            messageIds: ['msg_anchor', 'msg_tail'],
        }),
        setRevertedSegment: jest.fn(),
        getUndoRangeForAnchor: jest.fn().mockReturnValue({ startIndex: 0, endIndex: 1 }),
        getMessageIndexMap: jest.fn().mockReturnValue([{ messageId: 'msg_anchor', messageIndex: 0 }]),
        createInternalMessageId: jest.fn((_role: string, sessionId?: string) => `internal:assistant:${sessionId}:1`),
        registerMessage: jest.fn().mockReturnValue(42),
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
    provider.clearClientRevertedSegmentIfNonRestorable = jest.fn();
    provider.getInvalidSegmentMessageIds = jest.fn().mockReturnValue(new Set());
    provider.resolveChangeListCommits = jest.fn().mockResolvedValue([]);
    provider.setChangeListReverted = jest.fn().mockResolvedValue(undefined);
    provider.persistRevertedSegment = jest.fn().mockResolvedValue(undefined);
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
        onDidDispose: (_callback: () => void) => ({ dispose: jest.fn() }),
    } as any);
    if (!receive) throw new Error('webview receive callback was not registered');
    return { postMessage: webview.postMessage, receive };
}

afterEach(async () => {
    await Promise.all(createdProviders.splice(0).map((provider) => typeof provider.dispose === 'function' ? provider.dispose() : undefined));
});

describe('SidebarProvider undoToMessage owner routing', () => {
    it('uses payload session as undo owner instead of provider current session', async () => {
        const provider = createProvider();
        const { postMessage, receive } = attachWebview(provider);

        await receive({ type: 'undoToMessage', sessionId: 'ses_A_payload', messageId: 'msg_anchor', operationId: 'op_1' });

        expect(provider.client.undoFromMessage).toHaveBeenCalledWith('msg_anchor', expect.objectContaining({
            sessionId: 'ses_A_payload',
        }));
        expect(provider.client.undoFromMessage).not.toHaveBeenCalledWith('msg_anchor', expect.objectContaining({
            sessionId: 'ses_B_current',
        }));
        expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'revertedSegment',
            sessionId: 'ses_A_payload',
            operationId: 'op_1',
            messageIds: ['msg_anchor', 'msg_tail'],
            segment: expect.objectContaining({
                messageIds: ['msg_anchor', 'msg_tail'],
            }),
        }));
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('[EXT][UNDO_TX] type=revertedSegment'));
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('messageIds=2'));
        expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'addResponse',
            sessionId: 'ses_A_payload',
            meta: expect.objectContaining({ operationId: 'op_1', sessionId: 'ses_A_payload' }),
        }));
    });

    it('keeps the applied canonical range when the WebView-visible range is shorter', async () => {
        const provider = createProvider();
        provider.client.getUndoRangeForAnchor.mockReturnValue({ startIndex: 2, endIndex: 10 });
        provider.client.getRevertedSegment.mockReturnValue({
            isActive: true,
            startMessageId: 'msg_anchor',
            startMessageIndex: 2,
            endMessageId: 'msg_merged_tail',
            endMessageIndex: 10,
            collapsed: true,
            messageIds: ['msg_anchor', 'msg_ui_tail', 'msg_folded_anchor', 'msg_merged_tail'],
        });
        const { postMessage, receive } = attachWebview(provider);

        await receive({
            type: 'undoToMessage',
            sessionId: 'ses_A_payload',
            messageId: 'msg_anchor',
            operationId: 'op_ui_range',
            visibleMessageIds: ['msg_pre_1', 'msg_pre_2', 'msg_pre_3', 'msg_anchor', 'msg_ui_tail'],
            anchorIndex: 3,
            forwardMessageIdsFromAnchor: ['msg_anchor', 'msg_ui_tail'],
        });

        expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'revertedSegment',
            sessionId: 'ses_A_payload',
            operationId: 'op_ui_range',
            messageIds: ['msg_anchor', 'msg_ui_tail', 'msg_folded_anchor', 'msg_merged_tail'],
            segment: expect.objectContaining({
                endMessageId: 'msg_merged_tail',
                messageIds: ['msg_anchor', 'msg_ui_tail', 'msg_folded_anchor', 'msg_merged_tail'],
            }),
        }));
        expect(provider.persistRevertedSegment).toHaveBeenCalledWith(
            'ses_A_payload',
            expect.objectContaining({ messageIds: ['msg_anchor', 'msg_ui_tail', 'msg_folded_anchor', 'msg_merged_tail'] }),
            expect.any(Array),
            false
        );
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('[EXT][UNDO_RANGE] source=extension-canonical'));
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('messageIds=4 uiMessageIds=2'));
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('uiAnchorIndex=3 extAnchorIndex=2'));
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('[EXT][UNDO_RANGE_MISMATCH]'));
    });

    it('falls back to extension canonical range when WebView-visible range is invalid', async () => {
        const provider = createProvider();
        const { postMessage, receive } = attachWebview(provider);

        await receive({
            type: 'undoToMessage',
            sessionId: 'ses_A_payload',
            messageId: 'msg_anchor',
            operationId: 'op_bad_ui_range',
            visibleMessageIds: ['msg_pre', 'msg_anchor', 'msg_ui_tail'],
            anchorIndex: 0,
            forwardMessageIdsFromAnchor: ['msg_pre', 'msg_anchor', 'msg_ui_tail'],
        });

        expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'revertedSegment',
            sessionId: 'ses_A_payload',
            operationId: 'op_bad_ui_range',
            messageIds: ['msg_anchor', 'msg_tail'],
            segment: expect.objectContaining({
                messageIds: ['msg_anchor', 'msg_tail'],
            }),
        }));
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('[EXT][UNDO_RANGE] source=extension-canonical'));
    });

    it('uses the WebView range only when the applied segment has no canonical members', async () => {
        const provider = createProvider();
        provider.client.getRevertedSegment.mockReturnValue({
            isActive: true,
            startMessageId: 'msg_anchor',
            startMessageIndex: 1,
            endMessageId: 'msg_anchor',
            endMessageIndex: 1,
            collapsed: true,
            messageIds: [],
        });
        const { postMessage, receive } = attachWebview(provider);

        await receive({
            type: 'undoToMessage',
            sessionId: 'ses_A_payload',
            messageId: 'msg_anchor',
            operationId: 'op_missing_canonical',
            visibleMessageIds: ['msg_pre', 'msg_anchor', 'msg_ui_tail'],
            anchorIndex: 1,
            forwardMessageIdsFromAnchor: ['msg_anchor', 'msg_ui_tail'],
        });

        expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'revertedSegment',
            messageIds: ['msg_anchor', 'msg_ui_tail'],
            segment: expect.objectContaining({
                endMessageId: 'msg_ui_tail',
                messageIds: ['msg_anchor', 'msg_ui_tail'],
            }),
        }));
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('[EXT][UNDO_RANGE] source=webview-visible'));
    });

    it('retains WebView-visible order for undo conflict override retry', async () => {
        const provider = createProvider();
        provider.client.undoFromMessage
            .mockResolvedValueOnce({ conflicts: [{ file: 'file.ts', type: 'modified' }], touchedFiles: [], applied: false })
            .mockResolvedValueOnce({ conflicts: [], touchedFiles: ['file.ts'], applied: true });
        const { receive } = attachWebview(provider);

        await receive({
            type: 'undoToMessage',
            sessionId: 'ses_A_payload',
            messageId: 'msg_anchor',
            operationId: 'op_conflict_ui_range',
            visibleMessageIds: ['msg_pre_1', 'msg_anchor', 'msg_ui_tail'],
            anchorIndex: 1,
            forwardMessageIdsFromAnchor: ['msg_anchor', 'msg_ui_tail'],
        });
        const pendingConflict = provider.pendingConflictStore.get('ses_A_payload');
        expect(pendingConflict).toBeDefined();

        await receive({
            type: 'conflictDecision',
            decision: 'override',
            sessionId: 'ses_A_payload',
            operationId: 'op_conflict_ui_range',
            conflictId: pendingConflict!.conflictId,
            kind: 'undo',
        });

        expect(provider.client.undoFromMessage).toHaveBeenNthCalledWith(2, 'msg_anchor', expect.objectContaining({
            force: true,
            sessionId: 'ses_A_payload',
            visibleMessageIds: ['msg_pre_1', 'msg_anchor', 'msg_ui_tail'],
            forwardMessageIdsFromAnchor: ['msg_anchor', 'msg_ui_tail'],
        }));
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('[EXT][CONFLICT_RETRY] kind=undo'));
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('uiRange=3 forward=2'));
    });

    it('reports undo conflict retry failure clearly when cached UI order is missing', async () => {
        const provider = createProvider();
        provider.client.undoFromMessage
            .mockResolvedValueOnce({ conflicts: [{ file: 'file.ts', type: 'modified' }], touchedFiles: [], applied: false })
            .mockRejectedValueOnce(new Error('Unknown message for undo.'));
        const { postMessage, receive } = attachWebview(provider);

        await receive({
            type: 'undoToMessage',
            sessionId: 'ses_A_payload',
            messageId: 'msg_anchor',
            operationId: 'op_conflict_missing_ui_range',
        });
        const pendingConflict = provider.pendingConflictStore.get('ses_A_payload');
        expect(pendingConflict).toBeDefined();

        await receive({
            type: 'conflictDecision',
            decision: 'override',
            sessionId: 'ses_A_payload',
            operationId: 'op_conflict_missing_ui_range',
            conflictId: pendingConflict!.conflictId,
            kind: 'undo',
        });

        expect(provider.client.undoFromMessage).toHaveBeenNthCalledWith(2, 'msg_anchor', expect.objectContaining({
            force: true,
            sessionId: 'ses_A_payload',
            visibleMessageIds: [],
            forwardMessageIdsFromAnchor: [],
        }));
        expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'addResponse',
            value: expect.stringContaining('Conflict resolution failed: Error: Unknown message for undo.'),
            sessionId: 'ses_A_payload',
            operationId: 'op_conflict_missing_ui_range',
        }));
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('uiRange=0 forward=0'));
    });

    it('drops missing required undo owner inputs without calling undo', async () => {
        const provider = createProvider();
        const { postMessage, receive } = attachWebview(provider);

        await receive({ type: 'undoToMessage', messageId: 'msg_anchor', operationId: 'op_missing_session' });
        await receive({ type: 'undoToMessage', sessionId: 'ses_A_payload', operationId: 'op_missing_message' });
        await receive({ type: 'undoToMessage', sessionId: 'ses_A_payload', messageId: 'msg_anchor' });

        expect(provider.client.undoFromMessage).not.toHaveBeenCalled();
        expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'revertedSegment' }));
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('[EXT][UNDO_DROP] reason=missing-sessionId'));
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('[EXT][UNDO_DROP] reason=missing-messageId'));
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('[EXT][UNDO_DROP] reason=missing-operationId'));
    });

    it('routes undo errors with payload session and operation id', async () => {
        const provider = createProvider();
        provider.client.undoFromMessage.mockRejectedValueOnce(new Error('boom'));
        const { postMessage, receive } = attachWebview(provider);

        await receive({ type: 'undoToMessage', sessionId: 'ses_A_payload', messageId: 'msg_anchor', operationId: 'op_err' });

        expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'addResponse',
            value: expect.stringContaining('Undo failed:'),
            sessionId: 'ses_A_payload',
            operationId: 'op_err',
            meta: expect.objectContaining({ operationId: 'op_err' }),
        }));
    });
});
