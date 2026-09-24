import { mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { connectNormalSupervisor } from '../NormalSupervisorConnection';
import { bridgeBearer, connectionProof, serviceAuthenticationProof, signConnectionLease, type ConnectionLease } from '../normal-connection-protocol';
import type { NormalLaunch } from '../normal-launch-protocol';
import type { ServerConnection } from '../../transport/OpenCodeHttpClient';

describe('normal supervisor service/bridge authentication', () => {
    let root = '';
    afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
    async function setup() {
        root = await realpath(await mkdtemp(join(tmpdir(), 'gui-supervisor-connect-')));
        const binding = { integrationId: '11'.repeat(32), serviceId: '22'.repeat(32), workspace: 'd:/trial', serviceOrigin: 'http://127.0.0.1:42001' };
        const authHeader = `Basic ${Buffer.from('opencode:test-only-password').toString('base64')}`;
        const launchKey = '33'.repeat(32);
        const launch: NormalLaunch = { schemaVersion: 1, kind: 'normal-gui-launch', binding, launchKey,
            identityKey: '44'.repeat(32), privateDirectory: root, authenticationProof: serviceAuthenticationProof(launchKey, binding, authHeader) };
        const lease: ConnectionLease = { schemaVersion: 1, kind: 'normal-gui', ...binding, instanceId: '55'.repeat(32),
            bridgeOrigin: 'http://127.0.0.1:54321', pluginVersion: '0.1.0', opencodeVersion: '1.18.29', issuedAt: 1000, expiresAt: 61000 };
        const service: ServerConnection = { host: '127.0.0.1', port: 42001, baseUrl: binding.serviceOrigin, authHeader,
            lock: { workspaceRoot: 'd:/trial', port: 42001, password: 'test-only-password', updatedAt: '' } };
        const signed = signConnectionLease(lease, launchKey);
        await writeFile(join(root, `${binding.serviceId}.json`), JSON.stringify(signed));
        const fetcher = jest.fn(async (url: string, options: RequestInit) => {
            expect(options.redirect).toBe('error');
            if (url === `${service.baseUrl}/global/health`) {
                expect(options.headers).toEqual({ Authorization: authHeader });
                return new Response(JSON.stringify({ version: '1.18.29' }));
            }
            expect(url.startsWith(`${lease.bridgeOrigin}/v1/identity?challenge=`)).toBe(true);
            expect(options.headers).toEqual({ Authorization: `Bearer ${bridgeBearer(launchKey, binding, lease.instanceId)}` });
            const challenge = new URL(url).searchParams.get('challenge')!;
            return new Response(JSON.stringify({ lease: signed, proof: connectionProof(launchKey, lease, challenge) }));
        });
        return { launch, lease, service, fetcher, signed };
    }

    test('connects only after exact normal service health and live bridge challenge', async () => {
        const { launch, lease, service, fetcher } = await setup();
        const connection = await connectNormalSupervisor(launch, service, new AbortController().signal, fetcher as typeof fetch, () => 1000);
        expect(connection.instanceId).toBe(lease.instanceId);
        expect(connection.serviceEndpoint).toBe(service.baseUrl);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    test('wrong instance, workspace, credentials and expired discovery fail before HTTP', async () => {
        const { launch, service, fetcher, signed } = await setup();
        for (const payload of [{ ...signed.payload, workspace: 'd:/wrong' }, { ...signed.payload, serviceId: '66'.repeat(32) }]) {
            await writeFile(join(root, `${launch.binding.serviceId}.json`), JSON.stringify({ ...signed, payload }));
            await expect(connectNormalSupervisor(launch, service, new AbortController().signal, fetcher as typeof fetch, () => 1000)).rejects.toThrow();
        }
        await writeFile(join(root, `${launch.binding.serviceId}.json`), JSON.stringify(signed));
        await expect(connectNormalSupervisor(launch, service, new AbortController().signal, fetcher as typeof fetch, () => 61000)).rejects.toThrow();
        await expect(connectNormalSupervisor(launch, { ...service, authHeader: `Basic ${Buffer.from('opencode:wrong-password').toString('base64')}` }, new AbortController().signal, fetcher as typeof fetch, () => 1000)).rejects.toThrow();
        expect(fetcher).not.toHaveBeenCalled();
    });

    test.each([401, 200])('rejects authentication failure or incompatible health: %s', async status => {
        const { launch, service } = await setup();
        const fetcher = jest.fn(async () => new Response(JSON.stringify({ version: '1.18.31' }), { status }));
        await expect(connectNormalSupervisor(launch, service, new AbortController().signal, fetcher as typeof fetch, () => 1000))
            .rejects.toThrow(status === 401 ? 'disconnected' : 'incompatible');
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test('rejects stale live challenge and oversized response', async () => {
        const { launch, lease, service, signed } = await setup();
        for (const body of [JSON.stringify({ lease: signed, proof: connectionProof(launch.launchKey, lease, '77'.repeat(32)) }), 'x'.repeat(8193)]) {
            const fetcher = jest.fn().mockResolvedValueOnce(new Response(JSON.stringify({ version: '1.18.29' })))
                .mockResolvedValueOnce(new Response(body));
            await expect(connectNormalSupervisor(launch, service, new AbortController().signal, fetcher as typeof fetch, () => 1000)).rejects.toThrow();
        }
    });
});
