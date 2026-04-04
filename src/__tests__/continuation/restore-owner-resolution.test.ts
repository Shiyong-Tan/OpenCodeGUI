import type { SessionMap } from '../../undo/types';
import { makeCommitHash, makeHandoffMetadata, makeSessionMap, makeSessionEntry } from '../helpers/continuation-factories';

jest.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: (_key: string, defaultValue: unknown) => defaultValue,
        }),
    },
}), { virtual: true });

import { GitUndoEngine } from '../../undo/GitUndoEngine';

function createMockedEngine(map: SessionMap) {
    const engine = new GitUndoEngine('D:\\0.Code\\OpenCodeGUI', () => undefined) as any;
    engine.capabilities = { gitAvailable: true };
    engine.repoManager = {
        resolveRepo: jest.fn().mockResolvedValue({
            repoId: map.repoId,
            gitDir: 'git-dir',
            indexFile: 'index-file',
            workTree: 'work-tree',
        }),
    };
    engine.lockManager = {
        withRepoLock: jest.fn().mockImplementation(
            async (_repo: unknown, _logger: unknown, fn: () => Promise<unknown>) => fn()
        ),
    };
    engine.mapStore = {
        loadSessionMap: jest.fn().mockResolvedValue(map),
        saveSessionMap: jest.fn(),
    };
    return engine;
}

describe('restoreToMessage resolves superseded owner via continuation', () => {
    it('redirects restore of superseded msg A to current owner msg B', async () => {
        const supersededMsgId = 'msg_superseded_A';
        const currentOwnerMsgId = 'msg_current_B';
        const headCommit = makeCommitHash('head');
        const ownerCommit = makeCommitHash('owner-commit');

        const map = makeSessionMap({
            headCommit,
            currentBaseCommit: headCommit,
            msgToCommit: {
                [currentOwnerMsgId]: ownerCommit,
            },
            entries: [
                makeSessionEntry({ commitHash: ownerCommit, finalAssistantMsgId: currentOwnerMsgId }),
            ],
            continuation: makeHandoffMetadata({
                currentOwnerMsgId,
                predecessorOwnerMsgId: supersededMsgId,
            }),
        });

        const engine = createMockedEngine(map);
        engine.getCommitParent = jest.fn().mockResolvedValue(makeCommitHash('parent'));
        engine.ensureWorkspaceMatchesCommit = jest.fn().mockResolvedValue([]);
        engine.applyWorkspaceToTargetCommit = jest.fn().mockResolvedValue({ conflicts: [], touchedFiles: ['src/b.ts'] });

        const mockRunGit = jest.fn().mockResolvedValue({ stdout: 'src/b.ts\n', code: 0, stderr: '' });
        jest.spyOn(require('../../undo/GitRunner'), 'runGit').mockImplementation(mockRunGit);

        const result = await engine.restoreToMessage(map.sessionId, supersededMsgId);

        expect(result.applied).toBe(true);
        expect(engine.applyWorkspaceToTargetCommit).toHaveBeenCalledWith(
            expect.anything(),
            expect.any(Array),
            ownerCommit,
            'restore',
            expect.anything()
        );
    });

    it('uses direct binding when superseded msg has its own commit', async () => {
        const msgA = 'msg_A';
        const msgB = 'msg_B';
        const commitA = makeCommitHash('commitA');
        const commitB = makeCommitHash('commitB');
        const headCommit = makeCommitHash('head');

        const map = makeSessionMap({
            headCommit,
            currentBaseCommit: headCommit,
            msgToCommit: {
                [msgA]: commitA,
                [msgB]: commitB,
            },
            entries: [
                makeSessionEntry({ commitHash: commitA, finalAssistantMsgId: msgA }),
                makeSessionEntry({ commitHash: commitB, finalAssistantMsgId: msgB }),
            ],
            continuation: makeHandoffMetadata({
                currentOwnerMsgId: msgB,
                predecessorOwnerMsgId: msgA,
                continuationSequence: 2,
            }),
        });

        const engine = createMockedEngine(map);
        engine.getCommitParent = jest.fn().mockResolvedValue(makeCommitHash('parent'));
        engine.ensureWorkspaceMatchesCommit = jest.fn().mockResolvedValue([]);
        engine.applyWorkspaceToTargetCommit = jest.fn().mockResolvedValue({ conflicts: [], touchedFiles: ['src/a.ts'] });

        const mockRunGit = jest.fn().mockResolvedValue({ stdout: 'src/a.ts\n', code: 0, stderr: '' });
        jest.spyOn(require('../../undo/GitRunner'), 'runGit').mockImplementation(mockRunGit);

        const result = await engine.restoreToMessage(map.sessionId, msgA);

        expect(result.applied).toBe(true);
        expect(engine.applyWorkspaceToTargetCommit).toHaveBeenCalledWith(
            expect.anything(),
            expect.any(Array),
            commitA,
            'restore',
            expect.anything()
        );
    });
});
