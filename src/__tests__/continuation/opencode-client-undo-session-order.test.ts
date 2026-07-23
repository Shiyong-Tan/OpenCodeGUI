jest.mock('vscode', () => ({
    workspace: {
        workspaceFolders: [{ uri: { fsPath: 'D:\\0.Code\\OpenCodeGUI' } }],
        getConfiguration: () => ({
            get: (_key: string, defaultValue: unknown) => defaultValue,
        }),
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
    },
}), { virtual: true });

import { OpenCodeClient } from '../../OpenCodeClient';

function createClient(): any {
    const client: any = new OpenCodeClient();
    client.gitUndoAvailable = true;
    client.gitUndo = {
        undoFromMessage: jest.fn().mockResolvedValue({
            conflicts: [],
            touchedFiles: ['file.ts'],
            applied: true,
            startCommit: 'start',
            startCommits: ['start'],
            restoreCommit: 'restore',
            undoTargetCommit: 'target',
            fileSet: ['file.ts'],
        }),
    };
    client.setUiDebugChannel({ appendLine: jest.fn() });
    return client;
}

describe('OpenCodeClient undo session-scoped message order', () => {
    it('uses B session order after switching instead of A/global order', async () => {
        const client = createClient();
        client.registerMessage('msg_A_anchor', 'ses_A');
        client.registerMessage('msg_A_tail', 'ses_A');
        client.registerMessage('msg_B_anchor', 'ses_B');
        client.registerMessage('msg_B_tail', 'ses_B');

        await client.undoFromMessage('msg_B_anchor', { sessionId: 'ses_B' });

        expect(client.gitUndo.undoFromMessage).toHaveBeenCalledWith(
            'ses_B',
            'msg_B_anchor',
            ['msg_B_anchor', 'msg_B_tail'],
            false
        );
        expect(client.gitUndo.undoFromMessage).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.arrayContaining(['msg_A_anchor']),
            expect.anything()
        );
    });

    it('uses validated WebView visible order when B cache is not hydrated', async () => {
        const client = createClient();
        client.registerMessage('msg_A_anchor', 'ses_A');
        client.registerMessage('msg_A_tail', 'ses_A');

        await client.undoFromMessage('msg_B_anchor', {
            sessionId: 'ses_B',
            visibleMessageIds: ['msg_B_pre', 'msg_B_anchor', 'msg_B_tail'],
            forwardMessageIdsFromAnchor: ['msg_B_anchor', 'msg_B_tail'],
        });

        expect(client.gitUndo.undoFromMessage).toHaveBeenCalledWith(
            'ses_B',
            'msg_B_anchor',
            ['msg_B_anchor', 'msg_B_tail'],
            false
        );
        expect(client.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('undo.order.source=webview-visible'));
        expect(client.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('undo.anchor.ok'));
    });

    it('fails clearly when both session cache and UI order are missing', async () => {
        const client = createClient();
        client.registerMessage('msg_A_anchor', 'ses_A');

        await expect(client.undoFromMessage('msg_B_anchor', { sessionId: 'ses_B' })).rejects.toThrow('Unknown message for undo.');

        expect(client.gitUndo.undoFromMessage).not.toHaveBeenCalled();
        expect(client.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('undo.order.source=missing'));
        expect(client.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('missing-session-cache-and-ui-order'));
    });

    it('retains independent reverted segments when A and B undo are interleaved', async () => {
        const client = createClient();
        client.registerMessage('msg_A_anchor', 'ses_A');
        client.registerMessage('msg_A_tail', 'ses_A');
        client.registerMessage('msg_B_anchor', 'ses_B');
        client.registerMessage('msg_B_tail', 'ses_B');

        await client.undoFromMessage('msg_A_anchor', { sessionId: 'ses_A' });
        await client.undoFromMessage('msg_B_anchor', { sessionId: 'ses_B' });

        expect(client.getRevertedSegment('ses_A')).toMatchObject({
            startMessageId: 'msg_A_anchor',
            messageIds: ['msg_A_anchor', 'msg_A_tail'],
        });
        expect(client.getRevertedSegment('ses_B')).toMatchObject({
            startMessageId: 'msg_B_anchor',
            messageIds: ['msg_B_anchor', 'msg_B_tail'],
        });

        client.discardRevertedSegment('ses_A');
        expect(client.getRevertedSegment('ses_A')?.discarded).toBe(true);
        expect(client.getRevertedSegment('ses_B')?.discarded).toBe(false);
    });
});
