/**
 * End-to-end regression boundary for continuation takeover.
 *
 * This suite exercises the full connected lifecycle in a single test flow:
 *   start → post-final watch → signal → revive → continuation → final → handoff
 *   → snapshot/reload → undo resolution
 *
 * It consolidates the 8 required regression scenarios:
 *   1. Success takeover
 *   2. Failure retention
 *   3. Repeated retry
 *   4. Chained current-owner handoff (A → B → C)
 *   5. Reload consistency
 *   6. Invisible control signal
 *   7. Changelist dedup
 *   8. Undo/restore current-owner resolution
 */

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
import { GitSessionMapStore } from '../../undo/GitSessionMapStore';
import { resolveSessionOwnership, resolveCurrentOwnerMsgId } from '../../undo/ownershipResolver';
import { SidebarProvider } from '../../SidebarProvider';
import { OpenCodeDiffProvider } from '../../OpenCodeDiffProvider';
import {
    makeSessionMap,
    makeSessionEntry,
    makeCommitHash,
    makeHandoffMetadata,
    makePostFinalWatchEntry,
    buildSuccessfulTakeoverScenario,
    buildFailedContinuationScenario,
    buildChainedTakeoverScenario,
    resetFactoryCounters,
} from '../helpers/continuation-factories';

const BACKGROUND_COMPLETE_SIGNAL = '[ALL BACKGROUND TASKS COMPLETE]';
const createdClients: OpenCodeClient[] = [];
const createdProviders: Array<{ dispose: () => Promise<void> }> = [];

// --- Helpers ---

function getChain(client: OpenCodeClient, sessionId: string): any {
    return (client as any).continuationChainsBySession.get(sessionId);
}

function getPostFinalWatchState(client: OpenCodeClient, sessionId: string): any {
    return (client as any).postFinalWatchStateBySession.get(sessionId);
}

function createSealedChainClient(sessionId: string, ownerMsgId = 'msg_owner_a'): OpenCodeClient {
    const client = new OpenCodeClient() as any;
    createdClients.push(client as OpenCodeClient);
    client.startTurn(sessionId, 'local-user-1');
    client.expectedMainAgentBySession.set(sessionId, 'sisyphus');
    client.recordAssistantMsgId(sessionId, ownerMsgId);
    client.markTurnFinal(sessionId, ownerMsgId, 'sse');
    client.finishTurn(sessionId);
    return client as OpenCodeClient;
}

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

function createSidebarProvider(): any {
    const context: any = {
        globalState: { get: () => undefined, update: () => Promise.resolve() },
        extensionUri: { fsPath: 'D:\\0.Code\\OpenCodeGUI' },
        globalStoragePath: 'D:\\0.Code\\OpenCodeGUI\\.tmp-test',
    };
    const diffProvider = { updateFromSnapshot: jest.fn() } as unknown as OpenCodeDiffProvider;
    const provider = new SidebarProvider(context, context.extensionUri, diffProvider) as any;
    createdProviders.push(provider);
    provider.uiDebugChannel = { appendLine: jest.fn() };
    return provider;
}

afterEach(async () => {
    await Promise.all([
        ...createdClients.splice(0).map((client) => typeof client.dispose === 'function' ? client.dispose() : undefined),
        ...createdProviders.splice(0).map((provider) => typeof provider.dispose === 'function' ? provider.dispose() : undefined),
    ]);
});

beforeEach(() => {
    resetFactoryCounters();
});

