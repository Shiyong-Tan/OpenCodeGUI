import { mkdtemp, writeFile, readFile, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse } from 'jsonc-parser';
import { configureSupervisor, mergeSupervisorConfig, supervisorRelease } from '../SupervisorSetup';

test('adds a pinned plugin without changing comments, permissions or other plugins', () => {
    const source = '{\n // keep this\n "permission": {"bash":"ask"}, "plugin": ["other"],\n}';
    const after = mergeSupervisorConfig(source), data = parse(after);
    expect(after).toContain('// keep this');
    expect(data.permission).toEqual({ bash: 'ask' });
    expect(data.plugin[0]).toBe('other');
    expect(data.plugin[1]).toEqual([supervisorRelease, { allowDispatch: true, allowNotifications: false, normalGui: { enabled: true } }]);
    expect(mergeSupervisorConfig(after)).toBe(after);
});
test('retains existing local plugin options and refuses malformed/ambiguous configurations', () => {
    const data = parse(mergeSupervisorConfig(JSON.stringify({ plugin: [['file:///D:/Tools/OpenCodeTaskSupervisor/dist/plugin.js', { allowDispatch: false, allowNotifications: true }]] })));
    expect(data.plugin).toHaveLength(1); expect(data.plugin[0][1].allowDispatch).toBe(false);
    expect(data.plugin[0][1].allowNotifications).toBe(true);
    for (const source of ['[]', '{oops', '{"plugin":{}}', JSON.stringify({ plugin: [supervisorRelease, supervisorRelease] }),
        JSON.stringify({ plugin: [[supervisorRelease, { managedLab: {} }]] })]) expect(() => mergeSupervisorConfig(source)).toThrow();
});
test('release failure never writes configuration; successful setup is backed up and idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'supervisor-setup-'));
    try {
        const file = join(root, 'opencode.jsonc'), source = '{ // retained\n "permission": "ask" }';
        await writeFile(file, source);
        await expect(configureSupervisor(root, async () => { throw new Error('offline'); })).rejects.toThrow('offline');
        expect(await readFile(file, 'utf8')).toBe(source);
        const check = jest.fn(async () => {});
        expect(await configureSupervisor(root, check)).toBe(true);
        expect(await configureSupervisor(root, check)).toBe(false);
        expect(check).toHaveBeenCalledTimes(1);
        expect((await readdir(root)).filter(f => f.includes('backup'))).toHaveLength(1);
        await writeFile(join(root, 'opencode.json'), '{}');
        await expect(configureSupervisor(root, check)).rejects.toThrow('Multiple workspace');
    } finally { await rm(root, { recursive: true, force: true }); }
});
