import { V2EventIntegration, nativeToolFragment, type NativeEventOwner } from '../transport/protocol/V2EventIntegration';
import { decodeV2Event } from '../transport/protocol/V2EventAdapter';
import type { V2Backend } from '../transport/protocol/V2Backend';
import { extractFilesFromToolPart } from '../changes/FileChangeExtractor';

const event = (id: string, type: string, data: Record<string, unknown> = {}) => decodeV2Event({ id: `evt_${id}`, type, data: { sessionID: 'ses_A', ...data } });
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test('native patch completion carries file diffs into the existing change extractor', () => {
    const started = nativeToolFragment(event('patch-start', 'session.tool.input.started', { assistantMessageID: 'msg_A', id: 'call_patch', name: 'patch' }), undefined)!;
    const completed = nativeToolFragment(event('patch-done', 'session.tool.success', { assistantMessageID: 'msg_A', id: 'call_patch',
        content: [], metadata: { files: [{ file: 'src/a.ts', status: 'modified', patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new' }] } }), started)!;
    expect(completed.sessionID).toBe('ses_A'); expect(completed.messageID).toBe('msg_A');
    expect(extractFilesFromToolPart(completed)).toEqual([expect.objectContaining({ filePath: 'src/a.ts', type: 'update', patch: expect.stringContaining('+new') })]);
});
function harness() {
    let current = true;
    const owner: NativeEventOwner = { isCurrent: () => current, accepts: () => true, session: jest.fn(), step: jest.fn(), text: jest.fn(), tool: jest.fn(),
        delivered: jest.fn(async () => undefined), reconcile: jest.fn(async () => undefined), interaction: jest.fn(), failure: jest.fn() };
    const sessionInfo = jest.fn(async (id: string) => ({ id, directory: '/fixture' }));
    return { bridge: new V2EventIntegration({ sessionInfo } as unknown as V2Backend, owner), owner, sessionInfo, replace: () => { current = false; } };
}
test('execution completion reconciles while provider streamed/step ended never finalize the turn', async () => {
    const f = harness();
    f.bridge.receive(event('one', 'session.step.streamed', { assistantMessageID: 'msg_A' }));
    f.bridge.receive(event('two', 'session.step.ended', { assistantMessageID: 'msg_A' }));
    await flush(); expect(f.owner.reconcile).not.toHaveBeenCalled();
    f.bridge.receive(event('three', 'session.execution.succeeded')); await flush();
    expect(f.owner.reconcile).toHaveBeenCalledWith('ses_A', expect.objectContaining({ type: 'session.execution.succeeded' }));
});
test('duplicate live text IDs cannot append the same delta twice', async () => {
    const f = harness(), value = event('one', 'session.text.delta', { assistantMessageID: 'msg_A', ordinal: 0, delta: 'Hello' });
    f.bridge.receive(value); f.bridge.receive(value); await flush();
    expect(f.owner.text).toHaveBeenCalledTimes(1);
});
test('service replacement discards queued old events', async () => {
    const f = harness(); f.bridge.receive(event('one', 'session.execution.succeeded')); f.replace(); await flush();
    expect(f.owner.reconcile).not.toHaveBeenCalled();
});
test('different sessions make independent progress while one boundary read waits', async () => {
    const f = harness(); let release!: () => void;
    (f.owner.delivered as jest.Mock).mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
    f.bridge.receive(event('one', 'session.inbox.delivered', { inboxID: 'msg_user' }));
    f.bridge.receive(event('two', 'session.text.delta', { sessionID: 'ses_B', assistantMessageID: 'msg_B', ordinal: 0, delta: 'B' }));
    await flush(); expect(f.owner.text).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'ses_B' })); release(); await flush();
});
test('per-call tool fragments never reopen terminal state or overwrite a different call', () => {
    const started = event('one', 'session.tool.input.started', { assistantMessageID: 'msg_A', id: 'call_A', name: 'shell' });
    const first = nativeToolFragment(started, undefined)!;
    const done = nativeToolFragment(event('two', 'session.tool.success', { assistantMessageID: 'msg_A', id: 'call_A', content: [{ type: 'text', text: 'Done' }] }), first)!;
    expect(done).toMatchObject({ callID: 'call_A', state: { status: 'completed', output: 'Done' } });
    expect(nativeToolFragment(started, done)).toBeUndefined();
});
