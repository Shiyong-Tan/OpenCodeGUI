import * as fs from 'fs';
import * as pathModule from 'path';
import * as vscode from 'vscode';
import type { SmartSearchMessage } from '../../search/SmartSearchService';
import type { AutomaticEditorContext } from '../../context/EditorContextService';

type UtilityMessage = Record<string, any>;
type LocalQuestionResolution = { resolved: boolean; sessionId?: string };

export interface UtilityCommandHost {
    getLiveWebview(fallback: vscode.Webview): vscode.Webview;
    log(message: string): void;
    applyModelSelection(value: unknown, webview: vscode.Webview): Promise<void>;
    applyModeSelection(value: unknown): Promise<void>;
    applyVariantSelection(value: unknown): Promise<void>;
    pickCompactionModelId(): string | undefined;
    parseModelRef(fullId: string): { providerID: string; modelID: string } | undefined;
    summarizeSession(
        sessionId: string,
        options: { providerID: string; modelID: string; auto: boolean }
    ): Promise<unknown>;
    fetchSessionUsage(sessionId: string): Promise<{ used: number; size: number; amount: number } | null | undefined>;
    postAddResponse(
        webview: vscode.Webview,
        value: string,
        meta: { sessionId: string; operationId?: string }
    ): void;
    refreshModels(webview: vscode.Webview): Promise<unknown>;
    refreshModelQuota(webview: vscode.Webview): Promise<void>;
    runSmartSearch(
        sessionId: string,
        query: string,
        messages: SmartSearchMessage[]
    ): Promise<{ messageIds: string[]; modelId?: string }>;
    listWorkspaceFiles(query: string): Promise<Array<{ path: string; name: string; directory: string }>>;
    getWorkspaceCompletionTerms(): Promise<string[]>;
    getAutoEditorContext(): AutomaticEditorContext | null;
    saveClipboardImage(dataUrl: string, mime: string): Promise<{
        id: string;
        name: string;
        filePath: string;
    }>;
    getImageMimeFromName(name: string): string | undefined;
    isImageFileName(name: string): boolean;
    isGitUndoEnabled(): boolean;
    openGitDiffForFile(
        sessionId: string,
        filePath: string,
        webview: vscode.Webview,
        commitHead?: string,
        commitBase?: string
    ): Promise<void>;
    sendToolResult(input: {
        sessionId: string;
        callId: string;
        requestId?: string;
        result: unknown;
    }): Promise<void>;
    resolveLocalQuestion(callId: string, result: unknown): LocalQuestionResolution;
    respondPermission(input: {
        sessionId: string;
        permissionId?: string;
        requestId?: string;
        response: 'always' | 'reject' | 'once';
    }): Promise<void>;
    getWorkspaceRootPath(): string;
}

export type UtilityCommandHandler = (
    data: UtilityMessage,
    activeWebview: vscode.Webview,
    fallbackWebview: vscode.Webview
) => false | Promise<boolean>;

const UTILITY_COMMANDS = new Set([
    'setModel',
    'compactSession',
    'setMode',
    'setVariant',
    'refreshModels',
    'refreshModelQuota',
    'smartSessionSearch',
    'listWorkspaceFiles',
    'getWorkspaceCompletionTerms',
    'getAutoEditorContext',
    'ping',
    'reloadWindow',
    'clipboardImage',
    'selectAttachments',
    'openGitDiff',
    'toolResult',
    'localQuestionResult',
    'permissionResult',
    'openFileAtLocation',
    'resolveAssistantImageReferences',
]);

const ASSISTANT_IMAGE_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg',
    '.tif', '.tiff', '.ico', '.heic',
]);

export class UtilityCommandController {
    constructor(private readonly host: UtilityCommandHost) {}

