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
const createAppendSnapshotController = require('../../../webview-src/continuation/append-snapshot-controller').createAppendSnapshotController;
const createMessageRekeyController = require('../../../webview-src/session-runtime/message-rekey-controller').createMessageRekeyController;

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

function createClientWithRetainedAppendRootAfterDisplayReset(sessionId: string, rootUserMsgId: string): any {
    const client = createClientWithAppendTurn(sessionId, rootUserMsgId);
    expect(client.beginAppendPrompt(sessionId, 'seed-append-client', 'seed follow-up', rootUserMsgId)).toEqual(expect.objectContaining({
        sessionId,
        rootUserMsgId,
    }));

    client.resetSessionState({ preserveInFlightSessionIds: new Set([sessionId]) });

    expect(client.turnStateBySession.has(sessionId)).toBe(true);
    expect(client.getAppendRootUserMsgId(sessionId)).toBe(rootUserMsgId);
    expect(client.displayTurnUserMsgIdBySession.has(sessionId)).toBe(false);
    return client;
}

function createClientWithResolvedLocalRootAlias(sessionId: string, localRootKey: string, serverRootId: string): any {
    const client = new OpenCodeClient() as any;
    createdClients.push(client as OpenCodeClient);
    client.startTurn(sessionId, localRootKey);
    const turnState = client.turnStateBySession.get(sessionId);
    expect(turnState).toBeDefined();
    // Existing OpenCodeClient alias source: export resolution stores the server user id
    // that resolved the active turn state's pending local user key.
    turnState.resolvedUserMsgId = serverRootId;
    expect(client.displayTurnUserMsgIdBySession.has(sessionId)).toBe(false);
    return client;
}

function createClientWithAckBoundLocalRootAlias(sessionId: string, localRootKey: string, serverRootId: string): any {
    const client = new OpenCodeClient() as any;
    createdClients.push(client as OpenCodeClient);
    client.startTurn(sessionId, localRootKey);
    client.registerMessage(localRootKey, sessionId);
    client.aliasMessageId(localRootKey, serverRootId);
    expect(client.turnStateBySession.get(sessionId)?.resolvedUserMsgId).toBeUndefined();
    expect(client.displayTurnUserMsgIdBySession.has(sessionId)).toBe(false);
    expect(client.getAppendRootCandidates(sessionId)).toEqual(new Set([localRootKey]));
    return client;
}

function canAppendForExplicitRoot(client: any, sessionId: string, rootUserMsgId: string): boolean {
    if (typeof client.canAppendToCurrentTurnRoot === 'function') {
        return client.canAppendToCurrentTurnRoot(sessionId, rootUserMsgId);
    }
    return client.canAppendToCurrentTurn(sessionId, rootUserMsgId)
        && client.getAppendRootUserMsgId(sessionId) === rootUserMsgId;
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
        onDidDispose: (_callback: () => void) => ({ dispose: jest.fn() }),
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
        messageIdentityStore: {
            bindCanonical: (message: any, canonicalId: string) => {
                message.meta = {
                    ...(message.meta || {}),
                    identity: {
                        entityId: message.meta?.identity?.entityId || 'entity:test',
                        canonicalId,
                    },
                };
            },
        },
        logTimelineSnapshot: jest.fn(),
        syncAppendSnapshotMetadata: jest.fn(),
        getSessionSearchState: () => ({ rekey: jest.fn() }),
    };
    context.messageRekeyController = createMessageRekeyController({
        bindCanonical: context.messageIdentityStore.bindCanonical,
    });
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
        window: { __ocContinuation: { createAppendSnapshotController } },
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
this.getAppendPredecessorPresentationId = getAppendPredecessorPresentationId;
this.resolveAppendPredecessorPresentation = resolveAppendPredecessorPresentation;
this.classifyAppendFollowupTransition = classifyAppendFollowupTransition;
this.createAppendSuccessorPresentation = createAppendSuccessorPresentation;
this.collectAppendTransitionPredecessorSubagentIds = collectAppendTransitionPredecessorSubagentIds;
this.applyAppendSuccessorAssistantText = applyAppendSuccessorAssistantText;
this.collectAppendPredecessorSubagentSessionIds = collectAppendPredecessorSubagentSessionIds;
this.filterAppendSuccessorSubagents = filterAppendSuccessorSubagents;
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
        turnLifecycleController: {
            acceptMainFinal: jest.fn(() => ({ accepted: true })),
        },
    };
    context.appendSnapshotController = createAppendSnapshotController({
        resolveMessageKey: (_session: any, key: unknown) => typeof key === 'string' ? key : null,
        getSession: (sessionId: string) => sessions.get(sessionId),
        postMessage: (message: any) => posts.push(message),
    });
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
        window: { __ocContinuation: { createAppendSnapshotController } },
        vscode: {
            postMessage: (message: any) => posts.push(message),
        },
    };
    vm.createContext(context);
    vm.runInContext(`${source.slice(stableStart, stableEnd)}
this.buildAppendChildPresentationIndex = buildAppendChildPresentationIndex;
this.isAppendChildTopLevelUser = isAppendChildTopLevelUser;
this.isAppendChainTopLevelAssistantHidden = isAppendChainTopLevelAssistantHidden;
this.collectAppendPresentationRetiredIds = collectAppendPresentationRetiredIds;`, context);
    return { context, posts };
}

afterEach(async () => {
    await Promise.all(createdProviders.splice(0).map((provider) => typeof provider.dispose === 'function' ? provider.dispose() : undefined));
    await Promise.all(createdClients.splice(0).map((client) => client.dispose()));
});

