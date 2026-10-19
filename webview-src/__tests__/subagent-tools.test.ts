import { clampSubagentText, scheduleSubagentToolHide, subagentToolRows, visibleSubagentCards } from '../rendering/subagent-tools';

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

test('process wait explains the operation without asserting process health or changing terminal states', () => {
    for (const name of ['supervisor_process_wait', 'Running: supervisor_process_wait']) {
        const tools = ['pending', 'running', 'completed', 'error'].map(status => ({
            sessionId: 'ses_A', assistantMessageId: 'msg_A', callId: status, name, status, settledAt: 1000,
        }));
        expect(subagentToolRows({ sessionId: 'ses_A', tools }, 1000)?.map(row => row.status))
            .toEqual(['Preparing', 'Waiting for process metrics', 'Completed', 'Failed']);
        expect(subagentToolRows({ sessionId: 'ses_A', tools: [{ ...tools[1],
            progressText: 'Elapsed 8m 32s · CPU 95.0% · 2 live processes' }] }, 1000)?.[0].status)
            .toBe('Elapsed 8m 32s · CPU 95.0% · 2 live processes');
    }
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

test('a new completion or redraw cannot revive old completed rows or extend their deadlines', () => {
 const record = (callId: string, settledAt?: number) => ({sessionId:'ses_A', assistantMessageId:'msg_A', callId,
  name:'read', status:'completed', ...(settledAt === undefined ? {} : {settledAt})});
 const tools = [record('expired', 1000), record('historical'), record('fresh', 5000)];
 for (const now of [5000, 5500, 5999]) {
  const rows = subagentToolRows({sessionId:'ses_A',tools}, now)!;
  expect(rows).toHaveLength(1); expect(rows[0].hideAt).toBe(6000);
 }
 expect(subagentToolRows({sessionId:'ses_A',tools}, 6000)).toEqual([]);
});

test('fast completed/failed tools remain for one second while active parallel calls remain visible', () => {
 const agent = {sessionId:'ses_A', tools: ['completed', 'error', 'running'].map(status => ({
  sessionId:'ses_A', assistantMessageId:'msg_A', callId:status, name:'read', status,
  ...(status === 'running' ? {} : {settledAt:1000}),
 }))};
 expect(subagentToolRows(agent, 1999)?.map(row => row.status)).toEqual(['Completed', 'Failed', 'Running']);
 expect(subagentToolRows(agent, 2000)?.map(row => row.status)).toEqual(['Running']);
 expect(agent.tools).toHaveLength(3);
});

test('dwell expiry removes only its captured mounted tool group and never another remounted row', () => {
 jest.useFakeTimers(); jest.setSystemTime(1000);
 try {
  const row = {isConnected:true, remove:jest.fn()}, detached = {isConnected:false, remove:jest.fn()};
  scheduleSubagentToolHide(row as unknown as HTMLElement, 2000);
  scheduleSubagentToolHide(detached as unknown as HTMLElement, 2000);
  jest.advanceTimersByTime(999); expect(row.remove).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1); expect(row.remove).toHaveBeenCalledTimes(1); expect(detached.remove).not.toHaveBeenCalled();
 } finally { jest.useRealTimers(); }
});

test('collapsed previews keep natural short height and a stable five-line cap across streaming and expansion', () => {
 const properties = new Map<string,string>();
 const row = {style:{setProperty:(name:string, value:string) => properties.set(name,value)}} as unknown as HTMLElement;
 for (let index=0; index<10; index++) {
  clampSubagentText(row, false);
  expect(properties.get('height')).toBe('auto'); expect(properties.get('max-height')).toBe('7.5em');
 }
 expect(properties.get('line-height')).toBe('1.5'); expect(properties.get('overflow')).toBe('hidden');
 clampSubagentText(row,true); expect(properties.get('height')).toBe('auto'); expect(properties.get('overflow')).toBe('visible');
 clampSubagentText(row,false); expect(properties.get('height')).toBe('auto');
});
