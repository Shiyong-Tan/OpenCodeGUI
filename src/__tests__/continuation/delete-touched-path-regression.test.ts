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
import * as os from 'os';
import * as path from 'path';
import { OpenCodeClient } from '../../OpenCodeClient';
import { GitUndoEngine } from '../../undo/GitUndoEngine';

const execFile = (file: string, args: string[], cwd: string): Promise<void> => new Promise((resolve, reject) => {
    cp.execFile(file, args, { cwd }, (error) => error ? reject(error) : resolve());
});

describe('delete touched-path sanitization regression', () => {
    let workspaceRoot: string;
    const clients: OpenCodeClient[] = [];

    beforeEach(async () => {
        workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'opencode-delete-path-'));
        await fs.promises.mkdir(path.join(workspaceRoot, 'tests'), { recursive: true });
    });

    afterEach(async () => {
        await Promise.all(clients.splice(0).map((client) => client.dispose()));
        await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    });

    it('rejects PowerShell flags/globs instead of returning a shell fragment as a touched path', () => {
        const client = new OpenCodeClient() as any;
        clients.push(client as OpenCodeClient);

        const globResult = client.extractDeletedPathsFromCommand('Remove-Item -Path "tests/*" -Force', workspaceRoot);
        const concreteResult = client.extractDeletedPathsFromCommand('Remove-Item -Path "tests/test0.txt" -Force', workspaceRoot);
        const bracketResult = client.extractDeletedPathsFromCommand('Remove-Item -LiteralPath "app/users/[id].tsx" -Force', workspaceRoot);

        expect(globResult).toEqual([]);
        expect(globResult).not.toContain(path.join(workspaceRoot, '-Path "tests/*" -Force'));
        expect(concreteResult).toEqual([path.join(workspaceRoot, 'tests/test0.txt')]);
        expect(bracketResult).toEqual([path.join(workspaceRoot, 'app', 'users', '[id].tsx')]);
    });

    it('commits valid concrete delete paths, including bracket paths, without staging the rejected PowerShell fragment', async () => {
        const logs: string[] = [];
        await fs.promises.mkdir(path.join(workspaceRoot, 'app', 'users'), { recursive: true });
        await fs.promises.writeFile(path.join(workspaceRoot, 'tests', 'test0.txt'), 'tracked\n', 'utf-8');
        await fs.promises.writeFile(path.join(workspaceRoot, 'app', 'users', '[id].tsx'), 'export default function Page() { return null; }\n', 'utf-8');
        await execFile('git', ['init'], workspaceRoot);
        await execFile('git', ['add', 'tests/test0.txt', 'app/users/[id].tsx'], workspaceRoot);

        const engine = new GitUndoEngine(workspaceRoot, (message) => logs.push(message)) as any;
        engine.capabilities = { gitAvailable: true };
        await engine.ensureBaselineReady('session-delete', 'turn-delete');
        await fs.promises.unlink(path.join(workspaceRoot, 'tests', 'test0.txt'));
        await fs.promises.unlink(path.join(workspaceRoot, 'app', 'users', '[id].tsx'));

        const rejected = await engine.commitFileChanges(
            'session-delete',
            'turn-fragment',
            undefined,
            undefined,
            [{ type: 'delete', path: '-Path "tests/*" -Force' }]
        );
        expect(rejected.commitHash).toBeUndefined();
        expect(rejected.touchedFiles).toEqual([]);

        const result = await engine.commitFileChanges(
            'session-delete',
            'turn-delete',
            undefined,
            undefined,
            [
                { type: 'delete', path: path.join(workspaceRoot, 'tests', 'test0.txt') },
                { type: 'delete', path: path.join(workspaceRoot, 'app', 'users', '[id].tsx') }
            ]
        );

        expect(result.commitHash).toMatch(/^[0-9a-f]{40}$/);
        expect(result.touchedFiles).toEqual(['tests/test0.txt', 'app/users/[id].tsx']);
        expect(logs.some((line) => line.includes('commit.path.reject') && line.includes('-Path'))).toBe(true);
        expect(logs.some((line) => line.includes('commit.ok') && line.includes('session-delete'))).toBe(true);
    });

    const createClientForRepo = (root: string, logs: string[] = []): OpenCodeClient => {
        const client = new OpenCodeClient() as any;
        clients.push(client as OpenCodeClient);
        client.workspaceRoot = root;
        client.gitUndo = new GitUndoEngine(root, (message) => logs.push(message));
        client.gitUndo.capabilities = { gitAvailable: true };
        client.gitUndoAvailable = true;
        return client as OpenCodeClient;
    };

    it('commits authoritative files with real git delta even when no pending turn changes exist', async () => {
        await fs.promises.writeFile(path.join(workspaceRoot, 'tests', 'test0.txt'), 'before\n', 'utf-8');
        await execFile('git', ['init'], workspaceRoot);
        await execFile('git', ['add', 'tests/test0.txt'], workspaceRoot);

        const client = createClientForRepo(workspaceRoot);
        await (client as any).gitUndo.ensureBaselineReady('session-auth-no-pending', 'turn-baseline');
        await fs.promises.writeFile(path.join(workspaceRoot, 'tests', 'test0.txt'), 'after\n', 'utf-8');

        const result = await client.commitPendingTurnChanges('session-auth-no-pending', {
            authoritativeFiles: ['tests/test0.txt']
        });

        expect(result.status).toBe('committed');
        expect(result.reason).toBeUndefined();
        expect(result.msgToCommit).toMatch(/^[0-9a-f]{40}$/);
        expect(result.touchedFiles).toEqual(['tests/test0.txt']);
    });

    it('does not use the legacy pending noop reason for authoritative files without git delta', async () => {
        await fs.promises.writeFile(path.join(workspaceRoot, 'tests', 'test0.txt'), 'unchanged\n', 'utf-8');
        await execFile('git', ['init'], workspaceRoot);
        await execFile('git', ['add', 'tests/test0.txt'], workspaceRoot);

        const client = createClientForRepo(workspaceRoot);
        await (client as any).gitUndo.ensureBaselineReady('session-auth-no-delta-no-pending', 'turn-baseline');

        const result = await client.commitPendingTurnChanges('session-auth-no-delta-no-pending', {
            authoritativeFiles: ['tests/test0.txt']
        });

        expect(result.status).toBe('noop');
        expect(result.reason).toBe('no-authoritative-git-delta');
        expect(result.reason).not.toBe('no-pending-turn-changes');
        expect(result.msgToCommit).toBeUndefined();
    });

    const queuePendingParserFragment = (client: OpenCodeClient, sessionId: string, turnKey: string): void => {
        const anyClient = client as any;
        anyClient.pendingTurnChangesBySession.set(sessionId, {
            turnKey,
            changes: [{ type: 'delete', path: '-Path "tests/*" -Force' }]
        });
    };

    it('uses authoritative changelist paths only, so a bad parser glob cannot broaden the commit', async () => {
        await fs.promises.writeFile(path.join(workspaceRoot, 'tests', 'test0.txt'), 'zero\n', 'utf-8');
        await fs.promises.writeFile(path.join(workspaceRoot, 'tests', 'test1.txt'), 'one\n', 'utf-8');
        await execFile('git', ['init'], workspaceRoot);
        await execFile('git', ['add', 'tests/test0.txt', 'tests/test1.txt'], workspaceRoot);

        const client = createClientForRepo(workspaceRoot);
        await (client as any).gitUndo.ensureBaselineReady('session-auth-only', 'turn-baseline');
        await fs.promises.unlink(path.join(workspaceRoot, 'tests', 'test0.txt'));
        await fs.promises.unlink(path.join(workspaceRoot, 'tests', 'test1.txt'));
        queuePendingParserFragment(client, 'session-auth-only', 'turn-delete');

        const result = await client.commitPendingTurnChanges('session-auth-only', {
            authoritativeFiles: ['tests/test0.txt']
        });

        expect(result.status).toBe('committed');
        expect(result.touchedFiles).toEqual(['tests/test0.txt']);
        expect(result.touchedFiles).not.toContain('-Path "tests/*" -Force');
        const stagedOrUnstaged = await new Promise<string>((resolve, reject) => {
            cp.execFile('git', ['status', '--porcelain', '--', 'tests/test1.txt'], { cwd: workspaceRoot }, (error, stdout) => error ? reject(error) : resolve(stdout));
        });
        expect(stagedOrUnstaged).toContain('tests/test1.txt');
    });

    it('uses the updated base for a recreate turn after the delete commit is bound', async () => {
        await fs.promises.writeFile(path.join(workspaceRoot, 'tests', 'test0.txt'), 'before\n', 'utf-8');
        await execFile('git', ['init'], workspaceRoot);
        await execFile('git', ['add', 'tests/test0.txt'], workspaceRoot);

        const client = createClientForRepo(workspaceRoot);
        await (client as any).gitUndo.ensureBaselineReady('session-recreate', 'turn-baseline');
        await fs.promises.unlink(path.join(workspaceRoot, 'tests', 'test0.txt'));
        queuePendingParserFragment(client, 'session-recreate', 'turn-delete');

        const deleteResult = await client.commitPendingTurnChanges('session-recreate', {
            authoritativeFiles: ['tests/test0.txt']
        });
        expect(deleteResult.status).toBe('committed');
        expect(deleteResult.msgToCommit).toMatch(/^[0-9a-f]{40}$/);
        await client.updateSessionBaseCommitAfterBind('session-recreate', deleteResult.msgToCommit!);

        await fs.promises.mkdir(path.join(workspaceRoot, 'tests'), { recursive: true });
        await fs.promises.writeFile(path.join(workspaceRoot, 'tests', 'test0.txt'), 'after\n', 'utf-8');
        queuePendingParserFragment(client, 'session-recreate', 'turn-recreate');
        const recreateResult = await client.commitPendingTurnChanges('session-recreate', {
            authoritativeFiles: ['tests/test0.txt']
        });

        expect(recreateResult.status).toBe('committed');
        expect(recreateResult.msgToBaseCommit).toBe(deleteResult.msgToCommit);
        expect(recreateResult.touchedFiles).toEqual(['tests/test0.txt']);
    });

    it('treats an authoritative changelist path with no actual git delta as noop', async () => {
        await fs.promises.writeFile(path.join(workspaceRoot, 'tests', 'test0.txt'), 'unchanged\n', 'utf-8');
        await execFile('git', ['init'], workspaceRoot);
        await execFile('git', ['add', 'tests/test0.txt'], workspaceRoot);

        const client = createClientForRepo(workspaceRoot);
        await (client as any).gitUndo.ensureBaselineReady('session-no-delta', 'turn-baseline');
        queuePendingParserFragment(client, 'session-no-delta', 'turn-no-delta');

        const result = await client.commitPendingTurnChanges('session-no-delta', {
            authoritativeFiles: ['tests/test0.txt']
        });

        expect(result.status).toBe('noop');
        expect(result.reason).toBe('no-authoritative-git-delta');
        expect(result.msgToCommit).toBeUndefined();
        expect(result.touchedFiles).toBeUndefined();
    });
});