describe('append runtime isolation', () => {
    it('accepts only idempotent or strictly consecutive append presentation generations', () => {
        const { context } = loadAppendSnapshotMetaHarness();
        const generationOne = {
            kind: 'append-followup',
            mode: 'same-turn-handoff',
            sessionId: 'ses',
            appendUserMsgId: 'msg_u',
            predecessorAssistantMsgId: 'msg_a',
            assistantMsgId: 'msg_b',
            generation: 1,
        };
        const generationTwo = {
            ...generationOne,
            predecessorAssistantMsgId: 'msg_b',
            assistantMsgId: 'msg_c',
            generation: 2,
        };

        expect(context.classifyAppendFollowupTransition(null, generationOne)).toBe('initial');
        expect(context.classifyAppendFollowupTransition(generationOne, { ...generationOne })).toBe('duplicate');
        expect(context.classifyAppendFollowupTransition(generationOne, generationTwo)).toBe('advance');
        expect(context.classifyAppendFollowupTransition(generationOne, { ...generationTwo, generation: 3 })).toBe('reject');
        expect(context.classifyAppendFollowupTransition(generationOne, { ...generationTwo, predecessorAssistantMsgId: 'msg_other' })).toBe('reject');
        expect(context.classifyAppendFollowupTransition(generationOne, { ...generationTwo, appendUserMsgId: 'msg_other_user' })).toBe('reject');
        expect(context.classifyAppendFollowupTransition(generationTwo, generationOne)).toBe('reject');
    });

    it('keeps duplicate append generations on the explicit no-op path', () => {
        const source = fs.readFileSync(path.join(__dirname, '../../../media/main.js'), 'utf8');
        const turnInFlightStart = source.indexOf("case 'turnInFlight':");
        const assistantMetaStart = source.indexOf("case 'assistantMessageMeta':", turnInFlightStart);
        const turnInFlightBlock = source.slice(turnInFlightStart, assistantMetaStart);

        expect(turnInFlightBlock).toContain("if (transition === 'duplicate')");
        expect(turnInFlightBlock).toContain("'duplicate-generation-noop'");
        expect(turnInFlightBlock).toContain('parentID: followup.appendUserMsgId');
        expect(turnInFlightBlock.indexOf("if (transition === 'duplicate')"))
            .toBeLessThan(turnInFlightBlock.indexOf('createAppendSuccessorPresentation(predecessor, transition)'));
    });

    it('keeps the visible assistant presentation across an append generation advance', () => {
        const { context } = loadAppendSnapshotMetaHarness();
        const predecessor = {
            id: 'msg_b',
            role: 'assistant',
            text: 'Main agent text',
            meta: {
                isThinking: true,
                statusText: 'Running: task',
                currentSegment: 'Main agent text',
                textSegments: ['Earlier text'],
                todos: [{ content: 'Keep todo', status: 'in_progress' }],
                subagents: [{ sessionId: 'ses_current', state: 'done' }],
                identity: { canonicalId: 'msg_b' },
                internalId: 'msg_b',
            },
        };

        const presentation = context.createAppendSuccessorPresentation(predecessor, 'advance');

        expect(presentation.text).toBe('Main agent text');
        expect(presentation.meta).toEqual(expect.objectContaining({
            isThinking: true,
            statusText: 'Running: task',
            currentSegment: 'Main agent text',
            appendInheritedText: true,
            todos: [{ content: 'Keep todo', status: 'in_progress' }],
            subagents: [{ sessionId: 'ses_current', state: 'done' }],
        }));
        expect(presentation.meta.identity).toBeUndefined();
        expect(presentation.meta.internalId).toBeUndefined();
        presentation.meta.todos[0].status = 'completed';
        expect(predecessor.meta.todos[0].status).toBe('in_progress');
    });

    it('keeps the first append handoff blank instead of copying the completed predecessor', () => {
        const { context } = loadAppendSnapshotMetaHarness();
        const presentation = context.createAppendSuccessorPresentation({
            role: 'assistant',
            text: 'Completed prior answer',
            meta: { todos: [{ content: 'old' }], processingStartedAt: 1_000 },
        }, 'initial');

        expect(presentation).toEqual({
            text: '',
            meta: {
                isThinking: true,
                statusText: '',
                processingStartedAt: 1_000,
            },
        });
    });

    it('keeps active main text and rich state across the first append handoff', () => {
        const { context } = loadAppendSnapshotMetaHarness();
        const predecessor = {
            id: 'msg_active',
            role: 'assistant',
            text: 'Existing active answer',
            meta: {
                isThinking: true,
                statusText: 'Reading: prior.json',
                currentSegment: 'Existing active answer',
                textSegments: ['Earlier active text'],
                todos: [{ content: 'Keep active todo', status: 'in_progress' }],
                subagents: [{ sessionId: 'ses_active_child', state: 'running' }],
                processingStartedAt: 1_000,
            },
        };

        const presentation = context.createAppendSuccessorPresentation(predecessor, 'initial');

        expect(presentation.text).toBe('Existing active answer');
        expect(presentation.meta).toEqual(expect.objectContaining({
            isThinking: true,
            statusText: 'Reading: prior.json',
            currentSegment: 'Existing active answer',
            textSegments: ['Earlier active text'],
            appendInheritedText: true,
            todos: [{ content: 'Keep active todo', status: 'in_progress' }],
            subagents: [{ sessionId: 'ses_active_child', state: 'running' }],
            processingStartedAt: 1_000,
        }));
    });

    it('keeps inherited active text when the first append successor only changes tool status', () => {
        const { context } = loadAppendSnapshotMetaHarness();
        const presentation = context.createAppendSuccessorPresentation({
            role: 'assistant',
            text: 'Text that must remain visible',
            meta: { isThinking: true, statusText: 'Searching...' },
        }, 'initial');

        presentation.meta = {
            ...presentation.meta,
            isThinking: true,
            statusText: 'Reading: phase_b_freeze.json',
        };

        expect(presentation.text).toBe('Text that must remain visible');
        expect(presentation.meta.statusText).toBe('Reading: phase_b_freeze.json');
        expect(presentation.meta.appendInheritedText).toBe(true);
    });

    it('keeps one cumulative processing timer across every append presentation generation', () => {
        const { context } = loadAppendSnapshotMetaHarness();
        const initial = context.createAppendSuccessorPresentation({
            role: 'assistant',
            text: 'First assistant stage',
            meta: { processingStartedAt: 1_000 },
        }, 'initial');
        const advanced = context.createAppendSuccessorPresentation({
            role: 'assistant',
            text: 'Second assistant stage',
            meta: initial.meta,
        }, 'advance');

        expect(initial.meta.processingStartedAt).toBe(1_000);
        expect(advanced.meta.processingStartedAt).toBe(1_000);
    });

    it('replaces inherited main text only when the next main text arrives', () => {
        const { context } = loadAppendSnapshotMetaHarness();
        const target: any = {
            text: 'Previous main text',
            meta: { isThinking: true, appendInheritedText: true },
        };

        expect(context.applyAppendSuccessorAssistantText(target, '')).toBe(false);
        expect(target.text).toBe('Previous main text');
        expect(context.applyAppendSuccessorAssistantText(target, 'New main text')).toBe(true);
        expect(target.text).toBe('New main text');
        expect(target.meta.appendInheritedText).toBeUndefined();
        context.applyAppendSuccessorAssistantText(target, ' continued');
        expect(target.text).toBe('New main text continued');
    });

    it('does not reclassify current-chain subagents as stale on generation advance', () => {
        const { context } = loadAppendSnapshotMetaHarness();
        const current = { predecessorSubagentSessionIds: ['ses_before_append'] };
        const predecessor = {
            meta: { subagents: [{ sessionId: 'ses_current_chain', state: 'done' }] },
        };
        const active = [{ sessionId: 'ses_current_chain', state: 'done' }];

        expect(context.collectAppendTransitionPredecessorSubagentIds(
            current,
            predecessor,
            active,
            'advance'
        )).toEqual(['ses_before_append']);
        expect(context.collectAppendTransitionPredecessorSubagentIds(
            null,
            predecessor,
            active,
            'initial'
        )).toEqual(['ses_current_chain']);
    });

    it('keeps current-chain subagents visible when filtering an advanced append generation', () => {
        const { context } = loadAppendSnapshotMetaHarness();
        const predecessor = {
            id: 'msg_generation_one',
            role: 'assistant',
            meta: { subagents: [{ sessionId: 'ses_current_chain', state: 'running' }] },
        };
        const successor = {
            id: 'msg_generation_two',
            role: 'assistant',
            meta: { isThinking: true },
        };
        const followup = {
            kind: 'append-followup',
            mode: 'same-turn-handoff',
            generation: 2,
            predecessorAssistantMsgId: predecessor.id,
            predecessorPresentationAssistantId: predecessor.id,
            assistantMsgId: successor.id,
            predecessorSubagentSessionIds: ['ses_before_append'],
        };
        const session = {
            messagesById: new Map<string, any>([
                [predecessor.id, predecessor],
                [successor.id, successor],
            ]),
            appendFollowupIdentity: followup,
        };

        const visible = context.filterAppendSuccessorSubagents(session, successor, [
            { sessionId: 'ses_before_append', state: 'done' },
            { sessionId: 'ses_current_chain', state: 'running' },
        ]);

        expect(visible).toEqual([
            expect.objectContaining({ sessionId: 'ses_current_chain', state: 'running' }),
        ]);
    });

    it('resolves a canonical append predecessor to its active presentation owner', () => {
        const { context } = loadAppendSnapshotMetaHarness();
        const presentation = { id: 'msg_presentation', role: 'assistant', text: 'Working' };
        const session = {
            messagesById: new Map([[presentation.id, presentation]]),
            timeline: [presentation.id],
            backendTurnInFlight: true,
            turnFullyFinalized: false,
            canceledActiveTurn: false,
            currentTurnAssistantKey: presentation.id,
            currentTurnAssistantMsgId: 'msg_canonical_latest',
            thinkingId: presentation.id,
        };

        const resolved = context.resolveAppendPredecessorPresentation(session, {
            kind: 'append-followup',
            generation: 7,
            assistantMsgId: 'msg_successor',
            predecessorAssistantMsgId: 'msg_canonical_latest',
        });

        expect(resolved?.message).toBe(presentation);
        expect(resolved?.presentationId).toBe(presentation.id);
        expect(resolved?.reason).toBe('active-turn-owner');
    });

    it('rejects an unrelated canonical append predecessor instead of guessing a presentation owner', () => {
        const { context } = loadAppendSnapshotMetaHarness();
        const presentation = { id: 'msg_presentation', role: 'assistant', text: 'Working' };
        const session = {
            messagesById: new Map([[presentation.id, presentation]]),
            timeline: [presentation.id],
            backendTurnInFlight: true,
            turnFullyFinalized: false,
            canceledActiveTurn: false,
            currentTurnAssistantKey: presentation.id,
            currentTurnAssistantMsgId: 'msg_canonical_latest',
            thinkingId: presentation.id,
        };

        expect(context.resolveAppendPredecessorPresentation(session, {
            kind: 'append-followup',
            generation: 7,
            assistantMsgId: 'msg_successor',
            predecessorAssistantMsgId: 'msg_unrelated',
        })).toBeNull();

        session.turnFullyFinalized = true;
        expect(context.resolveAppendPredecessorPresentation(session, {
            kind: 'append-followup',
            generation: 7,
            assistantMsgId: 'msg_successor',
            predecessorAssistantMsgId: 'msg_canonical_latest',
        })).toBeNull();
    });

    it('reuses the stored append predecessor presentation after active ownership advances to the successor', () => {
        const { context } = loadAppendSnapshotMetaHarness();
        const presentation = { id: 'msg_presentation', role: 'assistant', text: 'Working' };
        const followup = {
            kind: 'append-followup',
            generation: 7,
            assistantMsgId: 'msg_successor',
            predecessorAssistantMsgId: 'msg_canonical_latest',
        };
        const session = {
            messagesById: new Map([[presentation.id, presentation]]),
            timeline: [presentation.id, 'msg_successor'],
            backendTurnInFlight: true,
            turnFullyFinalized: false,
            canceledActiveTurn: false,
            currentTurnAssistantKey: 'msg_successor',
            currentTurnAssistantMsgId: 'msg_successor',
            thinkingId: 'msg_successor',
            appendFollowupIdentity: {
                ...followup,
                predecessorPresentationAssistantId: presentation.id,
            },
        };

        const resolved = context.resolveAppendPredecessorPresentation(session, followup);

        expect(resolved?.message).toBe(presentation);
        expect(resolved?.presentationId).toBe(presentation.id);
        expect(resolved?.reason).toBe('stored-identity');
    });

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
            rootUserMsgId: 'msg_root_A',
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

    it('allows append availability for retained active root when display root was cleared by reset', () => {
        const client = createClientWithRetainedAppendRootAfterDisplayReset('ses_A', 'msg_root_A');

        expect(canAppendForExplicitRoot(client, 'ses_A', 'msg_root_A')).toBe(true);
    });

    it('allows append availability when explicit server root aliases retained local root candidate', () => {
        const client = createClientWithResolvedLocalRootAlias('ses_A', 'local-1780591738769-0', 'msg_e9389bfa4001ZknKQ7VC1euYup');

        expect(canAppendForExplicitRoot(client, 'ses_A', 'msg_e9389bfa4001ZknKQ7VC1euYup')).toBe(true);
        expect(canAppendForExplicitRoot(client, 'ses_A', 'msg_wrong_root')).toBe(false);

        client.turnFinalResolvedBySession.add('ses_A');
        expect(canAppendForExplicitRoot(client, 'ses_A', 'msg_e9389bfa4001ZknKQ7VC1euYup')).toBe(false);

        client.turnFinalResolvedBySession.delete('ses_A');
        client.canceledActiveTurnBySession.set('ses_A', true);
        expect(canAppendForExplicitRoot(client, 'ses_A', 'msg_e9389bfa4001ZknKQ7VC1euYup')).toBe(false);
    });

    it('threads accepted explicit root into appendPrompt send gate when display root is absent', async () => {
        const sessionId = 'ses_A';
        const localRootKey = 'local-1780591738769-0';
        const serverRootId = 'msg_e9389bfa4001ZknKQ7VC1euYup';
        const client = createClientWithResolvedLocalRootAlias(sessionId, localRootKey, serverRootId);
        client.ensureServer = jest.fn().mockResolvedValue(undefined);
        client.requestJson = jest.fn().mockResolvedValue(undefined);

        expect(client.displayTurnUserMsgIdBySession.has(sessionId)).toBe(false);
        expect(client.beginAppendPrompt(sessionId, 'append-client-1', 'follow-up text', serverRootId)).toEqual(expect.objectContaining({
            sessionId,
            rootUserMsgId: serverRootId,
            clientMessageId: 'append-client-1',
        }));

        await expect(client.appendPrompt(sessionId, 'follow-up text', {
            clientMessageId: 'append-client-1',
            rootUserMsgId: serverRootId,
        })).resolves.toBeUndefined();

        expect(client.canAppendToCurrentTurn(sessionId, serverRootId)).toBe(true);
        expect(client.requestJson).toHaveBeenCalledWith('POST', `/session/${sessionId}/prompt_async`, expect.objectContaining({
            parts: [{ type: 'text', text: 'follow-up text' }],
        }));
    });

    it('keeps appendPrompt no-explicit-root denial when display root is absent', async () => {
        const sessionId = 'ses_A';
        const localRootKey = 'local-1780591738769-0';
        const serverRootId = 'msg_e9389bfa4001ZknKQ7VC1euYup';
        const client = createClientWithResolvedLocalRootAlias(sessionId, localRootKey, serverRootId);
        client.ensureServer = jest.fn().mockResolvedValue(undefined);
        client.requestJson = jest.fn().mockResolvedValue(undefined);

        expect(client.beginAppendPrompt(sessionId, 'append-client-1', 'follow-up text', serverRootId)).toEqual(expect.objectContaining({
            rootUserMsgId: serverRootId,
        }));

        await expect(client.appendPrompt(sessionId, 'follow-up text', {
            clientMessageId: 'append-client-1',
        })).rejects.toThrow('This turn can no longer be appended to.');

        expect(client.canAppendToCurrentTurn(sessionId)).toBe(false);
        expect(client.requestJson).not.toHaveBeenCalled();
    });

    it('allows append availability when ack-bound server root aliases retained local root candidate', () => {
        const sessionId = 'ses_A';
        const localRootKey = 'local-1780599666471-0';
        const serverRootId = 'msg_e9402b73f001BuciWBPFnix51V';
        const client = createClientWithAckBoundLocalRootAlias(sessionId, localRootKey, serverRootId);

        expect(canAppendForExplicitRoot(client, sessionId, serverRootId)).toBe(true);
        expect(canAppendForExplicitRoot(client, sessionId, 'msg_wrong_root')).toBe(false);

        client.resetSessionState({ preserveInFlightSessionIds: new Set([sessionId]) });
        expect(client.getAppendRootCandidates(sessionId)).toEqual(new Set([localRootKey]));
        expect(client.displayTurnUserMsgIdBySession.has(sessionId)).toBe(false);
        expect(canAppendForExplicitRoot(client, sessionId, serverRootId)).toBe(true);

        client.turnFinalResolvedBySession.add(sessionId);
        expect(canAppendForExplicitRoot(client, sessionId, serverRootId)).toBe(false);

        client.turnFinalResolvedBySession.delete(sessionId);
        client.canceledActiveTurnBySession.set(sessionId, true);
        expect(canAppendForExplicitRoot(client, sessionId, serverRootId)).toBe(false);
    });

    it('rejects append availability for wrong explicit root during an active retained turn', () => {
        const client = createClientWithRetainedAppendRootAfterDisplayReset('ses_A', 'msg_root_A');

        expect(canAppendForExplicitRoot(client, 'ses_A', 'msg_wrong_root')).toBe(false);
    });

    it('rejects append availability for a finalized active turn with the same root', () => {
        const client = createClientWithRetainedAppendRootAfterDisplayReset('ses_A', 'msg_root_A');
        client.turnFinalResolvedBySession.add('ses_A');

        expect(canAppendForExplicitRoot(client, 'ses_A', 'msg_root_A')).toBe(false);
    });

    it('rejects append availability for a canceled active turn with the same root', () => {
        const client = createClientWithRetainedAppendRootAfterDisplayReset('ses_A', 'msg_root_A');
        client.canceledActiveTurnBySession.set('ses_A', true);

        expect(canAppendForExplicitRoot(client, 'ses_A', 'msg_root_A')).toBe(false);
    });

    it('rejects appendMessage as turn-not-in-flight even when client availability would allow append', async () => {
        const provider = createProvider();
        const { postMessage, receive } = attachWebview(provider);

        await receive({
            type: 'appendMessage',
            sessionId: 'ses_A_payload',
            rootUserKey: 'msg_root_A',
            clientMessageId: 'append-client-1',
            value: 'follow-up text',
        });

        expect(provider.client.canAppendToCurrentTurn).toHaveBeenCalledWith('ses_A_payload', 'msg_root_A');
        expect(provider.client.beginAppendPrompt).not.toHaveBeenCalled();
        expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'appendStatus',
            sessionId: 'ses_A_payload',
            clientMessageId: 'append-client-1',
            status: 'rejected',
            reason: 'turn-not-in-flight',
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

    it('retains only allowlisted client turn binding for requested in-flight sessions on reset', () => {
        const client = new OpenCodeClient() as any;
        createdClients.push(client as OpenCodeClient);

        client.startTurn('ses_keep', 'local-user-keep');
        client.setPendingAssistantTmpKey('ses_keep', 'tmp:assistant-keep');
        client.queueTurnChanges('ses_keep', 'local-user-keep', 'tmp:assistant-keep', 'msg_assistant_keep', [{ path: 'keep.txt', status: 'modified' }]);
        client.markTurnHasWrites('ses_keep', 'test');
        client.displayTurnUserMsgIdBySession.set('ses_keep', 'msg_visible_keep');
        client.canceledActiveTurnBySession.set('ses_keep', true);

        client.startTurn('ses_drop', 'local-user-drop');
        client.setPendingAssistantTmpKey('ses_drop', 'tmp:assistant-drop');
        client.queueTurnChanges('ses_drop', 'local-user-drop', 'tmp:assistant-drop', 'msg_assistant_drop', [{ path: 'drop.txt', status: 'modified' }]);
        client.markTurnHasWrites('ses_drop', 'test');

        client.resetSessionState({ preserveInFlightSessionIds: new Set(['ses_keep']) });

        expect(client.turnStateBySession.get('ses_keep')).toEqual(expect.objectContaining({
            pendingUserLocalKey: 'local-user-keep',
            pendingAssistantTmpKey: 'tmp:assistant-keep',
        }));
        expect(client.pendingTurnChangesBySession.get('ses_keep')).toEqual(expect.objectContaining({
            turnKey: 'local-user-keep',
            tmpKey: 'tmp:assistant-keep',
        }));
        expect(client.turnWriteStateBySession.get('ses_keep')).toEqual({ turnKey: 'local-user-keep', hasWrites: true });

        expect(client.turnStateBySession.has('ses_drop')).toBe(false);
        expect(client.pendingTurnChangesBySession.has('ses_drop')).toBe(false);
        expect(client.turnWriteStateBySession.has('ses_drop')).toBe(false);
        expect(client.displayTurnUserMsgIdBySession.has('ses_keep')).toBe(false);
        expect(client.canceledActiveTurnBySession.has('ses_keep')).toBe(false);
    });

    it('retains the original turn start across a session-switch reset', () => {
        const client = new OpenCodeClient() as any;
        createdClients.push(client as OpenCodeClient);

        client.startTurn('ses_keep', 'local-user-keep');
        client.currentTurnStartedAtBySession.set('ses_keep', 1_785_531_000_000);
        client.startTurn('ses_drop', 'local-user-drop');
        client.currentTurnStartedAtBySession.set('ses_drop', 1_785_531_120_000);

        client.resetSessionState({ preserveInFlightSessionIds: new Set(['ses_keep']) });

        expect(client.getCurrentTurnStartedAt('ses_keep')).toBe(1_785_531_000_000);
        expect(client.getCurrentTurnStartedAt('ses_drop')).toBeUndefined();
    });

    it('retains active assistant text evidence across a session-switch reset', async () => {
        const client = new OpenCodeClient() as any;
        createdClients.push(client as OpenCodeClient);

        client.startTurn('ses_keep', 'local-user-keep');
        client.turnStateBySession.get('ses_keep').assistantMsgId = 'msg_assistant_keep';
        client.currentTurnAssistantMsgIdBySession.set('ses_keep', 'msg_assistant_keep');
        client.assistantTextLengths.set('msg_assistant_keep', 837);
        client.assistantTextLengthsByPart.set('msg_assistant_keep:prt_final', 837);
        client.assistantTextById.set('msg_assistant_keep', 'final response');
        client.assistantHasDelta.add('msg_assistant_keep');
        client.assistantStatusCleared.add('msg_assistant_keep');

        client.startTurn('ses_drop', 'local-user-drop');
        client.turnStateBySession.get('ses_drop').assistantMsgId = 'msg_assistant_drop';
        client.currentTurnAssistantMsgIdBySession.set('ses_drop', 'msg_assistant_drop');
        client.assistantTextLengths.set('msg_assistant_drop', 42);
        client.assistantTextLengthsByPart.set('msg_assistant_drop:prt_final', 42);
        client.assistantTextById.set('msg_assistant_drop', 'drop response');

        client.resetSessionState({ preserveInFlightSessionIds: new Set(['ses_keep']) });

        expect(client.assistantTextLengths.get('msg_assistant_keep')).toBe(837);
        expect(client.assistantTextLengthsByPart.get('msg_assistant_keep:prt_final')).toBe(837);
        expect(client.assistantTextById.get('msg_assistant_keep')).toBe('final response');
        expect(client.assistantHasDelta.has('msg_assistant_keep')).toBe(true);
        expect(client.assistantStatusCleared.has('msg_assistant_keep')).toBe(true);

        expect(client.assistantTextLengths.has('msg_assistant_drop')).toBe(false);
        expect(client.assistantTextLengthsByPart.has('msg_assistant_drop:prt_final')).toBe(false);
        expect(client.assistantTextById.has('msg_assistant_drop')).toBe(false);

        client.markTurnFinal('ses_keep', 'msg_assistant_keep', 'sse');
        await client.runResyncSettleCheck('ses_keep', 'sse-drain');
        expect(client.turnFinalResolvedBySession.has('ses_keep')).toBe(true);
    });

    it('retains and resumes an accepted final across a session-switch reset', async () => {
        const client = new OpenCodeClient() as any;
        createdClients.push(client as OpenCodeClient);

        client.startTurn('ses_keep', 'local-user-keep');
        client.turnStateBySession.get('ses_keep').assistantMsgId = 'msg_final_keep';
        client.currentTurnAssistantMsgIdBySession.set('ses_keep', 'msg_final_keep');
        client.assistantTextLengths.set('msg_final_keep', 2);
        client.markTurnFinal('ses_keep', 'msg_final_keep', 'sse');

        expect(client.finalizingMsgIdBySession.get('ses_keep')).toBe('msg_final_keep');
        expect(client.turnFinalAtBySession.has('ses_keep')).toBe(true);

        client.resetSessionState({ preserveInFlightSessionIds: new Set(['ses_keep']) });

        expect(client.finalizingMsgIdBySession.get('ses_keep')).toBe('msg_final_keep');
        expect(client.turnFinalMsgIdBySession.get('ses_keep')).toBe('msg_final_keep');
        expect(client.turnFinalSourceBySession.get('ses_keep')).toBe('sse');
        expect(client.turnFinalAtBySession.has('ses_keep')).toBe(true);
        expect(client.turnFinalQuietTimersBySession.has('ses_keep')).toBe(true);

        await client.runResyncSettleCheck('ses_keep', 'sse-drain');
        expect(client.turnFinalResolvedBySession.has('ses_keep')).toBe(true);
    });

    it('retains only allowlisted provider bindings for pre-reset send-in-flight sessions', () => {
        const provider = createProvider();
        provider.client.resetSessionState = jest.fn();

        provider.sendInFlightBySession.add('ses_keep');
        provider.pendingLocalKeyBySession.set('ses_keep', 'local-user-keep');
        provider.pendingAssistantTmpKeyBySession.set('ses_keep', 'tmp:assistant-keep');
        provider.pendingAssistantMessageIdBySession.set('ses_keep', 'msg_assistant_keep');
        provider.assistantTextBufferBySession.set('ses_keep', 'stream text');
        provider.assistantTextBufferByMessageIdBySession.set(
            'ses_keep',
            new Map([['msg_assistant_keep', 'stream text']]),
        );
        provider.pendingSnapshotUserTextBySession.set('ses_keep', 'visible prompt');
        provider.rawUserTextByLocalKey.set('local-user-keep', 'raw prompt');
        provider.pendingAssistantTmpKeyByLocalKey.set('local-user-keep', 'tmp:assistant-keep');
        provider.appendSubmitInFlightBySession.add('ses_keep');
        provider.pendingBaselineTurnKey = 'baseline-stale';
        provider.draftByLocalKey.set('local-user-keep', { text: 'draft', attachments: [] });
        provider.uiTimelineBySession.set('ses_keep', ['local-user-keep', 'tmp:assistant-keep']);

        provider.pendingLocalKeyBySession.set('ses_drop', 'local-user-drop');
        provider.pendingAssistantTmpKeyBySession.set('ses_drop', 'tmp:assistant-drop');
        provider.pendingAssistantMessageIdBySession.set('ses_drop', 'msg_assistant_drop');
        provider.assistantTextBufferBySession.set('ses_drop', 'drop stream');
        provider.assistantTextBufferByMessageIdBySession.set(
            'ses_drop',
            new Map([['msg_assistant_drop', 'drop stream']]),
        );
        provider.pendingSnapshotUserTextBySession.set('ses_drop', 'drop visible prompt');
        provider.rawUserTextByLocalKey.set('local-user-drop', 'drop prompt');
        provider.pendingAssistantTmpKeyByLocalKey.set('local-user-drop', 'tmp:assistant-drop');

        provider.resetSessionState();

        expect(provider.client.resetSessionState).toHaveBeenCalledWith({ preserveInFlightSessionIds: expect.any(Set) });
        const preserveSet = provider.client.resetSessionState.mock.calls[0][0].preserveInFlightSessionIds;
        expect(Array.from(preserveSet)).toEqual(['ses_keep']);

        expect(provider.sendInFlightBySession.has('ses_keep')).toBe(true);
        expect(provider.pendingLocalKeyBySession.get('ses_keep')).toBe('local-user-keep');
        expect(provider.pendingAssistantTmpKeyBySession.get('ses_keep')).toBe('tmp:assistant-keep');
        expect(provider.pendingAssistantMessageIdBySession.get('ses_keep')).toBe('msg_assistant_keep');
        expect(provider.assistantTextBufferBySession.get('ses_keep')).toBe('stream text');
        expect(provider.assistantTextBufferByMessageIdBySession.get('ses_keep')?.get('msg_assistant_keep'))
            .toBe('stream text');
        expect(provider.pendingSnapshotUserTextBySession.get('ses_keep')).toBe('visible prompt');
        expect(provider.rawUserTextByLocalKey.get('local-user-keep')).toBe('raw prompt');
        expect(provider.pendingAssistantTmpKeyByLocalKey.get('local-user-keep')).toBe('tmp:assistant-keep');

        expect(provider.pendingLocalKeyBySession.has('ses_drop')).toBe(false);
        expect(provider.pendingAssistantTmpKeyBySession.has('ses_drop')).toBe(false);
        expect(provider.pendingAssistantMessageIdBySession.has('ses_drop')).toBe(false);
        expect(provider.assistantTextBufferBySession.has('ses_drop')).toBe(false);
        expect(provider.assistantTextBufferByMessageIdBySession.has('ses_drop')).toBe(false);
        expect(provider.pendingSnapshotUserTextBySession.has('ses_drop')).toBe(false);
        expect(provider.rawUserTextByLocalKey.has('local-user-drop')).toBe(false);
        expect(provider.pendingAssistantTmpKeyByLocalKey.has('local-user-drop')).toBe(false);
        expect(provider.appendSubmitInFlightBySession.has('ses_keep')).toBe(false);
        expect(provider.pendingBaselineTurnKey).toBeUndefined();
        expect(provider.draftByLocalKey.has('local-user-keep')).toBe(false);
        expect(provider.uiTimelineBySession.has('ses_keep')).toBe(false);
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

    it('does not replace protected in-flight append root with older hydrated append metadata', () => {
        const { context } = loadAppendSnapshotMetaHarness();
        const session = {
            messagesById: new Map<string, any>([
                ['msg_root_old', {
                    id: 'msg_root_old',
                    role: 'user',
                    text: 'older root prompt',
                    meta: {
                        appendedPrompts: [{
                            clientMessageId: 'append-client-old',
                            appendUserMsgId: 'msg_append_child_old',
                            text: 'older follow-up',
                            status: 'queued',
                            nested: { drop: true },
                        }],
                    },
                }],
                ['msg_root_active', {
                    id: 'msg_root_active',
                    role: 'user',
                    text: 'active root prompt',
                    meta: {},
                }],
                ['msg_append_child_old', { id: 'msg_append_child_old', role: 'user', text: 'older follow-up', meta: {} }],
            ]),
            appendRootUserKey: 'msg_root_active',
            lastTurnUserId: 'msg_root_active',
            backendTurnInFlight: true,
            turnFullyFinalized: false,
            canceledActiveTurn: false,
            finalAssistantLock: null,
        };

        const result = context.restoreAppendHydrationMetadata('ses_A', session);

        expect(result).toEqual(expect.objectContaining({ rootCount: 1, appendCount: 1, restoredRootUserKey: 'msg_root_old' }));
        expect(session.appendRootUserKey).toBe('msg_root_active');
        expect(session.messagesById.get('msg_root_old').meta.appendedPrompts[0]).toEqual(expect.objectContaining({
            clientMessageId: 'append-client-old',
            appendUserMsgId: 'msg_append_child_old',
            text: 'older follow-up',
            status: 'queued',
        }));
        expect(session.messagesById.get('msg_root_old').meta.appendedPrompts[0].nested).toBeUndefined();
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

    it('keeps the current in-flight assistant visible when append presentation hides assistants parented to the root', () => {
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
                ['msg_assistant_A', {
                    id: 'msg_assistant_A',
                    role: 'assistant',
                    text: 'working',
                    parentId: 'msg_root_A',
                    meta: {},
                }],
            ]),
            timeline: ['msg_root_A', 'msg_assistant_A', 'msg_append_child_A'],
            clientKeyToServerId: new Map<string, string>(),
            serverIdToClientKey: new Map<string, string>(),
            backendTurnInFlight: true,
            turnFullyFinalized: false,
            canceledActiveTurn: false,
            currentTurnAssistantKey: 'msg_assistant_A',
            currentTurnAssistantMsgId: 'msg_assistant_A',
            thinkingId: 'msg_assistant_A',
        };

        const appendIndex = context.buildAppendChildPresentationIndex(session);

        expect(context.isAppendChainTopLevelAssistantHidden(
            session,
            session.messagesById.get('msg_assistant_A'),
            'msg_assistant_A',
            appendIndex,
        )).toBe(false);

        session.backendTurnInFlight = false;
        session.turnFullyFinalized = true;

        expect(context.isAppendChainTopLevelAssistantHidden(
            session,
            session.messagesById.get('msg_assistant_A'),
            'msg_assistant_A',
            appendIndex,
        )).toBe(true);
    });

    it('keeps a hydrated later append assistant folded under the active presentation owner', () => {
        const { context } = loadAppendPresentationHarness();
        const session = {
            messagesById: new Map<string, any>([
                ['msg_root', {
                    id: 'msg_root', role: 'user', text: 'root', meta: {
                        appendedPrompts: [
                            { clientMessageId: 'append-1', appendUserMsgId: 'msg_append_1', text: 'first', status: 'queued' },
                            { clientMessageId: 'append-2', appendUserMsgId: 'msg_append_2', text: 'second', status: 'queued' },
                        ],
                    },
                }],
                ['msg_append_1', { id: 'msg_append_1', role: 'user', text: 'first', meta: {} }],
                ['msg_owner', { id: 'msg_owner', role: 'assistant', parentId: 'msg_append_1', text: 'working', meta: {} }],
                ['msg_append_2', { id: 'msg_append_2', role: 'user', text: 'second', meta: {} }],
                ['msg_hydrated_later', { id: 'msg_hydrated_later', role: 'assistant', parentId: 'msg_append_2', text: 'working', meta: {} }],
            ]),
            timeline: ['msg_root', 'msg_append_1', 'msg_owner', 'msg_append_2', 'msg_hydrated_later'],
            clientKeyToServerId: new Map<string, string>(),
            serverIdToClientKey: new Map<string, string>(),
            backendTurnInFlight: true,
            turnFullyFinalized: false,
            canceledActiveTurn: false,
            currentTurnAssistantKey: 'msg_owner',
            currentTurnAssistantMsgId: 'msg_owner',
            thinkingId: 'msg_owner',
            appendFollowupIdentity: {
                kind: 'append-followup', mode: 'same-turn-handoff', generation: 1,
                predecessorAssistantMsgId: 'msg_before', appendUserMsgId: 'msg_append_1', assistantMsgId: 'msg_owner',
            },
        };
        const appendIndex = context.buildAppendChildPresentationIndex(session);

        expect(context.isAppendChildTopLevelUser(session, session.messagesById.get('msg_append_2'), 'msg_append_2', appendIndex)).toBe(true);
        expect(context.isAppendChainTopLevelAssistantHidden(session, session.messagesById.get('msg_owner'), 'msg_owner', appendIndex)).toBe(false);
        expect(context.isAppendChainTopLevelAssistantHidden(session, session.messagesById.get('msg_hydrated_later'), 'msg_hydrated_later', appendIndex)).toBe(true);
    });

    it('does not hide a finalized historical append root while another root has an active append handoff', () => {
        const { context } = loadAppendPresentationHarness();
        const session = {
            messagesById: new Map<string, any>([
                ['msg_old_root', {
                    id: 'msg_old_root', role: 'user', text: 'old root', meta: {
                        appendedPrompts: [
                            { clientMessageId: 'old-append', appendUserMsgId: 'msg_old_append', text: 'old follow-up', status: 'received' },
                        ],
                    },
                }],
                ['msg_old_append', { id: 'msg_old_append', role: 'user', text: 'old follow-up', meta: {} }],
                ['msg_old_final', {
                    id: 'msg_old_final', role: 'assistant', parentId: 'msg_old_append', text: 'historical final',
                    meta: { isThinking: false },
                }],
                ['msg_active_root', {
                    id: 'msg_active_root', role: 'user', text: 'active root', meta: {
                        appendedPrompts: [
                            { clientMessageId: 'active-append', appendUserMsgId: 'msg_active_append', text: 'active follow-up', status: 'received' },
                        ],
                    },
                }],
                ['msg_active_append', { id: 'msg_active_append', role: 'user', text: 'active follow-up', meta: {} }],
                ['msg_active_owner', {
                    id: 'msg_active_owner', role: 'assistant', parentId: 'msg_active_append', text: 'working',
                    meta: { isThinking: true },
                }],
            ]),
            timeline: [
                'msg_old_root', 'msg_old_append', 'msg_old_final',
                'msg_active_root', 'msg_active_append', 'msg_active_owner',
            ],
            clientKeyToServerId: new Map<string, string>(),
            serverIdToClientKey: new Map<string, string>(),
            backendTurnInFlight: true,
            turnFullyFinalized: false,
            canceledActiveTurn: false,
            currentTurnAssistantKey: 'msg_active_owner',
            currentTurnAssistantMsgId: 'msg_active_owner',
            thinkingId: 'msg_active_owner',
            appendFollowupIdentity: {
                kind: 'append-followup', mode: 'same-turn-handoff', generation: 1,
                predecessorAssistantMsgId: 'msg_active_before',
                appendUserMsgId: 'msg_active_append',
                assistantMsgId: 'msg_active_owner',
            },
        };

        const appendIndex = context.buildAppendChildPresentationIndex(session);

        expect(context.isAppendChainTopLevelAssistantHidden(
            session, session.messagesById.get('msg_old_final'), 'msg_old_final', appendIndex,
        )).toBe(false);
        expect(context.isAppendChainTopLevelAssistantHidden(
            session, session.messagesById.get('msg_active_owner'), 'msg_active_owner', appendIndex,
        )).toBe(false);
    });

    it('keeps an aliased current in-flight assistant visible without exposing other append-chain assistants', () => {
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
                ['msg_assistant_old', {
                    id: 'msg_assistant_old',
                    role: 'assistant',
                    text: 'older result',
                    parentId: 'msg_root_A',
                    meta: {},
                }],
                ['msg_assistant_active', {
                    id: 'msg_assistant_active',
                    role: 'assistant',
                    text: 'working',
                    parentId: 'msg_root_A',
                    meta: {},
                }],
            ]),
            timeline: ['msg_root_A', 'msg_assistant_old', 'msg_assistant_active', 'msg_append_child_A'],
            clientKeyToServerId: new Map<string, string>([['local-assistant-active', 'msg_assistant_active']]),
            serverIdToClientKey: new Map<string, string>([['msg_assistant_active', 'local-assistant-active']]),
            backendTurnInFlight: true,
            turnFullyFinalized: false,
            canceledActiveTurn: false,
            currentTurnAssistantKey: 'local-assistant-active',
        };

        const appendIndex = context.buildAppendChildPresentationIndex(session);

        expect(context.isAppendChainTopLevelAssistantHidden(
            session,
            session.messagesById.get('msg_assistant_active'),
            'msg_assistant_active',
            appendIndex,
        )).toBe(false);
        expect(context.isAppendChainTopLevelAssistantHidden(
            session,
            session.messagesById.get('msg_assistant_old'),
            'msg_assistant_old',
            appendIndex,
        )).toBe(true);
    });

    it('keeps one predecessor presentation mounted until an append successor has content', () => {
        const { context } = loadAppendPresentationHarness();
        const session = {
            messagesById: new Map<string, any>([
                ['msg_root', {
                    id: 'msg_root',
                    role: 'user',
                    text: 'root prompt',
                    meta: {
                        appendedPrompts: [{
                            clientMessageId: 'append-client',
                            appendUserMsgId: 'msg_append',
                            text: 'follow up',
                            status: 'sending',
                        }],
                    },
                }],
                ['msg_predecessor', {
                    id: 'msg_predecessor',
                    role: 'assistant',
                    text: 'running task',
                    parentId: 'msg_root',
                    meta: {},
                }],
                ['msg_append', { id: 'msg_append', role: 'user', text: 'follow up', meta: {} }],
                ['msg_successor', {
                    id: 'msg_successor',
                    role: 'assistant',
                    text: '',
                    parentId: 'msg_append',
                    meta: { isThinking: true, statusText: '' },
                }],
            ]),
            timeline: ['msg_root', 'msg_predecessor', 'msg_append', 'msg_successor'],
            clientKeyToServerId: new Map<string, string>(),
            serverIdToClientKey: new Map<string, string>(),
            backendTurnInFlight: true,
            turnFullyFinalized: false,
            canceledActiveTurn: false,
            currentTurnAssistantKey: 'msg_successor',
            currentTurnAssistantMsgId: 'msg_successor',
            thinkingId: 'msg_successor',
            appendFollowupIdentity: {
                predecessorAssistantMsgId: 'msg_canonical_predecessor',
                predecessorPresentationAssistantId: 'msg_predecessor',
                appendUserMsgId: 'msg_append',
                assistantMsgId: 'msg_successor',
            },
        };
        const appendIndex = context.buildAppendChildPresentationIndex(session);

        expect(context.isAppendChainTopLevelAssistantHidden(
            session, session.messagesById.get('msg_predecessor'), 'msg_predecessor', appendIndex,
        )).toBe(false);
        expect(context.isAppendChainTopLevelAssistantHidden(
            session, session.messagesById.get('msg_successor'), 'msg_successor', appendIndex,
        )).toBe(true);

        session.messagesById.get('msg_successor').text = 'OK';

        expect(context.isAppendChainTopLevelAssistantHidden(
            session, session.messagesById.get('msg_predecessor'), 'msg_predecessor', appendIndex,
        )).toBe(true);
        expect(context.isAppendChainTopLevelAssistantHidden(
            session, session.messagesById.get('msg_successor'), 'msg_successor', appendIndex,
        )).toBe(false);
    });

    it('hides the append predecessor after handoff even when stale active aliases still reference it', () => {
        const { context } = loadAppendPresentationHarness();
        const session = {
            messagesById: new Map<string, any>([
                ['msg_root', {
                    id: 'msg_root',
                    role: 'user',
                    text: 'root prompt',
                    meta: {
                        appendedPrompts: [{
                            clientMessageId: 'append-client',
                            appendUserMsgId: 'msg_append',
                            text: 'follow up',
                            status: 'received',
                        }],
                    },
                }],
                ['msg_predecessor', {
                    id: 'msg_predecessor',
                    role: 'assistant',
                    text: 'first stage',
                    parentId: 'msg_root',
                    meta: {},
                }],
                ['msg_append', { id: 'msg_append', role: 'user', text: 'follow up', meta: {} }],
                ['msg_successor', {
                    id: 'msg_successor',
                    role: 'assistant',
                    text: 'second stage',
                    parentId: 'msg_append',
                    meta: { isThinking: true },
                }],
            ]),
            timeline: ['msg_root', 'msg_predecessor', 'msg_append', 'msg_successor'],
            clientKeyToServerId: new Map<string, string>([['tmp-assistant', 'msg_predecessor']]),
            serverIdToClientKey: new Map<string, string>([['msg_predecessor', 'tmp-assistant']]),
            backendTurnInFlight: true,
            turnFullyFinalized: false,
            canceledActiveTurn: false,
            currentTurnAssistantKey: 'msg_successor',
            currentTurnAssistantMsgId: 'msg_successor',
            thinkingId: 'msg_successor',
            pendingAssistantUpgrade: {
                tmpKey: 'tmp-assistant',
                assistantMsgId: 'msg_predecessor',
            },
            appendFollowupIdentity: {
                kind: 'append-followup',
                mode: 'same-turn-handoff',
                predecessorAssistantMsgId: 'msg_predecessor',
                predecessorPresentationAssistantId: 'msg_predecessor',
                appendUserMsgId: 'msg_append',
                assistantMsgId: 'msg_successor',
            },
        };
        const appendIndex = context.buildAppendChildPresentationIndex(session);

        expect(context.isAppendChainTopLevelAssistantHidden(
            session, session.messagesById.get('msg_predecessor'), 'msg_predecessor', appendIndex,
        )).toBe(true);
        expect(context.isAppendChainTopLevelAssistantHidden(
            session, session.messagesById.get('msg_successor'), 'msg_successor', appendIndex,
        )).toBe(false);
    });

    it('does not resurrect an older append generation through a hydrated pending upgrade alias', () => {
        const { context } = loadAppendPresentationHarness();
        const messagesById = new Map<string, any>([
            ['msg_root', {
                id: 'msg_root', role: 'user', text: 'root', meta: {
                    appendedPrompts: [
                        { appendUserMsgId: 'msg_append_1', text: 'one' },
                        { appendUserMsgId: 'msg_append_2', text: 'two' },
                    ],
                },
            }],
            ['msg_old', { id: 'msg_old', role: 'assistant', text: 'old generation', parentId: 'msg_root', meta: {} }],
            ['msg_append_1', { id: 'msg_append_1', role: 'user', text: 'one', meta: {} }],
            ['msg_middle', { id: 'msg_middle', role: 'assistant', text: 'middle generation', parentId: 'msg_append_1', meta: {} }],
            ['msg_append_2', { id: 'msg_append_2', role: 'user', text: 'two', meta: {} }],
            ['msg_current', { id: 'msg_current', role: 'assistant', text: 'current generation', parentId: 'msg_append_2', meta: { isThinking: true } }],
        ]);
        const session = {
            messagesById,
            timeline: [...messagesById.keys()],
            clientKeyToServerId: new Map<string, string>([['tmp-old', 'msg_old']]),
            serverIdToClientKey: new Map<string, string>([['msg_old', 'tmp-old']]),
            backendTurnInFlight: true,
            turnFullyFinalized: false,
            canceledActiveTurn: false,
            currentTurnAssistantKey: 'msg_current',
            currentTurnAssistantMsgId: 'msg_current',
            thinkingId: 'msg_current',
            pendingAssistantUpgrade: { tmpKey: 'tmp-old', assistantMsgId: 'msg_old' },
            appendFollowupIdentity: {
                kind: 'append-followup',
                mode: 'same-turn-handoff',
                predecessorAssistantMsgId: 'msg_middle',
                predecessorPresentationAssistantId: 'msg_middle',
                appendUserMsgId: 'msg_append_2',
                assistantMsgId: 'msg_current',
            },
        };
        const appendIndex = context.buildAppendChildPresentationIndex(session);

        expect(context.isAppendChainTopLevelAssistantHidden(
            session, messagesById.get('msg_old'), 'msg_old', appendIndex,
        )).toBe(true);
        expect(context.isAppendChainTopLevelAssistantHidden(
            session, messagesById.get('msg_middle'), 'msg_middle', appendIndex,
        )).toBe(true);
        expect(context.isAppendChainTopLevelAssistantHidden(
            session, messagesById.get('msg_current'), 'msg_current', appendIndex,
        )).toBe(false);
    });

    it('hides every hydrated assistant stage sharing the active successor parent', () => {
        const { context } = loadAppendPresentationHarness();
        const messagesById = new Map<string, any>([
            ['msg_user', { id: 'msg_user', role: 'user', text: 'run analysis', meta: {} }],
            ['msg_old', { id: 'msg_old', role: 'assistant', text: 'first stage', parentId: 'msg_user', meta: {} }],
            ['msg_middle', { id: 'msg_middle', role: 'assistant', text: 'second stage', parentId: 'msg_user', meta: {} }],
            ['msg_current', { id: 'msg_current', role: 'assistant', text: 'current stage', parentId: 'msg_user', meta: { isThinking: true } }],
        ]);
        const session = {
            messagesById,
            timeline: [...messagesById.keys()],
            clientKeyToServerId: new Map(),
            serverIdToClientKey: new Map<string, string>([
                ['msg_old', 'msg_current'],
                ['msg_middle', 'msg_current'],
                ['msg_current', 'msg_current'],
            ]),
            backendTurnInFlight: true,
            turnFullyFinalized: false,
            canceledActiveTurn: false,
            currentTurnAssistantKey: 'msg_current',
            currentTurnAssistantMsgId: 'msg_current',
            thinkingId: 'msg_current',
            appendFollowupIdentity: {
                kind: 'append-followup',
                mode: 'same-turn-handoff',
                predecessorAssistantMsgId: 'msg_middle',
                predecessorPresentationAssistantId: 'msg_middle',
                appendUserMsgId: 'msg_user',
                assistantMsgId: 'msg_current',
            },
        };
        const appendIndex = context.buildAppendChildPresentationIndex(session);

        expect(context.isAppendChainTopLevelAssistantHidden(
            session, messagesById.get('msg_old'), 'msg_old', appendIndex,
        )).toBe(true);
        expect(context.isAppendChainTopLevelAssistantHidden(
            session, messagesById.get('msg_middle'), 'msg_middle', appendIndex,
        )).toBe(true);
        expect(context.isAppendChainTopLevelAssistantHidden(
            session, messagesById.get('msg_current'), 'msg_current', appendIndex,
        )).toBe(false);

        session.backendTurnInFlight = false;
        session.turnFullyFinalized = true;
        (session as any).appendFollowupIdentity = null;
        const finalizedIndex = context.buildAppendChildPresentationIndex(session);
        expect(context.isAppendChainTopLevelAssistantHidden(
            session, messagesById.get('msg_old'), 'msg_old', finalizedIndex,
        )).toBe(false);
    });

    it('keeps the predecessor hidden after the transient append handoff is cleared', () => {
        const { context } = loadAppendPresentationHarness();
        const session = {
            messagesById: new Map<string, any>([
                ['msg_root', {
                    id: 'msg_root',
                    role: 'user',
                    text: 'root prompt',
                    meta: {
                        appendedPrompts: [{
                            clientMessageId: 'append-client',
                            appendUserMsgId: 'msg_append',
                            text: 'follow up',
                            status: 'received',
                        }],
                    },
                }],
                ['msg_predecessor', {
                    id: 'msg_predecessor',
                    role: 'assistant',
                    text: 'first stage',
                    // Streaming messages do not always retain their backend
                    // parent on the Webview presentation object.
                    meta: {},
                }],
                ['msg_append', { id: 'msg_append', role: 'user', text: 'follow up', meta: {} }],
                ['msg_successor', {
                    id: 'msg_successor',
                    role: 'assistant',
                    text: 'final stage',
                    parentId: 'msg_append',
                    meta: {
                        isThinking: false,
                        appendPresentationPredecessorId: 'msg_predecessor',
                        appendPresentationGeneration: 1,
                    },
                }],
            ]),
            timeline: ['msg_root', 'msg_predecessor', 'msg_append', 'msg_successor'],
            clientKeyToServerId: new Map<string, string>(),
            serverIdToClientKey: new Map<string, string>(),
            backendTurnInFlight: true,
            turnFullyFinalized: false,
            canceledActiveTurn: false,
            currentTurnAssistantKey: null,
            currentTurnAssistantMsgId: null,
            thinkingId: null,
            pendingAssistantUpgrade: null,
            appendFollowupIdentity: null,
        };
        const appendIndex = context.buildAppendChildPresentationIndex(session);

        expect(context.isAppendChainTopLevelAssistantHidden(
            session, session.messagesById.get('msg_predecessor'), 'msg_predecessor', appendIndex,
        )).toBe(true);
        expect(context.isAppendChainTopLevelAssistantHidden(
            session, session.messagesById.get('msg_successor'), 'msg_successor', appendIndex,
        )).toBe(false);

        session.backendTurnInFlight = false;
        session.turnFullyFinalized = true;
        expect(context.isAppendChainTopLevelAssistantHidden(
            session, session.messagesById.get('msg_predecessor'), 'msg_predecessor', appendIndex,
        )).toBe(true);
    });

    it('keeps every retired append presentation hidden across three assistant generations', () => {
        const { context } = loadAppendPresentationHarness();
        const generationOne = {
            id: 'msg_generation_one',
            role: 'assistant',
            text: 'first temporary presentation',
            meta: {},
        };
        const generationTwo = {
            id: 'msg_generation_two',
            role: 'assistant',
            text: 'second temporary presentation',
            meta: {
                appendPresentationPredecessorId: generationOne.id,
                appendPresentationRetiredIds: [generationOne.id],
            },
        };
        const generationThree = {
            id: 'msg_generation_three',
            role: 'assistant',
            text: 'third temporary presentation',
            meta: {
                appendPresentationPredecessorId: generationTwo.id,
                appendPresentationRetiredIds: context.collectAppendPresentationRetiredIds(
                    generationTwo,
                    generationTwo.id,
                    'msg_current',
                ),
            },
        };
        const current = {
            id: 'msg_current',
            role: 'assistant',
            text: 'current presentation',
            parentId: 'msg_append',
            meta: {
                appendPresentationPredecessorId: generationThree.id,
                appendPresentationRetiredIds: context.collectAppendPresentationRetiredIds(
                    generationThree,
                    generationThree.id,
                    'msg_current',
                ),
            },
        };
        const session = {
            messagesById: new Map<string, any>([
                ['msg_root', {
                    id: 'msg_root',
                    role: 'user',
                    text: 'root prompt',
                    meta: {
                        appendedPrompts: [{
                            clientMessageId: 'append-client',
                            appendUserMsgId: 'msg_append',
                            text: 'follow up',
                            status: 'received',
                        }],
                    },
                }],
                [generationOne.id, generationOne],
                [generationTwo.id, generationTwo],
                [generationThree.id, generationThree],
                ['msg_append', { id: 'msg_append', role: 'user', text: 'follow up', meta: {} }],
                [current.id, current],
            ]),
            timeline: [
                'msg_root', generationOne.id, generationTwo.id, generationThree.id, 'msg_append', current.id,
            ],
            clientKeyToServerId: new Map<string, string>(),
            serverIdToClientKey: new Map<string, string>(),
            backendTurnInFlight: true,
            turnFullyFinalized: false,
            canceledActiveTurn: false,
            currentTurnAssistantKey: current.id,
            currentTurnAssistantMsgId: current.id,
            thinkingId: current.id,
            pendingAssistantUpgrade: null,
            appendFollowupIdentity: null,
        };
        const appendIndex = context.buildAppendChildPresentationIndex(session);

        for (const retired of [generationOne, generationTwo, generationThree]) {
            expect(context.isAppendChainTopLevelAssistantHidden(
                session, retired, retired.id, appendIndex,
            )).toBe(true);
        }
        expect(context.isAppendChainTopLevelAssistantHidden(
            session, current, current.id, appendIndex,
        )).toBe(false);

        // The retirement metadata is durable presentation state. It must still
        // suppress old generations after finalization or a virtual-window rebuild.
        session.backendTurnInFlight = false;
        session.turnFullyFinalized = true;
        for (const retired of [generationOne, generationTwo, generationThree]) {
            expect(context.isAppendChainTopLevelAssistantHidden(
                session, retired, retired.id, appendIndex,
            )).toBe(true);
        }
    });

    it('does not hide a final successor through a preserved canonical predecessor alias', () => {
        const { context } = loadAppendPresentationHarness();
        const session = {
            messagesById: new Map<string, any>([
                ['msg_root', {
                    id: 'msg_root',
                    role: 'user',
                    text: 'root prompt',
                    meta: {
                        appendedPrompts: [{
                            clientMessageId: 'append-client',
                            appendUserMsgId: 'msg_append',
                            text: 'follow up',
                            status: 'received',
                        }],
                    },
                }],
                ['msg_predecessor', {
                    id: 'msg_predecessor',
                    role: 'assistant',
                    text: 'first stage',
                    parentId: 'msg_root',
                    meta: {},
                }],
                ['msg_append', { id: 'msg_append', role: 'user', text: 'follow up', meta: {} }],
                ['msg_successor', {
                    id: 'msg_successor',
                    role: 'assistant',
                    text: 'final stage',
                    parentId: 'msg_append',
                    meta: {
                        isThinking: false,
                        appendPresentationPredecessorId: 'msg_predecessor',
                        appendPresentationGeneration: 1,
                    },
                }],
            ]),
            timeline: ['msg_root', 'msg_predecessor', 'msg_append', 'msg_successor'],
            clientKeyToServerId: new Map<string, string>(),
            // Hydration deliberately preserves this canonical handoff alias.
            serverIdToClientKey: new Map<string, string>([
                ['msg_predecessor', 'msg_successor'],
                ['msg_successor', 'msg_successor'],
            ]),
            backendTurnInFlight: false,
            turnFullyFinalized: true,
            canceledActiveTurn: false,
            currentTurnAssistantKey: null,
            currentTurnAssistantMsgId: null,
            thinkingId: null,
            pendingAssistantUpgrade: null,
            appendFollowupIdentity: null,
        };
        const appendIndex = context.buildAppendChildPresentationIndex(session);

        expect(context.isAppendChainTopLevelAssistantHidden(
            session, session.messagesById.get('msg_predecessor'), 'msg_predecessor', appendIndex,
        )).toBe(true);
        expect(context.isAppendChainTopLevelAssistantHidden(
            session, session.messagesById.get('msg_successor'), 'msg_successor', appendIndex,
        )).toBe(false);
    });

    it('does not hide a finalized successor through its retired temporary DOM alias', () => {
        const { context } = loadAppendPresentationHarness();
        const session = {
            messagesById: new Map<string, any>([
                ['msg_root', {
                    id: 'msg_root',
                    role: 'user',
                    text: 'root prompt',
                    meta: {
                        appendedPrompts: [{
                            clientMessageId: 'append-client',
                            appendUserMsgId: 'msg_append',
                            text: 'follow up',
                            status: 'received',
                        }],
                    },
                }],
                ['tmp:assistant', {
                    id: 'tmp:assistant',
                    role: 'assistant',
                    text: 'temporary predecessor',
                    parentId: 'msg_root',
                    meta: {},
                }],
                ['msg_append', { id: 'msg_append', role: 'user', text: 'follow up', meta: {} }],
                ['msg_final', {
                    id: 'msg_final',
                    role: 'assistant',
                    text: 'durable final answer',
                    parentId: 'msg_append',
                    meta: {
                        isThinking: false,
                        appendPresentationPredecessorId: 'tmp:assistant',
                        appendPresentationRetiredIds: ['tmp:assistant'],
                        appendPresentationGeneration: 1,
                    },
                }],
                ['msg_other_root', {
                    id: 'msg_other_root',
                    role: 'user',
                    text: 'new turn',
                    meta: {
                        appendedPrompts: [{
                            clientMessageId: 'other-append-client',
                            appendUserMsgId: 'msg_other_append',
                            text: 'continue active turn',
                            status: 'received',
                        }],
                    },
                }],
                ['msg_other_append', {
                    id: 'msg_other_append',
                    role: 'user',
                    text: 'continue active turn',
                    meta: {},
                }],
                ['msg_other_turn', {
                    id: 'msg_other_turn',
                    role: 'assistant',
                    text: 'current active answer',
                    parentId: 'msg_other_append',
                    meta: { isThinking: true },
                }],
            ]),
            timeline: [
                'msg_root', 'tmp:assistant', 'msg_append', 'msg_final',
                'msg_other_root', 'msg_other_append', 'msg_other_turn',
            ],
            clientKeyToServerId: new Map<string, string>([['tmp:assistant', 'msg_final']]),
            serverIdToClientKey: new Map<string, string>([['msg_final', 'tmp:assistant']]),
            backendTurnInFlight: true,
            turnFullyFinalized: false,
            canceledActiveTurn: false,
            currentTurnAssistantKey: 'msg_other_turn',
            currentTurnAssistantMsgId: 'msg_other_turn',
            thinkingId: 'msg_other_turn',
            pendingAssistantUpgrade: null,
            appendFollowupIdentity: {
                kind: 'append-followup',
                mode: 'same-turn-handoff',
                appendUserMsgId: 'msg_other_append',
                assistantMsgId: 'msg_other_turn',
            },
        };
        const appendIndex = context.buildAppendChildPresentationIndex(session);

        expect(context.isAppendChainTopLevelAssistantHidden(
            session, session.messagesById.get('tmp:assistant'), 'tmp:assistant', appendIndex,
        )).toBe(true);
        expect(context.isAppendChainTopLevelAssistantHidden(
            session, session.messagesById.get('msg_final'), 'msg_final', appendIndex,
        )).toBe(false);
        expect(context.isAppendChainTopLevelAssistantHidden(
            session, session.messagesById.get('msg_other_turn'), 'msg_other_turn', appendIndex,
        )).toBe(false);
    });

    it('does not reattach predecessor subagent state while finalizing an append successor', () => {
        const { context, sessions } = loadAppendChatDoneHarness();
        const successor = {
            id: 'msg_successor',
            role: 'assistant',
            text: 'OK',
            meta: {
                isThinking: true,
                statusText: '',
                subagents: [{ sessionId: 'ses_agent', state: 'done', title: 'old status' }],
            },
        };
        const session = {
            messagesById: new Map<string, any>([['msg_successor', successor]]),
            timeline: ['msg_successor'],
            thinkingId: 'msg_successor',
            currentTurnAssistantKey: 'msg_successor',
            currentTurnAssistantMsgId: 'msg_successor',
            activeSubagents: [{ sessionId: 'ses_agent', state: 'done', title: 'old status' }],
            appendFollowupIdentity: {
                kind: 'append-followup',
                mode: 'same-turn-handoff',
                assistantMsgId: 'msg_successor',
                predecessorSubagentSessionIds: ['ses_agent'],
            },
            backendTurnInFlight: true,
            turnFullyFinalized: false,
        };
        sessions.set('ses_A', session);

        context.handleChatDone('ses_A', { lastAssistantMsgId: 'msg_successor' });

        expect(successor.meta.subagents).toBeUndefined();
        expect(session.activeSubagents).toEqual([]);
        expect(session.appendFollowupIdentity).toBeNull();
        expect(successor.meta.isThinking).toBe(false);
    });

    it('clears a transient append owner when chatDone resolves to a later assistant generation', () => {
        const { context, sessions } = loadAppendChatDoneHarness();
        const terminal = {
            id: 'msg_terminal',
            role: 'assistant',
            text: 'final answer',
            meta: { isThinking: true, statusText: '' },
        };
        const session = {
            messagesById: new Map<string, any>([['msg_terminal', terminal]]),
            timeline: ['msg_terminal'],
            thinkingId: 'msg_terminal',
            currentTurnAssistantKey: 'msg_terminal',
            currentTurnAssistantMsgId: 'msg_terminal',
            appendFollowupIdentity: {
                kind: 'append-followup',
                mode: 'same-turn-handoff',
                generation: 6,
                assistantMsgId: 'msg_append_successor',
                predecessorAssistantMsgId: 'msg_append_predecessor',
            },
            backendTurnInFlight: true,
            turnFullyFinalized: false,
        };
        sessions.set('ses_A', session);

        context.handleChatDone('ses_A', { lastAssistantMsgId: 'msg_terminal' });

        expect(session.appendFollowupIdentity).toBeNull();
        expect(terminal.meta.isThinking).toBe(false);
    });

    it('clears a stale append owner before a normal prompt starts its thinking presentation', () => {
        const source = fs.readFileSync(path.join(__dirname, '../../../media/main.js'), 'utf8');
        const promptStart = source.indexOf('function applyPromptToSession');
        const promptEnd = source.indexOf('function canAppendToMessage', promptStart);
        const promptBlock = source.slice(promptStart, promptEnd);

        const clearIndex = promptBlock.indexOf("clearTransientAppendFollowupIdentity(sessionId, session, 'new-normal-turn')");
        const lifecycleIndex = promptBlock.indexOf('turnLifecycleController.start(session)');
        const invariantIndex = promptBlock.indexOf("assertInvariants(sessionId, 'sendPrompt')");

        expect(clearIndex).toBeGreaterThanOrEqual(0);
        expect(clearIndex).toBeLessThan(lifecycleIndex);
        expect(clearIndex).toBeLessThan(invariantIndex);
    });

    it('uses the extension-owned turn timestamps when finalizing the live assistant presentation', () => {
        const { context, sessions } = loadAppendChatDoneHarness();
        const assistant: any = {
            id: 'msg_final',
            role: 'assistant',
            text: 'final answer',
            meta: {
                isThinking: true,
                processingStartedAt: 5_000,
                timeCompleted: 70_000,
                currentSegment: 'final answer',
            },
        };
        sessions.set('ses_A', {
            messagesById: new Map<string, any>([['msg_final', assistant]]),
            timeline: ['msg_final'],
            thinkingId: 'msg_final',
            currentTurnAssistantKey: 'msg_final',
            currentTurnAssistantMsgId: 'msg_final',
            backendTurnInFlight: true,
            turnFullyFinalized: false,
        });

        context.handleChatDone('ses_A', {
            lastAssistantMsgId: 'msg_final',
            processingStartedAt: 1_000,
            completedAt: 76_000,
        });

        expect(assistant.meta.processingStartedAt).toBe(1_000);
        expect(assistant.meta.processingCompletedAt).toBe(76_000);
        expect(assistant.meta.isThinking).toBe(false);
    });

    it('keeps post-handoff subagents on the append successor while excluding predecessor agents', () => {
        const { context } = loadAppendSnapshotMetaHarness();
        const predecessor = {
            id: 'msg_predecessor',
            role: 'assistant',
            meta: {
                subagents: [{ sessionId: 'ses_old', state: 'done', title: 'old coder' }],
            },
        };
        const successor = {
            id: 'msg_successor',
            role: 'assistant',
            text: 'Continuing',
            meta: { isThinking: true },
        };
        const followup = {
            kind: 'append-followup',
            mode: 'same-turn-handoff',
            predecessorAssistantMsgId: predecessor.id,
            assistantMsgId: successor.id,
            predecessorSubagentSessionIds: ['ses_old'],
        };
        const session = {
            messagesById: new Map<string, any>([
                [predecessor.id, predecessor],
                [successor.id, successor],
            ]),
            appendFollowupIdentity: followup,
        };

        const visible = context.filterAppendSuccessorSubagents(session, successor, [
            { sessionId: 'ses_old', state: 'done', title: 'old coder' },
            { sessionId: 'ses_new', state: 'running', title: 'new verifier' },
        ]);

        expect(visible).toEqual([
            expect.objectContaining({ sessionId: 'ses_new', state: 'running' }),
        ]);
        expect(predecessor.meta.subagents).toEqual([
            expect.objectContaining({ sessionId: 'ses_old' }),
        ]);
    });

    it('snapshots a post-handoff subagent when finalizing the append successor', () => {
        const { context, sessions } = loadAppendChatDoneHarness();
        const successor: any = {
            id: 'msg_successor',
            role: 'assistant',
            text: 'OK',
            meta: { isThinking: true, statusText: '' },
        };
        const session = {
            messagesById: new Map<string, any>([['msg_successor', successor]]),
            timeline: ['msg_successor'],
            thinkingId: 'msg_successor',
            currentTurnAssistantKey: 'msg_successor',
            currentTurnAssistantMsgId: 'msg_successor',
            activeSubagents: [{ sessionId: 'ses_new', state: 'done', title: 'new verifier' }],
            appendFollowupIdentity: {
                kind: 'append-followup',
                mode: 'same-turn-handoff',
                assistantMsgId: 'msg_successor',
                predecessorSubagentSessionIds: ['ses_old'],
            },
            backendTurnInFlight: true,
            turnFullyFinalized: false,
        };
        sessions.set('ses_A', session);

        context.handleChatDone('ses_A', { lastAssistantMsgId: 'msg_successor' });

        expect(successor.meta.subagents).toEqual([
            expect.objectContaining({
                sessionId: 'ses_new',
                state: 'done',
                latestText: null,
                latestTool: null,
            }),
        ]);
        expect(session.activeSubagents).toEqual([]);
        expect(session.appendFollowupIdentity).toBeNull();
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
