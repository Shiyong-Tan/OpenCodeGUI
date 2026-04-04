import { buildChainedTakeoverScenario, buildSuccessfulTakeoverScenario, makeMsgId, makeSessionMap } from '../helpers/continuation-factories';
import { resolveCurrentVisibleOwnerMsgId, resolveSessionOwnership } from '../../undo/ownershipResolver';

describe('resolveSessionOwnership', () => {
    it('returns the explicit fallback owner unchanged for non-takeover sessions', () => {
        const originalOwnerMsgId = makeMsgId('original-owner');
        const sessionMap = makeSessionMap({ continuation: undefined });

        const resolved = resolveSessionOwnership(sessionMap, originalOwnerMsgId);

        expect(resolved.currentOwnerMsgId).toBe(originalOwnerMsgId);
        expect(resolved.predecessorOwnerMsgId).toBeNull();
    });

    it('returns current and predecessor owners from single-hop handoff metadata', () => {
        const scenario = buildSuccessfulTakeoverScenario();
        const sessionMap = {
            ...scenario.sessionMap,
            continuation: scenario.handoffAfterTakeover,
        };

        const resolved = resolveSessionOwnership(sessionMap, scenario.msgA);

        expect(resolved.currentOwnerMsgId).toBe(scenario.msgB);
        expect(resolved.predecessorOwnerMsgId).toBe(scenario.msgA);
    });

    it('resolves chained A -> B -> C handoffs to current owner C and predecessor B', () => {
        const scenario = buildChainedTakeoverScenario();
        const sessionMap = {
            ...scenario.sessionMap,
            continuation: scenario.handoffAfterC,
        };

        const resolved = resolveSessionOwnership(sessionMap, scenario.msgA);

        expect(resolved.currentOwnerMsgId).toBe(scenario.msgC);
        expect(resolved.predecessorOwnerMsgId).toBe(scenario.msgB);
    });

    it('does not mutate raw session history or commit ownership maps', () => {
        const scenario = buildSuccessfulTakeoverScenario();
        const sessionMap = {
            ...scenario.sessionMap,
            continuation: scenario.handoffAfterTakeover,
        };
        const originalEntries = sessionMap.entries;
        const originalMsgToCommit = sessionMap.msgToCommit;
        const originalMsgToBaseCommit = sessionMap.msgToBaseCommit;

        const resolved = resolveSessionOwnership(sessionMap, scenario.msgA);

        expect(resolved.currentOwnerMsgId).toBe(scenario.msgB);
        expect(sessionMap.entries).toBe(originalEntries);
        expect(sessionMap.msgToCommit).toBe(originalMsgToCommit);
        expect(sessionMap.msgToBaseCommit).toBe(originalMsgToBaseCommit);
        expect(sessionMap.msgToCommit[scenario.msgA]).toBe(scenario.commitA);
    });

    it('preserves user message ids when resolving visible owners during takeover collapse', () => {
        const scenario = buildSuccessfulTakeoverScenario();
        const sessionMap = {
            ...scenario.sessionMap,
            continuation: scenario.handoffAfterTakeover,
            msgToCommit: {
                ...scenario.sessionMap.msgToCommit,
                [scenario.msgB]: scenario.commitB,
            },
        };

        expect(resolveCurrentVisibleOwnerMsgId(sessionMap, 'msg_user_1')).toBe('msg_user_1');
        expect(resolveCurrentVisibleOwnerMsgId(sessionMap, scenario.msgA)).toBe(scenario.msgB);
        expect(resolveCurrentVisibleOwnerMsgId(sessionMap, scenario.msgB)).toBe(scenario.msgB);
    });

    it('collapses chained predecessor assistant owners but not arbitrary ids', () => {
        const scenario = buildChainedTakeoverScenario();
        const sessionMap = {
            ...scenario.sessionMap,
            continuation: scenario.handoffAfterC,
            msgToCommit: {
                ...scenario.sessionMap.msgToCommit,
                [scenario.msgC]: scenario.commitC,
            },
        };

        expect(resolveCurrentVisibleOwnerMsgId(sessionMap, scenario.msgA)).toBe(scenario.msgC);
        expect(resolveCurrentVisibleOwnerMsgId(sessionMap, scenario.msgB)).toBe(scenario.msgC);
        expect(resolveCurrentVisibleOwnerMsgId(sessionMap, 'msg_user_1')).toBe('msg_user_1');
    });
});
