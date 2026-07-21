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
import { buildChainedTakeoverScenario, buildSuccessfulTakeoverScenario, makeSessionEntry } from '../helpers/continuation-factories';

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
    provider.currentSessionId = 'ses_task8';
    return provider;
}

afterEach(async () => {
    await Promise.all(createdProviders.splice(0).map((provider) => typeof provider.dispose === 'function' ? provider.dispose() : undefined));
});

describe('SidebarProvider Task 8 snapshot/reload current-owner semantics', () => {
    it('does not collapse assistant messages from separate ordinary turns', async () => {
        const provider = createProvider();
        provider.readPersistedSessionMap = jest.fn().mockResolvedValue({
            schemaVersion: 1,
            sessionId: 'ses_task8',
            entries: [
                makeSessionEntry({ turnKey: 'local-turn-1', finalAssistantMsgId: 'msg_owner_a' }),
                makeSessionEntry({ turnKey: 'local-turn-2', finalAssistantMsgId: 'msg_owner_b' }),
            ],
            continuation: {
                currentOwnerMsgId: 'msg_owner_b',
                predecessorOwnerMsgId: 'msg_owner_a',
                continuationSequence: 3,
            },
        });

        const payload = await provider.buildSnapshotSessionPayload({
            type: 'sessionData',
            sessionId: 'ses_task8',
            title: 'Separate turns',
            messages: [
                { role: 'user', id: 'msg_user_1', text: 'first', messageIndex: 1 },
                { role: 'assistant', id: 'msg_owner_a', text: 'first answer', messageIndex: 2, meta: { parentID: 'msg_user_1' } },
                { role: 'user', id: 'msg_user_2', text: 'second', messageIndex: 3 },
                { role: 'assistant', id: 'msg_owner_b', text: 'second answer', messageIndex: 4, meta: { parentID: 'msg_user_2' } },
            ],
            meta: {
                timelineMessageIds: ['msg_user_1', 'msg_owner_a', 'msg_user_2', 'msg_owner_b'],
            },
        });

        expect(payload.meta.timelineMessageIds).toEqual([
            'msg_user_1', 'msg_owner_a', 'msg_user_2', 'msg_owner_b',
        ]);
        expect(payload.messages.map((message: any) => message.id)).toEqual([
            'msg_user_1', 'msg_owner_a', 'msg_user_2', 'msg_owner_b',
        ]);
    });

    it('collapses persisted snapshot visibility from A -> B down to current owner B only', async () => {
        const provider = createProvider();
        const scenario = buildSuccessfulTakeoverScenario();
        provider.readPersistedSessionMap = jest.fn().mockResolvedValue({
            ...scenario.sessionMap,
            continuation: scenario.handoffAfterTakeover,
            entries: [
                ...scenario.sessionMap.entries,
                makeSessionEntry({
                    turnKey: 'cont:2',
                    finalAssistantMsgId: scenario.msgB,
                    commitHash: scenario.commitB,
                }),
            ],
            msgToCommit: {
                ...scenario.sessionMap.msgToCommit,
                [scenario.msgB]: scenario.commitB,
            },
        });

        const payload = await provider.buildSnapshotSessionPayload({
            type: 'sessionData',
            sessionId: 'ses_task8',
            title: 'Task 8',
            messages: [
                { role: 'user', id: 'msg_user_1', text: 'please continue', messageIndex: 1 },
                { role: 'assistant', id: scenario.msgA, text: 'old final', messageIndex: 2 },
                { role: 'assistant', id: scenario.msgB, text: 'new final', messageIndex: 3 },
                { role: 'system', id: 'system:changeList:headB', text: '', meta: { kind: 'changeList', anchorMessageId: scenario.msgA } },
            ],
            meta: {
                timelineMessageIds: ['msg_user_1', scenario.msgA, scenario.msgB, 'system:changeList:headB'],
            },
        });

        expect(payload.meta.timelineMessageIds).toEqual(['msg_user_1', scenario.msgB, 'system:changeList:headB']);
        expect(payload.messages.map((message: any) => message.id)).toEqual(['msg_user_1', scenario.msgB, 'system:changeList:headB']);
    });

    it('preserves current-owner visibility on failed continuation while appending changelist state', async () => {
        const provider = createProvider();
        provider.readSnapshot = jest.fn().mockResolvedValue({
            obj: {
                sessionId: 'ses_task8',
                exportedAt: 1,
                sessionData: {
                    type: 'sessionData',
                    sessionId: 'ses_task8',
                    title: 'Task 8',
                    messages: [
                        { role: 'user', id: 'msg_user_1', text: 'continue', messageIndex: 1 },
                        { role: 'assistant', id: 'msg_owner_a', text: 'stable owner', messageIndex: 2 },
                    ],
                    segments: [],
                    meta: { timelineMessageIds: ['msg_user_1', 'msg_owner_a'] },
                },
            },
            bytes: 10,
        });
        provider.writeSnapshotAtomic = jest.fn().mockResolvedValue(100);

        await provider.appendSnapshotIncremental(
            'ses_task8',
            ['msg_user_1', 'msg_owner_a', 'system:changeList:headA'],
            [
                { role: 'user', id: 'msg_user_1', text: 'continue', messageIndex: 1 },
                { role: 'assistant', id: 'msg_owner_a', text: 'stable owner', messageIndex: 2 },
                { role: 'system', id: 'system:changeList:headA', text: '', meta: { kind: 'changeList' } },
            ],
            'Task 8',
        );

        const written = provider.writeSnapshotAtomic.mock.calls[0][1];
        expect(written.sessionData.meta.timelineMessageIds).toEqual(['msg_user_1', 'msg_owner_a', 'system:changeList:headA']);
        expect(written.sessionData.messages.map((message: any) => message.id)).toEqual(['msg_user_1', 'msg_owner_a', 'system:changeList:headA']);
    });

    it('collapses the latest chained predecessor B -> C reload visibility to owner C', async () => {
        const provider = createProvider();
        const scenario = buildChainedTakeoverScenario();
        provider.readPersistedSessionMap = jest.fn().mockResolvedValue({
            ...scenario.sessionMap,
            continuation: scenario.handoffAfterC,
            entries: [
                ...scenario.sessionMap.entries,
                makeSessionEntry({
                    turnKey: 'cont:3',
                    finalAssistantMsgId: scenario.msgC,
                    commitHash: scenario.commitC,
                }),
            ],
            msgToCommit: {
                ...scenario.sessionMap.msgToCommit,
                [scenario.msgC]: scenario.commitC,
            },
        });

        const payload = await provider.buildSnapshotSessionPayload({
            type: 'sessionData',
            sessionId: 'ses_task8',
            title: 'Task 8 chain',
            messages: [
                { role: 'user', id: 'msg_user_1', text: 'continue', messageIndex: 1 },
                { role: 'assistant', id: scenario.msgB, text: 'B', messageIndex: 3 },
                { role: 'assistant', id: scenario.msgC, text: 'C', messageIndex: 4 },
            ],
            meta: {
                timelineMessageIds: ['msg_user_1', scenario.msgB, scenario.msgC],
            },
        });

        expect(payload.meta.timelineMessageIds).toEqual(['msg_user_1', scenario.msgC]);
        expect(payload.messages.map((message: any) => message.id)).toEqual(['msg_user_1', scenario.msgC]);
    });

    it('does not let a finalize collision replace the persisted current-owner record', async () => {
        const provider = createProvider();
        const currentOwner = {
            role: 'assistant',
            id: 'msg_owner_b',
            text: 'persisted owner text',
            messageIndex: 3,
            meta: { owner: 'current', stable: true },
            futureOwnerField: { keep: true },
        };
        provider.readPersistedSessionMap = jest.fn().mockResolvedValue(null);
        provider.readSnapshot = jest.fn().mockResolvedValue({
            obj: {
                sessionId: 'ses_task8',
                exportedAt: 1,
                sessionData: {
                    type: 'sessionData',
                    sessionId: 'ses_task8',
                    title: 'Task 8',
                    messages: [currentOwner],
                    segments: [],
                    meta: { timelineMessageIds: ['msg_owner_b'] },
                },
            },
            bytes: 10,
        });
        provider.writeSnapshotAtomic = jest.fn().mockResolvedValue(100);
        provider.client.exportSession = jest.fn().mockResolvedValue({});
        provider.formatSession = jest.fn().mockReturnValue({
            title: 'Task 8 remote',
            messages: [{
                ...currentOwner,
                text: 'remote collision text',
                meta: { owner: 'remote', stable: false },
                futureOwnerField: { keep: false },
            }],
        });

        await provider.writeFinalizeSnapshotFromCanonicalSession({
            sessionId: 'ses_task8',
            assistantMessageId: 'msg_owner_b',
        });

        const written = provider.writeSnapshotAtomic.mock.calls[0][1];
        expect(written.sessionData.meta.timelineMessageIds).toEqual(['msg_owner_b']);
        expect(written.sessionData.messages).toEqual([currentOwner]);
    });
});
