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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OpenCodeClient } from '../../OpenCodeClient';
import type { PostFinalWatchEntry } from '../../undo/types';
import { makeCommitHash, makeSessionEntry } from '../helpers/continuation-factories';

type PostFinalWatchState = {
    ownerMsgId: string;
    lastAssistantMsgId?: string;
    turnKey: string;
    changes: Array<{ type: string; path?: string; oldPath?: string; newPath?: string }>;
};

const createdClients: OpenCodeClient[] = [];

function getPostFinalWatchState(client: OpenCodeClient, sessionId: string): PostFinalWatchState | undefined {
    return (client as any).postFinalWatchStateBySession.get(sessionId);
}

function createTakeoverReadyClient(sessionId: string, ownerMsgId = 'msg_owner_final'): OpenCodeClient {
    const client = new OpenCodeClient() as any;
    createdClients.push(client as OpenCodeClient);
    client.startTurn(sessionId, 'local-user-1');
    client.expectedMainAgentBySession.set(sessionId, 'sisyphus');
    client.recordAssistantMsgId(sessionId, ownerMsgId);
    client.markTurnFinal(sessionId, ownerMsgId, 'sse');
    client.finishTurn(sessionId);
    return client as OpenCodeClient;
}

async function createPersistingClient(workspaceRoot: string): Promise<OpenCodeClient> {
    const client = new OpenCodeClient() as any;
    createdClients.push(client as OpenCodeClient);
    client.setWorkspaceRoot(workspaceRoot);
    client.gitUndoAvailable = true;
    client.gitUndo.capabilities = { gitAvailable: true };
    return client as OpenCodeClient;
}

afterEach(async () => {
    await Promise.all(createdClients.splice(0).map((client) => client.dispose()));
});

async function loadPersistedMap(client: OpenCodeClient, sessionId: string) {
    const gitUndo = (client as any).gitUndo;
    const repo = await gitUndo.repoManager.resolveRepo(sessionId);
    return gitUndo.mapStore.loadSessionMap(sessionId, repo.repoId);
}

async function waitForPersist(client: OpenCodeClient, sessionId: string): Promise<void> {
    const pending = (client as any).continuationPersistBySession?.get(sessionId);
    if (pending) {
        await pending;
    }
}

