import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SnapshotStore } from '../history/SnapshotStore';

describe('SnapshotStore', () => {
    let root: string;
    beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-snapshot-store-')); });
    afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

    test('writes atomically and reports the exact UTF-8 byte length', async () => {
        const store = new SnapshotStore({
            getDirectory: () => path.join(root, 'snapshots'),
            ensureDir: async (directory) => { await fs.promises.mkdir(directory, { recursive: true }); },
        });
        const payload = { sessionId: 'session-a', sessionData: { messages: [{ text: '中文' }] } };
        const bytes = await store.writeAtomic('session-a', payload);
        const loaded = await store.read('session-a');
        expect(loaded?.obj).toEqual(payload);
        expect(loaded?.bytes).toBe(bytes);
        expect(fs.existsSync(`${store.getFile('session-a')}.tmp`)).toBe(false);
    });

    test('returns null only when the snapshot is absent', async () => {
        const store = new SnapshotStore({ getDirectory: () => root, ensureDir: async () => undefined });
        await expect(store.read('missing')).resolves.toBeNull();
        fs.writeFileSync(store.getFile('broken'), '{', 'utf-8');
        await expect(store.read('broken')).rejects.toThrow();
    });
});
