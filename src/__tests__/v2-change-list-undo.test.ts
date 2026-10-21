jest.mock('vscode', () => ({
    workspace: {
        workspaceFolders: [{ uri: { fsPath: 'D:\\0.Code\\OpenCodeGUI' } }],
        getConfiguration: () => ({
            get: (_key: string, defaultValue: unknown) => defaultValue,
        }),
        findFiles: jest.fn().mockResolvedValue([]),
    },
    window: {
        createOutputChannel: () => ({
            appendLine: () => undefined,
            append: () => undefined,
            clear: () => undefined,
            show: () => undefined,
            hide: () => undefined,
            dispose: () => undefined,
        }),
    },
}), { virtual: true });

import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { OpenCodeClient } from '../OpenCodeClient';
import { GitUndoEngine } from '../undo/GitUndoEngine';
import * as gitRunner from '../undo/GitRunner';
import { V2Backend } from '../transport/protocol/V2Backend';
import { V2Transport } from '../transport/protocol/V2Transport';

function clientFor(root: string, response: unknown) {
    const client = new OpenCodeClient() as any;
    client.workspaceRoot = root;
    const fetcher = jest.fn().mockResolvedValue(Response.json({ data: response }));
    const backend = new V2Backend(new V2Transport({ baseUrl: 'http://127.0.0.1:42000',
        authorization: 'Basic fixture', directory: root, isCurrent: () => true }, fetcher));
    Object.defineProperty(client, 'nativeBackend', { value: backend });
    client.getSessionMessageDetail = jest.fn(() => { throw Error('V1 message summaries must not be queried'); });
    return { client: client as OpenCodeClient, fetcher };
}

test('V2 authoritative range is scoped, normalized and never falls back on failed reads', async () => {
    const root = path.join(process.cwd(), '.lab', 'change-list-v2');
    const x = clientFor(root, [{ file: 'a.ts' }, { file: 'a.ts' }, { file: '../outside.ts' }]);
    try {
        const input = { sessionId: 'ses_A', rootUserMessageId: 'msg_root', latestAppendUserMessageId: 'msg_append' };
        expect(await x.client.getAuthoritativeDiffFileSet(input)).toEqual({ files: ['a.ts'],
            queriedIds: ['msg_root', 'msg_append'], missingIds: [], source: 'native-turn-diff' });
        x.fetcher.mockRejectedValueOnce(Error('offline'));
        expect(await x.client.getAuthoritativeDiffFileSet(input)).toMatchObject({ files: [], missingIds: ['msg_root', 'msg_append'] });
        expect(await x.client.getAuthoritativeDiffFileSet({ sessionId: 'ses_B' })).toMatchObject({ files: [], queriedIds: [] });
        expect(x.fetcher).toHaveBeenCalledTimes(2);
    } finally { await x.client.dispose(); }
});

