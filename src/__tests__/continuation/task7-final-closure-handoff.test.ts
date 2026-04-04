import { makeCommitHash, makeHandoffMetadata, makePostFinalWatchEntry, makeSessionEntry, makeSessionMap } from '../helpers/continuation-factories';
import { GitSessionMapStore } from '../../undo/GitSessionMapStore';

function createTask7Map() {
    const msgA = 'msg_owner_a';
    const msgB = 'msg_owner_b';
    const tmpKey = 'tmp_assistant_b';
    const commitA = makeCommitHash('commitA');
    const commitB = makeCommitHash('commitB');
    const baseA = makeCommitHash('baseA');
    const sessionMap = makeSessionMap({
        sessionId: 'ses_task7',
        repoId: 'repo_task7',
        headCommit: commitB,
        currentBaseCommit: commitB,
        entries: [
            makeSessionEntry({ finalAssistantMsgId: msgA, commitHash: commitA, touchedFiles: ['src/a.ts'], opType: 'update' }),
            makeSessionEntry({ tmpKey, commitHash: commitB, touchedFiles: ['src/a.ts', 'src/b.ts'], opType: 'multi' }),
        ],
        tmpToCommit: { [tmpKey]: commitB },
        tmpToBaseCommit: { [tmpKey]: baseA },
        msgToCommit: { [msgA]: commitA },
        msgToBaseCommit: { [msgA]: baseA },
        continuation: makeHandoffMetadata({
            chainId: 'chain_task7',
            currentOwnerMsgId: msgA,
            predecessorOwnerMsgId: null,
            continuationSequence: 1,
            lifecycleState: 'watching',
            postFinalWatchEntries: [
                makePostFinalWatchEntry({ filePath: 'src/a.ts', ownerMsgId: msgA, observedAt: 1 }),
                makePostFinalWatchEntry({ filePath: 'src/watched-only.ts', ownerMsgId: msgA, observedAt: 2 }),
            ],
        }),
    });
    return { msgA, msgB, tmpKey, commitA, commitB, baseA, sessionMap };
}

describe('Task 7 accepted-final closure handoff', () => {
    it('promotes current owner to msg B and preserves predecessor atomically on accepted final bind', () => {
        const { sessionMap, tmpKey, msgA, msgB, commitB, baseA } = createTask7Map();
        const store = new GitSessionMapStore('D:\\0.Code\\OpenCodeGUI', () => undefined);

        const updated = store.bindFinalMsg(sessionMap, tmpKey, msgB);

        expect(updated.continuation?.currentOwnerMsgId).toBe(msgB);
        expect(updated.continuation?.predecessorOwnerMsgId).toBe(msgA);
        expect(updated.continuation?.continuationSequence).toBe(2);
        expect(updated.continuation?.lifecycleState).toBe('idle');
        expect(updated.msgToCommit[msgB]).toBe(commitB);
        expect(updated.msgToBaseCommit[msgB]).toBe(baseA);
    });

    it('merges and reassigns post-final watch entries onto the new owner without duplicates', () => {
        const { sessionMap, tmpKey, msgB } = createTask7Map();
        const store = new GitSessionMapStore('D:\\0.Code\\OpenCodeGUI', () => undefined);

        const updated = store.bindFinalMsg(sessionMap, tmpKey, msgB);
        const watchEntries = updated.continuation?.postFinalWatchEntries ?? [];
        const filePaths = watchEntries.map((entry) => entry.filePath).sort();

        expect(filePaths).toEqual(['src/a.ts', 'src/b.ts', 'src/watched-only.ts']);
        for (const entry of watchEntries) {
            expect(entry.ownerMsgId).toBe(msgB);
        }
    });

    it('is idempotent when the same accepted final bind replays', () => {
        const { sessionMap, tmpKey, msgB } = createTask7Map();
        const store = new GitSessionMapStore('D:\\0.Code\\OpenCodeGUI', () => undefined);

        const once = store.bindFinalMsg(sessionMap, tmpKey, msgB);
        const twice = store.bindFinalMsg(once, tmpKey, msgB);

        expect(twice.continuation).toEqual(once.continuation);
        expect(Object.keys(twice.msgToCommit).filter((id) => id === msgB)).toHaveLength(1);
        expect((twice.continuation?.postFinalWatchEntries ?? []).map((entry) => entry.filePath).sort())
            .toEqual(['src/a.ts', 'src/b.ts', 'src/watched-only.ts']);
    });

    it('does not create a new owner when tmp binding is missing for a failed continuation', () => {
        const { sessionMap, msgA } = createTask7Map();
        const store = new GitSessionMapStore('D:\\0.Code\\OpenCodeGUI', () => undefined);

        const updated = store.bindFinalMsg({
            ...sessionMap,
            tmpToCommit: {},
            tmpToBaseCommit: {},
        }, 'tmp_missing', 'msg_failed_b');

        expect(updated.continuation?.currentOwnerMsgId).toBe(msgA);
        expect(updated.continuation?.predecessorOwnerMsgId).toBeNull();
        expect(updated.msgToCommit['msg_failed_b']).toBeUndefined();
    });
});
