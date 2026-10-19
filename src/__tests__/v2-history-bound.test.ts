import { V2Backend } from '../transport/protocol/V2Backend';
import { V2Transport } from '../transport/protocol/V2Transport';
import { BackendOperationError } from '../transport/protocol/BackendContract';

test('larger response allowance is limited to single transcript records', async () => {
    const payload = JSON.stringify({ data: 'x'.repeat(9 * 1024 * 1024) });
    const transport = new V2Transport({ baseUrl: 'http://127.0.0.1:42000', authorization: 'fixture', directory: 'fixture', isCurrent: () => true },
        jest.fn(async () => new Response(payload, { headers: { 'Content-Type': 'application/json' } })) as typeof fetch);
    await expect(transport.request('GET', '/api/session/ses_A/message?limit=200')).rejects.toThrow('response bound');
    await expect(transport.request('GET', '/api/session/ses_A/message?limit=1')).resolves.toHaveProperty('data');
    await expect(transport.request('GET', '/api/session/ses_A/message/msg_A')).resolves.toHaveProperty('data');
    await expect(transport.request('GET', '/api/config?limit=1')).rejects.toThrow('response bound');
});

test('oversized transcript pages retry the same cursor with fewer records and retain the terminal suffix', async () => {
    const backend = new V2Backend({} as V2Transport);
    const messages = jest.spyOn(backend.sessions, 'messages');
    messages.mockRejectedValueOnce(new BackendOperationError('invalid_response', 'V2 response bound'));
    messages.mockResolvedValueOnce({ items: [{ id: 'msg_A' }], next: 'next' } as never);
    messages.mockRejectedValueOnce(new BackendOperationError('invalid_response', 'V2 response bound'));
    messages.mockResolvedValueOnce({ items: [{ id: 'msg_final' }, { id: 'msg_idle' }] } as never);
    expect((await backend.transcript('ses_A')).map(item => item.id)).toEqual(['msg_A', 'msg_final', 'msg_idle']);
    expect(messages.mock.calls.map(call => call[1])).toEqual([
        { limit: 200 }, { limit: 100 }, { limit: 100, cursor: 'next' }, { limit: 50, cursor: 'next' },
    ]);
});

test('single oversized records and unrelated failures fail explicitly without dropping content', async () => {
    const backend = new V2Backend({} as V2Transport);
    const messages = jest.spyOn(backend.sessions, 'messages').mockRejectedValue(new BackendOperationError('invalid_response', 'V2 response bound'));
    await expect(backend.transcript('ses_A')).rejects.toThrow('response bound');
    expect(messages.mock.calls.map(call => call[1]?.limit)).toEqual([200, 100, 50, 25, 12, 6, 3, 1]);
    messages.mockClear().mockRejectedValue(new BackendOperationError('authentication', 'GET transcript'));
    await expect(backend.transcript('ses_A')).rejects.toThrow('authentication');
    expect(messages).toHaveBeenCalledTimes(1);
});
