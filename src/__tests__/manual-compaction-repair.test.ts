jest.mock('vscode', () => ({ window: { createOutputChannel: () => ({ appendLine() {} }) }, workspace: {} }), { virtual: true });
import { failedManualCompaction, repairFailedManualCompaction } from '../continuation/ManualCompaction';
import { OpenCodeClient } from '../OpenCodeClient';

const control = { info: { id: 'control', sessionID: 'A', role: 'user' }, parts: [
    { id: 'part', sessionID: 'A', messageID: 'control', type: 'compaction', auto: false },
] };
const failure = { info: { id: 'failure', sessionID: 'A', role: 'assistant', parentID: 'control', summary: true,
    error: { name: 'APIError' }, time: { completed: 10 } }, parts: [] };
const failed = [control, failure];
const cleaned = [{ ...control, parts: [] }, failure];

test('identifies only a failed manual control with no ordinary user content', () => {
    expect(failedManualCompaction(failed, 'A')).toEqual({ messageId: 'control', partId: 'part' });
    for (const messages of [
        [control],
        [{ ...control, parts: [{ ...control.parts[0], auto: true }] }, failure],
        [{ ...control, parts: [...control.parts, { type: 'text', text: 'keep' }] }, failure],
        [control, { ...failure, info: { ...failure.info, error: undefined, finish: 'stop' } }],
        [control, { ...failure, info: { ...failure.info, time: {} } }],
        [...failed, { info: { id: 'new-user', role: 'user' }, parts: [] }],
        [...failed, { info: { role: 'assistant', summary: false } }],
    ]) expect(failedManualCompaction(messages, 'A')).toBeUndefined();
    expect(failedManualCompaction(failed, 'B')).toBeUndefined();
});

test('uses the original session/message/part and verifies cleanup without invoking a model', async () => {
    const request = jest.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce({})
        .mockResolvedValueOnce(failed).mockResolvedValueOnce(true).mockResolvedValueOnce(cleaned);
    await expect(repairFailedManualCompaction('A', request)).resolves.toBe(true);
    expect(request.mock.calls.filter(([method]) => method !== 'GET')).toEqual([
        ['DELETE', '/session/A/message/control/part/part'],
    ]);
});

test.each(['busy', 'retry', 'unknown'])('does not clean an active or unverified session (%s)', async type => {
    const request = jest.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce({ A: { type } });
    await expect(repairFailedManualCompaction('A', request)).rejects.toThrow('idle');
    expect(request.mock.calls.every(([method]) => method === 'GET')).toBe(true);
});

test('rejects newer messages, failed deletion and unconfirmed deletion', async () => {
    const changed = jest.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce({}).mockResolvedValueOnce(cleaned);
    await expect(repairFailedManualCompaction('A', changed)).rejects.toThrow('changed');
    expect(changed).toHaveBeenCalledTimes(3);
    const denied = jest.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce({})
        .mockResolvedValueOnce(failed).mockRejectedValueOnce(new Error('permission denied'));
    await expect(repairFailedManualCompaction('A', denied)).rejects.toThrow('permission denied');
    const retained = jest.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce({})
        .mockResolvedValueOnce(failed).mockResolvedValueOnce(true).mockResolvedValueOnce(failed);
    await expect(repairFailedManualCompaction('A', retained)).rejects.toThrow('could not be confirmed');
});

function harness() {
    const client = Object.create(OpenCodeClient.prototype) as any;
    Object.assign(client, { workspaceRoot: 'workspace', turnStateBySession: new Map(), ensureServer: jest.fn(),
        logUiDebug: jest.fn(), parseModelRef: jest.fn(), eventListeners: new Set(), expectedMainAgentBySession: new Map(),
        waitForTurnCompletionFinal: jest.fn(), requestJson: jest.fn() });
    return client;
}

test('a failed summarize cleans its control and reports failure; the next question is posted exactly once', async () => {
    const client = harness();
    let messages: unknown[] = [];
    client.requestJson.mockImplementation(async (method: string, route: string) => {
        if (route.endsWith('/summarize')) { messages = failed; return true; }
        if (method === 'DELETE') { messages = cleaned; return true; }
        if (route === '/session/status') return {};
        return messages;
    });
    await expect(client.summarizeSession('A', { providerID: 'free', modelID: 'free' })).rejects.toThrow('provider failed');
    expect(messages).toEqual(cleaned);
    await client.chat('question', { sessionId: 'A', mode: 'researcher' });
    expect(client.requestJson.mock.calls.filter(([, route]: string[]) => route.endsWith('/prompt_async'))).toEqual([
        ['POST', '/session/A/prompt_async', { parts: [{ type: 'text', text: 'question' }], agent: 'researcher' }],
    ]);
});

test('preflight repairs a failed control left by an older GUI before posting a new question', async () => {
    const client = harness();
    client.requestJson.mockResolvedValueOnce(failed).mockResolvedValueOnce({}).mockResolvedValueOnce(failed)
        .mockResolvedValueOnce(true).mockResolvedValueOnce(cleaned).mockResolvedValueOnce(undefined);
    await client.chat('question', { sessionId: 'A' });
    expect(client.requestJson.mock.calls.map(([method]: string[]) => method)).toEqual(['GET', 'GET', 'GET', 'DELETE', 'GET', 'POST']);
});

test('busy failed control blocks prompt submission; workspace change blocks deletion', async () => {
    const client = harness();
    client.requestJson.mockResolvedValueOnce(failed).mockResolvedValueOnce({ A: { type: 'busy' } });
    await expect(client.chat('question', { sessionId: 'A' })).rejects.toThrow('idle');
    expect(client.requestJson.mock.calls.every(([method]: string[]) => method === 'GET')).toBe(true);
    client.requestJson.mockImplementation(async () => { client.workspaceRoot = 'different'; return failed; });
    await expect(client.repairFailedCompaction('A')).rejects.toThrow('Session changed');
});

