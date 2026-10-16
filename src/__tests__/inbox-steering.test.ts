import { InboxSteering } from '../transport/protocol/InboxSteering';
import { BackendOperationError } from '../transport/protocol/BackendContract';
import type { ProtocolBinding } from '../transport/protocol/ProtocolConnectionOwner';

function harness() {
    let current = true;
    const sessions = { inbox: jest.fn(async (_id: string): Promise<unknown[]> => [{ id: 'msg_Q', sessionId: 'ses_A', kind: 'user', delivery: 'queue' }]),
        changeDelivery: jest.fn(async () => undefined) };
    const binding = { generation: 4, isCurrent: () => current, native: { sessions } } as unknown as ProtocolBinding;
    return { service: new InboxSteering(async () => binding), sessions, replace: () => { current = false; } };
}
const input = { sessionId: 'ses_A', inboxId: 'msg_Q', generation: 4 };
test('double click patches the original inbox once without dispatching any prompt', async () => {
    const f = harness(); await Promise.all([f.service.steer(input), f.service.steer(input)]);
    expect(f.sessions.changeDelivery).toHaveBeenCalledTimes(1);
    expect(f.sessions.changeDelivery).toHaveBeenCalledWith('ses_A', 'msg_Q', 'steer');
});
test('stale generation is refused before reading or changing a queue', async () => {
    const f = harness(); await expect(f.service.steer({ ...input, generation: 3 })).rejects.toMatchObject({ reason: 'superseded' });
    expect(f.sessions.inbox).not.toHaveBeenCalled();
});
test('delivery racing with a click is not mistaken for permission to resend', async () => {
    const f = harness(); f.sessions.inbox.mockResolvedValueOnce([]);
    await expect(f.service.steer(input)).resolves.toEqual({ delivery: 'unknown', canSteer: false });
    expect(f.sessions.changeDelivery).not.toHaveBeenCalled();
});
test.each(['ambiguous', 'conflict'] as const)('a %s response rechecks the durable inbox instead of retrying PATCH', async reason => {
    const f = harness(); f.sessions.changeDelivery.mockRejectedValueOnce(new BackendOperationError(reason, 'fixture'));
    f.sessions.inbox.mockResolvedValueOnce([{ id: 'msg_Q', kind: 'user', delivery: 'queue' }]).mockResolvedValueOnce([{ id: 'msg_Q', kind: 'user', delivery: 'steer' }]);
    await expect(f.service.steer(input)).resolves.toEqual({ delivery: 'steer', canSteer: false });
    expect(f.sessions.changeDelivery).toHaveBeenCalledTimes(1);
});
test('service replacement after pending read prevents an old operation from changing the new service', async () => {
    const f = harness(); f.sessions.inbox.mockImplementationOnce(async () => { f.replace(); return [{ id: 'msg_Q', kind: 'user', delivery: 'queue' }]; });
    await expect(f.service.steer(input)).rejects.toMatchObject({ reason: 'superseded' });
    expect(f.sessions.changeDelivery).not.toHaveBeenCalled();
});