    public async handle(
        data: UtilityMessage,
        activeWebview: vscode.Webview,
        fallbackWebview: vscode.Webview
    ): Promise<boolean> {
        if (!UTILITY_COMMANDS.has(data?.type)) return false;

        switch (data.type) {
            case 'setModel':
                await this.host.applyModelSelection(data.value, activeWebview);
                return true;
            case 'compactSession':
                await this.compactSession(data, activeWebview);
                return true;
            case 'setMode':
                await this.host.applyModeSelection(data.value);
                return true;
            case 'setVariant':
                await this.host.applyVariantSelection(data.value);
                return true;
            case 'refreshModels':
                await this.host.refreshModels(activeWebview);
                return true;
            case 'refreshModelQuota':
                await this.host.refreshModelQuota(activeWebview);
                return true;
            case 'smartSessionSearch':
                await this.smartSessionSearch(data, activeWebview);
                return true;
            case 'listWorkspaceFiles':
                await this.listWorkspaceFiles(data, activeWebview);
                return true;
            case 'getWorkspaceCompletionTerms':
                await this.getWorkspaceCompletionTerms(data, activeWebview);
                return true;
            case 'getAutoEditorContext':
                this.getAutoEditorContext(data, activeWebview);
                return true;
            case 'ping':
                this.host.getLiveWebview(fallbackWebview).postMessage({ type: 'pong', ts: data.ts });
                return true;
            case 'reloadWindow':
                this.host.log('EXT: reloadWindow.requested');
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
                return true;
            case 'clipboardImage':
                await this.addClipboardImage(data, activeWebview);
                return true;
            case 'selectAttachments':
                await this.selectAttachments(data, activeWebview);
                return true;
            case 'openGitDiff':
                await this.openGitDiff(data, activeWebview);
                return true;
            case 'toolResult':
                await this.sendToolResult(data);
                return true;
            case 'localQuestionResult':
                this.resolveLocalQuestion(data);
                return true;
            case 'permissionResult':
                await this.respondPermission(data, activeWebview);
                return true;
            case 'openFileAtLocation':
                await this.openFileAtLocation(data);
                return true;
            case 'resolveAssistantImageReferences':
                await this.resolveAssistantImageReferences(data, activeWebview);
                return true;
            default:
                return false;
        }
    }

    private async compactSession(data: UtilityMessage, activeWebview: vscode.Webview): Promise<void> {
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        if (!sessionId) {
            this.host.log('[EXT][ADD_RESPONSE_DROP] reason=missing-session-owner source=compactSession');
            return;
        }
        const modelId = this.host.pickCompactionModelId();
        if (!modelId) {
            this.host.postAddResponse(activeWebview, 'Compaction skipped: no free model available.', { sessionId });
            return;
        }
        const modelRef = this.host.parseModelRef(modelId);
        if (!modelRef) {
            this.host.postAddResponse(activeWebview, `Compaction skipped: invalid model id ${modelId}.`, { sessionId });
            return;
        }
        activeWebview.postMessage({ type: 'compactionState', sessionId, running: true });
        try {
            await this.host.summarizeSession(sessionId, {
                providerID: modelRef.providerID,
                modelID: modelRef.modelID,
                auto: false,
            });
            this.host.postAddResponse(activeWebview, `Compaction started (${modelId}).`, { sessionId });
        } catch (error) {
            this.host.postAddResponse(activeWebview, `Compaction failed: ${error}`, { sessionId });
        } finally {
            const liveWebview = this.host.getLiveWebview(activeWebview);
            liveWebview.postMessage({ type: 'compactionState', sessionId, running: false });
            const usage = await this.host.fetchSessionUsage(sessionId);
            if (usage) {
                liveWebview.postMessage({
                    type: 'sessionUsage',
                    sessionId,
                    used: usage.used,
                    size: usage.size,
                    amount: usage.amount,
                });
            }
        }
    }