test('V2 changed files commit, undo and restore actual create/update/delete content without touching unrelated edits', async () => {
    const base = path.join(process.cwd(), '.lab', 'change-list-v2');
    await fs.promises.mkdir(base, { recursive: true });
    const root = await fs.promises.mkdtemp(path.join(base, 'workspace-'));
    const x = clientFor(root, ['update.txt', 'create.txt', 'delete.txt'].map(file => ({ file })));
    const read = (name: string) => fs.promises.readFile(path.join(root, name), 'utf8');
    const write = (name: string, value: string) => fs.promises.writeFile(path.join(root, name), value);
    try {
        await write('update.txt', 'before\n'); await write('delete.txt', 'deleted-before\n'); await write('unrelated.txt', 'original\n');
        cp.execFileSync('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
        cp.execFileSync('git', ['add', '--', 'update.txt', 'delete.txt', 'unrelated.txt'], { cwd: root, windowsHide: true });
        const userIndex = await fs.promises.readFile(path.join(root, '.git', 'index'));
        const engine = new GitUndoEngine(root, () => undefined);
        (engine as any).capabilities = { gitAvailable: true };
        Object.assign(x.client, { gitUndo: engine, gitUndoAvailable: true });
        expect((await engine.ensureBaselineReady('ses_A', 'turn_A')).ok).toBe(true);
        await write('update.txt', 'after\n'); await write('create.txt', 'new\n'); await write('unrelated.txt', 'user edit\n');
        await fs.promises.unlink(path.join(root, 'delete.txt'));
        const auth = await x.client.getAuthoritativeDiffFileSet({ sessionId: 'ses_A', rootUserMessageId: 'msg_root' });
        const commit = await x.client.commitPendingTurnChanges('ses_A', { authoritativeFiles: auth.files });
        expect(commit.status).toBe('committed');
        expect(commit.touchedFiles?.sort()).toEqual(['create.txt', 'delete.txt', 'update.txt']);
        expect((await x.client.bindCommitToMessageIds('ses_A', { messageIds: ['msg_root', 'msg_final'],
            commitHash: commit.msgToCommit!, baseCommit: commit.msgToBaseCommit!, reason: 'test-native-range' })).ok).toBe(true);
        expect(await x.client.updateSessionBaseCommitAfterBind('ses_A', commit.msgToCommit!)).toBe(true);
        const undo = await engine.undoFromMessage('ses_A', 'msg_root', ['msg_root', 'msg_final']);
        expect(undo).toMatchObject({ applied: true, conflicts: [] });
        expect(await read('update.txt')).toBe('before\n'); expect(await read('delete.txt')).toBe('deleted-before\n');
        expect(fs.existsSync(path.join(root, 'create.txt'))).toBe(false); expect(await read('unrelated.txt')).toBe('user edit\n');
        const restored = await engine.restoreAll('ses_A', undo.restoreCommit!, undo.fileSet!, undo.undoTargetCommit!);
        expect(restored.applied).toBe(true); expect(restored.conflicts).toEqual([]);
        expect(await read('update.txt')).toBe('after\n'); expect(await read('create.txt')).toBe('new\n');
        expect(fs.existsSync(path.join(root, 'delete.txt'))).toBe(false); expect(await read('unrelated.txt')).toBe('user edit\n');
        expect(await fs.promises.readFile(path.join(root, '.git', 'index'))).toEqual(userIndex);
    } finally { await x.client.dispose(); await fs.promises.rm(root, { recursive: true, force: true }); }
}, 30000);


test('restore cannot report success after checkout failure or a failed content verification', async () => {
    const engine = new GitUndoEngine(process.cwd(), () => undefined) as any;
    const repo = { workTree: process.cwd(), gitDir: 'unused', indexFile: 'unused', repoId: 'fixture' };
    const runner = jest.spyOn(gitRunner, 'runGit');
    try {
        runner.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
            .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'checkout rejected' });
        await expect(engine.applyCheckoutToCommit(repo, 'commit', ['a.txt'])).rejects.toThrow('Restore checkout failed');
        expect(runner.mock.calls[1][1]).toEqual(['checkout', 'commit']);
        runner.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
            .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' });
        engine.ensureWorkspaceMatchesCommit = jest.fn().mockResolvedValue([{ path: 'a.txt' }]);
        await expect(engine.applyCheckoutToCommit(repo, 'commit', ['a.txt'])).rejects.toThrow('Restore verification failed');
    } finally { runner.mockRestore(); }
});


test('workspace verification fails closed when Git cannot compare the file', async () => {
    const engine = new GitUndoEngine(process.cwd(), () => undefined) as any;
    const runner = jest.spyOn(gitRunner, 'runGit');
    try {
        runner.mockResolvedValueOnce({ code: 0, stdout: '', stderr: '' })
            .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'comparison unavailable' });
        await expect(engine.ensureWorkspaceMatchesCommit({ workTree: process.cwd() }, 'commit', ['a.txt']))
            .rejects.toThrow('Workspace verification failed');
    } finally { runner.mockRestore(); }
});
