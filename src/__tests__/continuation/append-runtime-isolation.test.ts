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
        showErrorMessage: jest.fn(),
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

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { OpenCodeClient } from '../../OpenCodeClient';
import { SidebarProvider } from '../../SidebarProvider';
import { OpenCodeDiffProvider } from '../../OpenCodeDiffProvider';

const createdClients: OpenCodeClient[] = [];
const createdProviders: Array<{ dispose: () => Promise<void> }> = [];

function createClientWithAppendTurn(sessionId: string, rootUserMsgId: string): any {
    const client = new OpenCodeClient() as any;
    createdClients.push(client as OpenCodeClient);
    client.startTurn(sessionId, 'local-user');
    client.setCurrentTurnUserMsgId(sessionId, rootUserMsgId, 'test-root');
    client.displayTurnUserMsgIdBySession.set(sessionId, rootUserMsgId);
    return client;
}

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
    provider.uiDebugChannel = { appendLine: jest.fn() };
    provider.currentSessionId = 'ses_B_current';
    provider.selectedModel = 'model-test';
    provider.selectedMode = 'build';
    provider.client = {
        dispose: jest.fn().mockResolvedValue(undefined),
        shutdownServer: jest.fn().mockResolvedValue(undefined),
        setSessionId: jest.fn(),
        setStorage: jest.fn(),
        setUiDebugChannel: jest.fn(),
        setServerStatusHandler: jest.fn(),
        addChatEventListener: jest.fn(),
        getWorkspaceRoot: jest.fn().mockReturnValue('D:\\0.Code\\OpenCodeGUI'),
        getAppendRootUserMsgId: jest.fn().mockReturnValue('msg_root_A'),
        canAppendToCurrentTurn: jest.fn().mockReturnValue(true),
        beginAppendPrompt: jest.fn().mockReturnValue({
            sessionId: 'ses_A_payload',
            rootUserMsgId: 'msg_root_A',
            clientMessageId: 'append-client-1',
        }),
        appendPrompt: jest.fn().mockResolvedValue(undefined),
        failAppendPrompt: jest.fn(),
    };
    return provider;
}

function attachWebview(provider: any): { postMessage: jest.Mock; receive: (data: any) => Promise<void> } {
    let receive: ((data: any) => Promise<void>) | undefined;
    const webview: any = {
        options: {},
        html: '',
        cspSource: 'vscode-webview:',
        asWebviewUri: (uri: any) => uri,
        postMessage: jest.fn(),
        onDidReceiveMessage: (callback: (data: any) => Promise<void>) => {
            receive = callback;
            return { dispose: jest.fn() };
        },
    };
    provider.resolveWebviewView({
        webview,
        visible: true,
        onDidChangeVisibility: (_callback: () => void) => ({ dispose: jest.fn() }),
    } as any);
    if (!receive) throw new Error('webview receive callback was not registered');
    return { postMessage: webview.postMessage, receive };
}

function loadUserAckBindHarness() {
    const mainPath = path.join(__dirname, '../../../media/main.js');
    const source = fs.readFileSync(mainPath, 'utf8');
    const mappingStart = source.indexOf('function registerMessageIdMapping');
    const mappingEnd = source.indexOf('function toStableMessageKey');
    const replaceStart = source.indexOf('function replaceKeyEverywhere');
    const replaceEnd = source.indexOf('function ensureThinkingUnique');
    if (mappingStart < 0 || mappingEnd <= mappingStart || replaceStart < 0 || replaceEnd <= replaceStart) {
        throw new Error('Could not locate userAckBind helper block in media/main.js');
    }

    const posts: any[] = [];
    const sessions = new Map<string, any>();
    const context: any = {
        console,
        Map,
        Set,
        activeSessionId: 'ses_A',
        vscode: {
            postMessage: (message: any) => posts.push(message),
        },
        getEventSessionId: (message: any) => message?.sessionId || null,
        getSessionState: (sessionId: string) => sessions.get(sessionId),
        logTimelineSnapshot: jest.fn(),
        syncAppendSnapshotMetadata: jest.fn(),
    };
    vm.createContext(context);
    vm.runInContext(`${source.slice(mappingStart, mappingEnd)}\n${source.slice(replaceStart, replaceEnd)}\nthis.handleUserAckBindMessage = handleUserAckBindMessage;`, context);
    return { context, posts, sessions };
}

