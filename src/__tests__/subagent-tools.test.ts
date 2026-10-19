import { updateSubagentTools, type SubagentToolProgress } from '../events/SubagentTools';
import type { ChatEvent } from '../OpenCodeClient';

const event = (callId: string, status = 'running', overrides = {}): ChatEvent => ({ type: 'tool', sessionId: 'ses_child', assistantMsgId: 'msg_A', callId,
    tool: 'read', toolState: { status, input: { path: `/fixture/${callId}` } }, ...overrides });
test('parallel tools update independently and duplicate names never collapse call identity', () => {
    let tools = updateSubagentTools([], event('one'))!;
    tools = updateSubagentTools(tools, event('two'))!;
    tools = updateSubagentTools(tools, event('one', 'completed'))!;
    expect(tools).toHaveLength(2);
    expect(tools.map(item => item.status)).toEqual(['completed', 'running']);
    expect(tools[1].input).toBe('/fixture/two');
});
test('late progress cannot reopen a settled tool or regress running to streaming', () => {
    const tools = updateSubagentTools([], event('one', 'completed'))!;
    expect(updateSubagentTools(tools, event('one'))).toEqual(tools);
    const running = updateSubagentTools([], event('two'))!;
    expect(updateSubagentTools(running, event('two', 'streaming'))).toEqual(running);
});

test('first terminal observation owns the dwell deadline; replay cannot extend it or reopen a tool', () => {
    const running = updateSubagentTools([], event('one'), 100)!;
    const settled = updateSubagentTools(running, event('one', 'completed'), 200)!;
    expect(settled[0]).toMatchObject({ status: 'completed', settledAt: 200 });
    expect(updateSubagentTools(settled, event('one', 'completed'), 5000)).toEqual(settled);
    expect(updateSubagentTools(settled, event('one', 'running'), 6000)).toEqual(settled);
    expect(running[0].settledAt).toBeUndefined();
});

test('completed-only replay does not manufacture a fresh display deadline, including evicted history', () => {
    let tools: SubagentToolProgress[] = [];
    for (let index = 0; index < 40; index++) tools = updateSubagentTools(tools, event(String(index), 'completed'), 100)!;
    expect(tools).toHaveLength(32);
    expect(tools.every(tool => tool.settledAt === undefined)).toBe(true);
    const replay = updateSubagentTools(tools, event('0', 'completed'), 10000)!;
    expect(replay.find(tool => tool.callId === '0')?.settledAt).toBeUndefined();
    let active = updateSubagentTools(replay, event('live', 'pending'), 10000)!;
    active = updateSubagentTools(active, event('live', 'completed'), 10001)!;
    expect(active.find(tool => tool.callId === 'live')?.settledAt).toBe(10001);
});
test('same call ID in different assistant messages and sessions remains distinct', () => {
    let tools = updateSubagentTools([], event('one'))!;
    tools = updateSubagentTools(tools, event('one', 'running', { assistantMsgId: 'msg_B' }))!;
    tools = updateSubagentTools(tools, event('one', 'running', { sessionId: 'ses_other' }))!;
    expect(tools).toHaveLength(3);
});
test('missing identity retains the legacy display path rather than inventing a tool ID', () => {
    expect(updateSubagentTools([], event('', 'running'))).toBeUndefined();
    expect(updateSubagentTools([], event('one', 'future'))).toBeUndefined();
});

test('process metrics follow their exact call and cannot overwrite terminal evidence', () => {
    const progress = event('one', 'running', { tool: 'Running: supervisor_process_wait',
        toolState: { status: 'running', progressText: 'Elapsed 8m 32s · CPU 95.0%' } });
    let tools = updateSubagentTools([], progress)!;
    tools = updateSubagentTools(tools, event('two'))!;
    expect(tools[0].progressText).toBe('Elapsed 8m 32s · CPU 95.0%');
    expect(tools[1].progressText).toBeUndefined();
    tools = updateSubagentTools(tools, event('one', 'completed'))!;
    expect(updateSubagentTools(tools, progress)).toEqual(tools);
});

test('wait execution identity survives progress without input and remains independent of another tool', () => {
    const wait = event('wait', 'running', {tool:'Running: supervisor_process_wait',toolState:{status:'running',input:{executionId:'exec_A'}}});
    let tools=updateSubagentTools([],wait)!;
    tools=updateSubagentTools(tools,event('read'))!;
    tools=updateSubagentTools(tools,{...wait,toolState:{status:'running'}})!;
    expect(tools[0].executionId).toBe('exec_A'); expect(tools[1].executionId).toBeUndefined();
    expect(tools.map(tool=>tool.status)).toEqual(['running','running']);
});
test('bounded settled history does not discard any active parallel call', () => {
    let tools: SubagentToolProgress[] = [];
    for (let index = 0; index < 80; index++) tools = updateSubagentTools(tools, event(String(index), index % 2 ? 'running' : 'completed'))!;
    expect(tools.filter(item => item.status === 'running')).toHaveLength(40);
    expect(tools.filter(item => item.status === 'completed')).toHaveLength(32);
});
