import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitRepoManager } from '../../undo/GitRepoManager';
import { GitRepoRef, IndexMap } from '../../undo/types';

type InstrumentedManager = {
    resolveRepo(sessionId?: string, turnKey?: string): Promise<GitRepoRef>;
    loadIndexJson(): Promise<IndexMap>;
    initBareRepo(repoId: string): Promise<GitRepoRef>;
    syncWorkspaceGitignoreToInternalRepo(gitDir: string): Promise<boolean>;
};

describe('GitRepoManager resolution cache', () => {
    let workspaceRoot: string;

    beforeEach(async () => {
        workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'opencode-repo-cache-'));
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    });

    const createManager = (logs: string[] = []): GitRepoManager =>
        new GitRepoManager(workspaceRoot, (message) => logs.push(message));

    const readIndex = async (): Promise<IndexMap> =>
        JSON.parse(await fs.promises.readFile(
            path.join(workspaceRoot, '.opencode', 'git', 'index.json'),
            'utf-8'
        )) as IndexMap;

    it('bounds expensive work and logging for 1000 sequential warm resolutions', async () => {
        const logs: string[] = [];
        const manager = createManager(logs) as unknown as InstrumentedManager;
        const loadSpy = jest.spyOn(manager, 'loadIndexJson');
        const initSpy = jest.spyOn(manager, 'initBareRepo');
        const syncSpy = jest.spyOn(manager, 'syncWorkspaceGitignoreToInternalRepo');

        const refs: GitRepoRef[] = [];
        for (let i = 0; i < 1000; i++) {
            refs.push(await manager.resolveRepo('session-sequential', 'turn-sequential'));
        }

        expect(refs.every((ref) => JSON.stringify(ref) === JSON.stringify(refs[0]))).toBe(true);
        expect(await readIndex()).toMatchObject({
            sessionToRepo: { 'session-sequential': refs[0].repoId },
            turnToRepo: { 'turn-sequential': refs[0].repoId }
        });
        expect(loadSpy).toHaveBeenCalledTimes(1);
        expect(initSpy).toHaveBeenCalledTimes(1);
        expect(syncSpy).toHaveBeenCalledTimes(1);
        expect(logs.filter((line) => line.startsWith('resolveRepo.'))).toHaveLength(2);
    });

    it('coalesces 1000 concurrent cold resolutions into one creation', async () => {
        const logs: string[] = [];
        const manager = createManager(logs) as unknown as InstrumentedManager;
        const loadSpy = jest.spyOn(manager, 'loadIndexJson');
        const initSpy = jest.spyOn(manager, 'initBareRepo');

        const refs = await Promise.all(Array.from(
            { length: 1000 },
            () => manager.resolveRepo('session-concurrent', 'turn-concurrent')
        ));

        expect(new Set(refs.map((ref) => JSON.stringify(ref))).size).toBe(1);
        expect(loadSpy).toHaveBeenCalledTimes(1);
        expect(initSpy).toHaveBeenCalledTimes(1);
        expect(await readIndex()).toMatchObject({
            sessionToRepo: { 'session-concurrent': refs[0].repoId },
            turnToRepo: { 'turn-concurrent': refs[0].repoId }
        });
        expect(logs.filter((line) => line.startsWith('resolveRepo.'))).toHaveLength(3);
    });

    it('serializes cold creation across manager instances', async () => {
        const first = createManager() as unknown as InstrumentedManager;
        const second = createManager() as unknown as InstrumentedManager;
        const firstInit = jest.spyOn(first, 'initBareRepo');
        const secondInit = jest.spyOn(second, 'initBareRepo');

        const [firstRef, secondRef] = await Promise.all([
            first.resolveRepo('shared-session', 'shared-turn'),
            second.resolveRepo('shared-session', 'shared-turn')
        ]);

        expect(secondRef).toEqual(firstRef);
        expect(firstInit.mock.calls.length + secondInit.mock.calls.length).toBe(1);
        expect(await readIndex()).toMatchObject({
            sessionToRepo: { 'shared-session': firstRef.repoId },
            turnToRepo: { 'shared-turn': firstRef.repoId }
        });
    });

    it('preserves session precedence and durably binds a turn owner to a later session', async () => {
        const manager = createManager();
        const turnRef = await manager.resolveRepo(undefined, 'turn-alias');
        const sessionRef = await manager.resolveRepo('session-alias', 'turn-alias');
        expect(sessionRef).toEqual(turnRef);
        expect((await readIndex()).sessionToRepo['session-alias']).toBe(turnRef.repoId);

        const sessionWinner = await manager.resolveRepo('session-winner', 'turn-winner-source');
        const turnLoser = await manager.resolveRepo(undefined, 'turn-loser');
        const index = await readIndex();
        index.turnToRepo['turn-loser'] = turnLoser.repoId;
        index.sessionToRepo['session-winner'] = sessionWinner.repoId;
        await fs.promises.writeFile(
            path.join(workspaceRoot, '.opencode', 'git', 'index.json'),
            JSON.stringify(index, null, 2),
            'utf-8'
        );

        expect(await manager.resolveRepo('session-winner', 'turn-loser')).toEqual(sessionWinner);
        expect((await manager.resolveRepo(undefined, 'turn-loser')).repoId).toBe(turnLoser.repoId);
    });

    it('keeps distinct and missing identities semantically separate with exact refs', async () => {
        const manager = createManager();
        const first = await manager.resolveRepo('session-one', 'turn-one');
        const second = await manager.resolveRepo('session-two', 'turn-two');
        const unkeyedFirst = await manager.resolveRepo();
        const unkeyedSecond = await manager.resolveRepo();

        expect(new Set([first.repoId, second.repoId, unkeyedFirst.repoId, unkeyedSecond.repoId]).size).toBe(4);
        expect(first).toEqual({
            repoId: first.repoId,
            gitDir: path.join(workspaceRoot, '.opencode', 'git', 'repos', `${first.repoId}.git`),
            indexFile: path.join(workspaceRoot, '.opencode', 'git', 'repos', `${first.repoId}.git`, 'index'),
            workTree: workspaceRoot
        });
    });

    it('evicts a rejected resolution so the same key can retry', async () => {
        const manager = createManager() as unknown as InstrumentedManager;
        const original = manager.initBareRepo.bind(manager);
        const initSpy = jest.spyOn(manager, 'initBareRepo')
            .mockRejectedValueOnce(new Error('forced init failure'))
            .mockImplementation((repoId) => original(repoId));

        await expect(manager.resolveRepo('retry-session', 'retry-turn')).rejects.toThrow('forced init failure');
        await expect(manager.resolveRepo('retry-session', 'retry-turn')).resolves.toMatchObject({
            repoId: expect.any(String),
            workTree: workspaceRoot
        });
        expect(initSpy).toHaveBeenCalledTimes(2);
    });

    it('invalidates on index replacement and internal repo deletion', async () => {
        const manager = createManager() as unknown as InstrumentedManager;
        const original = await manager.resolveRepo('mutable-session', 'mutable-turn');
        const replacement = await manager.resolveRepo(undefined, 'replacement-turn');
        const index = await readIndex();
        index.sessionToRepo['mutable-session'] = replacement.repoId;
        await fs.promises.writeFile(
            path.join(workspaceRoot, '.opencode', 'git', 'index.json'),
            JSON.stringify(index, null, 2),
            'utf-8'
        );

        expect((await manager.resolveRepo('mutable-session', 'mutable-turn')).repoId).toBe(replacement.repoId);
        const initSpy = jest.spyOn(manager, 'initBareRepo');
        await fs.promises.rm(replacement.gitDir, { recursive: true, force: true });
        expect(await manager.resolveRepo('mutable-session', 'mutable-turn')).toEqual(replacement);
        expect(initSpy).toHaveBeenCalledTimes(1);
        expect(original.repoId).not.toBe(replacement.repoId);
    });

    it('content-validates workspace gitignore and internal exclude before cache hits', async () => {
        const manager = createManager() as unknown as InstrumentedManager;
        await fs.promises.writeFile(path.join(workspaceRoot, '.gitignore'), 'first.txt\n', 'utf-8');
        const ref = await manager.resolveRepo('ignore-session', 'ignore-turn');
        const syncSpy = jest.spyOn(manager, 'syncWorkspaceGitignoreToInternalRepo');

        await fs.promises.writeFile(path.join(workspaceRoot, '.gitignore'), 'second.txt\n', 'utf-8');
        await manager.resolveRepo('ignore-session', 'ignore-turn');
        const excludePath = path.join(ref.gitDir, 'info', 'exclude');
        expect(await fs.promises.readFile(excludePath, 'utf-8')).toContain('second.txt');

        await fs.promises.writeFile(excludePath, 'externally changed\n', 'utf-8');
        await manager.resolveRepo('ignore-session', 'ignore-turn');
        expect(await fs.promises.readFile(excludePath, 'utf-8')).toContain('second.txt');
        expect(syncSpy).toHaveBeenCalledTimes(2);
    });

    it('does not publish freshness when gitignore synchronization fails', async () => {
        const manager = createManager() as unknown as InstrumentedManager;
        const loadSpy = jest.spyOn(manager, 'loadIndexJson');
        const syncSpy = jest.spyOn(manager, 'syncWorkspaceGitignoreToInternalRepo')
            .mockResolvedValue(false);

        const first = await manager.resolveRepo('sync-retry-session', 'sync-retry-turn');
        const second = await manager.resolveRepo('sync-retry-session', 'sync-retry-turn');

        expect(second).toEqual(first);
        expect(loadSpy).toHaveBeenCalledTimes(2);
        expect(syncSpy).toHaveBeenCalledTimes(2);
    });
});
