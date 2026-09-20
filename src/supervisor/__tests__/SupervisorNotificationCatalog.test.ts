import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { SupervisorNotificationCatalog } from '../SupervisorNotificationCatalog';

let root: string;
const identity = { schemaVersion: 1, isolationId: 'lab_A', instanceId: 'old_instance', taskId: 'task_A', attemptId: 'attempt_A',
    parentSessionId: 'ses_A', childSessionId: 'ses_child', notificationId: 'notice_A', eventId: 'event_A', messageId: 'msg_notice' };
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'supervisor-catalog-')); await mkdir(join(root, 'identities')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const catalog = () => new SupervisorNotificationCatalog(join(root, 'connection.json'), 'lab_A');
const persist = (value: unknown = identity) => writeFile(join(root, 'identities', 'msg_notice.json'), JSON.stringify(value));

test('real persisted ID survives reload and old instance; same-text user and foreign parent remain unclassified', async () => {
    const reader = catalog();
    expect(await reader.lookup('ses_A', 'msg_notice')).toBeUndefined();
    await persist(); // A miss must not conceal registration that happens later.
    expect(await reader.lookup('ses_A', 'msg_notice')).toEqual(identity);
    expect(await reader.lookup('ses_B', 'msg_notice')).toBeUndefined();
    expect(await reader.lookup('ses_A', 'msg_user_same_text')).toBeUndefined();
    expect(await catalog().lookup('ses_A', 'msg_notice')).toEqual(identity);
    expect(Object.isFrozen(await reader.lookup('ses_A', 'msg_notice'))).toBe(true);
});

test.each([
    { ...identity, isolationId: 'foreign' }, { ...identity, messageId: 'msg_other' },
    { ...identity, extra: 'synthetic' }, { ...identity, schemaVersion: 2 },
])('rejects corrupt or foreign durable evidence without returning untrusted metadata', async value => {
    await persist(value);
    await expect(catalog().lookup('ses_A', 'msg_notice')).rejects.toThrow('classification unavailable');
});

test('bounds actual reads and rejects path-like IDs without disk access', async () => {
    await writeFile(join(root, 'identities', 'msg_notice.json'), 'x'.repeat(4097));
    await expect(catalog().lookup('ses_A', 'msg_notice')).rejects.toThrow('classification unavailable');
    expect(await catalog().lookup('ses_A', '../msg_notice')).toBeUndefined();
});

test('missing identity directory blocks classification instead of presenting internal input as user text', async () => {
    await rm(join(root, 'identities'), { recursive: true });
    await expect(catalog().lookup('ses_A', 'msg_notice')).rejects.toThrow('classification unavailable');
});
