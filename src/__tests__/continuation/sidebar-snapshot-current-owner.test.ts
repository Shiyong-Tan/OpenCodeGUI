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
    it('selects the newest tool-call assistant generation using OpenCode info.time timestamps', () => {
        const provider = createProvider();
        const formatted = provider.formatSession({
            session: { id: 'ses_task8', title: 'Active append' },
            messages: [
                { info: { id: 'msg_user', role: 'user' }, parts: [{ type: 'text', text: 'continue' }] },
                {
                    info: {
                        id: 'msg_old', role: 'assistant', parentID: 'msg_user', finish: 'tool-calls',
                        time: { created: 100, completed: 200 },
                    },
                    parts: [{ type: 'text', text: 'old stage' }],
                },
                {
                    info: {
                        id: 'msg_current', role: 'assistant', parentID: 'msg_user', finish: 'tool-calls',
                        time: { created: 300 },
                    },
                    parts: [{ type: 'text', text: 'current stage' }],
                },
            ],
        });

        expect(formatted.messages.map((message: any) => message.id)).toEqual(['msg_user', 'msg_current']);
        expect(formatted.messages[1]).toEqual(expect.objectContaining({
            text: 'current stage',
            meta: expect.objectContaining({ parentID: 'msg_user', timeCreated: 300 }),
        }));
    });

    it('uses the last OpenCode assistant generation when timestamps are unavailable', () => {
        const provider = createProvider();
        const formatted = provider.formatSession({
            session: { id: 'ses_task8', title: 'Timestamp fallback' },
            messages: [
                { info: { id: 'msg_user', role: 'user' }, parts: [{ type: 'text', text: 'continue' }] },
                {
                    info: { id: 'msg_old', role: 'assistant', parentID: 'msg_user', finish: 'tool-calls' },
                    parts: [{ type: 'text', text: 'old stage' }],
                },
                {
                    info: { id: 'msg_current', role: 'assistant', parentID: 'msg_user', finish: 'tool-calls' },
                    parts: [{ type: 'text', text: 'current stage' }],
                },
            ],
        });

        expect(formatted.messages.map((message: any) => message.id)).toEqual(['msg_user', 'msg_current']);
    });

    it('keeps the latest assistant identity while inheriting text across a tool-only generation', () => {
        const provider = createProvider();
        const formatted = provider.formatSession({
            session: { id: 'ses_task8', title: 'Recovered active turn' },
            messages: [
                { info: { id: 'msg_user', role: 'user' }, parts: [{ type: 'text', text: 'continue' }] },
                {
                    info: {
                        id: 'msg_text', role: 'assistant', parentID: 'msg_user', finish: 'tool-calls',
                        time: { created: 100, completed: 200 },
                    },
                    parts: [{ type: 'text', text: 'keep this visible while tools continue' }],
                },
                {
                    info: {
                        id: 'msg_tool_only', role: 'assistant', parentID: 'msg_user', finish: 'tool-calls',
                        time: { created: 300 },
                    },
                    parts: [{ type: 'tool', state: { status: 'running' } }],
                },
            ],
        });

        expect(formatted.messages.map((message: any) => message.id)).toEqual(['msg_user', 'msg_tool_only']);
        expect(formatted.messages[1]).toEqual(expect.objectContaining({
            text: 'keep this visible while tools continue',
            meta: expect.objectContaining({
                parentID: 'msg_user',
                timeCreated: 300,
                timeCompleted: undefined,
                inheritedTextFromAssistantId: 'msg_text',
            }),
        }));
    });

    it('excludes summary-flagged compaction records and their assistant children from hydrated history', () => {
        const provider = createProvider();
        const formatted = provider.formatSession({
            session: { id: 'ses_task8', title: 'Compacted active turn' },
            messages: [
                { info: { id: 'msg_user', role: 'user' }, parts: [{ type: 'text', text: 'continue' }] },
                {
                    info: {
                        id: 'msg_visible', role: 'assistant', parentID: 'msg_user', finish: 'tool-calls',
                        time: { created: 100 },
                    },
                    parts: [{ type: 'text', text: 'visible active response' }],
                },
                {
                    info: { id: 'msg_compaction_user', role: 'user', summary: true },
                    parts: [{ type: 'text', text: 'Objective and important details' }],
                },
                {
                    info: {
                        id: 'msg_compaction_child', role: 'assistant', parentID: 'msg_compaction_user',
                        time: { created: 200 },
                    },
                    parts: [{ type: 'text', text: 'internal compacted context' }],
                },
            ],
        });

        expect(formatted.messages.map((message: any) => message.id)).toEqual(['msg_user', 'msg_visible']);
        expect(formatted.messages.map((message: any) => message.text)).not.toContain('Objective and important details');
        expect(formatted.messages.map((message: any) => message.text)).not.toContain('internal compacted context');
    });

    it('does not let a summary-flagged assistant replace the visible assistant generation', () => {
        const provider = createProvider();
        const formatted = provider.formatSession({
            session: { id: 'ses_task8', title: 'Compaction generation' },
            messages: [
                { info: { id: 'msg_user', role: 'user' }, parts: [{ type: 'text', text: 'continue' }] },
                {
                    info: {
                        id: 'msg_visible', role: 'assistant', parentID: 'msg_user', finish: 'tool-calls',
                        time: { created: 100 },
                    },
                    parts: [{ type: 'text', text: 'visible active response' }],
                },
                {
                    info: {
                        id: 'msg_summary', role: 'assistant', parentID: 'msg_user', summary: true,
                        time: { created: 200 },
                    },
                    parts: [{ type: 'text', text: 'Objective and important details' }],
                },
            ],
        });

        expect(formatted.messages.map((message: any) => message.id)).toEqual(['msg_user', 'msg_visible']);
        expect(formatted.messages[1]).toEqual(expect.objectContaining({ text: 'visible active response' }));
    });

    it('folds an OpenCode post-compaction continuation back into the active visible turn', () => {
        const provider = createProvider();
        const formatted = provider.formatSession({
            session: { id: 'ses_task8', title: 'Post-compaction continuation' },
            messages: [
                { info: { id: 'msg_user', role: 'user' }, parts: [{ type: 'text', text: 'finish the task' }] },
                {
                    info: {
                        id: 'msg_before_compaction', role: 'assistant', parentID: 'msg_user',
                        time: { created: 100 },
                    },
                    parts: [{ type: 'text', text: 'working before compaction' }],
                },
                { info: { id: 'msg_compaction_user', role: 'user' }, parts: [] },
                {
                    info: {
                        id: 'msg_compaction_summary', role: 'assistant', parentID: 'msg_compaction_user',
                        mode: 'compaction', agent: 'compaction', summary: true, time: { created: 200 },
                    },
                    parts: [{ type: 'text', text: 'internal compacted context' }],
                },
                {
                    info: { id: 'msg_resume_control', role: 'user', agent: 'researcher' },
                    parts: [{
                        type: 'text',
                        text: 'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.',
                    }],
                },
                {
                    info: {
                        id: 'msg_after_compaction', role: 'assistant', parentID: 'msg_resume_control',
                        time: { created: 300 },
                    },
                    parts: [{ type: 'text', text: 'current active response' }],
                },
            ],
        });

        expect(formatted.messages.map((message: any) => message.id)).toEqual([
            'msg_user', 'msg_after_compaction',
        ]);
        expect(formatted.messages[1]).toEqual(expect.objectContaining({
            text: 'current active response',
            meta: expect.objectContaining({ parentID: 'msg_user' }),
        }));
        expect(formatted.messages.map((message: any) => message.text)).not.toContain(
            'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.',
        );
    });

    it('keeps the same continuation sentence when it is not structurally preceded by compaction', () => {
        const provider = createProvider();
        const prompt = 'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.';
        const formatted = provider.formatSession({
            session: { id: 'ses_task8', title: 'Ordinary user text' },
            messages: [
                { info: { id: 'msg_user', role: 'user' }, parts: [{ type: 'text', text: prompt }] },
                {
                    info: { id: 'msg_assistant', role: 'assistant', parentID: 'msg_user', time: { created: 100 } },
                    parts: [{ type: 'text', text: 'ordinary response' }],
                },
            ],
        });

        expect(formatted.messages.map((message: any) => message.id)).toEqual(['msg_user', 'msg_assistant']);
        expect(formatted.messages[0].text).toBe(prompt);
    });

    it('reconstructs the active turn owner from hydrated busy-session messages', () => {
        const provider = createProvider();
        provider.client.recoverActiveTurn = jest.fn();
        provider.markWebviewActiveTurnUpdated = jest.fn();
        provider.markBusySessionInFlight('ses_task8', 'init:status-busy');

        const recovered = provider.recoverBusySessionTurnFromMessages('ses_task8', [
            { role: 'assistant', id: 'msg_previous', text: 'previous final', meta: { timeCompleted: 50 } },
            { role: 'user', id: 'msg_user', text: 'continue' },
            {
                role: 'assistant',
                id: 'msg_active',
                text: 'working',
                meta: { parentID: 'msg_user', timeCreated: 100, timeCompleted: undefined },
            },
        ], 'init:status-busy');

        expect(recovered).toEqual({ userMessageId: 'msg_user', assistantMessageId: 'msg_active' });
        expect(provider.sendInFlightBySession.has('ses_task8')).toBe(true);
        expect(provider.pendingAssistantMessageIdBySession.get('ses_task8')).toBe('msg_active');
        expect(provider.client.recoverActiveTurn).toHaveBeenCalledWith('ses_task8', 'msg_user', 'msg_active', 100);
        expect(provider.markWebviewActiveTurnUpdated).toHaveBeenCalledWith('ses_task8', 'init:status-busy');
    });

    it('does not revive a completed assistant while reconstructing a busy session', () => {
        const provider = createProvider();
        provider.client.recoverActiveTurn = jest.fn();
        provider.markBusySessionInFlight('ses_task8', 'init:status-busy');

        const recovered = provider.recoverBusySessionTurnFromMessages('ses_task8', [
            { role: 'user', id: 'msg_user', text: 'continue' },
            {
                role: 'assistant',
                id: 'msg_final',
                text: 'done',
                meta: { parentID: 'msg_user', timeCreated: 100, timeCompleted: 200 },
            },
        ], 'init:status-busy');

        expect(recovered).toBeNull();
        expect(provider.sendInFlightBySession.has('ses_task8')).toBe(true);
        expect(provider.client.recoverActiveTurn).not.toHaveBeenCalled();
    });

    it('does not mistake an older snapshot assistant for the current busy turn', () => {
        const provider = createProvider();
        provider.client.recoverActiveTurn = jest.fn();
        provider.markBusySessionInFlight('ses_task8', 'init:status-busy');

        const recovered = provider.recoverBusySessionTurnFromMessages('ses_task8', [
            { role: 'user', id: 'msg_old_user', text: 'old request' },
            { role: 'assistant', id: 'msg_old_assistant', text: 'old answer', meta: { parentID: 'msg_old_user' } },
            { role: 'user', id: 'msg_current_user', text: 'current request' },
        ], 'init:status-busy');

        expect(recovered).toBeNull();
        expect(provider.client.recoverActiveTurn).not.toHaveBeenCalled();
    });

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
        provider.client.exportSession = jest.fn();
        provider.client.getMessageIndex = jest.fn().mockReturnValue(currentOwner.messageIndex);
        provider.assistantTextBufferBySession.set('ses_task8', 'remote collision text');

        await provider.writeFinalizeSnapshotFromCurrentTurn({
            sessionId: 'ses_task8',
            assistantMessageId: 'msg_owner_b',
        });

        const written = provider.writeSnapshotAtomic.mock.calls[0][1];
        expect(written.sessionData.meta.timelineMessageIds).toEqual(['msg_owner_b']);
        expect(written.sessionData.messages).toEqual([currentOwner]);
        expect(provider.client.exportSession).not.toHaveBeenCalled();
    });
});
