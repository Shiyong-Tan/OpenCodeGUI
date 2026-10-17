jest.mock('vscode', () => ({
    workspace: { workspaceFolders: [{ uri: { fsPath: '/fixture' } }], getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }) },
    window: { createOutputChannel: () => ({ appendLine() {}, append() {}, dispose() {} }) },
    Uri: { file: (path: string) => ({ toString: () => `file://${path}` }) },
}), { virtual: true });
import { OpenCodeClient } from '../OpenCodeClient';
import { decodeV2Event } from '../transport/protocol/V2EventAdapter';
import { projectHistory } from '../transport/protocol/V2HistoryProjection';
import { message } from '../transport/protocol/V2Codec';

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

test('live text and repeated mixed-content history replay append each text part exactly once', () => {
    const { client } = harness();
    client.setCurrentTurnUserMsgId('ses_A', 'msg_user');
    client.acceptNativeStep(decodeV2Event({ id: 'evt_step', type: 'session.step.started',
        data: { sessionID: 'ses_A', assistantMessageID: 'msg_answer', started: Date.now() } }));
    const emit = (id: string, type: string, more: object) => client.acceptNativeText(decodeV2Event({ id, type,
        data: { sessionID: 'ses_A', assistantMessageID: 'msg_answer', ordinal: 0, ...more } }));
    emit('evt_delta', 'session.text.delta', { delta: 'Same' });
    emit('evt_ended', 'session.text.ended', { text: 'Same' });
    const projected = projectHistory('ses_A', [message({ id: 'msg_answer', type: 'assistant', time: { created: Date.now() },
        content: [{ type: 'reasoning', text: '' }, { type: 'text', text: 'Same' }, { type: 'text', text: 'Same' }] }, 'ses_A')], true);
    for (let i = 0; i < 2; i++) for (const part of projected.messages[0].parts)
        client.handleClassifiedServerEvent('message.part.updated', { part }, 'sse', 0);
    expect(client.getAssistantText('msg_answer')).toBe('SameSame');
});

test('native child final recovers its own user anchor without finalizing the parent or sibling', async () => {
    const { client, native } = harness();
    client.registerSubagentSession('ses_child', 'ses_parent');
    client.setCurrentTurnUserMsgId('ses_parent', 'msg_parent');
    client.setCurrentTurnUserMsgId('ses_sibling', 'msg_sibling');
    (native as any).projection = jest.fn(async () => ({ messages: [
        { info: { id: 'msg_child_user', role: 'user' }, parts: [] },
        { info: { id: 'msg_old', role: 'assistant', parentID: 'msg_old_user', finish: 'stop' }, parts: [] },
        { info: { id: 'msg_child_answer', sessionID: 'ses_child', role: 'assistant', parentID: 'msg_child_user',
            finish: 'stop', time: { created: 10, completed: 11 } }, parts: [] },
    ], controls: [], outcome: 'succeeded', active: false }));
    const dispatch = jest.spyOn(client, 'handleClassifiedServerEvent');
    client.emitChatEvents = jest.fn(); client.resolveTurnFinal = jest.fn();
    await client.reconcileNativeExecution('ses_child');
    expect(client.currentTurnUserMsgIdBySession.get('ses_child')).toBe('msg_child_user');
    expect(client.currentTurnUserMsgIdBySession.get('ses_parent')).toBe('msg_parent');
    expect(client.currentTurnUserMsgIdBySession.get('ses_sibling')).toBe('msg_sibling');
    expect(dispatch.mock.calls.some(([type, payload]: any[]) =>
        type === 'message.updated' && payload.info.id === 'msg_child_answer' && payload.info.finish === 'stop')).toBe(true);
    expect(dispatch.mock.calls.some(([, payload]: any[]) => payload.info?.id === 'msg_old')).toBe(false);
    expect(client.emitChatEvents.mock.calls.flatMap(([events]: any[]) => events)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'assistantMessageMeta', sessionId: 'ses_child',
            assistantMsgId: 'msg_child_answer', completedAt: 11, parentSessionId: 'ses_parent' }),
    ]));
    expect(client.resolveTurnFinal).not.toHaveBeenCalled();
});

test('detaching a child while its native history read is pending cannot restore its anchor or final', async () => {
    const { client, native } = harness();
    client.registerSubagentSession('ses_child', 'ses_parent');
    (native as any).projection = jest.fn(async () => {
        client.clearSubagentSession('ses_child');
        return { messages: [{ info: { id: 'msg_child_user', role: 'user' }, parts: [] }], controls: [], active: false };
    });
    client.handleClassifiedServerEvent = jest.fn();
    await client.reconcileNativeExecution('ses_child');
    expect(client.currentTurnUserMsgIdBySession.has('ses_child')).toBe(false);
    expect(client.handleClassifiedServerEvent).not.toHaveBeenCalled();
});