test('manual compaction is serialized per session and blocks a competing prompt without a model call', async () => {
    const client = harness();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    client.ensureServer.mockImplementation(() => barrier);
    client.repairFailedCompaction = jest.fn();
    const completed = new Set<string>();
    client.requestJson.mockImplementation(async (method: string, route: string) => {
        const session = route.split('/')[2];
        if (method === 'POST') { completed.add(session); return true; }
        return completed.has(session) ? [{ info: { id: 'summary', role: 'assistant', summary: true, finish: 'stop', time: { completed: 10 } } }] : [];
    });
    const a = client.summarizeSession('A', { providerID: 'free', modelID: 'free' });
    await expect(client.summarizeSession('A', { providerID: 'free', modelID: 'free' })).rejects.toThrow('already running');
    const b = client.summarizeSession('B', { providerID: 'free', modelID: 'free' });
    const prompt = client.chat('question', { sessionId: 'A' }, jest.fn());
    const rejected = expect(prompt).rejects.toThrow('Compaction is still running');
    release();
    await rejected;
    await expect(a).resolves.toBe(true);
    await expect(b).resolves.toBe(true);
    expect(client.eventListeners.size).toBe(0);
    expect(client.requestJson.mock.calls.filter(([, route]: string[]) => route.endsWith('/prompt_async'))).toHaveLength(0);
});

test('unavailable compaction refreshes models and retries only a different free model', async () => {
    const client = harness(); client.parseModelRef.mockImplementation((fullId: string) => ({ providerID: fullId.split('/')[0], modelID: fullId.split('/')[1] }));
    client.listModels = jest.fn().mockResolvedValue([
        { fullId: 'opencode/first-free', providerId: 'opencode', id: 'first-free' },
        { fullId: 'openai/paid', providerId: 'openai', id: 'paid' },
        { fullId: 'opencode/second-free', providerId: 'opencode', id: 'second-free' },
    ]);
    client.repairFailedCompaction = jest.fn();
    let attempt = 0;
    client.requestJson.mockImplementation(async (method: string) => {
        if (method === 'POST') { attempt++; return true; }
        if (!attempt) return [];
        return [{ info: { id: 'summary' + attempt, role: 'assistant', summary: true, finish: 'stop', time: { completed: 10 },
            ...(attempt === 1 ? { error: { data: { message: 'Upstream request failed: Model is unavailable.' } } } : {}) } }];
    });
    await expect(client.summarizeSession('A', { providerID: 'opencode', modelID: 'first-free', allowFreeFallback: true })).resolves.toBe(true);
    expect(client.requestJson.mock.calls.filter(([method]: string[]) => method === 'POST').map((call: unknown[]) => call[2])).toEqual([
        { providerID: 'opencode', modelID: 'first-free', auto: false }, { providerID: 'opencode', modelID: 'second-free', auto: false },
    ]);
    expect(client.listModels).toHaveBeenCalledTimes(1);
});

test('unavailable compaction stops when refreshed catalog contains no other free model', async () => {
    const client = harness(); client.repairFailedCompaction = jest.fn(); client.listModels = jest.fn().mockResolvedValue([{ fullId: 'openai/paid', providerId: 'openai' }]);
    let posted = false;
    client.requestJson.mockImplementation(async (method: string) => {
        if (method === 'POST') { posted = true; return true; }
        return posted ? [{ info: { id: 'failure', role: 'assistant', summary: true, error: { data: { message: 'Model is unavailable.' } } } }] : [];
    });
    await expect(client.summarizeSession('A', { providerID: 'opencode', modelID: 'first-free', allowFreeFallback: true })).rejects.toThrow('no alternative free model');
    expect(client.requestJson.mock.calls.filter(([method]: string[]) => method === 'POST')).toHaveLength(1);
});

test('free compaction fallback is bounded to three distinct models', async () => {
    const client = harness(); client.repairFailedCompaction = jest.fn();
    client.parseModelRef.mockImplementation((fullId: string) => ({ providerID: 'opencode', modelID: fullId.split('/')[1] }));
    client.listModels = jest.fn().mockResolvedValue([1, 2, 3, 4].map(n => ({ fullId: 'opencode/' + n + '-free', providerId: 'opencode', id: n + '-free' })));
    let posted = 0;
    client.requestJson.mockImplementation(async (method: string) => {
        if (method === 'POST') { posted++; return true; }
        return posted ? [{ info: { id: 'failure' + posted, role: 'assistant', summary: true, error: { data: { message: 'Model is unavailable.' } } } }] : [];
    });
    await expect(client.summarizeSession('A', { providerID: 'opencode', modelID: '1-free', allowFreeFallback: true })).rejects.toThrow('three models');
    expect(posted).toBe(3);
});

test('failed cleanup blocks fallback, even for an unavailable model', async () => {
    const client = harness(); client.repairFailedCompaction = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('cleanup unverified'));
    client.listModels = jest.fn(); let posted = false;
    client.requestJson.mockImplementation(async (method: string) => {
        if (method === 'POST') { posted = true; return true; }
        return posted ? [{ info: { id: 'failure', role: 'assistant', summary: true, error: { data: { message: 'Model is unavailable.' } } } }] : [];
    });
    await expect(client.summarizeSession('A', { providerID: 'opencode', modelID: 'first-free', allowFreeFallback: true })).rejects.toThrow('cleanup unverified');
    expect(client.listModels).not.toHaveBeenCalled();
});
