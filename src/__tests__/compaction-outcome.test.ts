jest.mock('vscode', () => ({
    window: { createOutputChannel: () => ({ appendLine: () => undefined }) },
    workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
}), { virtual: true });

import { OpenCodeClient } from '../OpenCodeClient';
import { createUtilityCommandHandler } from '../webview/controllers/UtilityCommandController';
import { COMPACTION_ONLY_STOP, findCompactionOnlyStop, verifyCompactionResult } from '../continuation/CompactionOutcome';

const prompt = { info: { id: 'msg_user', role: 'user' }, parts: [{ type: 'text', text: 'question' }] };
const summary = { info: { id: 'msg_summary', role: 'assistant', parentID: 'msg_user', agent: 'compaction', summary: true, finish: 'stop', time: { completed: 20 } }, parts: [] };

describe('compaction outcomes', () => {
    test.each([false, true])('manual compaction reports the verified outcome and clears its indicator (failure=%s)', async fail => {
        const postMessage = jest.fn();
        const host = {
            pickCompactionModelId: () => 'free/model', parseModelRef: () => ({ providerID: 'free', modelID: 'model' }),
            summarizeSession: jest.fn(async () => { if (fail) throw new Error('provider failed'); return true; }),
            getLiveWebview: (view: unknown) => view, postAddResponse: jest.fn(), fetchSessionUsage: jest.fn(),
        };
        const handle = createUtilityCommandHandler(host as any);
        await handle({ type: 'compactSession', sessionId: 'A' }, { postMessage } as any, { postMessage } as any);
        expect(host.postAddResponse.mock.calls[0][1]).toContain(fail ? 'Compaction failed' : 'Compaction completed');
        expect(postMessage).toHaveBeenLastCalledWith({ type: 'compactionState', sessionId: 'A', running: false });
    });
    test('distinguishes summary-only stop from a real answer', () => {
        expect(findCompactionOnlyStop([prompt, summary], 'msg_user')).toBe(COMPACTION_ONLY_STOP);
        expect(findCompactionOnlyStop([prompt, summary, { info: { role: 'assistant', parentID: 'msg_user' } }], 'msg_user')).toBeUndefined();
    });
    test.each([
        [], [summary], [prompt],
        [prompt, { ...summary, info: { ...summary.info, finish: undefined } }],
        [prompt, { ...summary, info: { ...summary.info, parentID: 'msg_old' } }],
        [{ ...prompt, parts: [{ type: 'compaction', auto: true }] }, summary],
        [prompt, summary, { info: { id: 'msg_continue', role: 'user' } }],
    ])('does not terminate an unproven or continuing request (%#)', (...messages) => {
        expect(findCompactionOnlyStop(messages, 'msg_user')).toBeUndefined();
    });
    test('does not mistake HTTP success or an old summary for successful manual compaction', () => {
        expect(() => verifyCompactionResult([], [summary])).not.toThrow();
        expect(() => verifyCompactionResult([summary], [summary])).toThrow('could not be verified');
        expect(() => verifyCompactionResult([], [{ info: { ...summary.info, error: { name: 'APIError' } } }])).toThrow('provider failed');
        expect(() => verifyCompactionResult([], [])).toThrow('could not be verified');
    });
});

function clientHarness() {
    const client = Object.create(OpenCodeClient.prototype) as any;
    const state: { compactionCheckPending?: boolean; terminalError?: string } = {};
    Object.assign(client, {
        turnStateBySession: new Map([['A', state]]), currentTurnUserMsgIdBySession: new Map([['A', 'msg_user']]),
        subagentToParentSessionMap: new Map(), canceledActiveTurnBySession: new Map(), turnFinalResolvedBySession: new Set(),
        getTurnAssistantMsgId: jest.fn(() => undefined), logUiDebug: jest.fn(), resolveTurnFinal: jest.fn(),
        requestJson: jest.fn(async (_method: string, route: string) => route === '/session/status' ? {} : [prompt, summary]),
    });
    return { client, state };
}

