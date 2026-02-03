import * as vscode from "vscode";
import * as fs from "fs";
import * as pathModule from "path";
import { UndoManager } from "./UndoManager";
import { OpenCodeClient, ChatEvent, ModelInfo, SessionInfo } from "./OpenCodeClient";
import { OpenCodeDiffProvider } from "./OpenCodeDiffProvider";

type SessionMessage = {
    role: 'user' | 'assistant';
    text: string;
    id?: string;
};

export class SidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private client: OpenCodeClient;
    private currentSessionId?: string;
    private selectedModel?: string;
    private selectedVariant?: string;
    private selectedMode?: string;
    private undoManager: UndoManager;
    private pendingClientMessageId?: string;
    private activeCheckpointId?: string;
    private checkpointStarted = false;
    private pendingBackupWrites: Promise<void>[] = [];

    constructor(
        private readonly _context: vscode.ExtensionContext,
        private readonly _extensionUri: vscode.Uri,
        private readonly diffProvider: OpenCodeDiffProvider
    ) {
        this.client = new OpenCodeClient();
        this.undoManager = new UndoManager();
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            const activeWebview = webviewView.webview;
            OpenCodeClient.outputChannel.appendLine(`[Extension] Received: ${data.type}`);

            switch (data.type) {
                case "webviewReady": {
                    await this.sendInit(activeWebview);
                    break;
                }
                case "sendMessage": {
                    if (!data.value) return;

                    if (data.value.toLowerCase() === 'ping') {
                        OpenCodeClient.outputChannel.appendLine(`[BRIDGE] Manual PONG sent`);
                        activeWebview.postMessage({ type: 'addResponse', value: 'PONG - Bridge is working!' });
                        return;
                    }

                    try {
                        const attachments = Array.isArray(data.attachments) ? data.attachments : [];
                        const clientMessageId = data.clientMessageId || `local-${Date.now()}`;
                        this.pendingClientMessageId = clientMessageId;
                        this.activeCheckpointId = clientMessageId;
                        this.checkpointStarted = false;

                        if (this.currentSessionId) {
                            this.undoManager.startCheckpoint(this.currentSessionId, clientMessageId, 'local');
                            this.checkpointStarted = true;
                        }

                        OpenCodeClient.outputChannel.appendLine(`[BRIDGE] Starting chat for: ${data.value}`);
                        await this.client.chat(
                            data.value,
                            {
                                model: this.selectedModel,
                                variant: this.selectedVariant,
                                sessionId: this.currentSessionId,
                                files: attachments,
                                mode: this.selectedMode
                            },
                            (event: ChatEvent) => {
                                this.handleChatEvent(event, activeWebview);
                            }
                        );

                        OpenCodeClient.outputChannel.appendLine(`[BRIDGE] Chat done`);
                        activeWebview.postMessage({ type: 'chatDone' });
                        if (this.pendingBackupWrites.length) {
                            await Promise.all(this.pendingBackupWrites);
                            this.pendingBackupWrites = [];
                        }
                        if (this.currentSessionId && this.activeCheckpointId) {
                            await this.undoManager.finalizeCheckpoint(this.currentSessionId, this.activeCheckpointId);
                        }
                        await this.refreshSessions(activeWebview);
                    } catch (error) {
                        OpenCodeClient.outputChannel.appendLine(`[BRIDGE] Error: ${error}`);
                        vscode.window.showErrorMessage(`OpenCode Error: ${error}`);
                        activeWebview.postMessage({
                            type: 'addResponse',
                            value: `Error: ${error}`
                        });
                        activeWebview.postMessage({ type: 'chatDone' });
                    }
                    break;
                }
                case "setModel": {
                    this.selectedModel = data.value || undefined;
                    await this._context.globalState.update('opencode.model', this.selectedModel);
                    break;
                }
                case "setMode": {
                    this.selectedMode = data.value || undefined;
                    await this._context.globalState.update('opencode.mode', this.selectedMode);
                    break;
                }
                case "setVariant": {
                    this.selectedVariant = data.value || undefined;
                    await this._context.globalState.update('opencode.variant', this.selectedVariant);
                    break;
                }
                case "refreshModels": {
                    await this.refreshModels(activeWebview);
                    break;
                }
                case "refreshSessions": {
                    await this.refreshSessions(activeWebview);
                    break;
                }
                case "selectSession": {
                    if (!data.sessionId) return;
                    try {
                        this.currentSessionId = data.sessionId;
                        const exportData = await this.client.exportSession(data.sessionId);
                        const formatted = this.formatSession(exportData);
                        activeWebview.postMessage({
                            type: 'sessionData',
                            sessionId: data.sessionId,
                            title: formatted.title,
                            messages: formatted.messages
                        });
                    } catch (error) {
                        vscode.window.showErrorMessage(`Failed to load session: ${error}`);
                        activeWebview.postMessage({ type: 'addResponse', value: `Error: ${error}` });
                    }
                    break;
                }

                case "clipboardImage": {
                    if (!data.dataUrl || !data.mime) return;
                    try {
                        const saved = await this.saveClipboardImage(data.dataUrl, data.mime);
                        activeWebview.postMessage({
                            type: 'attachmentAdded',
                            id: saved.id,
                            name: saved.name,
                            filePath: saved.filePath,
                            dataUrl: data.dataUrl,
                            mime: data.mime
                        });
                    } catch (error) {
                        vscode.window.showErrorMessage(`Failed to save image: ${error}`);
                        activeWebview.postMessage({ type: 'attachmentError', value: `Failed to save image: ${error}` });
                    }
                    break;
                }
                case "newSession": {
                    this.currentSessionId = undefined;
                    activeWebview.postMessage({ type: 'newSession' });
                    break;
                }
                case "redoLast": {
                    if (!this.currentSessionId) return;
                    const result = await this.undoManager.redo(this.currentSessionId);
                    if (result.conflictFiles.length) {
                        const choice = await vscode.window.showWarningMessage(
                            'User edits detected in files. Overwrite all and redo?',
                            'Redo and overwrite',
                            'Cancel'
                        );
                        if (choice === 'Redo and overwrite') {
                            await this.undoManager.redo(this.currentSessionId, true);
                            activeWebview.postMessage({ type: 'addResponse', value: 'Redo applied.' });
                        }
                        return;
                    }
                    activeWebview.postMessage({ type: 'addResponse', value: 'Redo applied.' });
                    break;
                }
                case "undoToMessage": {
                    if (!data.messageId || !this.currentSessionId) return;
                    const result = await this.undoManager.undoToMessage(this.currentSessionId, data.messageId);
                    if (result.conflictFiles.length) {
                        const choice = await vscode.window.showWarningMessage(
                            'User edits detected in files. Overwrite all and undo?',
                            'Undo and overwrite',
                            'Cancel'
                        );
                        if (choice === 'Undo and overwrite') {
                            await this.undoManager.undoToMessage(this.currentSessionId, data.messageId, true);
                            activeWebview.postMessage({ type: 'addResponse', value: 'Undo applied.' });
                        }
                        return;
                    }
                    activeWebview.postMessage({ type: 'addResponse', value: 'Undo applied.' });
                    break;
                }
                case "cancel": {
                    this.client.cancel();
                    activeWebview.postMessage({ type: 'addResponse', value: 'Canceled.' });
                    activeWebview.postMessage({ type: 'chatDone' });
                    break;
                }
            }
        });
    }

    private async sendInit(webview: vscode.Webview): Promise<void> {
        let models: ModelInfo[] = [];
        let sessions: SessionInfo[] = [];
        try {
            models = await this.client.listModels();
        } catch (error) {
            webview.postMessage({ type: 'error', value: `Failed to load models: ${error}` });
        }

        try {
            sessions = await this.client.listSessions();
        } catch (error) {
            webview.postMessage({ type: 'error', value: `Failed to load sessions: ${error}` });
        }
        const storedModel = this._context.globalState.get<string>('opencode.model');
        const storedVariant = this._context.globalState.get<string>('opencode.variant');
        const storedMode = this._context.globalState.get<string>('opencode.mode');

        const defaultModel = storedModel || (models[0] ? models[0].fullId : undefined);
        const defaultVariant = storedVariant || undefined;
        const defaultMode = storedMode || 'build';

        this.selectedModel = defaultModel;
        this.selectedVariant = defaultVariant;
        this.selectedMode = defaultMode;

        if (!storedModel && defaultModel) {
            await this._context.globalState.update('opencode.model', defaultModel);
        }

        webview.postMessage({
            type: 'init',
            models,
            sessions,
            selectedModel: defaultModel,
            selectedVariant: defaultVariant,
            selectedMode: defaultMode,
            currentSessionId: this.currentSessionId
        });

}


    private async saveClipboardImage(dataUrl: string, mime: string): Promise<{ id: string; name: string; filePath: string }> {
        const storageRoot = this._context.globalStoragePath;
        const attachmentsDir = pathModule.join(storageRoot, 'attachments');
        await fs.promises.mkdir(attachmentsDir, { recursive: true });

        let ext = 'png';
        if (mime === 'image/jpeg') ext = 'jpg';
        if (mime === 'image/webp') ext = 'webp';

        const id = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const name = `${id}.${ext}`;
        const filePath = pathModule.join(attachmentsDir, name);

        let base64 = dataUrl;
        if (dataUrl.startsWith('data:')) {
            const commaIndex = dataUrl.indexOf(',');
            if (commaIndex !== -1) {
                base64 = dataUrl.slice(commaIndex + 1);
            }
        }

        const buffer = Buffer.from(base64, 'base64');
        await fs.promises.writeFile(filePath, buffer);
        return { id, name, filePath };
    }

    private handleChatEvent(event: ChatEvent, webview: vscode.Webview): void {
        if (event.type === 'session' && event.sessionId) {
            this.currentSessionId = event.sessionId;
            webview.postMessage({ type: 'sessionId', value: event.sessionId });
            if (this.activeCheckpointId && !this.checkpointStarted) {
                this.undoManager.startCheckpoint(this.currentSessionId, this.activeCheckpointId, 'local');
                this.checkpointStarted = true;
            }
            return;
        }

        if (event.type === 'text' && event.text) {
            webview.postMessage({ type: 'chatChunk', value: event.text });
            return;
        }

        if (event.type === 'error' && event.text) {
            webview.postMessage({ type: 'addResponse', value: `Error: ${event.text}` });
            webview.postMessage({ type: 'chatDone' });
            return;
        }

        if (event.type === 'permission' && event.text) {
            webview.postMessage({ type: 'permissionPrompt', value: event.text });
            return;
        }

        if (event.type === 'message' && event.text) {
            if (this.pendingClientMessageId && this.currentSessionId) {
                this.undoManager.updateMessageId(this.currentSessionId, this.pendingClientMessageId, event.text);
                webview.postMessage({
                    type: 'messageIdMap',
                    clientMessageId: this.pendingClientMessageId,
                    messageId: event.text
                });
                if (this.activeCheckpointId === this.pendingClientMessageId) {
                    this.activeCheckpointId = event.text;
                }
                this.pendingClientMessageId = undefined;
            }
            return;
        }

        if ((event.type === 'diff' || event.type === 'toolPatch') && event.text) {
            webview.postMessage({ type: 'diffChunk', value: event.text });
            if (this.currentSessionId && this.activeCheckpointId) {
                if (!this.checkpointStarted) {
                    this.undoManager.startCheckpoint(this.currentSessionId, this.activeCheckpointId, 'local');
                    this.checkpointStarted = true;
                }
                const paths = this.extractDiffPaths(event.text);
                const focusFile = paths[0];
                if (focusFile) {
                    this.diffProvider.markNextChangeAutoFollow();
                    this.diffProvider.applyWorkspaceSnapshot(focusFile, event.text);
                }
                for (const filePath of paths) {
                    const task = this.undoManager.recordFilePre(this.currentSessionId, this.activeCheckpointId, 'local', filePath);
                    this.pendingBackupWrites.push(task);
                }
            }
            return;
        }

        if (event.type === 'raw' && event.text) {
            webview.postMessage({ type: 'chatChunk', value: event.text });
        }
    }

    private async refreshModels(webview: vscode.Webview): Promise<void> {
        try {
            const models = await this.client.listModels();
            webview.postMessage({ type: 'models', models });
        } catch (error) {
            webview.postMessage({ type: 'error', value: `Failed to refresh models: ${error}` });
        }
    }

    private async refreshSessions(webview: vscode.Webview): Promise<void> {
        try {
            const sessions = await this.client.listSessions();
            webview.postMessage({ type: 'sessions', sessions });
        } catch (error) {
            webview.postMessage({ type: 'error', value: `Failed to refresh sessions: ${error}` });
        }
    }

    private extractDiffPaths(diffText: string): string[] {
        const paths = new Set<string>();
        const lf = String.fromCharCode(10);
        const cr = String.fromCharCode(13);
        const lines = diffText.split(lf);
        for (const rawLine of lines) {
            const line = rawLine.endsWith(cr) ? rawLine.slice(0, -1) : rawLine;
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (trimmed.startsWith('*** Update File:') || trimmed.startsWith('*** Add File:') || trimmed.startsWith('*** Delete File:')) {
                const raw = trimmed.split(':', 2)[1].trim();
                if (raw) paths.add(raw);
                continue;
            }
            if (trimmed.startsWith('+++ ') || trimmed.startsWith('--- ')) {
                const raw = trimmed.slice(4).trim();
                if (raw === '/dev/null') continue;
                const cleaned = (raw.startsWith('b/') || raw.startsWith('a/')) ? raw.slice(2) : raw;
                paths.add(cleaned);
                continue;
            }
            if (trimmed.startsWith('diff --git ')) {
                const parts = trimmed.split(' ');
                if (parts.length >= 4) {
                    const rawPath = parts[3];
                    const cleaned = rawPath.startsWith('b/') ? rawPath.slice(2) : rawPath;
                    paths.add(cleaned);
                }
                continue;
            }
            if (trimmed.length >= 3 && trimmed[1] === ':' && (trimmed[2] === '' || trimmed[2] === '/')) {
                paths.add(trimmed);
            }
        }
        return Array.from(paths);
    }

    private formatSession(exportData: any): { title: string; messages: SessionMessage[] } {
        const title = exportData?.info?.title || 'Session';
        const messages: SessionMessage[] = [];
        const rawMessages = Array.isArray(exportData?.messages) ? exportData.messages : [];

        for (const message of rawMessages) {
            const role = message?.info?.role === 'user' ? 'user' : 'assistant';
            const parts = Array.isArray(message?.parts)
                ? message.parts.filter((part: any) => part.type === 'text' && typeof part.text === 'string')
                : [];
            const text = parts.map((part: any) => part.text).join('');
            if (!text) continue;
            const messageId = message?.info?.id;
            messages.push({ role, text, id: messageId });
        }

        return { title, messages };
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const styleResetUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "reset.css")
        );
        const styleVSCodeUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "vscode.css")
        );
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "main.js")
        );
        const styleMainUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "main.css")
        );

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="${styleMainUri}" rel="stylesheet">
                <style>
                    .message.bot.thinking {
                        color: var(--vscode-descriptionForeground);
                        font-style: italic;
                        animation: pulse 1.5s infinite;
                    }
                    @keyframes pulse {
                        0% { opacity: 0.5; }
                        50% { opacity: 1; }
                        100% { opacity: 0.5; }
                    }
                </style>
                <title>OpenCode Chat</title>
            </head>
            <body>
                <div class="session-header">
                    <span class="session-title" id="session-title">New Session</span>
                    <div class="session-controls">
                        <button class="icon-btn" id="new-session-btn" title="New Session">
                            <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M14 7v1H8v6H7V8H1V7h6V1h1v6h6z"/></svg>
                        </button>
                        <button class="icon-btn" id="redo-btn" title="Redo">
                            <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M8 3a5 5 0 0 1 4.5 2.8l.9-.4A6 6 0 1 0 8 14v-1a5 5 0 1 1 0-10zm1 0h3V0l3 3-3 3V4H9V3z"/></svg>
                        </button>
                        <button class="icon-btn" id="history-btn" title="History">
                            <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11zm0 1a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z"/><path fill-rule="evenodd" clip-rule="evenodd" d="M8.5 4.5V8l2.5 1.5-.5.866L7.5 8.5V4.5h1z"/></svg>
                        </button>
                    </div>
                </div>

                <div class="panel-backdrop hidden" id="panel-backdrop"></div>
                <div class="session-panel hidden" id="session-panel">
                    <div class="session-panel-header">
                        <span>Sessions</span>
                        <div class="session-panel-actions">
                            <button class="icon-btn" id="refresh-sessions" title="Refresh">
                                <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M8 3a5 5 0 1 1-4.546 2.916l.908-.417A4 4 0 1 0 8 4V1.5L11 4 8 6.5V4z"/></svg>
                            </button>
                            <button class="icon-btn" id="close-sessions" title="Close">
                                <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06z"/></svg>
                            </button>
                        </div>
                    </div>
                    <div class="session-list" id="session-list"></div>
                </div>

                <div class="chat-area" id="chat">
                    <div class="message bot">
                        Hello! I am OpenCode. How can I help you today?
                    </div>
                </div>

                <div class="input-container">
                    <textarea id="chat-input" placeholder="Ask anything..."></textarea>
                    <div class="attachment-list" id="attachment-list"></div>

                    <div class="toolbar">
                        <div class="left-tools">
                            <div class="select-wrapper mode-wrapper">
                                <select id="mode-select" title="Mode">
                                    <option value="build">build</option>
                                    <option value="plan">plan</option>
                                </select>
                            </div>

                            <div class="select-wrapper model-wrapper">
                                <select id="model-select" title="Model"></select>
                            </div>

                            <div class="select-wrapper variant-wrapper">
                                <select id="variant-select" title="Variant"></select>
                            </div>
                        </div>

                        <div class="right-tools">
                            <button class="send-btn" id="send-btn">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" fill="currentColor"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>

                <script src="${scriptUri}"></script>
            </body>
            </html>`;
    }
}
