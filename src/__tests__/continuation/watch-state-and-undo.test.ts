import {
    resetFactoryCounters,
    buildSuccessfulTakeoverScenario,
    buildChainedTakeoverScenario,
    makeHandoffMetadata,
    makePostFinalWatchEntry,
    makeSessionMap,
    makeSessionEntry,
    makeCommitHash,
    makeMsgId,
} from '../helpers/continuation-factories';

import { resolveOwnerAfterReload } from '../helpers/continuation-owner-stubs';
import { GitSessionMapStore } from '../../undo/GitSessionMapStore';

beforeEach(() => {
    resetFactoryCounters();
});

describe('post-final watch state attribution', () => {
    it('attributes watched file changes to the current owner at observation time', () => {
        const ownerMsg = makeMsgId('owner');
        const entry = makePostFinalWatchEntry({
            filePath: 'src/late-edit.ts',
            ownerMsgId: ownerMsg,
        });

        expect(entry.ownerMsgId).toBe(ownerMsg);
        expect(entry.filePath).toBe('src/late-edit.ts');
    });

    it('reassigns watch entries to new owner after successful takeover via bindFinalMsg', () => {
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
        const watchEntries = updated.continuation?.postFinalWatchEntries ?? [];

        for (const entry of watchEntries) {
            expect(entry.ownerMsgId).toBe(scenario.msgB);
        }
    });
});

describe('undo/changelist anchor follows current owner', () => {
    it('session map binds the new owner commit after takeover via bindFinalMsg', () => {
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
        expect(updated.continuation?.currentOwnerMsgId).toBe(scenario.msgB);
    });

    it('preserves historical msg A -> commit binding without mutation', () => {
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

        expect(updated.msgToCommit[scenario.msgA]).toBe(scenario.commitA);
    });
});

describe('chained takeover undo consistency', () => {
    it('after A -> B -> C, undo targets C as the anchor point via successive bindFinalMsg', () => {
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
        expect(sessionMap.continuation?.currentOwnerMsgId).toBe(scenario.msgB);

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
        expect(sessionMap.msgToCommit[scenario.msgC]).toBe(scenario.commitC);
    });

    it('all historical commit bindings survive chain folding', () => {
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

        expect(sessionMap.msgToCommit[scenario.msgA]).toBe(scenario.commitA);
        expect(sessionMap.msgToCommit[scenario.msgB]).toBe(scenario.commitB);
        expect(sessionMap.msgToCommit[scenario.msgC]).toBe(scenario.commitC);
    });
});

describe('reload consistency', () => {
    it('reload after A -> B takeover resolves B as current owner', () => {
        const scenario = buildSuccessfulTakeoverScenario();
        const result = resolveOwnerAfterReload(scenario.handoffAfterTakeover);
        expect(result).toBe(scenario.msgB);
    });

    it('reload with no continuation returns null', () => {
        const result = resolveOwnerAfterReload(null);
        expect(result).toBeNull();
    });

    it('reload after chained A -> B -> C resolves C', () => {
        const scenario = buildChainedTakeoverScenario();
        const result = resolveOwnerAfterReload(scenario.handoffAfterC);
        expect(result).toBe(scenario.msgC);
    });
});
