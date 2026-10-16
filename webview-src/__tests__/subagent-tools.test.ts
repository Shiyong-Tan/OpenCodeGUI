import { subagentToolRows } from '../rendering/subagent-tools';

test('parallel subagent rows preserve identity and independently show state', () => {
    const rows = subagentToolRows({ sessionId: 'ses_A', tools: [
        { sessionId: 'ses_A', assistantMessageId: 'msg_A', callId: 'one', name: 'read', input: 'a', status: 'running' },
        { sessionId: 'ses_A', assistantMessageId: 'msg_A', callId: 'two', name: 'read', input: 'b', status: 'completed' },
    ] })!;
    expect(rows.map(row => row.status)).toEqual(['Running', 'Completed']);
    expect(rows[0].key).not.toBe(rows[1].key); expect(rows[0].color).not.toBe(rows[1].color);
});
test('foreign, duplicate and unrecognized tool rows cannot leak into another subagent', () => {
    const row = { sessionId: 'ses_A', assistantMessageId: 'msg_A', callId: 'one', name: '<script>', status: 'error' };
    expect(subagentToolRows({ sessionId: 'ses_A', tools: [row, row, { ...row, sessionId: 'ses_B' }, { ...row, callId: 'two', status: 'future' }] }))
        .toEqual([expect.objectContaining({ name: '<script>', status: 'Failed' })]);
});
test('legacy task cards keep their existing display and explicit empty collections stay empty', () => {
    expect(subagentToolRows({ latestTool: 'Reading file' })).toBeUndefined();
    expect(subagentToolRows({ tools: [] })).toEqual([]);
});