// ─────────────────────────────────────────────────────────────────────────
// Regression Scenario 1: Full success takeover lifecycle A → B
// ─────────────────────────────────────────────────────────────────────────
describe('E2E Scenario 1: success takeover full lifecycle', () => {
    it('drives msg A final → post-final watch → signal → revive → msg B final → owner handoff', () => {
        const sessionId = 'ses_e2e_success';
        const client = createSealedChainClient(sessionId, 'msg_owner_a') as any;

        // Phase 1: post-final watch collects changes
        client.queueTurnChanges(sessionId, sessionId, undefined, undefined, [
            { type: 'update', path: 'src/post-final-edit.ts' },
        ]);
        const watchAfterPostFinal = getPostFinalWatchState(client, sessionId);
        expect(watchAfterPostFinal).toBeDefined();
        expect(watchAfterPostFinal.ownerMsgId).toBe('msg_owner_a');
        expect(watchAfterPostFinal.changes).toHaveLength(1);

        // Phase 2: background completion signal → revive
        const signalSse = makeTextPartEvent(sessionId, 'msg_signal', BACKGROUND_COMPLETE_SIGNAL);
        const signalEvents: any[] = client.mapServerEventToChatEvents(signalSse.type, signalSse.props, 'sse');
        expect(signalEvents.filter((e: any) => e.type === 'text')).toHaveLength(0); // invisible
        expect(getChain(client, sessionId)!.state).toBe('bootstrap_buffering');

        // Phase 3: continuation assistant msg B streams and finalizes
        client.expectedMainAgentBySession.set(sessionId, 'sisyphus');
        client.recordAssistantMsgId(sessionId, 'msg_owner_b');
        client.markTurnFinal(sessionId, 'msg_owner_b', 'sse');
        expect(getChain(client, sessionId)!.state).toBe('continuation_active');

        // Phase 4: finish turn — post-final watch rebinds to msg B
        client.finishTurn(sessionId);
        const watchAfterHandoff = getPostFinalWatchState(client, sessionId);
        expect(watchAfterHandoff.ownerMsgId).toBe('msg_owner_b');
        expect(watchAfterHandoff.lastAssistantMsgId).toBe('msg_owner_b');

        // Phase 5: store-level handoff via bindFinalMsg
        const scenario = buildSuccessfulTakeoverScenario();
        const store = new GitSessionMapStore('D:\\0.Code\\OpenCodeGUI', () => undefined);
        const tmpKey = 'tmp_assistant_b';
        const sessionMap = makeSessionMap({
            ...scenario.sessionMap,
            entries: [
                ...scenario.sessionMap.entries,
                makeSessionEntry({ tmpKey, commitHash: scenario.commitB, touchedFiles: ['src/b.ts'], opType: 'update' }),
            ],
            tmpToCommit: { [tmpKey]: scenario.commitB },
            tmpToBaseCommit: { [tmpKey]: scenario.commitA },
            continuation: scenario.handoffBeforeTakeover,
        });
        const updated = store.bindFinalMsg(sessionMap, tmpKey, scenario.msgB);
        expect(updated.continuation?.currentOwnerMsgId).toBe(scenario.msgB);
        expect(updated.continuation?.predecessorOwnerMsgId).toBe(scenario.msgA);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Regression Scenario 2: Failure retention — owner stays unchanged
// ─────────────────────────────────────────────────────────────────────────
describe('E2E Scenario 2: failure retention keeps current owner', () => {
    it('failed continuation preserves msg A as owner with appended watched edits', () => {
        const sessionId = 'ses_e2e_failure';
        const client = createSealedChainClient(sessionId, 'msg_owner_a') as any;

        // Add post-final edits
        client.queueTurnChanges(sessionId, sessionId, undefined, undefined, [
            { type: 'update', path: 'src/pre-failure.ts' },
        ]);

        // Revive + bootstrap
        client.handleReviveGate(sessionId);
        client.bootstrapContinuationTurn(sessionId);

        // Failed attempt adds more edits then cancels
        client.setPendingAssistantTmpKey(sessionId, 'tmp:failed');
        client.recordAssistantMsgId(sessionId, 'msg_failed_attempt');
        client.queueTurnChanges(sessionId, 'cont-turn-1', 'tmp:failed', 'msg_failed_attempt', [
            { type: 'update', path: 'src/during-failure.ts' },
        ]);
        client.cancelTurn(sessionId);
        client.finishTurn(sessionId);

        // Owner unchanged, chain resealed
        expect(getChain(client, sessionId)!.state).toBe('sealed');
        expect(getPostFinalWatchState(client, sessionId)).toMatchObject({
            ownerMsgId: 'msg_owner_a',
            changes: expect.arrayContaining([
                expect.objectContaining({ path: 'src/pre-failure.ts' }),
                expect.objectContaining({ path: 'src/during-failure.ts' }),
            ]),
        });

        // Store-level: no promotion when tmp binding missing
        const scenario = buildFailedContinuationScenario();
        const store = new GitSessionMapStore('D:\\0.Code\\OpenCodeGUI', () => undefined);
        const sessionMap = makeSessionMap({
            ...scenario.sessionMap,
            tmpToCommit: {},
            tmpToBaseCommit: {},
            continuation: scenario.handoff,
        });
        const updated = store.bindFinalMsg(sessionMap, 'tmp_missing', 'msg_failed_b');
        expect(updated.continuation?.currentOwnerMsgId).toBe(scenario.msgA);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Regression Scenario 3: Repeated retry — fail then succeed
// ─────────────────────────────────────────────────────────────────────────
describe('E2E Scenario 3: repeated retry then success', () => {
    it('fail → reseal → revive → succeed → promote exactly once', () => {
        const sessionId = 'ses_e2e_retry';
        const client = createSealedChainClient(sessionId, 'msg_owner_a') as any;

        // Pre-failure edits
        client.queueTurnChanges(sessionId, sessionId, undefined, undefined, [
            { type: 'update', path: 'src/pre-retry.ts' },
        ]);

        // First attempt: fail
        client.handleReviveGate(sessionId);
        client.bootstrapContinuationTurn(sessionId);
        client.setPendingAssistantTmpKey(sessionId, 'tmp:attempt1');
        client.recordAssistantMsgId(sessionId, 'msg_attempt1');
        client.queueTurnChanges(sessionId, 'cont-1', 'tmp:attempt1', 'msg_attempt1', [
            { type: 'update', path: 'src/attempt1.ts' },
        ]);
        client.cancelTurn(sessionId);
        client.finishTurn(sessionId);
        expect(getChain(client, sessionId)!.state).toBe('sealed');
        expect(getChain(client, sessionId)!.continuationCount).toBe(1);

        // Second attempt: succeed
        client.handleReviveGate(sessionId);
        client.bootstrapContinuationTurn(sessionId);
        expect(getChain(client, sessionId)!.continuationCount).toBe(2);
        client.setPendingAssistantTmpKey(sessionId, 'tmp:attempt2');
        client.recordAssistantMsgId(sessionId, 'msg_owner_b');
        client.expectedMainAgentBySession.set(sessionId, 'sisyphus');
        client.markTurnFinal(sessionId, 'msg_owner_b', 'sse');
        client.finishTurn(sessionId);

        // Post-success watch collects new edits
        client.queueTurnChanges(sessionId, sessionId, undefined, undefined, [
            { type: 'update', path: 'src/post-success.ts' },
        ]);

        const watch = getPostFinalWatchState(client, sessionId);
        expect(watch.ownerMsgId).toBe('msg_owner_b');
        expect(watch.changes).toEqual(expect.arrayContaining([
            expect.objectContaining({ path: 'src/pre-retry.ts' }),
            expect.objectContaining({ path: 'src/attempt1.ts' }),
            expect.objectContaining({ path: 'src/post-success.ts' }),
        ]));
        // No duplicate failed-attempt entries
        expect(watch.changes.filter((c: any) => c.path === 'src/attempt1.ts')).toHaveLength(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Regression Scenario 4: Chained handoff A → B → C via store
// ─────────────────────────────────────────────────────────────────────────
describe('E2E Scenario 4: chained current-owner handoff A → B → C', () => {
    it('successive bindFinalMsg calls collapse ownership to C', () => {
        const scenario = buildChainedTakeoverScenario();
        const store = new GitSessionMapStore('D:\\0.Code\\OpenCodeGUI', () => undefined);

        const tmpKeyB = 'tmp_assistant_b';
        const tmpKeyC = 'tmp_assistant_c';

        // A → B
        let sessionMap = makeSessionMap({
            ...scenario.sessionMap,
            entries: [
                ...scenario.sessionMap.entries,
                makeSessionEntry({ tmpKey: tmpKeyB, commitHash: scenario.commitB, touchedFiles: ['src/b.ts'], opType: 'update' }),
            ],
            tmpToCommit: { [tmpKeyB]: scenario.commitB },
            tmpToBaseCommit: { [tmpKeyB]: scenario.commitA },
            continuation: scenario.handoffAfterA,
        });
        sessionMap = store.bindFinalMsg(sessionMap, tmpKeyB, scenario.msgB);
        expect(sessionMap.continuation?.currentOwnerMsgId).toBe(scenario.msgB);

        // B → C
        sessionMap = {
            ...sessionMap,
            entries: [
                ...sessionMap.entries,
                makeSessionEntry({ tmpKey: tmpKeyC, commitHash: scenario.commitC, touchedFiles: ['src/c.ts'], opType: 'update' }),
            ],
            tmpToCommit: { ...sessionMap.tmpToCommit, [tmpKeyC]: scenario.commitC },
            tmpToBaseCommit: { ...sessionMap.tmpToBaseCommit, [tmpKeyC]: scenario.commitB },
        };
        sessionMap = store.bindFinalMsg(sessionMap, tmpKeyC, scenario.msgC);
        expect(sessionMap.continuation?.currentOwnerMsgId).toBe(scenario.msgC);
        expect(sessionMap.continuation?.continuationSequence).toBe(3);

        // Ownership resolver confirms C
        const resolved = resolveSessionOwnership(sessionMap, scenario.msgA);
        expect(resolved.currentOwnerMsgId).toBe(scenario.msgC);
        expect(resolved.predecessorOwnerMsgId).toBe(scenario.msgB);

        // Historical bindings remain intact
        expect(sessionMap.msgToCommit[scenario.msgA]).toBe(scenario.commitA);
        expect(sessionMap.msgToCommit[scenario.msgB]).toBe(scenario.commitB);
        expect(sessionMap.msgToCommit[scenario.msgC]).toBe(scenario.commitC);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Regression Scenario 5: Reload consistency
// ─────────────────────────────────────────────────────────────────────────
describe('E2E Scenario 5: reload consistency', () => {
    it('persisted handoff metadata reconstructs the same current owner on reload', async () => {
        const scenario = buildSuccessfulTakeoverScenario();

        // Simulate persisted state
        const handoff = makeHandoffMetadata({
            chainId: scenario.chainId,
            currentOwnerMsgId: scenario.msgB,
            predecessorOwnerMsgId: scenario.msgA,
            continuationSequence: 2,
            lifecycleState: 'idle',
        });

        // Reload resolves from metadata, not ordering
        const resolvedOwner = resolveCurrentOwnerMsgId({ continuation: handoff }, scenario.msgA);
        expect(resolvedOwner).toBe(scenario.msgB);

        // Chained reload also resolves correctly
        const chainScenario = buildChainedTakeoverScenario();
        const chainReload = resolveCurrentOwnerMsgId(
            { continuation: chainScenario.handoffAfterC },
            chainScenario.msgA
        );
        expect(chainReload).toBe(chainScenario.msgC);

        // No continuation returns fallback
        const noContReload = resolveCurrentOwnerMsgId({ continuation: undefined }, 'msg_original');
        expect(noContReload).toBe('msg_original');
    });

    it('store persistence round-trip preserves continuation metadata', async () => {
        const scenario = buildSuccessfulTakeoverScenario();
        const store = new GitSessionMapStore('D:\\0.Code\\OpenCodeGUI', () => undefined);

        const tmpKey = 'tmp_b';
        const sessionMap = makeSessionMap({
            ...scenario.sessionMap,
            entries: [
                ...scenario.sessionMap.entries,
                makeSessionEntry({ tmpKey, commitHash: scenario.commitB, touchedFiles: ['src/b.ts'], opType: 'update' }),
            ],
            tmpToCommit: { [tmpKey]: scenario.commitB },
            tmpToBaseCommit: { [tmpKey]: scenario.commitA },
            continuation: scenario.handoffBeforeTakeover,
        });

        const after = store.bindFinalMsg(sessionMap, tmpKey, scenario.msgB);
        // Verify the critical fields survive through the bind
        expect(after.continuation?.currentOwnerMsgId).toBe(scenario.msgB);
        expect(after.continuation?.predecessorOwnerMsgId).toBe(scenario.msgA);
        expect(after.continuation?.continuationSequence).toBe(2);
        expect(after.continuation?.lifecycleState).toBe('idle');
        expect(after.continuation?.chainId).toBe(scenario.chainId);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Regression Scenario 6: Invisible control signal
// ─────────────────────────────────────────────────────────────────────────
describe('E2E Scenario 6: invisible control signal', () => {
    it('background completion signal is consumed as control flow and never reaches visible events', () => {
        const sessionId = 'ses_e2e_invisible';
        const client = createSealedChainClient(sessionId) as any;

        // Detection
        expect(client.isBackgroundCompletionSignal(BACKGROUND_COMPLETE_SIGNAL)).toBe(true);
        expect(client.isBackgroundCompletionSignal('Normal text')).toBe(false);
        expect(client.isBackgroundCompletionSignal(`  ${BACKGROUND_COMPLETE_SIGNAL}  `)).toBe(true);

        // SSE: no visible text events, no leaked meta, chain transitioned
        const sse = makeTextPartEvent(sessionId, 'msg_signal_carrier', BACKGROUND_COMPLETE_SIGNAL);
        const events: any[] = client.mapServerEventToChatEvents(sse.type, sse.props, 'sse');
        expect(events.filter((e: any) => e.type === 'text')).toHaveLength(0);
        expect(events.filter((e: any) =>
            e.type === 'assistantMessageMeta' &&
            typeof e.lastText === 'string' &&
            e.lastText.includes(BACKGROUND_COMPLETE_SIGNAL)
        )).toHaveLength(0);
        expect(getChain(client, sessionId)!.state).toBe('bootstrap_buffering');

        // Hidden control marker set
        const hiddenSet: Set<string> = client.hiddenControlUserMsgIdsBySession.get(sessionId);
        expect(hiddenSet).toBeDefined();
        expect(hiddenSet.has('msg_signal_carrier')).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Regression Scenario 7: Changelist dedup via sidebar
// ─────────────────────────────────────────────────────────────────────────
describe('E2E Scenario 7: changelist dedup through current owner', () => {
    function createSidebarWithClient(): any {
        const provider = createSidebarProvider();
        provider.client = {
            getTurnAssistantMsgId: jest.fn().mockReturnValue('msg_owner_a'),
            getLastTurnCommitBase: jest.fn().mockReturnValue(null),
            wasChangeListEmitted: jest.fn().mockReturnValue(false),
            markChangeListEmitted: jest.fn().mockReturnValue(true),
            getCommitHashesForMessageIds: jest.fn().mockResolvedValue([]),
            dispose: jest.fn().mockResolvedValue(undefined),
        };
        provider.gitUndoEnabled = true;
        return provider;
    }

    it('stale-anchored changelist record is reanchored to current owner during inject', async () => {
        const provider = createSidebarWithClient();
        const scenario = buildSuccessfulTakeoverScenario();
        provider.readPersistedSessionMap = jest.fn().mockResolvedValue({
            ...scenario.sessionMap,
            continuation: scenario.handoffAfterTakeover,
            msgToCommit: {
                ...scenario.sessionMap.msgToCommit,
                [scenario.msgB]: scenario.commitB,
            },
        });
        provider.readChangeLists = jest.fn().mockResolvedValue([
            {
                id: 'system:changeList:head1',
                commitHead: 'head1',
                commitBase: 'base1',
                files: ['src/stale.ts'],
                anchorMessageId: scenario.msgA,
                createdAt: 1,
            },
        ]);
        provider.readCanceledTurns = jest.fn().mockResolvedValue([]);
        provider.normalizeDisplayMessagesForSnapshot = jest.fn().mockImplementation((msgs: any[]) => msgs);

        const formatted = {
            title: 'Test',
            messages: [
                { id: 'msg_user_1', role: 'user', text: 'hello' },
                { id: scenario.msgB, role: 'assistant', text: 'response' },
            ],
        };

        const result = await provider.injectChangeLists('ses_e2e', formatted);
        const clMsgs = result.messages.filter((m: any) => m.meta?.kind === 'changeList');
        expect(clMsgs).toHaveLength(1);
        const ownerIdx = result.messages.findIndex((m: any) => m.id === scenario.msgB);
        const clIdx = result.messages.findIndex((m: any) => m.meta?.kind === 'changeList');
        expect(clIdx).toBe(ownerIdx + 1);
        expect(clMsgs[0].meta).toEqual(expect.objectContaining({
            anchorMessageId: scenario.msgB,
            stableAnchorMessageId: scenario.msgB,
        }));
    });

    it('upsert resolves anchor through current owner, not historical', async () => {
        const provider = createSidebarWithClient();
        const scenario = buildSuccessfulTakeoverScenario();
        provider.readPersistedSessionMap = jest.fn().mockResolvedValue({
            ...scenario.sessionMap,
            continuation: scenario.handoffAfterTakeover,
            msgToCommit: {
                ...scenario.sessionMap.msgToCommit,
                [scenario.msgB]: scenario.commitB,
            },
        });
        provider.readChangeLists = jest.fn().mockResolvedValue([
            {
                id: 'system:changeList:head2',
                commitHead: 'head2',
                commitBase: 'base2',
                files: ['src/a.ts'],
                anchorMessageId: scenario.msgA,
                createdAt: 1,
            },
        ]);
        provider.writeChangeLists = jest.fn().mockResolvedValue(undefined);

        await provider.upsertChangeList('ses_e2e', {
            id: 'system:changeList:head2',
            commitHead: 'head2',
            commitBase: 'base2',
            files: ['src/a.ts', 'src/b.ts'],
            anchorMessageId: scenario.msgB,
            createdAt: 2,
        });

        expect(provider.writeChangeLists).toHaveBeenCalledWith(
            'ses_e2e',
            expect.arrayContaining([
                expect.objectContaining({
                    anchorMessageId: scenario.msgB,
                    files: ['src/a.ts', 'src/b.ts'],
                }),
            ])
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Regression Scenario 8: Undo/restore current-owner resolution
// ─────────────────────────────────────────────────────────────────────────
describe('E2E Scenario 8: undo/restore routes through current owner', () => {
    it('undoFromMessage redirects superseded owner to effective current owner for commit lookup', async () => {
        const requestedMsgId = 'msg_superseded_A';
        const effectiveOwnerMsgId = 'msg_current_B';
        const effectiveOwnerCommit = makeCommitHash('owner-commit');
        const effectiveOwnerBaseCommit = makeCommitHash('effective-base');
        const currentHeadCommit = makeCommitHash('head');

        const map = makeSessionMap({
            headCommit: currentHeadCommit,
            currentBaseCommit: currentHeadCommit,
            msgToCommit: { [effectiveOwnerMsgId]: effectiveOwnerCommit },
            msgToBaseCommit: {
                [requestedMsgId]: makeCommitHash('requested-base'),
                [effectiveOwnerMsgId]: effectiveOwnerBaseCommit,
            },
            continuation: makeHandoffMetadata({
                currentOwnerMsgId: effectiveOwnerMsgId,
                predecessorOwnerMsgId: requestedMsgId,
            }),
        });

        // Import and test via engine
        const { GitUndoEngine } = await import('../../undo/GitUndoEngine');
        const engine = new GitUndoEngine('D:\\0.Code\\OpenCodeGUI', () => undefined) as any;
        engine.capabilities = { gitAvailable: true };
        engine.repoManager = {
            resolveRepo: jest.fn().mockResolvedValue({
                repoId: map.repoId,
                gitDir: 'git-dir',
                indexFile: 'index-file',
                workTree: 'work-tree',
            }),
        };
        engine.lockManager = {
            withRepoLock: jest.fn().mockImplementation(
                async (_repo: unknown, _logger: unknown, fn: () => Promise<unknown>) => fn()
            ),
        };
        engine.mapStore = {
            loadSessionMap: jest.fn().mockResolvedValue(map),
            saveSessionMap: jest.fn(),
        };
        engine.getCommitParent = jest.fn().mockResolvedValue(makeCommitHash('parent'));
        engine.getOrderedCommitsForMessages = jest.fn().mockReturnValue([effectiveOwnerCommit]);
        engine.getTouchedUnionForCommits = jest.fn().mockReturnValue([]);
        engine.computeFileSet = jest.fn().mockResolvedValue([]);

        const result = await engine.undoFromMessage(map.sessionId, requestedMsgId);

        expect(result.applied).toBe(true);
        expect(result.startCommit).toBe(effectiveOwnerCommit);
        expect(result.undoTargetCommit).toBe(effectiveOwnerBaseCommit);
    });

    it('resolveSessionOwnership gives consistent results for non-takeover, single-hop, and chained', () => {
        // Non-takeover
        const noTakeover = resolveSessionOwnership({ continuation: undefined }, 'msg_original');
        expect(noTakeover.currentOwnerMsgId).toBe('msg_original');
        expect(noTakeover.predecessorOwnerMsgId).toBeNull();

        // Single-hop
        const singleHop = resolveSessionOwnership(
            { continuation: makeHandoffMetadata({ currentOwnerMsgId: 'msg_b', predecessorOwnerMsgId: 'msg_a' }) },
            'msg_a'
        );
        expect(singleHop.currentOwnerMsgId).toBe('msg_b');
        expect(singleHop.predecessorOwnerMsgId).toBe('msg_a');

        // Chained
        const scenario = buildChainedTakeoverScenario();
        const chained = resolveSessionOwnership(
            { continuation: scenario.handoffAfterC },
            scenario.msgA
        );
        expect(chained.currentOwnerMsgId).toBe(scenario.msgC);
        expect(chained.predecessorOwnerMsgId).toBe(scenario.msgB);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// Regression Scenario: Snapshot visibility collapse
// ─────────────────────────────────────────────────────────────────────────
describe('E2E: snapshot/timeline visibility collapses superseded owners', () => {
    it('buildSnapshotSessionPayload collapses A → B to B only in timeline', async () => {
        const provider = createSidebarProvider();
        provider.currentSessionId = 'ses_e2e_snap';
        const scenario = buildSuccessfulTakeoverScenario();
        provider.readPersistedSessionMap = jest.fn().mockResolvedValue({
            ...scenario.sessionMap,
            continuation: scenario.handoffAfterTakeover,
            msgToCommit: {
                ...scenario.sessionMap.msgToCommit,
                [scenario.msgB]: scenario.commitB,
            },
        });

        const payload = await provider.buildSnapshotSessionPayload({
            type: 'sessionData',
            sessionId: 'ses_e2e_snap',
            title: 'E2E Snapshot',
            messages: [
                { role: 'user', id: 'msg_user_1', text: 'go', messageIndex: 1 },
                { role: 'assistant', id: scenario.msgA, text: 'A', messageIndex: 2 },
                { role: 'assistant', id: scenario.msgB, text: 'B', messageIndex: 3 },
            ],
            meta: {
                timelineMessageIds: ['msg_user_1', scenario.msgA, scenario.msgB],
            },
        });

        expect(payload.meta.timelineMessageIds).toEqual(['msg_user_1', scenario.msgB]);
        expect(payload.messages.map((m: any) => m.id)).toEqual(['msg_user_1', scenario.msgB]);
    });

    it('chained A → B → C collapses to user + C only', async () => {
        const provider = createSidebarProvider();
        provider.currentSessionId = 'ses_e2e_chain_snap';
        const scenario = buildChainedTakeoverScenario();
        provider.readPersistedSessionMap = jest.fn().mockResolvedValue({
            ...scenario.sessionMap,
            continuation: scenario.handoffAfterC,
            msgToCommit: {
                ...scenario.sessionMap.msgToCommit,
                [scenario.msgC]: scenario.commitC,
            },
        });

        const payload = await provider.buildSnapshotSessionPayload({
            type: 'sessionData',
            sessionId: 'ses_e2e_chain_snap',
            title: 'Chain',
            messages: [
                { role: 'user', id: 'msg_user_1', text: 'go', messageIndex: 1 },
                { role: 'assistant', id: scenario.msgA, text: 'A', messageIndex: 2 },
                { role: 'assistant', id: scenario.msgB, text: 'B', messageIndex: 3 },
                { role: 'assistant', id: scenario.msgC, text: 'C', messageIndex: 4 },
            ],
            meta: { timelineMessageIds: ['msg_user_1', scenario.msgA, scenario.msgB, scenario.msgC] },
        });

        expect(payload.meta.timelineMessageIds).toEqual(['msg_user_1', scenario.msgC]);
    });
});
