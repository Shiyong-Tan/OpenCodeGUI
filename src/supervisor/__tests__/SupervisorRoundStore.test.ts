import { SupervisorRoundStore, type ParentExecution, type SupervisorRoundStorage } from '../SupervisorRoundStore';
import type { NotificationIdentity } from '../notification-identity-protocol';
const notice = (suffix = 'a', parentSessionId = 'ses_a'): NotificationIdentity => ({ schemaVersion: 1,
    isolationId: 'lab', instanceId: 'instance', taskId: `task_${suffix}`, attemptId: `attempt_${suffix}`,
    parentSessionId, childSessionId: `ses_child_${suffix}`, notificationId: `notice_${suffix}`, eventId: `event_${suffix}`, messageId: `msg_notice_${suffix}` });
function fixture() {
    const disk = new Map<string, unknown>();
    const storage: SupervisorRoundStorage = { read: async id => structuredClone(disk.get(id)), write: jest.fn(async (id, data) => { disk.set(id, structuredClone(data)); }) };
    const store = new SupervisorRoundStore('lab', storage);
    const observe = (source = notice(), assistantMessageId = 'msg_first', observedAt = 100, parent: ParentExecution = { kind: 'terminal' }) => store.observeActivity({ source, assistantMessageId, observedAt, parent });
    return { disk, storage, store, observe };
}
test('submission alone creates no round; actual observation fixes the timing origin', async () => {
    const f = fixture();
    expect(await f.store.list('ses_a')).toEqual([]);
    const result = await f.observe();
    expect(result).toMatchObject({ disposition: 'start', round: { roundId: 'msg_first', startedAt: 100, timingBasis: 'first-observed-activity', kind: 'independent' } });
    expect(await f.observe(notice(), 'msg_first', 500, { kind: 'active', executionId: 'msg_first' })).toMatchObject({ disposition: 'duplicate', round: { startedAt: 100 } });
});
test('multiple notices in the same execution share one independently owned round', async () => {
    const f = fixture(); await f.observe();
    await f.observe(notice('b'), 'msg_second', 300, { kind: 'active', executionId: 'msg_first' });
    const rounds = await f.store.list('ses_a');
    expect(rounds).toHaveLength(1);
    expect(rounds[0].sources.map(s => s.notificationId)).toEqual(['notice_a', 'notice_b']);
    expect(rounds[0].assistantMessageIds).toEqual(['msg_first', 'msg_second']);
    expect(rounds[0].startedAt).toBe(100);
});
test('active parent joins its canonical execution without starting an independent turn', async () => {
    const f = fixture();
    expect(await f.observe(notice(), 'msg_first', 200, { kind: 'active', executionId: 'user_turn' })).toMatchObject({ disposition: 'join', round: { kind: 'existing-turn', executionId: 'user_turn' } });
    expect(await f.observe(notice('b'), 'msg_second', 300, { kind: 'active', executionId: 'user_turn' })).toMatchObject({ disposition: 'join' });
    expect(await f.store.list('ses_a')).toHaveLength(1);
});
test('final, timestamp and source identity remain immutable after duplicate/late events and reload', async () => {
    const f = fixture(); await f.observe();
    await f.store.finish('ses_a', 'msg_first', 'msg_first', 400);
    const before = await f.store.list('ses_a');
    await f.store.finish('ses_a', 'msg_first', 'msg_first', 900);
    const reloaded = new SupervisorRoundStore('lab', f.storage);
    expect(await reloaded.observeActivity({ source: notice(), assistantMessageId: 'msg_late', observedAt: 1000, parent: { kind: 'terminal' } })).toMatchObject({ disposition: 'retired' });
    expect(await reloaded.list('ses_a')).toEqual(before);
    await f.observe(notice('b'), 'msg_new', 1100);
    expect((await f.store.list('ses_a'))[0]).toEqual(before[0]);
});
test('sessions stay isolated and returned projections cannot mutate canonical provenance', async () => {
    const f = fixture();
    await Promise.all([f.observe(), f.observe(notice('b', 'ses_b'), 'msg_b', 101)]);
    const result = await f.store.list('ses_a'); result[0].sources.length = 0;
    expect((await f.store.list('ses_a'))[0].sources).toHaveLength(1);
    expect((await f.store.list('ses_b'))[0].sessionId).toBe('ses_b');
});
test('storage failure does not publish a phantom round or consume its identity', async () => {
    const f = fixture();
    (f.storage.write as jest.Mock).mockRejectedValueOnce(new Error('disk failure'));
    await expect(f.observe()).rejects.toThrow('disk failure');
    expect(await f.store.list('ses_a')).toEqual([]);
    expect((await f.observe()).disposition).toBe('start');
});
test('foreign/corrupt storage and conflicting notification identities fail closed', async () => {
    const f = fixture(); await f.observe();
    await expect(f.observe({ ...notice(), attemptId: 'another' }, 'msg_first', 200, { kind: 'active', executionId: 'msg_first' })).rejects.toThrow();
    await expect(new SupervisorRoundStore('foreign', f.storage).list('ses_a')).rejects.toThrow();
    const stored = f.disk.get('ses_a') as {rounds: unknown[]}; stored.rounds.push({});
    await expect(new SupervisorRoundStore('lab', f.storage).list('ses_a')).rejects.toThrow();
});
test('late activity from an old execution cannot attach to the current execution', async () => {
    const f = fixture(); await f.observe();
    const before = await f.store.list('ses_a');
    expect(await f.observe(notice(), 'msg_late', 800, { kind: 'active', executionId: 'new_user_turn' })).toMatchObject({ disposition: 'retired' });
    expect(await f.store.list('ses_a')).toEqual(before);
});

test('unfinished durable provenance after reload does not invent a new generation', async () => {
    const f = fixture(); await f.observe();
    const reloaded = new SupervisorRoundStore('lab', f.storage);
    expect(await reloaded.observeActivity({ source: notice(), assistantMessageId: 'msg_later', observedAt: 900,
        parent: { kind: 'terminal' } })).toMatchObject({ disposition: 'unresolved', round: { startedAt: 100 } });
    expect(await reloaded.list('ses_a')).toEqual(await f.store.list('ses_a'));
});
