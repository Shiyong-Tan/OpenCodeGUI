jest.mock('vscode', () => ({
    workspace: {
        workspaceFolders: [{ uri: { fsPath: 'D:\\0.Code\\OpenCodeGUI' } }],
        getConfiguration: () => ({
            get: (_key: string, defaultValue: unknown) => defaultValue,
        }),
        asRelativePath: (p: string) => p,
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
        showInformationMessage: () => undefined,
        showErrorMessage: () => undefined,
    },
    Uri: {
        file: (fsPath: string) => ({ fsPath }),
        joinPath: (...parts: any[]) => ({ fsPath: parts.map((p) => p?.fsPath || String(p)).join('/') }),
    },
    commands: { executeCommand: async () => undefined },
    env: { clipboard: { readText: async () => '' } },
}), { virtual: true });

import * as fs from 'fs';
import * as path from 'path';
import { SidebarProvider } from '../../SidebarProvider';
import { OpenCodeDiffProvider } from '../../OpenCodeDiffProvider';

const createdProviders: Array<{ dispose: () => Promise<void> }> = [];

function createProvider(): any {
    const context: any = {
        globalState: {
            get: () => undefined,
            update: () => Promise.resolve(),
        },
        extensionUri: { fsPath: 'D:\\0.Code\\OpenCodeGUI' },
        globalStoragePath: 'D:\\0.Code\\OpenCodeGUI\\.tmp-test',
    };
    const diffProvider = { updateFromSnapshot: jest.fn() } as unknown as OpenCodeDiffProvider;
    const provider = new SidebarProvider(context, context.extensionUri, diffProvider) as any;
    createdProviders.push(provider);
    provider.uiDebugChannel = { appendLine: jest.fn() };
    provider.currentSessionId = 'ses_delta';
    provider.readPersistedSessionMap = jest.fn().mockResolvedValue(null);
    return provider;
}

function msg(id: string, messageIndex: any, role: 'user' | 'assistant' = 'assistant', text = id): any {
    return { id, messageIndex, role, text };
}

function snapshotOf(messages: any[], timelineMessageIds = messages.map((message) => message.id)): any {
    return {
        obj: {
            sessionId: 'ses_delta',
            exportedAt: 1,
            sessionData: {
                type: 'sessionData',
                sessionId: 'ses_delta',
                title: 'Snapshot title',
                messages,
                segments: [],
                meta: { timelineMessageIds },
            },
        },
        bytes: 10,
    };
}

afterEach(async () => {
    await Promise.all(createdProviders.splice(0).map((provider) => provider.dispose()));
});

describe('W5A immutable snapshot semantic precedence', () => {
    it('does not let divergent same-ID remote fields modify a base snapshot record', () => {
        const provider = createProvider();
        const base = {
            id: 'msg_boundary',
            role: 'assistant',
            text: 'snapshot text',
            messageIndex: 7,
            timestamp: 100,
            parts: [{ type: 'text', text: 'snapshot part' }],
            meta: { source: 'snapshot', nested: { stable: true } },
            futureSchemaField: { preserved: 'yes' },
        };
        const remote = {
            ...base,
            text: 'remote rewrite',
            messageIndex: 700,
            timestamp: 999,
            parts: [{ type: 'text', text: 'remote part' }],
            meta: { source: 'remote', nested: { stable: false } },
            futureSchemaField: { preserved: 'no' },
        };

        const merged = provider.buildImmutableSnapshotWithProvenSuffix([base], [remote]);

        expect(merged).toHaveLength(1);
        expect(merged[0]).toEqual(base);
    });

    it('keeps snapshot relative order under shuffled overlapping remote input', () => {
        const provider = createProvider();
        const base = [msg('msg_a', 1), msg('msg_b', 2), msg('msg_boundary', 3)];
        const incoming = [base[2], msg('msg_new', 4), base[0], base[1]];

        expect(provider.buildImmutableSnapshotWithProvenSuffix(base, incoming).map((message: any) => message.id))
            .toEqual(['msg_a', 'msg_b', 'msg_boundary', 'msg_new']);
    });

    it('keeps permitted local schema normalization semantically idempotent', () => {
        const provider = createProvider();
        const fixture = [{
            id: 'msg_user_1',
            role: 'user',
            text: 'local text',
            messageIndex: 1,
            meta: {
                images: ['file:///kept.png', 'data:image/png;base64,redacted'],
                appendedPrompts: [{ clientMessageId: 'local-1', text: 'follow up', ignored: 'schema-noise' }],
            },
            futureSchemaField: { retained: true },
        }];

        const once = provider.normalizeSnapshotStoredMessages(fixture);
        const twice = provider.normalizeSnapshotStoredMessages(once);

        expect(twice).toEqual(once);
        expect(once[0]).toMatchObject({
            id: 'msg_user_1',
            role: 'user',
            text: 'local text',
            messageIndex: 1,
            futureSchemaField: { retained: true },
            meta: {
                images: ['file:///kept.png'],
                imageCount: 2,
                imagesRedactedInSnapshot: true,
                appendedPrompts: [{ clientMessageId: 'local-1', text: 'follow up' }],
            },
        });
    });
});

