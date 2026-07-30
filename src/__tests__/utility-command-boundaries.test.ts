jest.mock('vscode', () => {
    const executeCommand = jest.fn();
    const showOpenDialog = jest.fn();
    const showErrorMessage = jest.fn();
    const showQuickPick = jest.fn();
    const openTextDocument = jest.fn();
    const showTextDocument = jest.fn();
    return {
        commands: { executeCommand },
        window: {
            createOutputChannel: () => ({ appendLine: () => undefined, append: () => undefined, dispose: () => undefined }),
            showOpenDialog,
            showErrorMessage,
            showInformationMessage: jest.fn(),
            showTextDocument,
            showQuickPick,
        },
        workspace: {
            workspaceFolders: [],
            openTextDocument,
            findFiles: jest.fn(async () => []),
        },
        Uri: {
            joinPath: (...parts: any[]) => parts.join('/'),
            file: (fsPath: string) => ({ fsPath }),
        },
        Position: class Position {
            constructor(public readonly line: number, public readonly character: number) {}
        },
        Selection: class Selection {
            constructor(public readonly anchor: unknown, public readonly active: unknown) {}
        },
        Range: class Range {
            constructor(public readonly start: unknown, public readonly end: unknown) {}
        },
        TextEditorRevealType: { InCenter: 0 },
    };
}, { virtual: true });

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { resolveSidebarWebviewView } from '../webview/SidebarWebviewController';
import { createUtilityCommandHandler } from '../webview/controllers/UtilityCommandController';

const controllerSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'webview', 'SidebarWebviewController.ts'),
    'utf8',
);
const utilityControllerSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'webview', 'controllers', 'UtilityCommandController.ts'),
    'utf8',
);

