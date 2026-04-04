/**
 * Production-path seeding tests for continuation metadata.
 *
 * Proves that `bindFinalMsg()` seeds `SessionMap.continuation` from scratch
 * when called on a session map with NO pre-existing continuation field —
 * exactly the real production path where:
 *   1. `createEmptySessionMap()` creates a map without `continuation`
 *   2. `GitUndoEngine.finalizeBinding()` calls `bindFinalMsg()` with the first finalized msg
 *   3. `continuation` is seeded on that first call
 *
 * This closes the F1 Plan Compliance Audit gap: production code now seeds
 * `SessionMap.continuation` without requiring hand-crafted test fixtures.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitSessionMapStore } from '../../undo/GitSessionMapStore';
import { resolveCurrentOwnerMsgId, resolveSessionOwnership } from '../../undo/ownershipResolver';
import {
    resetFactoryCounters,
    makeSessionMap,
    makeSessionEntry,
    makeCommitHash,
    makeMsgId,
} from '../helpers/continuation-factories';

beforeEach(() => {
    resetFactoryCounters();
});

describe('bindFinalMsg seeds continuation from empty session map (production path)', () => {
    const store = new GitSessionMapStore('D:\\0.Code\\OpenCodeGUI', () => undefined);

    it('seeds continuation with currentOwnerMsgId on first bindFinalMsg call', () => {
        const msgA = makeMsgId('A');
        const commitA = makeCommitHash('commitA');
        const baselineCommit = makeCommitHash('baseline');
        const tmpKey = 'tmp_assistant_a';

        const map = makeSessionMap({
            sessionId: 'ses_seed_test',
            baselineCommit,
            headCommit: commitA,
            currentBaseCommit: baselineCommit,
            entries: [
                makeSessionEntry({
                    tmpKey,
                    commitHash: commitA,
                    touchedFiles: ['src/a.ts'],
                    opType: 'update',
                }),
            ],
            tmpToCommit: { [tmpKey]: commitA },
            tmpToBaseCommit: { [tmpKey]: baselineCommit },
        });

        expect(map.continuation).toBeUndefined();

        const updated = store.bindFinalMsg(map, tmpKey, msgA);

        expect(updated.continuation).toBeDefined();
        expect(updated.continuation!.currentOwnerMsgId).toBe(msgA);
        expect(updated.continuation!.predecessorOwnerMsgId).toBeNull();
        expect(updated.continuation!.continuationSequence).toBe(1);
        expect(updated.continuation!.lifecycleState).toBe('idle');
    });

    it('seeds postFinalWatchEntries from touched files on first bind', () => {
        const msgA = makeMsgId('A');
        const commitA = makeCommitHash('commitA');
        const baselineCommit = makeCommitHash('baseline');
        const tmpKey = 'tmp_assistant_a';
        const touchedFiles = ['src/file1.ts', 'src/file2.ts'];

        const map = makeSessionMap({
            sessionId: 'ses_seed_watch_test',
            baselineCommit,
            entries: [
                makeSessionEntry({
                    tmpKey,
                    commitHash: commitA,
                    touchedFiles,
                    opType: 'update',
                }),
            ],
            tmpToCommit: { [tmpKey]: commitA },
            tmpToBaseCommit: { [tmpKey]: baselineCommit },
        });

        const updated = store.bindFinalMsg(map, tmpKey, msgA);

        const watchEntries = updated.continuation!.postFinalWatchEntries;
        expect(watchEntries.length).toBe(2);
        expect(watchEntries.map((e) => e.filePath).sort()).toEqual(['src/file1.ts', 'src/file2.ts']);
        for (const entry of watchEntries) {
            expect(entry.ownerMsgId).toBe(msgA);
            expect(typeof entry.observedAt).toBe('number');
        }
    });

    it('ownershipResolver resolves seeded continuation after first bind', () => {
        const msgA = makeMsgId('A');
        const commitA = makeCommitHash('commitA');
        const tmpKey = 'tmp_assistant_a';

        const map = makeSessionMap({
            sessionId: 'ses_resolver_test',
            entries: [
                makeSessionEntry({ tmpKey, commitHash: commitA }),
            ],
            tmpToCommit: { [tmpKey]: commitA },
        });

        const updated = store.bindFinalMsg(map, tmpKey, msgA);

        const ownerId = resolveCurrentOwnerMsgId(updated, 'fallback_msg');
        expect(ownerId).toBe(msgA);

        const ownership = resolveSessionOwnership(updated, 'fallback_msg');
        expect(ownership.currentOwnerMsgId).toBe(msgA);
        expect(ownership.predecessorOwnerMsgId).toBeNull();
    });
});

describe('second bindFinalMsg promotes owner on seeded continuation (A → B)', () => {
    const store = new GitSessionMapStore('D:\\0.Code\\OpenCodeGUI', () => undefined);

    it('promotes currentOwnerMsgId from A to B without pre-fabricated continuation', () => {
        const msgA = makeMsgId('A');
        const msgB = makeMsgId('B');
        const commitA = makeCommitHash('commitA');
        const commitB = makeCommitHash('commitB');
        const baselineCommit = makeCommitHash('baseline');
        const tmpKeyA = 'tmp_assistant_a';
        const tmpKeyB = 'tmp_assistant_b';

        // Step 1: seed continuation
        let map = makeSessionMap({
            sessionId: 'ses_promote_test',
            baselineCommit,
            entries: [
                makeSessionEntry({ tmpKey: tmpKeyA, commitHash: commitA, touchedFiles: ['src/a.ts'] }),
            ],
            tmpToCommit: { [tmpKeyA]: commitA },
            tmpToBaseCommit: { [tmpKeyA]: baselineCommit },
        });

        map = store.bindFinalMsg(map, tmpKeyA, msgA);
        expect(map.continuation!.currentOwnerMsgId).toBe(msgA);
        expect(map.continuation!.predecessorOwnerMsgId).toBeNull();
        expect(map.continuation!.continuationSequence).toBe(1);

        // Step 2: add B's entry
        map = {
            ...map,
            entries: [
                ...map.entries,
                makeSessionEntry({ tmpKey: tmpKeyB, commitHash: commitB, touchedFiles: ['src/b.ts'] }),
            ],
            tmpToCommit: { ...map.tmpToCommit, [tmpKeyB]: commitB },
            tmpToBaseCommit: { ...map.tmpToBaseCommit, [tmpKeyB]: commitA },
        };

        // Step 3: promote A → B
        map = store.bindFinalMsg(map, tmpKeyB, msgB);

        expect(map.continuation!.currentOwnerMsgId).toBe(msgB);
        expect(map.continuation!.predecessorOwnerMsgId).toBe(msgA);
        expect(map.continuation!.continuationSequence).toBe(2);
        expect(map.continuation!.lifecycleState).toBe('idle');
    });

    it('preserves raw historical bindings for both A and B after promotion', () => {
        const msgA = makeMsgId('A');
        const msgB = makeMsgId('B');
        const commitA = makeCommitHash('commitA');
        const commitB = makeCommitHash('commitB');
        const baselineCommit = makeCommitHash('baseline');
        const tmpKeyA = 'tmp_assistant_a';
        const tmpKeyB = 'tmp_assistant_b';

        let map = makeSessionMap({
            sessionId: 'ses_preserve_bindings',
            baselineCommit,
            entries: [
                makeSessionEntry({ tmpKey: tmpKeyA, commitHash: commitA }),
            ],
            tmpToCommit: { [tmpKeyA]: commitA },
            tmpToBaseCommit: { [tmpKeyA]: baselineCommit },
        });

        map = store.bindFinalMsg(map, tmpKeyA, msgA);

        map = {
            ...map,
            entries: [
                ...map.entries,
                makeSessionEntry({ tmpKey: tmpKeyB, commitHash: commitB }),
            ],
            tmpToCommit: { ...map.tmpToCommit, [tmpKeyB]: commitB },
            tmpToBaseCommit: { ...map.tmpToBaseCommit, [tmpKeyB]: commitA },
        };

        map = store.bindFinalMsg(map, tmpKeyB, msgB);

        expect(map.msgToCommit[msgA]).toBe(commitA);
        expect(map.msgToCommit[msgB]).toBe(commitB);
        expect(map.msgToBaseCommit[msgA]).toBe(baselineCommit);
        expect(map.msgToBaseCommit[msgB]).toBe(commitA);
    });

    it('ownershipResolver resolves to B after A → B promotion', () => {
        const msgA = makeMsgId('A');
        const msgB = makeMsgId('B');
        const commitA = makeCommitHash('commitA');
        const commitB = makeCommitHash('commitB');
        const tmpKeyA = 'tmp_assistant_a';
        const tmpKeyB = 'tmp_assistant_b';

        let map = makeSessionMap({
            sessionId: 'ses_resolver_promote',
            entries: [
                makeSessionEntry({ tmpKey: tmpKeyA, commitHash: commitA }),
            ],
            tmpToCommit: { [tmpKeyA]: commitA },
        });

        map = store.bindFinalMsg(map, tmpKeyA, msgA);

        map = {
            ...map,
            entries: [
                ...map.entries,
                makeSessionEntry({ tmpKey: tmpKeyB, commitHash: commitB }),
            ],
            tmpToCommit: { ...map.tmpToCommit, [tmpKeyB]: commitB },
        };

        map = store.bindFinalMsg(map, tmpKeyB, msgB);

        expect(resolveCurrentOwnerMsgId(map, 'fallback')).toBe(msgB);

        const ownership = resolveSessionOwnership(map, 'fallback');
        expect(ownership.currentOwnerMsgId).toBe(msgB);
        expect(ownership.predecessorOwnerMsgId).toBe(msgA);
    });
});

describe('seeded continuation survives save/reload cycle', () => {
    let workspaceRoot: string;
    let store: GitSessionMapStore;

    beforeEach(async () => {
        workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'opencode-seed-'));
        store = new GitSessionMapStore(workspaceRoot, () => undefined);
    });

    afterEach(async () => {
        await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    });

    it('persists and reloads continuation that was seeded by bindFinalMsg', async () => {
        const msgA = makeMsgId('A');
        const commitA = makeCommitHash('commitA');
        const tmpKey = 'tmp_a';
        const sessionId = 'ses_persist_seed';
        const repoId = 'repo_test';

        let map = makeSessionMap({
            sessionId,
            repoId,
            entries: [
                makeSessionEntry({ tmpKey, commitHash: commitA, touchedFiles: ['src/a.ts'] }),
            ],
            tmpToCommit: { [tmpKey]: commitA },
        });

        map = store.bindFinalMsg(map, tmpKey, msgA);
        expect(map.continuation).toBeDefined();

        await store.saveSessionMap(sessionId, map);
        const reloaded = await store.loadSessionMap(sessionId, repoId);

        expect(reloaded.continuation).toBeDefined();
        expect(reloaded.continuation!.currentOwnerMsgId).toBe(msgA);
        expect(reloaded.continuation!.predecessorOwnerMsgId).toBeNull();
        expect(reloaded.continuation!.continuationSequence).toBe(1);
        expect(reloaded.continuation!.lifecycleState).toBe('idle');
        expect(reloaded.continuation!.postFinalWatchEntries.length).toBe(1);
        expect(reloaded.continuation!.postFinalWatchEntries[0].filePath).toBe('src/a.ts');
        expect(reloaded.continuation!.postFinalWatchEntries[0].ownerMsgId).toBe(msgA);
    });

    it('persists promoted continuation (A → B) after save/reload', async () => {
        const msgA = makeMsgId('A');
        const msgB = makeMsgId('B');
        const commitA = makeCommitHash('commitA');
        const commitB = makeCommitHash('commitB');
        const tmpKeyA = 'tmp_a';
        const tmpKeyB = 'tmp_b';
        const sessionId = 'ses_persist_promote';
        const repoId = 'repo_test';

        let map = makeSessionMap({
            sessionId,
            repoId,
            entries: [
                makeSessionEntry({ tmpKey: tmpKeyA, commitHash: commitA, touchedFiles: ['src/a.ts'] }),
            ],
            tmpToCommit: { [tmpKeyA]: commitA },
        });

        map = store.bindFinalMsg(map, tmpKeyA, msgA);

        map = {
            ...map,
            entries: [
                ...map.entries,
                makeSessionEntry({ tmpKey: tmpKeyB, commitHash: commitB, touchedFiles: ['src/b.ts'] }),
            ],
            tmpToCommit: { ...map.tmpToCommit, [tmpKeyB]: commitB },
            tmpToBaseCommit: { ...map.tmpToBaseCommit, [tmpKeyB]: commitA },
        };

        map = store.bindFinalMsg(map, tmpKeyB, msgB);

        await store.saveSessionMap(sessionId, map);
        const reloaded = await store.loadSessionMap(sessionId, repoId);

        expect(reloaded.continuation!.currentOwnerMsgId).toBe(msgB);
        expect(reloaded.continuation!.predecessorOwnerMsgId).toBe(msgA);
        expect(reloaded.continuation!.continuationSequence).toBe(2);

        expect(reloaded.msgToCommit[msgA]).toBe(commitA);
        expect(reloaded.msgToCommit[msgB]).toBe(commitB);
    });
});

describe('idempotent rebind does not double-increment', () => {
    const store = new GitSessionMapStore('D:\\0.Code\\OpenCodeGUI', () => undefined);

    it('calling bindFinalMsg twice with same finalMsgId does not change sequence', () => {
        const msgA = makeMsgId('A');
        const commitA = makeCommitHash('commitA');
        const tmpKey = 'tmp_a';

        let map = makeSessionMap({
            entries: [makeSessionEntry({ tmpKey, commitHash: commitA })],
            tmpToCommit: { [tmpKey]: commitA },
        });

        map = store.bindFinalMsg(map, tmpKey, msgA);
        expect(map.continuation!.continuationSequence).toBe(1);

        map = store.bindFinalMsg(map, tmpKey, msgA);
        expect(map.continuation!.continuationSequence).toBe(1);
        expect(map.continuation!.currentOwnerMsgId).toBe(msgA);
        expect(map.continuation!.predecessorOwnerMsgId).toBeNull();
    });
});
