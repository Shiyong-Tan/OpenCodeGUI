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
        upsertCanceledTurn: jest.fn(async () => undefined),
        handleAbortedMessage: jest.fn(async () => undefined),
        resolveMessageIdentity: jest.fn(() => undefined),
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
    function sendHarness() {
        const harness = createHarness({
            trackUserOwnedSession: jest.fn(),
            isTurnCommandInFlight: jest.fn(() => false),
            normalizeReferencedWorkspaceFiles: jest.fn(async () => []),
            rememberDraft: jest.fn(), startTurnCommandState: jest.fn(),
            bindMessageIdentity: jest.fn(), setTurnPendingSnapshotUserText: jest.fn(),
            setTurnPendingSnapshotAttachments: jest.fn(), bindTurnAssistantMessage: jest.fn(),
            isTurnCommandOwner: jest.fn(() => true), emitTurnFinalizePhase: jest.fn(),
            postMessageIndexMap: jest.fn(), resolvePendingUserUpgrade: jest.fn(),
            emitDiffFileListWithRetry: jest.fn(), writeFinalizeSnapshotFromCurrentTurn: jest.fn(),
            isTurnPendingLocalKey: jest.fn(() => true), clearDraft: jest.fn(),
            clearCompletedTurnPendingUser: jest.fn(), getTurnPendingLocalKey: jest.fn(),
            clearFailedTurnCommandState: jest.fn(), finishTurnCommandState: jest.fn(() => true),
            postModelQuota: jest.fn(() => new Promise<void>(() => undefined)),
        });
        Object.assign(harness.host.client, {
            registerMessage: jest.fn(() => 1), createInternalMessageId: jest.fn(() => 'msg_assistant_A'),
            chat: jest.fn(async () => undefined), waitForSessionIdleGate: jest.fn(async () => undefined),
        });
        return harness;
    }
    const send = { type: 'sendMessage', sessionId: 'session-A', value: 'hello', clientMessageId: 'local-A', tmpKey: 'tmp:A', opId: 'op-A' };

    test.each([false, true])('releases only the owning turn despite a hung quota request (chat failure=%s)', async (fail) => {
        const h = sendHarness();
        if (fail) h.host.client.chat.mockRejectedValue(new Error('chat failed'));
        await h.handler(send, h.activeWebview, h.activeWebview);
        expect(h.host.postModelQuota).toHaveBeenCalledWith(h.activeWebview, fail ? 'chat-error' : 'chat-done');
        expect(h.host.finishTurnCommandState).toHaveBeenCalledWith('session-A', 'local-A');
        expect(h.posts).toContainEqual({ type: 'turnInFlight', sessionId: 'session-A', inFlight: false });
        expect(h.posts).not.toContainEqual(expect.objectContaining({ sessionId: 'session-B', type: 'turnInFlight' }));
        if (!fail) {
            expect(h.host.clearCompletedTurnPendingUser).toHaveBeenCalledWith('session-A', 'local-A');
            expect(h.host.clearCompletedTurnPendingUser.mock.invocationCallOrder[0]).toBeLessThan(h.host.finishTurnCommandState.mock.invocationCallOrder[0]);
        }
    });

    test('error output has one prefix and carries the owning placeholder identity', async () => {
        const h = sendHarness();
        h.host.client.chat.mockRejectedValue(new Error('Compaction stopped'));
        h.host.client.getTurnAssistantMsgId.mockReturnValue(undefined);
        await h.handler(send, h.activeWebview, h.activeWebview);
        expect(h.posts).toContainEqual({ type: 'addResponse', value: 'Error: Compaction stopped', sessionId: 'session-A', skipSnapshot: true });
        expect(h.posts).toContainEqual(expect.objectContaining({ type: 'chatDone', sessionId: 'session-A', failedTmpKey: 'tmp:A', skipSnapshot: true }));
    });

    test.each([false, true])('quota failure does not become a chat error (synchronous=%s)', async (synchronous) => {
        const h = sendHarness();
        if (synchronous) h.host.postModelQuota.mockImplementation(() => { throw new Error('quota unavailable'); });
        else h.host.postModelQuota.mockRejectedValue(new Error('quota unavailable'));
        await h.handler(send, h.activeWebview, h.activeWebview);
        await Promise.resolve();
        expect(h.posts.filter(p => p.type === 'chatDone')).toHaveLength(1);
        expect(h.posts.filter(p => p.type === 'addResponse')).toHaveLength(0);
        expect(h.host.finishTurnCommandState).toHaveBeenCalledTimes(1);
    });

    test('stale command cleanup cannot clear a newer owner or refresh quota', async () => {
        const h = sendHarness();
        h.host.isTurnCommandOwner.mockReturnValue(false);
        h.host.finishTurnCommandState.mockReturnValue(false);
        await h.handler(send, h.activeWebview, h.activeWebview);
        expect(h.posts).not.toContainEqual({ type: 'turnInFlight', sessionId: 'session-A', inFlight: false });
        expect(h.host.postModelQuota).not.toHaveBeenCalled();
    });

    test('rejects the exact optimistic send without finishing the existing turn', async () => {
        const h = sendHarness();
        h.host.isTurnCommandInFlight.mockReturnValue(true);
        await h.handler(send, h.activeWebview, h.activeWebview);
        expect(h.posts).toContainEqual({ type: 'sendRejected', sessionId: 'session-A', clientMessageId: 'local-A', tmpKey: 'tmp:A', opId: 'op-A', reason: 'turn-in-flight' });
        expect(h.host.finishTurnCommandState).not.toHaveBeenCalled();
        expect(h.host.client.chat).not.toHaveBeenCalled();
    });
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
            upsertCanceledTurn: jest.fn(async () => order.push('record-canceled')),
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
            'clear-raw',
            'cancel',
            'clear-turn',
            'record-canceled',
            'abort',
            'commit',
            'finish',
            'sync',
            'compensate',
        ]);
    });

    test('captures the draft and every append generation before cancellation awaits', async () => {
        const draft = { text: 'original request', attachments: [] };
        const harness = createHarness({
            captureTurnCancelOwner: jest.fn(() => ({
                sessionId: 'session-A',
                operationId: 'op-A',
                localKey: 'local-A',
                temporaryAssistantKey: 'tmp:A',
                assistantMessageId: 'msg_assistant_latest',
                userMessageIds: ['msg_root', 'msg_append'],
                assistantMessageIds: ['msg_assistant_1', 'msg_assistant_latest'],
            })),
            consumeDraft: jest.fn(() => draft),
        });
        harness.host.client.getPendingTurnMessageIds.mockReturnValue({
            userMsgId: 'msg_append',
            assistantMsgId: 'msg_assistant_latest',
        });

        await harness.handler(
            { type: 'cancel', sessionId: 'session-A', opId: 'op-A' },
            harness.activeWebview,
            harness.activeWebview,
        );

        expect(harness.host.consumeDraft).toHaveBeenCalledWith('local-A');
        expect(harness.posts).toContainEqual({
            type: 'restoreDraft',
            sessionId: 'session-A',
            payload: draft,
        });
        expect(harness.host.upsertCanceledTurn).toHaveBeenCalledWith(
            'session-A',
            expect.objectContaining({
                userMessageIds: ['msg_root', 'msg_append'],
                assistantMessageIds: ['msg_assistant_1', 'msg_assistant_latest'],
            }),
        );
        for (const messageId of [
            'local-A', 'tmp:A', 'msg_root', 'msg_append',
            'msg_assistant_1', 'msg_assistant_latest',
        ]) {
            expect(harness.host.handleAbortedMessage).toHaveBeenCalledWith(
                'session-A', messageId, harness.activeWebview,
            );
        }
    });
});
