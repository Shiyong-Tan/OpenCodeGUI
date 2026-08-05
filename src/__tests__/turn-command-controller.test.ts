jest.mock('vscode', () => ({
    workspace: { workspaceFolders: [] },
    window: {
        showErrorMessage: jest.fn(),
        createOutputChannel: jest.fn(() => ({
            appendLine: jest.fn(),
            append: jest.fn(),
            dispose: jest.fn(),
        })),
    },
}), { virtual: true });

import { createTurnCommandHandler } from '../webview/controllers/TurnCommandController';

function createHarness(overrides: Record<string, unknown> = {}) {
    const posts: any[] = [];
    const activeWebview: any = {
        postMessage: jest.fn(async (message: any) => {
            posts.push(message);
            return true;
        }),
    };
    const host: any = {
        client: {
            canAppendToCurrentTurn: jest.fn(() => true),
            beginAppendPrompt: jest.fn((
                sessionId: string,
                _clientMessageId: string,
                _value: string,
                rootUserMsgId: string,
            ) => ({ sessionId, rootUserMsgId })),
            appendPrompt: jest.fn(async () => undefined),
            failAppendPrompt: jest.fn(),
            abortSession: jest.fn(async () => undefined),
            cancelTurn: jest.fn(),
            finishTurn: jest.fn(),
            getPendingTurnMessageIds: jest.fn(() => ({})),
            getTurnAssistantMsgId: jest.fn(() => 'msg_assistant_A'),
            getCurrentTurnStartedAt: jest.fn(() => 1_000),
            getCurrentTurnCompletedAt: jest.fn(() => 76_000),
            getCurrentTurnProcessingPausedAt: jest.fn(() => undefined),
            getCurrentTurnProcessingPausedMs: jest.fn(() => 12_000),
            revertPendingTurnChangesToCurrentBase: jest.fn(async () => undefined),
        },
        attachments: {},
        getLiveWebview: jest.fn((fallback: unknown) => fallback),
        getCurrentSessionId: jest.fn(() => 'session-B'),
        getTurnSelection: jest.fn(() => ({
            model: 'provider/model',
            mode: 'plan',
            variant: 'fast',
        })),
        log: jest.fn(),
        logBridge: jest.fn(),
        isTurnCommandInFlight: jest.fn(() => true),
        isAppendSubmissionInFlight: jest.fn(() => false),
        markAppendSubmissionStarted: jest.fn(),
        markAppendSubmissionFinished: jest.fn(),
        cacheAppendSnapshotMeta: jest.fn(),
        registerTurnTemporaryKey: jest.fn(),
        captureTurnCancelOwner: jest.fn(() => ({
            sessionId: 'session-A',
            operationId: 'op-A',
        })),
        promptCancelRollbackDecision: jest.fn(async () => false),
        clearTurnRawUserText: jest.fn(),
        clearCanceledTurnCommandState: jest.fn(),
        clearCanceledTurnAssistantState: jest.fn(),
        consumeDraft: jest.fn(() => undefined),
        commitPendingTurnChangesFromAuthoritativeFiles: jest.fn(async () => ({})),
        buildFinalizeTurnIdentity: jest.fn((sessionId: string, partial: unknown) => ({
            sessionId,
            ...(partial as object),
        })),
        clearPostFinalWatchDiffFocus: jest.fn(),
        markSubagentsTerminalForParent: jest.fn(),
        emitSubagentStatus: jest.fn(),
        clearSubagentSessionsForParent: jest.fn(),
        syncTurnInFlightAfterFinalize: jest.fn(),
        runPendingSendInitGuardCompensation: jest.fn(async () => undefined),
        ...overrides,
    };
    return {
        activeWebview,
        posts,
        host,
        handler: createTurnCommandHandler(host),
    };
}

