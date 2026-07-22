import { TurnFinalizationCoordinator } from '../continuation/TurnFinalizationCoordinator';

describe('TurnFinalizationCoordinator', () => {
    test('preserves canonical finalization ordering and identity binding', async () => {
        const calls: string[] = [];
        const posted: any[] = [];
        const coordinator = new TurnFinalizationCoordinator({
            getAssistantMessageId: () => 'msg_assistant',
            emitPhase: (_target, _sessionId, phase) => calls.push(`phase:${phase}`),
            postMessageIndexMap: () => calls.push('index'),
            buildIdentity: (sessionId, partial) => ({ sessionId, ...partial }),
            commitChanges: async (identity) => {
                calls.push(`commit:${identity.assistantMessageId}`);
                return { status: 'committed', msgToCommit: 'commit-a' };
            },
            finalizeBinding: async () => { calls.push('binding'); },
            resolvePendingUserUpgrade: async () => { calls.push('upgrade'); },
            promoteContinuationOwner: async () => { calls.push('promote'); },
            consolidateContinuationOwner: async () => { calls.push('consolidate'); },
            emitChangeList: async (identity) => { calls.push(`changes:${identity.commitResult?.status}`); },
            writeSnapshot: async () => { calls.push('snapshot'); },
            clearSendInFlight: () => { calls.push('clear-in-flight'); },
            finishTurn: () => { calls.push('finish'); },
            syncTurnInFlight: () => { calls.push('sync-in-flight'); },
            runSendInitCompensation: async () => { calls.push('compensation'); },
        });
        await coordinator.finalize('session-a', { postMessage: (message) => posted.push(message) });
        expect(posted).toEqual([
            { type: 'chatDone', sessionId: 'session-a', assistantMsgId: 'msg_assistant', lastAssistantMsgId: 'msg_assistant' },
            { type: 'turnInFlight', sessionId: 'session-a', inFlight: false },
        ]);
        expect(calls).toEqual([
            'phase:stream_done', 'index', 'commit:msg_assistant', 'binding',
            'phase:commit_done', 'upgrade', 'phase:upgrade_done', 'promote', 'consolidate',
            'index', 'changes:committed', 'snapshot', 'clear-in-flight', 'finish',
            'sync-in-flight', 'phase:finalize_done', 'compensation',
        ]);
    });

    test('does nothing without a session id', async () => {
        const getAssistantMessageId = jest.fn();
        const coordinator = new TurnFinalizationCoordinator({
            getAssistantMessageId,
        } as any);
        await coordinator.finalize(undefined, { postMessage: jest.fn() });
        expect(getAssistantMessageId).not.toHaveBeenCalled();
    });
});
