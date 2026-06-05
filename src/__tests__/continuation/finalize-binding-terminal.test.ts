jest.mock('vscode', () => ({
    workspace: {
        getConfiguration: jest.fn(() => ({
            get: jest.fn((_key: string, fallback: unknown) => fallback),
        })),
        findFiles: jest.fn(async () => []),
    },
    RelativePattern: jest.fn(),
}), { virtual: true });

import { GitUndoEngine } from '../../undo/GitUndoEngine';
import { GitSessionMapStore } from '../../undo/GitSessionMapStore';
import type { SessionMap } from '../../undo/types';
import {
    makeCommitHash,
    makeMsgId,
    makeSessionEntry,
    makeSessionMap,
    resetFactoryCounters,
} from '../helpers/continuation-factories';

beforeEach(() => {
    resetFactoryCounters();
});

const buildEngine = (map: SessionMap, logs: string[]) => {
    const bindStore = new GitSessionMapStore('D:\\0.Code\\OpenCodeGUI', () => undefined);
    const saved: SessionMap[] = [];
    const engine = new GitUndoEngine('D:\\0.Code\\OpenCodeGUI', (message) => logs.push(message)) as any;
    engine.capabilities = { gitAvailable: true };
    engine.repoManager = {
        resolveRepo: jest.fn(async () => ({
            repoId: map.repoId,
            gitDir: 'D:\\0.Code\\OpenCodeGUI\\.git',
            indexFile: 'D:\\0.Code\\OpenCodeGUI\\.git\\index',
            workTree: 'D:\\0.Code\\OpenCodeGUI',
        })),
    };
    engine.lockManager = {
        withRepoLock: jest.fn(async (_repo: unknown, _logger: unknown, fn: () => Promise<unknown>) => fn()),
    };
    engine.mapStore = {
        loadSessionMap: jest.fn(async () => map),
        saveSessionMap: jest.fn(async (_sessionId: string, updated: SessionMap) => {
            saved.push(updated);
        }),
        bindFinalMsg: (input: SessionMap, tmpKey: string, finalMsgId: string) => bindStore.bindFinalMsg(input, tmpKey, finalMsgId),
    };
    return { engine: engine as GitUndoEngine, saved };
};

describe('GitUndoEngine.finalizeBinding terminal handling', () => {
    it('preserves tmpToCommit success path and binds final message', async () => {
        const logs: string[] = [];
        const tmpKey = 'tmp:assistant-success';
        const finalMsgId = makeMsgId('final');
        const userMsgId = makeMsgId('user');
        const commitHash = makeCommitHash('commit-success');
        const baseCommit = makeCommitHash('base-success');
        const map = makeSessionMap({
            sessionId: 'ses_finalize_success',
            repoId: 'repo_finalize',
            baselineCommit: baseCommit,
            headCommit: commitHash,
            currentBaseCommit: commitHash,
            entries: [makeSessionEntry({ tmpKey, commitHash, touchedFiles: ['src/success.ts'] })],
            tmpToCommit: { [tmpKey]: commitHash },
            tmpToBaseCommit: { [tmpKey]: baseCommit },
        });
        const { engine, saved } = buildEngine(map, logs);

        await engine.finalizeBinding(map.sessionId, tmpKey, finalMsgId, userMsgId);

        expect(saved).toHaveLength(1);
        expect(saved[0].msgToCommit[finalMsgId]).toBe(commitHash);
        expect(saved[0].msgToCommit[userMsgId]).toBe(commitHash);
        expect(saved[0].entries[0].finalAssistantMsgId).toBe(finalMsgId);
        expect(logs.some((line) => line.includes('finalizeBinding.ok'))).toBe(true);
    });

    it('treats missing tmpKey with same-map finalMsgId binding as idempotent already-bound terminal', async () => {
        const logs: string[] = [];
        const missingTmpKey = 'tmp:assistant-missing';
        const finalMsgId = makeMsgId('final');
        const commitHash = makeCommitHash('commit-bound');
        const map = makeSessionMap({
            sessionId: 'ses_finalize_already_bound',
            repoId: 'repo_finalize',
            entries: [makeSessionEntry({ finalAssistantMsgId: finalMsgId, commitHash })],
            msgToCommit: { [finalMsgId]: commitHash },
        });
        const { engine, saved } = buildEngine(map, logs);

        await engine.finalizeBinding(map.sessionId, missingTmpKey, finalMsgId);

        expect(saved).toHaveLength(0);
        expect(logs.some((line) => line.includes('reason=already-bound'))).toBe(true);
        expect(logs.some((line) => line.includes('reason=missing-tmpKey'))).toBe(false);
    });

    it('treats confirmed no-commit turn as terminal without creating or binding a commit', async () => {
        const logs: string[] = [];
        const tmpKey = 'tmp:assistant-no-commit';
        const finalMsgId = makeMsgId('final');
        const map = makeSessionMap({
            sessionId: 'ses_finalize_no_commit',
            repoId: 'repo_finalize',
            entries: [],
            tmpToCommit: {},
            msgToCommit: {},
        });
        const { engine, saved } = buildEngine(map, logs);

        await engine.finalizeBinding(map.sessionId, tmpKey, finalMsgId, undefined, { allowNoCommitTerminal: true });

        expect(saved).toHaveLength(0);
        expect(map.msgToCommit[finalMsgId]).toBeUndefined();
        expect(logs.some((line) => line.includes('reason=no-commit-terminal'))).toBe(true);
        expect(logs.some((line) => line.includes('reason=missing-tmpKey'))).toBe(false);
    });

    it('keeps true orphan missing tmpKey diagnosable as missing-tmpKey noop', async () => {
        const logs: string[] = [];
        const tmpKey = 'tmp:assistant-orphan';
        const finalMsgId = makeMsgId('final');
        const map = makeSessionMap({
            sessionId: 'ses_finalize_orphan',
            repoId: 'repo_finalize',
            entries: [],
            tmpToCommit: {},
            msgToCommit: {},
        });
        const { engine, saved } = buildEngine(map, logs);

        await engine.finalizeBinding(map.sessionId, tmpKey, finalMsgId);

        expect(saved).toHaveLength(0);
        expect(logs.some((line) => line.includes('reason=missing-tmpKey'))).toBe(true);
        expect(logs.some((line) => line.includes('reason=no-commit-terminal'))).toBe(false);
        expect(logs.some((line) => line.includes('reason=already-bound'))).toBe(false);
    });
});
