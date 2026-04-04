import type { SessionMap } from '../../undo/types';
import { makeCommitHash, makeHandoffMetadata, makeSessionMap } from '../helpers/continuation-factories';

jest.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: (_key: string, defaultValue: unknown) => defaultValue,
        }),
    },
}), { virtual: true });

import { GitUndoEngine } from '../../undo/GitUndoEngine';

describe('GitUndoEngine undoFromMessage owner base resolution', () => {
    it('uses the effective resolved owner message id for msgToBaseCommit lookup', async () => {
        const requestedMsgId = 'msg_superseded_A';
        const effectiveOwnerMsgId = 'msg_current_B';
        const currentHeadCommit = makeCommitHash('head');
        const effectiveOwnerCommit = makeCommitHash('owner-commit');
        const requestedBaseCommit = makeCommitHash('requested-base');
        const effectiveOwnerBaseCommit = makeCommitHash('effective-base');

        const map: SessionMap = makeSessionMap({
            headCommit: currentHeadCommit,
            currentBaseCommit: currentHeadCommit,
            msgToCommit: {
                [effectiveOwnerMsgId]: effectiveOwnerCommit,
            },
            msgToBaseCommit: {
                [requestedMsgId]: requestedBaseCommit,
                [effectiveOwnerMsgId]: effectiveOwnerBaseCommit,
            },
            continuation: makeHandoffMetadata({
                currentOwnerMsgId: effectiveOwnerMsgId,
                predecessorOwnerMsgId: requestedMsgId,
            }),
        });

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
            withRepoLock: jest.fn().mockImplementation(async (_repo: unknown, _logger: unknown, fn: () => Promise<unknown>) => fn()),
        };
        engine.mapStore = {
            loadSessionMap: jest.fn().mockResolvedValue(map),
            saveSessionMap: jest.fn(),
        };
        engine.getCommitParent = jest.fn().mockResolvedValue(makeCommitHash('parent-of-owner'));
        engine.getOrderedCommitsForMessages = jest.fn().mockReturnValue([effectiveOwnerCommit]);
        engine.getTouchedUnionForCommits = jest.fn().mockReturnValue([]);
        engine.computeFileSet = jest.fn().mockResolvedValue([]);

        const result = await engine.undoFromMessage(map.sessionId, requestedMsgId);

        expect(result.applied).toBe(true);
        expect(result.reason).toBe('no-file-set');
        expect(result.startCommit).toBe(effectiveOwnerCommit);
        expect(result.undoTargetCommit).toBe(effectiveOwnerBaseCommit);
        expect(engine.computeFileSet).toHaveBeenCalledWith(
            expect.anything(),
            effectiveOwnerBaseCommit,
            effectiveOwnerCommit,
            []
        );
    });
});
