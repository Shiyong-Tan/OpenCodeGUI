import { resolve } from 'path';
import { parseIsolatedSupervisorConnection } from '../IsolatedSupervisorConnection';
import { SupervisorReader } from '../SupervisorReader';

const descriptor = () => ({ schemaVersion: 1, isolationId: 'lab_A', instanceId: 'instance_A',
    workspace: resolve('isolated/work'), openCodeVersion: '1.18.29', pluginVersion: '0.1.0',
    service: { endpoint: 'http://127.0.0.1:40001', authorization: 'Basic dGVzdA==' },
    bridge: { endpoint: 'http://127.0.0.1:40002', token: 'a'.repeat(64) } });

test.each(['1.18.29', '1.18.31'])('descriptor and snapshot preserve matching version %s', async version => {
    const connection = parseIsolatedSupervisorConnection({ ...descriptor(), openCodeVersion: version });
    const reader = new SupervisorReader(connection, (async () => Response.json({ ...view(), openCodeVersion: version })) as typeof fetch);
    try {
        const result = await reader.read('ses_A');
        expect(result.status).toBe('observed');
        if (result.status === 'observed') expect(result.view.openCodeVersion).toBe(version);
    } finally { reader.dispose(); }
});

test('reader rejects a snapshot from another supported version', async () => {
    const connection = parseIsolatedSupervisorConnection({ ...descriptor(), openCodeVersion: '1.18.31' });
    const reader = new SupervisorReader(connection, (async () => Response.json(view())) as typeof fetch);
    try { expect(await reader.read('ses_A')).toEqual({ status: 'unavailable', reason: 'read_failed' }); }
    finally { reader.dispose(); }
});

test.each(['1.18.30', '1.18.32', '2.0.0', '1.18.31-beta', null, 11831])('descriptor refuses unaudited version %s', version => {
    expect(() => parseIsolatedSupervisorConnection({ ...descriptor(), openCodeVersion: version })).toThrow('version');
});
const view = (parent = 'ses_A', revision = 1) => ({ schemaVersion: 1, isolationId: 'lab_A', instanceId: 'instance_A',
    revision, pluginVersion: '0.1.0', openCodeVersion: '1.18.29', observedAt: '2026-09-18T00:00:00.000Z',
    parentSessionId: parent, scope: 'isolated_allowlisted_commands', tasks: [], executions: [], notifications: [], notificationIdentities: [] });

describe('isolated supervisor read boundary', () => {
    test('rejects remote origins, service reuse and unsupported versions without disclosing authentication', () => {
        expect(() => parseIsolatedSupervisorConnection({ ...descriptor(), schemaVersion: 2 })).toThrow();
        expect(() => parseIsolatedSupervisorConnection({ ...descriptor(), bridge: { endpoint: 'https://example.test', token: 'a'.repeat(64) } })).toThrow();
        expect(() => parseIsolatedSupervisorConnection({ ...descriptor(), bridge: { endpoint: 'http://127.0.0.1:40001', token: 'a'.repeat(64) } })).toThrow();
        expect(() => parseIsolatedSupervisorConnection({ ...descriptor(), service: { endpoint: 'http://secret@127.0.0.1:40001', authorization: 'Basic dGVzdA==' } })).toThrow();
    });

    test('scopes reads, strips undeclared data and rejects stale or foreign responses', async () => {
        let payload: unknown = { ...view(), token: 'must-not-reach-webview' };
        const fetcher = jest.fn(async () => Response.json(payload));
        const reader = new SupervisorReader(parseIsolatedSupervisorConnection(descriptor()), fetcher as typeof fetch, () => 100000);
        const result = await reader.read('ses_A');
        expect(result.status).toBe('observed');
        expect(JSON.stringify(result)).not.toContain('must-not-reach-webview');
        const request = fetcher.mock.calls[0] as unknown as [string, RequestInit];
        expect(request[0]).toBe('http://127.0.0.1:40002/v1/snapshot?parentSessionId=ses_A');
        expect(request[1].redirect).toBe('error');
        payload = view('ses_A', 0);
        expect((await reader.read('ses_A')).status).toBe('unavailable');
        payload = view('ses_A');
        expect((await reader.read('ses_B')).status).toBe('unavailable');
        reader.dispose();
        expect(await reader.read('ses_A')).toEqual({ status: 'unavailable', reason: 'disposed' });
    });

    test('authentication failure backs off and an instance restart never reuses the old cursor', async () => {
        let time = 0;
        let response = new Response('', { status: 401 });
        const fetcher = jest.fn(async () => response.clone());
        const reader = new SupervisorReader(parseIsolatedSupervisorConnection(descriptor()), fetcher as typeof fetch, () => time);
        expect((await reader.read('ses_A')).status).toBe('unavailable');
        expect(await reader.read('ses_A')).toEqual({ status: 'unavailable', reason: 'backoff' });
        expect(fetcher).toHaveBeenCalledTimes(1);
        time = 1001;
        response = Response.json({ ...view(), instanceId: 'instance_B' });
        expect((await reader.read('ses_A')).status).toBe('unavailable');
        reader.dispose();
    });

    test('controlled deadline bounds waits while retaining capacity for fetches that ignore abort', async () => {
        jest.useFakeTimers();
        const pending: Array<(value: Response) => void> = [];
        const fetcher = jest.fn(() => new Promise<Response>(resolve => pending.push(resolve)));
        const reader = new SupervisorReader(parseIsolatedSupervisorConnection(descriptor()), fetcher as typeof fetch);
        try {
            const a = reader.read('ses_A'), b = reader.read('ses_B');
            expect(await reader.read('ses_C')).toEqual({ status: 'unavailable', reason: 'busy' });
            await jest.advanceTimersByTimeAsync(2501);
            expect((await a).status).toBe('unavailable');
            expect((await b).status).toBe('unavailable');
            expect(await reader.read('ses_C')).toEqual({ status: 'unavailable', reason: 'busy' });
            reader.dispose();
            pending[0](Response.json(view('ses_A'))); pending[1](Response.json(view('ses_B')));
            await jest.runAllTimersAsync();
        } finally { reader.dispose(); jest.useRealTimers(); }
    });
});
