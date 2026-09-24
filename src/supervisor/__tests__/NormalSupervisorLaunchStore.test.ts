import { mkdtemp, rm, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { NormalSupervisorLaunchStore } from '../NormalSupervisorLaunchStore';
import type { ServerConnection } from '../../transport/OpenCodeHttpClient';

describe('normal supervisor private launch metadata', () => {
    let root = '';
    afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

    test('fresh launch rotates service keys while retaining durable identity in private storage only', async () => {
        root = await mkdtemp(join(tmpdir(), 'gui-supervisor-launch-'));
        const stored = new Map<string, string>();
        const secrets = { get: async (key: string) => stored.get(key), store: async (key: string, value: string) => { stored.set(key, value); } };
        // VS Code file URIs may lowercase the drive while realpath preserves its spelling.
        const owner = new NormalSupervisorLaunchStore(join(root, 'private').replace(/^[A-Z]:/, drive => drive.toLowerCase()), secrets);
        const lock = { workspaceRoot: root, port: 42001, password: 'test-only-secret', updatedAt: 'now' };
        const first = JSON.parse(await owner.prepare(lock));
        const second = JSON.parse(await owner.prepare(lock));
        expect(second.binding.integrationId).toBe(first.binding.integrationId);
        expect(second.identityKey).toBe(first.identityKey);
        expect(second.binding.serviceId).not.toBe(first.binding.serviceId);
        expect(second.launchKey).not.toBe(first.launchKey);
        expect(JSON.stringify([...stored])).not.toContain(lock.password);
        expect(await readdir(first.privateDirectory)).toEqual(['identities']);
        const connection: ServerConnection = { host: '127.0.0.1', port: lock.port,
            baseUrl: `http://127.0.0.1:${lock.port}`, authHeader: `Basic ${Buffer.from(`opencode:${lock.password}`).toString('base64')}`, lock };
        expect(await owner.forConnection(connection)).toEqual(second);
        expect(await owner.forConnection({ ...connection, baseUrl: 'http://127.0.0.1:42002' })).toBeUndefined();
        expect(await owner.forConnection({ ...connection, authHeader: `Basic ${Buffer.from('opencode:wrong-password').toString('base64')}` })).toBeUndefined();
        const reloaded = new NormalSupervisorLaunchStore(join(root, 'private'), secrets);
        expect(await reloaded.forConnection(connection)).toEqual(second);
    });

    test('other workspaces have independent identities and corrupt retained identity is not silently replaced', async () => {
        root = await mkdtemp(join(tmpdir(), 'gui-supervisor-launch-'));
        const stored = new Map<string, string>();
        const owner = new NormalSupervisorLaunchStore(join(root, 'private'), {
            get: async key => stored.get(key), store: async (key, value) => { stored.set(key, value); },
        });
        const lock = { workspaceRoot: root, port: 42001, password: 'test-only-secret', updatedAt: 'now' };
        const first = JSON.parse(await owner.prepare(lock));
        const other = await mkdtemp(join(root, 'other-'));
        const second = JSON.parse(await owner.prepare({ ...lock, workspaceRoot: other }));
        expect(second.binding.integrationId).not.toBe(first.binding.integrationId);
        expect(second.privateDirectory).not.toBe(first.privateDirectory);
        const firstKey = [...stored.keys()][0];
        stored.set(firstKey, '{"corrupt":true}');
        await expect(owner.prepare(lock)).rejects.toThrow('Invalid retained supervisor identity');
        expect(stored.get(firstKey)).toBe('{"corrupt":true}');
    });
});
