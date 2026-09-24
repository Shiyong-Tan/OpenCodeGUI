import { SupervisorNotificationIngress } from '../SupervisorNotificationIngress';
import type { NotificationIdentity } from '../notification-identity-protocol';

const notice: NotificationIdentity = { schemaVersion: 1, isolationId: 'lab', instanceId: 'instance', taskId: 'task', attemptId: 'attempt',
    parentSessionId: 'ses_A', childSessionId: 'ses_child', notificationId: 'notice', eventId: 'event', messageId: 'msg_notice' };
test('async identity checks preserve A order without delaying B; exact internal ID does not hide assistant or same-text user', async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const seen: string[] = [];
    const ingress = new SupervisorNotificationIngress(async (session, id) => {
        if (id === 'msg_notice') { await wait; return session === 'ses_A' ? notice : undefined; }
        return undefined;
    }, jest.fn());
    const one = ingress.route('ses_A', 'msg_notice', () => { seen.push('internal'); });
    const two = ingress.route('ses_A', 'msg_assistant', () => { seen.push('assistant'); });
    await ingress.route('ses_B', 'msg_user_same_text', () => { seen.push('user'); });
    expect(seen).toEqual(['user']);
    release(); await Promise.all([one, two]);
    expect(seen).toEqual(['user', 'assistant']);
    ingress.dispose();
});

test('lookup failure blocks only its owner and does not downgrade unverified internal text to user input', async () => {
    const blocked = jest.fn(), forward = jest.fn();
    const ingress = new SupervisorNotificationIngress(async session => { if (session === 'ses_A') throw new Error('unavailable'); return undefined; }, blocked);
    await ingress.route('ses_A', 'msg_notice', forward);
    await ingress.route('ses_A', 'msg_later', forward);
    expect(forward).not.toHaveBeenCalled(); expect(blocked).toHaveBeenCalledTimes(1);
    await ingress.route('ses_B', 'msg_user', forward); expect(forward).toHaveBeenCalledTimes(1);
    ingress.dispose();
});

test('dispose fences pending reads and overflow is explicit and bounded', async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const blocked = jest.fn(), forward = jest.fn();
    const ingress = new SupervisorNotificationIngress(async () => { await wait; return undefined; }, blocked);
    const tasks = Array.from({ length: 513 }, () => ingress.route('ses_A', 'msg_user', forward));
    expect(blocked).toHaveBeenCalledWith('ses_A');
    ingress.dispose(); release(); await Promise.all(tasks);
    expect(forward).not.toHaveBeenCalled();
});

test('a hung identity read has a deadline and its late result cannot forward an event', async () => {
    jest.useFakeTimers();
    let release!: (value: undefined) => void;
    const blocked = jest.fn(), forward = jest.fn();
    const ingress = new SupervisorNotificationIngress(() => new Promise(resolve => { release = resolve; }), blocked);
    try {
        const pending = ingress.route('ses_A', 'msg_notice', forward);
        await jest.advanceTimersByTimeAsync(2501);
        await pending;
        expect(blocked).toHaveBeenCalledWith('ses_A');
        release(undefined); await Promise.resolve();
        expect(forward).not.toHaveBeenCalled();
    } finally { ingress.dispose(); jest.useRealTimers(); }
});

test('normal mode quarantines one failed classification without blocking later ordinary messages', async () => {
    const forward = jest.fn(), blocked = jest.fn();
    const ingress = new SupervisorNotificationIngress(async (_session, id) => {
        if (id === 'msg_uncertain') throw new Error('unavailable');
        if (id === 'msg_notice') return notice;
        return undefined;
    }, blocked, false);
    await ingress.route('ses_A', 'msg_uncertain', forward);
    await ingress.route('ses_A', 'msg_notice', forward);
    expect(forward).not.toHaveBeenCalled();
    await ingress.route('ses_A', 'msg_real_user', forward);
    expect(forward).toHaveBeenCalledTimes(1);
    expect(blocked).toHaveBeenCalledTimes(1);
    ingress.dispose();
});