describe('TurnCommandController runtime protocol', () => {
    test('declines non-turn commands synchronously without an async boundary', () => {
        const harness = createHarness();
        expect(harness.handler(
            { type: 'selectSession', sessionId: 'session-A' },
            harness.activeWebview,
            harness.activeWebview,
        )).toBe(false);
    });

    test('routes append entirely by its payload owner and releases serialization state', async () => {
        const harness = createHarness();
        await harness.handler(
            {
                type: 'appendMessage',
                sessionId: 'session-A',
                rootUserKey: 'msg_root_A',
                clientMessageId: 'append-A',
                value: 'follow up',
            },
            harness.activeWebview,
            harness.activeWebview,
        );

        expect(harness.host.getCurrentSessionId).toHaveBeenCalledTimes(1);
        expect(harness.host.client.beginAppendPrompt).toHaveBeenCalledWith(
            'session-A',
            'append-A',
            'follow up',
            'msg_root_A',
        );
        expect(harness.host.client.appendPrompt).toHaveBeenCalledWith(
            'session-A',
            'follow up',
            expect.objectContaining({
                clientMessageId: 'append-A',
                rootUserMsgId: 'msg_root_A',
            }),
        );
        expect(harness.host.markAppendSubmissionStarted).toHaveBeenCalledWith('session-A');
        expect(harness.host.markAppendSubmissionFinished).toHaveBeenCalledWith('session-A');
        expect(harness.posts).toContainEqual(expect.objectContaining({
            type: 'appendStatus',
            sessionId: 'session-A',
            clientMessageId: 'append-A',
            status: 'queued',
        }));
    });

    test('delegates snapshot metadata and temporary assistant binding once', async () => {
        const harness = createHarness();
        const snapshot = {
            type: 'appendSnapshotMeta',
            sessionId: 'session-A',
            rootUserMsgId: 'msg_root_A',
        };
        await harness.handler(snapshot, harness.activeWebview, harness.activeWebview);
        await harness.handler(
            { type: 'registerTmpKey', sessionId: 'session-A', tmpKey: 'tmp:assistant-A' },
            harness.activeWebview,
            harness.activeWebview,
        );

        expect(harness.host.cacheAppendSnapshotMeta).toHaveBeenCalledWith(snapshot);
        expect(harness.host.registerTurnTemporaryKey).toHaveBeenCalledWith(
            'session-A',
            'tmp:assistant-A',
        );
    });

    test('cancel finalizes only the owner captured before its first await', async () => {
        const order: string[] = [];
        const harness = createHarness({
            promptCancelRollbackDecision: jest.fn(async () => {
                order.push('decision');
                return false;
            }),
            clearTurnRawUserText: jest.fn(() => order.push('clear-raw')),
            clearCanceledTurnCommandState: jest.fn(() => order.push('clear-turn')),
            commitPendingTurnChangesFromAuthoritativeFiles: jest.fn(async () => {
                order.push('commit');
                return {};
            }),
            syncTurnInFlightAfterFinalize: jest.fn(() => order.push('sync')),
            runPendingSendInitGuardCompensation: jest.fn(async () => order.push('compensate')),
        });
        harness.host.client.abortSession.mockImplementation(async () => {
            order.push('abort');
        });
        harness.host.client.cancelTurn.mockImplementation(() => order.push('cancel'));
        harness.host.client.finishTurn.mockImplementation(() => order.push('finish'));

        await harness.handler(
            { type: 'cancel', sessionId: 'session-A', opId: 'op-A' },
            harness.activeWebview,
            harness.activeWebview,
        );

        expect(harness.host.captureTurnCancelOwner).toHaveBeenCalledTimes(1);
        expect(harness.host.client.abortSession).toHaveBeenCalledWith('session-A');
        expect(harness.host.client.cancelTurn).toHaveBeenCalledWith('session-A', 'op-A');
        expect(harness.host.clearCanceledTurnCommandState).toHaveBeenCalledWith('session-A');
        expect(harness.posts).toContainEqual(expect.objectContaining({
            type: 'chatDone',
            sessionId: 'session-A',
        }));
        expect(order).toEqual([
            'decision',
            'abort',
            'clear-raw',
            'cancel',
            'clear-turn',
            'commit',
            'finish',
            'sync',
            'compensate',
        ]);
    });
});
