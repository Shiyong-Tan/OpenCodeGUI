import { subagentToolRows, visibleSubagentCards } from '../rendering/subagent-tools';

test('completed child cards disappear while active siblings and canonical results remain', () => {
    const agents = [{ state: 'running' }, { state: 'done', result: 'keep' }, { state: 'finalizing' }, { isDone: true }];
    expect(visibleSubagentCards(agents)).toEqual([agents[0], agents[2]]);
    expect(agents[1].result).toBe('keep'); expect(agents).toHaveLength(4);
});

test('cancelled and failed child cards leave the active view without deleting their evidence', () => {
    const agents = ['running', 'cancelled', 'failed', 'dismissed'].map(state => ({ state, isDone: state !== 'running' }));
    expect(visibleSubagentCards(agents)).toEqual([agents[0]]);
    expect(agents).toHaveLength(4);
});

test('parallel subagent rows preserve identity and independently show state', () => {
    const rows = subagentToolRows({ sessionId: 'ses_A', tools: [
        { sessionId: 'ses_A', assistantMessageId: 'msg_A', callId: 'one', name: 'read', input: 'a', status: 'running' },
        { sessionId: 'ses_A', assistantMessageId: 'msg_A', callId: 'two', name: 'read', input: 'b', status: 'pending' },
    ] })!;
    expect(rows.map(row => row.status)).toEqual(['Running', 'Preparing']);
    expect(rows[0].key).not.toBe(rows[1].key);
});
test('foreign, duplicate and unrecognized tool rows cannot leak into another subagent', () => {
    const row = { sessionId: 'ses_A', assistantMessageId: 'msg_A', callId: 'one', name: '<script>', status: 'running' };
    expect(subagentToolRows({ sessionId: 'ses_A', tools: [row, row, { ...row, sessionId: 'ses_B' }, { ...row, callId: 'two', status: 'future' }] }))
        .toEqual([expect.objectContaining({ name: '<script>', status: 'Running' })]);
});
test('legacy task cards keep their existing display and explicit empty collections stay empty', () => {
    expect(subagentToolRows({ latestTool: 'Reading file' })).toBeUndefined();
    expect(subagentToolRows({ tools: [] })).toEqual([]);
});

test('completed tool rows disappear without deleting canonical tool records', () => {
 const tools = ['completed', 'error'].map(status => ({sessionId:'ses_A',assistantMessageId:'msg_A',callId:status,name:'read',status}));
 expect(subagentToolRows({sessionId:'ses_A',tools})).toEqual([]);
 expect(tools).toHaveLength(2);
});
