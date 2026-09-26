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
    async function setup(version: string = '1.18.29', pluginVersion: '0.1.0' | '0.1.1' = '0.1.0') {
        root = await realpath(await mkdtemp(join(tmpdir(), 'gui-supervisor-connect-')));
        const binding = { integrationId: '11'.repeat(32), serviceId: '22'.repeat(32), workspace: 'd:/trial', serviceOrigin: 'http://127.0.0.1:42001' };
        const authHeader = `Basic ${Buffer.from('opencode:test-only-password').toString('base64')}`;
        const launchKey = '33'.repeat(32);
        const launch: NormalLaunch = { schemaVersion: 1, kind: 'normal-gui-launch', binding, launchKey,
            identityKey: '44'.repeat(32), privateDirectory: root, authenticationProof: serviceAuthenticationProof(launchKey, binding, authHeader) };
        const lease: ConnectionLease = { schemaVersion: 1, kind: 'normal-gui', ...binding, instanceId: '55'.repeat(32),
            bridgeOrigin: 'http://127.0.0.1:54321', pluginVersion, opencodeVersion: version, issuedAt: 1000, expiresAt: 61000 };
        const service: ServerConnection = { host: '127.0.0.1', port: 42001, baseUrl: binding.serviceOrigin, authHeader,
            lock: { workspaceRoot: 'd:/trial', port: 42001, password: 'test-only-password', updatedAt: '' } };
        const signed = signConnectionLease(lease, launchKey);
        await writeFile(join(root, `${binding.serviceId}.json`), JSON.stringify(signed));
        const fetcher = jest.fn(async (url: string, options: RequestInit) => {
            expect(options.redirect).toBe('error');
            if (url === `${service.baseUrl}/global/health`) {
                expect(options.headers).toEqual({ Authorization: authHeader });
                return new Response(JSON.stringify({ version }));
            }
            expect(url.startsWith(`${lease.bridgeOrigin}/v1/identity?challenge=`)).toBe(true);
            expect(options.headers).toEqual({ Authorization: `Bearer ${bridgeBearer(launchKey, binding, lease.instanceId)}` });
            const challenge = new URL(url).searchParams.get('challenge')!;
            return new Response(JSON.stringify({ lease: signed, proof: connectionProof(launchKey, lease, challenge) }));
        });
        return { launch, lease, service, fetcher, signed };
    }

    test.each(['1.18.29', '1.18.31', '1.18.32', '2.0.0', '2.1.0-beta+build.7'] as const)('connects with matching authenticated version %s', async version => {
        const { launch, lease, service, fetcher } = await setup(version);
        const connection = await connectNormalSupervisor(launch, service, new AbortController().signal, fetcher as typeof fetch, () => 1000);
        expect(connection.openCodeVersion).toBe(version);
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

    test.each(['1.18.32', '2.0.0', null, undefined])('rejects mismatched or malformed health %s before bridge access', async version => {
        const { launch, service } = await setup('1.18.31');
        const fetcher = jest.fn(async () => Response.json({ version }));
        await expect(connectNormalSupervisor(launch, service, new AbortController().signal, fetcher as typeof fetch, () => 1000))
            .rejects.toThrow('incompatible');
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    test('rejects a live signed lease that changes to another release', async () => {
        const { launch, lease, service } = await setup('1.18.31');
        const changed = { ...lease, opencodeVersion: '1.18.29' as const };
        const fetcher = jest.fn(async (url: string) => {
            if (url.endsWith('/global/health')) return Response.json({ version: '1.18.31' });
            const challenge = new URL(url).searchParams.get('challenge')!;
            return Response.json({ lease: signConnectionLease(changed, launch.launchKey),
                proof: connectionProof(launch.launchKey, changed, challenge) });
        });
        await expect(connectNormalSupervisor(launch, service, new AbortController().signal, fetcher as typeof fetch, () => 1000))
            .rejects.toThrow('disconnected');
    });
    test('preserves the authenticated 0.1.1 plugin version', async () => {
        const { launch, service, fetcher } = await setup('1.18.31', '0.1.1');
        const connection = await connectNormalSupervisor(launch, service, new AbortController().signal, fetcher as typeof fetch, () => 1000);
        expect(connection.pluginVersion).toBe('0.1.1');
    });
});
