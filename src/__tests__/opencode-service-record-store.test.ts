import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { OpenCodeServiceRecordStore } from '../transport/OpenCodeServiceRecordStore';

const windows = process.platform === 'win32' ? describe : describe.skip;
windows('private append-only service ownership records', () => {
    let root: string;
    let secrets: Map<string, string>;
    let store: OpenCodeServiceRecordStore;
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'opencode-owner-test-'));
        secrets = new Map();
        store = new OpenCodeServiceRecordStore(join(root, 'private'), {
            get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); },
        });
    });
    afterEach(async () => { await rm(root, { recursive: true, force: true }); });
    const lock = (workspaceRoot: string) => ({ workspaceRoot, port: 42000, password: 'fixture-only-password', updatedAt: 'now' });
    const identity = (serviceId: string) => ({ serviceId, pid: 123, creationFileTime: '133700000000000000' });

    test('reload preserves verified registration and binds exact workspace, port and authentication', async () => {
        const server = lock(root);
        const record = await store.begin(server);
        await store.register(root, identity(record.serviceId));
        const restored = new OpenCodeServiceRecordStore(join(root, 'private'), {
            get: async key => secrets.get(key), store: async (key, value) => { secrets.set(key, value); },
        });
        const loaded = await restored.current(root);
        expect(loaded?.process).toEqual(identity(record.serviceId));
        const connection = { lock: server, host: '127.0.0.1', port: server.port, baseUrl: 'http://127.0.0.1:42000',
            authHeader: `Basic ${Buffer.from('opencode:fixture-only-password').toString('base64')}` };
        expect(restored.matches(loaded!, connection)).toBe(true);
        expect(restored.matches(loaded!, { ...connection, authHeader: 'Basic foreign' })).toBe(false);
        expect(restored.matches(loaded!, { ...connection, baseUrl: 'http://127.0.0.1:42001' })).toBe(false);
        expect(restored.matches(loaded!, { ...connection, lock: { ...server, workspaceRoot: join(root, 'other') } })).toBe(false);
    });

    test('late old registration or stop cannot overwrite a newer generation', async () => {
        const first = await store.begin(lock(root));
        const next = await store.begin(lock(root));
        await expect(store.register(root, identity(first.serviceId))).rejects.toMatchObject({ reason: 'operation_superseded' });
        await expect(store.markStopped(root, first.serviceId)).rejects.toMatchObject({ reason: 'operation_superseded' });
        await store.register(root, identity(next.serviceId));
        await store.markStopped(root, next.serviceId);
        await store.markStopped(root, next.serviceId);
        expect(await store.current(root)).toMatchObject({ serviceId: next.serviceId, generation: 2, intentionallyStopped: true });
    });

    test('missing process registration remains unresolved and tampered evidence is rejected', async () => {
        const record = await store.begin(lock(root));
        expect((await store.current(root))?.process).toBeUndefined();
        const directory = join(root, 'private', await store.workspaceKey(root));
        const file = join(directory, (await readdir(directory)).find(name => name.endsWith('.start.json'))!);
        const raw = JSON.parse(await readFile(file, 'utf8'));
        raw.payload.port++;
        await writeFile(file, JSON.stringify(raw));
        await expect(store.current(root)).rejects.toMatchObject({ reason: 'record_authentication_failed' });
        expect(record.serviceId).toHaveLength(64);
    });

    test('losing the private signing key does not silently mint replacement ownership', async () => {
        await store.begin(lock(root)); secrets.clear();
        await expect(store.current(root)).rejects.toMatchObject({ reason: 'owner_key_missing' });
        await expect(store.begin(lock(root))).rejects.toMatchObject({ reason: 'owner_key_missing' });
    });
});