test('native delivered append owns the next step instead of retaining the legacy append root', async () => {
    const { client, native } = harness();
    client.turnStateBySession.set('ses_A', { turnMessageIds: new Set(), assistantMessageIds: new Set() });
    client.setCurrentTurnUserMsgId('ses_A', 'msg_root');
    client.appendTurnStateBySession.set('ses_A', { rootUserMsgId: 'msg_root', pending: [
        { clientMessageId: 'client_append', serverMsgId: 'msg_append', text: 'Pause and report' }],
        appendUserMsgIds: new Set(['msg_append']), emittedAppendUserMsgIds: new Set() });
    (native.history as jest.Mock).mockResolvedValue([{ info: { id: 'msg_append', role: 'user', sessionID: 'ses_A' }, parts: [] }]);
    client.emitChatEvents = jest.fn();
    await client.acceptNativeDelivered('ses_A', 'msg_append');
    expect(client.currentTurnUserMsgIdBySession.get('ses_A')).toBe('msg_append');
    const dispatch = jest.spyOn(client, 'handleClassifiedServerEvent');
    client.acceptNativeStep(decodeV2Event({ id: 'evt_next', type: 'session.step.started',
        data: { sessionID: 'ses_A', assistantMessageID: 'msg_reply', started: Date.now() } }));
    expect(dispatch).toHaveBeenCalledWith('message.updated', { info: expect.objectContaining({ parentID: 'msg_append' }) }, 'sse', 0);
});
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

test('an accepted native final is not overwritten by the empty-answer fallback before UI finishTurn', async () => {
    const { client, native } = harness();
    const turn = { turnMessageIds: new Set(), assistantMessageIds: new Set() } as any;
    client.turnStateBySession.set('ses_A', turn); client.currentTurnUserMsgIdBySession.set('ses_A', 'msg_user');
    (native as any).projection = jest.fn(async () => ({ messages: [{ info: { id: 'msg_answer', role: 'assistant',
        parentID: 'msg_user', finish: 'stop', time: { created: 1 } }, parts: [] }], controls: [], outcome: 'succeeded' }));
    client.handleClassifiedServerEvent = jest.fn(); client.markTurnFinal = jest.fn(); client.resolveTurnFinal = jest.fn();
    await client.reconcileNativeExecution('ses_A');
    expect(turn.terminalError).toBeUndefined();
    expect(client.resolveTurnFinal).toHaveBeenCalledTimes(1);
    expect(client.resolveTurnFinal).toHaveBeenCalledWith('ses_A', 'native-execution-ended');
});

test('a reviewed native question rejection supplies explicit feedback so the child can report rejection', async () => {
    const { client, native } = harness();
    client.getServerConn = jest.fn(async () => ({ baseUrl: 'http://127.0.0.1:42000' }));
    (native as any).interactions = { cancelForm: jest.fn(async () => undefined) };
    const connection = await client.connectRequestReview('ses_parent');
    await connection.native.respond({ sessionId: 'ses_child', requestId: 'frm_question', response: 'reject' });
    expect((native as any).interactions.cancelForm).toHaveBeenCalledWith('ses_child', 'frm_question', 'User rejected this question.');
});

test.each(['settled', 'queue', 'permission', 'form', 'active', 'shutdown', 'stale'])(
    'native interruption without idle requires fresh settled evidence: %s', async condition => {
        const { client, native } = harness();
        const turn: { terminalError?: string } = {};
        client.turnStateBySession.set('ses_A', turn);
        client.currentTurnStartedAtBySession.set('ses_A', 100);
        client.currentTurnUserMsgIdBySession.set('ses_A', 'msg_user');
        (native as any).projection = jest.fn(async () => ({ outcome: undefined, active: condition === 'active', controls: [],
            messages: [{ info: { id: 'msg_user', role: 'user' }, parts: [] }] }));
        (native.sessions as any).inbox = jest.fn(async () => condition === 'queue' ? [{}] : []);
        (native as any).interactions = {
            permissions: jest.fn(async () => condition === 'permission' ? [{}] : []),
            forms: jest.fn(async () => condition === 'form' ? [{}] : []),
        };
        client.resolveTurnFinal = jest.fn();
        const event = decodeV2Event({ id: 'evt_stop', type: 'session.execution.interrupted',
            created: condition === 'stale' ? 99 : 101, data: { sessionID: 'ses_A', reason: condition === 'shutdown' ? 'shutdown' : 'user' } });
        await client.reconcileNativeExecution('ses_A', event);
        if (condition === 'settled') {
            expect(turn.terminalError).toMatch(/interrupted/);
            expect(client.resolveTurnFinal).toHaveBeenCalledWith('ses_A', 'session-error-abort');
        } else expect(client.resolveTurnFinal).not.toHaveBeenCalled();
    });
