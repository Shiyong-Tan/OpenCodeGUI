import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as pathModule from "path";
import { OpenCodeClient, ChatEvent, ModelInfo, SessionInfo, FileSnapshot, ConflictDetail } from "./OpenCodeClient";
import { OpenCodeDiffProvider } from "./OpenCodeDiffProvider";

type SessionMessage = {
    role: 'user' | 'assistant';
    text: string;
    id?: string;
    messageIndex?: number;
};

type PersistedRevertedSegment = {
    sessionId: string;
    segment: {
        isActive: boolean;
        startMessageId?: string;
        startMessageIndex?: number;
        endMessageId?: string;
        endMessageIndex?: number;
        opIds?: string[];
        collapsed: boolean;
        messageIds?: string[];
        operationId?: string;
        historySegments?: Array<{
            isActive: boolean;
            discarded: boolean;
            startMessageId?: string;
            startMessageIndex?: number;
            endMessageId?: string;
            endMessageIndex?: number;
            collapsed: boolean;
            messageIds?: string[];
            operationId?: string;
        }>;
    };
    conflicts: ConflictDetail[];
    discarded?: boolean;
    updatedAt: number;
};

/**
 * Simplified SegmentState interface (V2)
 * Only tracks essential data, no state/anchor/resolved complexity
 */
interface SegmentState {
    noticeKey: string;       // Primary key: "system:undo:msg_xxx"
    anchorMsgId: string;     // Must start with msg_
    endMsgId: string;        // Must start with msg_
    memberMsgIds: string[];  // All msg_* in [anchor, end] interval
    applied?: boolean;
    restoreAllowed?: boolean;
    collapsed?: boolean;
    createdAt: number;
    updatedAt: number;
}

