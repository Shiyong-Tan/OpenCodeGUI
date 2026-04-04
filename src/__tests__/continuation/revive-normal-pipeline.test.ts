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

type ContinuationChainRuntime = {
    continuationChainId: string;
    priorAssistantFinalMsgId: string;
    sealedAt: number;
    state: string;
    continuationCount: number;
    latestContinuationMeta?: {
        continuationChainId: string;
        priorAssistantFinalMsgId: string;
        continuationSequence: number;
    };
    invalidatedReason?: string;
    invalidatedAt?: number;
};

const BACKGROUND_COMPLETE_SIGNAL = '[ALL BACKGROUND TASKS COMPLETE]';
const createdClients: OpenCodeClient[] = [];

function getChain(client: OpenCodeClient, sessionId: string): ContinuationChainRuntime | undefined {
    return (client as any).continuationChainsBySession.get(sessionId);
}

function getPostFinalWatchState(client: OpenCodeClient, sessionId: string): any {
    return (client as any).postFinalWatchStateBySession.get(sessionId);
}

function createSealedChainClient(
    sessionId: string,
    ownerMsgId = 'msg_owner_a'
): OpenCodeClient {
    const client = new OpenCodeClient() as any;
    createdClients.push(client as OpenCodeClient);
    client.startTurn(sessionId, 'local-user-1');
    client.expectedMainAgentBySession.set(sessionId, 'sisyphus');
    client.recordAssistantMsgId(sessionId, ownerMsgId);
    client.markTurnFinal(sessionId, ownerMsgId, 'sse');
    client.finishTurn(sessionId);
    return client as OpenCodeClient;
}

afterEach(async () => {
    await Promise.all(createdClients.splice(0).map((client) => client.dispose()));
});

function collectChatEvents(client: OpenCodeClient): { events: any[]; dispose: () => void } {
    const events: any[] = [];
    const handler = (evt: any) => {
        events.push(evt);
    };
    (client as any).eventListeners.add(handler);
    return { events, dispose: () => (client as any).eventListeners.delete(handler) };
}

