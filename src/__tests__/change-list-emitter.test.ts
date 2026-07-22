import { ChangeListEmitter } from '../changes/ChangeListEmitter';

describe('ChangeListEmitter', () => {
    test('emits and persists a commit-bound changelist through injected owners', async () => {
        const target = { postMessage: jest.fn() };
        const upsertRecord = jest.fn().mockResolvedValue(undefined);
        const client = {
            getLastTurnCommitBase: jest.fn().mockReturnValue(null),
            wasChangeListEmitted: jest.fn().mockReturnValue(false),
            markChangeListEmitted: jest.fn().mockReturnValue(true),
            updateSessionBaseCommitAfterBind: jest.fn().mockResolvedValue(undefined),
        };
        const emitter = new ChangeListEmitter({
            isEnabled: () => true,
            getClient: () => client,
            resolveRepo: async () => ({ repoId: 'repo', gitDir: 'git', indexFile: 'index', workTree: 'work' }),
            getHead: async () => 'unused-head',
            getParent: async () => 'unused-base',
            getDiffFileSet: async () => new Set(['src/a.ts']),
            getDiffStats: async () => ({ 'src/a.ts': { additions: 2, deletions: 1 } }),
            isResolvableMessageId: (id): id is string => typeof id === 'string' && id.startsWith('msg_'),
            readRecords: async () => [],
            readSessionMap: async () => null,
            resolveVisibleOwner: async (_sessionId, id) => id,
            upsertRecord,
            log: jest.fn(),
            now: () => 123,
            wait: async () => undefined,
        });
        await emitter.emit({
            sessionId: 'session-a',
            userMessageId: 'msg_user',
            assistantMessageId: 'msg_assistant',
            commitResult: {
                status: 'committed',
                msgToCommit: 'head',
                msgToBaseCommit: 'base',
                touchedFiles: ['src/a.ts'],
            },
        }, target);
        expect(target.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'diffFileList',
            sessionId: 'session-a',
            files: ['src/a.ts'],
            anchorMessageId: 'msg_assistant',
            commitHead: 'head',
            commitBase: 'base',
        }));
        expect(upsertRecord).toHaveBeenCalledWith('session-a', expect.objectContaining({
            id: 'system:changeList:head',
            anchorMessageId: 'msg_assistant',
            createdAt: 123,
        }), { preserveAuthoritativeFiles: true });
        expect(client.updateSessionBaseCommitAfterBind).toHaveBeenCalledWith('session-a', 'head');
    });

    test('does not emit the same already-recorded head twice', async () => {
        const target = { postMessage: jest.fn() };
        const client = {
            getLastTurnCommitBase: jest.fn().mockReturnValue('base'),
            wasChangeListEmitted: jest.fn().mockReturnValue(true),
            markChangeListEmitted: jest.fn(),
        };
        const emitter = new ChangeListEmitter({
            isEnabled: () => true,
            getClient: () => client,
            resolveRepo: async () => ({ repoId: 'repo', gitDir: 'git', indexFile: 'index', workTree: 'work' }),
            getHead: async () => 'head',
            getParent: async () => 'base',
            getDiffFileSet: async () => new Set(['a.ts']),
            getDiffStats: async () => ({}),
            isResolvableMessageId: (id): id is string => typeof id === 'string' && id.startsWith('msg_'),
            readRecords: async () => [],
            readSessionMap: async () => null,
            resolveVisibleOwner: async (_sessionId, id) => id,
            upsertRecord: async () => undefined,
            log: jest.fn(),
            now: () => 1,
            wait: async () => undefined,
        });
        const identity = { sessionId: 'session-a', userMessageId: 'msg_user', assistantMessageId: 'msg_assistant' };
        await emitter.emit(identity, target);
        await emitter.emit(identity, target);
        expect(target.postMessage).toHaveBeenCalledTimes(1);
    });
});
