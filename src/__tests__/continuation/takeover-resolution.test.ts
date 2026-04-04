import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    resetFactoryCounters,
    buildSuccessfulTakeoverScenario,
    buildFailedContinuationScenario,
    buildChainedTakeoverScenario,
    makeHandoffMetadata,
    makeMsgId,
    makePostFinalWatchEntry,
    makeSessionMap,
    makeSessionEntry,
    makeCommitHash,
} from '../helpers/continuation-factories';
import { GitSessionMapStore } from '../../undo/GitSessionMapStore';

import {
    resolveCurrentOwner,
    resolveOwnerAfterReload,
} from '../helpers/continuation-owner-stubs';

beforeEach(() => {
    resetFactoryCounters();
});

describe('GitSessionMapStore continuation persistence', () => {
    let workspaceRoot: string;
    let store: GitSessionMapStore;

    beforeEach(async () => {
        workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'opencode-continuation-'));
        store = new GitSessionMapStore(workspaceRoot, () => undefined);
    });

    afterEach(async () => {
        await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    });

    it('persists and reloads minimal continuation handoff metadata', async () => {
        const scenario = buildSuccessfulTakeoverScenario();
        const map = {
            ...scenario.sessionMap,
            continuation: {
                ...scenario.handoffAfterTakeover,
                lifecycleState: 'retry-ready' as const,
                postFinalWatchEntries: scenario.postFinalWatched,
            },
        };

        await store.saveSessionMap(map.sessionId, map);
        const reloaded = await store.loadSessionMap(map.sessionId, map.repoId);

        expect(reloaded.continuation).toEqual({
            chainId: scenario.chainId,
            currentOwnerMsgId: scenario.msgB,
            predecessorOwnerMsgId: scenario.msgA,
            continuationSequence: 2,
            lifecycleState: 'retry-ready',
            postFinalWatchEntries: scenario.postFinalWatched,
        });
    });

    it('loads legacy session maps without continuation metadata', async () => {
        const legacyMap = buildSuccessfulTakeoverScenario().sessionMap;
        await store.saveSessionMap(legacyMap.sessionId, legacyMap);

        const reloaded = await store.loadSessionMap(legacyMap.sessionId, legacyMap.repoId);

        expect(reloaded.msgToCommit).toEqual(legacyMap.msgToCommit);
        expect(reloaded.msgToBaseCommit).toEqual(legacyMap.msgToBaseCommit);
        expect(reloaded.continuation).toBeUndefined();
    });

    it('normalizes legacy priorOwnerMsgId continuation payloads on reload', async () => {
        const scenario = buildSuccessfulTakeoverScenario();
        const sessionDir = path.join(workspaceRoot, '.opencode', 'git', 'sessions', scenario.sessionMap.sessionId);
        await fs.promises.mkdir(sessionDir, { recursive: true });
        await fs.promises.writeFile(
            path.join(sessionDir, 'map.json'),
            JSON.stringify({
                ...scenario.sessionMap,
                continuation: {
                    chainId: scenario.chainId,
                    currentOwnerMsgId: scenario.msgB,
                    priorOwnerMsgId: scenario.msgA,
                    continuationSequence: 2,
                    lifecycleState: 'watching',
                    postFinalWatchEntries: scenario.postFinalWatched,
                },
            }, null, 2),
            'utf-8'
        );

        const reloaded = await store.loadSessionMap(scenario.sessionMap.sessionId, scenario.sessionMap.repoId);

        expect(reloaded.continuation?.predecessorOwnerMsgId).toBe(scenario.msgA);
        expect(reloaded.continuation?.currentOwnerMsgId).toBe(scenario.msgB);
        expect(reloaded.continuation?.continuationSequence).toBe(2);
        expect(reloaded.continuation?.lifecycleState).toBe('watching');
        expect(reloaded.continuation?.postFinalWatchEntries).toEqual(scenario.postFinalWatched);
    });
});

describe('resolveCurrentOwner', () => {
    it('returns the currentOwnerMsgId from persisted handoff metadata', () => {
        const handoff = makeHandoffMetadata({ currentOwnerMsgId: 'msg_test_owner_explicit' });
        const result = resolveCurrentOwner(handoff);
        expect(result).toBe('msg_test_owner_explicit');
    });

    it('returns null when no handoff metadata exists', () => {
        const result = resolveCurrentOwner(null);
        expect(result).toBeNull();
    });

    it('never infers owner from message ordering or UI position', () => {
        const handoff = makeHandoffMetadata({
            currentOwnerMsgId: 'msg_actual_owner',
            continuationSequence: 3,
        });
        const result = resolveCurrentOwner(handoff);
        expect(result).toBe('msg_actual_owner');
        expect(result).not.toBe('msg_latest_in_timeline');
    });
});

