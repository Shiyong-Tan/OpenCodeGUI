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
    commands: {
        executeCommand: async () => undefined,
    },
    env: {
        clipboard: {
            readText: async () => '',
        },
    },
}), { virtual: true });

import { SidebarProvider } from '../../SidebarProvider';
import { OpenCodeDiffProvider } from '../../OpenCodeDiffProvider';
import { buildChainedTakeoverScenario, buildSuccessfulTakeoverScenario } from '../helpers/continuation-factories';

const createdProviders: Array<{ dispose: () => Promise<void> }> = [];

function createProvider(): any {
    const context: any = {
        globalState: {
            get: () => undefined,
            update: () => Promise.resolve(),
        },
        extensionUri: { fsPath: 'D:\\0.Code\\OpenCodeGUI' },
    };
    const diffProvider = { updateFromSnapshot: jest.fn() } as unknown as OpenCodeDiffProvider;
    const provider = new SidebarProvider(context, context.extensionUri, diffProvider) as any;
    createdProviders.push(provider);
    provider.client = {
        getTurnAssistantMsgId: jest.fn().mockReturnValue('msg_owner_a'),
        getLastTurnCommitBase: jest.fn().mockReturnValue(null),
        wasChangeListEmitted: jest.fn().mockReturnValue(false),
        markChangeListEmitted: jest.fn().mockReturnValue(true),
        getCommitHashesForMessageIds: jest.fn().mockResolvedValue([]),
        updateSessionBaseCommitAfterBind: jest.fn().mockResolvedValue(undefined),
        dispose: jest.fn().mockResolvedValue(undefined),
    };
    provider.uiDebugChannel = { appendLine: jest.fn() };
    provider.gitUndoEnabled = true;
    return provider;
}

afterEach(async () => {
    await Promise.all(createdProviders.splice(0).map((provider) => typeof provider.dispose === 'function' ? provider.dispose() : undefined));
});

