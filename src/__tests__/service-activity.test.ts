import { queryServiceActivity } from '../transport/ServiceActivity';
import type { ServerConnection } from '../transport/OpenCodeHttpClient';

const connection: ServerConnection = { host: '127.0.0.1', port: 42000, baseUrl: 'http://127.0.0.1:42000', authHeader: 'Basic fixture',
    lock: { workspaceRoot: 'C:\\trial', port: 42000, password: 'fixture', updatedAt: 'now' } };

test.each([
    [{}, [], 'idle'], [{ a: { type: 'idle' } }, [], 'idle'],
    [{ a: { type: 'busy' } }, [], 'active'], [{ a: { type: 'retry' } }, [], 'active'],
    [{}, [{ id: 'permission' }], 'active'],
])('activity accounts for model execution, retries and permission waits', async (statuses, permissions, expected) => {
    const fetcher = jest.fn(async (url: string | URL | Request) => Response.json(String(url).endsWith('/permission') ? permissions : statuses));
    await expect(queryServiceActivity(connection, fetcher)).resolves.toBe(expected);
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([connection.baseUrl + '/session/status', connection.baseUrl + '/permission']);
});

test.each([null, [], { a: { type: 'unknown' } }, { a: null }])('unrecognized activity is never treated as idle', async statuses => {
    const fetcher = async (url: string | URL | Request) => Response.json(String(url).endsWith('/permission') ? [] : statuses);
    await expect(queryServiceActivity(connection, fetcher)).rejects.toMatchObject({ reason: 'activity_unknown' });
});

test('HTTP failure and oversized activity replies conservatively refuse an operation', async () => {
    for (const response of [new Response(null, { status: 401 }), new Response('x'.repeat(131073))]) {
        await expect(queryServiceActivity(connection, async () => response.clone())).rejects.toMatchObject({ reason: 'activity_unknown' });
    }
});