describe('W5A proven-new append candidates', () => {
    it('appends only the contiguous server suffix after the exact newest snapshot boundary, once and in server order', () => {
        const provider = createProvider();
        const candidates = provider.computeRecentAppendCandidates(
            new Set(['msg_old', 'msg_boundary']),
            2,
            [msg('msg_old', 1), msg('msg_boundary', 2), msg('msg_new_1', 3), msg('msg_new_1', 3), msg('msg_new_2', 4)],
        );

        expect(candidates.map((message: any) => message.id)).toEqual(['msg_new_1', 'msg_new_2']);
    });

    it('returns no append candidate when the exact boundary is missing and requires full fallback', () => {
        const provider = createProvider();
        const candidates = provider.computeRecentAppendCandidates(
            new Set(['msg_old', 'msg_boundary']),
            2,
            [msg('msg_new_1', 3), msg('msg_new_2', 4)],
        );

        expect(candidates).toEqual([]);
    });

    it('treats overlap that does not reach the newest snapshot boundary as unknown', () => {
        const provider = createProvider();
        const candidates = provider.computeRecentAppendCandidates(
            new Set(['msg_old', 'msg_boundary']),
            2,
            [msg('msg_old', 1), msg('msg_new', 3)],
        );

        expect(candidates).toEqual([]);
    });

    it('rejects an absent old ID before the boundary while accepting the proven suffix', () => {
        const provider = createProvider();
        const candidates = provider.computeRecentAppendCandidates(
            new Set(['msg_old', 'msg_boundary']),
            2,
            [msg('msg_absent_old', 0), msg('msg_boundary', 2), msg('msg_new', 3)],
        );

        expect(candidates.map((message: any) => message.id)).toEqual(['msg_new']);
    });

    it.each([
        ['missing', undefined],
        ['malformed', '4'],
        ['greater', 400],
        ['sparse', 9],
    ])('does not let a %s messageIndex independently prove newness', (_caseName, messageIndex) => {
        const provider = createProvider();
        const candidates = provider.computeRecentAppendCandidates(
            new Set(['msg_boundary']),
            2,
            [msg('msg_unproven', messageIndex)],
        );

        expect(candidates).toEqual([]);
    });

    it('fails closed on an out-of-order suffix response', () => {
        const provider = createProvider();
        const candidates = provider.computeRecentAppendCandidates(
            new Set(['msg_boundary']),
            2,
            [msg('msg_boundary', 2), msg('msg_newer', 4), msg('msg_older', 3)],
        );

        expect(candidates).toEqual([]);
    });

    it('does not accept a different ID at the snapshot boundary index as newer', () => {
        const provider = createProvider();
        const candidates = provider.computeRecentAppendCandidates(
            new Set(['msg_boundary']),
            2,
            [msg('msg_boundary', 2), msg('msg_not_newer', 2)],
        );

        expect(candidates).toEqual([]);
    });

    it.each([
        ['missing', undefined],
        ['non-finite', Number.NaN],
    ])('fails closed when the boundary is present but a suffix index is %s', (_caseName, messageIndex) => {
        const provider = createProvider();
        const candidates = provider.computeRecentAppendCandidates(
            new Set(['msg_boundary']),
            2,
            [msg('msg_boundary', 2), msg('msg_new', messageIndex)],
        );

        expect(candidates).toEqual([]);
    });

    it('keeps tmp/final aliases and same-ID collisions from overwriting the snapshot', () => {
        const provider = createProvider();
        const base = msg('msg_final', 2, 'assistant', 'snapshot final');
        const candidates = provider.computeRecentAppendCandidates(
            new Set(['msg_final']),
            2,
            [
                msg('msg_final', 2, 'assistant', 'remote collision'),
                msg('tmp:assistant', 3, 'assistant', 'temporary alias'),
            ],
        );

        expect(candidates).toEqual([]);
        expect(provider.buildImmutableSnapshotWithProvenSuffix([base], candidates)).toEqual([base]);
    });
});

