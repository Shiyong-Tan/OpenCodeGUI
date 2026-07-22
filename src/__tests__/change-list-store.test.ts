import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChangeListStore } from '../changes/ChangeListStore';

describe('ChangeListStore', () => {
    let root: string;
    let dataDir: string;
    let legacyDir: string;
    let logs: string[];

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-change-list-store-'));
        dataDir = path.join(root, 'data');
        legacyDir = path.join(root, 'legacy');
        logs = [];
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    const createStore = () => new ChangeListStore({
        getDataDir: () => dataDir,
        getLegacyDir: () => legacyDir,
        ensureDir: async (dir) => { await fs.promises.mkdir(dir, { recursive: true }); },
        log: (line) => logs.push(line),
    });

    test('writes atomically and reads the persisted records', async () => {
        const store = createStore();
        const records: any[] = [{ id: 'list-a', files: ['src/a.ts'], anchorMessageId: 'msg_a' }];
        await store.write('session-a', records);
        await expect(store.read('session-a')).resolves.toEqual(records);
        expect(fs.existsSync(path.join(dataDir, 'session-a.json.tmp'))).toBe(false);
        expect(logs.some((line) => line.includes('[EXT][CHANGELIST_WRITE_OK]'))).toBe(true);
    });

    test('migrates legacy records to the current data directory', async () => {
        fs.mkdirSync(legacyDir, { recursive: true });
        const records: any[] = [{ id: 'list-old', files: ['old.ts'], anchorMessageId: 'msg_old' }];
        fs.writeFileSync(path.join(legacyDir, 'session-old.json'), JSON.stringify(records), 'utf-8');
        const store = createStore();
        await expect(store.read('session-old')).resolves.toEqual(records);
        expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'session-old.json'), 'utf-8'))).toEqual(records);
        expect(logs.some((line) => line.includes('[EXT][CHANGELIST_MIGRATED]'))).toBe(true);
    });

    test('treats missing or malformed storage as empty', async () => {
        const store = createStore();
        await expect(store.read('missing')).resolves.toEqual([]);
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(path.join(dataDir, 'broken.json'), '{', 'utf-8');
        await expect(store.read('broken')).resolves.toEqual([]);
    });
});