    private async smartSessionSearch(data: UtilityMessage, activeWebview: vscode.Webview): Promise<void> {
        const requestId = typeof data.requestId === 'string' ? data.requestId : '';
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        const query = typeof data.query === 'string' ? data.query : '';
        const messages: SmartSearchMessage[] = Array.isArray(data.messages)
            ? data.messages
                .filter((item: any) => item && typeof item.id === 'string' && typeof item.text === 'string')
                .map((item: any) => ({
                    id: item.id,
                    role: typeof item.role === 'string' ? item.role : 'unknown',
                    text: item.text,
                }))
            : [];
        const liveWebview = this.host.getLiveWebview(activeWebview);
        if (!sessionId) {
            this.host.log(`EXT: smartSearch.drop | requestId=${requestId || 'null'} | reason=missing-session-owner`);
            return;
        }
        try {
            const result = await this.host.runSmartSearch(sessionId, query, messages);
            this.host.log(
                `EXT: smartSearch.done | requestId=${requestId || 'null'} | model=${result.modelId || 'default'} | results=${result.messageIds.length}`
            );
            liveWebview.postMessage({
                type: 'smartSessionSearchResult',
                requestId,
                sessionId,
                messageIds: result.messageIds,
                modelId: result.modelId,
            });
        } catch (error) {
            this.host.log(`EXT: smartSearch.fail | requestId=${requestId || 'null'} | err=${String(error)}`);
            liveWebview.postMessage({
                type: 'smartSessionSearchError',
                requestId,
                sessionId,
                error: String(error),
            });
        }
    }

    private async listWorkspaceFiles(data: UtilityMessage, activeWebview: vscode.Webview): Promise<void> {
        const requestId = typeof data.requestId === 'string' ? data.requestId : '';
        const query = typeof data.query === 'string' ? data.query : '';
        const files = await this.host.listWorkspaceFiles(query);
        this.host.getLiveWebview(activeWebview).postMessage({
            type: 'workspaceFileResults',
            requestId,
            query,
            files,
        });
    }

    private async getWorkspaceCompletionTerms(
        data: UtilityMessage,
        activeWebview: vscode.Webview
    ): Promise<void> {
        const requestId = typeof data.requestId === 'string' ? data.requestId : '';
        const enabled = vscode.workspace
            .getConfiguration('opencode.wordCompletion')
            .get<boolean>('enabled', true);
        const terms = enabled ? await this.host.getWorkspaceCompletionTerms() : [];
        this.host.getLiveWebview(activeWebview).postMessage({
            type: 'workspaceCompletionTerms',
            requestId,
            enabled,
            terms,
        });
    }

    private getAutoEditorContext(data: UtilityMessage, activeWebview: vscode.Webview): void {
        const requestId = typeof data.requestId === 'string' ? data.requestId : '';
        this.host.getLiveWebview(activeWebview).postMessage({
            type: 'autoEditorContextResult',
            requestId,
            context: this.host.getAutoEditorContext(),
        });
    }