describe('W5A snapshot export and finalize contracts', () => {
    it('rebuilds a structurally incomplete snapshot from full export in canonical message order', () => {
        const provider = createProvider();
        const existing = [
            msg('msg_user_0', 0, 'user'),
            msg('msg_user_1', 3, 'user'),
            msg('msg_assistant_2', 8, 'assistant', 'snapshot second answer'),
            msg('msg_user_2', 6, 'user'),
        ];
        const full = [
            msg('msg_user_0', 0, 'user'),
            msg('msg_assistant_0', 2, 'assistant'),
            msg('msg_remote_hidden', 2.5, 'assistant'),
            msg('msg_user_1', 3, 'user'),
            msg('msg_assistant_1', 5, 'assistant'),
            msg('msg_user_2', 6, 'user'),
            msg('msg_assistant_2', 8, 'assistant', 'remote second answer'),
        ];
        const expectedVisibleIds = [
            'msg_user_0', 'msg_assistant_0', 'msg_user_1',
            'msg_assistant_1', 'msg_user_2', 'msg_assistant_2',
        ];

        const repaired = provider.buildFullExportSnapshotDelta(
            existing,
            ['msg_user_0', 'msg_assistant_0', 'msg_user_1', 'msg_assistant_2', 'msg_user_2'],
            full,
            ['msg_assistant_1'],
        );

        expect(repaired.repairedSnapshot).toBe(true);
        expect(repaired.proven).toBe(true);
        expect(repaired.timelineMessageIds).toEqual(expectedVisibleIds);
        expect(repaired.messages.map((message: any) => message.id)).toEqual(expectedVisibleIds);
        expect(repaired.timelineMessageIds).not.toContain('msg_remote_hidden');
        expect(repaired.messages.at(-1).text).toBe('snapshot second answer');
    });

    it('derives a strict snapshot boundary when timeline metadata is empty', async () => {
        const provider = createProvider();
        const base = [
            msg('msg_snapshot_user', 1, 'user', 'snapshot user'),
            msg('msg_snapshot_assistant', 2, 'assistant', 'snapshot assistant'),
        ];
        provider.readSnapshot = jest.fn().mockResolvedValue(snapshotOf(base, []));
        provider.writeSnapshotAtomic = jest.fn().mockResolvedValue(123);

        await provider.appendSnapshotIncremental(
            'ses_delta',
            ['msg_snapshot_user', 'msg_snapshot_assistant', 'msg_new_user'],
            [msg('msg_new_user', 3, 'user', 'new user')],
        );

        const written = provider.writeSnapshotAtomic.mock.calls[0][1].sessionData;
        expect(written.meta.timelineMessageIds).toEqual([
            'msg_snapshot_user',
            'msg_snapshot_assistant',
            'msg_new_user',
        ]);
        expect(written.messages).toEqual([...base, msg('msg_new_user', 3, 'user', 'new user')]);
    });

    it('persists the current visible turn without requesting a canonical export', async () => {
        const provider = createProvider();
        const boundary = msg('msg_boundary', 2, 'assistant', 'snapshot final');
        provider.readSnapshot = jest.fn().mockResolvedValue(snapshotOf([boundary]));
        provider.writeSnapshotAtomic = jest.fn().mockResolvedValue(456);
        provider.client.exportSession = jest.fn();
        provider.client.getMessageIndex = jest.fn((id: string) => id === 'msg_user_new' ? 3 : 4);
        provider.pendingSnapshotUserTextBySession.set('ses_delta', 'reload window 未显示历史记录');
        provider.assistantTextBufferBySession.set('ses_delta', '这是本轮助手回答。');

        await provider.writeFinalizeSnapshotFromCurrentTurn({
            sessionId: 'ses_delta',
            clientMessageId: 'local-new',
            userMessageId: 'msg_user_new',
            assistantMessageId: 'msg_assistant_new',
        });

        const written = provider.writeSnapshotAtomic.mock.calls[0][1].sessionData;
        expect(written.meta.timelineMessageIds).toEqual([
            'msg_boundary',
            'msg_user_new',
            'msg_assistant_new',
        ]);
        expect(written.messages).toEqual([
            boundary,
            msg('msg_user_new', 3, 'user', 'reload window 未显示历史记录'),
            msg('msg_assistant_new', 4, 'assistant', '这是本轮助手回答。'),
        ]);
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(
            expect.stringContaining('reason=finalize-incremental-write'),
        );
        expect(provider.client.exportSession).not.toHaveBeenCalled();
        expect(provider.pendingSnapshotUserTextBySession.has('ses_delta')).toBe(false);
        expect(provider.assistantTextBufferBySession.has('ses_delta')).toBe(false);
    });

    it('persists only the accepted final assistant message when one turn has multiple assistant stages', async () => {
        const provider = createProvider();
        provider.readSnapshot = jest.fn().mockResolvedValue(undefined);
        provider.writeSnapshotAtomic = jest.fn().mockResolvedValue(456);
        provider.client.exportSession = jest.fn();
        provider.client.getMessageIndex = jest.fn((id: string) => id === 'msg_user_new' ? 1 : 5);
        provider.pendingSnapshotUserTextBySession.set('ses_delta', 'inspect the implementation');

        const firstTemporary = 'A'.repeat(114);
        const secondTemporary = 'B'.repeat(164);
        const finalText = 'F'.repeat(5001);
        provider.appendAssistantBuffer('ses_delta', firstTemporary, 'msg_assistant_tool_1');
        provider.appendAssistantBuffer('ses_delta', secondTemporary, 'msg_assistant_tool_2');
        provider.appendAssistantBuffer('ses_delta', finalText, 'msg_assistant_final');

        await provider.writeFinalizeSnapshotFromCurrentTurn({
            sessionId: 'ses_delta',
            userMessageId: 'msg_user_new',
            assistantMessageId: 'msg_assistant_final',
        });

        const written = provider.writeSnapshotAtomic.mock.calls[0][1].sessionData;
        expect(written.messages).toEqual([
            msg('msg_user_new', 1, 'user', 'inspect the implementation'),
            msg('msg_assistant_final', 5, 'assistant', finalText),
        ]);
        expect(written.messages[1].text).toHaveLength(5001);
        expect(written.messages[1].text).not.toContain(firstTemporary);
        expect(written.messages[1].text).not.toContain(secondTemporary);
        expect(provider.assistantTextBufferByMessageIdBySession.has('ses_delta')).toBe(false);
    });

    it('resumes an active turn from the current assistant ID instead of a stale initial binding', () => {
        const provider = createProvider();
        provider.pendingAssistantMessageIdBySession.set('ses_delta', 'msg_assistant_initial');
        provider.client.getTurnAssistantMsgId = jest.fn().mockReturnValue('msg_assistant_current');
        provider.appendAssistantBuffer('ses_delta', 'temporary status', 'msg_assistant_initial');
        provider.appendAssistantBuffer('ses_delta', 'current answer', 'msg_assistant_current');

        const payload = provider.buildLiveTurnResumePayload(
            'ses_delta',
            'panel-1',
            'webview-1',
            {
                turnId: 'turn-1',
                source: 'sendInFlightBySession',
                streaming: true,
                finalizing: false,
            },
        );

        expect(payload).toEqual(expect.objectContaining({
            assistantMessageId: 'msg_assistant_current',
            assistantText: 'current answer',
        }));
    });

    it('persists append users and only the final assistant presentation', async () => {
        const provider = createProvider();
        const boundary = msg('msg_boundary', 10, 'assistant', 'older snapshot final');
        provider.readSnapshot = jest.fn().mockResolvedValue(snapshotOf([boundary]));
        provider.writeSnapshotAtomic = jest.fn().mockResolvedValue(789);
        provider.client.exportSession = jest.fn();
        const indices: Record<string, number> = {
            msg_root: 11,
            msg_predecessor: 12,
            msg_append: 13,
            msg_successor: 14,
        };
        provider.client.getMessageIndex = jest.fn((id: string) => indices[id]);
        provider.pendingSnapshotUserTextBySession.set('ses_delta', '请你派遣 subagent 计时 1 分钟');
        provider.rawUserTextByMsgId.set('msg_root', '请你派遣 subagent 计时 1 分钟');
        provider.appendAssistantBuffer(
            'ses_delta',
            '将派遣子代理进行非修改性 1 分钟计时。',
            'msg_predecessor',
        );
        provider.recordAppendSnapshotUserMessage(
            'ses_delta',
            'msg_root',
            'msg_append',
            '计时结束后回复 OK。',
        );
        provider.cacheAppendSnapshotMeta({
            sessionId: 'ses_delta',
            roots: [{
                rootMessageId: 'msg_root',
                appendRootUserKey: 'msg_root',
                meta: {
                    appendedPrompts: [{
                        clientMessageId: 'append-client',
                        appendUserMsgId: 'msg_append',
                        text: '计时结束后回复 OK。',
                        status: 'applied',
                    }],
                },
            }],
            reason: 'test',
        });

        provider.prepareAppendSnapshotHandoff('ses_delta', {
            generation: 1,
            predecessorAssistantMsgId: 'msg_predecessor',
            appendUserMsgId: 'msg_append',
            assistantMsgId: 'msg_successor',
        });
        expect(provider.assistantTextBufferBySession.get('ses_delta')).toBe('');
        provider.appendAssistantBuffer('ses_delta', 'OK', 'msg_successor');

        await provider.writeFinalizeSnapshotFromCurrentTurn({
            sessionId: 'ses_delta',
            rootUserMessageId: 'msg_root',
            latestAppendUserMessageId: 'msg_append',
            userMessageId: 'msg_append',
            assistantMessageId: 'msg_successor',
        });

        const written = provider.writeSnapshotAtomic.mock.calls[0][1].sessionData;
        expect(written.meta.timelineMessageIds).toEqual([
            'msg_boundary',
            'msg_root',
            'msg_append',
            'msg_successor',
        ]);
        expect(written.messages).toEqual([
            boundary,
            expect.objectContaining({
                id: 'msg_root',
                role: 'user',
                text: '请你派遣 subagent 计时 1 分钟',
                meta: expect.objectContaining({
                    appendRootUserKey: 'msg_root',
                    appendedPrompts: [expect.objectContaining({
                        appendUserMsgId: 'msg_append',
                        text: '计时结束后回复 OK。',
                    })],
                }),
            }),
            expect.objectContaining({
                id: 'msg_append',
                role: 'user',
                text: '计时结束后回复 OK。',
            }),
            expect.objectContaining({
                id: 'msg_successor',
                role: 'assistant',
                text: 'OK',
                meta: { parentID: 'msg_append' },
            }),
        ]);
        expect(provider.client.exportSession).not.toHaveBeenCalled();
        expect(provider.appendSnapshotTurnStateBySession.has('ses_delta')).toBe(false);
    });

    it('uses pending display text for an attachment-only turn without exporting history', async () => {
        const provider = createProvider();
        provider.readSnapshot = jest.fn().mockResolvedValue(undefined);
        provider.writeSnapshotAtomic = jest.fn().mockResolvedValue(99);
        provider.client.exportSession = jest.fn();
        provider.client.getMessageIndex = jest.fn().mockReturnValue(1);
        provider.pendingSnapshotUserTextBySession.set('ses_delta', '📄 report.txt');

        await provider.writeFinalizeSnapshotFromCurrentTurn({
            sessionId: 'ses_delta',
            userMessageId: 'msg_attachment_user',
        });

        const written = provider.writeSnapshotAtomic.mock.calls[0][1].sessionData;
        expect(written.meta.timelineMessageIds).toEqual(['msg_attachment_user']);
        expect(written.messages).toEqual([
            msg('msg_attachment_user', 1, 'user', '📄 report.txt'),
        ]);
        expect(provider.client.exportSession).not.toHaveBeenCalled();
    });

    it('releases finalize buffers when an incremental snapshot write fails', async () => {
        const provider = createProvider();
        provider.readSnapshot = jest.fn().mockResolvedValue(undefined);
        provider.writeSnapshotAtomic = jest.fn().mockRejectedValue(new Error('disk unavailable'));
        provider.client.exportSession = jest.fn();
        provider.client.getMessageIndex = jest.fn((id: string) => id === 'msg_user_new' ? 1 : 2);
        provider.pendingSnapshotUserTextBySession.set('ses_delta', 'new prompt');
        provider.assistantTextBufferBySession.set('ses_delta', 'new answer');

        await expect(provider.writeFinalizeSnapshotFromCurrentTurn({
            sessionId: 'ses_delta',
            userMessageId: 'msg_user_new',
            assistantMessageId: 'msg_assistant_new',
        })).resolves.toBeUndefined();

        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(
            expect.stringContaining('reason=finalize-incremental-error'),
        );
        expect(provider.client.exportSession).not.toHaveBeenCalled();
        expect(provider.pendingSnapshotUserTextBySession.has('ses_delta')).toBe(false);
        expect(provider.assistantTextBufferBySession.has('ses_delta')).toBe(false);
    });

    it('appendSnapshotIncremental preserves existing same-ID fields/order and appends a proven canonical ID', async () => {
        const provider = createProvider();
        const baseA = { ...msg('msg_a', 1, 'user', 'snapshot user'), meta: { stable: 'a' }, future: 'keep-a' };
        const boundary = { ...msg('msg_boundary', 2, 'assistant', 'snapshot final'), meta: { stable: 'b' }, future: 'keep-b' };
        provider.readSnapshot = jest.fn().mockResolvedValue(snapshotOf([baseA, boundary]));
        provider.writeSnapshotAtomic = jest.fn().mockResolvedValue(123);

        await provider.appendSnapshotIncremental(
            'ses_delta',
            ['msg_a', 'msg_boundary', 'msg_new'],
            [
                { ...boundary, text: 'remote rewrite', meta: { stable: 'remote' }, future: 'replace-b' },
                msg('msg_new', 3, 'assistant', 'new canonical'),
            ],
            'Updated title',
        );

        const written = provider.writeSnapshotAtomic.mock.calls[0][1].sessionData;
        expect(written.meta.timelineMessageIds).toEqual(['msg_a', 'msg_boundary', 'msg_new']);
        expect(written.messages).toEqual([baseA, boundary, msg('msg_new', 3, 'assistant', 'new canonical')]);
    });

    it('leaves an existing snapshot untouched when the current turn has no visible records', async () => {
        const provider = createProvider();
        const base = msg('msg_boundary', 2, 'assistant', 'snapshot final');
        provider.readSnapshot = jest.fn().mockResolvedValue(snapshotOf([base]));
        provider.writeSnapshotAtomic = jest.fn().mockResolvedValue(123);
        provider.client.exportSession = jest.fn();

        await provider.writeFinalizeSnapshotFromCurrentTurn({ sessionId: 'ses_delta' });

        expect(provider.writeSnapshotAtomic).not.toHaveBeenCalled();
        expect(provider.client.exportSession).not.toHaveBeenCalled();
    });

    it('does not replace an existing snapshot record on finalize collision', async () => {
        const provider = createProvider();
        const base = { ...msg('msg_boundary', 2, 'assistant', 'snapshot final'), meta: { stable: true }, future: 'keep' };
        provider.readSnapshot = jest.fn().mockResolvedValue(snapshotOf([base]));
        provider.writeSnapshotAtomic = jest.fn().mockResolvedValue(123);
        provider.client.exportSession = jest.fn();
        provider.client.getMessageIndex = jest.fn().mockReturnValue(2);
        provider.assistantTextBufferBySession.set('ses_delta', 'remote rewrite');

        await provider.writeFinalizeSnapshotFromCurrentTurn({
            sessionId: 'ses_delta',
            assistantMessageId: 'msg_boundary',
        });

        expect(provider.writeSnapshotAtomic.mock.calls[0][1].sessionData.messages).toEqual([base]);
        expect(provider.client.exportSession).not.toHaveBeenCalled();
    });

    it('allows missing-snapshot full export to establish initial authoritative history', async () => {
        const provider = createProvider();
        const webview = { postMessage: jest.fn() };
        provider.readSnapshot = jest.fn().mockResolvedValue(undefined);
        provider.client.exportSessionRecent = jest.fn().mockRejectedValue(new Error('recent unavailable'));
        provider.client.exportSession = jest.fn().mockResolvedValue({ phase: 'full' });
        provider.formatSession = jest.fn().mockReturnValue({ title: 'Full', messages: [msg('msg_full', 1)] });
        provider.injectChangeLists = jest.fn(async (_sessionId: string, formatted: any) => formatted);

        const result = await provider.repostSessionDataForSendInitGuardCompensation(
            { sessionId: 'ses_delta', panelId: 'panel-1', webviewInstanceId: 'wv-1', token: 'token' },
            webview,
            () => true,
        );

        const payload = webview.postMessage.mock.calls[0][0];
        expect(result.phase).toBe('full');
        expect(payload.meta.hydrationCoverage).toBe('authoritativeHistoryComplete');
    });

    it('keeps recent-only history explicitly continuity-unknown', async () => {
        const provider = createProvider();
        const webview = { postMessage: jest.fn() };
        provider.readSnapshot = jest.fn().mockResolvedValue(undefined);
        provider.client.exportSessionRecent = jest.fn().mockResolvedValue({ phase: 'recent' });
        provider.formatSession = jest.fn().mockReturnValue({
            title: 'Recent',
            messages: [msg('msg_user_1', 1, 'user'), msg('msg_assistant_1', 2, 'assistant')],
        });
        provider.injectChangeLists = jest.fn(async (_sessionId: string, formatted: any) => formatted);

        const result = await provider.repostSessionDataForSendInitGuardCompensation(
            { sessionId: 'ses_delta', panelId: 'panel-1', webviewInstanceId: 'wv-1', token: 'token' },
            webview,
            () => true,
        );

        expect(result.phase).toBe('recent');
        expect(webview.postMessage.mock.calls[0][0].meta.hydrationCoverage).toBe('deltaContinuityUnknown');
    });

    it('keeps flag-false fallback snapshot-only and continuity-unknown', async () => {
        const provider = createProvider();
        const webview = { postMessage: jest.fn() };
        const base = msg('msg_boundary', 2, 'assistant', 'snapshot');
        provider.snapshotDeltaContinuityRepairEnabled = false;
        provider.readSnapshot = jest.fn().mockResolvedValue(snapshotOf([base]));
        provider.client.exportSessionRecent = jest.fn().mockResolvedValue({ phase: 'recent' });
        provider.client.exportSession = jest.fn();
        provider.formatSession = jest.fn().mockReturnValue({ title: 'Recent', messages: [msg('msg_unrelated', 3)] });
        provider.injectChangeLists = jest.fn(async (_sessionId: string, formatted: any) => formatted);

        const result = await provider.repostSessionDataForSendInitGuardCompensation(
            { sessionId: 'ses_delta', panelId: 'panel-1', webviewInstanceId: 'wv-1', token: 'token' },
            webview,
            () => true,
        );

        expect(result).toMatchObject({ phase: 'snapshot', reason: 'repair-disabled' });
        expect(provider.client.exportSession).not.toHaveBeenCalled();
        expect(webview.postMessage.mock.calls.at(-1)[0]).toMatchObject({
            messages: [base],
            meta: { hydrationCoverage: 'deltaContinuityUnknown' },
        });
    });
});