describe('compaction-only turn closure', () => {
    test('idle releases the actual final waiter without accepting the summary as an answer', async () => {
        const { client, state } = clientHarness();
        delete client.resolveTurnFinal;
        Object.assign(client, {
            appendTurnStateBySession: new Map(), turnFinalMsgIdBySession: new Map(), finalizingMsgIdBySession: new Map(),
            turnFinalWaitersBySession: new Map(), turnFinalSourceBySession: new Map(), turnFinalAtBySession: new Map(),
            lockedFinalSettleAttemptsBySession: new Map(), clearPendingMainFinalGate: jest.fn(),
            stopNonFinalResyncLoop: jest.fn(), stopRescueWatchdog: jest.fn(), startRescueTimer: jest.fn(), markTurnFinal: jest.fn(),
        });
        const waiting = client.waitForTurnCompletionFinal('A');
        client.handleSessionIdleFinal('A');
        await waiting;
        expect(state.terminalError).toBe(COMPACTION_ONLY_STOP);
        expect(client.turnFinalResolvedBySession.has('A')).toBe(true);
        expect(client.turnFinalMsgIdBySession.size).toBe(0);
        expect(client.turnFinalResolvedBySession.has('B')).toBe(false);
    });
    test('verifies idle and messages before resolving the owning request as an error', async () => {
        const { client, state } = clientHarness();
        await client.checkCompactionOnlyStop('A', state);
        expect(state.terminalError).toBe(COMPACTION_ONLY_STOP);
        expect(client.resolveTurnFinal).toHaveBeenCalledWith('A', 'session-error');
        expect(client.requestJson.mock.calls.map((call: string[]) => call[1])).toEqual([
            '/session/A/message?limit=200', '/session/status', '/session/A/message?limit=200',
        ]);
    });
    test.each(['busy', 'retry'])('does not close a %s backend', async status => {
        const { client, state } = clientHarness();
        client.requestJson.mockImplementation(async (_method: string, route: string) => route === '/session/status' ? { A: { type: status } } : [prompt, summary]);
        await client.checkCompactionOnlyStop('A', state);
        expect(client.resolveTurnFinal).not.toHaveBeenCalled();
    });
    test('discards stale results after a newer turn starts', async () => {
        const { client, state } = clientHarness();
        client.requestJson.mockImplementation(async () => {
            client.turnStateBySession.set('A', {});
            return [prompt, summary];
        });
        await client.checkCompactionOnlyStop('A', state);
        expect(client.resolveTurnFinal).not.toHaveBeenCalled();
    });
    test('keeps waiting when a real answer arrives during verification', async () => {
        const { client, state } = clientHarness();
        client.requestJson.mockResolvedValueOnce([prompt, summary]).mockResolvedValueOnce({})
            .mockResolvedValueOnce([prompt, summary, { info: { id: 'msg_answer', role: 'assistant' } }]);
        await client.checkCompactionOnlyStop('A', state);
        expect(client.resolveTurnFinal).not.toHaveBeenCalled();
    });
    test('read failure leaves the request pending rather than guessing it is finished', async () => {
        const { client, state } = clientHarness();
        client.requestJson.mockRejectedValue(new Error('offline'));
        await client.checkCompactionOnlyStop('A', state);
        expect(client.resolveTurnFinal).not.toHaveBeenCalled();
        expect(state.compactionCheckPending).toBe(false);
    });
    test('manual compaction validates the recorded provider result', async () => {
        const { client } = clientHarness();
        client.ensureServer = jest.fn();
        client.requestJson.mockResolvedValueOnce([]).mockResolvedValueOnce(true)
            .mockResolvedValueOnce([{ info: { ...summary.info, error: { name: 'APIError' } } }]);
        await expect(client.summarizeSession('A', { providerID: 'free', modelID: 'free' })).rejects.toThrow('provider failed');
    });
    test('chat surfaces the verified error instead of reporting a successful answer', async () => {
        const { client, state } = clientHarness();
        client.ensureServer = jest.fn(); client.parseModelRef = jest.fn();
        client.expectedMainAgentBySession = new Map(); client.eventListeners = new Set();
        client.waitForTurnCompletionFinal = jest.fn(async () => { state.terminalError = COMPACTION_ONLY_STOP; });
        await expect(client.chat('question', { sessionId: 'A' }, jest.fn())).rejects.toThrow(COMPACTION_ONLY_STOP);
        expect(client.eventListeners.size).toBe(0);
    });
});