    private async addClipboardImage(data: UtilityMessage, activeWebview: vscode.Webview): Promise<void> {
        if (!data.dataUrl || !data.mime) return;
        const sessionId = typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : '';
        if (!sessionId) {
            this.host.log('[EXT][ATTACHMENT_DROP] type=clipboardImage reason=missing-session-owner');
            return;
        }
        try {
            const saved = await this.host.saveClipboardImage(data.dataUrl, data.mime);
            activeWebview.postMessage({
                type: 'attachmentAdded',
                id: saved.id,
                name: saved.name,
                filePath: saved.filePath,
                dataUrl: data.dataUrl,
                mime: data.mime,
                sessionId,
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to save image: ${error}`);
            activeWebview.postMessage({
                type: 'attachmentError',
                value: `Failed to save image: ${error}`,
                sessionId,
            });
        }
    }

    private async selectAttachments(data: UtilityMessage, activeWebview: vscode.Webview): Promise<void> {
        const sessionId = typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : '';
        if (!sessionId) {
            this.host.log('[EXT][ATTACHMENT_DROP] type=selectAttachments reason=missing-session-owner');
            return;
        }
        try {
            const picks = await vscode.window.showOpenDialog({
                canSelectMany: true,
                canSelectFiles: true,
                canSelectFolders: false,
                openLabel: 'Add attachments',
            });
            if (!picks?.length) return;
            for (const uri of picks) {
                const filePath = uri.fsPath;
                const name = pathModule.basename(filePath);
                const mime = this.host.getImageMimeFromName(name) || 'application/octet-stream';
                let dataUrl: string | undefined;
                if (this.host.isImageFileName(name)) {
                    try {
                        const buffer = await fs.promises.readFile(filePath);
                        dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
                    } catch (error) {
                        this.host.log(`[EXT][ATTACH_READ_FAIL] file=${name} err=${String(error)}`);
                    }
                }
                const id = `file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                activeWebview.postMessage({
                    type: 'attachmentAdded',
                    id,
                    name,
                    filePath,
                    dataUrl,
                    mime,
                    sessionId,
                });
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to add attachments: ${error}`);
            activeWebview.postMessage({
                type: 'attachmentError',
                value: `Failed to add attachments: ${error}`,
                sessionId,
            });
        }
    }

    private async openGitDiff(data: UtilityMessage, activeWebview: vscode.Webview): Promise<void> {
        if (!data.filePath || typeof data.filePath !== 'string') return;
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        if (!sessionId) {
            this.host.log('[EXT][ADD_RESPONSE_DROP] reason=missing-session-owner source=openGitDiff');
            return;
        }
        if (!this.host.isGitUndoEnabled()) {
            this.host.postAddResponse(
                activeWebview,
                'Git diff unavailable: Git not installed or version too old.',
                { sessionId }
            );
            return;
        }
        try {
            const commitHead = typeof data.commitHead === 'string' ? data.commitHead : undefined;
            const commitBase = typeof data.commitBase === 'string' ? data.commitBase : undefined;
            await this.host.openGitDiffForFile(
                sessionId,
                data.filePath,
                activeWebview,
                commitHead,
                commitBase
            );
        } catch (error) {
            vscode.window.showErrorMessage(`Open diff failed: ${error}`);
            this.host.postAddResponse(activeWebview, `Open diff failed: ${error}`, { sessionId });
        }
    }

    private async sendToolResult(data: UtilityMessage): Promise<void> {
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        const callId = typeof data.callId === 'string' ? data.callId : '';
        if (!sessionId || !callId) {
            this.host.log(`EXT: toolResult.skip | sessionId=${sessionId || 'null'} | callId=${callId || 'null'}`);
            return;
        }
        try {
            await this.host.sendToolResult({
                sessionId,
                callId,
                requestId: typeof data.requestId === 'string' ? data.requestId : undefined,
                result: data.result,
            });
            this.host.log(`EXT: toolResult.sent | sessionId=${sessionId} | callId=${callId}`);
        } catch (error) {
            this.host.log(`EXT: toolResult.fail | sessionId=${sessionId} | callId=${callId} | err=${String(error)}`);
        }
    }

    private resolveLocalQuestion(data: UtilityMessage): void {
        const callId = typeof data.callId === 'string' ? data.callId : '';
        const resolution = this.host.resolveLocalQuestion(callId, data?.result);
        if (!resolution.resolved) {
            this.host.log(`EXT: localQuestionResult.skip | callId=${callId || 'null'} | reason=missing-pending`);
            return;
        }
        this.host.log(`EXT: localQuestionResult.ok | sessionId=${resolution.sessionId} | callId=${callId}`);
    }

    private async respondPermission(data: UtilityMessage, activeWebview: vscode.Webview): Promise<void> {
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        const permissionId = typeof data.permissionId === 'string' ? data.permissionId : '';
        const requestId = typeof data.requestId === 'string' ? data.requestId : '';
        const response = data.response === 'always' || data.response === 'reject' ? data.response : 'once';
        if (!sessionId) {
            this.host.log('EXT: permissionResult.skip | reason=missing-session');
            return;
        }
        const liveWebview = this.host.getLiveWebview(activeWebview);
        try {
            await this.host.respondPermission({
                sessionId,
                permissionId: permissionId || undefined,
                requestId: requestId || undefined,
                response,
            });
            this.host.log(
                `EXT: permissionResult.sent | sessionId=${sessionId} permissionId=${permissionId || requestId || 'null'} response=${response}`
            );
            liveWebview.postMessage({
                type: 'permissionResultAck',
                sessionId,
                permissionId: permissionId || requestId || '',
                response,
            });
        } catch (error) {
            this.host.log(
                `EXT: permissionResult.fail | sessionId=${sessionId} permissionId=${permissionId || requestId || 'null'} err=${String(error)}`
            );
            liveWebview.postMessage({
                type: 'permissionResultFailed',
                sessionId,
                permissionId: permissionId || requestId || '',
                response,
                reason: String(error),
            });
        }
    }

    private isAssistantImagePath(filePath: string): boolean {
        return ASSISTANT_IMAGE_EXTENSIONS.has(pathModule.extname(filePath).toLowerCase());
    }

    private isInsideWorkspace(workspaceRoot: string, candidatePath: string): boolean {
        const rel = pathModule.relative(pathModule.resolve(workspaceRoot), pathModule.resolve(candidatePath));
        return rel === '' || (!rel.startsWith('..') && !pathModule.isAbsolute(rel));
    }

    private async isExistingFile(candidatePath: string): Promise<boolean> {
        try {
            return (await fs.promises.stat(candidatePath)).isFile();
        } catch {
            return false;
        }
    }

    private async resolveAssistantImageCandidates(
        rawPath: string,
        contextPath?: string
    ): Promise<string[]> {
        const workspaceRoot = pathModule.resolve(this.host.getWorkspaceRootPath());
        const cleanedPath = rawPath.trim().replace(/^["'`<]+|["'`>,.;:]+$/g, '');
        if (!cleanedPath || !this.isAssistantImagePath(cleanedPath)) return [];
        const candidates: string[] = [];
        const addCandidate = async (candidatePath: string): Promise<void> => {
            const resolved = pathModule.resolve(candidatePath);
            if (!this.isInsideWorkspace(workspaceRoot, resolved)) return;
            if (await this.isExistingFile(resolved) && !candidates.includes(resolved)) {
                candidates.push(resolved);
            }
        };

        const abbreviated = /^\.{3}[\\/]/.test(cleanedPath);
        if (abbreviated && contextPath) {
            const cleanContext = contextPath.trim().replace(/^["'`<]+|["'`>,.;:]+$/g, '');
            const contextAbsolute = pathModule.isAbsolute(cleanContext)
                ? pathModule.resolve(cleanContext)
                : pathModule.resolve(workspaceRoot, cleanContext);
            const contextBase = pathModule.extname(contextAbsolute)
                ? pathModule.dirname(contextAbsolute)
                : contextAbsolute;
            await addCandidate(pathModule.join(contextBase, cleanedPath.replace(/^\.{3}[\\/]/, '')));
        } else if (!abbreviated) {
            await addCandidate(pathModule.isAbsolute(cleanedPath)
                ? cleanedPath
                : pathModule.join(workspaceRoot, cleanedPath));
        }

        if (candidates.length === 0 && typeof vscode.workspace.findFiles === 'function') {
            const baseName = pathModule.basename(cleanedPath);
            const matches = await vscode.workspace.findFiles(
                `**/${baseName}`,
                '**/{.git,node_modules,.opencode}/**',
                20
            );
            for (const match of matches) {
                if (this.isAssistantImagePath(match.fsPath)) await addCandidate(match.fsPath);
            }
        }
        return candidates;
    }

    private async resolveAssistantImageReferences(
        data: UtilityMessage,
        activeWebview: vscode.Webview
    ): Promise<void> {
        const requestId = typeof data.requestId === 'string' ? data.requestId : '';
        const references = Array.isArray(data.references) ? data.references.slice(0, 24) : [];
        const items: Array<Record<string, unknown>> = [];
        for (const reference of references) {
            const id = typeof reference?.id === 'string' ? reference.id : '';
            const rawPath = typeof reference?.path === 'string' ? reference.path : '';
            const contextPath = typeof reference?.contextPath === 'string'
                ? reference.contextPath
                : undefined;
            if (!id || !rawPath) continue;
            const candidates = await this.resolveAssistantImageCandidates(rawPath, contextPath);
            if (candidates.length === 1) {
                items.push({
                    id,
                    path: rawPath,
                    resolvedPath: candidates[0],
                    uri: activeWebview.asWebviewUri(vscode.Uri.file(candidates[0])).toString(),
                });
            } else {
                items.push({
                    id,
                    path: rawPath,
                    ambiguous: candidates.length > 1,
                    candidates: candidates.map((candidate) =>
                        pathModule.relative(this.host.getWorkspaceRootPath(), candidate)
                    ),
                });
            }
        }
        await activeWebview.postMessage({
            type: 'assistantImageReferencesResolved',
            requestId,
            items,
        });
    }

    private async openFileAtLocation(data: UtilityMessage): Promise<void> {
        const rawPath = typeof data.path === 'string' ? data.path.trim() : '';
        const lineNum = Number.isFinite(Number(data.line)) ? Number(data.line) : 1;
        const colNum = Number.isFinite(Number(data.col)) ? Number(data.col) : 1;
        const line = Math.max(1, Math.floor(lineNum));
        const col = Math.max(1, Math.floor(colNum));
        if (!rawPath) {
            this.host.log('EXT: openFileAtLocation | error=empty-path');
            return;
        }
        const workspaceRoot = this.host.getWorkspaceRootPath();
        let absPath = pathModule.isAbsolute(rawPath)
            ? pathModule.resolve(rawPath)
            : pathModule.resolve(pathModule.join(workspaceRoot, rawPath));
        if (this.isAssistantImagePath(rawPath)) {
            const contextPath = typeof data.contextPath === 'string' ? data.contextPath : undefined;
            const candidates = await this.resolveAssistantImageCandidates(rawPath, contextPath);
            if (candidates.length === 0) {
                this.host.log(`EXT: openFileAtLocation | path=${rawPath} | error=image-not-found`);
                return;
            }
            if (candidates.length > 1) {
                const selected = await vscode.window.showQuickPick(
                    candidates.map((candidate) => ({
                        label: pathModule.relative(workspaceRoot, candidate),
                        description: candidate,
                        candidate,
                    })),
                    { placeHolder: `Select image for ${rawPath}` }
                );
                if (!selected) return;
                absPath = selected.candidate;
            } else {
                absPath = candidates[0];
            }
        }
        const normalizedRoot = pathModule.resolve(workspaceRoot);
        const rel = pathModule.relative(normalizedRoot, absPath);
        if (rel.startsWith('..') || pathModule.isAbsolute(rel)) {
            this.host.log(
                `EXT: openFileAtLocation | path=${rawPath} | line=${line} | col=${col} | resolvedAbs=${absPath} | error=outside-workspace`
            );
            return;
        }
        try {
            const stat = await fs.promises.stat(absPath);
            if (stat.isDirectory()) {
                await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(absPath));
                this.host.log(
                    `EXT: openFileAtLocation | path=${rawPath} | resolvedAbs=${absPath} | revealed=directory`
                );
                return;
            }
            if (this.isAssistantImagePath(absPath)) {
                await vscode.commands.executeCommand(
                    'vscode.open',
                    vscode.Uri.file(absPath),
                    { preview: true }
                );
                this.host.log(
                    `EXT: openFileAtLocation | path=${rawPath} | resolvedAbs=${absPath} | opened=image`
                );
                return;
            }
            if (absPath.endsWith('.md')) {
                await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(absPath));
                this.host.log(
                    `EXT: openFileAtLocation | path=${rawPath} | resolvedAbs=${absPath} | opened in markdown preview`
                );
                return;
            }
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
            const editor = await vscode.window.showTextDocument(doc, { preview: true });
            const safeLine = Math.min(Math.max(line - 1, 0), Math.max(doc.lineCount - 1, 0));
            const lineText = doc.lineAt(safeLine).text;
            const safeCol = Math.min(Math.max(col - 1, 0), lineText.length);
            const pos = new vscode.Position(safeLine, safeCol);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            this.host.log(
                `EXT: openFileAtLocation | path=${rawPath} | line=${line} | col=${col} | resolvedAbs=${absPath} | ok`
            );
        } catch (error) {
            this.host.log(
                `EXT: openFileAtLocation | path=${rawPath} | line=${line} | col=${col} | resolvedAbs=${absPath} | error=${String(error)}`
            );
        }
    }
}

export function createUtilityCommandHandler(host: UtilityCommandHost): UtilityCommandHandler {
    const controller = new UtilityCommandController(host);
    return (data, activeWebview, fallbackWebview) => {
        if (!UTILITY_COMMANDS.has(data?.type)) return false;
        return controller.handle(data, activeWebview, fallbackWebview);
    };
}