describe('W5A paths and guards', () => {
    const providerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'SidebarProvider.ts'), 'utf8');
    const initializerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'history', 'SidebarSessionInitializer.ts'), 'utf8');
    const controllerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'controllers', 'SessionCommandController.ts'), 'utf8');

    it('site E surrounds recent hydration with session, epoch, liveness, and exact-webview identity guards', () => {
        const siteStart = initializerSource.indexOf('const recentSelectionEpoch = host.sessionSelectionEpoch');
        const siteEnd = initializerSource.indexOf("host.uiDebugChannel.appendLine(`[EXT][SNAP_SAVE_SKIP] sessionId=${recentSessionId} reason=sendInit:recent", siteStart);
        expect(siteStart).toBeGreaterThanOrEqual(0);
        expect(siteEnd).toBeGreaterThan(siteStart);
        const siteE = initializerSource.slice(siteStart, siteEnd);

        expect(siteE).toMatch(/currentSessionId\s*===\s*recentSessionId/);
        expect(siteE).toContain('sessionSelectionEpoch');
        expect(siteE).toContain('webviewLivenessCurrent');
        expect(siteE).toContain('_webviewInstanceId');
        expect(siteE.match(/isStill|guard|stale/gi)?.length || 0).toBeGreaterThanOrEqual(2);
    });

    it('liveTurnHistory candidate selection continues to skip an existing snapshot ID', () => {
        const provider = createProvider();
        const candidates = provider.computeRecentAppendCandidates(
            new Set(['msg_boundary']),
            2,
            [msg('msg_boundary', 2, 'assistant', 'remote duplicate')],
        );

        expect(candidates).toEqual([]);
    });

    it('fresh active sendInit remains history merge-only followed by resume', () => {
        const chainStart = initializerSource.indexOf('EXT: webviewAutoRescue.hardRescue.sendInitGuard.defer');
        const chainEnd = initializerSource.indexOf('await host.ensureSessionUndoReady(recentSessionId', chainStart);
        const freshChain = initializerSource.slice(chainStart, chainEnd);
        const historyIndex = freshChain.indexOf('postLiveTurnHistoryForSendInitGuardDefer');
        const resumeIndex = freshChain.indexOf('postLiveTurnResumeForSendInitGuardDefer');

        expect(historyIndex).toBeGreaterThanOrEqual(0);
        expect(resumeIndex).toBeGreaterThan(historyIndex);
        expect(freshChain).not.toContain("type: 'sessionData'");
    });

    it('routes hydration families A-E around the generic incoming-wins merge', () => {
        const familyRanges = [
            ['private async postLiveTurnHistoryForSendInitGuardDefer', 'private logSendInitGuardCompensation'],
            ['private async repostSessionDataForSendInitGuardCompensation', 'private async runPendingSendInitGuardCompensation'],
            ['private async repostActiveSessionDataForWebviewSoftRescue', 'private async executeWebviewAutoRescueSoftRescue'],
            ['private async selectSession(', 'private async newSession('],
            ['const recentSelectionEpoch = host.sessionSelectionEpoch', '[EXT][SNAP_SAVE_SKIP] sessionId=${recentSessionId} reason=sendInit:recent'],
        ];

        for (const [startMarker, endMarker] of familyRanges) {
            const ownerSource = startMarker.includes('host.sessionSelectionEpoch')
                ? initializerSource : (startMarker.includes('private async selectSession(') ? controllerSource : providerSource);
            const start = ownerSource.indexOf(startMarker);
            const end = ownerSource.indexOf(endMarker, start);
            expect(start).toBeGreaterThanOrEqual(0);
            expect(end).toBeGreaterThan(start);
            const family = ownerSource.slice(start, end);
            expect(family).toContain('buildImmutableSnapshotWithProvenSuffix');
            expect(family).not.toContain('mergeSessionMessagesById(');
        }
    });
});