describe('SidebarProvider Task 6 current-owner changelist routing', () => {
    it('reanchors an existing changelist record to the resolved current owner instead of preserving stale historical anchor', async () => {
        const provider = createProvider();
        const scenario = buildSuccessfulTakeoverScenario();
        provider.readPersistedSessionMap = jest.fn().mockResolvedValue({
            ...scenario.sessionMap,
            continuation: scenario.handoffAfterTakeover,
            msgToCommit: {
                ...scenario.sessionMap.msgToCommit,
                [scenario.msgB]: scenario.commitB,
            },
        });
        provider.readChangeLists = jest.fn().mockResolvedValue([
            {
                id: 'system:changeList:head1',
                commitHead: 'head1',
                commitBase: 'base1',
                files: ['src/a.ts'],
                anchorMessageId: scenario.msgA,
                createdAt: 1,
            },
        ]);
        provider.writeChangeLists = jest.fn().mockResolvedValue(undefined);

        await provider.upsertChangeList('ses_task6', {
            id: 'system:changeList:head1',
            commitHead: 'head1',
            commitBase: 'base1',
            files: ['src/a.ts', 'src/b.ts'],
            anchorMessageId: scenario.msgB,
            createdAt: 2,
        });

        expect(provider.writeChangeLists).toHaveBeenCalledWith(
            'ses_task6',
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'system:changeList:head1',
                    anchorMessageId: scenario.msgB,
                    files: ['src/a.ts', 'src/b.ts'],
                }),
            ])
        );
    });

    it('emits diff file list anchored to the resolved current visible owner during continuation', async () => {
        const provider = createProvider();
        const scenario = buildSuccessfulTakeoverScenario();
        provider.readPersistedSessionMap = jest.fn().mockResolvedValue({
            ...scenario.sessionMap,
            continuation: scenario.handoffAfterTakeover,
            msgToCommit: {
                ...scenario.sessionMap.msgToCommit,
                [scenario.msgB]: scenario.commitB,
            },
        });
        provider.client.getTurnAssistantMsgId.mockReturnValue(scenario.msgA);
        provider.resolveInternalRepo = jest.fn().mockResolvedValue({ repoId: 'repo1', gitDir: 'g', indexFile: 'i', workTree: 'w' });
        provider.getInternalHeadCommit = jest.fn().mockResolvedValue('head2');
        provider.getInternalParentCommit = jest.fn().mockResolvedValue('base2');
        provider.getInternalDiffFileSet = jest.fn().mockResolvedValue(new Set(['src/continued.ts']));
        provider.getInternalDiffStats = jest.fn().mockResolvedValue({ 'src/continued.ts': { additions: 3, deletions: 1 } });
        provider.readChangeLists = jest.fn().mockResolvedValue([]);
        provider.upsertChangeList = jest.fn().mockResolvedValue(undefined);
        const webview = { postMessage: jest.fn() } as any;

        await provider.emitDiffFileList({
            sessionId: 'ses_task6',
            assistantMessageId: scenario.msgA,
            commitResult: {
                status: 'committed',
                msgToCommit: 'head2',
                msgToBaseCommit: 'base2',
                touchedFiles: ['src/continued.ts'],
            },
        }, webview);

        expect(webview.postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'diffFileList',
            sessionId: 'ses_task6',
            anchorMessageId: scenario.msgB,
            commitHead: 'head2',
            commitBase: 'base2',
        }));
        expect(provider.upsertChangeList).toHaveBeenCalledWith(
            'ses_task6',
            expect.objectContaining({
                anchorMessageId: scenario.msgB,
                commitHead: 'head2',
                commitBase: 'base2',
            }),
            { preserveAuthoritativeFiles: true }
        );
    });

    it('keeps failed-continuation changelist updates anchored to the current owner and appends edits', async () => {
        const provider = createProvider();
        const scenario = buildSuccessfulTakeoverScenario();
        provider.readPersistedSessionMap = jest.fn().mockResolvedValue({
            ...scenario.sessionMap,
            continuation: scenario.handoffAfterTakeover,
            msgToCommit: {
                ...scenario.sessionMap.msgToCommit,
                [scenario.msgB]: scenario.commitB,
            },
        });
        provider.readChangeLists = jest.fn().mockResolvedValue([
            {
                id: 'system:changeList:head3',
                commitHead: 'head3',
                commitBase: 'base3',
                files: ['src/original.ts'],
                anchorMessageId: scenario.msgB,
                createdAt: 1,
            },
        ]);
        provider.writeChangeLists = jest.fn().mockResolvedValue(undefined);

        await provider.upsertChangeList('ses_task6', {
            id: 'system:changeList:head3',
            commitHead: 'head3',
            commitBase: 'base3',
            files: ['src/original.ts', 'src/appended.ts'],
            anchorMessageId: scenario.msgA,
            createdAt: 2,
        });

        expect(provider.writeChangeLists).toHaveBeenCalledWith(
            'ses_task6',
            expect.arrayContaining([
                expect.objectContaining({
                    id: 'system:changeList:head3',
                    anchorMessageId: scenario.msgB,
                    files: ['src/original.ts', 'src/appended.ts'],
                }),
            ])
        );
    });

    it('injectChangeLists resolves stale anchors to current owner so only one changelist card appears per owner', async () => {
        const provider = createProvider();
        const scenario = buildSuccessfulTakeoverScenario();
        provider.readPersistedSessionMap = jest.fn().mockResolvedValue({
            ...scenario.sessionMap,
            continuation: scenario.handoffAfterTakeover,
            msgToCommit: {
                ...scenario.sessionMap.msgToCommit,
                [scenario.msgB]: scenario.commitB,
            },
        });
        provider.readChangeLists = jest.fn().mockResolvedValue([
            {
                id: 'system:changeList:head4',
                commitHead: 'head4',
                commitBase: 'base4',
                files: ['src/stale.ts'],
                anchorMessageId: scenario.msgA,
                createdAt: 1,
            },
        ]);
        provider.readCanceledTurns = jest.fn().mockResolvedValue([]);
        provider.normalizeDisplayMessagesForSnapshot = jest.fn().mockImplementation((msgs: any[]) => msgs);

        const formatted = {
            title: 'Test Session',
            messages: [
                { id: 'msg_user_1', role: 'user', text: 'hello' },
                { id: scenario.msgB, role: 'assistant', text: 'response' },
            ],
        };

        const result = await provider.injectChangeLists('ses_task6', formatted);

        const changeListMessages = result.messages.filter(
            (m: any) => m.meta?.kind === 'changeList'
        );
        expect(changeListMessages.length).toBe(1);
        expect(changeListMessages[0].meta.commitHead).toBe('head4');
        expect(changeListMessages[0].meta.anchorMessageId).toBe(scenario.msgB);
        expect(changeListMessages[0].meta.stableAnchorMessageId).toBe(scenario.msgB);
        const ownerIndex = result.messages.findIndex((m: any) => m.id === scenario.msgB);
        const clIndex = result.messages.findIndex((m: any) => m.id === 'system:changeList:head4');
        expect(clIndex).toBeGreaterThan(ownerIndex);
    });

    it('injectChangeLists deduplicates when multiple records share the same resolved current owner', async () => {
        const provider = createProvider();
        const scenario = buildChainedTakeoverScenario();
        provider.readPersistedSessionMap = jest.fn().mockResolvedValue({
            ...scenario.sessionMap,
            continuation: scenario.handoffAfterC,
            msgToCommit: {
                ...scenario.sessionMap.msgToCommit,
                [scenario.msgC]: scenario.commitC,
            },
        });
        provider.readChangeLists = jest.fn().mockResolvedValue([
            {
                id: 'system:changeList:head5a',
                commitHead: 'head5a',
                commitBase: 'base5',
                files: ['src/first.ts'],
                anchorMessageId: scenario.msgA,
                createdAt: 1,
            },
            {
                id: 'system:changeList:head5b',
                commitHead: 'head5b',
                commitBase: 'base5',
                files: ['src/second.ts'],
                anchorMessageId: scenario.msgC,
                createdAt: 2,
            },
        ]);
        provider.readCanceledTurns = jest.fn().mockResolvedValue([]);
        provider.normalizeDisplayMessagesForSnapshot = jest.fn().mockImplementation((msgs: any[]) => msgs);

        const formatted = {
            title: 'Test Session',
            messages: [
                { id: 'msg_user_1', role: 'user', text: 'hello' },
                { id: scenario.msgC, role: 'assistant', text: 'response' },
            ],
        };

        const result = await provider.injectChangeLists('ses_task6', formatted);

        const changeListMessages = result.messages.filter(
            (m: any) => m.meta?.kind === 'changeList'
        );
        expect(changeListMessages.length).toBe(2);
        const ownerIndex = result.messages.findIndex((m: any) => m.id === scenario.msgC);
        for (const cl of changeListMessages) {
            const clIndex = result.messages.findIndex((m: any) => m.id === cl.id);
            expect(clIndex).toBeGreaterThan(ownerIndex);
        }

        const firstClIndex = result.messages.findIndex((m: any) => m.meta?.kind === 'changeList');
        expect(firstClIndex).toBeGreaterThan(ownerIndex);
    });

    it('preserves msg_user ids when resolving visible owners through the real production helper', async () => {
        const provider = createProvider();
        const scenario = buildSuccessfulTakeoverScenario();
        provider.readPersistedSessionMap = jest.fn().mockResolvedValue({
            ...scenario.sessionMap,
            continuation: scenario.handoffAfterTakeover,
            msgToCommit: {
                ...scenario.sessionMap.msgToCommit,
                [scenario.msgB]: scenario.commitB,
            },
        });

        await expect(provider.resolveCurrentVisibleOwnerMessageId('ses_task6', 'msg_user_1')).resolves.toBe('msg_user_1');
        await expect(provider.resolveCurrentVisibleOwnerMessageId('ses_task6', scenario.msgA)).resolves.toBe(scenario.msgB);
    });
});
