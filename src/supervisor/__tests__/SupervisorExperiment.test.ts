import { resolve } from 'path';
import { SupervisorExperiment } from '../SupervisorExperiment';
import { parseIsolatedSupervisorConnection } from '../IsolatedSupervisorConnection';
import { OpenCodeHttpClient } from '../../transport/OpenCodeHttpClient';

const connection = () => parseIsolatedSupervisorConnection({ schemaVersion: 1, isolationId: 'lab_A', instanceId: 'instance_A',
    workspace: resolve('isolated/work'), openCodeVersion: '1.18.29', pluginVersion: '0.1.0',
    service: { endpoint: 'http://127.0.0.1:40001', authorization: 'Basic dGVzdA==' },
    bridge: { endpoint: 'http://127.0.0.1:40002', token: 'a'.repeat(64) } });

test('isolated attach verifies actual version and rejects instance changes without launching or migrating', async () => {
    let descriptor = connection();
    const load = jest.fn(async () => descriptor);
    const fetcher = jest.fn(async () => Response.json({ version: '1.18.29' }));
    const runtime = new SupervisorExperiment(resolve('isolated/state/supervisor/connection.json'), load, fetcher as typeof fetch);
    await runtime.ensure(descriptor.workspace);
    expect(runtime.serverConnection().isolatedSupervisor).toBe(true);
    expect(runtime.serverConnection().lock.password).toBe('');
    descriptor = { ...descriptor, instanceId: 'new_instance' };
    await expect(runtime.ensure(descriptor.workspace)).rejects.toThrow('instance changed');
    expect(fetcher).toHaveBeenCalledTimes(1);
    runtime.dispose();
    await expect(runtime.ensure(descriptor.workspace)).rejects.toThrow('disposed');
});

test('wrong service version and missing descriptor fail without a fallback connection', async () => {
    const descriptor = connection();
    const runtime = new SupervisorExperiment(resolve('isolated/state/supervisor/connection.json'), async () => descriptor,
        (async () => Response.json({ version: '1.18.31' })) as typeof fetch);
    await expect(runtime.ensure(descriptor.workspace)).rejects.toThrow('version mismatch');
    expect(() => runtime.serverConnection()).toThrow('unavailable');
    const missing = new SupervisorExperiment('missing', async () => { throw new Error('missing descriptor'); });
    await expect(missing.ensure(descriptor.workspace)).rejects.toThrow('missing descriptor');
    expect(() => missing.serverConnection()).toThrow('unavailable');
    runtime.dispose(); missing.dispose();
});

test('isolated authentication failure never enters workspace lock migration', async () => {
    const descriptor = connection();
    const runtime = new SupervisorExperiment(resolve('isolated/state/supervisor/connection.json'), async () => descriptor,
        (async () => Response.json({ version: '1.18.29' })) as typeof fetch);
    await runtime.ensure(descriptor.workspace);
    const migrate = jest.fn(), recover = jest.fn();
    const client = new OpenCodeHttpClient({ waitUntilReady: async () => undefined,
        getConnection: async () => runtime.serverConnection(), migrateUnauthorized: migrate,
        recoverTransport: recover, log: () => undefined, fetch: async () => new Response('', { status: 401 }) });
    expect((await client.fetch('/session')).status).toBe(401);
    expect(migrate).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled();
    runtime.dispose();
});
