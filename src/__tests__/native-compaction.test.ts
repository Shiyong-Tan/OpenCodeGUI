import { NativeCompaction } from '../transport/protocol/NativeCompaction';
import type { ProtocolBinding } from '../transport/protocol/ProtocolConnectionOwner';
import type { BackendEvent } from '../transport/protocol/V2EventAdapter';

function harness() {
    const cancellation = new AbortController();
    const compact = jest.fn(async (_sessionId: string, _id: string, _delivery: string) => undefined);
    const binding = { native: { controls: { compact }, transport: { connection: { signal: cancellation.signal } } }, isCurrent: () => !cancellation.signal.aborted } as unknown as ProtocolBinding;
    const owner = new NativeCompaction(() => binding, 1000);
    const event = (sessionId: string, type: string, inputID?: string) => owner.observe({ sessionId, type, payload: { reason: 'manual', inputID } } as unknown as BackendEvent);
    return { owner, compact, cancellation, event };
}
test('native compaction requires its own started identity and same-session completion', async () => {
    const { owner, compact, event } = harness();
    const pending = owner.run('ses_A'); let done = false; void pending.then(() => { done = true; });
    const id = compact.mock.calls[0]?.[1];
    event('ses_A', 'session.compaction.ended');
    event('ses_A', 'session.compaction.started', 'msg_foreign');
    event('ses_A', 'session.compaction.ended'); await Promise.resolve(); expect(done).toBe(false);
    event('ses_A', 'session.compaction.started', id);
    event('ses_B', 'session.compaction.ended'); await Promise.resolve(); expect(done).toBe(false);
    event('ses_A', 'session.compaction.ended'); await pending;
    expect(compact).toHaveBeenCalledTimes(1);
});
test('native compaction is cancelled when its captured service binding changes', async () => {
    const { owner, cancellation } = harness();
    const pending = owner.run('ses_A'); cancellation.abort();
    await expect(pending).rejects.toThrow('superseded');
});
test('native compaction timeout remains ambiguous and never retries admission', async () => {
    jest.useFakeTimers();
    try {
        const { owner, compact } = harness(); const pending = owner.run('ses_A');
        const rejection = expect(pending).rejects.toThrow('ambiguous');
        await jest.advanceTimersByTimeAsync(1001); await rejection;
        expect(compact).toHaveBeenCalledTimes(1);
    } finally { jest.useRealTimers(); }
});
