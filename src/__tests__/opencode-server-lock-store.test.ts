import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hashWorkspaceForServer, normalizeWorkspaceForServerHash, OpenCodeServerLockStore } from '../transport/OpenCodeServerLockStore';

describe('OpenCode server lock store', () => {
    let root = '';

    afterEach(() => {
        if (root) fs.rmSync(root, { recursive: true, force: true });
        root = '';
    });

    test('preserves workspace hash normalization rules', () => {
        expect(normalizeWorkspaceForServerHash('C:\\Work\\Repo\\', 'win32')).toBe('c:/work/repo');
        expect(hashWorkspaceForServer('C:\\Work\\Repo\\', 'win32'))
            .toBe(hashWorkspaceForServer('c:/work/repo', 'win32'));
    });

    test('creates, reuses, and authenticates a workspace-scoped lock', async () => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-lock-store-'));
        const logs: string[] = [];
        const store = new OpenCodeServerLockStore({ getWorkspaceRoot: () => root, log: (line) => logs.push(line) });
        const first = await store.getConnection();
        const second = await store.getConnection();
        expect(second.port).toBe(first.port);
        expect(second.lock.password).toBe(first.lock.password);
        expect(second.authHeader).toBe(`Basic ${Buffer.from(`opencode:${first.lock.password}`).toString('base64')}`);
        expect(fs.existsSync(path.join(root, '.opencode', 'server.lock.json'))).toBe(true);
        expect(logs.some((line) => line.includes('server.lock.create'))).toBe(true);
    });

    test('provides one deterministic pass through the configured port range', () => {
        const store = new OpenCodeServerLockStore({ getWorkspaceRoot: () => 'C:\\repo', log: () => undefined });
        const ports = store.getMigrationPorts('C:\\repo');
        expect(ports).toHaveLength(store.portRange);
        expect(new Set(ports).size).toBe(store.portRange);
        expect(Math.min(...ports)).toBe(store.portBase);
        expect(Math.max(...ports)).toBe(store.portBase + store.portRange - 1);
    });
});