function createHarness(overrides: Record<string, unknown> = {}) {
    let messageRegistrations = 0;
    let messageHandler: ((data: any) => Promise<void>) | undefined;
    const posts: any[] = [];
    const webview: any = {
        options: {},
        html: '',
        asWebviewUri: (uri: any) => ({ toString: () => `webview:${uri.fsPath}` }),
        postMessage: jest.fn(async (message: any) => {
            posts.push(message);
            return true;
        }),
        onDidReceiveMessage: (handler: (data: any) => Promise<void>) => {
            messageRegistrations += 1;
            messageHandler = handler;
        },
    };
    const view: any = {
        webview,
        visible: true,
        onDidChangeVisibility: jest.fn(),
        onDidDispose: jest.fn(),
    };
    const host: any = {
        _view: undefined,
        _extensionUri: {},
        _webviewInstanceId: '',
        webviewLivenessPanelSeq: 0,
        initPosted: false,
        resetWebviewLiveness: jest.fn(),
        uiDebugChannel: { appendLine: jest.fn() },
        _getHtmlForWebview: jest.fn(() => '<html></html>'),
        beginWebviewLifecycleResolution: (targetView: any) => {
            host._view = targetView;
            return 'panel-1';
        },
        getLifecycleActiveWebview: (fallback?: any) => host._view?.webview || fallback,
        startWebviewLivenessProbes: jest.fn(),
        stopWebviewLivenessProbes: jest.fn(),
        triggerWebviewLivenessProbe: jest.fn(),
        selectedModel: undefined,
        selectedMode: 'plan',
        selectedVariant: undefined,
        availableModes: ['plan', 'build'],
        _context: { globalState: { update: jest.fn(async () => undefined) } },
        postModelQuota: jest.fn(async () => undefined),
        applyUtilityModelSelection: async function (this: any, value: unknown, targetWebview: unknown) {
            this.selectedModel = value || undefined;
            await this._context.globalState.update('opencode.model', this.selectedModel);
            await this.postModelQuota(targetWebview, 'model-change');
        },
        applyUtilityModeSelection: async function (this: any, value: unknown) {
            const requestedMode = typeof value === 'string' ? value : '';
            this.selectedMode = this.availableModes.includes(requestedMode)
                ? requestedMode
                : (this.availableModes[0] || 'plan');
            await this._context.globalState.update('opencode.mode', this.selectedMode);
        },
        applyUtilityVariantSelection: async function (this: any, value: unknown) {
            this.selectedVariant = value || undefined;
            await this._context.globalState.update('opencode.variant', this.selectedVariant);
        },
        resolveUtilityLocalQuestion: function (this: any, callId: string, result: any) {
            const pending = callId ? this.pendingLocalQuestionRequests.get(callId) : undefined;
            if (!pending) return { resolved: false };
            this.pendingLocalQuestionRequests.delete(callId);
            pending.resolve({
                selectedId: typeof result?.selectedId === 'string' ? result.selectedId : undefined,
                selectedLabel: typeof result?.selectedLabel === 'string' ? result.selectedLabel : undefined,
            });
            return { resolved: true, sessionId: pending.sessionId };
        },
        refreshModels: jest.fn(async () => undefined),
        refreshModelQuota: jest.fn(async () => undefined),
        listWorkspaceFiles: jest.fn(async () => []),
        getAutoEditorContext: jest.fn(() => null),
        smartSearch: { run: jest.fn() },
        attachmentStorage: {
            saveClipboardImage: jest.fn(),
            getImageMimeFromName: jest.fn(() => 'image/png'),
            isImageFileName: jest.fn(() => true),
        },
        client: {
            summarizeSession: jest.fn(async () => undefined),
            fetchSessionUsage: jest.fn(async () => undefined),
            sendToolResult: jest.fn(async () => undefined),
            respondPermission: jest.fn(async () => undefined),
        },
        pendingLocalQuestionRequests: new Map(),
        gitUndoEnabled: true,
        openGitDiffForFile: jest.fn(async () => undefined),
        postAddResponse: jest.fn(),
        getWorkspaceRootPath: jest.fn(() => path.resolve('workspace')),
        ...overrides,
    };
    const utilityCommandHandler = createUtilityCommandHandler({
        getLiveWebview: (fallback) => host._view?.webview || fallback,
        log: (message) => host.uiDebugChannel.appendLine(message),
        applyModelSelection: (value, targetWebview) => host.applyUtilityModelSelection(value, targetWebview),
        applyModeSelection: (value) => host.applyUtilityModeSelection(value),
        applyVariantSelection: (value) => host.applyUtilityVariantSelection(value),
        pickCompactionModelId: () => undefined,
        parseModelRef: () => undefined,
        summarizeSession: (sessionId, options) => host.client.summarizeSession(sessionId, options),
        fetchSessionUsage: (sessionId) => host.client.fetchSessionUsage(sessionId),
        postAddResponse: (targetWebview, value, meta) => host.postAddResponse(targetWebview, value, meta),
        refreshModels: (targetWebview) => host.refreshModels(targetWebview),
        refreshModelQuota: (targetWebview) => host.refreshModelQuota(targetWebview),
        runSmartSearch: (sessionId, query, messages) => host.smartSearch.run(sessionId, query, messages),
        listWorkspaceFiles: (query) => host.listWorkspaceFiles(query),
        getAutoEditorContext: () => host.getAutoEditorContext(),
        saveClipboardImage: (dataUrl, mime) => host.attachmentStorage.saveClipboardImage(dataUrl, mime),
        getImageMimeFromName: (name) => host.attachmentStorage.getImageMimeFromName(name),
        isImageFileName: (name) => host.attachmentStorage.isImageFileName(name),
        isGitUndoEnabled: () => host.gitUndoEnabled,
        openGitDiffForFile: (sessionId, filePath, targetWebview, commitHead, commitBase) =>
            host.openGitDiffForFile(sessionId, filePath, targetWebview, commitHead, commitBase),
        sendToolResult: (input) => host.client.sendToolResult(input),
        resolveLocalQuestion: (callId, result) => host.resolveUtilityLocalQuestion(callId, result),
        respondPermission: (input) => host.client.respondPermission(input),
        getWorkspaceRootPath: () => host.getWorkspaceRootPath(),
    });
    resolveSidebarWebviewView(
        view,
        {} as any,
        {} as any,
        {
            localResourceRoots: [{} as any],
            getHtmlForWebview: () => host._getHtmlForWebview(),
            log: jest.fn(),
            utilityCommandHandler,
            sessionCommandHandler: () => false,
            turnCommandHandler: () => false,
            undoCommandHandler: () => false,
            lifecycleController: {
                begin: (targetView: any) => host.beginWebviewLifecycleResolution(targetView),
                getActiveWebview: (fallback: any) => host.getLifecycleActiveWebview(fallback),
                noteActivity: jest.fn(),
                handleCommand: () => false,
                handleVisibility: jest.fn(),
                handleDispose: jest.fn(),
            },
        },
    );
    return {
        host,
        view,
        posts,
        utilityCommandHandler,
        get messageRegistrations() { return messageRegistrations; },
        send: async (data: any) => {
            if (!messageHandler) throw new Error('message handler unavailable');
            await messageHandler(data);
        },
    };
}

