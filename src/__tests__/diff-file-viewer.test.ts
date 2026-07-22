import * as path from 'path';
import { DiffFileViewer } from '../changes/DiffFileViewer';

const repo: any = { workTree: 'repo' };

function result(stdout = '', code = 0): any {
    return { code, stdout, stderr: '' };
}

describe('DiffFileViewer', () => {
    test('opens an immutable commit-to-commit diff when a changelist supplies commits', async () => {
        const calls: string[][] = [];
        const updates: any[] = [];
        const viewer = new DiffFileViewer({
            resolveRepo: async () => repo,
            getHead: async () => { throw new Error('must not resolve head'); },
            getParent: async () => { throw new Error('must not resolve parent'); },
            getWorkspaceRoot: () => path.join('C:', 'workspace'),
            updateDiff: async (...args) => { updates.push(args); },
            runGit: async (_repo, args) => {
                calls.push(args);
                if (args[0] === 'show') return result(args[1].startsWith('base:') ? 'before' : 'after');
                if (args[0] === 'diff') return result('patch');
                return result();
            },
        });
        await viewer.open({ sessionId: 'session-a', filePath: 'src\\a.ts', commitHead: 'head', commitBase: 'base', noBaseline: jest.fn() });
        expect(calls).toContainEqual(['diff', 'base', 'head', '--', 'src/a.ts']);
        expect(updates).toEqual([['src/a.ts', 'before', 'after', 'patch']]);
    });

    test('uses the working tree when no explicit head was supplied', async () => {
        const updates: any[] = [];
        const viewer = new DiffFileViewer({
            resolveRepo: async () => repo,
            getHead: async () => 'head-live',
            getParent: async () => 'base-live',
            getWorkspaceRoot: () => path.join('C:', 'workspace'),
            updateDiff: async (...args) => { updates.push(args); },
            readFile: async () => 'working tree',
            runGit: async (_repo, args) => args[0] === 'show' ? result('before') : (args[0] === 'diff' ? result('live patch') : result()),
        });
        await viewer.open({ sessionId: 'session-a', filePath: 'src/a.ts', noBaseline: jest.fn() });
        expect(updates).toEqual([['src/a.ts', 'before', 'working tree', 'live patch']]);
    });

    test('reports a missing baseline without updating the provider', async () => {
        const noBaseline = jest.fn();
        const updateDiff = jest.fn();
        const viewer = new DiffFileViewer({
            resolveRepo: async () => repo,
            getHead: async () => null,
            getParent: async () => null,
            getWorkspaceRoot: () => '.',
            updateDiff,
        });
        await viewer.open({ sessionId: 'session-a', filePath: 'a.ts', noBaseline });
        expect(noBaseline).toHaveBeenCalledTimes(1);
        expect(updateDiff).not.toHaveBeenCalled();
    });
});