export class SidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _webviewInstanceId?: string;
    private client: OpenCodeClient;
    private currentSessionId?: string;
    private selectedModel?: string;
    private selectedVariant?: string;
    private selectedMode?: string;
    private pendingClientMessageId?: string;
    private currentDiffFilePath: string | null = null;
    private diffHashes = new Map<string, { before: string; after: string }>();
    private revertedSegment?: { conflicts: ConflictDetail[]; discarded?: boolean };
    private clientMessageIdMap = new Map<string, string>();
    private revertedSegmentHistory: Array<{ isActive: boolean; discarded: boolean; startMessageId?: string; startMessageIndex?: number; endMessageId?: string; endMessageIndex?: number; collapsed: boolean; messageIds?: string[] }> = [];
    private pendingConflict?: { kind: 'undo' | 'restore'; startMessageId?: string; operationId?: string };
    private uiDebugChannel!: vscode.OutputChannel;
    private undoSegmentsBySession: Map<string, Map<string, SegmentState>> = new Map();
    private readonly UNDO_SEGMENTS_KEY = 'opencode.undoSegmentsBySession.v1';
    private pendingAssistantTmpKeyBySession = new Map<string, string>();

    private async ensureDir(dir: string): Promise<void> {
        await fs.promises.mkdir(dir, { recursive: true });
    }

    private getSnapshotDir(): string {
        return pathModule.join(this._context.globalStorageUri.fsPath, 'sessionSnapshots');
    }

    private getSnapshotFile(sessionId: string): string {
        return pathModule.join(this.getSnapshotDir(), `${sessionId}.json`);
    }

    private async writeSnapshotAtomic(sessionId: string, payloadObj: unknown): Promise<number> {
        const dir = this.getSnapshotDir();
        await this.ensureDir(dir);
        const filePath = this.getSnapshotFile(sessionId);
        const tmpPath = `${filePath}.tmp`;
        const text = JSON.stringify(payloadObj, null, 2);
        await fs.promises.writeFile(tmpPath, text, 'utf-8');
        await fs.promises.rename(tmpPath, filePath);
        return Buffer.byteLength(text, 'utf-8');
    }

    private async readSnapshot(sessionId: string): Promise<{ obj: any; bytes: number } | null> {
        const filePath = this.getSnapshotFile(sessionId);
        if (!fs.existsSync(filePath)) return null;
        const text = await fs.promises.readFile(filePath, 'utf-8');
        return { obj: JSON.parse(text), bytes: Buffer.byteLength(text, 'utf-8') };
    }

    private extractLastLine(text: string): string {
        const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        return lines.length ? lines[lines.length - 1] : '';
    }

    constructor(
        private readonly _context: vscode.ExtensionContext,
        private readonly _extensionUri: vscode.Uri,
        private readonly diffProvider: OpenCodeDiffProvider
    ) {
        this.client = new OpenCodeClient();
        this.uiDebugChannel = vscode.window.createOutputChannel('OpenCode UI Debug');
        this.uiDebugChannel.show(true);
        this.client.setUiDebugChannel(this.uiDebugChannel);

        try {
            const raw = this._context.globalState.get<string>(this.UNDO_SEGMENTS_KEY);
            if (raw) {
                const parsed = JSON.parse(raw) as Record<string, Record<string, SegmentState>>;
                for (const [sid, segs] of Object.entries(parsed)) {
                    const segMap = new Map<string, SegmentState>();
                    for (const [nk, seg] of Object.entries(segs)) {
                        segMap.set(nk, seg);
                    }
                    this.undoSegmentsBySession.set(sid, segMap);
                }
            }
            const totalSegments = Array.from(this.undoSegmentsBySession.values())
                .flatMap(m => Array.from(m.values())).length;
            this.uiDebugChannel.appendLine(`EXT: segments hydrate | sessions | ${this.undoSegmentsBySession.size} | totalSegments | ${totalSegments}`);
        } catch (error) {
            this.uiDebugChannel.appendLine(`EXT: segments hydrate error | ${error}`);
        }
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
            const activeWebview = this._view?.webview || webviewView.webview;

            // Diagnostic logging for undoToMessage
            if (data.type === 'undoToMessage') {
                this.uiDebugChannel.appendLine(`[EXT][UNDO_ENTRY] type=${data.type} messageId=${data.messageId || 'NULL'} sessionId=${data.sessionId || 'NULL'} operationId=${data.operationId || 'NULL'} hasMessageId=${!!data.messageId}`);
            }

            switch (data.type) {
                case "webviewReady": {
                    // 更新 this._view 为最新实例
                    this._view = webviewView;
                    this._webviewInstanceId = data.webviewInstanceId;
                    this.uiDebugChannel.appendLine(`[EXT][HANDSHAKE_1_RX] webviewReady | wvId=${this._webviewInstanceId}`);
                    
                    const liveWebview = this._view?.webview;
                    if (liveWebview) {
                        this.uiDebugChannel.appendLine(`[EXT][HANDSHAKE_2_START] calling sendInit()`);
                        await this.sendInit(liveWebview);
                        this.uiDebugChannel.appendLine(`[EXT][HANDSHAKE_3_DONE] sendInit() complete, sending ack`);
                        
                        liveWebview.postMessage({ type: 'webviewReadyAck', timestamp: Date.now(), webviewInstanceId: this._webviewInstanceId });
                        this.uiDebugChannel.appendLine(`[EXT][HANDSHAKE_4_ACK] ack sent`);
                    }
                    break;
                }
                case "sendMessage": {
                    this.uiDebugChannel.appendLine(
                        `[EXT][SEND_RX] sessionId=${this.currentSessionId || 'NULL'} ` +
                        `hasValue=${Boolean(data.value)} valueLen=${data.value?.length || 0}`
                    );
                    
                    if (!data.value) {
                        this.uiDebugChannel.appendLine(`[EXT][SEND_DROP] reason=empty-value`);
                        return;
                    }

                    if (!this.currentSessionId) {
                        this.uiDebugChannel.appendLine(`[EXT][SEND_CREATE_SESSION] reason=no-current`);
                        try {
                            const sessionInfo = await this.client.createSession();
                            this.currentSessionId = sessionInfo.id;
                            this.client.setSessionId(this.currentSessionId);
                            this.uiDebugChannel.appendLine(`[EXT][SEND_SESSION_CREATED] id=${this.currentSessionId}`);
                            const liveWebview = this._view?.webview || activeWebview;
                            liveWebview.postMessage({
                                type: 'sessionId',
                                value: this.currentSessionId,
                                sessionId: this.currentSessionId
                            });
                        } catch (error) {
                            this.uiDebugChannel.appendLine(`[EXT][SEND_SESSION_CREATE_FAILED] err=${String(error)}`);
                        }
                    }

                    if (data.value.toLowerCase() === 'ping') {
                        OpenCodeClient.outputChannel.appendLine(`[BRIDGE] Manual PONG sent`);
                        this.postAddResponse(activeWebview, 'PONG - Bridge is working!');
                        return;
                    }

                    this.uiDebugChannel.appendLine(`[EXT][SEND_START] sessionId=${this.currentSessionId} attachments=${data.attachments?.length || 0}`);

                    try {
                        const attachments = Array.isArray(data.attachments) ? data.attachments : [];
                        const userText = data.value as string;
                        const modelText = userText;
                        const clientMessageId = data.clientMessageId || `local-${Date.now()}`;
                        this.pendingClientMessageId = clientMessageId;
                        if (this.currentSessionId) {
                            this.client.startTurn(this.currentSessionId, clientMessageId);
                        }
                        if (typeof data.tmpKey === 'string' && data.tmpKey.startsWith('tmp:') && this.currentSessionId) {
                            this.pendingAssistantTmpKeyBySession.set(this.currentSessionId, data.tmpKey);
                        }

                        const messageIndex = this.client.registerMessage(clientMessageId);
                        const liveWebview = this._view?.webview || activeWebview;
                        this.clientMessageIdMap.set(clientMessageId, clientMessageId);

                        const attachmentNames = attachments.map((item: string) => pathModule.basename(item));
                        const displayText = attachmentNames.length
                            ? `${userText}

[Attached: ${attachmentNames.join(', ')}]`
                            : userText;
                        const pendingUserMessage: SessionMessage = {
                            role: 'user',
                            text: displayText,
                            id: clientMessageId,
                            messageIndex
                        };

                        const assistantMessageId = this.client.createInternalMessageId('assistant', this.currentSessionId);
                        const assistantMessageIndex = this.client.registerMessage(assistantMessageId);
                        liveWebview.postMessage({
                            type: 'messageAppend',
                            message: pendingUserMessage,
                            sessionId: this.currentSessionId
                        });
                        liveWebview.postMessage({
                            type: 'assistantMessageMeta',
                            messageId: assistantMessageId,
                            messageIndex: assistantMessageIndex,
                            sessionId: this.currentSessionId
                        });

                        await this.client.chat(
                            modelText,
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
                        liveWebview.postMessage({ type: 'chatDone', sessionId: this.currentSessionId });
                        await this.resolvePendingUserUpgrade(this.currentSessionId, liveWebview);
                        if (this.currentSessionId) {
                            this.client.finishTurn(this.currentSessionId);
                        }
                        this.postMessageIndexMap(liveWebview);
                        if (this.pendingClientMessageId) {
                            await this.handleAbortedMessage(this.pendingClientMessageId, liveWebview);
                            this.pendingClientMessageId = undefined;
                        }
                        if (this.selectedMode === 'build' && this.currentSessionId) {
                            const segment = this.client.getRevertedSegment();
                            if (segment) {
                                segment.discarded = true;
                                segment.isActive = true;
                                segment.collapsed = true;
                                this.client.setRevertedSegment(segment);
                                await this.persistRevertedSegment(this.currentSessionId, segment, segment.conflicts || [], true);
                            }
                        }
                    } catch (error) {
                        OpenCodeClient.outputChannel.appendLine(`[BRIDGE] Error: ${error}`);
                        vscode.window.showErrorMessage(`OpenCode Error: ${error}`);
                        this.postAddResponse(activeWebview, `Error: ${error}`);
                        activeWebview.postMessage({ type: 'chatDone', sessionId: this.currentSessionId });
                        await this.resolvePendingUserUpgrade(this.currentSessionId, activeWebview);
                        if (this.currentSessionId) {
                            this.client.finishTurn(this.currentSessionId);
                        }
                        if (this.pendingClientMessageId) {
                            await this.handleAbortedMessage(this.pendingClientMessageId, activeWebview);
                            this.pendingClientMessageId = undefined;
                        }
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
                    // 使用 webviewView.webview（最新实例），而不是 activeWebview
                    await this.refreshSessions(webviewView.webview, data.requestId || '');
                    break;
                }
                case "ping": {
                    const liveWebview = this._view?.webview || webviewView.webview;
                    liveWebview.postMessage({ type: 'pong', ts: data.ts });
                    break;
                }
                case "registerTmpKey": {
                    if (typeof data.sessionId !== 'string' || typeof data.tmpKey !== 'string') break;
                    if (!data.tmpKey.startsWith('tmp:')) break;
                    this.pendingAssistantTmpKeyBySession.set(data.sessionId, data.tmpKey);
                    break;
                }
                case "registerPendingUserLocal": {
                    if (typeof data.sessionId !== 'string' || typeof data.localKey !== 'string') break;
                    if (!data.localKey.startsWith('local-')) break;
                    this.client.startTurn(data.sessionId, data.localKey);
                    break;
                }
                case "undoSegmentUpsert": {
                    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : this.currentSessionId;
                    if (!sessionId) {
                        this.uiDebugChannel.appendLine(`[EXT][SEG_UPSERT_SKIP] reason=missing-sessionId noticeKey=${typeof data.segment?.noticeKey === 'string' ? data.segment.noticeKey : 'null'}`);
                        break;
                    }
                    
                    const seg = data.segment;
                    if (!seg || typeof seg.noticeKey !== 'string') {
                        this.uiDebugChannel.appendLine(`[EXT][SEG_UPSERT_SKIP] reason=invalid-segment noticeKey=${typeof seg?.noticeKey === 'string' ? seg.noticeKey : 'null'}`);
                        break;
                    }
                    
                    // Validate anchorMsgId
                    if (!seg.anchorMsgId || !seg.anchorMsgId.startsWith('msg_')) {
                        this.uiDebugChannel.appendLine(`[EXT][SEG_UPSERT_SKIP] reason=invalid-anchor anchorMsgId=${seg.anchorMsgId || 'null'} noticeKey=${seg.noticeKey}`);
                        break;
                    }
                    
                    // Filter memberMsgIds to only msg_*
                    const memberMsgIds = Array.isArray(seg.memberMsgIds)
                        ? seg.memberMsgIds.filter((id: string) => typeof id === 'string' && id.startsWith('msg_'))
                        : [];
                    
                    // Get or create segment map for this session
                    let segMap = this.undoSegmentsBySession.get(sessionId);
                    if (!segMap) {
                        segMap = new Map<string, SegmentState>();
                        this.undoSegmentsBySession.set(sessionId, segMap);
                    }
                    
                    const beforeCount = segMap.size;
                    this.uiDebugChannel.appendLine(
                        `[EXT][SEG_UPSERT_RX] sessionId=${sessionId} noticeKey=${seg.noticeKey} ` +
                        `anchor=${seg.anchorMsgId} end=${seg.endMsgId || seg.anchorMsgId} members=${memberMsgIds.length}`
                    );

                    // Create/update segment
                    const segmentState: SegmentState = {
                        noticeKey: seg.noticeKey,
                        anchorMsgId: seg.anchorMsgId,
                        endMsgId: seg.endMsgId || seg.anchorMsgId,
                        memberMsgIds: memberMsgIds,
                        applied: typeof seg.applied === 'boolean' ? seg.applied : undefined,
                        restoreAllowed: typeof seg.restoreAllowed === 'boolean' ? seg.restoreAllowed : undefined,
                        collapsed: typeof seg.collapsed === 'boolean' ? seg.collapsed : undefined,
                        createdAt: segMap.get(seg.noticeKey)?.createdAt || Date.now(),
                        updatedAt: Date.now()
                    };
                    
                    segMap.set(seg.noticeKey, segmentState);
                    
                    // Save to globalState
                    const toSave: Record<string, Record<string, SegmentState>> = {};
                    for (const [sid, sMap] of this.undoSegmentsBySession) {
                        const obj: Record<string, SegmentState> = {};
                        for (const [nk, s] of sMap) {
                            obj[nk] = s;
                        }
                        toSave[sid] = obj;
                    }
                    await this._context.globalState.update(this.UNDO_SEGMENTS_KEY, JSON.stringify(toSave));
                    
                    this.uiDebugChannel.appendLine(
                        `[EXT][SEG_UPSERT_SAVE] sessionId=${sessionId} before=${beforeCount} after=${segMap.size}`
                    );
                    this.uiDebugChannel.appendLine(
                        `[EXT][SEG_SAVE] noticeKey=${seg.noticeKey} restoreAllowed=${segmentState.restoreAllowed === true}`
                    );
                    break;
                }
                case "undoSegmentRemove": {
                    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : this.currentSessionId;
                    const noticeKey = typeof data.noticeKey === 'string' ? data.noticeKey : '';
                    
                    if (!sessionId || !noticeKey) {
                        this.uiDebugChannel.appendLine(
                            `[EXT][SEG_REMOVE_DROP] sessionId=${sessionId || 'null'} noticeKey=${noticeKey || 'null'}`
                        );
                        break;
                    }
                    
                    const segMap = this.undoSegmentsBySession.get(sessionId);
                    const before = segMap?.size ?? 0;
                    const deleted = segMap?.delete(noticeKey) ?? false;
                    const after = segMap?.size ?? 0;
                    
                    if (deleted) {
                        // Save to globalState
                        const toSave: Record<string, Record<string, SegmentState>> = {};
                        for (const [sid, sMap] of this.undoSegmentsBySession) {
                            const obj: Record<string, SegmentState> = {};
                            for (const [nk, seg] of sMap) {
                                obj[nk] = seg;
                            }
                            toSave[sid] = obj;
                        }
                        await this._context.globalState.update(this.UNDO_SEGMENTS_KEY, JSON.stringify(toSave));
                    }
                    
                    this.uiDebugChannel.appendLine(
                        `[EXT][SEG_REMOVE_SAVE] sessionId=${sessionId} noticeKey=${noticeKey} ` +
                        `deleted=${deleted} before=${before} after=${after}`
                    );
                    break;
                }
                case "undoSegmentDelete": {
                    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : this.currentSessionId;
                    const noticeKey = typeof data.noticeKey === 'string' ? data.noticeKey : '';
                    if (!sessionId || !noticeKey) {
                        this.uiDebugChannel.appendLine(
                            `[EXT][SEG_DELETE_RX] sessionId=${sessionId || 'null'} noticeKey=${noticeKey || 'null'}`
                        );
                        break;
                    }

                    this.uiDebugChannel.appendLine(
                        `[EXT][SEG_DELETE_RX] sessionId=${sessionId} noticeKey=${noticeKey}`
                    );

                    const segMap = this.undoSegmentsBySession.get(sessionId);
                    const before = segMap?.size ?? 0;
                    const deleted = segMap?.delete(noticeKey) ?? false;
                    const after = segMap?.size ?? 0;

                    if (deleted) {
                        const toSave: Record<string, Record<string, SegmentState>> = {};
                        for (const [sid, sMap] of this.undoSegmentsBySession) {
                            const obj: Record<string, SegmentState> = {};
                            for (const [nk, seg] of sMap) {
                                obj[nk] = seg;
                            }
                            toSave[sid] = obj;
                        }
                        await this._context.globalState.update(this.UNDO_SEGMENTS_KEY, JSON.stringify(toSave));
                    }

                    this.uiDebugChannel.appendLine(
                        `[EXT][SEG_DELETE_SAVE] sessionId=${sessionId} before=${before} after=${after}`
                    );
                    break;
                }
                case "selectSession": {
                    if (!data.sessionId) return;
                    try {
                        this.resetUiState();
                        this.currentSessionId = data.sessionId;
                        this.client.setSessionId(this.currentSessionId);
                        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                        if (workspaceFolder) {
                            await this._context.globalState.update(`recentSession.${workspaceFolder}`, data.sessionId);
                        }
                        const cwd = workspaceFolder || process.cwd();
                        this.uiDebugChannel.appendLine(`[EXT][EXPORT_TRY] sessionId=${data.sessionId} cwd=${cwd} cmd="opencode export ${data.sessionId}"`);
                        let exportResult: any = null;
                        let normalized = { ok: false, data: null as any, stderrLastLine: '' };
                        try {
                            exportResult = await this.client.exportSession(data.sessionId);
                            if (exportResult && typeof exportResult.code === 'number') {
                                normalized.ok = exportResult.code === 0;
                                normalized.stderrLastLine = this.extractLastLine(exportResult.stderr);
                                normalized.data = exportResult.data ?? exportResult;
                            } else {
                                normalized.ok = true;
                                normalized.data = exportResult;
                            }
                        } catch (err) {
                            normalized.ok = false;
                            normalized.stderrLastLine = this.extractLastLine(String(err));
                        }

                        if (!normalized.ok) {
                            this.uiDebugChannel.appendLine(`[EXT][EXPORT_FAIL] sessionId=${data.sessionId} stderrLastLine=${normalized.stderrLastLine || 'null'}`);
                            try {
                                const snap = await this.readSnapshot(data.sessionId);
                                if (snap?.obj?.sessionData) {
                                    const payload = snap.obj.sessionData;
                                    payload.meta = {
                                        source: 'snapshot',
                                        reason: 'export_failed',
                                        stderrLastLine: normalized.stderrLastLine || ''
                                    };
                                    const liveWebview = this._view?.webview || activeWebview;
                                    liveWebview.postMessage(payload);
                                    this.uiDebugChannel.appendLine(`[EXT][SNAP_LOAD_OK] sessionId=${data.sessionId} file=${this.getSnapshotFile(data.sessionId)} bytes=${snap.bytes}`);
                                    return;
                                }
                                this.uiDebugChannel.appendLine(`[EXT][SNAP_LOAD_MISS] sessionId=${data.sessionId} file=${this.getSnapshotFile(data.sessionId)}`);
                            } catch (err) {
                                this.uiDebugChannel.appendLine(`[EXT][SNAP_LOAD_FAIL] sessionId=${data.sessionId} err=${String(err)}`);
                            }
                            const liveWebview = this._view?.webview || activeWebview;
                            liveWebview.postMessage({
                                type: 'sessionLoadFailed',
                                payload: {
                                    sessionId: data.sessionId,
                                    reason: 'export_failed_no_snapshot',
                                    stderrLastLine: normalized.stderrLastLine || ''
                                }
                            });
                            return;
                        }

                        const exportData = normalized.data;
                        const formatted = this.formatSession(exportData);
                        const liveWebview = this._view?.webview || activeWebview;
                        const persisted = await this.loadPersistedSegment(data.sessionId);
                        const historySegments = persisted?.segment?.historySegments || [];
                        if (persisted?.segment?.historySegments) {
                            this.revertedSegmentHistory = persisted.segment.historySegments;
                        } else {
                            this.revertedSegmentHistory = [];
                        }
                        if (persisted?.segment) {
                            this.client.setRevertedSegment({
                                isActive: Boolean(persisted.segment.isActive),
                                discarded: Boolean(persisted.discarded),
                                startMessageId: persisted.segment.startMessageId || data.sessionId,
                                startMessageIndex: persisted.segment.startMessageIndex ?? 0,
                                endMessageId: persisted.segment.endMessageId || data.sessionId,
                                endMessageIndex: persisted.segment.endMessageIndex ?? (persisted.segment.startMessageIndex ?? 0),
                                opIds: persisted.segment.opIds || [],
                                collapsed: true,
                                conflicts: persisted.conflicts || [],
                                messageIds: persisted.segment.messageIds,
                                operationId: persisted.segment.operationId
                            });
                        }
                        const segMap = this.undoSegmentsBySession.get(data.sessionId);
                        const segments = segMap ? Array.from(segMap.values()) : [];

                        this.uiDebugChannel.appendLine(
                            `[EXT][SEG_HYDRATE_LOAD] sessionId=${data.sessionId} found=${segments.length} ` +
                            `keys=[${(segMap ? Array.from(segMap.keys()) : []).join(', ')}]`
                        );
                        
                        this.uiDebugChannel.appendLine(
                            `[EXT][SEG_HYDRATE_SEND] sessionId=${data.sessionId} count=${segments.length} reason=selectSession`
                        );
                        
                        const timelineMsgCount = formatted.messages.filter((m) => typeof m.id === 'string' && m.id.startsWith('msg_')).length;
                        this.uiDebugChannel.appendLine(
                            `sessionData.send | sessionId | ${data.sessionId} | messagesCount | ${formatted.messages.length} | ` +
                            `timelineMsgCount | ${timelineMsgCount} | segmentsCount | ${segments.length}`
                        );

                        const sessionPayload = {
                            type: 'sessionData',
                            sessionId: data.sessionId,
                            title: formatted.title,
                            messages: formatted.messages,
                            segments: segments  // Simplified segment array
                        };
                        liveWebview.postMessage(sessionPayload);
                        try {
                            const snapshotObj = {
                                sessionId: data.sessionId,
                                exportedAt: Date.now(),
                                sessionData: sessionPayload
                            };
                            const bytes = await this.writeSnapshotAtomic(data.sessionId, snapshotObj);
                            this.uiDebugChannel.appendLine(`[EXT][SNAP_SAVE] sessionId=${data.sessionId} file=${this.getSnapshotFile(data.sessionId)} bytes=${bytes}`);
                        } catch (err) {
                            this.uiDebugChannel.appendLine(`[EXT][SNAP_SAVE_FAIL] sessionId=${data.sessionId} err=${String(err)}`);
                        }
                        } catch (error) {
                            vscode.window.showErrorMessage(`Failed to load session: ${error}`);
                            this.postAddResponse(activeWebview, `Error: ${error}`);
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
                            mime: data.mime,
                            sessionId: this.currentSessionId
                        });
                    } catch (error) {
                        vscode.window.showErrorMessage(`Failed to save image: ${error}`);
                        this.postAddResponse(activeWebview, `Failed to save image: ${error}`);
                    }
                    break;
                }
                case "newSession": {
                    if (this.currentSessionId) {
                        await this.clearPersistedSegment(this.currentSessionId);
                    }
                    this.resetSessionState();
                    this.currentSessionId = undefined;
                    this.client.setSessionId(this.currentSessionId);
                    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                    if (workspaceFolder) {
                        await this._context.globalState.update(`recentSession.${workspaceFolder}`, undefined);
                    }
                    activeWebview.postMessage({ type: 'newSession', sessionId: this.currentSessionId });
                    break;
                }
                case "undoToMessage": {
                    this.uiDebugChannel.appendLine(`[EXT][UNDO_CASE] messageId=${data.messageId || 'NULL'} checkFailed=${!data.messageId}`);
                    if (!data.messageId) {
                        this.uiDebugChannel.appendLine(`[EXT][UNDO_DROP] reason=no-messageId fullData=${JSON.stringify(data)}`);
                        return;
                    }
                    try {
                        const sessionId = this.currentSessionId;
                        const operationId = typeof data.operationId === 'string' ? data.operationId : undefined;
                        const resolvedMessageId = this.clientMessageIdMap.get(data.messageId) || data.messageId;
                        const noticeKey = `system:undo:${resolvedMessageId}`;
                        this.uiDebugChannel.appendLine(`[EXT][UNDO_RX] anchorMsgId=${data.messageId} resolvedMsgId=${resolvedMessageId} sessionId=${sessionId || 'null'} opId=${operationId || 'null'}`);
                        const previousSegment = this.client.getRevertedSegment();
                        const result = await this.client.undoFromMessage(resolvedMessageId);
                        this.uiDebugChannel.appendLine(`[EXT][UNDO_DONE] applied=${result.applied} conflicts=${result.conflicts.length} sessionId=${sessionId || 'null'}`);
                        if (!result.applied && result.conflicts.length) {
                            this.pendingConflict = { kind: 'undo', startMessageId: resolvedMessageId, operationId };
                            const liveWebview = this._view?.webview || activeWebview;
                            this.uiDebugChannel.appendLine(`EXT: undo.postToWebview | type=conflictCard | sessionId | ${sessionId || 'null'} | opId | ${operationId || 'null'}`);
                            liveWebview.postMessage({
                                type: 'conflictCard',
                                kind: 'undo',
                                startMessageId: resolvedMessageId,
                                conflicts: result.conflicts,
                                sessionId: sessionId,
                                operationId,
                                noticeKey
                            });
                            this.postAddResponse(activeWebview, `Undo paused due to ${result.conflicts.length} conflicts.`, { operationId });
                            break;
                        }
                        this.postMessageIndexMap(activeWebview);
                        if (result.applied && previousSegment) {
                            const current = this.client.getRevertedSegment();
                            const currentSet = new Set(current?.messageIds ?? []);
                            const prevIds = previousSegment.messageIds ?? [];
                            const trimmedPrevIds = prevIds.filter(id => !currentSet.has(id));
                            let historyEntry = {
                                isActive: false,
                                discarded: true,
                                startMessageId: previousSegment.startMessageId,
                                startMessageIndex: previousSegment.startMessageIndex,
                                endMessageId: previousSegment.endMessageId,
                                endMessageIndex: previousSegment.endMessageIndex,
                                collapsed: true,
                                messageIds: trimmedPrevIds,
                                operationId: previousSegment.operationId
                            };
                            if (trimmedPrevIds.length) {
                                this.revertedSegmentHistory = [...this.revertedSegmentHistory, historyEntry];
                            }
                            this.revertedSegmentHistory = this.revertedSegmentHistory
                                .map(e => ({
                                    ...e,
                                    messageIds: (e.messageIds ?? []).filter(id => !currentSet.has(id))
                                }))
                                .filter(e => (e.messageIds ?? []).length > 0);
                        }
                        const segment = this.client.getRevertedSegment();
                        const liveWebview = this._view?.webview || activeWebview;
                        if (segment) {
                            if (operationId) {
                                segment.operationId = operationId;
                                this.client.setRevertedSegment(segment);
                            }
                            this.revertedSegment = { conflicts: result.conflicts };
                            const finalSessionId = sessionId || this.currentSessionId;
                            this.uiDebugChannel.appendLine(`[EXT][UNDO_TX] type=revertedSegment sessionId=${finalSessionId || 'null'} anchorMsgId=${segment.startMessageId} endMsgId=${segment.endMessageId} applied=true opId=${operationId || 'null'}`);
                            liveWebview.postMessage({
                                type: 'revertedSegment',
                                conflicts: result.conflicts || [],
                                segment: {
                                    isActive: segment.isActive,
                                    startMessageId: segment.startMessageId,
                                    startMessageIndex: segment.startMessageIndex,
                                    endMessageId: segment.endMessageId,
                                    endMessageIndex: segment.endMessageIndex,
                                    collapsed: segment.collapsed,
                                    messageIds: segment.messageIds,
                                    operationId,
                                    historySegments: this.revertedSegmentHistory
                                },
                                sessionId: finalSessionId,
                                operationId,
                                noticeKey
                            });
                            if (this.currentSessionId) {
                                await this.persistRevertedSegment(this.currentSessionId, segment, result.conflicts, false);
                            }
                        } else {
                            this.revertedSegment = { conflicts: result.conflicts };
                            const finalSessionId = sessionId || this.currentSessionId;
                            this.uiDebugChannel.appendLine(`[EXT][UNDO_TX] type=revertedSegment sessionId=${finalSessionId || 'null'} anchorMsgId=null endMsgId=null applied=true opId=${operationId || 'null'}`);
                            liveWebview.postMessage({
                                type: 'revertedSegment',
                                conflicts: result.conflicts || [],
                                segment: null,
                                sessionId: finalSessionId,
                                operationId,
                                noticeKey
                            });
                        }
                        if (!result.touchedFiles.length) {
                            this.postAddResponse(activeWebview, 'Undo applied. No tracked file changes were available to revert. The current model may not support file change tracks. Please consider use OpenAI Codex.', { operationId });
                        } else {
                            this.postAddResponse(activeWebview, 'Undo applied.', { operationId });
                        }
                        this.refreshDiffIfTouched(result.touchedFiles);
                    } catch (error) {
                        vscode.window.showErrorMessage(`Undo failed: ${error}`);
                        activeWebview.postMessage({ type: 'addResponse', value: `Undo failed: ${error}` });
                    }
                    break;
                }
                case "cancel": {
                    this.client.cancel();
                    if (this.pendingClientMessageId) {
                        await this.handleAbortedMessage(this.pendingClientMessageId, activeWebview);
                        this.pendingClientMessageId = undefined;
                    }
                    this.postAddResponse(activeWebview, 'Canceled.');
                    activeWebview.postMessage({ type: 'chatDone', sessionId: this.currentSessionId });
                    await this.resolvePendingUserUpgrade(this.currentSessionId, activeWebview);
                    if (this.currentSessionId) {
                        this.client.finishTurn(this.currentSessionId);
                    }
                    break;
                }
                case "restoreAll": {
                    this.uiDebugChannel.appendLine(`[EXT][RESTORE_RX] type=restoreAll sessionId=${this.currentSessionId || 'null'} noticeKey=${typeof data.noticeKey === 'string' ? data.noticeKey : 'null'}`);
                    try {
                        const operationId = typeof data.operationId === 'string' ? data.operationId : undefined;
                        const result = await this.client.restoreAll();
                        if (!result.applied && result.conflicts.length) {
                            this.pendingConflict = { kind: 'restore', operationId };
                            const liveWebview = this._view?.webview || activeWebview;
                            liveWebview.postMessage({
                                type: 'conflictCard',
                                kind: 'restore',
                                conflicts: result.conflicts,
                                sessionId: this.currentSessionId
                            });
                            this.postAddResponse(activeWebview, `Restore paused due to ${result.conflicts.length} conflicts.`, { operationId });
                            break;
                        }
                        this.revertedSegment = { conflicts: [] };
                        activeWebview.postMessage({
                            type: 'restoredSegment',
                            noticeKey: typeof data.noticeKey === 'string' ? data.noticeKey : '',
                            applied: result.applied,
                            conflicts: result.conflicts,
                            sessionId: this.currentSessionId
                        });
                        this.uiDebugChannel.appendLine(`[EXT][RESTORE_TX] type=restoredSegment sessionId=${this.currentSessionId || 'null'} noticeKey=${typeof data.noticeKey === 'string' ? data.noticeKey : 'null'} applied=${result.applied}`);
                        if (this.currentSessionId) {
                            await this.clearPersistedSegment(this.currentSessionId);
                        }
                        this.postAddResponse(activeWebview, 'Restore applied.', { operationId });
                        this.refreshDiffIfTouched(result.touchedFiles);
                        if (this.currentSessionId) {
                            await this.clearPersistedSegment(this.currentSessionId);
                        }
                    } catch (error) {
                        vscode.window.showErrorMessage(`Restore failed: ${error}`);
                        activeWebview.postMessage({ type: 'addResponse', value: `Restore failed: ${error}` });
                    }
                    break;
                }
                case "restoreSegment": {
                    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : this.currentSessionId;
                    const anchorMsgId = typeof data.anchorMsgId === 'string' ? data.anchorMsgId : '';
                    const noticeKey = typeof data.noticeKey === 'string' ? data.noticeKey : '';
                    const endMsgId = typeof data.endMsgId === 'string' ? data.endMsgId : undefined;
                    this.uiDebugChannel.appendLine(`[EXT][RESTORE_RX] type=restoreSegment sessionId=${sessionId || 'null'} noticeKey=${noticeKey || 'null'} anchorMsgId=${anchorMsgId || 'null'}`);
                    if (!sessionId || !anchorMsgId) {
                        this.uiDebugChannel.appendLine(`[EXT][RESTORE_DROP] sessionId=${sessionId || 'null'} anchorMsgId=${anchorMsgId || 'null'}`);
                        break;
                    }
                    try {
                        const result = await this.client.restoreFromMessage(anchorMsgId, endMsgId);
                        const liveWebview = this._view?.webview || activeWebview;
                        liveWebview.postMessage({
                            type: 'restoredSegment',
                            noticeKey,
                            anchorMsgId,
                            applied: result.applied,
                            conflicts: result.conflicts,
                            sessionId: sessionId
                        });
                        this.uiDebugChannel.appendLine(`[EXT][RESTORE_TX] type=restoredSegment sessionId=${sessionId || 'null'} noticeKey=${noticeKey || 'null'} applied=${result.applied}`);
                        if (result.applied) {
                            this.postAddResponse(activeWebview, 'Restore applied.', { operationId: undefined });
                            this.refreshDiffIfTouched(result.touchedFiles);
                        } else if (result.conflicts.length) {
                            liveWebview.postMessage({
                                type: 'conflictCard',
                                kind: 'restore',
                                conflicts: result.conflicts,
                                sessionId: sessionId
                            });
                            this.postAddResponse(activeWebview, `Restore paused due to ${result.conflicts.length} conflicts.`);
                        }
                    } catch (error) {
                        vscode.window.showErrorMessage(`Restore failed: ${error}`);
                        activeWebview.postMessage({ type: 'addResponse', value: `Restore failed: ${error}` });
                    }
                    break;
                }
                case "conflictDecision": {
                    if (!this.pendingConflict || !data.decision) return;
                    const decision = data.decision as 'continue' | 'cancel';
                    const conflictContext = this.pendingConflict;
                    this.pendingConflict = undefined;
                    if (decision === 'cancel') {
                        this.postAddResponse(activeWebview, 'Conflict resolution canceled.', { operationId: conflictContext.operationId });
                        break;
                    }
                    try {
                        if (conflictContext.kind === 'undo' && conflictContext.startMessageId) {
                            const previousSegment = this.client.getRevertedSegment();
                            const result = await this.client.undoFromMessage(conflictContext.startMessageId, { force: true });
                            if (result.applied && previousSegment) {
                                const historyEntry = {
                                    isActive: false,
                                    discarded: true,
                                    startMessageId: previousSegment.startMessageId,
                                    startMessageIndex: previousSegment.startMessageIndex,
                                    endMessageId: previousSegment.endMessageId,
                                    endMessageIndex: previousSegment.endMessageIndex,
                                    collapsed: true,
                                    messageIds: previousSegment.messageIds,
                                    operationId: previousSegment.operationId
                                };
                                this.revertedSegmentHistory = [...this.revertedSegmentHistory, historyEntry];
                            }
                            const segment = this.client.getRevertedSegment();
                            if (segment) {
                                if (conflictContext.operationId) {
                                    segment.operationId = conflictContext.operationId;
                                    this.client.setRevertedSegment(segment);
                                }
                                this.revertedSegment = { conflicts: result.conflicts };
                                activeWebview.postMessage({
                                    type: 'revertedSegment',
                                    conflicts: result.conflicts || [],
                                    segment: {
                                        isActive: segment.isActive,
                                        startMessageId: segment.startMessageId,
                                        startMessageIndex: segment.startMessageIndex,
                                        endMessageId: segment.endMessageId,
                                        endMessageIndex: segment.endMessageIndex,
                                        collapsed: segment.collapsed,
                                        messageIds: segment.messageIds,
                                        operationId: conflictContext.operationId,
                                        historySegments: this.revertedSegmentHistory
                                    },
                                    sessionId: this.currentSessionId
                                });
                                if (this.currentSessionId) {
                                    await this.persistRevertedSegment(this.currentSessionId, segment, result.conflicts, false);
                                }
                            }
                            this.postAddResponse(activeWebview, 'Undo applied (force mode).', { operationId: conflictContext.operationId });
                            this.refreshDiffIfTouched(result.touchedFiles);
                        }
                        if (conflictContext.kind === 'restore') {
                            const result = await this.client.restoreAll({ force: true });
                            this.revertedSegmentHistory = [];
                            activeWebview.postMessage({
                                type: 'revertedSegment',
                                conflicts: result.conflicts || [],
                                segment: {
                                    historySegments: this.revertedSegmentHistory,
                                    messageIds: [],
                                    isActive: false,
                                    discarded: false,
                                    collapsed: true,
                                    startMessageId: '',
                                    startMessageIndex: 0,
                                    endMessageId: '',
                                    endMessageIndex: 0
                                },
                                sessionId: this.currentSessionId
                            });
                            if (this.currentSessionId) {
                                await this.clearPersistedSegment(this.currentSessionId);
                            }
                            this.postAddResponse(activeWebview, 'Restore applied (force mode).', { operationId: conflictContext.operationId });
                            this.refreshDiffIfTouched(result.touchedFiles);
                        }
                    } catch (error) {
                        vscode.window.showErrorMessage(`Conflict resolution failed: ${error}`);
                        activeWebview.postMessage({ type: 'addResponse', value: `Conflict resolution failed: ${error}` });
                    }
                    break;
                }
                case "discardSegment": {
                    this.uiDebugChannel.appendLine(`[EXT][DISCARD_SEND] reason=explicit_user_action sessionId=${this.currentSessionId || 'null'}`);
                    this.client.discardRevertedSegment();
                    this.revertedSegment = { conflicts: [], discarded: true };
                    const discardedSegment = this.client.getRevertedSegment();
                    activeWebview.postMessage({
                        type: 'revertedSegmentDiscarded',
                        segment: discardedSegment ? { ...discardedSegment, historySegments: this.revertedSegmentHistory } : discardedSegment,
                        sessionId: this.currentSessionId
                    });
                    this.postAddResponse(activeWebview, 'Reverted segment discarded.');
                    if (this.currentSessionId) {
                        const segment = this.client.getRevertedSegment();
                        if (segment) {
                            await this.persistRevertedSegment(this.currentSessionId, segment, segment.conflicts || [], true);
                        }
                    }
                    break;
                }
                case "setRevertedSegmentCollapsed": {
                    if (typeof data.collapsed !== 'boolean') return;
                    this.client.setRevertedSegmentCollapsed(data.collapsed);
                    activeWebview.postMessage({
                        type: 'revertedSegmentState',
                        segment: this.client.getRevertedSegment()
                            ? { ...this.client.getRevertedSegment(), historySegments: this.revertedSegmentHistory }
                            : null,
                        sessionId: this.currentSessionId
                    });
                    break;
                }
                case "ui-debug": {
                    if (Array.isArray(data.payload)) {
                        const [tag, ...args] = data.payload;
                        const message = args.map((arg: unknown) => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' | ');
                        this.uiDebugChannel.appendLine(`${tag}: ${message}`);
                    }
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
            this.postAddResponse(webview, `Failed to load models: ${error}`);
        }

        try {
            sessions = await this.client.listSessions();
        } catch (error) {
            this.postAddResponse(webview, `Failed to load sessions: ${error}`);
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

        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        let recentSessionId: string | undefined;
        if (workspaceFolder) {
            recentSessionId = this._context.globalState.get<string>(`recentSession.${workspaceFolder}`);
        }
                if (recentSessionId) {
                    try {
                        const cwd = workspaceFolder || process.cwd();
                        this.uiDebugChannel.appendLine(`[EXT][EXPORT_TRY] sessionId=${recentSessionId} cwd=${cwd} cmd="opencode export ${recentSessionId}"`);
                        let exportResult: any = null;
                        let normalized = { ok: false, data: null as any, stderrLastLine: '' };
                        try {
                            exportResult = await this.client.exportSession(recentSessionId);
                            if (exportResult && typeof exportResult.code === 'number') {
                                normalized.ok = exportResult.code === 0;
                                normalized.stderrLastLine = this.extractLastLine(exportResult.stderr);
                                normalized.data = exportResult.data ?? exportResult;
                            } else {
                                normalized.ok = true;
                                normalized.data = exportResult;
                            }
                        } catch (err) {
                            normalized.ok = false;
                            normalized.stderrLastLine = this.extractLastLine(String(err));
                        }

                        if (!normalized.ok) {
                            this.uiDebugChannel.appendLine(`[EXT][EXPORT_FAIL] sessionId=${recentSessionId} stderrLastLine=${normalized.stderrLastLine || 'null'}`);
                            try {
                                const snap = await this.readSnapshot(recentSessionId);
                                if (snap?.obj?.sessionData) {
                                    const payload = snap.obj.sessionData;
                                    payload.meta = {
                                        source: 'snapshot',
                                        reason: 'export_failed',
                                        stderrLastLine: normalized.stderrLastLine || ''
                                    };
                                    const liveWebview = this._view?.webview || webview;
                                    liveWebview.postMessage(payload);
                                    this.uiDebugChannel.appendLine(`[EXT][SNAP_LOAD_OK] sessionId=${recentSessionId} file=${this.getSnapshotFile(recentSessionId)} bytes=${snap.bytes}`);
                                    this.currentSessionId = recentSessionId;
                                    this.client.setSessionId(this.currentSessionId);
                                    return;
                                }
                                this.uiDebugChannel.appendLine(`[EXT][SNAP_LOAD_MISS] sessionId=${recentSessionId} file=${this.getSnapshotFile(recentSessionId)}`);
                            } catch (err) {
                                this.uiDebugChannel.appendLine(`[EXT][SNAP_LOAD_FAIL] sessionId=${recentSessionId} err=${String(err)}`);
                            }
                            const liveWebview = this._view?.webview || webview;
                            liveWebview.postMessage({
                                type: 'sessionLoadFailed',
                                payload: {
                                    sessionId: recentSessionId,
                                    reason: 'export_failed_no_snapshot',
                                    stderrLastLine: normalized.stderrLastLine || ''
                                }
                            });
                            return;
                        }

                        const exportData = normalized.data;
                        const formatted = this.formatSession(exportData);
                        this.currentSessionId = recentSessionId;
                        this.client.setSessionId(this.currentSessionId);
                        const liveWebview = this._view?.webview || webview;
                        const persisted = await this.loadPersistedSegment(recentSessionId);
                        const historySegments = persisted?.segment?.historySegments || [];
                        if (persisted?.segment?.historySegments) {
                            this.revertedSegmentHistory = persisted.segment.historySegments;
                        } else {
                            this.revertedSegmentHistory = [];
                        }
                        if (persisted?.segment) {
                            this.client.setRevertedSegment({
                                isActive: Boolean(persisted.segment.isActive),
                                discarded: Boolean(persisted.discarded),
                                startMessageId: persisted.segment.startMessageId || recentSessionId,
                                startMessageIndex: persisted.segment.startMessageIndex ?? 0,
                                endMessageId: persisted.segment.endMessageId || recentSessionId,
                                endMessageIndex: persisted.segment.endMessageIndex ?? (persisted.segment.startMessageIndex ?? 0),
                                opIds: persisted.segment.opIds || [],
                                collapsed: true,
                                conflicts: persisted.conflicts || [],
                                messageIds: persisted.segment.messageIds,
                                operationId: persisted.segment.operationId
                            });
                        }
                        const segMap = this.undoSegmentsBySession.get(recentSessionId);
                        const segments = segMap ? Array.from(segMap.values()) : [];

                        this.uiDebugChannel.appendLine(
                            `[EXT][SEG_HYDRATE_LOAD] sessionId=${recentSessionId} found=${segments.length} ` +
                            `keys=[${(segMap ? Array.from(segMap.keys()) : []).join(', ')}]`
                        );
                        
                        this.uiDebugChannel.appendLine(
                            `[EXT][SEG_HYDRATE_SEND] sessionId=${recentSessionId} count=${segments.length} reason=sendInit`
                        );
                        
                        const timelineMsgCount = formatted.messages.filter((m) => typeof m.id === 'string' && m.id.startsWith('msg_')).length;
                        this.uiDebugChannel.appendLine(
                            `sessionData.send | sessionId | ${recentSessionId} | messagesCount | ${formatted.messages.length} | ` +
                            `timelineMsgCount | ${timelineMsgCount} | segmentsCount | ${segments.length}`
                        );
                        
                        const sessionPayload = {
                            type: 'sessionData',
                            sessionId: recentSessionId,
                            title: formatted.title,
                            messages: formatted.messages,
                            segments: segments  // Simplified segment array (no complex mapping)
                        };
                        
                        liveWebview.postMessage(sessionPayload);
                        try {
                            const snapshotObj = {
                                sessionId: recentSessionId,
                                exportedAt: Date.now(),
                                sessionData: sessionPayload
                            };
                            const bytes = await this.writeSnapshotAtomic(recentSessionId, snapshotObj);
                            this.uiDebugChannel.appendLine(`[EXT][SNAP_SAVE] sessionId=${recentSessionId} file=${this.getSnapshotFile(recentSessionId)} bytes=${bytes}`);
                        } catch (err) {
                            this.uiDebugChannel.appendLine(`[EXT][SNAP_SAVE_FAIL] sessionId=${recentSessionId} err=${String(err)}`);
                        }
                } catch (err) {
                    this.uiDebugChannel.appendLine(`[EXT][EXPORT_FAILED] sessionId=${recentSessionId} err=${String(err)}`);
                    this.currentSessionId = undefined;
                }
            }

        // CRITICAL: Ensure we ALWAYS have a session selected
        if (!this.currentSessionId) {
            this.uiDebugChannel.appendLine(`[EXT][NO_SESSION] checking sessions.length=${sessions.length}`);
            
            if (sessions.length > 0) {
                // Auto-select most recent session
                const mostRecent = sessions[0];  // Already sorted by updatedAt desc
                this.currentSessionId = mostRecent.id;
                this.client.setSessionId(this.currentSessionId);
                this.uiDebugChannel.appendLine(`[EXT][AUTO_SELECT] sessionId=${this.currentSessionId} reason=no-current-session`);
                
                // Save as recent session for this workspace
                if (workspaceFolder) {
                    await this._context.globalState.update(`recentSession.${workspaceFolder}`, this.currentSessionId);
                }
                
                // Try to load this session's data
                try {
                    const exportResult = await this.client.exportSession(this.currentSessionId);
                    const formatted = this.formatSession(exportResult);
                    const segMap = this.undoSegmentsBySession.get(this.currentSessionId);
                    const segments = segMap ? Array.from(segMap.values()) : [];
                    
                    const liveWebview = this._view?.webview || webview;
                    liveWebview.postMessage({
                        type: 'sessionData',
                        sessionId: this.currentSessionId,
                        title: formatted.title,
                        messages: formatted.messages,
                        segments: segments
                    });
                    this.uiDebugChannel.appendLine(`[EXT][AUTO_SELECT_LOADED] sessionId=${this.currentSessionId} messages=${formatted.messages.length}`);
                } catch (err) {
                    this.uiDebugChannel.appendLine(`[EXT][AUTO_SELECT_LOAD_FAILED] sessionId=${this.currentSessionId} err=${String(err)}`);
                    // Try snapshot as fallback
                    try {
                        const snap = await this.readSnapshot(this.currentSessionId);
                        if (snap?.obj?.sessionData) {
                            const liveWebview = this._view?.webview || webview;
                            liveWebview.postMessage(snap.obj.sessionData);
                            this.uiDebugChannel.appendLine(`[EXT][AUTO_SELECT_SNAP_OK] sessionId=${this.currentSessionId}`);
                        }
                    } catch (snapErr) {
                        this.uiDebugChannel.appendLine(`[EXT][AUTO_SELECT_SNAP_FAILED] sessionId=${this.currentSessionId}`);
                    }
                }
            } else {
                // No sessions exist - create new one
                this.uiDebugChannel.appendLine(`[EXT][CREATE_NEW_SESSION] reason=no-sessions-exist`);
                try {
                    const newSession = await this.client.createSession();
                    this.currentSessionId = newSession.id;
                    this.client.setSessionId(this.currentSessionId);
                    this.uiDebugChannel.appendLine(`[EXT][SESSION_CREATED] sessionId=${this.currentSessionId}`);
                    
                    // Save as recent session
                    if (workspaceFolder) {
                        await this._context.globalState.update(`recentSession.${workspaceFolder}`, this.currentSessionId);
                    }
                    
                    const liveWebview = this._view?.webview || webview;
                    liveWebview.postMessage({
                        type: 'sessionData',
                        sessionId: this.currentSessionId,
                        title: 'New Chat',
                        messages: [],
                        segments: []
                    });
                } catch (err) {
                    this.uiDebugChannel.appendLine(`[EXT][SESSION_CREATE_FAILED] err=${String(err)}`);
                    // Last resort: set a placeholder to avoid undefined
                    this.currentSessionId = `fallback-${Date.now()}`;
                }
            }
        }

        // Now send init with GUARANTEED non-null currentSessionId
        const liveWebview = this._view?.webview || webview;
        this.uiDebugChannel.appendLine(
            `[EXT][INIT_SEND] models=${models.length} sessions=${sessions.length} ` +
            `currentSessionId=${this.currentSessionId} selectedModel=${defaultModel || 'NULL'}`
        );

        liveWebview.postMessage({
            type: 'init',
            models,
            sessions,
            selectedModel: defaultModel,
            selectedVariant: defaultVariant,
            selectedMode: defaultMode,
            currentSessionId: this.currentSessionId,
            sessionId: this.currentSessionId
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

    private async resolvePendingUserUpgrade(sessionId: string | undefined, webview: vscode.Webview): Promise<void> {
        if (!sessionId) return;
        const result = await this.client.resolveUserMessageUpgrade(sessionId);
        if (result.status === 'ok') {
            // Update user message ID mapping
            if (result.localKey && result.userMsgId) {
                this.clientMessageIdMap.set(result.localKey, result.userMsgId);
                const ok = this.client.upgradeMessageId(result.localKey, result.userMsgId);
                this.uiDebugChannel.appendLine(`EXT: user.upgrade.client | localKey | ${result.localKey} | msgId | ${result.userMsgId} | ok | ${ok}`);
            } else {
                this.uiDebugChannel.appendLine(`EXT: user.upgrade.client | skip | localKey=${result.localKey || 'null'} userMsgId=${result.userMsgId || 'null'}`);
            }
            
            // Also update assistant message ID mapping if we have a tmpKey
            const tmpKey = this.pendingAssistantTmpKeyBySession.get(sessionId);
            if (tmpKey && tmpKey.startsWith('tmp:') && result.assistantMsgId && result.assistantMsgId.startsWith('msg_')) {
                this.clientMessageIdMap.set(tmpKey, result.assistantMsgId);
                const assistantOk = this.client.upgradeMessageId(tmpKey, result.assistantMsgId);
                this.uiDebugChannel.appendLine(`EXT: assistant.upgrade.client | tmpKey | ${tmpKey} | msgId | ${result.assistantMsgId} | ok | ${assistantOk}`);
                // Clear the pending tmpKey since we've resolved it
                this.pendingAssistantTmpKeyBySession.delete(sessionId);
            }
            
            webview.postMessage({
                type: 'userMessageUpgrade',
                sessionId,
                localKey: result.localKey,
                userMsgId: result.userMsgId,
                assistantMsgId: result.assistantMsgId,
                assistantMsgIdsAll: result.assistantMsgIdsAll,
                chosenFinish: result.chosenFinish,
                chosenTimeCompleted: result.chosenTimeCompleted,
                chosenTimeCreated: result.chosenTimeCreated,
                tmpKey: tmpKey
            });
            return;
        }

        const tmpKey = this.pendingAssistantTmpKeyBySession.get(sessionId);
        const pendingPayload = {
            type: 'userMessageUpgrade',
            sessionId,
            localKey: result.localKey,
            userMsgId: result.userMsgId,
            assistantMsgId: null,
            awaitingAssistantIdFromExport: true,
            reason: result.reason,
            tmpKey
        };
        this.uiDebugChannel.appendLine(`EXT: user.upgrade.pending | session=${sessionId} reason=${result.reason} localKey=${result.localKey || 'null'} userMsgId=${result.userMsgId || 'null'}`);
        webview.postMessage(pendingPayload);
    }

    private handleChatEvent(event: ChatEvent, webview: vscode.Webview): void {
        if (event.type === 'session' && event.sessionId) {
            this.currentSessionId = event.sessionId;
            this.client.setSessionId(this.currentSessionId);
            const liveWebview = this._view?.webview || webview;
            liveWebview.postMessage({ type: 'sessionId', value: event.sessionId, sessionId: event.sessionId });
            return;
        }

        if (event.type === 'assistantMessageMeta' && (event.messageId || event.assistantMsgId)) {
            const liveWebview = this._view?.webview || webview;
            const sessionId = event.sessionId || this.currentSessionId;
            const tmpKey = sessionId ? this.pendingAssistantTmpKeyBySession.get(sessionId) : undefined;
            if (event.assistantMsgId && sessionId) {
                this.uiDebugChannel.appendLine(`[DBG_ASSIST_ID] session=${sessionId} assistantMsgId=${event.assistantMsgId} tmpKey=${tmpKey || 'null'}`);
            }
            liveWebview.postMessage({
                type: 'assistantMessageMeta',
                messageId: event.messageId,
                messageIndex: event.messageIndex,
                lastText: event.lastText,
                sessionId: this.currentSessionId,
                assistantMsgId: event.assistantMsgId,
                tmpKey
            });
            return;
        }

        if (event.type === 'text' && event.text) {
            const liveWebview = this._view?.webview || webview;
            const sessionId = event.sessionId || this.currentSessionId;
            const tmpKey = sessionId ? this.pendingAssistantTmpKeyBySession.get(sessionId) : undefined;
            liveWebview.postMessage({ type: 'chatChunk', value: event.text, sessionId: this.currentSessionId, assistantMsgId: event.assistantMsgId, tmpKey });
            return;
        }

        if (event.type === 'error' && event.text) {
            const liveWebview = this._view?.webview || webview;
            liveWebview.postMessage({ type: 'addResponse', value: `Error: ${event.text}`, sessionId: this.currentSessionId });
            liveWebview.postMessage({ type: 'chatDone', sessionId: this.currentSessionId });
            return;
        }

        if (event.type === 'permission' && event.text) {
            const liveWebview = this._view?.webview || webview;
            liveWebview.postMessage({ type: 'permissionPrompt', value: event.text, sessionId: this.currentSessionId });
            return;
        }

        if (event.type === 'message' && event.text) {
            if (this.pendingClientMessageId && this.currentSessionId) {
                const mappedMessageIndex = this.client.getMessageIndex(this.pendingClientMessageId)
                    ?? this.client.registerMessage(this.pendingClientMessageId);
                this.client.aliasMessageId(this.pendingClientMessageId, event.text);
                const internalId = this.clientMessageIdMap.get(this.pendingClientMessageId);
                if (internalId && internalId !== event.text) {
                    this.client.aliasMessageId(internalId, event.text);
                }
                const internalForPending = this.clientMessageIdMap.get(this.pendingClientMessageId);
                if (internalForPending) {
                    this.client.aliasMessageId(event.text, internalForPending);
                }
                this.clientMessageIdMap.delete(this.pendingClientMessageId);
                this.clientMessageIdMap.set(event.text, event.text);
                this.pendingClientMessageId = undefined;
            }
            return;
        }

        if ((event.type === 'diff' || event.type === 'toolPatch') && event.text) {
            const liveWebview = this._view?.webview || webview;
            liveWebview.postMessage({ type: 'diffChunk', value: event.text, sessionId: this.currentSessionId });
            return;
        }

        if (event.type === 'files' && event.files && event.files.length) {
            const picked = this.pickActiveFile(event.files);
            if (!picked) return;
            const { file: active, index } = picked;
            if (!active.before || !active.after) return;
            const beforeText = this.normalizeText(active.before);
            const afterText = this.normalizeText(active.after);
            const beforeHash = this.hashText(beforeText);
            const afterHash = this.hashText(afterText);
            const cache = this.diffHashes.get(active.filePath);
            const shouldUpdate = !cache || cache.before !== beforeHash || cache.after !== afterHash;
            if (!shouldUpdate) {
                return;
            }
            this.diffHashes.set(active.filePath, { before: beforeHash, after: afterHash });
            this.currentDiffFilePath = active.filePath;
            this.diffProvider.markNextChangeAutoFollow();
            this.diffProvider.updateFromSnapshot(active.filePath, beforeText, afterText, active.diff);
            const diffLen = active.diff ? active.diff.length : 0;
            const basename = pathModule.basename(active.filePath);
            OpenCodeClient.outputChannel.appendLine(`[DIFF] file=${basename} idx=${index} before=${beforeText.length} after=${afterText.length} diff=${diffLen}`);
            return;
        }

        if (event.type === 'raw' && event.text) {
            const liveWebview = this._view?.webview || webview;
            liveWebview.postMessage({ type: 'chatChunk', value: event.text, sessionId: this.currentSessionId });
        }
    }

    private async refreshModels(webview: vscode.Webview): Promise<void> {
        try {
            const models = await this.client.listModels();
            webview.postMessage({ type: 'models', models, sessionId: this.currentSessionId });
        } catch (error) {
            this.postAddResponse(webview, `Failed to refresh models: ${error}`);
        }
    }

    private async refreshSessions(webview: vscode.Webview, requestId: string): Promise<void> {
        try {
            const sessions = await this.client.listSessions();
            const topSession = sessions?.[0];
            webview.postMessage({ type: 'sessionsList', requestId, sessions });
        } catch (error) {
            this.postAddResponse(webview, `Failed to refresh sessions: ${error}`);
        }
    }

    private getRevertedSegmentStorageDir(): string {
        return this._context.globalStorageUri.fsPath;
    }

    private getRevertedSegmentPath(sessionId: string): string {
        return pathModule.join(this.getRevertedSegmentStorageDir(), 'revertedSegments', `${sessionId}.json`);
    }

    private async persistRevertedSegment(
        sessionId: string,
        segment: { isActive: boolean; startMessageId?: string; startMessageIndex?: number; endMessageId?: string; endMessageIndex?: number; opIds?: string[]; collapsed?: boolean; messageIds?: string[]; operationId?: string },
        conflicts: ConflictDetail[],
        discarded?: boolean
    ): Promise<void> {
        const dir = pathModule.join(this.getRevertedSegmentStorageDir(), 'revertedSegments');
        await fs.promises.mkdir(dir, { recursive: true });
        const payload: PersistedRevertedSegment = {
            sessionId,
            segment: {
                isActive: segment.isActive,
                startMessageId: segment.startMessageId,
                startMessageIndex: segment.startMessageIndex,
                endMessageId: segment.endMessageId,
                endMessageIndex: segment.endMessageIndex,
                opIds: segment.opIds || [],
                collapsed: true,
                messageIds: segment.messageIds,
                operationId: segment.operationId,
                historySegments: this.revertedSegmentHistory
            },
            conflicts: conflicts || [],
            discarded,
            updatedAt: Date.now()
        };
        await fs.promises.writeFile(this.getRevertedSegmentPath(sessionId), JSON.stringify(payload, null, 2), 'utf-8');
    }

    private async loadPersistedSegment(sessionId: string): Promise<PersistedRevertedSegment | undefined> {
        const filePath = this.getRevertedSegmentPath(sessionId);
        if (!fs.existsSync(filePath)) return undefined;
        try {
            const raw = await fs.promises.readFile(filePath, 'utf-8');
            return JSON.parse(raw) as PersistedRevertedSegment;
        } catch {
            return undefined;
        }
    }

    private async clearPersistedSegment(sessionId: string): Promise<void> {
        const filePath = this.getRevertedSegmentPath(sessionId);
        if (!fs.existsSync(filePath)) return;
        await fs.promises.unlink(filePath);
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

    private pickActiveFile(files: FileSnapshot[]): { file: FileSnapshot; index: number } | undefined {
        if (!files.length) return undefined;
        if (files.length === 1) return { file: files[0], index: 0 };
        let bestIndex = -1;
        let bestScore = -1;
        let hasScore = false;
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            if (typeof file.additions === 'number' && typeof file.deletions === 'number') {
                const score = file.additions + file.deletions;
                if (!hasScore || score > bestScore) {
                    bestScore = score;
                    bestIndex = i;
                    hasScore = true;
                }
            }
        }
        if (hasScore && bestIndex >= 0) {
            return { file: files[bestIndex], index: bestIndex };
        }
        return { file: files[0], index: 0 };
    }

    private normalizeText(text: string): string {
        return text.replace(/\r\n/g, '\n');
    }

    private refreshDiffIfTouched(touchedFiles: string[]): void {
        if (!this.currentDiffFilePath) return;
        if (!touchedFiles.includes(this.currentDiffFilePath)) return;
        const editor = vscode.window.visibleTextEditors.find((item) => {
            const uri = item.document.uri;
            return uri.scheme === 'opencode-diff' && uri.authority === 'right';
        });
        if (!editor) return;
        const key = editor.document.uri.path.replace(/^\//, '');
        this.diffProvider.markNextChangeAutoFollow();
        this.diffProvider.emitRefresh(key);
    }

    private hashText(text: string): string {
        return crypto.createHash('sha1').update(text).digest('hex');
    }

    private formatSession(exportData: any): { title: string; messages: SessionMessage[] } {
        const title = exportData?.info?.title || 'Session';
        const messages: SessionMessage[] = [];
        const rawMessages = Array.isArray(exportData?.messages) ? exportData.messages : [];
        const sessionId = exportData?.info?.id || exportData?.info?.sessionId || this.currentSessionId || 'unknown';
        const exportLines: string[] = [];
        const idRoleMap = new Map<string, Set<string>>();
        const seenIds = new Set<string>();
        let duplicateIds = false;

        for (let i = 0; i < rawMessages.length; i++) {
            const message = rawMessages[i];
            const role = message?.info?.role === 'user' ? 'user' : 'assistant';
            const messageId = message?.info?.id || '';
            const replyTo = message?.info?.replyTo || message?.info?.reply_to || message?.info?.parent || message?.info?.turnId || '';
            if (messageId) {
                if (seenIds.has(messageId)) {
                    duplicateIds = true;
                }
                seenIds.add(messageId);
                if (!idRoleMap.has(messageId)) {
                    idRoleMap.set(messageId, new Set());
                }
                idRoleMap.get(messageId)?.add(role);
            }
            const suffix = replyTo ? ` reply_to=${replyTo}` : '';
            exportLines.push(`  ${i} role=${role} id=${messageId}${suffix}`);
        }

        const multiRoleIds = Array.from(idRoleMap.entries()).filter(([, roles]) => roles.size > 1).map(([id]) => id);
        this.uiDebugChannel.appendLine(`[DBG_EXPORT] session=${sessionId} messages:`);
        for (const line of exportLines) {
            this.uiDebugChannel.appendLine(`[DBG_EXPORT] ${line}`);
        }
        this.uiDebugChannel.appendLine(`[DBG_EXPORT] total=${rawMessages.length} duplicateIds=${duplicateIds} multiRoleIds=${multiRoleIds.length}`);
        if (multiRoleIds.length) {
            this.uiDebugChannel.appendLine(`[DBG_EXPORT] multiRoleSample=[${multiRoleIds.slice(0, 5).join(', ')}]`);
        }

        for (const message of rawMessages) {
            const role = message?.info?.role === 'user' ? 'user' : 'assistant';
            const parts = Array.isArray(message?.parts)
                ? message.parts.filter((part: any) => part.type === 'text' && typeof part.text === 'string')
                : [];
            const text = parts.map((part: any) => part.text).join('');
            if (!text) continue;
            const messageId = message?.info?.id;
            const resolvedId = typeof messageId === 'string' ? messageId : '';
            if (!resolvedId.startsWith('msg_')) {
                this.uiDebugChannel.appendLine(`sessionData.skipMessage | reason | invalid-msg-id | id | ${resolvedId || 'null'}`);
                continue;
            }
            const messageIndex = this.client.registerMessage(resolvedId);
            messages.push({ role, text, id: resolvedId, messageIndex });
        }

        return { title, messages };
    }

    private resetSessionState(): void {
        this.client.resetSessionState();
        this.clientMessageIdMap.clear();
        this.revertedSegment = undefined;
        this.revertedSegmentHistory = [];
        this.pendingConflict = undefined;
        this.pendingClientMessageId = undefined;
        this.currentDiffFilePath = null;
        this.diffHashes.clear();
    }

    private resetUiState(): void {
        this.resetSessionState();
        if (this._view) {
            this._view.webview.postMessage({ type: 'resetUiState' });
        }
    }

    private async handleAbortedMessage(messageId: string, webview: vscode.Webview): Promise<void> {
        await this.client.rollbackMessageSnapshot(messageId);
        this.client.removeMessageId(messageId);
        this.clientMessageIdMap.delete(messageId);
        for (const [key, value] of this.clientMessageIdMap.entries()) {
            if (value === messageId) {
                this.clientMessageIdMap.delete(key);
            }
        }
        webview.postMessage({ type: 'removeMessage', messageId, sessionId: this.currentSessionId });
    }

    private postAddResponse(webview: vscode.Webview, value: string, meta?: { operationId?: string }): void {
        const messageId = this.client.createInternalMessageId('assistant', this.currentSessionId);
        const messageIndex = this.client.registerMessage(messageId);
        const liveWebview = this._view?.webview || webview;
        liveWebview.postMessage({
            type: 'addResponse',
            value,
            messageId,
            messageIndex,
            sessionId: this.currentSessionId,
            meta
        });
    }

    private postMessageIndexMap(webview: vscode.Webview): void {
        const map = this.client.getMessageIndexMap();
        const liveWebview = this._view?.webview || webview;
        liveWebview.postMessage({
            type: 'messageIndexMap',
            map,
            sessionId: this.currentSessionId
        });
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

        const markdownItUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "markdown-it.min.js")
        );
        const domPurifyUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "purify.min.js")
        );
        const highlightScriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "highlight.min.js")
        );
        const highlightStyleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "highlight-github-dark.css")
        );

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="${styleMainUri}" rel="stylesheet">
                <link href="${highlightStyleUri}" rel="stylesheet">
                <script src="${markdownItUri}"></script>
                <script>window.markdownit = window.markdownit || markdownit;</script>
                <script src="${domPurifyUri}"></script>
                <script src="${highlightScriptUri}"></script>
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
                    <span class="pending-indicator hidden" id="pending-indicator"></span>
                    <div class="session-controls">
                        <button class="icon-btn" id="new-session-btn" title="New Session">
                            <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M14 7v1H8v6H7V8H1V7h6V1h1v6h6z"/></svg>
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
                    <div class="message bot">Hello! I am OpenCode. How can I help you today?</div>
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