function loadAppendSnapshotMetaHarness() {
    const mainPath = path.join(__dirname, '../../../media/main.js');
    const source = fs.readFileSync(mainPath, 'utf8');
    const stableStart = source.indexOf('function toStableMessageKey');
    const stableEnd = source.indexOf('function buildCanonicalSnapshotEntries');
    if (stableStart < 0 || stableEnd <= stableStart) {
        throw new Error('Could not locate append snapshot helper block in media/main.js');
    }

    const posts: any[] = [];
    const sessions = new Map<string, any>();
    const context: any = {
        console,
        Map,
        Set,
        Number,
        Array,
        Object,
        vscode: {
            postMessage: (message: any) => posts.push(message),
        },
        getSessionState: (sessionId: string) => sessions.get(sessionId),
    };
    vm.createContext(context);
    vm.runInContext(`${source.slice(stableStart, stableEnd)}
this.collectAppendSnapshotMetadata = collectAppendSnapshotMetadata;
this.syncAppendSnapshotMetadata = syncAppendSnapshotMetadata;
this.normalizeAppendItemsForFinalize = normalizeAppendItemsForFinalize;
this.restoreAppendHydrationMetadata = restoreAppendHydrationMetadata;`, context);
    return { context, posts, sessions };
}

function loadAppendChatDoneHarness() {
    const mainPath = path.join(__dirname, '../../../media/main.js');
    const source = fs.readFileSync(mainPath, 'utf8');
    const normalizeStart = source.indexOf('function normalizeAppendItemsForFinalize');
    const collectStart = source.indexOf('function collectAppendSnapshotMetadata');
    const chatDoneStart = source.indexOf('function handleChatDone');
    const chatDoneEnd = source.indexOf('function sanitizeMetaForSnapshot');
    if (normalizeStart < 0 || collectStart <= normalizeStart || chatDoneStart < 0 || chatDoneEnd <= chatDoneStart) {
        throw new Error('Could not locate append chatDone helper block in media/main.js');
    }

    const posts: any[] = [];
    const sessions = new Map<string, any>();
    const syncAppendSnapshotMetadata = jest.fn();
    const context: any = {
        console,
        Map,
        Set,
        Date,
        vscode: {
            postMessage: (message: any) => posts.push(message),
        },
        getSessionState: (sessionId: string) => sessions.get(sessionId),
        attemptAssistantUpgrade: jest.fn(),
        assertTempFinalParity: jest.fn(),
        stabilizeTimelineAfterFinal: jest.fn(),
        updateSendGate: jest.fn(),
        assertInvariants: jest.fn(),
        syncAppendSnapshotMetadata,
    };
    vm.createContext(context);
    vm.runInContext(`${source.slice(normalizeStart, collectStart)}\n${source.slice(chatDoneStart, chatDoneEnd)}
this.handleChatDone = handleChatDone;
this.normalizeSessionAppendItemsForFinalize = normalizeSessionAppendItemsForFinalize;`, context);
    return { context, posts, sessions, syncAppendSnapshotMetadata };
}

function loadAppendPresentationHarness() {
    const mainPath = path.join(__dirname, '../../../media/main.js');
    const source = fs.readFileSync(mainPath, 'utf8');
    const stableStart = source.indexOf('function toStableMessageKey');
    const stableEnd = source.indexOf('function buildCanonicalSnapshotEntries');
    if (stableStart < 0 || stableEnd <= stableStart) {
        throw new Error('Could not locate append presentation helper block in media/main.js');
    }

    const posts: any[] = [];
    const context: any = {
        console,
        Map,
        Set,
        Number,
        Array,
        Object,
        vscode: {
            postMessage: (message: any) => posts.push(message),
        },
    };
    vm.createContext(context);
    vm.runInContext(`${source.slice(stableStart, stableEnd)}
this.buildAppendChildPresentationIndex = buildAppendChildPresentationIndex;
this.isAppendChildTopLevelUser = isAppendChildTopLevelUser;`, context);
    return { context, posts };
}

afterEach(async () => {
    await Promise.all(createdProviders.splice(0).map((provider) => typeof provider.dispose === 'function' ? provider.dispose() : undefined));
    await Promise.all(createdClients.splice(0).map((client) => client.dispose()));
});

