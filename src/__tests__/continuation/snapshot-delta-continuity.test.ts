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

    it('preserves snapshot-only data when a full export cannot reach its boundary', async () => {
        const provider = createProvider();
        const base = msg('msg_boundary', 2, 'assistant', 'snapshot final');
        provider.readSnapshot = jest.fn().mockResolvedValue(snapshotOf([base]));
        provider.writeSnapshotAtomic = jest.fn().mockResolvedValue(123);
        provider.client.exportSession = jest.fn().mockResolvedValue({});
        provider.formatSession = jest.fn().mockReturnValue({
            title: 'Remote',
            messages: [msg('msg_unrelated', 99, 'assistant', 'unreachable export')],
        });

        await provider.writeFinalizeSnapshotFromCanonicalSession({ sessionId: 'ses_delta' });

        const written = provider.writeSnapshotAtomic.mock.calls[0][1].sessionData;
        expect(written.meta.timelineMessageIds).toEqual(['msg_boundary']);
        expect(written.messages).toEqual([base]);
    });

    it('does not replace an existing snapshot record on finalize collision', async () => {
        const provider = createProvider();
        const base = { ...msg('msg_boundary', 2, 'assistant', 'snapshot final'), meta: { stable: true }, future: 'keep' };
        provider.readSnapshot = jest.fn().mockResolvedValue(snapshotOf([base]));
        provider.writeSnapshotAtomic = jest.fn().mockResolvedValue(123);
        provider.client.exportSession = jest.fn().mockResolvedValue({});
        provider.formatSession = jest.fn().mockReturnValue({
            title: 'Remote',
            messages: [{ ...base, text: 'remote rewrite', meta: { stable: false }, future: 'replace' }],
        });

        await provider.writeFinalizeSnapshotFromCanonicalSession({ sessionId: 'ses_delta' });

        expect(provider.writeSnapshotAtomic.mock.calls[0][1].sessionData.messages).toEqual([base]);
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

    it('site E surrounds recent hydration with session, epoch, liveness, and exact-webview identity guards', () => {
        const siteStart = providerSource.indexOf('const recentSelectionEpoch = this.sessionSelectionEpoch');
        const siteEnd = providerSource.indexOf("this.uiDebugChannel.appendLine(`[EXT][SNAP_SAVE_SKIP] sessionId=${recentSessionId} reason=sendInit:recent", siteStart);
        expect(siteStart).toBeGreaterThanOrEqual(0);
        expect(siteEnd).toBeGreaterThan(siteStart);
        const siteE = providerSource.slice(siteStart, siteEnd);

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
        const chainStart = providerSource.indexOf('EXT: webviewAutoRescue.hardRescue.sendInitGuard.defer');
        const chainEnd = providerSource.indexOf('await this.ensureSessionUndoReady(recentSessionId', chainStart);
        const freshChain = providerSource.slice(chainStart, chainEnd);
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
            ['case "selectSession"', 'case "clipboardImage"'],
            ['const recentSelectionEpoch = this.sessionSelectionEpoch', '[EXT][SNAP_SAVE_SKIP] sessionId=${recentSessionId} reason=sendInit:recent'],
        ];

        for (const [startMarker, endMarker] of familyRanges) {
            const start = providerSource.indexOf(startMarker);
            const end = providerSource.indexOf(endMarker, start);
            expect(start).toBeGreaterThanOrEqual(0);
            expect(end).toBeGreaterThan(start);
            const family = providerSource.slice(start, end);
            expect(family).toContain('buildImmutableSnapshotWithProvenSuffix');
            expect(family).not.toContain('mergeSessionMessagesById(');
        }
    });
});
