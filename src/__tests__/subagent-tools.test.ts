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
test('bounded settled history does not discard any active parallel call', () => {
    let tools: SubagentToolProgress[] = [];
    for (let index = 0; index < 80; index++) tools = updateSubagentTools(tools, event(String(index), index % 2 ? 'running' : 'completed'))!;
    expect(tools.filter(item => item.status === 'running')).toHaveLength(40);
    expect(tools.filter(item => item.status === 'completed')).toHaveLength(32);
});
