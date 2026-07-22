import { getServerRequestPolicy, OpenCodeHttpClient, type ServerConnection } from '../transport/OpenCodeHttpClient';

function connection(port: number): ServerConnection {
    return {
        host: '127.0.0.1',
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        authHeader: `Basic auth-${port}`,
        lock: { workspaceRoot: 'C:\\workspace', port, password: `pw-${port}`, updatedAt: 'now' },
    };
}

describe('OpenCode HTTP client', () => {
    test('preserves endpoint-specific timeout and retry policy', () => {
        expect(getServerRequestPolicy('GET', '/session/s1/message?limit=10')).toEqual({
            opName: 'session.message', timeoutMs: 20000, retryOnAbort: true, retryTimeoutMs: 30000,
        });
        expect(getServerRequestPolicy('POST', '/session/s1/prompt_async')).toEqual({
            opName: 'session.post', timeoutMs: 60000, retryOnAbort: true, retryTimeoutMs: 90000,
        });
        expect(getServerRequestPolicy('POST', '/session/s1/summarize')).toEqual({
            opName: 'session.summarize', timeoutMs: 0, noTimeout: true, retryOnAbort: true,
        });
    });

    test('migrates and retries once on unauthorized responses', async () => {
        const getConnection = jest.fn(async (refresh?: boolean) => connection(refresh ? 42001 : 42000));
        const migrateUnauthorized = jest.fn(async () => undefined);
        const fetchMock = jest.fn()
            .mockResolvedValueOnce(new Response('', { status: 401 }))
            .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
        const client = new OpenCodeHttpClient({
            waitUntilReady: async () => undefined,
            getConnection,
            migrateUnauthorized,
            recoverTransport: async () => undefined,
            log: () => undefined,
            fetch: fetchMock,
        });
        await expect(client.requestJson<{ ok: boolean }>('GET', '/global/health')).resolves.toEqual({ ok: true });
        expect(migrateUnauthorized).toHaveBeenCalledWith(expect.objectContaining({ port: 42000 }));
        expect(getConnection).toHaveBeenLastCalledWith(true);
        expect(fetchMock.mock.calls[1][0]).toBe('http://127.0.0.1:42001/global/health');
        expect(new Headers(fetchMock.mock.calls[1][1].headers).get('Authorization')).toBe('Basic auth-42001');
    });

    test('recovers transport failures before the single retry', async () => {
        const recoverTransport = jest.fn(async () => undefined);
        const fetchMock = jest.fn()
            .mockRejectedValueOnce(new Error('connection refused'))
            .mockResolvedValueOnce(new Response(null, { status: 204 }));
        const client = new OpenCodeHttpClient({
            waitUntilReady: async () => undefined,
            getConnection: async () => connection(42000),
            migrateUnauthorized: async () => undefined,
            recoverTransport,
            log: () => undefined,
            fetch: fetchMock,
        });
        await expect(client.requestJson('POST', '/session/s1/abort', {})).resolves.toEqual({});
        expect(recoverTransport).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('refreshes the connection on configured abort retry without restarting the server', async () => {
        const aborted = Object.assign(new Error('timed out'), { name: 'AbortError' });
        const recoverTransport = jest.fn(async () => undefined);
        const getConnection = jest.fn(async (refresh?: boolean) => connection(refresh ? 42001 : 42000));
        const fetchMock = jest.fn()
            .mockRejectedValueOnce(aborted)
            .mockResolvedValueOnce(new Response('[]', { status: 200 }));
        const client = new OpenCodeHttpClient({
            waitUntilReady: async () => undefined,
            getConnection,
            migrateUnauthorized: async () => undefined,
            recoverTransport,
            log: () => undefined,
            fetch: fetchMock,
        });
        await expect(client.requestJson('GET', '/session/s1/message')).resolves.toEqual([]);
        expect(getConnection).toHaveBeenLastCalledWith(true);
        expect(recoverTransport).not.toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
