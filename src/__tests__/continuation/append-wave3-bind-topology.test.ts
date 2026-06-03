jest.mock('vscode', () => ({
    workspace: {
        workspaceFolders: [{ uri: { fsPath: 'D:\\0.Code\\OpenCodeGUI' } }],
        getConfiguration: () => ({
            get: (_key: string, defaultValue: unknown) => defaultValue,
        }),
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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OpenCodeClient } from '../../OpenCodeClient';
import { GitSessionMapStore } from '../../undo/GitSessionMapStore';
import type { SessionMap } from '../../undo/types';

const makeMap = (sessionId: string, repoId = 'repo_append'): SessionMap => ({
    schemaVersion: 1,
    sessionId,
    repoId,
    baselineCommit: 'base0',
    currentBaseCommit: 'base0',
    entries: [],
    tmpToCommit: {},
    tmpToBaseCommit: {},
    msgToCommit: {},
    msgToBaseCommit: {},
});

describe('append Wave 3 authoritative diff union', () => {
    it.each([
        ['root-only', ['src/root.ts'], []],
        ['child-only', [], ['src/child.ts']],
        ['overlap', ['src/shared.ts', 'src/root.ts'], ['src/shared.ts', 'src/child.ts']],
    ])('uses deterministic root + latest child summary.diffs union for %s', async (_name, rootFiles, childFiles) => {
        const client = new OpenCodeClient() as any;
        const detailByMessage = new Map<string, string[]>([
            ['msg_root_A', rootFiles],
            ['msg_append_child_A', childFiles],
        ]);
        client.getSessionMessageDetail = jest.fn(async (_sessionId: string, messageId: string) => ({
            info: {
                summary: {
                    diffs: (detailByMessage.get(messageId) || []).map((file) => ({ path: file })),
                },
            },
            parts: [],
        }));

        const result = await client.getAuthoritativeDiffFileSet({
            sessionId: 'ses_A',
            rootUserMessageId: 'msg_root_A',
            latestAppendUserMessageId: 'msg_append_child_A',
        });

        expect(client.getSessionMessageDetail).toHaveBeenCalledWith('ses_A', 'msg_root_A');
        expect(client.getSessionMessageDetail).toHaveBeenCalledWith('ses_A', 'msg_append_child_A');
        expect(result.queriedIds).toEqual(['msg_root_A', 'msg_append_child_A']);
        expect(result.files).toEqual(Array.from(new Set([...rootFiles, ...childFiles])).sort());
        expect(result.source).toBe('message-summary-diffs');
    });
});

describe('append Wave 3a commit-bind topology', () => {
    it('persists root, child, user, and assistant ids to the same commit/base across reload', async () => {
        const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'opencode-append-bind-'));
        const store = new GitSessionMapStore(workspaceRoot, () => undefined);
        const sessionId = 'ses_append_bind';
        const repoId = 'repo_append_bind';
        const commit = '8ed291f400000000000000000000000000000000';
        const base = '1111111100000000000000000000000000000000';
        const ids = ['msg_root_A', 'msg_append_child_A', 'msg_final_assistant_A'];

        await store.saveSessionMap(sessionId, store.bindMessageIdsToCommit(makeMap(sessionId, repoId), ids, commit, base));
        const reloaded = await store.loadSessionMap(sessionId, repoId);

        for (const id of ids) {
            expect(reloaded.msgToCommit[id]).toBe(commit);
            expect(reloaded.msgToBaseCommit[id]).toBe(base);
        }
    });

    it('makes root/presentation undo lookup resolvable through msgToCommit', async () => {
        const mapStore = {
            loadSessionMap: jest.fn(async () => makeMap('ses_A', 'repo_A')),
            saveSessionMap: jest.fn(async () => undefined),
            bindMessageIdsToCommit: jest.fn((map: SessionMap, ids: string[], commit: string, base?: string) => {
                const next = new GitSessionMapStore('D:\\0.Code\\OpenCodeGUI', () => undefined).bindMessageIdsToCommit(map, ids, commit, base);
                mapStore.latest = next;
                return next;
            }),
            latest: undefined as SessionMap | undefined,
        };
        const client = new OpenCodeClient() as any;
        client.gitUndoAvailable = true;
        client.gitUndo = {
            repoManager: { resolveRepo: jest.fn(async () => ({ repoId: 'repo_A' })) },
            mapStore,
        };

        const result = await client.bindCommitToMessageIds('ses_A', {
            messageIds: ['msg_root_A', 'msg_append_child_A', 'msg_append_child_A', 'msg_final_assistant_A'],
            commitHash: '8ed291f400000000000000000000000000000000',
            baseCommit: '1111111100000000000000000000000000000000',
            reason: 'append-commit-bind',
        });

        expect(result).toEqual({ ok: true, boundIds: ['msg_root_A', 'msg_append_child_A', 'msg_final_assistant_A'] });
        expect(mapStore.saveSessionMap).toHaveBeenCalledWith('ses_A', expect.objectContaining({
            msgToCommit: expect.objectContaining({
                msg_root_A: '8ed291f400000000000000000000000000000000',
                msg_append_child_A: '8ed291f400000000000000000000000000000000',
                msg_final_assistant_A: '8ed291f400000000000000000000000000000000',
            }),
            msgToBaseCommit: expect.objectContaining({
                msg_root_A: '1111111100000000000000000000000000000000',
                msg_append_child_A: '1111111100000000000000000000000000000000',
                msg_final_assistant_A: '1111111100000000000000000000000000000000',
            }),
        }));

        mapStore.loadSessionMap.mockResolvedValueOnce(mapStore.latest!);
        await expect(client.getCommitHashesForMessageIds('ses_A', ['msg_root_A'])).resolves.toEqual(['8ed291f400000000000000000000000000000000']);
    });
});