describe('append runtime isolation', () => {
    it('normalizes append item statuses for finalized turns without dropping safe fields', () => {
        const { context } = loadAppendSnapshotMetaHarness();
        const terminalApplied = { clientMessageId: 'terminal-applied', status: 'applied', text: 'done' };
        const terminalFailed = { clientMessageId: 'terminal-failed', status: 'failed', reason: 'existing-fail' };
        const terminalRejected = { clientMessageId: 'terminal-rejected', status: 'rejected', reason: 'existing-reject' };

        const result = context.normalizeAppendItemsForFinalize([
            { clientMessageId: 'queued-acked', appendUserMsgId: 'msg_append_A', text: 'acked', status: 'queued', createdAt: 1, updatedAt: 2 },
            { clientMessageId: 'seen-acked', appendUserMsgId: 'msg_append_B', text: 'seen', status: 'seen' },
            { clientMessageId: 'sending-acked', appendUserMsgId: 'msg_append_C', text: 'sending', status: 'sending' },
            { clientMessageId: 'queued-unacked', text: 'unacked', status: 'queued' },
            terminalApplied,
            terminalFailed,
            terminalRejected,
        ]);

        expect(result.changed).toBe(true);
        expect(result.items).toEqual([
            expect.objectContaining({ clientMessageId: 'queued-acked', appendUserMsgId: 'msg_append_A', text: 'acked', status: 'applied', createdAt: 1, updatedAt: 2 }),
            expect.objectContaining({ clientMessageId: 'seen-acked', appendUserMsgId: 'msg_append_B', text: 'seen', status: 'applied' }),
            expect.objectContaining({ clientMessageId: 'sending-acked', appendUserMsgId: 'msg_append_C', text: 'sending', status: 'applied' }),
            expect.objectContaining({ clientMessageId: 'queued-unacked', text: 'unacked', status: 'failed', reason: 'append-not-acknowledged' }),
            terminalApplied,
            terminalFailed,
            terminalRejected,
        ]);
    });

    it('upgrades append root user key on userAckBind and keeps appended prompts canonical', () => {
        const { context, sessions } = loadUserAckBindHarness();
        const localRootKey = 'local-1780513444265-0';
        const serverRootKey = 'msg_root_A';
        const appendedPrompts = [{ clientMessageId: 'append-client-1', text: 'follow-up text', status: 'queued' }];
        const session = {
            messagesById: new Map<string, any>([
                [localRootKey, { id: localRootKey, role: 'user', text: 'root prompt', meta: { appendedPrompts } }],
            ]),
            timeline: [localRootKey, 'msg_assistant_A'],
            segmentsByNoticeKey: new Map(),
            clientKeyToServerId: new Map(),
            serverIdToClientKey: new Map(),
            appendRootUserKey: localRootKey,
            appendComposerFor: localRootKey,
            appendComposerDrafts: new Map([[localRootKey, 'draft text']]),
            lastTurnUserId: localRootKey,
            currentTurnAssistantKey: 'msg_assistant_A',
            currentTurnAssistantMsgId: 'msg_assistant_A',
        };
        sessions.set('ses_A', session);

        expect(context.handleUserAckBindMessage({
            type: 'userAckBind',
            sessionId: 'ses_A',
            localKey: localRootKey,
            msgId: serverRootKey,
        })).toBe(true);

        expect(session.messagesById.has(localRootKey)).toBe(false);
        expect(session.messagesById.get(serverRootKey)).toEqual(expect.objectContaining({
            id: serverRootKey,
            role: 'user',
            meta: expect.objectContaining({ appendedPrompts }),
        }));
        expect(session.timeline[0]).toBe(serverRootKey);
        expect(session.appendRootUserKey).toBe(serverRootKey);
        expect(session.appendComposerFor).toBe(serverRootKey);
        expect(session.appendComposerDrafts.has(localRootKey)).toBe(false);
        expect(session.appendComposerDrafts.get(serverRootKey)).toBe('draft text');
        expect(session.lastTurnUserId).toBe(serverRootKey);
        expect(session.currentTurnAssistantKey).toBe('msg_assistant_A');
        expect(session.currentTurnAssistantMsgId).toBe('msg_assistant_A');
    });

    it('accepts appendMessage for payload session even when current session changed', async () => {
        const provider = createProvider();
        const { postMessage, receive } = attachWebview(provider);
        provider.sendInFlightBySession.add('ses_A_payload');

        await receive({
            type: 'appendMessage',
            sessionId: 'ses_A_payload',
            rootUserKey: 'msg_root_A',
            clientMessageId: 'append-client-1',
            value: 'follow-up text',
        });
        expect(provider.client.beginAppendPrompt).toHaveBeenCalledWith('ses_A_payload', 'append-client-1', 'follow-up text', 'msg_root_A');
        expect(provider.client.appendPrompt).toHaveBeenCalledWith('ses_A_payload', 'follow-up text', expect.objectContaining({
            clientMessageId: 'append-client-1',
        }));
        expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'appendStatus',
            sessionId: 'ses_A_payload',
            clientMessageId: 'append-client-1',
            status: 'queued',
        }));
        expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
            type: 'appendStatus',
            status: 'rejected',
            reason: 'finalized',
        }));
    });

    it('retains append root and latest child state after finishTurn and resetSessionState', () => {
        const client = createClientWithAppendTurn('ses_A', 'msg_root_A');

        expect(client.beginAppendPrompt('ses_A', 'append-client-1', 'follow-up text', 'msg_root_A')).toEqual(expect.objectContaining({
            sessionId: 'ses_A',
            rootUserMsgId: 'msg_root_A',
            clientMessageId: 'append-client-1',
        }));
        client.appendTurnStateBySession.get('ses_A').appendUserMsgIds.add('msg_append_child_A');

        client.finishTurn('ses_A');
        expect(client.getAppendRootUserMsgId('ses_A')).toBe('msg_root_A');
        expect(client.getLatestAppendUserMsgId('ses_A')).toBe('msg_append_child_A');

        client.resetSessionState();
        expect(client.getAppendRootUserMsgId('ses_A')).toBe('msg_root_A');
        expect(client.getLatestAppendUserMsgId('ses_A')).toBe('msg_append_child_A');
    });

    it('merges cached append metadata into canonical snapshot root without replacing unrelated meta', () => {
        const provider = createProvider();
        provider.cacheAppendSnapshotMeta({
            type: 'appendSnapshotMeta',
            sessionId: 'ses_A',
            reason: 'test',
            roots: [{
                rootMessageId: 'msg_root_A',
                appendRootUserKey: 'msg_root_A',
                meta: {
                    appendedPrompts: [{
                        clientMessageId: 'append-client-1',
                        appendUserMsgId: 'msg_append_child_A',
                        text: 'follow-up text',
                        status: 'queued',
                        unsafeObject: { drop: true },
                    }],
                },
            }],
        });

        const messagesById = new Map<string, any>([
            ['msg_root_A', { id: 'msg_root_A', role: 'user', text: 'root prompt', meta: { keepMe: 'yes' } }],
            ['msg_assistant_A', { id: 'msg_assistant_A', role: 'assistant', text: 'done', meta: { tokens: 1 } }],
        ]);

        expect(provider.applyAppendSnapshotMeta('ses_A', messagesById)).toBe(1);
        expect(messagesById.get('msg_root_A').meta).toEqual(expect.objectContaining({
            keepMe: 'yes',
            appendRootUserKey: 'msg_root_A',
            appendedPrompts: [expect.objectContaining({
                clientMessageId: 'append-client-1',
                appendUserMsgId: 'msg_append_child_A',
                text: 'follow-up text',
                status: 'queued',
            })],
        }));
        expect(messagesById.get('msg_root_A').meta.appendedPrompts[0].unsafeObject).toBeUndefined();
    });

    it('restores append root key from hydrated canonical root metadata', () => {
        const { context, posts } = loadAppendSnapshotMetaHarness();
        const session = {
            messagesById: new Map<string, any>([
                ['msg_root_A', {
                    id: 'msg_root_A',
                    role: 'user',
                    text: 'root prompt',
                    meta: {
                        appendedPrompts: [{
                            clientMessageId: 'append-client-1',
                            appendUserMsgId: 'msg_append_child_A',
                            text: 'follow-up text',
                            status: 'queued',
                            nested: { drop: true },
                        }],
                    },
                }],
                ['msg_append_child_A', { id: 'msg_append_child_A', role: 'user', text: 'follow-up text', meta: {} }],
            ]),
            appendRootUserKey: null,
            turnFullyFinalized: true,
        };

        const result = context.restoreAppendHydrationMetadata('ses_A', session);

        expect(result).toEqual(expect.objectContaining({ rootCount: 1, appendCount: 1, restoredRootUserKey: 'msg_root_A' }));
        expect(session.appendRootUserKey).toBe('msg_root_A');
        expect(session.messagesById.get('msg_root_A').meta.appendedPrompts[0]).toEqual(expect.objectContaining({
            clientMessageId: 'append-client-1',
            appendUserMsgId: 'msg_append_child_A',
            text: 'follow-up text',
            status: 'applied',
        }));
        expect(session.messagesById.get('msg_root_A').meta.appendedPrompts[0].nested).toBeUndefined();
        expect(posts).toContainEqual(expect.objectContaining({
            type: 'ui-debug',
            payload: expect.arrayContaining(['[WV][APPEND_HYDRATE_META]']),
        }));
    });

    it('derives append child presentation index without deleting child evidence messages', () => {
        const { context } = loadAppendPresentationHarness();
        const session = {
            messagesById: new Map<string, any>([
                ['msg_root_A', {
                    id: 'msg_root_A',
                    role: 'user',
                    text: 'root prompt',
                    meta: {
                        appendedPrompts: [{
                            clientMessageId: 'append-client-1',
                            appendUserMsgId: 'msg_append_child_A',
                            text: 'follow-up text',
                            status: 'queued',
                        }],
                    },
                }],
                ['msg_append_child_A', { id: 'msg_append_child_A', role: 'user', text: 'follow-up text', meta: {} }],
                ['msg_assistant_A', { id: 'msg_assistant_A', role: 'assistant', text: 'done', meta: {} }],
            ]),
            timeline: ['msg_root_A', 'msg_append_child_A', 'msg_assistant_A'],
            clientKeyToServerId: new Map<string, string>(),
            serverIdToClientKey: new Map<string, string>(),
        };

        const appendIndex = context.buildAppendChildPresentationIndex(session);
        const topLevelRendered = session.timeline.filter((id: string) => {
            const msg = session.messagesById.get(id);
            return !context.isAppendChildTopLevelUser(session, msg, id, appendIndex);
        });

        expect(appendIndex.has('msg_append_child_A')).toBe(true);
        expect(context.isAppendChildTopLevelUser(session, session.messagesById.get('msg_root_A'), 'msg_root_A', appendIndex)).toBe(false);
        expect(context.isAppendChildTopLevelUser(session, session.messagesById.get('msg_append_child_A'), 'msg_append_child_A', appendIndex)).toBe(true);
        expect(topLevelRendered).toEqual(['msg_root_A', 'msg_assistant_A']);
        expect(session.messagesById.has('msg_append_child_A')).toBe(true);
        expect(session.timeline).toContain('msg_append_child_A');
    });

    it('normalizes all append roots on chatDone and re-syncs append snapshot metadata', () => {
        const { context, sessions, syncAppendSnapshotMetadata } = loadAppendChatDoneHarness();
        const session = {
            messagesById: new Map<string, any>([
                ['msg_root_A', {
                    id: 'msg_root_A',
                    role: 'user',
                    text: 'root A',
                    meta: {
                        appendedPrompts: [{
                            clientMessageId: 'append-client-A',
                            appendUserMsgId: 'msg_append_child_A',
                            text: 'follow-up A',
                            status: 'queued',
                        }],
                    },
                }],
                ['msg_root_B', {
                    id: 'msg_root_B',
                    role: 'user',
                    text: 'root B',
                    meta: {
                        appendedPrompts: [{
                            clientMessageId: 'append-client-B',
                            text: 'follow-up B',
                            status: 'queued',
                        }],
                    },
                }],
                ['msg_append_child_A', { id: 'msg_append_child_A', role: 'user', text: 'follow-up A', meta: {} }],
            ]),
            appendRootUserKey: 'stale-missing-root',
            lastTurnUserId: 'msg_root_B',
            backendTurnInFlight: true,
            turnFullyFinalized: false,
        };
        sessions.set('ses_A', session);

        context.handleChatDone('ses_A', {});

        expect(session.messagesById.get('msg_root_A').meta.appendedPrompts[0]).toEqual(expect.objectContaining({
            clientMessageId: 'append-client-A',
            appendUserMsgId: 'msg_append_child_A',
            status: 'applied',
        }));
        expect(session.messagesById.get('msg_root_B').meta.appendedPrompts[0]).toEqual(expect.objectContaining({
            clientMessageId: 'append-client-B',
            status: 'failed',
            reason: 'append-not-acknowledged',
        }));
        expect(syncAppendSnapshotMetadata).toHaveBeenCalledWith('ses_A', 'chatDone-finalize');
        expect(session.messagesById.has('msg_append_child_A')).toBe(true);
    });

    it('self-heals finalized hydrated append metadata from stale queued to applied', () => {
        const { context } = loadAppendSnapshotMetaHarness();
        const session = {
            messagesById: new Map<string, any>([
                ['msg_root_A', {
                    id: 'msg_root_A',
                    role: 'user',
                    text: 'root prompt',
                    meta: {
                        appendedPrompts: [{
                            clientMessageId: 'append-client-1',
                            appendUserMsgId: 'msg_append_child_A',
                            text: 'follow-up text',
                            status: 'queued',
                        }],
                    },
                }],
                ['msg_append_child_A', { id: 'msg_append_child_A', role: 'user', text: 'follow-up text', meta: {} }],
            ]),
            backendTurnInFlight: false,
            turnFullyFinalized: true,
        };

        const result = context.restoreAppendHydrationMetadata('ses_A', session);

        expect(result).toEqual(expect.objectContaining({ rootCount: 1, appendCount: 1, restoredRootUserKey: 'msg_root_A' }));
        expect(session.messagesById.get('msg_root_A').meta.appendedPrompts[0]).toEqual(expect.objectContaining({
            clientMessageId: 'append-client-1',
            appendUserMsgId: 'msg_append_child_A',
            text: 'follow-up text',
            status: 'applied',
        }));
        expect(session.messagesById.has('msg_append_child_A')).toBe(true);
    });

    it('does not self-heal queued hydrated append metadata without finalized proof even when backend is idle', () => {
        const { context } = loadAppendSnapshotMetaHarness();
        const session = {
            messagesById: new Map<string, any>([
                ['msg_root_A', {
                    id: 'msg_root_A',
                    role: 'user',
                    text: 'root prompt',
                    meta: {
                        appendedPrompts: [{
                            clientMessageId: 'append-client-1',
                            appendUserMsgId: 'msg_append_child_A',
                            text: 'follow-up text',
                            status: 'queued',
                        }],
                    },
                }],
                ['msg_append_child_A', { id: 'msg_append_child_A', role: 'user', text: 'follow-up text', meta: {} }],
            ]),
            backendTurnInFlight: false,
            turnFullyFinalized: false,
        };

        const result = context.restoreAppendHydrationMetadata('ses_A', session);

        expect(result).toEqual(expect.objectContaining({ rootCount: 1, appendCount: 1, restoredRootUserKey: 'msg_root_A' }));
        expect(session.messagesById.get('msg_root_A').meta.appendedPrompts[0]).toEqual(expect.objectContaining({
            clientMessageId: 'append-client-1',
            appendUserMsgId: 'msg_append_child_A',
            text: 'follow-up text',
            status: 'queued',
        }));
        expect(session.messagesById.has('msg_append_child_A')).toBe(true);
    });

    it('resolves local append child aliases for presentation-only top-level hiding', () => {
        const { context } = loadAppendPresentationHarness();
        const session = {
            messagesById: new Map<string, any>([
                ['msg_root_A', {
                    id: 'msg_root_A',
                    role: 'user',
                    text: 'root prompt',
                    meta: {
                        appendedPrompts: [{
                            clientMessageId: 'append-client-1',
                            appendUserMsgId: 'local-append-child-A',
                            text: 'follow-up text',
                            status: 'queued',
                        }],
                    },
                }],
                ['msg_append_child_A', { id: 'msg_append_child_A', role: 'user', text: 'follow-up text', meta: {} }],
            ]),
            timeline: ['msg_root_A', 'msg_append_child_A'],
            clientKeyToServerId: new Map<string, string>([['local-append-child-A', 'msg_append_child_A']]),
            serverIdToClientKey: new Map<string, string>([['msg_append_child_A', 'local-append-child-A']]),
        };

        const appendIndex = context.buildAppendChildPresentationIndex(session);

        expect(appendIndex.has('local-append-child-A')).toBe(true);
        expect(appendIndex.has('msg_append_child_A')).toBe(true);
        expect(context.isAppendChildTopLevelUser(session, session.messagesById.get('msg_append_child_A'), 'msg_append_child_A', appendIndex)).toBe(true);
        expect(session.messagesById.has('msg_append_child_A')).toBe(true);
        expect(session.timeline).toEqual(['msg_root_A', 'msg_append_child_A']);
    });
});