describe('OpenCodeClient post-final watch lifecycle', () => {
    it('keeps a dedicated post-final watch state after finishTurn for takeover-enabled sessions', () => {
        const sessionId = 'ses_takeover_watch';
        const client = createTakeoverReadyClient(sessionId) as any;

        client.queueTurnChanges(sessionId, sessionId, undefined, undefined, [
            { type: 'update', path: 'src/post-final-watch.ts' },
        ]);

        expect(client.pendingTurnChangesBySession.has(sessionId)).toBe(false);
        expect(client.hasPendingTurnChanges(sessionId)).toBe(true);
        expect(getPostFinalWatchState(client, sessionId)).toMatchObject({
            ownerMsgId: 'msg_owner_final',
            changes: [
                { type: 'update', path: 'src/post-final-watch.ts' },
            ],
        });
    });

    it('preserves collected post-final watch changes under the same owner across retry start', () => {
        const sessionId = 'ses_takeover_retry';
        const client = createTakeoverReadyClient(sessionId) as any;

        client.queueTurnChanges(sessionId, sessionId, undefined, undefined, [
            { type: 'update', path: 'src/retry-keeps-owner.ts' },
        ]);
        client.startTurn(sessionId, 'local-user-retry');

        expect(getPostFinalWatchState(client, sessionId)).toMatchObject({
            ownerMsgId: 'msg_owner_final',
            changes: [
                { type: 'update', path: 'src/retry-keeps-owner.ts' },
            ],
        });
    });

    it('rebinds preserved post-final watch state to the later accepted final owner', () => {
        const sessionId = 'ses_takeover_rebind';
        const client = createTakeoverReadyClient(sessionId, 'msg_owner_a') as any;

        client.queueTurnChanges(sessionId, sessionId, undefined, undefined, [
            { type: 'update', path: 'src/rebind-after-success.ts' },
        ]);

        client.startTurn(sessionId, 'local-user-retry');
        client.expectedMainAgentBySession.set(sessionId, 'sisyphus');
        client.recordAssistantMsgId(sessionId, 'msg_owner_b');
        client.markTurnFinal(sessionId, 'msg_owner_b', 'sse');
        client.finishTurn(sessionId);

        expect(getPostFinalWatchState(client, sessionId)).toMatchObject({
            ownerMsgId: 'msg_owner_b',
            lastAssistantMsgId: 'msg_owner_b',
            changes: [
                { type: 'update', path: 'src/rebind-after-success.ts' },
            ],
        });
    });

    it('keeps non-takeover sessions fully cleaned after finishTurn', () => {
        const sessionId = 'ses_normal_cleanup';
        const client = new OpenCodeClient() as any;
        createdClients.push(client as OpenCodeClient);
        client.startTurn(sessionId, 'local-user-1');
        client.recordAssistantMsgId(sessionId, 'msg_normal_final');
        client.markTurnFinal(sessionId, 'msg_normal_final', 'sse');
        client.finishTurn(sessionId);

        client.queueTurnChanges(sessionId, sessionId, undefined, undefined, [
            { type: 'update', path: 'src/non-takeover-should-clear.ts' },
        ]);

        expect(client.hasPendingTurnChanges(sessionId)).toBe(false);
        expect(client.pendingTurnChangesBySession.has(sessionId)).toBe(false);
        expect(getPostFinalWatchState(client, sessionId)).toBeUndefined();
    });

    it('does not promote a new owner when a continuation turn fails or is cancelled', () => {
        const sessionId = 'ses_takeover_watch_fail';
        const client = createTakeoverReadyClient(sessionId) as any;

        (client as any).continuationChainsBySession.get(sessionId).state = 'revive_armed';
        
        client.bootstrapContinuationTurn(sessionId);
        
        client.recordAssistantMsgId(sessionId, 'msg_assistant_failed');
        client.queueTurnChanges(sessionId, 'cont:key', undefined, 'msg_assistant_failed', [
            { type: 'update', path: 'src/pending.ts' },
        ]);

        client.cancelTurn(sessionId);
        client.finishTurn(sessionId);

        const state = getPostFinalWatchState(client, sessionId);
        expect(state).toBeDefined();
        expect(state!.ownerMsgId).toBe('msg_owner_final');
        expect(state!.lastAssistantMsgId).toBe('msg_owner_final');
        expect(state!.changes.some(c => c.path === 'src/pending.ts')).toBe(true);

        const chain = (client as any).continuationChainsBySession.get(sessionId);
        expect(chain.state).toBe('sealed');
    });

    it('persists continuation metadata from the real accepted-final to post-final watch path', async () => {
        const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'opencode-cont-runtime-'));
        const sessionId = 'ses_persisted_watch';
        const client = await createPersistingClient(workspaceRoot) as any;

        client.startTurn(sessionId, 'local-user-1');
        client.expectedMainAgentBySession.set(sessionId, 'sisyphus');
        client.recordAssistantMsgId(sessionId, 'msg_owner_a');
        client.markTurnFinal(sessionId, 'msg_owner_a', 'sse');
        client.finishTurn(sessionId);
        client.queueTurnChanges(sessionId, sessionId, undefined, undefined, [
            { type: 'update', path: 'src/post-final-watch.ts' },
        ]);
        await waitForPersist(client, sessionId);

        const map = await loadPersistedMap(client, sessionId);
        expect(map.continuation).toMatchObject({
            currentOwnerMsgId: 'msg_owner_a',
            predecessorOwnerMsgId: null,
            continuationSequence: 1,
            lifecycleState: 'watching',
        });
        expect(map.continuation?.postFinalWatchEntries).toEqual([
            expect.objectContaining({ filePath: 'src/post-final-watch.ts', ownerMsgId: 'msg_owner_a' }),
        ]);
    });

    it('drains the real finishTurn continuation persist before dispose returns', async () => {
        const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'opencode-cont-dispose-drain-'));
        const sessionId = 'ses_dispose_drain';
        const client = await createPersistingClient(workspaceRoot) as any;
        client.startTurn(sessionId, 'local-user-1');
        client.expectedMainAgentBySession.set(sessionId, 'sisyphus');
        client.recordAssistantMsgId(sessionId, 'msg_owner_dispose');
        client.markTurnFinal(sessionId, 'msg_owner_dispose', 'sse');
        client.finishTurn(sessionId);
        client.queueTurnChanges(sessionId, sessionId, undefined, undefined, [{ type: 'update', path: 'src/dispose-drain.ts' }]);
        await client.dispose();
        const map = await loadPersistedMap(client, sessionId);
        expect(map.continuation).toMatchObject({ currentOwnerMsgId: 'msg_owner_dispose', lifecycleState: 'watching' });
    });

    it('persists retry-ready failure state while keeping current owner and watched entries', async () => {
        const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'opencode-cont-fail-'));
        const sessionId = 'ses_persisted_failure';
        const client = await createPersistingClient(workspaceRoot) as any;

        client.startTurn(sessionId, 'local-user-1');
        client.expectedMainAgentBySession.set(sessionId, 'sisyphus');
        client.recordAssistantMsgId(sessionId, 'msg_owner_a');
        client.markTurnFinal(sessionId, 'msg_owner_a', 'sse');
        client.finishTurn(sessionId);
        client.queueTurnChanges(sessionId, sessionId, undefined, undefined, [
            { type: 'update', path: 'src/post-final-watch.ts' },
        ]);
        client.handleReviveGate(sessionId);
        client.bootstrapContinuationTurn(sessionId);
        client.recordAssistantMsgId(sessionId, 'msg_failed_b');
        client.queueTurnChanges(sessionId, 'cont:key', undefined, 'msg_failed_b', [
            { type: 'update', path: 'src/failed-attempt.ts' },
        ]);
        client.cancelTurn(sessionId);
        client.finishTurn(sessionId);
        await waitForPersist(client, sessionId);

        const map = await loadPersistedMap(client, sessionId);
        expect(map.continuation).toMatchObject({
            currentOwnerMsgId: 'msg_owner_a',
            predecessorOwnerMsgId: null,
            continuationSequence: 1,
            lifecycleState: 'retry-ready',
        });
        expect((map.continuation?.postFinalWatchEntries ?? []).map((entry: PostFinalWatchEntry) => entry.filePath).sort()).toEqual([
            'src/failed-attempt.ts',
            'src/post-final-watch.ts',
        ]);
    });

    it('promotes persisted current owner and predecessor on later accepted final through runtime path', async () => {
        const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'opencode-cont-promote-'));
        const sessionId = 'ses_persisted_promote';
        const client = await createPersistingClient(workspaceRoot) as any;
        const gitUndo = client.gitUndo;
        const tmpKey = 'tmp_assistant_b';
        const commitB = makeCommitHash('commitB');
        const baseB = makeCommitHash('baseB');

        client.startTurn(sessionId, 'local-user-1');
        client.expectedMainAgentBySession.set(sessionId, 'sisyphus');
        client.recordAssistantMsgId(sessionId, 'msg_owner_a');
        client.markTurnFinal(sessionId, 'msg_owner_a', 'sse');
        client.finishTurn(sessionId);
        client.queueTurnChanges(sessionId, sessionId, undefined, undefined, [
            { type: 'update', path: 'src/post-final-watch.ts' },
        ]);
        await waitForPersist(client, sessionId);

        const repo = await gitUndo.repoManager.resolveRepo(sessionId);
        const beforePromotion = await gitUndo.mapStore.loadSessionMap(sessionId, repo.repoId);
        await gitUndo.mapStore.saveSessionMap(sessionId, {
            ...beforePromotion,
            entries: [
                ...beforePromotion.entries,
                makeSessionEntry({ tmpKey, commitHash: commitB, touchedFiles: ['src/accepted-final-b.ts'], opType: 'update' }),
            ],
            tmpToCommit: {
                ...beforePromotion.tmpToCommit,
                [tmpKey]: commitB,
            },
            tmpToBaseCommit: {
                ...beforePromotion.tmpToBaseCommit,
                [tmpKey]: baseB,
            },
        });

        client.handleReviveGate(sessionId);
        client.bootstrapContinuationTurn(sessionId);
        client.expectedMainAgentBySession.set(sessionId, 'sisyphus');
        client.recordAssistantMsgId(sessionId, 'msg_owner_b');
        await gitUndo.finalizeBinding(sessionId, tmpKey, 'msg_owner_b');
        client.markTurnFinal(sessionId, 'msg_owner_b', 'sse');
        client.finishTurn(sessionId);
        await waitForPersist(client, sessionId);

        const map = await loadPersistedMap(client, sessionId);
        expect(map.continuation).toMatchObject({
            currentOwnerMsgId: 'msg_owner_b',
            predecessorOwnerMsgId: 'msg_owner_a',
            continuationSequence: 2,
            lifecycleState: 'watching',
        });
        expect((map.continuation?.postFinalWatchEntries ?? []).map((entry: PostFinalWatchEntry) => entry.filePath).sort()).toEqual([
            'src/accepted-final-b.ts',
            'src/post-final-watch.ts',
        ]);
    });
});
