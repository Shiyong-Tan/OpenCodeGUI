jest.mock('vscode', () => ({
    workspace: { workspaceFolders: [{ uri: { fsPath: '/fixture' } }], getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
    window: { createOutputChannel: () => ({ appendLine() {}, append() {}, dispose() {} }) },
    Uri: { file: (path: string) => ({ toString: () => `file://${path}` }) },
}), { virtual: true });
import { OpenCodeClient } from '../OpenCodeClient';
import { decodeV2Event } from '../transport/protocol/V2EventAdapter';

function harness() {
    const client = new OpenCodeClient() as any;
    const native = { sessions: { admit: jest.fn(async (sessionId: string, value: any) => ({ sessionId, id: value.id, delivery: value.delivery })),
        interrupt: jest.fn(async () => ({ interrupted: true })), createSession: jest.fn(async () => ({ id: 'ses_new' })) },
        controls: { selectModel: jest.fn(async () => undefined), selectAgent: jest.fn(async () => undefined), active: jest.fn(async () => ({})),
            models: jest.fn(async () => [{ ref: { id: 'model', providerID: 'provider' }, name: 'Model', enabled: true, variants: ['high'], contextLimit: 1000 }]) },
        history: jest.fn(async () => []), sessionInfo: jest.fn(async (id: string) => ({ id, title: 'Fixture' })) };
    client.protocolBinding = { native, identity: { family: 'v2', version: '2.99.0' }, generation: 7, isCurrent: () => true };
    client.ensureServer = jest.fn(async () => undefined);
    client.requestJson = jest.fn(async () => { throw new Error('Unexpected V1 request'); });
    client.repairFailedCompaction = jest.fn(async () => { throw new Error('Unexpected V1 compaction repair'); });
    return { client, native };
}
test('native chat selects the requested role/model then admits exactly one durable prompt', async () => {
    const { client, native } = harness();
    client.turnStateBySession.set('ses_A', { pendingUserLocalKey: 'local-A', turnMessageIds: new Set(), assistantMessageIds: new Set() });
    client.waitForTurnCompletionFinal = jest.fn(async () => 'sse');
    client.handleClassifiedServerEvent = jest.fn();
    await client.chat('Fixture', { sessionId: 'ses_A', model: 'provider/model', variant: 'high', mode: 'researcher' });
    expect(native.controls.selectModel).toHaveBeenCalledWith('ses_A', { providerID: 'provider', id: 'model', variant: 'high' });
    expect(native.controls.selectAgent).toHaveBeenCalledWith('ses_A', 'researcher');
    expect(native.sessions.admit).toHaveBeenCalledTimes(1);
    const admitted = native.sessions.admit.mock.calls[0][1];
    expect(admitted).toMatchObject({ text: 'Fixture', delivery: 'steer' }); expect(admitted.id).toMatch(/^msg_/);
    expect(client.currentTurnUserMsgIdBySession.get('ses_A')).toBe(admitted.id);
    expect(client.requestJson).not.toHaveBeenCalled(); expect(client.repairFailedCompaction).not.toHaveBeenCalled();
});
test('native session reads/creation and interrupt route independently of the visible session', async () => {
    const { client, native } = harness(); client.currentSessionId = 'ses_visible';
    expect(await client.createSession()).toEqual({ id: 'ses_new' });
    await client.exportSession('ses_background'); await client.abortSession('ses_background');
    expect(native.history).toHaveBeenCalledWith('ses_background');
    expect(native.sessions.interrupt).toHaveBeenCalledWith('ses_background'); expect(client.requestJson).not.toHaveBeenCalled();
});
test('native text delta followed by full ended text cannot append a duplicate answer', () => {
    const { client } = harness(); client.handleClassifiedServerEvent = jest.fn();
    const raw = (id: string, type: string, data: Record<string, unknown>) => decodeV2Event({ id, type, data: {
        sessionID: 'ses_A', assistantMessageID: 'msg_A', ordinal: 0, ...data,
    } });
    client.acceptNativeText(raw('evt_A', 'session.text.delta', { delta: 'Hello' }));
    const key = client.getAssistantTextLengthPartKey('msg_A', { id: 'msg_A_0' });
    expect(client.assistantTextLengthsByPart.get(key)).toBe(5);
    client.acceptNativeText(raw('evt_B', 'session.text.ended', { text: 'Hello' }));
    expect(client.assistantTextLengthsByPart.get(key)).toBe(5);
    expect(client.handleClassifiedServerEvent).toHaveBeenCalledTimes(2);
});

test('native idle without an assistant answer resolves only the owning turn with an explicit error', async () => {
    const { client, native } = harness();
    const turn = { turnMessageIds: new Set(), assistantMessageIds: new Set() } as any;
    client.turnStateBySession.set('ses_A', turn);
    (native as any).projection = jest.fn(async () => ({ messages: [], controls: [], outcome: 'succeeded' }));
    client.resolveTurnFinal = jest.fn();
    await client.reconcileNativeExecution('ses_A');
    expect(turn.terminalError).toMatch(/without an answer/);
    expect(client.resolveTurnFinal).toHaveBeenCalledWith('ses_A', 'session-error');
});

test('a superseded native idle read cannot finalize a newer turn', async () => {
    const { client, native } = harness();
    const first = {}, second = {};
    client.turnStateBySession.set('ses_A', first);
    (native as any).projection = jest.fn(async () => {
        client.turnStateBySession.set('ses_A', second);
        return { messages: [], controls: [], outcome: 'succeeded' };
    });
    client.resolveTurnFinal = jest.fn();
    await client.reconcileNativeExecution('ses_A');
    expect(client.resolveTurnFinal).not.toHaveBeenCalled();
});
