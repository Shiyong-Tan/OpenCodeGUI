import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { NormalSupervisorIntegration } from '../NormalSupervisorIntegration';
import { connectionProof, serviceAuthenticationProof, signConnectionLease, type ConnectionLease } from '../normal-connection-protocol';
import { normalIdentityCodec } from '../normal-identity-protocol';
import type { NormalLaunch } from '../normal-launch-protocol';
import type { ServerConnection } from '../../transport/OpenCodeHttpClient';
import type { NotificationIdentity } from '../notification-identity-protocol';

describe('normal supervisor enable and durable classification boundary', () => {
    let root = '';
    afterEach(async () => { jest.useRealTimers(); if (root) await rm(root, { recursive: true, force: true }); });
    async function setup() {
        root = await realpath(await mkdtemp(join(tmpdir(), 'gui-normal-supervisor-')));
        await mkdir(join(root, 'identities'));
        const binding = { integrationId: '11'.repeat(32), serviceId: '22'.repeat(32), workspace: 'd:/trial', serviceOrigin: 'http://127.0.0.1:42001' };
        const authHeader = `Basic ${Buffer.from('opencode:test-only').toString('base64')}`;
        const launchKey = '33'.repeat(32);
        const launch: NormalLaunch = { schemaVersion: 1, kind: 'normal-gui-launch', binding, launchKey,
            identityKey: '44'.repeat(32), privateDirectory: root, authenticationProof: serviceAuthenticationProof(launchKey, binding, authHeader) };
        const lease: ConnectionLease = { schemaVersion: 1, kind: 'normal-gui', ...binding, instanceId: '55'.repeat(32),
            bridgeOrigin: 'http://127.0.0.1:54321', pluginVersion: '0.1.0', opencodeVersion: '1.18.29', issuedAt: 1000, expiresAt: 61000 };
        const service: ServerConnection = { host: '127.0.0.1', port: 42001, baseUrl: binding.serviceOrigin, authHeader,
            lock: { workspaceRoot: 'd:/trial', port: 42001, password: 'test-only', updatedAt: '' } };
        const signed = signConnectionLease(lease, launchKey);
        await writeFile(join(root, `${binding.serviceId}.json`), JSON.stringify(signed));
        const fetcher = jest.fn(async (url: string) => {
            if (url.endsWith('/global/health')) return new Response(JSON.stringify({ version: '1.18.29' }));
            const parsed = new URL(url);
            if (parsed.pathname === '/v1/identity') return new Response(JSON.stringify({ lease: signed,
                proof: connectionProof(launchKey, lease, parsed.searchParams.get('challenge')!) }));
            return new Response(JSON.stringify({ schemaVersion: 2, kind: 'normal-gui-view', integrationId: binding.integrationId,
                serviceId: binding.serviceId, scope: 'registered_tasks_only', instanceId: lease.instanceId,
                revision: 1, pluginVersion: '0.1.0', openCodeVersion: '1.18.29', observedAt: new Date(1000).toISOString(),
                parentSessionId: parsed.searchParams.get('parentSessionId'), tasks: [], executions: [], notifications: [], notificationIdentities: [] }));
        });
        const store = { forConnection: jest.fn(async () => launch) };
        const owner = new NormalSupervisorIntegration(store, async () => service, fetcher as typeof fetch, () => 1000);
        return { owner, store, fetcher, launch };
    }

    test('default off performs no network reads; disabling preserves signed history classification', async () => {
        const { owner, fetcher, launch } = await setup();
        expect(owner.status()).toBe('disabled');
        expect((await owner.read('ses_A')).status).toBe('unavailable');
        expect(fetcher).not.toHaveBeenCalled();
        const identity: NotificationIdentity = { schemaVersion: 1, isolationId: launch.binding.integrationId,
            instanceId: 'old-instance', taskId: 'task_1', attemptId: 'attempt_1', parentSessionId: 'ses_A', childSessionId: 'ses_child',
            notificationId: 'notice_1', eventId: 'event_1', messageId: 'msg_notice' };
        await writeFile(join(root, 'identities', 'msg_notice.json'), JSON.stringify(normalIdentityCodec(launch.binding.integrationId, launch.identityKey).encode(identity)));
        owner.setEnabled(true);
        expect((await owner.read('ses_A')).status).toBe('observed');
        expect(owner.status()).toBe('connected');
        owner.setEnabled(false);
        const calls = fetcher.mock.calls.length;
        expect(await owner.lookupNotification('ses_A', 'msg_notice')).toEqual(identity);
        expect(await owner.lookupNotification('ses_B', 'msg_notice')).toBeUndefined();
        expect(await owner.lookupNotification('ses_A', 'msg_real_user')).toBeUndefined();
        expect((await owner.read('ses_A')).status).toBe('unavailable');
        expect(fetcher).toHaveBeenCalledTimes(calls);
        expect(owner.status()).toBe('disabled');
        owner.dispose();
        expect(owner.knownNotification('ses_A', 'msg_notice')).toBeUndefined();
    });

    test('live disable cannot downgrade an in-flight signed classification to a user message', async () => {
        const { owner, store, launch, fetcher } = await setup();
        const identity: NotificationIdentity = { schemaVersion: 1, isolationId: launch.binding.integrationId,
            instanceId: 'old-instance', taskId: 'task_1', attemptId: 'attempt_1', parentSessionId: 'ses_A', childSessionId: 'ses_child',
            notificationId: 'notice_1', eventId: 'event_1', messageId: 'msg_notice' };
        await writeFile(join(root, 'identities', 'msg_notice.json'), JSON.stringify(normalIdentityCodec(launch.binding.integrationId, launch.identityKey).encode(identity)));
        let release!: (value: NormalLaunch) => void;
        store.forConnection.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        owner.setEnabled(true);
        const classifying = owner.lookupNotification('ses_A', 'msg_notice');
        await Promise.resolve(); await Promise.resolve();
        owner.setEnabled(false);
        release(launch);
        expect(await classifying).toEqual(identity);
        expect(fetcher).not.toHaveBeenCalled();
        owner.dispose();
    });

    test('disable fences a late handshake before reader creation', async () => {
        const { owner, store, launch, fetcher } = await setup();
        let release!: (value: NormalLaunch) => void;
        store.forConnection.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        owner.setEnabled(true);
        const reading = owner.read('ses_A');
        await Promise.resolve(); await Promise.resolve();
        owner.setEnabled(false);
        release(launch);
        expect((await reading).status).toBe('unavailable');
        expect(owner.status()).toBe('disabled');
        expect(fetcher).not.toHaveBeenCalled();
        owner.dispose();
    });

    test('bounded metadata failure does not create additional subscriptions or retry loops', async () => {
        const { owner, store, fetcher } = await setup();
        jest.useFakeTimers();
        store.forConnection.mockImplementation(() => new Promise(() => undefined));
        owner.setEnabled(true);
        const reading = owner.read('ses_A');
        await jest.advanceTimersByTimeAsync(2500);
        expect((await reading).status).toBe('unavailable');
        expect(owner.status()).toBe('disconnected');
        expect((await owner.read('ses_A')).status).toBe('unavailable');
        expect(store.forConnection).toHaveBeenCalledTimes(1);
        owner.dispose();
        await jest.advanceTimersByTimeAsync(10000);
        expect(fetcher).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
    });
});