describe('successful takeover (A -> B) via production bindFinalMsg', () => {
    it('transfers ownership from msg A to msg B after B reaches accepted final', () => {
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
        expect(updated.continuation?.continuationSequence).toBe(2);
        expect(updated.continuation?.chainId).toBe(scenario.chainId);
    });

    it('reassigns post-final watched entries to the new owner', () => {
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
            continuation: {
                ...scenario.handoffBeforeTakeover,
                postFinalWatchEntries: scenario.postFinalWatched,
            },
        });

        const updated = store.bindFinalMsg(sessionMap, tmpKey, scenario.msgB);
        const watchEntries = updated.continuation?.postFinalWatchEntries ?? [];

        expect(watchEntries.length).toBeGreaterThan(0);
        for (const entry of watchEntries) {
            expect(entry.ownerMsgId).toBe(scenario.msgB);
        }
    });

    it('updates session map to reference the new owner commit', () => {
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

        expect(updated.msgToCommit[scenario.msgB]).toBe(scenario.commitB);
    });
});

describe('failed continuation retains current owner', () => {
    it('keeps msg A as current owner when continuation bind has no tmp commit', () => {
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

    it('appends newly watched entries under the existing owner on failed continuation', () => {
        const scenario = buildFailedContinuationScenario();
        const store = new GitSessionMapStore('D:\\0.Code\\OpenCodeGUI', () => undefined);
        const existingWatch = makePostFinalWatchEntry({
            filePath: 'src/original-watch.ts',
            ownerMsgId: scenario.msgA,
        });
        const newWatch = makePostFinalWatchEntry({
            filePath: 'src/watched-during-attempt.ts',
            ownerMsgId: scenario.msgA,
        });

        const handoffWithWatch = {
            ...scenario.handoff,
            postFinalWatchEntries: [existingWatch, newWatch],
        };

        const sessionMap = makeSessionMap({
            ...scenario.sessionMap,
            tmpToCommit: {},
            tmpToBaseCommit: {},
            continuation: handoffWithWatch,
        });

        const updated = store.bindFinalMsg(sessionMap, 'tmp_missing', 'msg_failed_b');

        expect(updated.continuation?.currentOwnerMsgId).toBe(scenario.msgA);
        expect(updated.continuation?.postFinalWatchEntries).toEqual(handoffWithWatch.postFinalWatchEntries);
    });

    it('does not increment continuation sequence on failed bind', () => {
        const scenario = buildFailedContinuationScenario();
        const store = new GitSessionMapStore('D:\\0.Code\\OpenCodeGUI', () => undefined);

        const sessionMap = makeSessionMap({
            ...scenario.sessionMap,
            tmpToCommit: {},
            tmpToBaseCommit: {},
            continuation: scenario.handoff,
        });

        const updated = store.bindFinalMsg(sessionMap, 'tmp_missing', 'msg_failed_b');

        expect(updated.continuation?.continuationSequence).toBe(1);
    });
});

describe('chained takeover A -> B -> C collapses to C via successive bindFinalMsg', () => {
    it('resolves current owner to C after full chain', () => {
        const scenario = buildChainedTakeoverScenario();
        const store = new GitSessionMapStore('D:\\0.Code\\OpenCodeGUI', () => undefined);

        const tmpKeyB = 'tmp_assistant_b';
        const tmpKeyC = 'tmp_assistant_c';
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
        expect(sessionMap.continuation?.chainId).toBe(scenario.chainId);
    });

    it('treats A and B as historical-only after C takes over', () => {
        const scenario = buildChainedTakeoverScenario();
        const store = new GitSessionMapStore('D:\\0.Code\\OpenCodeGUI', () => undefined);

        const tmpKeyB = 'tmp_assistant_b';
        const tmpKeyC = 'tmp_assistant_c';
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

        expect(sessionMap.continuation?.currentOwnerMsgId).not.toBe(scenario.msgA);
        expect(sessionMap.continuation?.currentOwnerMsgId).not.toBe(scenario.msgB);
    });

    it('preserves chain identity across all handoffs', () => {
        const scenario = buildChainedTakeoverScenario();
        expect(scenario.handoffAfterA.chainId).toBe(scenario.chainId);
        expect(scenario.handoffAfterB.chainId).toBe(scenario.chainId);
        expect(scenario.handoffAfterC.chainId).toBe(scenario.chainId);
    });
});

describe('snapshot reload rebuilds from persisted metadata only', () => {
    it('resolves owner from persisted handoff, not message order', () => {
        const handoff = makeHandoffMetadata({
            currentOwnerMsgId: 'msg_persisted_owner',
            continuationSequence: 2,
        });
        const result = resolveOwnerAfterReload(handoff);
        expect(result).toBe('msg_persisted_owner');
    });

    it('returns null when no persisted handoff exists (no continuation in session)', () => {
        const result = resolveOwnerAfterReload(null);
        expect(result).toBeNull();
    });
});