describe('OpenCodeClient revive normal pipeline (Task 5)', () => {

    describe('background completion signal detection', () => {
        it('identifies the background completion control signal text', () => {
            const client = new OpenCodeClient() as any;
            createdClients.push(client as OpenCodeClient);
            expect(client.isBackgroundCompletionSignal(BACKGROUND_COMPLETE_SIGNAL)).toBe(true);
        });

        it('rejects normal assistant text as a control signal', () => {
            const client = new OpenCodeClient() as any;
            createdClients.push(client as OpenCodeClient);
            expect(client.isBackgroundCompletionSignal('Here is the code you requested')).toBe(false);
            expect(client.isBackgroundCompletionSignal('')).toBe(false);
            expect(client.isBackgroundCompletionSignal(undefined)).toBe(false);
        });

        it('identifies signal with surrounding whitespace', () => {
            const client = new OpenCodeClient() as any;
            createdClients.push(client as OpenCodeClient);
            expect(client.isBackgroundCompletionSignal(`  ${BACKGROUND_COMPLETE_SIGNAL}  `)).toBe(true);
        });
    });

    describe('revive gate transitions continuation chain state', () => {
        it('transitions sealed chain to revive_armed when background completion signal is received', () => {
            const sessionId = 'ses_revive_gate';
            const client = createSealedChainClient(sessionId);

            const chain = getChain(client, sessionId);
            expect(chain).toBeDefined();
            expect(chain!.state).toBe('sealed');

            (client as any).handleReviveGate(sessionId);

            const updated = getChain(client, sessionId);
            expect(updated).toBeDefined();
            expect(updated!.state).toBe('revive_armed');
        });

        it('does not transition an invalidated chain', () => {
            const sessionId = 'ses_revive_invalidated';
            const client = createSealedChainClient(sessionId);

            const chain = getChain(client, sessionId)!;
            chain.state = 'invalidated';
            chain.invalidatedReason = 'submitted-prompt';

            (client as any).handleReviveGate(sessionId);

            expect(getChain(client, sessionId)!.state).toBe('invalidated');
        });

        it('does not transition an exhausted chain', () => {
            const sessionId = 'ses_revive_exhausted';
            const client = createSealedChainClient(sessionId);

            const chain = getChain(client, sessionId)!;
            chain.state = 'exhausted';

            (client as any).handleReviveGate(sessionId);

            expect(getChain(client, sessionId)!.state).toBe('exhausted');
        });
    });

    describe('revive enters normal assistant pipeline', () => {
        it('bootstraps a new turn state after revive without invalidating the chain', () => {
            const sessionId = 'ses_revive_bootstrap';
            const client = createSealedChainClient(sessionId) as any;

            // Given: chain is revive_armed
            client.handleReviveGate(sessionId);
            expect(getChain(client, sessionId)!.state).toBe('revive_armed');

            // When: bootstrap continuation turn
            client.bootstrapContinuationTurn(sessionId);

            // Then: chain transitions and turn state is active
            expect(getChain(client, sessionId)!.state).toBe('bootstrap_buffering');
            expect(client.turnStateBySession.has(sessionId)).toBe(true);
            const turnState = client.turnStateBySession.get(sessionId);
            expect(turnState).toBeDefined();
            expect(getChain(client, sessionId)!.state).not.toBe('invalidated');
        });

        it('preserves post-final watch state across revive bootstrap', () => {
            const sessionId = 'ses_revive_preserve_watch';
            const client = createSealedChainClient(sessionId) as any;

            // Add some post-final watched changes
            client.queueTurnChanges(sessionId, sessionId, undefined, undefined, [
                { type: 'update', path: 'src/watched.ts' },
            ]);

            const watchBefore = getPostFinalWatchState(client, sessionId);
            expect(watchBefore).toBeDefined();
            expect(watchBefore.changes.length).toBe(1);

            // Revive + bootstrap
            client.handleReviveGate(sessionId);
            client.bootstrapContinuationTurn(sessionId);

            // Watch state should survive
            const watchAfter = getPostFinalWatchState(client, sessionId);
            expect(watchAfter).toBeDefined();
            expect(watchAfter.changes.length).toBe(1);
            expect(watchAfter.ownerMsgId).toBe('msg_owner_a');
        });

        it('increments continuation count on bootstrap', () => {
            const sessionId = 'ses_revive_count';
            const client = createSealedChainClient(sessionId) as any;

            const chain = getChain(client, sessionId)!;
            expect(chain.continuationCount).toBe(0);

            client.handleReviveGate(sessionId);
            client.bootstrapContinuationTurn(sessionId);

            expect(getChain(client, sessionId)!.continuationCount).toBe(1);
        });
    });

    describe('msg B captured from explicit runtime IDs', () => {
        it('captures msg B assistant ID via recordAssistantMsgId into turn state', () => {
            const sessionId = 'ses_revive_explicit_id';
            const client = createSealedChainClient(sessionId) as any;

            client.handleReviveGate(sessionId);
            client.bootstrapContinuationTurn(sessionId);

            // When: assistant message arrives with explicit ID
            const msgB = 'msg_successor_b';
            client.recordAssistantMsgId(sessionId, msgB);

            const turnState = client.turnStateBySession.get(sessionId);
            expect(turnState).toBeDefined();
            expect(turnState.assistantMsgId).toBe(msgB);
        });

        it('msg B final captured via markTurnFinal and ensureSealedContinuationChain updates chain meta', () => {
            const sessionId = 'ses_revive_final_capture';
            const client = createSealedChainClient(sessionId) as any;

            client.handleReviveGate(sessionId);
            client.bootstrapContinuationTurn(sessionId);

            const msgB = 'msg_successor_b_final';
            client.recordAssistantMsgId(sessionId, msgB);
            client.markTurnFinal(sessionId, msgB, 'sse');

            const chain = getChain(client, sessionId)!;
            expect(chain.state).toBe('continuation_active');

            const turnFinalMsgId = client.turnFinalMsgIdBySession.get(sessionId);
            expect(turnFinalMsgId).toBe(msgB);
        });

        it('after finishTurn, post-final watch state rebinds owner to msg B', () => {
            const sessionId = 'ses_revive_rebind';
            const client = createSealedChainClient(sessionId, 'msg_owner_a') as any;

            client.queueTurnChanges(sessionId, sessionId, undefined, undefined, [
                { type: 'update', path: 'src/pre-revive-watched.ts' },
            ]);

            client.handleReviveGate(sessionId);
            client.bootstrapContinuationTurn(sessionId);

            const msgB = 'msg_owner_b';
            client.expectedMainAgentBySession.set(sessionId, 'sisyphus');
            client.recordAssistantMsgId(sessionId, msgB);
            client.markTurnFinal(sessionId, msgB, 'sse');
            client.finishTurn(sessionId);

            // Post-final watch state should now point to msg B
            const watch = getPostFinalWatchState(client, sessionId);
            expect(watch).toBeDefined();
            expect(watch.ownerMsgId).toBe(msgB);
            expect(watch.lastAssistantMsgId).toBe(msgB);
        });
    });

    describe('control signal stays invisible in timeline/snapshot content', () => {
        it('does not emit the background completion signal as visible text in chat events', () => {
            const sessionId = 'ses_revive_invisible';
            const client = createSealedChainClient(sessionId) as any;

            const { events } = collectChatEvents(client);

            client.handleReviveGate(sessionId);

            const signalLeaked = events.some((evt: any) => {
                if (typeof evt.text === 'string' && evt.text.includes(BACKGROUND_COMPLETE_SIGNAL)) return true;
                if (typeof evt.lastText === 'string' && evt.lastText.includes(BACKGROUND_COMPLETE_SIGNAL)) return true;
                return false;
            });
            expect(signalLeaked).toBe(false);
        });

        it('isBackgroundCompletionSignal prevents signal text from entering the text event pipeline', () => {
            const client = new OpenCodeClient() as any;
            createdClients.push(client as OpenCodeClient);
            expect(client.isBackgroundCompletionSignal(BACKGROUND_COMPLETE_SIGNAL)).toBe(true);
            expect(client.isBackgroundCompletionSignal('Normal assistant response')).toBe(false);
        });
    });

    describe('repeated retry/revive from current owner after failure', () => {
        it('supports revive after a failed continuation attempt', () => {
            const sessionId = 'ses_revive_retry';
            const client = createSealedChainClient(sessionId, 'msg_owner_a') as any;

            // Given: chain is sealed after msg A finalization
            expect(getChain(client, sessionId)!.state).toBe('sealed');

            // When: first revive attempt
            client.handleReviveGate(sessionId);
            client.bootstrapContinuationTurn(sessionId);
            expect(getChain(client, sessionId)!.state).toBe('bootstrap_buffering');

            // When: continuation fails
            client.handleFailedContinuationRevive(sessionId);

            // Then: chain resets to sealed, watch state preserved under original owner
            const chainAfterFail = getChain(client, sessionId)!;
            expect(chainAfterFail.state).toBe('sealed');
            const watch = getPostFinalWatchState(client, sessionId);
            expect(watch).toBeDefined();
            expect(watch.ownerMsgId).toBe('msg_owner_a');

            // When: second revive attempt
            client.handleReviveGate(sessionId);
            expect(getChain(client, sessionId)!.state).toBe('revive_armed');
            client.bootstrapContinuationTurn(sessionId);

            // Then: bootstrap succeeds with incremented count
            expect(getChain(client, sessionId)!.state).toBe('bootstrap_buffering');
            expect(getChain(client, sessionId)!.continuationCount).toBe(2);
        });

        it('preserves failed-attempt watched edits under the current owner and clears stale retry state', () => {
            const sessionId = 'ses_revive_failed_attempt_watch';
            const client = createSealedChainClient(sessionId, 'msg_owner_a') as any;

            client.queueTurnChanges(sessionId, sessionId, undefined, undefined, [
                { type: 'update', path: 'src/pre-failure-watch.ts' },
            ]);

            client.handleReviveGate(sessionId);
            client.bootstrapContinuationTurn(sessionId);
            client.setPendingAssistantTmpKey(sessionId, 'tmp:failed-attempt');
            client.recordAssistantMsgId(sessionId, 'msg_failed_attempt');
            client.queueTurnChanges(sessionId, 'cont-turn-1', 'tmp:failed-attempt', 'msg_failed_attempt', [
                { type: 'update', path: 'src/failed-attempt-watch.ts' },
            ]);
            client.cancelTurn(sessionId, 'op_cancel_failed_attempt');

            client.finishTurn(sessionId);

            expect(getChain(client, sessionId)!.state).toBe('sealed');
            expect(getPostFinalWatchState(client, sessionId)).toMatchObject({
                ownerMsgId: 'msg_owner_a',
                lastAssistantMsgId: 'msg_owner_a',
                changes: [
                    { type: 'update', path: 'src/pre-failure-watch.ts' },
                    { type: 'update', path: 'src/failed-attempt-watch.ts' },
                ],
            });
            expect(client.pendingTurnChangesBySession.has(sessionId)).toBe(false);
            expect(client.currentTurnAssistantMsgIdBySession.has(sessionId)).toBe(false);
            expect(client.pendingAssistantMsgIdBySession.has(sessionId)).toBe(false);
            expect(client.pendingUserMsgIdBySession.has(sessionId)).toBe(false);
            expect(client.currentTurnUserMsgIdBySession.has(sessionId)).toBe(false);
            expect(client.activeTurnOpIdBySession.has(sessionId)).toBe(false);
        });

        it('promotes exactly once after retry success without duplicating failed-attempt watch state', () => {
            const sessionId = 'ses_revive_retry_then_success';
            const client = createSealedChainClient(sessionId, 'msg_owner_a') as any;

            client.queueTurnChanges(sessionId, sessionId, undefined, undefined, [
                { type: 'update', path: 'src/pre-failure-watch.ts' },
            ]);

            client.handleReviveGate(sessionId);
            client.bootstrapContinuationTurn(sessionId);
            client.setPendingAssistantTmpKey(sessionId, 'tmp:failed-attempt');
            client.recordAssistantMsgId(sessionId, 'msg_failed_attempt');
            client.queueTurnChanges(sessionId, 'cont-turn-1', 'tmp:failed-attempt', 'msg_failed_attempt', [
                { type: 'update', path: 'src/failed-attempt-watch.ts' },
            ]);

            client.cancelTurn(sessionId);
            client.finishTurn(sessionId);

            client.handleReviveGate(sessionId);
            client.bootstrapContinuationTurn(sessionId);
            client.setPendingAssistantTmpKey(sessionId, 'tmp:successful-attempt');
            client.recordAssistantMsgId(sessionId, 'msg_owner_b');
            client.expectedMainAgentBySession.set(sessionId, 'sisyphus');
            client.markTurnFinal(sessionId, 'msg_owner_b', 'sse');
            client.finishTurn(sessionId);

            client.queueTurnChanges(sessionId, sessionId, undefined, undefined, [
                { type: 'update', path: 'src/post-success-watch.ts' },
            ]);

            const watch = getPostFinalWatchState(client, sessionId);
            expect(getChain(client, sessionId)!.continuationCount).toBe(2);
            expect(watch).toMatchObject({
                ownerMsgId: 'msg_owner_b',
                lastAssistantMsgId: 'msg_owner_b',
            });
            expect(watch.changes).toEqual([
                { type: 'update', path: 'src/pre-failure-watch.ts' },
                { type: 'update', path: 'src/failed-attempt-watch.ts' },
                { type: 'update', path: 'src/post-success-watch.ts' },
            ]);
            expect(watch.changes.filter((change: any) => change.path === 'src/failed-attempt-watch.ts')).toHaveLength(1);
            expect(client.getTurnAssistantMsgId(sessionId)).toBeUndefined();
            expect(client.pendingAssistantMsgIdBySession.has(sessionId)).toBe(false);
        });

        it('respects exhaustion limit after max retry attempts', () => {
            const sessionId = 'ses_revive_exhaust';
            const client = createSealedChainClient(sessionId) as any;

            const maxContinuations = (client as any).maxContinuationCountPerOriginalTurn || 2;

            for (let i = 0; i < maxContinuations; i++) {
                client.handleReviveGate(sessionId);
                client.bootstrapContinuationTurn(sessionId);
                if (i < maxContinuations - 1) {
                    client.cancelTurn(sessionId);
                    client.finishTurn(sessionId);
                }
            }

            const shouldDrop = client.shouldDropLateContinuationByExhaustedPolicy(sessionId);
            expect(shouldDrop).toBe(true);
            expect(getChain(client, sessionId)!.state).toBe('exhausted');
        });
    });

    describe('continuation chain state transitions during revive lifecycle', () => {
        it('follows sealed → revive_armed → bootstrap_buffering → continuation_active flow', () => {
            const sessionId = 'ses_revive_lifecycle';
            const client = createSealedChainClient(sessionId) as any;

            // Given: sealed
            expect(getChain(client, sessionId)!.state).toBe('sealed');

            // When: revive_armed
            client.handleReviveGate(sessionId);
            expect(getChain(client, sessionId)!.state).toBe('revive_armed');

            // When: bootstrap_buffering
            client.bootstrapContinuationTurn(sessionId);
            expect(getChain(client, sessionId)!.state).toBe('bootstrap_buffering');

            // When: continuation assistant finalized → continuation_active
            const msgB = 'msg_continuation_b';
            client.recordAssistantMsgId(sessionId, msgB);
            client.markTurnFinal(sessionId, msgB, 'sse');

            // Then: state is continuation_active
            expect(getChain(client, sessionId)!.state).toBe('continuation_active');
        });
    });

    describe('production runtime path: mapServerEventToChatEvents consumes signal', () => {

        function makeTextPartEvent(sessionId: string, messageId: string, text: string) {
            return {
                type: 'message.part.updated',
                props: {
                    part: {
                        type: 'text',
                        sessionID: sessionId,
                        messageID: messageId,
                        text,
                    },
                },
            };
        }

        it('signal SSE event does not emit visible text and transitions chain to bootstrap_buffering', () => {
            const sessionId = 'ses_runtime_signal';
            const client = createSealedChainClient(sessionId) as any;

            // Given: chain is sealed, turn is finished (post-final window)
            expect(getChain(client, sessionId)!.state).toBe('sealed');
            expect(client.turnFinishedBySession.has(sessionId)).toBe(true);

            // When: SSE delivers the background completion signal
            const sse = makeTextPartEvent(sessionId, 'msg_signal_carrier', BACKGROUND_COMPLETE_SIGNAL);
            const events: any[] = client.mapServerEventToChatEvents(sse.type, sse.props, 'sse');

            // Then: no visible text event emitted
            const textEvents = events.filter((e: any) => e.type === 'text');
            expect(textEvents).toHaveLength(0);

            // Then: chain transitioned through revive_armed → bootstrap_buffering atomically
            expect(getChain(client, sessionId)!.state).toBe('bootstrap_buffering');
        });

        it('signal SSE event does not emit assistantMessageMeta containing the signal', () => {
            const sessionId = 'ses_runtime_meta_invisible';
            const client = createSealedChainClient(sessionId) as any;

            const sse = makeTextPartEvent(sessionId, 'msg_signal_meta', BACKGROUND_COMPLETE_SIGNAL);
            const events: any[] = client.mapServerEventToChatEvents(sse.type, sse.props, 'sse');

            const leakedMeta = events.filter((e: any) =>
                e.type === 'assistantMessageMeta' &&
                typeof e.lastText === 'string' &&
                e.lastText.includes(BACKGROUND_COMPLETE_SIGNAL)
            );
            expect(leakedMeta).toHaveLength(0);
        });

        it('normal assistant text SSE event still emits visible text (no false positive suppression)', () => {
            const sessionId = 'ses_runtime_normal';
            const client = new OpenCodeClient() as any;
            createdClients.push(client as OpenCodeClient);

            // Given: active turn (not finished) so text flows through
            client.startTurn(sessionId, 'local-user-1');
            client.expectedMainAgentBySession.set(sessionId, 'sisyphus');

            // When: normal text arrives
            const sse = makeTextPartEvent(sessionId, 'msg_normal_asst', 'Here is the code you requested.');
            const events: any[] = client.mapServerEventToChatEvents(sse.type, sse.props, 'sse');

            // Then: text event IS emitted
            const textEvents = events.filter((e: any) => e.type === 'text');
            expect(textEvents.length).toBeGreaterThan(0);
        });

        it('after signal consumption, new assistant text flows through the normal pipeline', () => {
            const sessionId = 'ses_runtime_bootstrap_flow';
            const client = createSealedChainClient(sessionId) as any;

            // Given: signal consumed — chain atomically moves to bootstrap_buffering
            const sse = makeTextPartEvent(sessionId, 'msg_signal_flow', BACKGROUND_COMPLETE_SIGNAL);
            client.mapServerEventToChatEvents(sse.type, sse.props, 'sse');
            expect(getChain(client, sessionId)!.state).toBe('bootstrap_buffering');

            // When: real continuation assistant text arrives via SSE
            const realText = makeTextPartEvent(sessionId, 'msg_real_b', 'I have completed the implementation.');
            const events: any[] = client.mapServerEventToChatEvents(realText.type, realText.props, 'sse');

            // Then: visible text IS emitted for the real assistant
            const textEvents = events.filter((e: any) => e.type === 'text');
            expect(textEvents.length).toBeGreaterThan(0);
            expect(textEvents[0].text).toContain('I have completed the implementation.');
        });

        it('signal message is marked as hidden control user msg', () => {
            const sessionId = 'ses_runtime_hidden';
            const client = createSealedChainClient(sessionId) as any;

            const signalMsgId = 'msg_signal_hidden_check';
            const sse = makeTextPartEvent(sessionId, signalMsgId, BACKGROUND_COMPLETE_SIGNAL);
            client.mapServerEventToChatEvents(sse.type, sse.props, 'sse');

            // Then: signal carrier message is remembered as hidden control
            const hiddenSet: Set<string> | undefined = client.hiddenControlUserMsgIdsBySession.get(sessionId);
            expect(hiddenSet).toBeDefined();
            expect(hiddenSet!.has(signalMsgId)).toBe(true);
        });

        it('signal bypasses the turnFinished guard that blocks other SSE events', () => {
            const sessionId = 'ses_runtime_bypass_guard';
            const client = createSealedChainClient(sessionId) as any;

            // Given: turn is finished (post-final window)
            expect(client.turnFinishedBySession.has(sessionId)).toBe(true);

            // Given: normal SSE text is blocked by the turnFinished guard
            const normalSse = makeTextPartEvent(sessionId, 'msg_blocked', 'Should be blocked');
            const blockedEvents: any[] = client.mapServerEventToChatEvents(normalSse.type, normalSse.props, 'sse');
            expect(blockedEvents).toHaveLength(0);

            // When: background completion signal arrives (also during post-final window)
            const signalSse = makeTextPartEvent(sessionId, 'msg_signal_bypass', BACKGROUND_COMPLETE_SIGNAL);
            const signalEvents: any[] = client.mapServerEventToChatEvents(signalSse.type, signalSse.props, 'sse');

            // Then: signal is consumed (returns empty events) but chain IS transitioned
            expect(signalEvents).toHaveLength(0);
            expect(getChain(client, sessionId)!.state).toBe('bootstrap_buffering');
        });
    });
});