describe('utility command family characterization', () => {
    test('routes utility-owned mutable state through a provider-composed narrow controller host', () => {
        const providerSource = fs.readFileSync(
            path.join(process.cwd(), 'src', 'SidebarProvider.ts'),
            'utf8',
        );
        expect(providerSource).toContain('this.utilityCommandHandler = createUtilityCommandHandler({');
        expect(providerSource).not.toContain('createUtilityCommandHandler(this)');
        expect(controllerSource).toContain('const utilityHandling = utilityCommandHandler(data, activeWebview, webviewView.webview)');
        expect(controllerSource).toContain('utilityHandling !== false && await utilityHandling');
        expect(utilityControllerSource).toContain('this.host.applyModelSelection(data.value, activeWebview)');
        expect(utilityControllerSource).toContain('this.host.applyModeSelection(data.value)');
        expect(utilityControllerSource).toContain('this.host.applyVariantSelection(data.value)');
        expect(utilityControllerSource).toContain('this.host.resolveLocalQuestion(callId, data?.result)');
        for (const forbidden of [
            'sendInFlightBySession',
            'pendingAssistantTmpKeyBySession',
            'undoSegmentsBySession',
            'webviewLivenessCurrent',
            'pendingConflictStore',
        ]) expect(utilityControllerSource).not.toContain(forbidden);
        for (const method of [
            'applyUtilityModelSelection', 'applyUtilityModeSelection',
            'applyUtilityVariantSelection', 'resolveUtilityLocalQuestion',
        ]) expect(providerSource).toMatch(new RegExp(`private (?:async )?${method}\\b`));
    });

    test('extracts every utility command while retaining one top-level message registration', () => {
        const commands = [
            'setModel', 'compactSession', 'setMode', 'setVariant', 'refreshModels', 'refreshModelQuota',
            'smartSessionSearch', 'listWorkspaceFiles', 'ping', 'reloadWindow',
            'getAutoEditorContext',
            'clipboardImage', 'selectAttachments', 'openGitDiff', 'toolResult',
            'localQuestionResult', 'permissionResult', 'openFileAtLocation',
            'resolveAssistantImageReferences',
        ];
        for (const command of commands) {
            expect(utilityControllerSource).toContain(`case '${command}'`);
            expect(controllerSource).not.toContain(`case "${command}"`);
        }
        expect(createHarness().messageRegistrations).toBe(1);
    });

    test('declines non-utility commands synchronously without adding an async boundary', () => {
        const harness = createHarness();
        const result = harness.utilityCommandHandler(
            { type: 'sendMessage' },
            harness.view.webview,
            harness.view.webview,
        );
        expect(result).toBe(false);
    });

    test('persists model, normalized mode, and variant with their existing keys and order', async () => {
        const harness = createHarness();
        await harness.send({ type: 'setModel', value: 'provider/model' });
        await harness.send({ type: 'setMode', value: 'invalid-mode' });
        await harness.send({ type: 'setVariant', value: 'fast' });

        expect(harness.host.selectedModel).toBe('provider/model');
        expect(harness.host.selectedMode).toBe('plan');
        expect(harness.host.selectedVariant).toBe('fast');
        expect(harness.host._context.globalState.update.mock.calls).toEqual([
            ['opencode.model', 'provider/model'],
            ['opencode.mode', 'plan'],
            ['opencode.variant', 'fast'],
        ]);
        expect(harness.host.postModelQuota).toHaveBeenCalledWith(harness.view.webview, 'model-change');
    });

    test('refreshes model quota without refreshing the full model catalog', async () => {
        const harness = createHarness();

        await harness.send({ type: 'refreshModelQuota' });

        expect(harness.host.refreshModelQuota).toHaveBeenCalledWith(harness.view.webview);
        expect(harness.host.refreshModels).not.toHaveBeenCalled();
    });

    test('normalizes Smart Search input and preserves request/session ownership on success and failure', async () => {
        const run = jest.fn()
            .mockResolvedValueOnce({ messageIds: ['m2'], modelId: 'free/model' })
            .mockRejectedValueOnce(new Error('cancelled'));
        const harness = createHarness({ smartSearch: { run } });
        const input = {
            type: 'smartSessionSearch',
            requestId: 'request-1',
            sessionId: 'session-a',
            query: 'reload history',
            messages: [
                { id: 'm1', role: 'user', text: 'one' },
                { id: 'm2', text: 'two' },
                { id: 3, role: 'assistant', text: 'invalid' },
            ],
        };
        await harness.send(input);
        await harness.send({ ...input, requestId: 'request-2' });

        expect(run).toHaveBeenNthCalledWith(1, 'session-a', 'reload history', [
            { id: 'm1', role: 'user', text: 'one' },
            { id: 'm2', role: 'unknown', text: 'two' },
        ]);
        expect(harness.posts).toContainEqual({
            type: 'smartSessionSearchResult',
            requestId: 'request-1',
            sessionId: 'session-a',
            messageIds: ['m2'],
            modelId: 'free/model',
        });
        expect(harness.posts).toContainEqual({
            type: 'smartSessionSearchError',
            requestId: 'request-2',
            sessionId: 'session-a',
            error: 'Error: cancelled',
        });
    });

    test('routes file listing, ping, and reload without changing session ownership', async () => {
        const listWorkspaceFiles = jest.fn(async () => ['a.ts', 'b.ts']);
        const harness = createHarness({ listWorkspaceFiles });
        await harness.send({ type: 'listWorkspaceFiles', requestId: 'files-1', query: 'src' });
        await harness.send({ type: 'ping', ts: 123 });
        await harness.send({ type: 'reloadWindow' });

        expect(listWorkspaceFiles).toHaveBeenCalledWith('src');
        expect(harness.posts).toContainEqual({
            type: 'workspaceFileResults',
            requestId: 'files-1',
            query: 'src',
            files: ['a.ts', 'b.ts'],
        });
        expect(harness.posts).toContainEqual({ type: 'pong', ts: 123 });
        expect(vscode.commands.executeCommand).toHaveBeenCalledWith('workbench.action.reloadWindow');
    });

    test('returns correlated automatic editor context', async () => {
        const context = {
            displayText: 'src/a.ts:2-3',
            text: 'selected',
            source: 'editor-auto',
            filePath: 'C:\\workspace\\src\\a.ts',
            workspacePath: 'src/a.ts',
            range: { startLine: 2, endLine: 3 },
            contextKey: 'file:///workspace/src/a.ts:2-3:v1',
            automatic: true,
        };
        const harness = createHarness({ getAutoEditorContext: jest.fn(() => context) });
        await harness.send({ type: 'getAutoEditorContext', requestId: 'editor-1' });
        expect(harness.posts).toContainEqual({
            type: 'autoEditorContextResult',
            requestId: 'editor-1',
            context,
        });
    });

    test('resolves abbreviated assistant image paths and opens images in the native editor', async () => {
        const os = require('os') as typeof import('os');
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-assistant-image-'));
        const reportDir = path.join(tempRoot, 'results', 'case-a');
        const imagePath = path.join(reportDir, 'eta_kappa.png');
        fs.mkdirSync(reportDir, { recursive: true });
        fs.writeFileSync(path.join(reportDir, 'summary.json'), '{}');
        fs.writeFileSync(imagePath, 'image');
        const executeCommand = vscode.commands.executeCommand as jest.Mock;
        executeCommand.mockClear();
        try {
            const harness = createHarness({ getWorkspaceRootPath: jest.fn(() => tempRoot) });
            await harness.send({
                type: 'resolveAssistantImageReferences',
                requestId: 'images-1',
                references: [{
                    id: 'image-1',
                    path: '.../eta_kappa.png',
                    contextPath: 'results/case-a/summary.json',
                }],
            });

            expect(harness.posts).toContainEqual({
                type: 'assistantImageReferencesResolved',
                requestId: 'images-1',
                items: [{
                    id: 'image-1',
                    path: '.../eta_kappa.png',
                    resolvedPath: imagePath,
                    uri: `webview:${imagePath}`,
                }],
            });

            await harness.send({
                type: 'openFileAtLocation',
                path: '.../eta_kappa.png',
                contextPath: 'results/case-a/summary.json',
            });
            expect(executeCommand).toHaveBeenCalledWith(
                'vscode.open',
                { fsPath: imagePath },
                { preview: true },
            );
        } finally {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    test('keeps clipboard attachment responses bound to the payload session', async () => {
        const saveClipboardImage = jest.fn()
            .mockResolvedValueOnce({ id: 'attachment-1', name: 'image.png', filePath: 'saved/image.png' })
            .mockRejectedValueOnce(new Error('save failed'));
        const harness = createHarness({
            attachmentStorage: {
                saveClipboardImage,
                getImageMimeFromName: jest.fn(),
                isImageFileName: jest.fn(),
            },
        });
        const input = {
            type: 'clipboardImage',
            dataUrl: 'data:image/png;base64,AA==',
            mime: 'image/png',
            sessionId: 'session-a',
        };
        await harness.send(input);
        await harness.send(input);

        expect(harness.posts).toContainEqual({
            type: 'attachmentAdded',
            id: 'attachment-1',
            name: 'image.png',
            filePath: 'saved/image.png',
            dataUrl: input.dataUrl,
            mime: 'image/png',
            sessionId: 'session-a',
        });
        expect(harness.posts).toContainEqual({
            type: 'attachmentError',
            value: 'Failed to save image: Error: save failed',
            sessionId: 'session-a',
        });
    });

    test('acknowledges permission results on the latest Webview and preserves failure payloads', async () => {
        const respondPermission = jest.fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('backend unavailable'));
        const harness = createHarness({ client: { sendToolResult: jest.fn(), respondPermission } });
        const input = {
            type: 'permissionResult',
            sessionId: 'session-a',
            permissionId: 'permission-1',
            requestId: 'request-1',
            response: 'always',
        };
        await harness.send(input);
        await harness.send({ ...input, response: 'invalid' });

        expect(respondPermission).toHaveBeenNthCalledWith(1, {
            sessionId: 'session-a',
            permissionId: 'permission-1',
            requestId: 'request-1',
            response: 'always',
        });
        expect(respondPermission).toHaveBeenNthCalledWith(2, {
            sessionId: 'session-a',
            permissionId: 'permission-1',
            requestId: 'request-1',
            response: 'once',
        });
        expect(harness.posts).toContainEqual({
            type: 'permissionResultAck',
            sessionId: 'session-a',
            permissionId: 'permission-1',
            response: 'always',
        });
        expect(harness.posts).toContainEqual({
            type: 'permissionResultFailed',
            sessionId: 'session-a',
            permissionId: 'permission-1',
            response: 'once',
            reason: 'Error: backend unavailable',
        });
    });

    test('consumes a pending local question exactly once through its domain method', async () => {
        const resolve = jest.fn();
        const pendingLocalQuestionRequests = new Map([[
            'call-1',
            { sessionId: 'session-a', resolve },
        ]]);
        const harness = createHarness({ pendingLocalQuestionRequests });
        const input = {
            type: 'localQuestionResult',
            callId: 'call-1',
            result: { selectedId: 'keep', selectedLabel: 'Keep Changes', ignored: true },
        };
        await harness.send(input);
        await harness.send(input);

        expect(resolve).toHaveBeenCalledTimes(1);
        expect(resolve).toHaveBeenCalledWith({
            selectedId: 'keep',
            selectedLabel: 'Keep Changes',
        });
        expect(pendingLocalQuestionRequests.has('call-1')).toBe(false);
        expect(harness.host.uiDebugChannel.appendLine).toHaveBeenCalledWith(
            'EXT: localQuestionResult.ok | sessionId=session-a | callId=call-1',
        );
        expect(harness.host.uiDebugChannel.appendLine).toHaveBeenCalledWith(
            'EXT: localQuestionResult.skip | callId=call-1 | reason=missing-pending',
        );
    });
});
