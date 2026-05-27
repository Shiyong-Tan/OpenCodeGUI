import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as pathModule from "path";
import { OpenCodeClient, ChatEvent, ModelInfo, SessionInfo, FileSnapshot, ConflictDetail, AgentInfo, ChatFilePart } from "./OpenCodeClient";
import { OpenCodeDiffProvider } from "./OpenCodeDiffProvider";
import { GitRepoManager } from './undo/GitRepoManager';
import { runGit } from './undo/GitRunner';
import { GitRepoRef, SessionMap } from './undo/types';
import { resolveCurrentVisibleOwnerMsgId, resolveSessionOwnership } from './undo/ownershipResolver';

type SessionMessage = {
    role: 'user' | 'assistant' | 'system';
    text: string;
    id?: string;
    messageIndex?: number;
    meta?: Record<string, unknown>;
};

type ChangeListRecord = {
    id: string;
    commitHead: string;
    commitBase: string;
    files: string[];
    anchorMessageId: string;
    createdAt: number;
    reverted?: boolean;
    statsByPath?: Record<string, { additions: number | null; deletions: number | null }>;
};

type CanceledTurnRecord = {
    opId?: string;
    localKey?: string;
    userMsgId?: string;
    assistantMsgId?: string;
    textHash?: string;
    canceledAt: number;
};

type WorkspaceFileResult = {
    path: string;
    name: string;
    directory: string;
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

type AttachmentPayload = {
    filename?: string;
    mime?: string;
    dataBase64?: string;
    tempPath?: string;
};

type SavedAttachment = {
    token: string;
    filename: string;
    mime: string;
    sizeBytes: number;
    relPath: string;
};

type LocalQuestionRequest = {
    sessionId: string;
    resolve: (result: { selectedId?: string; selectedLabel?: string }) => void;
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
    mergedInvalidSegments?: SegmentState[];
    applied?: boolean;
    restoreAllowed?: boolean;
    collapsed?: boolean;
    createdAt: number;
    updatedAt: number;
}

type SubagentLifecycleState = 'queued' | 'running' | 'finalizing' | 'done' | 'failed' | 'cancelled' | 'dismissed';

export class SidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _webviewInstanceId?: string;
    private client: OpenCodeClient;
    private currentSessionId?: string;
    private userOwnedSessionIds = new Set<string>();
    private activeSubagentSessionIds = new Set<string>();
    private subagentProgressBySession = new Map<string, { taskId: string; parentSessionId: string; description: string; startedAt: number; title?: string; mode?: string; model?: string; providerId?: string; latestText?: string; latestTool?: string; latestToolInput?: string; isDone?: boolean; state?: SubagentLifecycleState; finishedAt?: number; dismissAt?: number; lastEventAt?: number; finalMessageId?: string; finalReason?: string }>();
    private readonly subagentDoneRetentionMs = 5000;
    private subagentRetentionTimer?: NodeJS.Timeout;
    private task1DoneVisibleTotalMs = 0;
    private task1DoneVisibleCount = 0;
    private task1FalseDoneEvents = 0;
    private appendSubmitInFlightBySession = new Set<string>();

    private cleanSubagentTitle(title?: string): string {
        const raw = typeof title === 'string' ? title.trim() : '';
        if (!raw) return '';
        return raw
            .replace(/\s*[（(]\s*@[^()]*[)）]\s*$/i, '')
            .trim();
    }

    private isUserOwnedSession(id: string): boolean {
        return this.userOwnedSessionIds.has(id) || id === this.currentSessionId;
    }

    private trackUserOwnedSession(id: string | undefined): void {
        if (id) {
            this.userOwnedSessionIds.add(id);
            this._context.globalState.update(this.USER_OWNED_SESSIONS_KEY, JSON.stringify([...this.userOwnedSessionIds]));
        }
    }

    private async loadUserOwnedSessions(): Promise<void> {
        try {
            const raw = this._context.globalState.get<string>(this.USER_OWNED_SESSIONS_KEY);
            if (!raw) {
                this.uiDebugChannel?.appendLine('[SidebarProvider] loadUserOwnedSessions: no stored sessions');
                return;
            }
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                parsed.forEach((id: string) => this.userOwnedSessionIds.add(id));
                this.uiDebugChannel?.appendLine(`[SidebarProvider] loadUserOwnedSessions: restored ${parsed.length} session(s)`);
            } else {
                this.uiDebugChannel?.appendLine('[SidebarProvider] loadUserOwnedSessions: invalid format (not an array)');
            }
        } catch (error) {
            this.uiDebugChannel?.appendLine(`[SidebarProvider] loadUserOwnedSessions: failed with error: ${String(error)}`);
        }
    }

    private clearSubagentSessions(): void {
        const now = Date.now();
        for (const [sessionId, entry] of this.subagentProgressBySession.entries()) {
            const st = entry.state || (entry.isDone ? 'done' : 'running');
            const expired = typeof entry.dismissAt === 'number' && entry.dismissAt <= now;
            const canClear = st === 'dismissed' || ((st === 'done' || st === 'failed' || st === 'cancelled') && expired);
            if (!canClear) continue;
            if ((st === 'done' || st === 'failed' || st === 'cancelled') && typeof entry.finishedAt === 'number') {
                const visibleMs = Math.max(0, now - entry.finishedAt);
                this.task1DoneVisibleTotalMs += visibleMs;
                this.task1DoneVisibleCount += 1;
                const avgDoneVisibleMs = this.task1DoneVisibleCount > 0 ? Math.round(this.task1DoneVisibleTotalMs / this.task1DoneVisibleCount) : 0;
                const falseDoneRate = this.task1DoneVisibleCount > 0 ? (this.task1FalseDoneEvents / this.task1DoneVisibleCount) : 0;
                this.uiDebugChannel.appendLine(`[SidebarProvider] metrics.task1 done_visible_ms=${avgDoneVisibleMs} false_done_rate=${falseDoneRate.toFixed(4)}`);
            }
            this.client.clearSubagentSession(sessionId);
            this.activeSubagentSessionIds.delete(sessionId);
            this.subagentProgressBySession.delete(sessionId);
            this.uiDebugChannel.appendLine(`[SidebarProvider] Cleared subagent session mapping: ${sessionId}`);
        }
    }

    private isTerminalSubagentState(state: SubagentLifecycleState | undefined): boolean {
        return state === 'done' || state === 'failed' || state === 'cancelled' || state === 'dismissed';
    }

    private async promptCancelRollbackDecision(webview: vscode.Webview, sessionId: string): Promise<boolean> {
        if (!sessionId) return true;
        if (!this.client.hasPendingTurnChanges(sessionId)) return true;

        const callId = `local-cancel-rollback-${crypto.randomUUID()}`;
        const prompt =
            'Local file changes were detected in the current turn. Do you want to roll them back? ' +
            'If you choose to roll back, changes made by both the agent and the user during this turn may be reverted. ' +
            'If you choose to keep them, no rollback will be performed and all changes will remain in place.';

        return await new Promise<boolean>((resolve) => {
            this.pendingLocalQuestionRequests.set(callId, {
                sessionId,
                resolve: (result) => {
                    const choice = (result.selectedId || result.selectedLabel || '').trim().toLowerCase();
                    resolve(choice === 'rollback');
                }
            });

            webview.postMessage({
                type: 'questionOverlay',
                sessionId,
                callId,
                title: 'Local Changes Detected',
                prompt,
                options: [
                    { id: 'rollback', label: 'Roll Back Changes' },
                    { id: 'keep', label: 'Keep Changes' }
                ],
                questions: [
                    {
                        title: 'Local Changes Detected',
                        prompt,
                        options: [
                            { id: 'rollback', label: 'Roll Back Changes' },
                            { id: 'keep', label: 'Keep Changes' }
                        ],
                        multiple: false
                    }
                ],
                localOnly: true
            });
        });
    }

    private syncClientRevertedSegmentFromUndoSegments(sessionId: string): void {
        const segMap = this.undoSegmentsBySession.get(sessionId);
        if (!segMap || segMap.size === 0) {
            this.client.setRevertedSegment(undefined);
            return;
        }
        const activeSegments = Array.from(segMap.values())
            .filter((seg) => seg.restoreAllowed === true)
            .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
        const seg = activeSegments[0];
        if (!seg) {
            this.client.setRevertedSegment(undefined);
            return;
        }
        const memberMsgIds = Array.isArray(seg.memberMsgIds)
            ? seg.memberMsgIds.filter((id) => typeof id === 'string' && id.startsWith('msg_'))
            : [];
        const startMessageId = seg.anchorMsgId || memberMsgIds[0] || '';
        const endMessageId = seg.endMsgId || memberMsgIds[memberMsgIds.length - 1] || startMessageId;
        const startMessageIndex = this.client.getMessageIndex(startMessageId);
        const endMessageIndex = this.client.getMessageIndex(endMessageId);
        this.client.setRevertedSegment({
            isActive: true,
            discarded: false,
            startMessageId,
            startMessageIndex: typeof startMessageIndex === 'number' ? startMessageIndex : 0,
            endMessageId,
            endMessageIndex: typeof endMessageIndex === 'number' ? endMessageIndex : (typeof startMessageIndex === 'number' ? startMessageIndex : 0),
            opIds: [],
            collapsed: true,
            conflicts: [],
            messageIds: memberMsgIds
        });
    }

    private clearClientRevertedSegmentIfNonRestorable(sessionId: string): void {
        const startMessageId = this.client.getRevertedSegment()?.startMessageId;
        if (!startMessageId) return;

        const noticeKey = `system:undo:${startMessageId}`;
        const stored = this.undoSegmentsBySession.get(sessionId)?.get(noticeKey);
        if (stored?.restoreAllowed === false) {
            this.client.setRevertedSegment(undefined);
            this.uiDebugChannel.appendLine(`[EXT][UNDO_SEGMENT] cleared non-restorable revertedSegment sessionId=${sessionId} noticeKey=${noticeKey}`);
        }
    }

    private transitionSubagentState(sessionId: string, entry: { state?: SubagentLifecycleState; isDone?: boolean; finalReason?: string; lastEventAt?: number }, to: SubagentLifecycleState, reason: string): void {
        const from = entry.state || (entry.isDone ? 'done' : 'queued');
        if (from === to) return;
        if (this.isTerminalSubagentState(from) && !this.isTerminalSubagentState(to)) {
            this.task1FalseDoneEvents += 1;
            this.uiDebugChannel.appendLine(`[SidebarProvider] subagent.state.blocked: ${sessionId} ${from} -> ${to} reason=${reason}`);
            return;
        }
        entry.state = to;
        entry.isDone = to === 'done';
        entry.finalReason = reason;
        entry.lastEventAt = Date.now();
        if (to === 'done') {
            (entry as any).latestText = 'Task done.';
            (entry as any).latestTool = '';
            (entry as any).latestToolInput = '';
        }
        this.uiDebugChannel.appendLine(
            `[SidebarProvider] state.transition from=${from} to=${to} reason=${reason} messageId=${(entry as any).finalMessageId || 'null'} parentId=${(entry as any).parentSessionId || 'null'} lane=subagent sessionId=${sessionId}`
        );
        this.emitSubagentStateDelta(sessionId, from, to, reason, entry);
    }

    private removeSubagentSession(sessionId: string): void {
        this.activeSubagentSessionIds.delete(sessionId);
        this.subagentProgressBySession.delete(sessionId);
        this.emitSubagentStatus();
    }

    private emitSubagentStatus(active?: boolean): void {
        const liveWebview = this._view?.webview;
        if (!liveWebview) return;
        const agents = Array.from(this.subagentProgressBySession.values()).map(entry => ({
            sessionId: entry.taskId,
            parentSessionId: entry.parentSessionId,
            description: entry.description,
            mode: entry.mode || '',
            startedAt: entry.startedAt,
            title: this.cleanSubagentTitle(entry.title) || '',
            model: entry.model || '',
            providerId: entry.providerId || '',
            latestText: entry.latestText || '',
            latestTool: entry.latestTool || '',
            latestToolInput: entry.latestToolInput || '',
            state: entry.state || (entry.isDone ? 'done' : 'running'),
            isDone: (entry.state || (entry.isDone ? 'done' : 'running')) === 'done'
        }));
        const runningCount = agents.filter((a: any) => a.state === 'running').length;
        const finalizingCount = agents.filter((a: any) => a.state === 'finalizing').length;
        const doneJustNowCount = agents.filter((a: any) => a.state === 'done').length;
        const isActive = active !== undefined ? active : (runningCount + finalizingCount) > 0;
        liveWebview.postMessage({ type: 'subagentStatus', active: isActive, agents, count: agents.length, runningCount, finalizingCount, doneJustNowCount, sessionId: this.currentSessionId });
    }
    private scheduleSubagentRetentionSweep(): void {
        if (this.subagentRetentionTimer) {
            clearTimeout(this.subagentRetentionTimer);
            this.subagentRetentionTimer = undefined;
        }
        const now = Date.now();
        let nextExpiry = Number.POSITIVE_INFINITY;
        for (const entry of this.subagentProgressBySession.values()) {
            if (typeof entry.dismissAt === 'number' && entry.dismissAt > now) {
                nextExpiry = Math.min(nextExpiry, entry.dismissAt);
            }
        }
        if (!Number.isFinite(nextExpiry)) return;
        this.subagentRetentionTimer = setTimeout(() => {
            this.clearSubagentSessions();
            this.emitSubagentStatus();
            this.scheduleSubagentRetentionSweep();
        }, Math.max(100, nextExpiry - now));
    }

    private emitSubagentStateDelta(sessionId: string, from: string, to: string, reason: string, entry: any): void {
        const liveWebview = this._view?.webview;
        if (!liveWebview || from === to) return;
        liveWebview.postMessage({
            type: 'subagentStateDelta',
            sessionId: this.currentSessionId,
            parentSessionId: entry?.parentSessionId || this.currentSessionId,
            agentSessionId: sessionId,
            from,
            to,
            reason,
            ts: Date.now(),
            payload: {
                finalMessageId: entry?.finalMessageId || '',
                finalReason: entry?.finalReason || ''
            }
        });
    }

    private markAllSubagentsTerminal(kind: 'done' | 'failed' | 'cancelled', reason: string): void {
        const now = Date.now();
        for (const [sessionId, entry] of this.subagentProgressBySession.entries()) {
            const st = entry.state || (entry.isDone ? 'done' : 'running');
            if (st === 'running' || st === 'finalizing' || st === 'queued') {
                this.transitionSubagentState(sessionId, entry, kind, reason);
                entry.finishedAt = now;
                entry.dismissAt = now + this.subagentDoneRetentionMs;
                this.scheduleSubagentRetentionSweep();
            }
        }
    }

    private emitTurnFinalizePhase(webview: vscode.Webview, sessionId: string | undefined, phase: 'stream_done' | 'commit_done' | 'upgrade_done' | 'finalize_done'): void {
        webview.postMessage({ type: 'turnFinalizePhase', sessionId, phase, ts: Date.now() });
    }

    private async finalizeResolvedTurn(sessionId: string | undefined, webview: vscode.Webview, assistantMsgId?: string): Promise<void> {
        if (!sessionId) return;
        const doneAssistantMsgId = assistantMsgId || this.client.getTurnAssistantMsgId(sessionId) || undefined;
        webview.postMessage({
            type: 'chatDone',
            sessionId,
            assistantMsgId: doneAssistantMsgId,
            lastAssistantMsgId: doneAssistantMsgId
        });
        this.emitTurnFinalizePhase(webview, sessionId, 'stream_done');
        this.postMessageIndexMap(webview);
        await this.client.commitPendingTurnChanges(sessionId);
        if (doneAssistantMsgId) {
            await this.client.finalizeTurnBindingFromResolvedAssistant(sessionId, doneAssistantMsgId);
        }
        this.emitTurnFinalizePhase(webview, sessionId, 'commit_done');
        await this.resolvePendingUserUpgrade(sessionId, webview);
        this.emitTurnFinalizePhase(webview, sessionId, 'upgrade_done');
        if (doneAssistantMsgId) {
            await this.client.promoteContinuationOwner(sessionId, doneAssistantMsgId);
            await this.client.consolidateCurrentContinuationOwner(sessionId);
        }
        this.postMessageIndexMap(webview);
        await this.emitDiffFileListWithRetry(sessionId, webview);
        this.sendInFlightBySession.delete(sessionId);
        webview.postMessage({ type: 'turnInFlight', sessionId, inFlight: false });
        this.client.finishTurn(sessionId);
        this.emitTurnFinalizePhase(webview, sessionId, 'finalize_done');
    }

    private selectedModel?: string;
    private selectedVariant?: string;
    private selectedMode?: string;
    private availableModes: string[] = ['plan', 'build'];
    private pendingClientMessageId?: string;
    private lastDraft?: { text: string; attachments: string[]; model?: string; variant?: string; mode?: string };
    private draftByLocalKey = new Map<string, { text: string; attachments: string[]; model?: string; variant?: string; mode?: string }>();
    private currentDiffFilePath: string | null = null;
    private diffHashes = new Map<string, { before: string; after: string }>();
    private shownDiffKeysBySession = new Map<string, Set<string>>();
    private postFinalWatchDiffFocusedBySession = new Set<string>();
    private revertedSegment?: { conflicts: ConflictDetail[]; discarded?: boolean };
    private clientMessageIdMap = new Map<string, string>();
    private revertedSegmentHistory: Array<{ isActive: boolean; discarded: boolean; startMessageId?: string; startMessageIndex?: number; endMessageId?: string; endMessageIndex?: number; collapsed: boolean; messageIds?: string[] }> = [];
    private pendingConflict?: { kind: 'undo' | 'restore' | 'restoreSegment'; startMessageId?: string; endMessageId?: string; operationId?: string; noticeKey?: string };
    private uiDebugChannel!: vscode.OutputChannel;
    private undoSegmentsBySession: Map<string, Map<string, SegmentState>> = new Map();
    private readonly UNDO_SEGMENTS_KEY = 'opencode.undoSegmentsBySession.v1';
    private readonly USER_OWNED_SESSIONS_KEY = 'opencode.userOwnedSessionIds.v1';
    private pendingAssistantTmpKeyBySession = new Map<string, string>();
    private pendingAssistantTmpKeyByLocalKey = new Map<string, string>();
    private pendingLocalKeyBySession = new Map<string, string>();
    private rawUserTextByLocalKey = new Map<string, string>();
    private rawUserTextByMsgId = new Map<string, string>();
    private pendingAssistantMessageIdBySession = new Map<string, string>();
    private pendingLocalQuestionRequests = new Map<string, LocalQuestionRequest>();
    private sendInFlightBySession = new Set<string>();
    private gitUndoEnabled = false;
    private gitUndoReason?: string;
    private pendingBaselineTurnKey?: string;
    private baselineReady = true;
    private pendingBaselineFailed = false;
    private serverStatus: 'connected' | 'reconnecting' | 'error' = 'connected';
    private readonly repoManager: GitRepoManager;
    private uiTimelineBySession = new Map<string, string[]>();
    private lastSnapshotPayloadBySession = new Map<string, any>();
    private lastEmittedChangeListHeadBySession = new Map<string, string>();
    private assistantTextBufferBySession = new Map<string, string>();
    private attachmentCleanupTimer?: NodeJS.Timeout;
    private attachmentCleanupInFlight = false;
    private lastKnownModels: ModelInfo[] = [];
    private modelQuotaInFlight?: Promise<void>;
    private workspaceSwitchInFlight = false;
    private currentWorkspaceKey = '';
    private initPosted = false;
    private sessionSelectionEpoch = 0;
    private readonly recentSessionLoadLimit = 200;

    private async ensureDir(dir: string): Promise<void> {
        await fs.promises.mkdir(dir, { recursive: true });
    }

    private normalizeWorkspaceRoot(root: string): string {
        const resolved = pathModule.resolve(root);
        if (process.platform === 'win32') {
            return resolved.toLowerCase();
        }
        return resolved;
    }

    private getWorkspaceKeyForRoot(root: string): string {
        const normalized = this.normalizeWorkspaceRoot(root);
        return crypto.createHash('sha1').update(normalized).digest('hex');
    }


    private getWorkspaceKey(): string {
        return this.currentWorkspaceKey || 'no-workspace';
    }

    private getSessionCwd(info: any): string | undefined {
        const cwd = info?.path?.cwd ?? info?.cwd;
        if (typeof cwd !== 'string' || !cwd) return undefined;
        return cwd;
    }

    private async getSessionWorkspaceMatch(
        sessionId: string,
        workspaceRoot: string,
        cwdHint?: string
    ): Promise<'match' | 'mismatch' | 'unknown'> {
        try {
            let sessionCwd = typeof cwdHint === 'string' && cwdHint ? cwdHint : undefined;
            if (!sessionCwd) {
                const info = await this.client.getSessionInfo(sessionId);
                sessionCwd = this.getSessionCwd(info);
            }
            if (!sessionCwd) {
                this.uiDebugChannel.appendLine(`[EXT][SESSION_FILTER_SKIP] sessionId=${sessionId} reason=missing-cwd`);
                return 'unknown';
            }
            const expected = this.normalizeWorkspaceRoot(workspaceRoot);
            const actual = this.normalizeWorkspaceRoot(sessionCwd);
            const matched = expected === actual;
            this.uiDebugChannel.appendLine(
                `[EXT][SESSION_FILTER] sessionId=${sessionId} workspace=${workspaceRoot} sessionCwd=${sessionCwd} matched=${String(matched)}`
            );
            return matched ? 'match' : 'mismatch';
        } catch (error) {
            this.uiDebugChannel.appendLine(`[EXT][SESSION_FILTER_ERR] sessionId=${sessionId} err=${String(error)}`);
            return 'unknown';
        }
    }

    private async sessionMatchesWorkspace(sessionId: string, workspaceRoot: string): Promise<boolean> {
        return (await this.getSessionWorkspaceMatch(sessionId, workspaceRoot)) === 'match';
    }

    private async findMostRecentWorkspaceSession(
        sessions: SessionInfo[],
        workspaceRoot: string,
        maxChecks = 20
    ): Promise<SessionInfo | undefined> {
        const checks = Math.min(Math.max(maxChecks, 1), sessions.length);
        for (let i = 0; i < checks; i++) {
            const candidate = sessions[i];
            if (!candidate?.id) continue;
            const matched = await this.sessionMatchesWorkspace(candidate.id, workspaceRoot);
            if (matched) {
                return candidate;
            }
        }
        return undefined;
    }

    private async filterSessionsForWorkspace(
        sessions: SessionInfo[],
        workspaceRoot: string | undefined,
        reason: string
    ): Promise<SessionInfo[]> {
        if (!workspaceRoot) {
            const userOwnedSessions = sessions.filter(s => this.isUserOwnedSession(s.id));
            this.uiDebugChannel.appendLine(
                `[EXT][SESSION_LIST_FILTER] reason=${reason} workspace=null total=${sessions.length} userOwned=${userOwnedSessions.length} matched=${userOwnedSessions.length}`
            );
            return userOwnedSessions;
        }

        const filtered: SessionInfo[] = [];
        let matched = 0;
        let mismatch = 0;
        let unknownIncluded = 0;
        let unknownExcluded = 0;
        let userOwned = 0;
        for (const session of sessions) {
            const isUserOwned = this.isUserOwnedSession(session.id);
            if (isUserOwned) {
                userOwned++;
            }
            const match = await this.getSessionWorkspaceMatch(session.id, workspaceRoot, session.cwd);
            if (match === 'match') {
                filtered.push(session);
                matched++;
            } else if (match === 'mismatch') {
                mismatch++;
            } else {
                const hasWorkspaceSnapshot = fs.existsSync(this.getSnapshotFile(session.id));
                if (hasWorkspaceSnapshot) {
                    filtered.push(session);
                    unknownIncluded++;
                } else {
                    unknownExcluded++;
                }
            }
        }
        this.uiDebugChannel.appendLine(
            `[EXT][SESSION_LIST_FILTER] reason=${reason} workspace=${workspaceRoot} total=${sessions.length} userOwned=${userOwned} included=${filtered.length} matched=${matched} mismatch=${mismatch} unknownIncluded=${unknownIncluded} unknownExcluded=${unknownExcluded}`
        );
        return filtered;
    }

    private getSnapshotDir(): string {
        const workspaceRoot = this.getWorkspaceRootPath();
        return pathModule.join(workspaceRoot, '.opencode', 'sessionSnapshots');
    }

    private getOpencodeDataDir(): string {
        const workspaceRoot = this.getWorkspaceRootPath();
        return pathModule.join(workspaceRoot, '.opencode');
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

    private getChangeListDir(): string {
        return pathModule.join(this.getOpencodeDataDir(), 'sessionChangeLists');
    }

    private getCanceledTurnsDir(): string {
        return pathModule.join(this.getOpencodeDataDir(), 'sessionCanceledTurns');
    }

    private getLegacyWorkspaceDataDir(kind: 'sessionChangeLists' | 'sessionCanceledTurns' | 'revertedSegments'): string {
        const workspaceRoot = this.getWorkspaceRootPath();
        const workspaceKey = this.getWorkspaceKeyForRoot(workspaceRoot);
        return pathModule.join(this._context.globalStoragePath, kind, workspaceKey);
    }

    private getLegacyChangeListPath(sessionId: string): string {
        return pathModule.join(this.getLegacyWorkspaceDataDir('sessionChangeLists'), `${sessionId}.json`);
    }

    private getLegacyCanceledTurnsPath(sessionId: string): string {
        return pathModule.join(this.getLegacyWorkspaceDataDir('sessionCanceledTurns'), `${sessionId}.json`);
    }

    private getChangeListPath(sessionId: string): string {
        return pathModule.join(this.getChangeListDir(), `${sessionId}.json`);
    }

    private getCanceledTurnsPath(sessionId: string): string {
        return pathModule.join(this.getCanceledTurnsDir(), `${sessionId}.json`);
    }

    private async readChangeLists(sessionId: string): Promise<ChangeListRecord[]> {
        const filePath = this.getChangeListPath(sessionId);
        if (!fs.existsSync(filePath)) {
            const legacyPath = this.getLegacyChangeListPath(sessionId);
            if (fs.existsSync(legacyPath)) {
                try {
                    const text = await fs.promises.readFile(legacyPath, 'utf-8');
                    const parsed = JSON.parse(text);
                    const records = Array.isArray(parsed) ? parsed : [];
                    if (records.length > 0) {
                        await this.writeChangeLists(sessionId, records);
                        this.uiDebugChannel.appendLine(
                            `[EXT][CHANGELIST_MIGRATED] sessionId=${sessionId} from=${legacyPath} to=${filePath} records=${records.length}`
                        );
                    }
                    return records;
                } catch {
                    return [];
                }
            }
            return [];
        }
        try {
            const text = await fs.promises.readFile(filePath, 'utf-8');
            const parsed = JSON.parse(text);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    private async readCanceledTurns(sessionId: string): Promise<CanceledTurnRecord[]> {
        const filePath = this.getCanceledTurnsPath(sessionId);
        if (!fs.existsSync(filePath)) {
            const legacyPath = this.getLegacyCanceledTurnsPath(sessionId);
            if (fs.existsSync(legacyPath)) {
                try {
                    const text = await fs.promises.readFile(legacyPath, 'utf-8');
                    const parsed = JSON.parse(text);
                    const records = Array.isArray(parsed) ? parsed : [];
                    if (records.length > 0) {
                        await this.writeCanceledTurns(sessionId, records);
                        this.uiDebugChannel.appendLine(
                            `[EXT][CANCELED_TURNS_MIGRATED] sessionId=${sessionId} from=${legacyPath} to=${filePath} records=${records.length}`
                        );
                    }
                    return records;
                } catch {
                    return [];
                }
            }
            return [];
        }
        try {
            const text = await fs.promises.readFile(filePath, 'utf-8');
            const parsed = JSON.parse(text);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }

    private async writeChangeLists(sessionId: string, records: ChangeListRecord[]): Promise<void> {
        const dir = this.getChangeListDir();
        await this.ensureDir(dir);
        const filePath = this.getChangeListPath(sessionId);
        const tmpPath = `${filePath}.tmp`;
        const text = JSON.stringify(records, null, 2);
        let lastError: unknown;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                await fs.promises.writeFile(tmpPath, text, 'utf-8');
                await fs.promises.rename(tmpPath, filePath);
                if (!fs.existsSync(filePath)) {
                    throw new Error(`change-list file missing after rename (attempt=${attempt})`);
                }
                this.uiDebugChannel.appendLine(
                    `[EXT][CHANGELIST_WRITE_OK] sessionId=${sessionId} file=${filePath} records=${records.length} bytes=${Buffer.byteLength(text, 'utf-8')} attempt=${attempt}`
                );
                return;
            } catch (error) {
                lastError = error;
                this.uiDebugChannel.appendLine(
                    `[EXT][CHANGELIST_WRITE_FAIL] sessionId=${sessionId} file=${filePath} attempt=${attempt} err=${String(error)}`
                );
                try {
                    if (fs.existsSync(tmpPath)) {
                        await fs.promises.unlink(tmpPath);
                    }
                } catch {
                    // Best effort tmp cleanup.
                }
            }
        }
        throw (lastError instanceof Error ? lastError : new Error(String(lastError)));
    }

    private async writeCanceledTurns(sessionId: string, records: CanceledTurnRecord[]): Promise<void> {
        const dir = this.getCanceledTurnsDir();
        await this.ensureDir(dir);
        const filePath = this.getCanceledTurnsPath(sessionId);
        const tmpPath = `${filePath}.tmp`;
        const text = JSON.stringify(records, null, 2);
        await fs.promises.writeFile(tmpPath, text, 'utf-8');
        await fs.promises.rename(tmpPath, filePath);
    }

    private async readPersistedSessionMap(sessionId: string): Promise<SessionMap | null> {
        try {
            const repo = await this.resolveInternalRepo(sessionId);
            if (!repo) return null;
            const mapPath = pathModule.join(this.getOpencodeDataDir(), 'git', 'sessions', sessionId, 'map.json');
            if (!fs.existsSync(mapPath)) return null;
            const raw = await fs.promises.readFile(mapPath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (!parsed || parsed.schemaVersion !== 1) return null;
            return parsed as SessionMap;
        } catch {
            return null;
        }
    }

    private async resolveCurrentVisibleOwnerMessageId(sessionId: string, fallbackMessageId?: string): Promise<string | undefined> {
        if (fallbackMessageId?.startsWith('msg_user_') || fallbackMessageId?.startsWith('msg_system_')) {
            return fallbackMessageId;
        }
        const map = await this.readPersistedSessionMap(sessionId);
        const resolved = resolveCurrentVisibleOwnerMsgId(map, fallbackMessageId || null);
        return typeof resolved === 'string' ? resolved : fallbackMessageId;
    }

    private canonicalizeSnapshotMessagesForCurrentOwner(
        sessionId: string,
        messages: SessionMessage[] | undefined,
        map: SessionMap | null
    ): SessionMessage[] {
        if (!Array.isArray(messages) || messages.length === 0) return [];
        const out: SessionMessage[] = [];
        const seenIds = new Set<string>();
        for (const message of messages) {
            if (!message || typeof message.id !== 'string' || !message.id) continue;
            const role = message.role;
            const resolvedMessageId = resolveCurrentVisibleOwnerMsgId(map, message.id) || message.id;
            if (role === 'assistant' && resolvedMessageId !== message.id) {
                continue;
            }
            const nextMessage: SessionMessage = { ...message };
            if (role === 'user' && nextMessage.meta && typeof nextMessage.meta === 'object') {
                const currentAssistantId = typeof nextMessage.meta.assistantId === 'string'
                    ? nextMessage.meta.assistantId
                    : undefined;
                if (currentAssistantId) {
                    const resolvedAssistantId = resolveCurrentVisibleOwnerMsgId(map, currentAssistantId) || currentAssistantId;
                    if (resolvedAssistantId !== currentAssistantId) {
                        nextMessage.meta = {
                            ...nextMessage.meta,
                            assistantId: resolvedAssistantId
                        };
                    }
                }
            }
            const nextMessageId = typeof nextMessage.id === 'string' ? nextMessage.id : '';
            if (!nextMessageId || seenIds.has(nextMessageId)) continue;
            seenIds.add(nextMessageId);
            out.push(nextMessage);
        }
        return out;
    }

    private async collapseOwnerChangeLists(
        sessionId: string,
        records: ChangeListRecord[],
        anchorMessageId: string,
        preferredRecord: ChangeListRecord
    ): Promise<ChangeListRecord[]> {
        const map = await this.readPersistedSessionMap(sessionId);
        const ownership = resolveSessionOwnership(map, anchorMessageId);
        const currentOwnerMsgId = ownership.currentOwnerMsgId;
        const predecessorOwnerMsgId = ownership.predecessorOwnerMsgId;
        const currentOwnerIsContinuation = Array.isArray(map?.entries)
            && !!currentOwnerMsgId
            && map.entries.some((entry) => {
                const entryOwner = entry.finalAssistantMsgId || entry.assistantMsgId;
                return entryOwner === currentOwnerMsgId
                    && typeof entry.turnKey === 'string'
                    && entry.turnKey.startsWith('cont:');
            });
        this.uiDebugChannel.appendLine(
            `[EXT][CHANGELIST_OWNER_COLLAPSE_INSPECT] sessionId=${sessionId} anchor=${anchorMessageId} currentOwner=${currentOwnerMsgId || 'null'} predecessor=${predecessorOwnerMsgId || 'null'} isContinuation=${currentOwnerIsContinuation}`
        );
        if (!currentOwnerIsContinuation || !currentOwnerMsgId || !predecessorOwnerMsgId || anchorMessageId !== currentOwnerMsgId) {
            this.uiDebugChannel.appendLine(
                `[EXT][CHANGELIST_OWNER_COLLAPSE_SKIP] sessionId=${sessionId} anchor=${anchorMessageId} currentOwner=${currentOwnerMsgId || 'null'} predecessor=${predecessorOwnerMsgId || 'null'} reason=preconditions`
            );
            return records;
        }

        const mergeCandidates: ChangeListRecord[] = [];
        const survivors: ChangeListRecord[] = [];
        for (const record of records) {
            const resolvedAnchor = await this.resolveCurrentVisibleOwnerMessageId(sessionId, record.anchorMessageId);
            if (resolvedAnchor === currentOwnerMsgId) {
                mergeCandidates.push(record);
            } else {
                survivors.push(record);
            }
        }
        if (!mergeCandidates.length) {
            this.uiDebugChannel.appendLine(
                `[EXT][CHANGELIST_OWNER_COLLAPSE_SKIP] sessionId=${sessionId} anchor=${anchorMessageId} currentOwner=${currentOwnerMsgId} predecessor=${predecessorOwnerMsgId} reason=no-merge-candidates`
            );
            return records;
        }

        mergeCandidates.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        const mergedFiles = Array.from(new Set(
            mergeCandidates.flatMap((record) => Array.isArray(record.files) ? record.files : [])
        ));
        const mergedStatsByPath = mergeCandidates.reduce<Record<string, { additions: number | null; deletions: number | null }>>(
            (acc, record) => ({ ...acc, ...(record.statsByPath || {}) }),
            {}
        );
        const earliest = mergeCandidates[0];
        const mergedRecord: ChangeListRecord = {
            id: preferredRecord.id,
            commitHead: preferredRecord.commitHead,
            commitBase: earliest?.commitBase || preferredRecord.commitBase,
            files: mergedFiles,
            statsByPath: mergedStatsByPath,
            anchorMessageId: currentOwnerMsgId,
            createdAt: earliest?.createdAt || preferredRecord.createdAt,
            reverted: mergeCandidates.every((record) => record.reverted === true) ? true : undefined,
        };
        survivors.push(mergedRecord);
        survivors.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        this.uiDebugChannel.appendLine(
            `[EXT][CHANGELIST_OWNER_COLLAPSE] sessionId=${sessionId} owner=${currentOwnerMsgId} predecessor=${predecessorOwnerMsgId} merged=${mergeCandidates.length} resultId=${mergedRecord.id}`
        );
        return survivors;
    }

    private async upsertChangeList(sessionId: string, record: ChangeListRecord): Promise<void> {
        const resolvedAnchorMessageId = await this.resolveCurrentVisibleOwnerMessageId(sessionId, record.anchorMessageId);
        const nextRecord = {
            ...record,
            anchorMessageId: resolvedAnchorMessageId || record.anchorMessageId
        };
        const records = await this.readChangeLists(sessionId);
        const idx = records.findIndex((item) => item.id === nextRecord.id);
        if (idx === -1) {
            records.push(nextRecord);
        } else {
            const existing = records[idx];
            const existingResolvedAnchorMessageId = await this.resolveCurrentVisibleOwnerMessageId(sessionId, existing.anchorMessageId);
            records[idx] = {
                ...existing,
                ...nextRecord,
                anchorMessageId: nextRecord.anchorMessageId || existingResolvedAnchorMessageId || existing.anchorMessageId
            };
        }
        const collapsedRecords = await this.collapseOwnerChangeLists(
            sessionId,
            records,
            nextRecord.anchorMessageId,
            nextRecord
        );
        await this.writeChangeLists(sessionId, collapsedRecords);
        const persisted = await this.readChangeLists(sessionId);
        const persistedHit = persisted.some((item) => item.id === nextRecord.id);
        this.uiDebugChannel.appendLine(
            `[EXT][CHANGELIST_UPSERT] sessionId=${sessionId} id=${nextRecord.id} commitHead=${nextRecord.commitHead} persisted=${persistedHit} total=${persisted.length}`
        );
    }

    private async upsertCanceledTurn(sessionId: string, record: CanceledTurnRecord): Promise<void> {
        const records = await this.readCanceledTurns(sessionId);
        const key = record.opId || record.localKey;
        const idx = key ? records.findIndex((item) => (item.opId || item.localKey) === key) : -1;
        if (idx === -1) {
            records.push(record);
        } else {
            records[idx] = { ...records[idx], ...record };
        }
        await this.writeCanceledTurns(sessionId, records);
    }

    private async setChangeListReverted(sessionId: string, commitHead: string, reverted: boolean, webview: vscode.Webview): Promise<void> {
        if (!sessionId || !commitHead) return;
        const records = await this.readChangeLists(sessionId);
        let updated = false;
        for (const record of records) {
            if (record.commitHead === commitHead) {
                if (record.reverted !== reverted) {
                    record.reverted = reverted;
                    updated = true;
                }
            }
        }
        if (updated) {
            await this.writeChangeLists(sessionId, records);
        }
        webview.postMessage({ type: 'changeListUpdate', sessionId, commitHead, reverted });
    }

    private async resolveChangeListCommits(
        sessionId: string,
        messageIds: string[] | undefined,
        fallbackCommits: string[]
    ): Promise<string[]> {
        const fromMessages = await this.client.getCommitHashesForMessageIds(sessionId, messageIds || []);
        const merged = [...fromMessages, ...fallbackCommits].filter(Boolean);
        return Array.from(new Set(merged));
    }

    private async injectChangeLists(sessionId: string, formatted: { title: string; messages: SessionMessage[] }): Promise<{ title: string; messages: SessionMessage[] }> {
        if (!sessionId) return formatted;
        const canceled = await this.readCanceledTurns(sessionId);
        const canceledUserIds = new Set(canceled.map((item) => item.userMsgId).filter((id): id is string => typeof id === 'string' && id.length > 0));
        const canceledAssistantIds = new Set(canceled.map((item) => item.assistantMsgId).filter((id): id is string => typeof id === 'string' && id.length > 0));
        const filteredMessages = (formatted.messages || []).filter((message) => {
            if (!message?.id) return true;
            if (canceledUserIds.has(message.id) || canceledAssistantIds.has(message.id)) return false;
            const meta = message.meta as { assistantId?: string; parentID?: string } | undefined;
            if (meta?.assistantId && canceledAssistantIds.has(meta.assistantId)) return false;
            if (meta?.parentID && canceledUserIds.has(meta.parentID)) return false;
            return true;
        });
        formatted = { ...formatted, messages: this.normalizeDisplayMessagesForSnapshot(filteredMessages) };
        const records = await this.readChangeLists(sessionId);
        if (!records.length) return formatted;

        const messages = formatted.messages || [];
        const idSet = new Set(messages.map((m) => m.id).filter((id): id is string => typeof id === 'string'));
        const byAnchor = new Map<string, ChangeListRecord[]>();
        const byId = new Map<string, ChangeListRecord>();
        for (const record of records) {
            const resolvedAnchor = await this.resolveCurrentVisibleOwnerMessageId(sessionId, record.anchorMessageId) || record.anchorMessageId;
            const effectiveRecord = resolvedAnchor !== record.anchorMessageId
                ? { ...record, anchorMessageId: resolvedAnchor }
                : record;
            if (effectiveRecord.id) {
                byId.set(effectiveRecord.id, effectiveRecord);
            }
            if (!effectiveRecord.anchorMessageId || !idSet.has(effectiveRecord.anchorMessageId)) {
                continue;
            }
            if (!byAnchor.has(effectiveRecord.anchorMessageId)) {
                byAnchor.set(effectiveRecord.anchorMessageId, []);
            }
            byAnchor.get(effectiveRecord.anchorMessageId)?.push(effectiveRecord);
        }
        if (!byAnchor.size) return formatted;

        for (const list of byAnchor.values()) {
            list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        }

        const merged: SessionMessage[] = [];
        const seenIds = new Set<string>();
        for (const message of messages) {
            let nextMessage = message;
            if (message?.id) {
                const bound = byId.get(message.id);
                if (bound) {
                    nextMessage = {
                        ...message,
                        role: 'system',
                        text: '',
                        meta: {
                            ...(message.meta || {}),
                            kind: 'changeList',
                            files: bound.files,
                            source: 'git',
                            scope: 'turn',
                            commitHead: bound.commitHead,
                            commitBase: bound.commitBase,
                            reverted: bound.reverted === true,
                            statsByPath: bound.statsByPath || {}
                        }
                    };
                }
            }
            if (message.id && seenIds.has(message.id)) {
                continue;
            }
            if (message.id) {
                seenIds.add(message.id);
            }
            merged.push(nextMessage);
            if (!message.id) continue;
            const list = byAnchor.get(message.id);
            if (!list || !list.length) continue;
            for (const record of list) {
                if (seenIds.has(record.id)) continue;
                merged.push({
                    role: 'system',
                    id: record.id,
                    text: '',
                    meta: {
                        kind: 'changeList',
                        files: record.files,
                        source: 'git',
                        scope: 'turn',
                        commitHead: record.commitHead,
                        commitBase: record.commitBase,
                        reverted: record.reverted === true,
                        statsByPath: record.statsByPath || {}
                    }
                });
                seenIds.add(record.id);
            }
        }

        return { ...formatted, messages: this.normalizeDisplayMessagesForSnapshot(merged) };
    }

    private collectSegmentVisibleMemberMessageIds(segments: any[] | undefined): Set<string> {
        const memberIds = new Set<string>();
        for (const segment of Array.isArray(segments) ? segments : []) {
            const ids = Array.isArray(segment?.memberMsgIds) ? segment.memberMsgIds : [];
            for (const id of ids) {
                if (typeof id === 'string' && id.startsWith('msg_')) {
                    memberIds.add(id);
                }
            }
        }
        return memberIds;
    }

    private collectVisibleSnapshotMessages(messages: SessionMessage[] | undefined): SessionMessage[] {
        const visibleMessages: SessionMessage[] = [];
        for (const message of Array.isArray(messages) ? messages : []) {
            if (!message || typeof message.id !== 'string' || !message.id) continue;
            const text = typeof message.text === 'string' ? message.text : '';
            if (message.role === 'user') {
                const visibleText = this.normalizeUserTextForSnapshot(text);
                if (!visibleText.trim()) continue;
                if (this.isHiddenControlUserText(visibleText)) continue;
            }
            if (message.role === 'assistant' && this.isHiddenControlAssistantText(text)) continue;
            visibleMessages.push(message);
        }
        return visibleMessages;
    }

    private computeRecentVisibleAppend(snapshotTimelineIdSet: Set<string>, recentFormattedMessages: SessionMessage[]): string[] {
        const newIds: string[] = [];
        const seenNewIds = new Set<string>();
        for (const message of Array.isArray(recentFormattedMessages) ? recentFormattedMessages : []) {
            if (!message || typeof message.id !== 'string' || !message.id) continue;
            const id = message.id;
            if (snapshotTimelineIdSet.has(id)) continue;       // already in snapshot
            if (seenNewIds.has(id)) continue;                   // internal dedup
            const text = typeof message.text === 'string' ? message.text : '';
            if (message.role === 'user') {
                const visibleText = this.normalizeUserTextForSnapshot(text);
                if (!visibleText.trim()) continue;
                if (this.isHiddenControlUserText(visibleText)) continue;
            }
            if (message.role === 'assistant' && this.isHiddenControlAssistantText(text)) continue;
            newIds.push(id);
            seenNewIds.add(id);
        }
        return newIds;
    }

    private getMaxMessageIndex(messages: SessionMessage[]): number | null {
        let maxIndex: number | null = null;
        for (const message of Array.isArray(messages) ? messages : []) {
            if (typeof message?.messageIndex !== 'number' || !Number.isFinite(message.messageIndex)) continue;
            maxIndex = maxIndex === null ? message.messageIndex : Math.max(maxIndex, message.messageIndex);
        }
        return maxIndex;
    }

    private computeRecentAppendCandidates(
        snapshotTimelineIdSet: Set<string>,
        snapshotMaxMessageIndex: number | null,
        recentFormattedMessages: SessionMessage[]
    ): SessionMessage[] {
        const out: SessionMessage[] = [];
        const seen = new Set<string>();
        const recentList = Array.isArray(recentFormattedMessages) ? recentFormattedMessages : [];
        let lastSnapshotHitIndex = -1;
        for (let i = 0; i < recentList.length; i++) {
            const id = typeof recentList[i]?.id === 'string' ? recentList[i]!.id : '';
            if (id && snapshotTimelineIdSet.has(id)) {
                lastSnapshotHitIndex = i;
            }
        }
        for (let i = 0; i < recentList.length; i++) {
            if (i <= lastSnapshotHitIndex) continue;
            const message = recentList[i];
            if (!message || typeof message.id !== 'string' || !message.id) continue;
            const id = message.id;
            if (id.startsWith('local-') || id.startsWith('tmp:')) continue;
            if (snapshotTimelineIdSet.has(id)) continue;
            if (seen.has(id)) continue;
            const text = typeof message.text === 'string' ? message.text : '';
            if (message.role === 'user') {
                const visibleText = this.normalizeUserTextForSnapshot(text);
                if (!visibleText.trim()) continue;
                if (this.isHiddenControlUserText(visibleText)) continue;
            }
            if (message.role === 'assistant' && this.isHiddenControlAssistantText(text)) continue;
            if (snapshotMaxMessageIndex !== null && typeof message.messageIndex === 'number' && Number.isFinite(message.messageIndex)) {
                if (message.messageIndex <= snapshotMaxMessageIndex) continue;
            }
            out.push(message);
            seen.add(id);
        }
        return out;
    }

    private enforceUserAssistantPairs(messages: SessionMessage[]): SessionMessage[] {
        const ordered = [...(Array.isArray(messages) ? messages : [])].sort((a, b) => {
            const ai = typeof a?.messageIndex === 'number' ? a.messageIndex : Number.MAX_SAFE_INTEGER;
            const bi = typeof b?.messageIndex === 'number' ? b.messageIndex : Number.MAX_SAFE_INTEGER;
            return ai - bi;
        });
        const paired: SessionMessage[] = [];
        const seen = new Set<string>();
        let pendingUser: SessionMessage | null = null;
        for (const message of ordered) {
            if (!message || typeof message.id !== 'string' || !message.id) continue;
            if (message.role === 'user') {
                pendingUser = message;
                continue;
            }
            if (message.role !== 'assistant') continue;
            if (!pendingUser || typeof pendingUser.id !== 'string' || !pendingUser.id) {
                continue;
            }
            if (!seen.has(pendingUser.id)) {
                paired.push(pendingUser);
                seen.add(pendingUser.id);
            }
            if (!seen.has(message.id)) {
                paired.push(message);
                seen.add(message.id);
            }
            pendingUser = null;
        }
        return paired;
    }

    private async buildSnapshotSessionPayload(
        sessionPayload: { type: string; sessionId: string; title: string; messages: SessionMessage[]; segments?: any[]; meta?: any },
        segmentMemberMessages: SessionMessage[] = []
    ) {
        const sessionId = sessionPayload.sessionId;
        const ownershipMap = await this.readPersistedSessionMap(sessionId);
        const canonicalMessages = this.canonicalizeSnapshotMessagesForCurrentOwner(sessionId, sessionPayload.messages, ownershipMap);
        const canonicalSegmentMessages = this.canonicalizeSnapshotMessagesForCurrentOwner(sessionId, segmentMemberMessages, ownershipMap);
        // Honor pre-provided timelineMessageIds (from reload path) to prevent backing message pollution
        const providedIdsRaw = Array.isArray(sessionPayload.meta?.timelineMessageIds) && sessionPayload.meta.timelineMessageIds.length > 0
            ? (sessionPayload.meta.timelineMessageIds as string[]).filter((id): id is string => typeof id === 'string' && Boolean(id))
            : null;
        let providedIds: string[] | null = null;
        if (providedIdsRaw) {
            const mappedIds = await Promise.all(
                providedIdsRaw.map((id) => this.resolveCurrentVisibleOwnerMessageId(sessionId, id).then((resolved) => resolved || id))
            );
            providedIds = Array.from(new Set(mappedIds));
        }
        const providedIdsSet = providedIds ? new Set(providedIds) : null;
        const timelineMessages = providedIdsSet
            ? canonicalMessages.filter(m => m && typeof m.id === 'string' && providedIdsSet.has(m.id))
            : this.collectVisibleSnapshotMessages(canonicalMessages);
        let timelineIds = providedIds ?? timelineMessages
            .map((message) => (typeof message?.id === 'string' ? message.id : ''))
            .filter((id): id is string => Boolean(id));
        if (!providedIds) {
            const mappedTimelineIds = await Promise.all(
                timelineIds.map((id) => this.resolveCurrentVisibleOwnerMessageId(sessionId, id).then((resolved) => resolved || id))
            );
            timelineIds = Array.from(new Set(mappedTimelineIds));
        }
        const timelineIdsSet = new Set(timelineIds);
        const mergedMessages: SessionMessage[] = [];
        const seenIds = new Set<string>();
        const pushMessage = (message: SessionMessage | null | undefined) => {
            if (!message) return;
            const messageId = typeof message.id === 'string' ? message.id : '';
            if (!messageId || seenIds.has(messageId)) return;
            const text = typeof message.text === 'string' ? message.text : '';
            if (message.role === 'user' && this.isHiddenControlUserText(text)) return;
            if (message.role === 'assistant' && this.isHiddenControlAssistantText(text)) return;
            mergedMessages.push(message);
            seenIds.add(messageId);
        };
        if (providedIds) {
            for (const message of timelineMessages) {
                pushMessage(message);
            }
        } else {
            for (const message of canonicalMessages) {
                if (message && typeof message.id === 'string' && timelineIdsSet.has(message.id)) {
                    pushMessage(message);
                }
            }
        }
        for (const message of canonicalSegmentMessages) {
            pushMessage(message);
        }
        const segmentBackingMessageIds = mergedMessages
            .map((message) => (typeof message?.id === 'string' ? message.id : ''))
            .filter((id): id is string => Boolean(id) && !timelineIds.includes(id));
        return {
            ...sessionPayload,
            messages: mergedMessages,
            meta: {
                ...(sessionPayload.meta || {}),
                timelineMessageIds: timelineIds,
                segmentBackingMessageIds
            }
        };
    }

    private async buildSnapshotSessionPayloadAndCache(
        sessionId: string,
        sessionPayload: { type: string; sessionId: string; title: string; messages: SessionMessage[]; segments?: any[]; meta?: any },
        segmentMemberMessages: SessionMessage[] = []
    ) {
        const payload = await this.buildSnapshotSessionPayload(sessionPayload, segmentMemberMessages);
        this.lastSnapshotPayloadBySession.set(sessionId, payload);
        return payload;
    }

    private normalizeSnapshotStoredMessages(messages: SessionMessage[]): SessionMessage[] {
        const out: SessionMessage[] = [];
        const seen = new Set<string>();
        for (const message of Array.isArray(messages) ? messages : []) {
            if (!message || typeof message.id !== 'string' || !message.id) continue;
            if (seen.has(message.id)) continue;
            const role = message.role === 'user' || message.role === 'assistant' || message.role === 'system'
                ? message.role
                : null;
            if (!role) continue;
            if (role === 'system' && message.meta?.kind !== 'changeList') continue;
            const normalizedMeta = this.normalizeSnapshotMessageMeta(message.meta);
            if (role === 'user' && this.rawUserTextByMsgId.has(message.id)) {
                out.push({ ...message, role, text: this.rawUserTextByMsgId.get(message.id) || '', ...(normalizedMeta ? { meta: normalizedMeta } : {}) });
            } else {
                out.push({ ...message, role, text: typeof message.text === 'string' ? message.text : '', ...(normalizedMeta ? { meta: normalizedMeta } : {}) });
            }
            seen.add(message.id);
        }
        return out;
    }

    private normalizeSnapshotMessageMeta(meta: any): any {
        if (!meta || typeof meta !== 'object') return undefined;
        const out: any = { ...meta };
        if (Array.isArray(meta.images)) {
            const sanitizedImages: string[] = [];
            let redactedCount = 0;
            for (const item of meta.images) {
                if (typeof item !== 'string' || !item) continue;
                if (item.startsWith('data:image/')) {
                    redactedCount++;
                    continue;
                }
                sanitizedImages.push(item);
            }
            if (sanitizedImages.length > 0) {
                out.images = sanitizedImages;
            } else {
                delete out.images;
            }
            if (redactedCount > 0) {
                out.imageCount = Math.max(Number(out.imageCount) || 0, sanitizedImages.length + redactedCount);
                out.imagesRedactedInSnapshot = true;
            }
        }
        return out;
    }

    private async appendSnapshotIncremental(
        sessionId: string,
        timelineIds: string[],
        incomingMessages: SessionMessage[],
        title?: string
    ): Promise<number> {
        const ownershipMap = await this.readPersistedSessionMap(sessionId);
        const canonicalIncomingMessages = this.canonicalizeSnapshotMessagesForCurrentOwner(sessionId, incomingMessages, ownershipMap);
        const canonicalTimelineIds = Array.from(new Set(await Promise.all(
            timelineIds
                .filter((id): id is string => typeof id === 'string' && Boolean(id))
                .map((id) => this.resolveCurrentVisibleOwnerMessageId(sessionId, id).then((resolved) => resolved || id))
        )));
        const existing = await this.readSnapshot(sessionId);
        const snapshotObj = existing?.obj ?? {
            sessionId,
            exportedAt: Date.now(),
            sessionData: {
                type: 'sessionData',
                sessionId,
                title: title || 'Session',
                messages: [] as SessionMessage[],
                segments: [],
                meta: {
                    timelineMessageIds: [] as string[],
                    segmentBackingMessageIds: [] as string[]
                }
            }
        };
        if (!snapshotObj.sessionData) {
            snapshotObj.sessionData = {
                type: 'sessionData',
                sessionId,
                title: title || 'Session',
                messages: [] as SessionMessage[],
                segments: [],
                meta: {
                    timelineMessageIds: [] as string[],
                    segmentBackingMessageIds: [] as string[]
                }
            };
        }
        if (typeof title === 'string' && title.trim()) {
            snapshotObj.sessionData.title = title;
        }
        const existingMessages: SessionMessage[] = Array.isArray(snapshotObj.sessionData.messages)
            ? snapshotObj.sessionData.messages
            : [];
        const canonicalExistingMessages = this.canonicalizeSnapshotMessagesForCurrentOwner(sessionId, existingMessages, ownershipMap);
        const timelineIdSet = new Set(
            canonicalTimelineIds.filter((id): id is string => typeof id === 'string' && Boolean(id))
        );
        const combinedById = new Map<string, SessionMessage>();
        for (const message of this.normalizeSnapshotStoredMessages(canonicalExistingMessages)) {
            if (typeof message.id === 'string' && message.id) {
                combinedById.set(message.id, message);
            }
        }
        for (const message of canonicalIncomingMessages) {
            if (!message || typeof message.id !== 'string' || !message.id) continue;
            if (!timelineIdSet.has(message.id)) continue;
            combinedById.set(message.id, message);
        }
        const nextTimeline = Array.from(timelineIdSet);
        const nextMessages = nextTimeline
            .map((id) => combinedById.get(id))
            .filter((message): message is SessionMessage => Boolean(message));
        snapshotObj.sessionData.messages = this.normalizeSnapshotStoredMessages(nextMessages);
        if (!snapshotObj.sessionData.meta) {
            snapshotObj.sessionData.meta = {};
        }
        snapshotObj.sessionData.meta.timelineMessageIds = nextTimeline;
        snapshotObj.exportedAt = Date.now();
        const bytes = await this.writeSnapshotAtomic(sessionId, snapshotObj);
        this.lastSnapshotPayloadBySession.set(sessionId, snapshotObj.sessionData);
        return bytes;
    }

    private async handleSnapshotTimelineIds(payload: any): Promise<void> {
        if (!payload || !payload.sessionId || !Array.isArray(payload.timelineIds)) {
            this.uiDebugChannel.appendLine('[EXT][SNAPSHOT_TIMELINE] Invalid payload, ignoring');
            return;
        }
        const { sessionId } = payload;
        const payloadTimelineIds = Array.isArray(payload.timelineIds)
            ? payload.timelineIds.filter((id: unknown): id is string => typeof id === 'string' && Boolean(id))
            : [];
        if (sessionId !== this.currentSessionId) {
            this.uiDebugChannel.appendLine(`[EXT][SNAPSHOT_TIMELINE] Session mismatch, ignoring (current=${this.currentSessionId}, received=${sessionId})`);
            return;
        }
        try {
            const incomingMessages = Array.isArray(payload.visibleMessages)
                ? payload.visibleMessages.filter((message: any): message is SessionMessage => {
                    const role = message?.role;
                    return !!message
                        && typeof message.id === 'string'
                        && (role === 'user' || role === 'assistant' || role === 'system');
                })
                : [];
            const canonicalTimelineIds = incomingMessages
                .map((message: SessionMessage) => (typeof message.id === 'string' ? message.id : ''))
                .filter((id: string): id is string => Boolean(id));
            const timelineIds = canonicalTimelineIds.length > 0 ? canonicalTimelineIds : payloadTimelineIds;
            if (timelineIds.some((id: string) => id.startsWith('local-') || id.startsWith('tmp:'))) {
                this.uiDebugChannel.appendLine(
                    `[EXT][SNAPSHOT_SKIP] sessionId=${sessionId} reason=unresolved-local-id first10=${timelineIds.slice(0, 10).join(',')}`
                );
                return;
            }
            this.uiTimelineBySession.set(sessionId, timelineIds);
            this.uiDebugChannel.appendLine(
                `[EXT][SNAPSHOT_TIMELINE] sessionId=${sessionId}, count=${timelineIds.length}, first10=${timelineIds.slice(0, 10).join(',')} source=${canonicalTimelineIds.length > 0 ? 'visibleMessages' : 'payloadTimelineIds'}`
            );
            const incomingTitle = typeof payload.title === 'string' ? payload.title : undefined;
            await this.appendSnapshotIncremental(sessionId, timelineIds, incomingMessages, incomingTitle);
            this.uiDebugChannel.appendLine(
                `[EXT][SNAPSHOT_WRITTEN] sessionId=${sessionId}, timelineCount=${timelineIds.length}, visibleMessages=${incomingMessages.length}`
            );
        } catch (error) {
            this.uiDebugChannel.appendLine(`[EXT][SNAPSHOT_WRITE_ERROR] ${String(error)}`);
        }
    }

    private shouldWriteSnapshot(sessionId: string, reason: string): boolean {
        if (!this.uiTimelineBySession.has(sessionId)) {
            this.uiDebugChannel.appendLine(`[EXT][SNAP_SAVE_SKIP] sessionId=${sessionId} reason=${reason} detail=missing-ui-timeline`);
            return false;
        }
        return true;
    }

    private isHiddenControlAssistantText(text: string): boolean {
        const trimmed = String(text || '').trim();
        const lower = trimmed.toLowerCase();
        return trimmed.includes('All continuation mechanisms have been stopped for this session')
            || trimmed.includes('All continuation mechanisms stopped for this session:')
            || (lower.includes('continuation') && lower.includes('stopped'));
    }

    private isHiddenControlUserText(text: string): boolean {
        const raw = String(text || '');
        const trimmed = raw.trim();
        if (!trimmed) return false;
        if (trimmed.startsWith('[OC_UI_AUTORESUME')) return true;
        if (trimmed === '/stop-continuation') return true;
        if (trimmed.includes('<auto-slash-command>') && trimmed.includes('/stop-continuation Command')) return true;
        if (trimmed.includes('<command-instruction>') && trimmed.toLowerCase().includes('stop all continuation mechanisms')) return true;
        return raw.includes('<!-- OMO_INTERNAL_INITIATOR -->')
            && (
                raw.includes('[SYSTEM DIRECTIVE: OH-MY-OPENCODE - BOULDER CONTINUATION]')
                || raw.includes('[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]')
            );
    }

    private extractLastLine(text: string): string {
        const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        return lines.length ? lines[lines.length - 1] : '';
    }

    private async ensureGitignoreIgnoresOpencode(): Promise<void> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return;
        const gitDir = pathModule.join(workspaceRoot, '.git');
        if (!fs.existsSync(gitDir)) return;
        const gitignorePath = pathModule.join(workspaceRoot, '.gitignore');
        let content = '';
        let exists = false;
        try {
            if (fs.existsSync(gitignorePath)) {
                content = await fs.promises.readFile(gitignorePath, 'utf-8');
                exists = true;
            }
        } catch {
            // ignore
        }
        if (/^\s*\.opencode\s*$/m.test(content)) return;
        const newline = content.includes('\r\n') ? '\r\n' : '\n';
        const needsNewline = content.length > 0 && !content.endsWith('\n') && !content.endsWith('\r\n');
        const next = `${content}${needsNewline ? newline : ''}.opencode${newline}`;
        try {
            await fs.promises.writeFile(gitignorePath, next, 'utf-8');
        } catch {
            if (!exists) {
                return;
            }
        }
    }

    private postUndoStatus(webview: vscode.Webview, sessionId: string | undefined, enabled: boolean): void {
        if (!sessionId) return;
        webview.postMessage({ type: 'undoStatus', sessionId, enabled });
    }

    private setSessionUndoEnabled(sessionId: string | undefined, enabled: boolean, webview: vscode.Webview): void {
        if (!sessionId) return;
        this.client.setSessionUndoEnabled(sessionId, enabled);
        this.postUndoStatus(webview, sessionId, enabled);
    }

    private async ensureSessionUndoReady(sessionId: string, webview: vscode.Webview): Promise<void> {
        if (!this.gitUndoEnabled) {
            this.baselineReady = false;
            this.setSessionUndoEnabled(sessionId, false, webview);
            return;
        }
        const result = await this.client.ensureBaselineReady(sessionId, sessionId);
        this.baselineReady = result.ok;
        if (!result.ok) {
            webview.postMessage({ type: 'baselineStatus', ready: false, message: 'Git baseline failed. Undo unavailable.' });
            this.setSessionUndoEnabled(sessionId, false, webview);
            return;
        }
        webview.postMessage({ type: 'baselineStatus', ready: true });
        this.setSessionUndoEnabled(sessionId, true, webview);
    }

    private getWorkspaceRootPath(): string {
        return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    }

    private async listWorkspaceFiles(query: string, limit = 50): Promise<WorkspaceFileResult[]> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return [];
        const normalizedQuery = String(query || '').trim().replace(/\\/g, '/').toLowerCase();
        const exclude = '{**/.git/**,**/node_modules/**,**/.opencode/**,**/.sisyphus/**}';
        const maxScan = normalizedQuery.length >= 2 ? 2500 : 500;
        const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(workspaceRoot, '**/*'), exclude, maxScan);
        const scored = uris
            .map((uri) => {
                const relPath = pathModule.relative(workspaceRoot, uri.fsPath).replace(/\\/g, '/');
                const lower = relPath.toLowerCase();
                if (!relPath || relPath.startsWith('..') || pathModule.isAbsolute(relPath)) return null;
                if (normalizedQuery && !lower.includes(normalizedQuery)) return null;
                const name = pathModule.basename(relPath);
                const directory = pathModule.dirname(relPath).replace(/\\/g, '/');
                const score = !normalizedQuery
                    ? relPath.length
                    : (lower === normalizedQuery ? 0
                        : (lower.endsWith(`/${normalizedQuery}`) || pathModule.basename(lower) === normalizedQuery ? 1
                            : (pathModule.basename(lower).includes(normalizedQuery) ? 2 : 3)));
                return { path: relPath, name, directory: directory === '.' ? '' : directory, score };
            })
            .filter((item): item is WorkspaceFileResult & { score: number } => Boolean(item))
            .sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
            .slice(0, limit)
            .map(({ score, ...item }) => item);
        return scored;
    }

    private async normalizeReferencedWorkspaceFiles(rawFiles: unknown): Promise<ChatFilePart[]> {
        if (!Array.isArray(rawFiles) || !rawFiles.length) return [];
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return [];
        const normalizedRoot = pathModule.resolve(workspaceRoot);
        const out: ChatFilePart[] = [];
        const seen = new Set<string>();
        for (const raw of rawFiles.slice(0, 20)) {
            const value = typeof raw === 'string'
                ? raw
                : (raw && typeof raw === 'object' && typeof (raw as { path?: unknown }).path === 'string'
                    ? String((raw as { path: string }).path)
                    : '');
            if (!value || value.includes('\0')) continue;
            const slashNormalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
            const absPath = pathModule.isAbsolute(value)
                ? pathModule.resolve(value)
                : pathModule.resolve(workspaceRoot, slashNormalized);
            const rel = pathModule.relative(normalizedRoot, absPath).replace(/\\/g, '/');
            if (!rel || rel.startsWith('..') || pathModule.isAbsolute(rel)) continue;
            if (seen.has(rel)) continue;
            try {
                const stat = await fs.promises.stat(absPath);
                if (!stat.isFile()) continue;
            } catch {
                continue;
            }
            seen.add(rel);
            const mime = await this.getWorkspaceReferenceMime(absPath, rel);
            if (!mime) continue;
            out.push({
                path: rel,
                mime,
                url: vscode.Uri.file(absPath).toString()
            });
        }
        return out;
    }

    private async getWorkspaceReferenceMime(absPath: string, name: string): Promise<string | undefined> {
        const mime = this.getMimeFromName(name);
        if (mime !== 'application/octet-stream') {
            return mime;
        }
        try {
            const handle = await fs.promises.open(absPath, 'r');
            try {
                const buffer = Buffer.alloc(8192);
                const result = await handle.read(buffer, 0, buffer.length, 0);
                const slice = buffer.subarray(0, result.bytesRead);
                if (slice.includes(0)) {
                    this.uiDebugChannel.appendLine(`EXT: fileRef.skip | reason=binary-unknown-mime | path=${name}`);
                    return undefined;
                }
                return 'text/plain';
            } finally {
                await handle.close();
            }
        } catch (error) {
            this.uiDebugChannel.appendLine(`EXT: fileRef.mime.fail | path=${name} | err=${String(error)}`);
            return undefined;
        }
    }

    private async resolveInternalRepo(sessionId: string): Promise<GitRepoRef | null> {
        if (!sessionId) return null;
        try {
            return await this.repoManager.resolveRepo(sessionId, sessionId);
        } catch (error) {
            this.uiDebugChannel.appendLine(`[EXT][INTERNAL_REPO] resolve failed sessionId=${sessionId} err=${String(error)}`);
            return null;
        }
    }

    private async getInternalHeadCommit(repo: GitRepoRef): Promise<string | null> {
        const head = await runGit(repo, ['rev-parse', 'HEAD']);
        if (head.code !== 0) return null;
        const value = head.stdout.trim();
        return value || null;
    }

    private async getInternalParentCommit(repo: GitRepoRef, headCommit: string): Promise<string | null> {
        if (!headCommit) return null;
        const parent = await runGit(repo, ['rev-parse', `${headCommit}^`]);
        if (parent.code !== 0) return null;
        const value = parent.stdout.trim();
        return value || null;
    }

    private async waitMs(durationMs: number): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, durationMs));
    }

    private async getInternalDiffFileSet(repo: GitRepoRef, baseCommit: string, headCommit: string): Promise<Set<string>> {
        if (!baseCommit || !headCommit) return new Set();
        const diffResult = await runGit(repo, ['diff', '--name-only', `${baseCommit}..${headCommit}`]);
        if (diffResult.code !== 0) {
            this.uiDebugChannel.appendLine(`[EXT][INTERNAL_DIFF] failed base=${baseCommit} head=${headCommit}`);
            return new Set();
        }
        const files = diffResult.stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
        return new Set(files);
    }

    private async getInternalDiffStats(
        repo: GitRepoRef,
        baseCommit: string,
        headCommit: string
    ): Promise<Record<string, { additions: number | null; deletions: number | null }>> {
        if (!baseCommit || !headCommit) return {};
        const diffResult = await runGit(repo, ['diff', '--numstat', `${baseCommit}..${headCommit}`]);
        if (diffResult.code !== 0) {
            this.uiDebugChannel.appendLine(`[EXT][INTERNAL_DIFF_STATS] failed base=${baseCommit} head=${headCommit}`);
            return {};
        }
        const stats: Record<string, { additions: number | null; deletions: number | null }> = {};
        const lines = (diffResult.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        for (const line of lines) {
            const parts = line.split('\t');
            if (parts.length < 3) continue;
            const addRaw = parts[0];
            const delRaw = parts[1];
            const pathRaw = parts.slice(2).join('\t');
            const normalizedPath = pathRaw.replace(/\\/g, '/');
            const additions = addRaw === '-' ? null : Number.parseInt(addRaw, 10);
            const deletions = delRaw === '-' ? null : Number.parseInt(delRaw, 10);
            if (!Number.isFinite(additions as number) && additions !== null) continue;
            if (!Number.isFinite(deletions as number) && deletions !== null) continue;
            stats[normalizedPath] = {
                additions: additions === null ? null : additions,
                deletions: deletions === null ? null : deletions
            };
        }
        return stats;
    }

    private async emitDiffFileList(sessionId: string, webview: vscode.Webview): Promise<void> {
        if (!this.gitUndoEnabled || !sessionId) return;
        const repo = await this.resolveInternalRepo(sessionId);
        if (!repo) return;
        let headCommit: string | null = null;
        let baseCommit: string | null = null;
        const turnCommitBase = this.client.getLastTurnCommitBase(sessionId) || null;
        for (let attempt = 0; attempt < 5; attempt++) {
            headCommit = await this.getInternalHeadCommit(repo);
            if (headCommit && turnCommitBase) {
                baseCommit = turnCommitBase;
            } else if (headCommit) {
                baseCommit = await this.getInternalParentCommit(repo, headCommit);
            }
            if (headCommit && baseCommit) break;
            await this.waitMs(100);
        }
        if (headCommit && !baseCommit) {
            this.uiDebugChannel.appendLine('EXT: diff.skip | reason=baseline-only');
            return;
        }
        if (!headCommit || !baseCommit) {
            return;
        }
        const currentSet = await this.getInternalDiffFileSet(repo, baseCommit, headCommit);
        const files = Array.from(currentSet);
        if (!files.length) return;
        const alreadyEmitted = this.client.wasChangeListEmitted(sessionId);
        const lastEmittedHead = this.lastEmittedChangeListHeadBySession.get(sessionId);
        if (alreadyEmitted && lastEmittedHead === headCommit) {
            this.uiDebugChannel.appendLine(
                `[LATE_DIFF] change-list already emitted for same head | sessionId=${sessionId} head=${headCommit} skipping=true`
            );
            return;
        }
        if (!alreadyEmitted) {
            if (!this.client.markChangeListEmitted(sessionId, 'emit-diff-list')) {
                return;
            }
        } else {
            this.uiDebugChannel.appendLine(
                `[LATE_DIFF] re-emitting change-list for advanced head | sessionId=${sessionId} prevHead=${lastEmittedHead || 'null'} nextHead=${headCommit}`
            );
        }
        files.sort();
        const statsByPath = await this.getInternalDiffStats(repo, baseCommit, headCommit);
        const existingRecords = await this.readChangeLists(sessionId);
        const matchedExisting = existingRecords.find((item) => item.commitHead === headCommit);
        const ownershipMap = await this.readPersistedSessionMap(sessionId);
        const liveAnchor = this.client.getTurnAssistantMsgId(sessionId);
        const anchorMessageId = await this.resolveCurrentVisibleOwnerMessageId(
            sessionId,
            matchedExisting?.anchorMessageId || liveAnchor || undefined
        );
        let mergedFiles = [...files];
        let mergedStatsByPath = { ...statsByPath };
        let changeListId = headCommit ? `system:changeList:${headCommit}` : `changes:${Date.now()}`;
        const postFinalOverlay = this.client.getPostFinalWatchOverlay(sessionId);
        const currentOwnerMsgId = ownershipMap?.continuation?.currentOwnerMsgId;
        const predecessorOwnerMsgId = ownershipMap?.continuation?.predecessorOwnerMsgId;
        const currentOwnerIsContinuation = Array.isArray(ownershipMap?.entries)
            && !!currentOwnerMsgId
            && ownershipMap!.entries.some((entry) => {
                const entryOwner = entry.finalAssistantMsgId || entry.assistantMsgId;
                return entryOwner === currentOwnerMsgId
                    && typeof entry.turnKey === 'string'
                    && entry.turnKey.startsWith('cont:');
            });
        if (currentOwnerIsContinuation && anchorMessageId && currentOwnerMsgId === anchorMessageId && predecessorOwnerMsgId) {
            const recordsForOwner: ChangeListRecord[] = [];
            for (const record of existingRecords) {
                const resolvedRecordAnchor = await this.resolveCurrentVisibleOwnerMessageId(sessionId, record.anchorMessageId);
                if (resolvedRecordAnchor === anchorMessageId) {
                    recordsForOwner.push(record);
                }
            }
            if (recordsForOwner.length) {
                const primary = recordsForOwner.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
                changeListId = primary.id || changeListId;
                const orderedFiles = [
                    ...recordsForOwner.flatMap((record) => Array.isArray(record.files) ? record.files : []),
                    ...files
                ].filter((item): item is string => typeof item === 'string' && item.length > 0);
                mergedFiles = Array.from(new Set(orderedFiles));
                mergedStatsByPath = recordsForOwner.reduce((acc, record) => ({
                    ...acc,
                    ...(record.statsByPath || {})
                }), { ...mergedStatsByPath });
            }
        }
        const overlayApplies = Array.isArray(postFinalOverlay.files)
            && postFinalOverlay.files.length > 0
            && (
                !postFinalOverlay.ownerMsgId
                || postFinalOverlay.ownerMsgId === anchorMessageId
                || postFinalOverlay.ownerMsgId === predecessorOwnerMsgId
                || postFinalOverlay.ownerMsgId === currentOwnerMsgId
            );
        if (overlayApplies) {
            mergedFiles = Array.from(new Set([...mergedFiles, ...postFinalOverlay.files]));
            mergedStatsByPath = {
                ...postFinalOverlay.statsByPath,
                ...mergedStatsByPath
            };
        }
        this.uiDebugChannel?.appendLine(`[EXT][COMMIT_BIND] created | sessionId=${sessionId} commit=${headCommit} anchor=${anchorMessageId || 'null'} isMsg=${anchorMessageId?.startsWith('msg_') || false} source=${matchedExisting?.anchorMessageId ? 'existing-record' : 'live-turn'}`);
        webview.postMessage({
            type: 'diffFileList',
            sessionId,
            files: mergedFiles,
            source: 'git',
            scope: 'turn',
            commitHead: headCommit,
            commitBase: baseCommit,
            statsByPath: mergedStatsByPath,
            anchorMessageId,
            changeListId
        });
        if (anchorMessageId && headCommit && baseCommit) {
            await this.upsertChangeList(sessionId, {
                id: changeListId,
                commitHead: headCommit,
                commitBase: baseCommit,
                files: mergedFiles,
                statsByPath: mergedStatsByPath,
                anchorMessageId,
                createdAt: Date.now()
            });
            this.uiDebugChannel?.appendLine(`[EXT][COMMIT_BIND] bound | changeListId=${changeListId} anchor=${anchorMessageId} isMsg=${anchorMessageId.startsWith('msg_')} commitHead=${headCommit}`);
        }
        this.lastEmittedChangeListHeadBySession.set(sessionId, headCommit);
        this.uiDebugChannel?.appendLine(`[EXT][DIFF_LIST] sessionId=${sessionId} count=${files.length} anchor=${anchorMessageId || 'null'}`);
    }

    /**
     * Wrapper for emitDiffFileList that retries until anchor message ID is ready.
     * Prevents race condition where anchor is still tmp: during finalization.
     */
    private async emitDiffFileListWithRetry(sessionId: string, webview: vscode.Webview): Promise<void> {
        const maxAttempts = 5;
        const delayMs = 50;
        
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const anchorMessageId = this.client.getTurnAssistantMsgId(sessionId);
            const isReady = anchorMessageId && 
                           !anchorMessageId.startsWith('tmp:') && 
                           !anchorMessageId.startsWith('local-');
            
            if (isReady) {
                this.uiDebugChannel?.appendLine(`[EXT][DIFF_LIST] anchor ready | attempt=${attempt}/${maxAttempts} anchor=${anchorMessageId}`);
                await this.emitDiffFileList(sessionId, webview);
                return;
            }
            
            this.uiDebugChannel?.appendLine(`[EXT][DIFF_LIST] anchor not ready | attempt=${attempt}/${maxAttempts} anchor=${anchorMessageId || 'null'} reason=${!anchorMessageId ? 'missing' : 'tmp/local'}`);
            
            if (attempt < maxAttempts) {
                await this.waitMs(delayMs);
            }
        }
        
        // Max retries exceeded - emit anyway to avoid blocking turn completion
        const finalAnchor = this.client.getTurnAssistantMsgId(sessionId);
        this.uiDebugChannel?.appendLine(`[EXT][DIFF_LIST] max retries exceeded | emitting anyway | anchor=${finalAnchor || 'null'}`);
        await this.emitDiffFileList(sessionId, webview);
    }

    private async getFileTextAtCommit(repo: GitRepoRef, commit: string, relativePath: string): Promise<string | null> {
        const normalized = relativePath.replace(/\\/g, '/');
        const exists = await runGit(repo, ['cat-file', '-e', `${commit}:${normalized}`]);
        if (exists.code !== 0) return null;
        const result = await runGit(repo, ['show', `${commit}:${normalized}`]);
        if (result.code !== 0) return null;
        return result.stdout ?? '';
    }

    private async getDiffTextForPath(repo: GitRepoRef, baseCommit: string, relativePath: string): Promise<string> {
        const normalized = relativePath.replace(/\\/g, '/');
        const result = await runGit(repo, ['diff', baseCommit, '--', normalized]);
        if (result.code !== 0) return '';
        return result.stdout ?? '';
    }

    private async getDiffTextBetweenCommits(repo: GitRepoRef, baseCommit: string, headCommit: string, relativePath: string): Promise<string> {
        const normalized = relativePath.replace(/\\/g, '/');
        const result = await runGit(repo, ['diff', baseCommit, headCommit, '--', normalized]);
        if (result.code !== 0) return '';
        return result.stdout ?? '';
    }

    private async openGitDiffForFile(
        sessionId: string,
        filePath: string,
        webview: vscode.Webview,
        commitHead?: string,
        commitBase?: string
    ): Promise<void> {
        if (!filePath || !sessionId) return;
        const repo = await this.resolveInternalRepo(sessionId);
        if (!repo) return;
        let headCommit = commitHead || await this.getInternalHeadCommit(repo);
        let baseCommit = commitBase || (headCommit ? await this.getInternalParentCommit(repo, headCommit) : null);
        if (!headCommit || !baseCommit) {
            this.postAddResponse(webview, 'No baseline available to open diff.');
            return;
        }
        const workspaceRoot = this.getWorkspaceRootPath();
        const absPath = pathModule.isAbsolute(filePath)
            ? filePath
            : pathModule.join(workspaceRoot, filePath);
        const relPath = pathModule.relative(workspaceRoot, absPath).replace(/\\/g, '/');
        const beforeText = (await this.getFileTextAtCommit(repo, baseCommit, relPath)) ?? '';
        let afterText = '';
        let diffText = '';
        if (commitHead) {
            afterText = (await this.getFileTextAtCommit(repo, headCommit, relPath)) ?? '';
            diffText = await this.getDiffTextBetweenCommits(repo, baseCommit, headCommit, relPath);
        } else {
            try {
                afterText = await fs.promises.readFile(absPath, 'utf-8');
            } catch {
                afterText = '';
            }
            diffText = await this.getDiffTextForPath(repo, baseCommit, relPath);
        }
        await this.diffProvider.updateFromSnapshot(relPath, beforeText, afterText, diffText || undefined);
    }

    constructor(
        private readonly _context: vscode.ExtensionContext,
        private readonly _extensionUri: vscode.Uri,
        private readonly diffProvider: OpenCodeDiffProvider
    ) {
        this.client = new OpenCodeClient();
        this.client.setStorage(this._context.globalState);
        this.uiDebugChannel = vscode.window.createOutputChannel('OpenCode UI Debug');
        this.client.setUiDebugChannel(this.uiDebugChannel);
        void this.loadUserOwnedSessions();
        this.client.setServerStatusHandler((status, reason) => {
            this.sendServerStatus(status, reason);
        });
        this.client.addChatEventListener((event) => {
            const liveWebview = this._view?.webview;
            if (!liveWebview) return;
            void this.handleChatEvent(event, liveWebview);
        });
        if (!process.env.JEST_WORKER_ID) {
            void this.client.warmServer();
        }
        process.on('exit', () => { void this.client.shutdownServer(); });
        process.on('SIGINT', () => { void this.client.shutdownServer(); });
        process.on('SIGTERM', () => { void this.client.shutdownServer(); });
        process.on('uncaughtException', () => { void this.client.shutdownServer(); });
        process.on('unhandledRejection', () => { void this.client.shutdownServer(); });
        const workspaceRoot = this.getWorkspaceRootPath();
        this.repoManager = new GitRepoManager(workspaceRoot, (message) => this.uiDebugChannel.appendLine(message));
        void this.initGitUndo();
        void this.ensureGitignoreIgnoresOpencode();
        this.scheduleAttachmentCleanup('activate');
        this.startAttachmentCleanupTimer();

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

    private async initGitUndo(): Promise<void> {
        const capabilities = await this.client.initGitUndo();
        this.gitUndoEnabled = Boolean(capabilities.gitAvailable);
        this.gitUndoReason = capabilities.reason || undefined;
        this.uiDebugChannel.appendLine(`detectGit: ok=${String(this.gitUndoEnabled)} version=${capabilities.version || 'null'} reason=${capabilities.reason || 'null'}`);
        const liveWebview = this._view?.webview;
        if (liveWebview) {
            liveWebview.postMessage({ type: 'gitUndoAvailability', enabled: this.gitUndoEnabled, reason: this.gitUndoReason });
        }
    }

    public async sendEditorSelectionToChat(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('No active editor selection to send.');
            return;
        }
        const selection = editor.selection;
        if (!selection || selection.isEmpty) {
            vscode.window.showInformationMessage('Select text in the editor to send.');
            return;
        }
        const text = editor.document.getText(selection);
        if (!text.trim()) {
            vscode.window.showInformationMessage('Selected text is empty.');
            return;
        }
        const startLine = Math.min(selection.start.line, selection.end.line) + 1;
        const endLine = Math.max(selection.start.line, selection.end.line) + 1;
        const filePath = editor.document.uri.fsPath;
        const displayPath = vscode.workspace.asRelativePath(filePath, false);
        const displayText = `${displayPath}:${startLine}-${endLine}`;
        this.sendPrefillInput(displayText, {
            source: 'editor',
            text,
            filePath,
            range: { startLine, endLine }
        });
    }

    public async sendOutputSelectionToChat(): Promise<void> {
        try {
            await vscode.commands.executeCommand('editor.action.clipboardCopyAction');
        } catch {
            // ignore copy failures, fallback to clipboard contents
        }
        const text = await vscode.env.clipboard.readText();
        if (!text || !text.trim()) {
            vscode.window.showInformationMessage('No output selection found. Copy selection and try again.');
            return;
        }
        this.sendPrefillInput('vscode output', {
            source: 'output',
            text
        });
    }

    private sendPrefillInput(displayText: string, payload: { source: string; text: string; filePath?: string; range?: { startLine?: number; endLine?: number } }): void {
        const liveWebview = this._view?.webview;
        if (!liveWebview) {
            vscode.window.showInformationMessage('Open the OpenCode UI to receive the selection.');
            return;
        }
        liveWebview.postMessage({
            type: 'prefillInput',
            displayText,
            payload
        });
    }

    private sendServerStatus(status: 'connected' | 'reconnecting' | 'error', reason?: string): void {
        this.serverStatus = status;
        const liveWebview = this._view?.webview;
        if (liveWebview) {
            liveWebview.postMessage({ type: 'serverStatus', status, reason });
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
            try {
                const keys = data && typeof data === 'object' ? Object.keys(data).sort() : [];
                this.uiDebugChannel.appendLine(`EXT: wv.msg | type=${data?.type || 'unknown'} | keys=[${keys.join(',')}]`);
            } catch {
                this.uiDebugChannel.appendLine('EXT: wv.msg | type=unknown | keys=[]');
            }

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
                        this.uiDebugChannel.appendLine(`[EXT][HANDSHAKE_2_START] calling sendInit() | initPosted=${this.initPosted}`);
                        let sendInitError: Error | undefined;
                        try {
                            await this.sendInit(liveWebview);
                            this.uiDebugChannel.appendLine(`[EXT][HANDSHAKE_3_DONE] sendInit() complete, sending ack`);
                        } catch (err) {
                            sendInitError = err instanceof Error ? err : new Error(String(err));
                            this.uiDebugChannel.appendLine(`[EXT][SENDINIT_ERROR] sendInit threw: ${sendInitError.message}`);
                        }
                        
                        if (sendInitError) {
                            liveWebview.postMessage({ 
                                type: 'webviewReadyAck', 
                                timestamp: Date.now(), 
                                webviewInstanceId: this._webviewInstanceId,
                                error: true,
                                message: sendInitError.message
                            });
                        } else {
                            liveWebview.postMessage({ type: 'webviewReadyAck', timestamp: Date.now(), webviewInstanceId: this._webviewInstanceId });
                        }
                        this.uiDebugChannel.appendLine(`[EXT][HANDSHAKE_4_ACK] ack sent`);
                    }
                    break;
                }
                case "sendMessage": {
                    // this.uiDebugChannel.appendLine(
                    //     `[EXT][SEND_RX] sessionId=${this.currentSessionId || 'NULL'} ` +
                    //     `hasValue=${Boolean(data.value)} valueLen=${data.value?.length || 0}`
                    // );
                    
                    const contextItems = Array.isArray(data.contextItems) ? data.contextItems : [];
                    const hasContext = contextItems.some((item: any) => typeof item?.text === 'string' && item.text.length > 0);
                    if (!data.value && !hasContext && !(Array.isArray(data.attachments) && data.attachments.length)) {
                        // this.uiDebugChannel.appendLine(`[EXT][SEND_DROP] reason=empty-value`);
                        return;
                    }

                    if (!this.currentSessionId) {
                        // this.uiDebugChannel.appendLine(`[EXT][SEND_CREATE_SESSION] reason=no-current`);
                        try {
                            const sessionInfo = await this.client.createSession();
                            this.currentSessionId = sessionInfo.id;
                            this.trackUserOwnedSession(this.currentSessionId);
                            this.client.setSessionId(this.currentSessionId);
                            const workspaceFolder = this.client.getWorkspaceRoot() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                            if (workspaceFolder) {
                                const workspaceKey = this.getWorkspaceKeyForRoot(workspaceFolder);
                                await this._context.globalState.update(`recentSession.${workspaceKey}`, this.currentSessionId);
                                this.uiDebugChannel.appendLine(
                                    `[EXT][RECENT_SESSION_UPDATED] sessionId=${this.currentSessionId} reason=sendMessage-createSession workspace=${workspaceFolder}`
                                );
                            }
                            // this.uiDebugChannel.appendLine(`[EXT][SEND_SESSION_CREATED] id=${this.currentSessionId}`);
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
                        // OpenCodeClient.outputChannel.appendLine(`[BRIDGE] Manual PONG sent`);
                        this.postAddResponse(activeWebview, 'PONG - Bridge is working!');
                        return;
                    }

                    if (this.currentSessionId && this.sendInFlightBySession.has(this.currentSessionId)) {
                        this.uiDebugChannel.appendLine(`EXT: send.blocked | sessionId=${this.currentSessionId} | reason=turn-in-flight`);
                        const liveWebview = this._view?.webview || activeWebview;
                        liveWebview.postMessage({ type: 'turnInFlight', sessionId: this.currentSessionId, inFlight: true });
                        return;
                    }

                    // this.uiDebugChannel.appendLine(`[EXT][SEND_START] sessionId=${this.currentSessionId} attachments=${data.attachments?.length || 0}`);

                    const reqId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                    let activeSendSessionId: string | undefined;
                    try {
                        const attachments = Array.isArray(data.attachments) ? data.attachments as AttachmentPayload[] : [];
                        const attachKeys = attachments.length ? Object.keys(attachments[0] || {}).join(',') : '';
                        this.uiDebugChannel.appendLine(`EXT: send.enter | reqId=${reqId} | sessionId=${this.currentSessionId || 'null'} | hasAttachments=${String(Boolean(attachments.length))} | attachmentsCount=${attachments.length} | attachKeys=${attachKeys}`);
                        const userText = (data.value as string) || '';
                        const referencedFiles = await this.normalizeReferencedWorkspaceFiles(data.files);
                        let modelText = userText;
                        const initialDraft = {
                            text: userText,
                            attachments: [],
                            model: this.selectedModel,
                            variant: this.selectedVariant,
                            mode: this.selectedMode
                        };
                        const clientMessageId = data.clientMessageId || `local-${Date.now()}`;
                        this.pendingClientMessageId = clientMessageId;
                        this.rememberDraft(clientMessageId, initialDraft);
                        this.rawUserTextByLocalKey.set(clientMessageId, userText);
                        const opId = typeof data.opId === 'string' ? data.opId : undefined;
                        if (this.currentSessionId) {
                            activeSendSessionId = this.currentSessionId;
                            this.sendInFlightBySession.add(this.currentSessionId);
                            this.pendingLocalKeyBySession.set(this.currentSessionId, clientMessageId);
                            this.pendingAssistantTmpKeyBySession.delete(this.currentSessionId);
                            const liveWebview = this._view?.webview || activeWebview;
                            liveWebview.postMessage({ type: 'turnInFlight', sessionId: this.currentSessionId, inFlight: true });
                            this.client.startTurnWithOp(this.currentSessionId, clientMessageId, opId);
                            this.assistantTextBufferBySession.set(this.currentSessionId, '');
                        }
                        if (typeof data.tmpKey === 'string' && data.tmpKey.startsWith('tmp:') && this.currentSessionId) {
                            this.pendingAssistantTmpKeyBySession.set(this.currentSessionId, data.tmpKey);
                            this.pendingAssistantTmpKeyByLocalKey.set(clientMessageId, data.tmpKey);
                            this.client.setPendingAssistantTmpKey(this.currentSessionId, data.tmpKey);
                        }

                        const messageIndex = this.client.registerMessage(clientMessageId);
                        const liveWebview = this._view?.webview || activeWebview;
                        this.clientMessageIdMap.set(clientMessageId, clientMessageId);

                        const attachmentNames = attachments.map((item) => {
                            if (item?.filename) return this.sanitizeFilename(item.filename);
                            if (item?.tempPath) return pathModule.basename(item.tempPath);
                            return 'attachment';
                        });
                        const fileNames = attachmentNames.filter((name: string) => !this.isImageFileName(name));
                        const attachmentLines = fileNames.map((name: string) => `📄 ${name}`);
                        const displayText = attachmentLines.length
                            ? (userText
                                ? `${userText}

${attachmentLines.join('\n')}`
                                : attachmentLines.join('\n'))
                            : userText;
                        const pendingUserMessage: SessionMessage = {
                            role: 'user',
                            text: displayText,
                            id: clientMessageId,
                            messageIndex
                        };

                        const assistantMessageId = this.client.createInternalMessageId('assistant', this.currentSessionId);
                        const assistantMessageIndex = this.client.registerMessage(assistantMessageId);
                        if (this.currentSessionId) {
                            this.pendingAssistantMessageIdBySession.set(this.currentSessionId, assistantMessageId);
                        }
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

                        const savedAttachments: SavedAttachment[] = [];
                        if (!attachments.length) {
                            this.uiDebugChannel.appendLine(`EXT: attach.precheck.skip | reqId=${reqId} | reason=no_attachments`);
                        } else if (this.currentSessionId) {
                            for (const attachment of attachments) {
                                try {
                                    const saved = await this.saveAttachment(this.currentSessionId, attachment, reqId);
                                    if (saved) {
                                        savedAttachments.push(saved);
                                    }
                                } catch (error) {
                                    this.uiDebugChannel.appendLine(`EXT: attach.save.fail | reqId=${reqId} | filename=${attachment?.filename || 'unknown'} | mime=${attachment?.mime || 'unknown'} | err=${String(error)}`);
                                }
                            }
                        if (savedAttachments.length) {
                            const manifest = this.buildAttachmentManifest(savedAttachments);
                            modelText = modelText ? `${modelText}\n\n${manifest}` : manifest;
                        }
                        const contextBlock = this.buildContextBlock(contextItems);
                        if (contextBlock) {
                            modelText = modelText ? `${modelText}\n\n${contextBlock}` : contextBlock;
                        }
                        }
                        this.uiDebugChannel.appendLine(`EXT: send.parts.built | reqId=${reqId} | textParts=1 | manifestCount=${savedAttachments.length} | savedCount=${savedAttachments.length}`);

                        await this.client.chat(
                            modelText,
                            {
                                model: this.selectedModel,
                                variant: this.selectedVariant,
                                sessionId: this.currentSessionId,
                                mode: this.selectedMode,
                                files: referencedFiles
                            }
                        );

                        if (this.currentSessionId) {
                            await this.client.waitForSessionIdleGate(this.currentSessionId, {
                                sseWaitMs: 2000,
                                pollEveryMs: 2000,
                                maxPolls: 3
                            });
                        }

                        OpenCodeClient.outputChannel.appendLine(`[BRIDGE] Chat done`);
                        let doneAssistantMsgId = this.currentSessionId
                            ? this.client.getTurnAssistantMsgId(this.currentSessionId)
                            : undefined;
                        if (this.currentSessionId && !doneAssistantMsgId) {
                            this.uiDebugChannel.appendLine(`EXT: chatdone.guard.wait-final | sessionId=${this.currentSessionId} | reason=missing-assistant-msg-id`);
                            doneAssistantMsgId = await this.client.waitForTurnAssistantMsgId(this.currentSessionId, 500);
                            this.uiDebugChannel.appendLine(`EXT: chatdone.guard.resolved | sessionId=${this.currentSessionId} | assistantMsgId=${doneAssistantMsgId}`);
                        }
                        liveWebview.postMessage({
                            type: 'chatDone',
                            sessionId: this.currentSessionId,
                            assistantMsgId: doneAssistantMsgId,
                            lastAssistantMsgId: doneAssistantMsgId
                        });
                        this.emitTurnFinalizePhase(liveWebview, this.currentSessionId, 'stream_done');
                        this.postMessageIndexMap(liveWebview);
                        if (this.currentSessionId) {
                            this.uiDebugChannel.appendLine(`EXT: finalize.order | sessionId=${this.currentSessionId} | phase=commit-start`);
                            await this.client.commitPendingTurnChanges(this.currentSessionId);
                            this.uiDebugChannel.appendLine(`EXT: finalize.order | sessionId=${this.currentSessionId} | phase=commit-done`);
                            this.emitTurnFinalizePhase(liveWebview, this.currentSessionId, 'commit_done');
                        }
                        this.uiDebugChannel.appendLine(`EXT: finalize.order | sessionId=${this.currentSessionId || 'null'} | phase=upgrade-start`);
                        await this.resolvePendingUserUpgrade(this.currentSessionId, liveWebview);
                        this.uiDebugChannel.appendLine(`EXT: finalize.order | sessionId=${this.currentSessionId || 'null'} | phase=upgrade-done`);
                        this.emitTurnFinalizePhase(liveWebview, this.currentSessionId, 'upgrade_done');
                        this.postMessageIndexMap(liveWebview);
                        if (this.currentSessionId) {
                            await this.emitDiffFileListWithRetry(this.currentSessionId, liveWebview);
                        }
                        if (this.currentSessionId) {
                            this.client.finishTurn(this.currentSessionId);
                            this.postFinalWatchDiffFocusedBySession.delete(this.currentSessionId);
                        }
                        // Do not force "done" from main finalize; only subagent final-accepted can set done.
                        // Any still-active subagents at this point are treated as cancelled.
                        this.markAllSubagentsTerminal('cancelled', 'main-finalize-cancel-active');
                        this.emitSubagentStatus();
                        this.clearSubagentSessions();
                        this.emitTurnFinalizePhase(liveWebview, this.currentSessionId, 'finalize_done');
                        await this.postModelQuota(liveWebview, 'chat-done');
                        if (this.pendingClientMessageId) {
                            this.clearDraft(this.pendingClientMessageId);
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
                        const sessionId = activeSendSessionId ?? this.currentSessionId;
                        this.uiDebugChannel.appendLine(`EXT: send.abort | reqId=${reqId} | reason=${String(error)}`);
                        OpenCodeClient.outputChannel.appendLine(`[BRIDGE] Error: ${error}`);
                        vscode.window.showErrorMessage(`OpenCode Error: ${error}`);
                        activeWebview.postMessage({ type: 'addResponse', value: `Error: ${error}`, sessionId, skipSnapshot: true });
                        const doneAssistantMsgId = sessionId
                            ? this.client.getTurnAssistantMsgId(sessionId)
                            : undefined;
                        activeWebview.postMessage({
                            type: 'chatDone',
                            sessionId,
                            assistantMsgId: doneAssistantMsgId,
                            lastAssistantMsgId: doneAssistantMsgId
                        });
                        this.emitTurnFinalizePhase(activeWebview, sessionId, 'stream_done');
                        if (sessionId) {
                            await this.client.commitPendingTurnChanges(sessionId);
                            this.emitTurnFinalizePhase(activeWebview, sessionId, 'commit_done');
                        }
                        await this.resolvePendingUserUpgrade(sessionId, activeWebview);
                        this.emitTurnFinalizePhase(activeWebview, sessionId, 'upgrade_done');
                        const pendingLocalKey = sessionId ? this.pendingLocalKeyBySession.get(sessionId) : undefined;
                        if (sessionId && sessionId === this.currentSessionId && pendingLocalKey && this.pendingClientMessageId === pendingLocalKey) {
                            this.clearDraft(this.pendingClientMessageId);
                            await this.handleAbortedMessage(this.pendingClientMessageId, activeWebview);
                            this.pendingClientMessageId = undefined;
                        }
                        if (sessionId) {
                            if (pendingLocalKey) {
                                this.pendingAssistantTmpKeyByLocalKey.delete(pendingLocalKey);
                                this.rawUserTextByLocalKey.delete(pendingLocalKey);
                            }
                            this.assistantTextBufferBySession.delete(sessionId);
                            this.pendingAssistantTmpKeyBySession.delete(sessionId);
                        }
                        if (sessionId) {
                            this.client.finishTurn(sessionId);
                        }
                        // Mark all active subagents as failed before clearing (error path)
                        this.markAllSubagentsTerminal('failed', 'main-error-finalize');
                        this.emitSubagentStatus();
                        this.clearSubagentSessions();
                        this.emitTurnFinalizePhase(activeWebview, sessionId, 'finalize_done');
                        await this.postModelQuota(activeWebview, 'chat-error');
                    } finally {
                        if (activeSendSessionId) {
                            const pendingLocalKey = this.pendingLocalKeyBySession.get(activeSendSessionId);
                            if (pendingLocalKey) {
                                this.rawUserTextByLocalKey.delete(pendingLocalKey);
                            }
                            this.sendInFlightBySession.delete(activeSendSessionId);
                            this.pendingLocalKeyBySession.delete(activeSendSessionId);
                            this.pendingAssistantTmpKeyBySession.delete(activeSendSessionId);
                            const liveWebview = this._view?.webview || activeWebview;
                            liveWebview.postMessage({ type: 'turnInFlight', sessionId: activeSendSessionId, inFlight: false });
                        }
                    }
                    break;
                }
                case "appendMessage": {
                    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : this.currentSessionId;
                    const value = typeof data.value === 'string' ? data.value.trim() : '';
                    const clientMessageId = typeof data.clientMessageId === 'string' ? data.clientMessageId : `append-${Date.now()}`;
                    const liveWebview = this._view?.webview || activeWebview;
                    const requestedRootUserMsgId = typeof data.rootUserKey === 'string' ? data.rootUserKey : undefined;
                    const currentRootUserMsgId = this.client.getAppendRootUserMsgId(sessionId) || requestedRootUserMsgId;
                    if (!sessionId || !value) {
                        liveWebview.postMessage({
                            type: 'appendStatus',
                            sessionId,
                            clientMessageId,
                            status: 'failed',
                            rootUserMsgId: currentRootUserMsgId,
                            reason: 'empty'
                        });
                        break;
                    }
                    if (!this.currentSessionId || sessionId !== this.currentSessionId || !this.sendInFlightBySession.has(sessionId) || !this.client.canAppendToCurrentTurn(sessionId)) {
                        liveWebview.postMessage({
                            type: 'appendStatus',
                            sessionId,
                            clientMessageId,
                            status: 'rejected',
                            rootUserMsgId: currentRootUserMsgId,
                            reason: 'finalized'
                        });
                        break;
                    }
                    if (this.appendSubmitInFlightBySession.has(sessionId)) {
                        liveWebview.postMessage({
                            type: 'appendStatus',
                            sessionId,
                            clientMessageId,
                            status: 'rejected',
                            rootUserMsgId: currentRootUserMsgId,
                            reason: 'append-in-flight'
                        });
                        break;
                    }
                    const beginAppend = this.client.beginAppendPrompt(sessionId, clientMessageId, value);
                    if (!beginAppend) {
                        liveWebview.postMessage({
                            type: 'appendStatus',
                            sessionId,
                            clientMessageId,
                            status: 'rejected',
                            rootUserMsgId: currentRootUserMsgId,
                            reason: 'begin-rejected'
                        });
                        break;
                    }
                    this.appendSubmitInFlightBySession.add(sessionId);
                    try {
                        await this.client.appendPrompt(sessionId, value, {
                            model: this.selectedModel,
                            mode: this.selectedMode,
                            clientMessageId
                        });
                        liveWebview.postMessage({
                            type: 'appendStatus',
                            sessionId,
                            clientMessageId,
                            rootUserMsgId: currentRootUserMsgId,
                            status: 'queued'
                        });
                    } catch (error) {
                        this.client.failAppendPrompt(sessionId, clientMessageId);
                        liveWebview.postMessage({
                            type: 'appendStatus',
                            sessionId,
                            clientMessageId,
                            status: 'failed',
                            rootUserMsgId: beginAppend.rootUserMsgId,
                            reason: String(error)
                        });
                    } finally {
                        this.appendSubmitInFlightBySession.delete(sessionId);
                    }
                    break;
                }
                case "setModel": {
                    this.selectedModel = data.value || undefined;
                    await this._context.globalState.update('opencode.model', this.selectedModel);
                    await this.postModelQuota(activeWebview, 'model-change');
                    break;
                }
                case "compactSession": {
                    const requestedSessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
                    const sessionId = requestedSessionId || this.currentSessionId || '';
                    if (!sessionId) {
                        this.postAddResponse(activeWebview, 'Compaction skipped: no active session.');
                        break;
                    }
                    const model = this.client.pickFreeModel(this.lastKnownModels, this.selectedModel);
                    if (!model) {
                        this.postAddResponse(activeWebview, 'Compaction skipped: no free model available.');
                        break;
                    }
                    const modelRef = this.parseModelRef(model.fullId);
                    if (!modelRef) {
                        this.postAddResponse(activeWebview, `Compaction skipped: invalid model id ${model.fullId}.`);
                        break;
                    }
                    activeWebview.postMessage({ type: 'compactionState', sessionId, running: true });
                    try {
                        await this.client.summarizeSession(sessionId, {
                            providerID: modelRef.providerID,
                            modelID: modelRef.modelID,
                            auto: false
                        });
                        this.postAddResponse(activeWebview, `Compaction started (${model.fullId}).`);
                    } catch (error) {
                        this.postAddResponse(activeWebview, `Compaction failed: ${error}`);
                    } finally {
                        const liveWebview = this._view?.webview || activeWebview;
                        liveWebview.postMessage({ type: 'compactionState', sessionId, running: false });
                        const refreshedUsage = await this.client.fetchSessionUsage(sessionId);
                        if (refreshedUsage) {
                            liveWebview.postMessage({
                                type: 'sessionUsage',
                                sessionId,
                                used: refreshedUsage.used,
                                size: refreshedUsage.size,
                                amount: refreshedUsage.amount
                            });
                        }
                    }
                    break;
                }
                case "setMode": {
                    const requestedMode = typeof data.value === 'string' ? data.value : '';
                    const mode = this.availableModes.includes(requestedMode)
                        ? requestedMode
                        : (this.availableModes[0] || 'plan');
                    this.selectedMode = mode || undefined;
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
                case "listWorkspaceFiles": {
                    const requestId = typeof data.requestId === 'string' ? data.requestId : '';
                    const query = typeof data.query === 'string' ? data.query : '';
                    const files = await this.listWorkspaceFiles(query);
                    const liveWebview = this._view?.webview || activeWebview;
                    liveWebview.postMessage({
                        type: 'workspaceFileResults',
                        requestId,
                        query,
                        files
                    });
                    break;
                }
                case "ping": {
                    const liveWebview = this._view?.webview || webviewView.webview;
                    liveWebview.postMessage({ type: 'pong', ts: data.ts });
                    break;
                }
                case "reloadWindow": {
                    this.uiDebugChannel.appendLine('EXT: reloadWindow.requested');
                    await vscode.commands.executeCommand('workbench.action.reloadWindow');
                    break;
                }
                case "registerTmpKey": {
                    if (typeof data.sessionId !== 'string' || typeof data.tmpKey !== 'string') break;
                    if (!data.tmpKey.startsWith('tmp:')) break;
                    this.pendingAssistantTmpKeyBySession.set(data.sessionId, data.tmpKey);
                    const pendingLocalKey = this.pendingLocalKeyBySession.get(data.sessionId);
                    if (pendingLocalKey && pendingLocalKey.startsWith('local-')) {
                        this.pendingAssistantTmpKeyByLocalKey.set(pendingLocalKey, data.tmpKey);
                    }
                    this.client.setPendingAssistantTmpKey(data.sessionId, data.tmpKey);
                    break;
                }
                case "registerPendingUserLocal": {
                    if (typeof data.sessionId !== 'string' || typeof data.localKey !== 'string') break;
                    if (!data.localKey.startsWith('local-')) break;
                    const isInFlight = this.sendInFlightBySession.has(data.sessionId);
                    this.uiDebugChannel.appendLine(`EXT: registerPendingUserLocal | sessionId=${data.sessionId} | localKey=${data.localKey} | inFlight=${String(isInFlight)}`);
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
                    
                    // Filter memberMsgIds to only msg_*
                    const memberMsgIds = Array.isArray(seg.memberMsgIds)
                        ? seg.memberMsgIds.filter((id: string) => typeof id === 'string' && id.startsWith('msg_'))
                        : [];
                    const anchorMsgId = typeof seg.anchorMsgId === 'string' && seg.anchorMsgId.startsWith('msg_')
                        ? seg.anchorMsgId
                        : (memberMsgIds[0] || '');
                    if (!anchorMsgId) {
                        this.uiDebugChannel.appendLine(`[EXT][SEGMENT_INVARIANT_FAIL] reason=missing-anchor-and-members noticeKey=${seg.noticeKey}`);
                        break;
                    }
                    if (!seg.anchorMsgId || !seg.anchorMsgId.startsWith('msg_')) {
                        this.uiDebugChannel.appendLine(`[EXT][SEGMENT_INVARIANT_FAIL] reason=invalid-anchor-fallback-used noticeKey=${seg.noticeKey} fallbackAnchor=${anchorMsgId}`);
                    }
                    
                    // Get or create segment map for this session
                    let segMap = this.undoSegmentsBySession.get(sessionId);
                    if (!segMap) {
                        segMap = new Map<string, SegmentState>();
                        this.undoSegmentsBySession.set(sessionId, segMap);
                    }
                    
                    const beforeCount = segMap.size;
                    this.uiDebugChannel.appendLine(
                        `[EXT][SEG_UPSERT_RX] sessionId=${sessionId} noticeKey=${seg.noticeKey} ` +
                        `anchor=${anchorMsgId} end=${seg.endMsgId || anchorMsgId} members=${memberMsgIds.length}`
                    );

                    // Create/update segment
                    const previousSegment = segMap.get(seg.noticeKey);
                    const incomingRestoreAllowed = typeof seg.restoreAllowed === 'boolean' ? seg.restoreAllowed : undefined;
                    const nextRestoreAllowed = previousSegment?.restoreAllowed === false
                        ? false
                        : incomingRestoreAllowed;
                    if (previousSegment?.restoreAllowed === false && incomingRestoreAllowed === true) {
                        this.uiDebugChannel.appendLine(`[EXT][RESTORE_LOCK_MONOTONIC_FAIL] noticeKey=${seg.noticeKey} from=false to=true action=blocked`);
                    }
                    const segmentState: SegmentState = {
                        noticeKey: seg.noticeKey,
                        anchorMsgId: anchorMsgId,
                        endMsgId: seg.endMsgId || anchorMsgId,
                        memberMsgIds: memberMsgIds,
                        mergedInvalidSegments: Array.isArray(seg.mergedInvalidSegments)
                            ? seg.mergedInvalidSegments
                                .filter((child: SegmentState) => child && typeof child.noticeKey === 'string')
                                .map((child: SegmentState) => ({
                                    noticeKey: child.noticeKey,
                                    anchorMsgId: child.anchorMsgId,
                                    endMsgId: child.endMsgId,
                                    memberMsgIds: Array.isArray(child.memberMsgIds)
                                        ? child.memberMsgIds.filter((id: string) => typeof id === 'string' && id.startsWith('msg_'))
                                        : [],
                                    restoreAllowed: child.restoreAllowed,
                                    collapsed: child.collapsed,
                                    applied: child.applied,
                                    mergedInvalidSegments: [],
                                    createdAt: typeof child.createdAt === 'number' ? child.createdAt : Date.now(),
                                    updatedAt: typeof child.updatedAt === 'number' ? child.updatedAt : Date.now()
                                }))
                            : [],
                        applied: typeof seg.applied === 'boolean' ? seg.applied : undefined,
                        restoreAllowed: nextRestoreAllowed,
                        collapsed: typeof seg.collapsed === 'boolean' ? seg.collapsed : undefined,
                        createdAt: previousSegment?.createdAt || Date.now(),
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
                case "deleteSession": {
                    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
                    const opId = typeof data.opId === 'string' ? data.opId : '';
                    if (!sessionId) {
                        break;
                    }
                    const liveWebview = this._view?.webview || activeWebview;
                    liveWebview.postMessage({ type: 'sessionDeleteStarted', sessionId, opId });

                    try {
                        const children = await this.client.getSessionChildren(sessionId);
                        if (children.length > 0) {
                            this.uiDebugChannel.appendLine(
                                `[EXT][SESSION_DELETE_CHILDREN] sessionId=${sessionId} count=${children.length}`
                            );
                        }

                        let deletedOnServer = false;
                        try {
                            deletedOnServer = await this.client.deleteSession(sessionId);
                        } catch (error) {
                            const text = String(error || '');
                            if (/\b404\b/.test(text) || text.includes('NotFoundError')) {
                                deletedOnServer = true;
                            } else {
                                throw error;
                            }
                        }

                        if (!deletedOnServer) {
                            throw new Error('Delete session returned false');
                        }

                        await this.cleanupDeletedSessionArtifacts(sessionId);
                        await this.clearRecentSessionIfMatches(sessionId);

                        if (this.currentSessionId === sessionId) {
                            this.resetUiState();
                            this.currentSessionId = undefined;
                            this.client.setSessionId(undefined);
                        }

                        await this.refreshSessions(liveWebview, `delete-${Date.now()}`);
                        liveWebview.postMessage({ type: 'sessionDeleted', sessionId, opId });
                    } catch (error) {
                        this.uiDebugChannel.appendLine(
                            `[EXT][SESSION_DELETE_FAIL] sessionId=${sessionId} opId=${opId || 'null'} err=${String(error)}`
                        );
                        vscode.window.showErrorMessage(`Failed to delete session: ${error}`);
                        liveWebview.postMessage({
                            type: 'sessionDeleteFailed',
                            sessionId,
                            opId,
                            reason: String(error)
                        });
                    }
                    break;
                }
                case "selectSession": {
                    if (!data.sessionId) return;
                    const targetSessionId = data.sessionId;
                    const selectionEpoch = ++this.sessionSelectionEpoch;
                    try {
                        this.resetUiState();
                        let sessionDataSent = false;
                        this.currentSessionId = targetSessionId;
                        this.trackUserOwnedSession(this.currentSessionId);
                        this.client.setSessionId(this.currentSessionId);
                        const isCurrentSelection = () => (
                            this.currentSessionId === targetSessionId &&
                            this.sessionSelectionEpoch === selectionEpoch
                        );
                        const postSessionData = (payload: any, phase: 'snapshot' | 'recent' | 'full') => {
                            if (!isCurrentSelection()) {
                                this.uiDebugChannel.appendLine(
                                    `[EXT][SESSION_LOAD_STALE] sessionId=${targetSessionId} phase=${phase}`
                                );
                                return false;
                            }
                            const liveWebview = this._view?.webview || activeWebview;
                            liveWebview.postMessage({ ...payload, phase });
                            return true;
                        };
                            const workspaceFolder = this.client.getWorkspaceRoot() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                            if (workspaceFolder) {
                                const workspaceKey = this.getWorkspaceKeyForRoot(workspaceFolder);
                                await this._context.globalState.update(`recentSession.${workspaceKey}`, targetSessionId);
                            }
                        await this.ensureSessionUndoReady(targetSessionId, activeWebview);

                        const persisted = await this.loadPersistedSegment(targetSessionId);
                        if (persisted?.segment?.historySegments) {
                            this.revertedSegmentHistory = persisted.segment.historySegments;
                        } else {
                            this.revertedSegmentHistory = [];
                        }
                        if (persisted?.segment && persisted.segment.isActive === true && persisted.discarded !== true) {
                            this.client.setRevertedSegment({
                                isActive: true,
                                discarded: false,
                                startMessageId: persisted.segment.startMessageId || targetSessionId,
                                startMessageIndex: persisted.segment.startMessageIndex ?? 0,
                                endMessageId: persisted.segment.endMessageId || targetSessionId,
                                endMessageIndex: persisted.segment.endMessageIndex ?? (persisted.segment.startMessageIndex ?? 0),
                                opIds: persisted.segment.opIds || [],
                                collapsed: true,
                                conflicts: persisted.conflicts || [],
                                messageIds: persisted.segment.messageIds,
                                operationId: persisted.segment.operationId
                            });
                        } else {
                            this.client.setRevertedSegment(undefined);
                        }

                        const segMap = this.undoSegmentsBySession.get(targetSessionId);
                        this.syncClientRevertedSegmentFromUndoSegments(targetSessionId);
                        const segments = segMap ? Array.from(segMap.values()) : [];

                        let baseTitle = 'Session';
                        let baseMessages: SessionMessage[] = [];
                        let snapPayload: any = null;

                        const snapshotStart = Date.now();
                        try {
                            const snap = await this.readSnapshot(targetSessionId);
                            if (snap?.obj?.sessionData) {
                                snapPayload = snap.obj.sessionData;
                                const snapshotFormatted = await this.injectChangeLists(targetSessionId, {
                                    title: snapPayload.title || baseTitle,
                                    messages: Array.isArray(snapPayload.messages) ? snapPayload.messages : []
                                });
                                const snapshotMessages = snapshotFormatted.messages;
                                baseTitle = snapshotFormatted.title || baseTitle;
                                baseMessages = snapshotMessages;
                                const payload = {
                                    type: 'sessionData',
                                    sessionId: targetSessionId,
                                    title: baseTitle,
                                    messages: snapshotMessages,
                                    segments,
                                    meta: {
                                        ...(snapPayload.meta || {}),
                                        source: 'snapshot'
                                    }
                                };
                                const sent = postSessionData(payload, 'snapshot');
                                if (sent && snapshotMessages.length > 0) {
                                    sessionDataSent = true;
                                }
                                this.uiDebugChannel.appendLine(
                                    `[EXT][SNAP_LOAD_HIT] sessionId=${targetSessionId} file=${this.getSnapshotFile(targetSessionId)} bytes=${snap.bytes} costMs=${Date.now() - snapshotStart}`
                                );
                            } else {
                                this.uiDebugChannel.appendLine(
                                    `[EXT][SNAP_LOAD_MISS] sessionId=${targetSessionId} file=${this.getSnapshotFile(targetSessionId)} costMs=${Date.now() - snapshotStart}`
                                );
                            }
                        } catch (err) {
                            this.uiDebugChannel.appendLine(
                                `[EXT][SNAP_LOAD_FAIL] sessionId=${targetSessionId} err=${String(err)} costMs=${Date.now() - snapshotStart}`
                            );
                        }

                        if (sessionDataSent && Array.isArray(baseMessages) && baseMessages.length > 0) {
                            this.uiDebugChannel.appendLine(
                                `[EXT][SESSION_RECENT_SKIP] sessionId=${targetSessionId} reason=snapshot-authoritative messages=${baseMessages.length}`
                            );
                            break;
                        }

                        let recentFailedReason = '';
                        const recentStart = Date.now();
                        try {
                            const recentExport = await this.client.exportSessionRecent(targetSessionId, this.recentSessionLoadLimit);
                            if (!isCurrentSelection()) {
                                break;
                            }

                            const formattedRaw = this.formatSession(recentExport);
                            const formatted = await this.injectChangeLists(targetSessionId, formattedRaw);
                            if (!isCurrentSelection()) {
                                break;
                            }

                            if (formatted.title) {
                                baseTitle = formatted.title;
                            }

                            const snapshotIds = Array.isArray(snapPayload?.meta?.timelineMessageIds)
                                ? (snapPayload.meta.timelineMessageIds as string[]).filter((id): id is string => typeof id === 'string' && Boolean(id))
                                : [];
                            const snapshotIdSet = new Set<string>(snapshotIds);
                            const snapshotMaxMessageIndex = this.getMaxMessageIndex(baseMessages);
                            const appendCandidates = this.computeRecentAppendCandidates(snapshotIdSet, snapshotMaxMessageIndex, formatted.messages);
                            const appendMessages = this.enforceUserAssistantPairs(appendCandidates);
                            const mergedMessages = this.mergeSessionMessagesById(baseMessages, appendMessages);
                            const newIds = appendMessages
                                .map((message) => (typeof message?.id === 'string' ? message.id : ''))
                                .filter((id): id is string => Boolean(id));
                            const sessionPayload = {
                                type: 'sessionData',
                                sessionId: targetSessionId,
                                title: baseTitle,
                                messages: mergedMessages,
                                segments,
                                meta: {
                                    timelineMessageIds: [...snapshotIds, ...newIds]
                                }
                            };
                            const sent = postSessionData(sessionPayload, 'recent');
                            if (sent && mergedMessages.length > 0) {
                                sessionDataSent = true;
                                baseMessages = mergedMessages;
                            }

                            this.uiDebugChannel.appendLine(
                                `[EXT][SESSION_RECENT_OK] sessionId=${targetSessionId} limit=${this.recentSessionLoadLimit} merged=${mergedMessages.length} costMs=${Date.now() - recentStart}`
                            );

                            if (sent) {
                                this.uiDebugChannel.appendLine(`[EXT][SNAP_SAVE_SKIP] sessionId=${targetSessionId} reason=selectSession:recent disabled=incremental-only`);
                            }
                        } catch (err) {
                            recentFailedReason = this.extractLastLine(String(err));
                            this.uiDebugChannel.appendLine(
                                `[EXT][SESSION_RECENT_FAIL] sessionId=${targetSessionId} limit=${this.recentSessionLoadLimit} err=${recentFailedReason || 'null'} costMs=${Date.now() - recentStart}`
                            );
                        }

                        if (sessionDataSent || !isCurrentSelection()) {
                            break;
                        }

                        let normalized = { ok: false, data: null as any, stderrLastLine: '' };

                        try {
                            const exportResult = await this.client.exportSession(targetSessionId);
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
                            this.uiDebugChannel.appendLine(`[EXT][EXPORT_FAIL] sessionId=${targetSessionId} stderrLastLine=${normalized.stderrLastLine || recentFailedReason || 'null'}`);
                            const liveWebview = this._view?.webview || activeWebview;
                            liveWebview.postMessage({
                                type: 'sessionLoadFailed',
                                payload: {
                                    sessionId: targetSessionId,
                                    reason: 'export_failed_no_snapshot',
                                    stderrLastLine: normalized.stderrLastLine || recentFailedReason || ''
                                }
                            });
                            return;
                        }

                        const exportData = normalized.data;
                        const formattedRaw = this.formatSession(exportData);
                        const formatted = await this.injectChangeLists(targetSessionId, formattedRaw);

                        // this.uiDebugChannel.appendLine(
                        //     `[EXT][SEG_HYDRATE_LOAD] sessionId=${data.sessionId} found=${segments.length} ` +
                        //     `keys=[${(segMap ? Array.from(segMap.keys()) : []).join(', ')}]`
                        // );
                        // 
                        // this.uiDebugChannel.appendLine(
                        //     `[EXT][SEG_HYDRATE_SEND] sessionId=${data.sessionId} count=${segments.length} reason=selectSession`
                        // );
                        // 
                        // const timelineMsgCount = formatted.messages.filter((m) => typeof m.id === 'string' && m.id.startsWith('msg_')).length;
                        // this.uiDebugChannel.appendLine(
                        //     `sessionData.send | sessionId | ${data.sessionId} | messagesCount | ${formatted.messages.length} | ` +
                        //     `timelineMsgCount | ${timelineMsgCount} | segmentsCount | ${segments.length}`
                        // );

                        const sessionPayload = {
                            type: 'sessionData',
                            sessionId: targetSessionId,
                            title: formatted.title,
                            messages: formatted.messages,
                            segments,
                                meta: {
                                    timelineMessageIds: this.collectVisibleSnapshotMessages(formatted.messages)
                                        .map((message) => (typeof message?.id === 'string' ? message.id : ''))
                                        .filter((id): id is string => Boolean(id))
                                }
                            };
                        const sent = postSessionData(sessionPayload, 'full');
                        if (sent && formatted.messages.length > 0) {
                            sessionDataSent = true;
                        }
                        if (sent) {
                            this.uiDebugChannel.appendLine(`[EXT][SNAP_SAVE_SKIP] sessionId=${targetSessionId} reason=selectSession:full disabled=incremental-only`);
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
                case "selectAttachments": {
                    try {
                        const picks = await vscode.window.showOpenDialog({
                            canSelectMany: true,
                            canSelectFiles: true,
                            canSelectFolders: false,
                            openLabel: 'Add attachments'
                        });
                        if (!picks || !picks.length) break;
                        for (const uri of picks) {
                            const filePath = uri.fsPath;
                            const name = pathModule.basename(filePath);
                            const mime = this.getImageMimeFromName(name) || 'application/octet-stream';
                            let dataUrl: string | undefined;
                            if (this.isImageFileName(name)) {
                                try {
                                    const buffer = await fs.promises.readFile(filePath);
                                    dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
                                } catch (error) {
                                    this.uiDebugChannel.appendLine(`[EXT][ATTACH_READ_FAIL] file=${name} err=${String(error)}`);
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
                                sessionId: this.currentSessionId
                            });
                        }
                    } catch (error) {
                        vscode.window.showErrorMessage(`Failed to add attachments: ${error}`);
                        activeWebview.postMessage({ type: 'attachmentError', value: `Failed to add attachments: ${error}`, sessionId: this.currentSessionId });
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
                        const workspaceFolder = this.client.getWorkspaceRoot() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                        if (workspaceFolder) {
                            const workspaceKey = this.getWorkspaceKeyForRoot(workspaceFolder);
                            await this._context.globalState.update(`recentSession.${workspaceKey}`, undefined);
                        }
                    activeWebview.postMessage({ type: 'newSession', sessionId: this.currentSessionId });
                    if (this.gitUndoEnabled) {
                        this.pendingBaselineTurnKey = `baseline-${Date.now()}`;
                        this.pendingBaselineFailed = false;
                        activeWebview.postMessage({ type: 'baselineStatus', ready: false, message: 'Initializing Git baseline...' });
                        const baselineResult = await this.client.ensureBaselineForTurn(this.pendingBaselineTurnKey);
                        this.baselineReady = baselineResult.ok;
                        if (!baselineResult.ok) {
                            this.pendingBaselineFailed = true;
                            activeWebview.postMessage({ type: 'baselineStatus', ready: false, message: 'Git baseline failed. Undo unavailable.' });
                        } else {
                            activeWebview.postMessage({ type: 'baselineStatus', ready: true });
                        }
                    }
                    break;
                }
                case "undoToMessage": {
                    this.uiDebugChannel.appendLine(`[EXT][UNDO_CASE] messageId=${data.messageId || 'NULL'} checkFailed=${!data.messageId}`);
                    if (!data.messageId) {
                        this.uiDebugChannel.appendLine(`[EXT][UNDO_DROP] reason=no-messageId fullData=${JSON.stringify(data)}`);
                        return;
                    }
                    if (!this.gitUndoEnabled) {
                        this.postAddResponse(activeWebview, 'Undo unavailable: Git not installed or version too old. Please install/upgrade Git and restart VS Code.');
                        return;
                    }
                    if (!this.baselineReady) {
                        this.postAddResponse(activeWebview, 'Undo unavailable: Git baseline not ready.');
                        return;
                    }
                    try {
                        const sessionId = this.currentSessionId;
                        const operationId = typeof data.operationId === 'string' ? data.operationId : undefined;
                        const resolvedMessageId = this.clientMessageIdMap.get(data.messageId) || data.messageId;
                        const noticeKey = `system:undo:${resolvedMessageId}`;
                        this.uiDebugChannel.appendLine(`[EXT][UNDO_CALL] anchorMsgId=${resolvedMessageId} sessionId=${sessionId || 'null'} opId=${operationId || 'null'}`);
                        this.uiDebugChannel.appendLine(`[EXT][UNDO_RX] anchorMsgId=${data.messageId} resolvedMsgId=${resolvedMessageId} sessionId=${sessionId || 'null'} opId=${operationId || 'null'}`);
                        if (sessionId) {
                            this.clearClientRevertedSegmentIfNonRestorable(sessionId);
                        }
                        const previousSegment = this.client.getRevertedSegment();
                        const currentActiveNoticeKey = previousSegment?.startMessageId
                            ? `system:undo:${previousSegment.startMessageId}`
                            : undefined;
                        const undoRange = this.client.getUndoRangeForAnchor(resolvedMessageId);
                        const invalidMessageIds = sessionId && undoRange && undoRange.endIndex >= undoRange.startIndex
                            ? Array.from(this.getInvalidSegmentMessageIds(sessionId, {
                                currentNoticeKey: currentActiveNoticeKey,
                                rangeStartIndex: undoRange.startIndex,
                                rangeEndIndex: undoRange.endIndex
                            }))
                            : [];
                        const result = await this.client.undoFromMessage(resolvedMessageId, { excludedMessageIds: invalidMessageIds });
                        const currentSegment = this.client.getRevertedSegment();
                        this.uiDebugChannel.appendLine(`[EXT][UNDO_RESULT] applied=${result.applied} conflicts=${result.conflicts.length} touched=${result.touchedFiles.length} reason=${result.reason || 'null'} segmentStart=${currentSegment?.startMessageId || 'null'} segmentEnd=${currentSegment?.endMessageId || 'null'}`);
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
                                // conflictCard provides the user-facing prompt; no extra system message needed.
                                break;
                            }
                        if (!result.applied && !result.conflicts.length) {
                            this.uiDebugChannel.appendLine(`[EXT][UNDO_CLASSIFY] kind=noop-or-missing reason=${result.reason || 'unknown'} anchor=${resolvedMessageId}`);
                            const liveWebview = this._view?.webview || activeWebview;
                            const finalSessionId = sessionId || this.currentSessionId;
                            this.uiDebugChannel.appendLine(`[EXT][UNDO_TX] type=revertedSegment sessionId=${finalSessionId || 'null'} anchorMsgId=${resolvedMessageId} endMsgId=${resolvedMessageId} applied=false opId=${operationId || 'null'} reason=missing-startCommit-or-noop`);
                            liveWebview.postMessage({
                                type: 'revertedSegment',
                                conflicts: [],
                                segment: {
                                    isActive: false,
                                    startMessageId: resolvedMessageId,
                                    startMessageIndex: -1,
                                    endMessageId: resolvedMessageId,
                                    endMessageIndex: -1,
                                    collapsed: true,
                                    messageIds: [resolvedMessageId],
                                    operationId,
                                    applied: false
                                },
                                sessionId: finalSessionId,
                                operationId,
                                noticeKey
                            });
                            const reasonText = result.reason === 'missing-startCommit'
                                ? 'Undo failed: commit mapping for the selected message was not found.'
                                : result.reason === 'missing-headCommit'
                                    ? 'Undo failed: repository head commit is unavailable.'
                                    : 'Undo could not be applied for the selected range.';
                            this.postAddResponse(activeWebview, reasonText, { operationId });
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
                            const fallbackCommits = Array.isArray(segment.startCommits) && segment.startCommits.length
                                ? segment.startCommits
                                : (segment.startCommit ? [segment.startCommit] : []);
                            const commitsToMark = finalSessionId
                                ? await this.resolveChangeListCommits(finalSessionId, segment.messageIds, fallbackCommits)
                                : [];
                            if (finalSessionId && commitsToMark.length) {
                                for (const commitHash of commitsToMark) {
                                    await this.setChangeListReverted(finalSessionId, commitHash, true, liveWebview);
                                }
                            }
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
                    const cancelSessionId = typeof data.sessionId === 'string' ? data.sessionId : this.currentSessionId;
                    const shouldRollback = cancelSessionId
                        ? await this.promptCancelRollbackDecision(activeWebview, cancelSessionId)
                        : true;
                    const restoreLocalKey =
                        this.pendingClientMessageId
                        || (cancelSessionId
                            ? this.pendingLocalKeyBySession.get(cancelSessionId)
                            : undefined);
                    if (cancelSessionId && shouldRollback) {
                        await this.client.revertPendingTurnChangesToCurrentBase(cancelSessionId);
                        const canceledAt = Date.now();
                        const { userMsgId, assistantMsgId } = this.client.getPendingTurnMessageIds(cancelSessionId);
                        await this.upsertCanceledTurn(cancelSessionId, {
                            opId: typeof data.opId === 'string' ? data.opId : undefined,
                            localKey: this.pendingClientMessageId,
                            userMsgId,
                            assistantMsgId,
                            canceledAt
                        });
                    }
                    this.client.cancel();
                    const cancelOpId = typeof data.opId === 'string' ? data.opId : undefined;
                    if (cancelSessionId) {
                        const pendingLocalKey = this.pendingLocalKeyBySession.get(cancelSessionId);
                        if (pendingLocalKey) {
                            this.rawUserTextByLocalKey.delete(pendingLocalKey);
                        }
                        this.client.cancelTurn(cancelSessionId, cancelOpId);
                        this.sendInFlightBySession.delete(cancelSessionId);
                        this.pendingLocalKeyBySession.delete(cancelSessionId);
                        this.pendingAssistantTmpKeyBySession.delete(cancelSessionId);
                        activeWebview.postMessage({ type: 'turnInFlight', sessionId: cancelSessionId, inFlight: false });
                    }
                    if (this.pendingClientMessageId) {
                        await this.handleAbortedMessage(this.pendingClientMessageId, activeWebview);
                        const mappedUser = this.clientMessageIdMap.get(this.pendingClientMessageId);
                        if (mappedUser && mappedUser !== this.pendingClientMessageId) {
                            await this.handleAbortedMessage(mappedUser, activeWebview);
                        }
                        this.pendingClientMessageId = undefined;
                    }
                    if (this.currentSessionId) {
                        const tmpKey = this.pendingAssistantTmpKeyBySession.get(this.currentSessionId);
                        const mappedAssistant = tmpKey ? this.clientMessageIdMap.get(tmpKey) : undefined;
                        const pendingAssistant = this.pendingAssistantMessageIdBySession.get(this.currentSessionId);
                        if (tmpKey) {
                            await this.handleAbortedMessage(tmpKey, activeWebview);
                            this.pendingAssistantTmpKeyBySession.delete(this.currentSessionId);
                        }
                        if (pendingAssistant) {
                            await this.handleAbortedMessage(pendingAssistant, activeWebview);
                            this.pendingAssistantMessageIdBySession.delete(this.currentSessionId);
                        }
                        if (mappedAssistant && mappedAssistant !== tmpKey) {
                            await this.handleAbortedMessage(mappedAssistant, activeWebview);
                        }
                        this.assistantTextBufferBySession.delete(this.currentSessionId);
                    }
                    const draftToRestore = this.consumeDraft(restoreLocalKey);
                    if (draftToRestore) {
                        activeWebview.postMessage({
                            type: 'restoreDraft',
                            payload: draftToRestore
                        });
                    }
                    // Cleanup before chatDone
                    if (this.currentSessionId) {
                        await this.client.commitPendingTurnChanges(this.currentSessionId);
                    }
                    if (this.currentSessionId) {
                        this.client.finishTurn(this.currentSessionId);
                        this.postFinalWatchDiffFocusedBySession.delete(this.currentSessionId);
                    }
                    this.markAllSubagentsTerminal('cancelled', 'user-cancel');
                    this.emitSubagentStatus();
                    this.clearSubagentSessions();

                    const doneAssistantMsgId = this.currentSessionId
                        ? this.client.getTurnAssistantMsgId(this.currentSessionId)
                        : undefined;
                    activeWebview.postMessage({
                        type: 'chatDone',
                        sessionId: this.currentSessionId,
                        assistantMsgId: doneAssistantMsgId,
                        lastAssistantMsgId: doneAssistantMsgId
                    });
                    break;
                }
                case "restoreAll": {
                    this.uiDebugChannel.appendLine(`[EXT][RESTORE_RX] type=restoreAll sessionId=${this.currentSessionId || 'null'} noticeKey=${typeof data.noticeKey === 'string' ? data.noticeKey : 'null'}`);
                    try {
                        if (!this.gitUndoEnabled) {
                            this.postAddResponse(activeWebview, 'Restore unavailable: Git not installed or version too old. Please install/upgrade Git and restart VS Code.');
                            break;
                        }
                        const operationId = typeof data.operationId === 'string' ? data.operationId : undefined;
                        const currentSegment = this.client.getRevertedSegment();
                        const fallbackCommits = Array.isArray(currentSegment?.startCommits) && currentSegment?.startCommits?.length
                            ? currentSegment.startCommits
                            : (currentSegment?.startCommit ? [currentSegment.startCommit] : []);
                        const commitsToClear = this.currentSessionId
                            ? await this.resolveChangeListCommits(this.currentSessionId, currentSegment?.messageIds, fallbackCommits)
                            : fallbackCommits;
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
                            // conflictCard provides the user-facing prompt; no extra system message needed.
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
                        this.client.discardRevertedSegment();
                        const discardedSegment = this.client.getRevertedSegment();
                        activeWebview.postMessage({
                            type: 'revertedSegmentDiscarded',
                            segment: discardedSegment ? { ...discardedSegment, historySegments: this.revertedSegmentHistory } : discardedSegment,
                            sessionId: this.currentSessionId
                        });
                        if (this.currentSessionId) {
                            await this.clearPersistedSegment(this.currentSessionId);
                        }
                        if (this.currentSessionId && commitsToClear.length) {
                            for (const commitHash of commitsToClear) {
                                await this.setChangeListReverted(this.currentSessionId, commitHash, false, activeWebview);
                            }
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
                        const currentSegment = this.client.getRevertedSegment();
                        const segMap = this.undoSegmentsBySession.get(sessionId);
                        const persistedSegment = noticeKey ? segMap?.get(noticeKey) : undefined;
                        const messageIds = Array.isArray(persistedSegment?.memberMsgIds) && persistedSegment?.memberMsgIds?.length
                            ? persistedSegment.memberMsgIds
                            : (Array.isArray(currentSegment?.messageIds) ? currentSegment?.messageIds : []);
                        const restoreScope = this.buildRestoreMessageScope(sessionId, noticeKey, messageIds, persistedSegment);
                        const fallbackCommits = Array.isArray(currentSegment?.startCommits) && currentSegment?.startCommits?.length
                            ? currentSegment.startCommits
                            : (currentSegment?.startCommit ? [currentSegment.startCommit] : []);
                        const commitsToClear = sessionId
                            ? await this.resolveChangeListCommits(sessionId, restoreScope.activeRestoreMessageIds, fallbackCommits)
                            : fallbackCommits;
                            const result = await this.client.restoreFromMessage(anchorMsgId, endMsgId, {
                                messageIds: restoreScope.activeRestoreMessageIds,
                                excludedMessageIds: restoreScope.invalidMessageIds
                            });
                        const liveWebview = this._view?.webview || activeWebview;
                        this.uiDebugChannel.appendLine(`[EXT][RESTORE_TX] type=restoredSegment sessionId=${sessionId || 'null'} noticeKey=${noticeKey || 'null'} applied=${result.applied}`);
                        if (result.applied) {
                            await this.applyRestoreSegmentSuccess(
                                sessionId,
                                noticeKey,
                                anchorMsgId,
                                endMsgId,
                                result,
                                commitsToClear,
                                undefined,
                                liveWebview
                            );
                        } else if (result.conflicts.length) {
                            this.pendingConflict = { kind: 'restoreSegment', startMessageId: anchorMsgId, endMessageId: endMsgId, noticeKey };
                            liveWebview.postMessage({
                                type: 'conflictCard',
                                kind: 'restore',
                                conflicts: result.conflicts,
                                sessionId: sessionId
                            });
                            // conflictCard provides the user-facing prompt; no extra system message needed.
                        }
                    } catch (error) {
                        vscode.window.showErrorMessage(`Restore failed: ${error}`);
                        activeWebview.postMessage({ type: 'addResponse', value: `Restore failed: ${error}` });
                    }
                    break;
                }
                case "openGitDiff": {
                    if (!data.filePath || typeof data.filePath !== 'string') break;
                    if (!this.gitUndoEnabled) {
                        this.postAddResponse(activeWebview, 'Git diff unavailable: Git not installed or version too old.');
                        break;
                    }
                    try {
                        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : this.currentSessionId;
                        if (!sessionId) {
                            this.postAddResponse(activeWebview, 'No session available to open diff.');
                            break;
                        }
                        const commitHead = typeof data.commitHead === 'string' ? data.commitHead : undefined;
                        const commitBase = typeof data.commitBase === 'string' ? data.commitBase : undefined;
                        await this.openGitDiffForFile(sessionId, data.filePath, activeWebview, commitHead, commitBase);
                    } catch (error) {
                        vscode.window.showErrorMessage(`Open diff failed: ${error}`);
                        this.postAddResponse(activeWebview, `Open diff failed: ${error}`);
                    }
                    break;
                }
                case "toolResult": {
                    const sessionId = data.sessionId || this.currentSessionId;
                    const callId = typeof data.callId === 'string' ? data.callId : '';
                    if (!sessionId || !callId) {
                        this.uiDebugChannel.appendLine(
                            `EXT: toolResult.skip | sessionId=${sessionId || 'null'} | callId=${callId || 'null'}`
                        );
                        break;
                    }
                    try {
                        await this.client.sendToolResult({
                            sessionId,
                            callId,
                            requestId: typeof data.requestId === 'string' ? data.requestId : undefined,
                            result: data.result
                        });
                        this.uiDebugChannel.appendLine(`EXT: toolResult.sent | sessionId=${sessionId} | callId=${callId}`);
                    } catch (error) {
                        this.uiDebugChannel.appendLine(
                            `EXT: toolResult.fail | sessionId=${sessionId} | callId=${callId} | err=${String(error)}`
                        );
                    }
                    break;
                }
                case "localQuestionResult": {
                    const callId = typeof data.callId === 'string' ? data.callId : '';
                    const pending = callId ? this.pendingLocalQuestionRequests.get(callId) : undefined;
                    if (!pending) {
                        this.uiDebugChannel.appendLine(`EXT: localQuestionResult.skip | callId=${callId || 'null'} | reason=missing-pending`);
                        break;
                    }
                    this.pendingLocalQuestionRequests.delete(callId);
                    pending.resolve({
                        selectedId: typeof data?.result?.selectedId === 'string' ? data.result.selectedId : undefined,
                        selectedLabel: typeof data?.result?.selectedLabel === 'string' ? data.result.selectedLabel : undefined
                    });
                    this.uiDebugChannel.appendLine(`EXT: localQuestionResult.ok | sessionId=${pending.sessionId} | callId=${callId}`);
                    break;
                }
                case "permissionResult": {
                    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : this.currentSessionId;
                    const permissionId = typeof data.permissionId === 'string' ? data.permissionId : '';
                    const requestId = typeof data.requestId === 'string' ? data.requestId : '';
                    const response = data.response === 'always' || data.response === 'reject' ? data.response : 'once';
                    if (!sessionId) {
                        this.uiDebugChannel.appendLine('EXT: permissionResult.skip | reason=missing-session');
                        break;
                    }
                    const liveWebview = this._view?.webview || activeWebview;
                    try {
                        await this.client.respondPermission({
                            sessionId,
                            permissionId: permissionId || undefined,
                            requestId: requestId || undefined,
                            response
                        });
                        this.uiDebugChannel.appendLine(
                            `EXT: permissionResult.sent | sessionId=${sessionId} permissionId=${permissionId || requestId || 'null'} response=${response}`
                        );
                        liveWebview.postMessage({
                            type: 'permissionResultAck',
                            sessionId,
                            permissionId: permissionId || requestId || '',
                            response
                        });
                    } catch (error) {
                        this.uiDebugChannel.appendLine(
                            `EXT: permissionResult.fail | sessionId=${sessionId} permissionId=${permissionId || requestId || 'null'} err=${String(error)}`
                        );
                        liveWebview.postMessage({
                            type: 'permissionResultFailed',
                            sessionId,
                            permissionId: permissionId || requestId || '',
                            response,
                            reason: String(error)
                        });
                    }
                    break;
                }
                case "openFileAtLocation": {
                    const rawPath = typeof data.path === 'string' ? data.path.trim() : '';
                    const lineNum = Number.isFinite(Number(data.line)) ? Number(data.line) : 1;
                    const colNum = Number.isFinite(Number(data.col)) ? Number(data.col) : 1;
                    const line = Math.max(1, Math.floor(lineNum));
                    const col = Math.max(1, Math.floor(colNum));
                    if (!rawPath) {
                        this.uiDebugChannel.appendLine('EXT: openFileAtLocation | error=empty-path');
                        break;
                    }
                    const workspaceRoot = this.getWorkspaceRootPath();
                    const absPath = pathModule.isAbsolute(rawPath)
                        ? pathModule.resolve(rawPath)
                        : pathModule.resolve(pathModule.join(workspaceRoot, rawPath));
                    const normalizedRoot = pathModule.resolve(workspaceRoot);
                    const rel = pathModule.relative(normalizedRoot, absPath);
                    const outsideWorkspace = rel.startsWith('..') || pathModule.isAbsolute(rel);
                    if (outsideWorkspace) {
                        this.uiDebugChannel.appendLine(
                            `EXT: openFileAtLocation | path=${rawPath} | line=${line} | col=${col} | resolvedAbs=${absPath} | error=outside-workspace`
                        );
                        break;
                    }
                    try {
                        // Open .md files in preview mode
                        if (absPath.endsWith('.md')) {
                            await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(absPath));
                            this.uiDebugChannel.appendLine(
                                `EXT: openFileAtLocation | path=${rawPath} | resolvedAbs=${absPath} | opened in markdown preview`
                            );
                        } else {
                            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
                            const editor = await vscode.window.showTextDocument(doc, { preview: true });
                            const safeLine = Math.min(Math.max(line - 1, 0), Math.max(doc.lineCount - 1, 0));
                            const lineText = doc.lineAt(safeLine).text;
                            const safeCol = Math.min(Math.max(col - 1, 0), lineText.length);
                            const pos = new vscode.Position(safeLine, safeCol);
                            editor.selection = new vscode.Selection(pos, pos);
                            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
                            this.uiDebugChannel.appendLine(
                                `EXT: openFileAtLocation | path=${rawPath} | line=${line} | col=${col} | resolvedAbs=${absPath} | ok`
                            );
                        }
                    } catch (error) {
                        this.uiDebugChannel.appendLine(
                            `EXT: openFileAtLocation | path=${rawPath} | line=${line} | col=${col} | resolvedAbs=${absPath} | error=${String(error)}`
                        );
                    }
                    break;
                }
                case "conflictDecision": {
                    if (!this.pendingConflict || !data.decision) return;
                    const decision = data.decision as 'override' | 'skip' | 'continue' | 'cancel';
                    const conflictContext = this.pendingConflict;
                    this.pendingConflict = undefined;
                    if (decision === 'cancel' || decision === 'skip') {
                        // skip means abandon the operation; do nothing.
                        break;
                    }
                    try {
                        if (conflictContext.kind === 'undo' && conflictContext.startMessageId) {
                            if (this.currentSessionId) {
                                this.clearClientRevertedSegmentIfNonRestorable(this.currentSessionId);
                            }
                            const previousSegment = this.client.getRevertedSegment();
                            const currentActiveNoticeKey = previousSegment?.startMessageId
                                ? `system:undo:${previousSegment.startMessageId}`
                                : undefined;
                            const undoRange = this.client.getUndoRangeForAnchor(conflictContext.startMessageId);
                            const invalidMessageIds = this.currentSessionId && undoRange && undoRange.endIndex >= undoRange.startIndex
                                ? Array.from(this.getInvalidSegmentMessageIds(this.currentSessionId, {
                                    currentNoticeKey: currentActiveNoticeKey,
                                    rangeStartIndex: undoRange.startIndex,
                                    rangeEndIndex: undoRange.endIndex
                                }))
                                : [];
                            const result = await this.client.undoFromMessage(conflictContext.startMessageId, { force: true, excludedMessageIds: invalidMessageIds });
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
                            this.postAddResponse(activeWebview, 'Undo applied.', { operationId: conflictContext.operationId });
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
                            this.client.discardRevertedSegment();
                            const discardedSegment = this.client.getRevertedSegment();
                            activeWebview.postMessage({
                                type: 'revertedSegmentDiscarded',
                                segment: discardedSegment ? { ...discardedSegment, historySegments: this.revertedSegmentHistory } : discardedSegment,
                                sessionId: this.currentSessionId
                            });
                            if (this.currentSessionId) {
                                await this.clearPersistedSegment(this.currentSessionId);
                            }
                            this.postAddResponse(activeWebview, 'Restore applied.', { operationId: conflictContext.operationId });
                            this.refreshDiffIfTouched(result.touchedFiles);
                        }
                        if (conflictContext.kind === 'restoreSegment' && conflictContext.startMessageId) {
                            const currentSegment = this.client.getRevertedSegment();
                            const segMap = this.undoSegmentsBySession.get(this.currentSessionId || '');
                            const persistedSegment = conflictContext.noticeKey ? segMap?.get(conflictContext.noticeKey) : undefined;
                            const messageIds = Array.isArray(persistedSegment?.memberMsgIds) && persistedSegment?.memberMsgIds?.length
                                ? persistedSegment.memberMsgIds
                                : (Array.isArray(currentSegment?.messageIds) ? currentSegment?.messageIds : []);
                            const restoreScope = this.currentSessionId
                                ? this.buildRestoreMessageScope(this.currentSessionId, conflictContext.noticeKey, messageIds, persistedSegment)
                                : { restoreMessageIds: messageIds, invalidMessageIds: [], activeRestoreMessageIds: messageIds };
                            const result = await this.client.restoreFromMessage(
                                conflictContext.startMessageId,
                                conflictContext.endMessageId,
                                {
                                    force: true,
                                    messageIds: restoreScope.activeRestoreMessageIds,
                                    excludedMessageIds: restoreScope.invalidMessageIds
                                }
                            );
                            if (this.currentSessionId && conflictContext.noticeKey) {
                                const currentSegment = this.client.getRevertedSegment();
                            const fallbackCommits = Array.isArray(currentSegment?.startCommits) && currentSegment?.startCommits?.length
                                ? currentSegment.startCommits
                                : (currentSegment?.startCommit ? [currentSegment.startCommit] : []);
                            const commitsToClear = this.currentSessionId
                                ? await this.resolveChangeListCommits(this.currentSessionId, restoreScope.activeRestoreMessageIds, fallbackCommits)
                                : fallbackCommits;
                                await this.applyRestoreSegmentSuccess(
                                    this.currentSessionId,
                                    conflictContext.noticeKey,
                                    conflictContext.startMessageId,
                                    conflictContext.endMessageId,
                                    result,
                                    commitsToClear,
                                    conflictContext.operationId,
                                    activeWebview
                                );
                            }
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
                case "snapshotTimelineIds": {
                    await this.handleSnapshotTimelineIds(data.payload);
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

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible && this.initPosted) {
                this.initPosted = false;
                this.uiDebugChannel.appendLine('[EXT][INIT_RESET] Webview visible after hidden, resetting initPosted');
            }
        });
    }

    private async sendInit(webview: vscode.Webview): Promise<void> {
        this.uiDebugChannel.appendLine(`[EXT][SENDINIT_START] initPosted=${this.initPosted}`);
        let models: ModelInfo[] = [];
        let agents: AgentInfo[] = [];
        let sessions: SessionInfo[] = [];
        try {
            models = await this.client.listModels();
            if (models.length) {
                this.lastKnownModels = models;
            }
        } catch (error) {
            this.postAddResponse(webview, `Failed to load models: ${error}`);
        }

        try {
            agents = await this.client.listAgents();
        } catch (error) {
            this.uiDebugChannel.appendLine(`EXT: agents.load.fail | err=${String(error)}`);
        }

        try {
            sessions = await this.client.listSessions();
        } catch (error) {
            this.postAddResponse(webview, `Failed to load sessions: ${error}`);
        }
        const initWorkspaceRoot = this.client.getWorkspaceRoot() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        sessions = await this.filterSessionsForWorkspace(sessions, initWorkspaceRoot, 'init');
        const storedModel = this._context.globalState.get<string>('opencode.model');
        const storedVariant = this._context.globalState.get<string>('opencode.variant');
        const storedMode = this._context.globalState.get<string>('opencode.mode');

        const allModes = agents
            // Keep primary agents visible in the mode picker; only hidden agents stay excluded.
            .filter((agent) => !agent.hidden && (agent.mode === 'all' || agent.mode === 'primary'))
            .map((agent) => agent.id)
            .filter((value, index, arr) => arr.indexOf(value) === index);
        const mergedModes = ['plan', 'build', ...allModes]
            .filter((value, index, arr) => arr.indexOf(value) === index);
        this.availableModes = mergedModes.length ? mergedModes : ['plan', 'build'];
        const resolvedMode = (storedMode && this.availableModes.includes(storedMode))
            ? storedMode
            : (this.availableModes.includes('plan') ? 'plan' : this.availableModes[0]);

        this.selectedMode = resolvedMode;

        if (!models.length) {
            const refreshed = await this.refreshModels(webview);
            if (refreshed.length) {
                models = refreshed;
            } else if (this.lastKnownModels.length) {
                models = this.lastKnownModels;
            }
        }

        const modelMap = new Map(models.map((model) => [model.fullId, model]));
        let resolvedModel = storedModel;
        if (!resolvedModel || !modelMap.has(resolvedModel)) {
            resolvedModel = models[0]?.fullId;
        }

        let resolvedVariant = storedVariant || undefined;
        const resolvedModelInfo = resolvedModel ? modelMap.get(resolvedModel) : undefined;
        const variants = resolvedModelInfo?.variants || [];
        if (resolvedVariant && !variants.includes(resolvedVariant)) {
            resolvedVariant = undefined;
        }

        this.selectedModel = resolvedModel;
        this.selectedVariant = resolvedVariant;

        if (resolvedModel && resolvedModel !== storedModel) {
            await this._context.globalState.update('opencode.model', resolvedModel);
        }
        if ((resolvedVariant || '') !== (storedVariant || '')) {
            await this._context.globalState.update('opencode.variant', resolvedVariant);
        }
        if ((resolvedMode || '') !== (storedMode || '')) {
            await this._context.globalState.update('opencode.mode', resolvedMode);
        }
        this.uiDebugChannel.appendLine(
            `[EXT][INIT_MODEL_RESOLVE] models=${models.length} storedModel=${storedModel || 'null'} selectedModel=${resolvedModel || 'null'} storedVariant=${storedVariant || 'null'} selectedVariant=${resolvedVariant || 'null'}`
        );
        this.uiDebugChannel.appendLine(
            `EXT: mode.init | stored=${storedMode || 'null'} | selected=${resolvedMode || 'null'} | available=${this.availableModes.join(',') || 'none'}`
        );

        const workspaceRoot = initWorkspaceRoot;
        const workspaceCount = vscode.workspace.workspaceFolders?.length || 0;
        if (workspaceRoot) {
            this.currentWorkspaceKey = this.getWorkspaceKeyForRoot(workspaceRoot);
        }
        this.uiDebugChannel.appendLine(
            `EXT: workspace.root.select | mode=first-folder | root=${workspaceRoot || 'null'} | count=${workspaceCount}`
        );

        const workspaceFolder = workspaceRoot;
        let recentSessionId: string | undefined;
        if (workspaceFolder) {
            const workspaceKey = this.getWorkspaceKeyForRoot(workspaceFolder);
            recentSessionId = this._context.globalState.get<string>(`recentSession.${workspaceKey}`);
        }
        if (workspaceFolder && recentSessionId) {
            const recentMatch = await this.getSessionWorkspaceMatch(recentSessionId, workspaceFolder);
            if (recentMatch === 'mismatch') {
                this.uiDebugChannel.appendLine(
                    `[EXT][RECENT_SESSION_SKIP] sessionId=${recentSessionId} reason=workspace-mismatch workspace=${workspaceFolder}`
                );
                recentSessionId = undefined;
            } else if (recentMatch === 'unknown') {
                this.uiDebugChannel.appendLine(
                    `[EXT][RECENT_SESSION_ACCEPT] sessionId=${recentSessionId} reason=trusted-recent-missing-cwd workspace=${workspaceFolder}`
                );
            }
        }

        let initSessionCandidate = recentSessionId;
        if (!initSessionCandidate && workspaceFolder) {
            const workspaceRecent = await this.findMostRecentWorkspaceSession(sessions, workspaceFolder);
            initSessionCandidate = workspaceRecent?.id;
        }

        if (!this.initPosted) {
            this.currentSessionId = this.currentSessionId || initSessionCandidate || undefined;
            if (this.currentSessionId) {
                this.client.setSessionId(this.currentSessionId);
            }
            const initSessionId = initSessionCandidate || this.currentSessionId || '';
            const liveWebview = this._view?.webview || webview;
            this.uiDebugChannel.appendLine(
                `[EXT][INIT_SEND] models=${models.length} sessions=${sessions.length} ` +
                `currentSessionId=${initSessionId || 'null'} selectedModel=${this.selectedModel || 'NULL'} selectedMode=${resolvedMode || 'null'} modeCount=${this.availableModes.length}`
            );

            liveWebview.postMessage({
                type: 'init',
                models,
                sessions,
                modes: this.availableModes,
                selectedModel: this.selectedModel,
                selectedVariant: this.selectedVariant,
                selectedMode: resolvedMode,
                currentSessionId: initSessionId,
                sessionId: initSessionId
            });
            if (initSessionId) {
                liveWebview.postMessage({
                    type: 'turnInFlight',
                    sessionId: initSessionId,
                    inFlight: this.sendInFlightBySession.has(initSessionId)
                });
            }

            await this.postModelQuota(liveWebview, 'init');

            liveWebview.postMessage({
                type: 'gitUndoAvailability',
                enabled: this.gitUndoEnabled,
                reason: this.gitUndoReason
            });

            this.sendServerStatus(this.serverStatus, 'init');

            this.initPosted = true;
        }

        let snapshotLoaded = false;
        let sessionDataSent = false;
                if (recentSessionId) {
                    try {
                        this.currentSessionId = recentSessionId;
                        this.trackUserOwnedSession(this.currentSessionId);
                        this.client.setSessionId(this.currentSessionId);
                        const liveWebview = this._view?.webview || webview;
                        try {
                            await this.ensureSessionUndoReady(recentSessionId, liveWebview);
                        } catch (err) {
                            this.uiDebugChannel.appendLine(`[EXT][UNDO_WARN] ensureSessionUndoReady failed for ${recentSessionId}: ${err}`);
                        }

                        const persisted = await this.loadPersistedSegment(recentSessionId);
                        if (persisted?.segment?.historySegments) {
                            this.revertedSegmentHistory = persisted.segment.historySegments;
                        } else {
                            this.revertedSegmentHistory = [];
                        }
                        if (persisted?.segment && persisted.segment.isActive === true && persisted.discarded !== true) {
                            this.client.setRevertedSegment({
                                isActive: true,
                                discarded: false,
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
                        } else {
                            this.client.setRevertedSegment(undefined);
                        }

                        const segMap = this.undoSegmentsBySession.get(recentSessionId);
                        this.syncClientRevertedSegmentFromUndoSegments(recentSessionId);
                        const segments = segMap ? Array.from(segMap.values()) : [];

                        let baseTitle = 'Session';
                        let baseMessages: SessionMessage[] = [];
                        let snapshotTimelineIds: string[] = [];

                        try {
                            const snap = await this.readSnapshot(recentSessionId);
                            if (snap?.obj?.sessionData) {
                                const snapshotFormatted = await this.injectChangeLists(recentSessionId, {
                                    title: snap.obj.sessionData?.title || baseTitle,
                                    messages: Array.isArray(snap.obj.sessionData?.messages)
                                        ? snap.obj.sessionData.messages
                                        : []
                                });
                                baseTitle = snapshotFormatted.title || baseTitle;
                                baseMessages = snapshotFormatted.messages;
                                snapshotTimelineIds = Array.isArray(snap.obj.sessionData?.meta?.timelineMessageIds)
                                    ? (snap.obj.sessionData.meta.timelineMessageIds as string[])
                                        .filter((id): id is string => typeof id === 'string' && Boolean(id))
                                    : this.collectVisibleSnapshotMessages(baseMessages)
                                        .map((message) => (typeof message?.id === 'string' ? message.id : ''))
                                        .filter((id): id is string => Boolean(id));

                                const snapshotPayload = {
                                    type: 'sessionData',
                                    sessionId: recentSessionId,
                                    title: baseTitle,
                                    messages: baseMessages,
                                    segments,
                                    meta: {
                                        ...(snap.obj.sessionData?.meta || {}),
                                        source: 'snapshot',
                                        timelineMessageIds: snapshotTimelineIds
                                    }
                                };
                                liveWebview.postMessage(snapshotPayload);
                                if (baseMessages.length > 0) {
                                    sessionDataSent = true;
                                }
                                snapshotLoaded = true;
                                this.uiDebugChannel.appendLine(`[EXT][SNAP_LOAD_HIT] sessionId=${recentSessionId} file=${this.getSnapshotFile(recentSessionId)} bytes=${snap.bytes}`);
                            } else {
                                this.uiDebugChannel.appendLine(`[EXT][SNAP_LOAD_MISS] sessionId=${recentSessionId} file=${this.getSnapshotFile(recentSessionId)}`);
                            }
                        } catch (err) {
                            this.uiDebugChannel.appendLine(`[EXT][SNAP_LOAD_FAIL] sessionId=${recentSessionId} err=${String(err)}`);
                        }

                        try {
                            const recentExport = await this.client.exportSessionRecent(recentSessionId, this.recentSessionLoadLimit);
                            const formattedRaw = this.formatSession(recentExport);
                            const formatted = await this.injectChangeLists(recentSessionId, formattedRaw);
                            if (formatted.title) {
                                baseTitle = formatted.title;
                            }

                            const snapshotIdSet = new Set<string>(snapshotTimelineIds);
                            const snapshotMaxMessageIndex = this.getMaxMessageIndex(baseMessages);
                            const appendCandidates = this.computeRecentAppendCandidates(snapshotIdSet, snapshotMaxMessageIndex, formatted.messages);
                            const appendMessages = this.enforceUserAssistantPairs(appendCandidates);
                            const mergedMessages = this.mergeSessionMessagesById(baseMessages, appendMessages);
                            const newIds = appendMessages
                                .map((message) => (typeof message?.id === 'string' ? message.id : ''))
                                .filter((id): id is string => Boolean(id));
                            const timelineIds = [...snapshotTimelineIds, ...newIds];

                            const timelineMsgCount = mergedMessages.filter((m) => typeof m.id === 'string' && m.id.startsWith('msg_')).length;
                            this.uiDebugChannel.appendLine(
                                `sessionData.send | sessionId | ${recentSessionId} | messagesCount | ${mergedMessages.length} | ` +
                                `timelineMsgCount | ${timelineMsgCount} | segmentsCount | ${segments.length}`
                            );

                            const sessionPayload = {
                                type: 'sessionData',
                                sessionId: recentSessionId,
                                title: baseTitle,
                                messages: mergedMessages,
                                segments,
                                meta: {
                                    timelineMessageIds: timelineIds
                                }
                            };
                            liveWebview.postMessage(sessionPayload);
                            if (mergedMessages.length > 0) {
                                sessionDataSent = true;
                            }
                            this.uiDebugChannel.appendLine(`[EXT][SNAP_SAVE_SKIP] sessionId=${recentSessionId} reason=sendInit:recent disabled=incremental-only`);
                        } catch (err) {
                            const recentErr = this.extractLastLine(String(err));
                            this.uiDebugChannel.appendLine(`[EXT][SESSION_RECENT_FAIL] sessionId=${recentSessionId} limit=${this.recentSessionLoadLimit} err=${recentErr || 'null'}`);

                            if (!snapshotLoaded) {
                                const liveWebview = this._view?.webview || webview;
                                liveWebview.postMessage({
                                    type: 'sessionLoadFailed',
                                    payload: {
                                        sessionId: recentSessionId,
                                        reason: 'recent_failed_no_snapshot',
                                        stderrLastLine: recentErr || ''
                                    }
                                });
                                return;
                            }
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
                let mostRecent: SessionInfo | undefined;
                if (workspaceFolder) {
                    mostRecent = await this.findMostRecentWorkspaceSession(sessions, workspaceFolder);
                    this.uiDebugChannel.appendLine(
                        `[EXT][SESSION_FILTER_RESULT] workspace=${workspaceFolder} total=${sessions.length} matched=${mostRecent ? 1 : 0}`
                    );
                } else {
                    mostRecent = sessions[0];
                }

                if (!mostRecent) {
                    this.uiDebugChannel.appendLine('[EXT][AUTO_SELECT_SKIP] reason=no-workspace-session-match');
                } else {
                    this.currentSessionId = mostRecent.id;
                    this.trackUserOwnedSession(this.currentSessionId);
                    this.client.setSessionId(this.currentSessionId);
                    this.uiDebugChannel.appendLine(`[EXT][AUTO_SELECT] sessionId=${this.currentSessionId} reason=no-current-session`);
                
                    // Save as recent session for this workspace
                    if (workspaceFolder) {
                        const workspaceKey = this.getWorkspaceKeyForRoot(workspaceFolder);
                        await this._context.globalState.update(`recentSession.${workspaceKey}`, this.currentSessionId);
                    }
                
                    // Try to load this session's data
                    try {
                        const exportResult = await this.client.exportSession(this.currentSessionId);
                        const segMap = this.undoSegmentsBySession.get(this.currentSessionId);
                        const segments = segMap ? Array.from(segMap.values()) : [];
                        const formattedRaw = this.formatSession(exportResult);
                        const formatted = await this.injectChangeLists(this.currentSessionId, formattedRaw);

                        const liveWebview = this._view?.webview || webview;
                        liveWebview.postMessage({
                            type: 'sessionData',
                            sessionId: this.currentSessionId,
                            title: formatted.title,
                            messages: formatted.messages,
                            segments: segments,
                            meta: {
                                timelineMessageIds: this.collectVisibleSnapshotMessages(formatted.messages)
                                    .map((message) => (typeof message?.id === 'string' ? message.id : ''))
                                    .filter((id): id is string => Boolean(id))
                            }
                        });
                        this.uiDebugChannel.appendLine(`[EXT][AUTO_SELECT_LOADED] sessionId=${this.currentSessionId} messages=${formatted.messages.length}`);
                    } catch (err) {
                        this.uiDebugChannel.appendLine(`[EXT][AUTO_SELECT_LOAD_FAILED] sessionId=${this.currentSessionId} err=${String(err)}`);
                        // Try snapshot as fallback
                        try {
                            const snap = await this.readSnapshot(this.currentSessionId);
                            if (snap?.obj?.sessionData) {
                                const segMap = this.undoSegmentsBySession.get(this.currentSessionId);
                                const segments = segMap ? Array.from(segMap.values()) : [];
                                const snapshotFormatted = await this.injectChangeLists(this.currentSessionId, {
                                    title: snap.obj.sessionData?.title || 'Session',
                                    messages: Array.isArray(snap.obj.sessionData?.messages)
                                        ? snap.obj.sessionData.messages
                                        : []
                                });
                                const liveWebview = this._view?.webview || webview;
                                liveWebview.postMessage({
                                    ...snap.obj.sessionData,
                                    title: snapshotFormatted.title,
                                    messages: snapshotFormatted.messages,
                                    segments
                                });
                                this.uiDebugChannel.appendLine(`[EXT][AUTO_SELECT_SNAP_OK] sessionId=${this.currentSessionId}`);
                            }
                        } catch (snapErr) {
                            this.uiDebugChannel.appendLine(`[EXT][AUTO_SELECT_SNAP_FAILED] sessionId=${this.currentSessionId}`);
                        }
                    }
                }

            }

            if (!this.currentSessionId) {
                // No sessions exist - create new one
                this.uiDebugChannel.appendLine(`[EXT][CREATE_NEW_SESSION] reason=${sessions.length > 0 ? 'no-workspace-session-match' : 'no-sessions-exist'}`);
                try {
                    const newSession = await this.client.createSession();
                    this.currentSessionId = newSession.id;
                    this.trackUserOwnedSession(this.currentSessionId);
                    this.client.setSessionId(this.currentSessionId);
                    this.uiDebugChannel.appendLine(`[EXT][SESSION_CREATED] sessionId=${this.currentSessionId}`);
                    
                    // Save as recent session
                    if (workspaceFolder) {
                        const workspaceKey = this.getWorkspaceKeyForRoot(workspaceFolder);
                        await this._context.globalState.update(`recentSession.${workspaceKey}`, this.currentSessionId);
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

        const liveWebview = this._view?.webview || webview;

        const shouldInitBaseline = Boolean(
            this.gitUndoEnabled &&
            !recentSessionId &&
            sessions.length === 0 &&
            this.currentSessionId
        );
        if (shouldInitBaseline) {
            this.pendingBaselineTurnKey = `baseline-${Date.now()}`;
            this.pendingBaselineFailed = false;
            liveWebview.postMessage({ type: 'baselineStatus', ready: false, message: 'Initializing Git baseline...' });
            let baselineResult: { ok: boolean } = { ok: false };
            try {
                baselineResult = await this.client.ensureBaselineForTurn(this.pendingBaselineTurnKey);
            } catch (err) {
                this.uiDebugChannel.appendLine(`[EXT][BASELINE_WARN] ensureBaselineForTurn failed: ${err}`);
            }
            this.baselineReady = baselineResult.ok;
            if (!baselineResult.ok) {
                this.pendingBaselineFailed = true;
                liveWebview.postMessage({ type: 'baselineStatus', ready: false, message: 'Git baseline failed. Undo unavailable.' });
            } else {
                liveWebview.postMessage({ type: 'baselineStatus', ready: true });
            }
            if (this.currentSessionId) {
                this.setSessionUndoEnabled(this.currentSessionId, baselineResult.ok, liveWebview);
            }
        }

        this.uiDebugChannel.appendLine(`[EXT][SENDINIT_END] sendInit completed successfully`);
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

    private isImageFileName(name: string): boolean {
        const lower = String(name || '').toLowerCase();
        if (!lower) return false;
        const ext = pathModule.extname(lower);
        return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.tif', '.tiff', '.ico', '.heic'].includes(ext)
            || lower.startsWith('img-')
            || lower.startsWith('image-');
    }

    private getImageMimeFromName(name: string): string | undefined {
        const ext = pathModule.extname(String(name || '')).toLowerCase();
        switch (ext) {
            case '.png':
                return 'image/png';
            case '.jpg':
            case '.jpeg':
                return 'image/jpeg';
            case '.gif':
                return 'image/gif';
            case '.webp':
                return 'image/webp';
            case '.bmp':
                return 'image/bmp';
            case '.svg':
                return 'image/svg+xml';
            case '.tif':
            case '.tiff':
                return 'image/tiff';
            case '.ico':
                return 'image/x-icon';
            case '.heic':
                return 'image/heic';
            default:
                return undefined;
        }
    }

    private getMimeFromName(name: string): string {
        const ext = pathModule.extname(String(name || '')).toLowerCase();
        if (ext) {
            const imageMime = this.getImageMimeFromName(name);
            if (imageMime) return imageMime;
        }
        switch (ext) {
            case '.txt':
                return 'text/plain';
            case '.md':
            case '.markdown':
                return 'text/markdown';
            case '.ts':
            case '.tsx':
            case '.js':
            case '.jsx':
            case '.mjs':
            case '.cjs':
            case '.py':
            case '.java':
            case '.c':
            case '.h':
            case '.cpp':
            case '.cxx':
            case '.cc':
            case '.hpp':
            case '.cs':
            case '.go':
            case '.rs':
            case '.rb':
            case '.php':
            case '.swift':
            case '.kt':
            case '.kts':
            case '.scala':
            case '.sh':
            case '.bash':
            case '.zsh':
            case '.ps1':
            case '.bat':
            case '.cmd':
            case '.sql':
            case '.yaml':
            case '.yml':
            case '.toml':
            case '.ini':
            case '.env':
            case '.gitignore':
            case '.dockerignore':
            case '.css':
            case '.scss':
            case '.less':
            case '.html':
            case '.htm':
            case '.vue':
            case '.svelte':
            case '.xml':
                return 'text/plain';
            case '.json':
                return 'application/json';
            case '.pdf':
                return 'application/pdf';
            case '.csv':
                return 'text/csv';
            default:
                return 'application/octet-stream';
        }
    }

    private getExtFromMime(mime: string): string {
        switch (mime) {
            case 'image/png':
                return 'png';
            case 'image/jpeg':
                return 'jpg';
            case 'image/gif':
                return 'gif';
            case 'image/webp':
                return 'webp';
            case 'image/bmp':
                return 'bmp';
            case 'image/svg+xml':
                return 'svg';
            case 'image/tiff':
                return 'tiff';
            case 'image/x-icon':
                return 'ico';
            case 'image/heic':
                return 'heic';
            case 'text/plain':
                return 'txt';
            case 'text/markdown':
                return 'md';
            case 'application/json':
                return 'json';
            case 'application/pdf':
                return 'pdf';
            case 'text/csv':
                return 'csv';
            case 'application/xml':
                return 'xml';
            default:
                return 'bin';
        }
    }

    private sanitizeFilename(name: string): string {
        const base = pathModule.basename(String(name || '').trim());
        const sanitized = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-');
        if (!sanitized || sanitized === '.' || sanitized === '..') {
            return 'attachment';
        }
        return sanitized;
    }

    private getAttachmentsRootPath(): string | null {
        const workspaceRoot = this.getWorkspaceRootPath();
        if (!workspaceRoot) return null;
        return pathModule.join(workspaceRoot, '.opencode', 'attachments');
    }

    private buildAttachmentManifest(saved: SavedAttachment[]): string {
        if (!saved.length) return '';
        const lines = ['---', 'Attachments (workspace files; read from disk; DO NOT use any URL):'];
        for (const item of saved) {
            lines.push(`- ${item.filename} | mime=${item.mime} | size=${item.sizeBytes} | path=${item.relPath}`);
        }
        lines.push('');
        lines.push('Authorization (IMPORTANT):');
        lines.push('- You are explicitly authorized to read ALL files listed above.');
        lines.push('- Access is READ-ONLY.');
        lines.push('- Access is strictly limited to the listed attachment paths.');
        lines.push('- Do NOT ask for confirmation before reading them.');
        lines.push('');
        lines.push('Instructions:');
        lines.push('- Read the listed attachments as needed to complete the task.');
        lines.push('- If an attachment is an image/screenshot, you may read it and extract information.');
        lines.push('- If OCR/parsing is needed, do so in read-only mode and report the extracted text/summary.');
        lines.push('---');
        return lines.join('\n');
    }

    private buildContextBlock(contextItems: Array<{ displayText?: string; text?: string; source?: string; filePath?: string; range?: { startLine?: number; endLine?: number } }>): string {
        if (!contextItems.length) return '';
        const blocks: string[] = [];
        for (let i = 0; i < contextItems.length; i += 1) {
            const item = contextItems[i];
            const text = typeof item?.text === 'string' ? item.text : '';
            if (!text) continue;
            const label = typeof item?.displayText === 'string' && item.displayText
                ? item.displayText
                : (item?.source === 'output' ? 'vscode output' : 'editor selection');
            const source = item?.source === 'output' ? 'VS Code Output' : 'Editor Selection';
            blocks.push(`---\n[Context ${i + 1}] ${label} (${source})\n${text}`);
        }
        if (!blocks.length) return '';
        return `Context:\n${blocks.join('\n')}`;
    }

    private async saveAttachment(sessionId: string, attachment: AttachmentPayload, reqId: string): Promise<SavedAttachment | null> {
        const workspaceRoot = this.getWorkspaceRootPath();
        if (!workspaceRoot) {
            this.uiDebugChannel.appendLine(`EXT: attach.save.fail | reqId=${reqId} | filename=${attachment?.filename || 'unknown'} | mime=${attachment?.mime || 'unknown'} | err=no-workspace`);
            return null;
        }
        const attachmentsRoot = this.getAttachmentsRootPath();
        if (!attachmentsRoot) {
            this.uiDebugChannel.appendLine(`EXT: attach.save.fail | reqId=${reqId} | filename=${attachment?.filename || 'unknown'} | mime=${attachment?.mime || 'unknown'} | err=no-attachments-root`);
            return null;
        }

        const token = crypto.randomBytes(8).toString('hex');
        const inputName = typeof attachment?.filename === 'string' ? attachment.filename : '';
        const fallbackMime = inputName ? this.getMimeFromName(inputName) : 'application/octet-stream';
        const mime = typeof attachment?.mime === 'string' && attachment.mime ? attachment.mime : fallbackMime;
        let filename = inputName ? this.sanitizeFilename(inputName) : '';
        if (!filename) {
            const ext = this.getExtFromMime(mime);
            filename = `attachment-${Date.now()}.${ext}`;
        }

        const dataBase64 = typeof attachment?.dataBase64 === 'string' ? attachment.dataBase64 : '';
        const tempPath = typeof attachment?.tempPath === 'string' ? attachment.tempPath : '';
        if (!dataBase64 && !tempPath) {
            this.uiDebugChannel.appendLine(`EXT: attach.skip | reqId=${reqId} | reason=missing-data | filename=${filename} | mime=${mime}`);
            return null;
        }

        const targetDir = pathModule.join(attachmentsRoot, sessionId, token);
        await fs.promises.mkdir(targetDir, { recursive: true });
        const filePath = pathModule.join(targetDir, filename);
        const tmpPath = `${filePath}.tmp`;
        let buffer: Buffer;

        try {
            if (dataBase64) {
                const normalized = dataBase64.startsWith('data:')
                    ? dataBase64.slice(dataBase64.indexOf(',') + 1)
                    : dataBase64;
                buffer = Buffer.from(normalized, 'base64');
            } else {
                buffer = await fs.promises.readFile(tempPath);
            }
            await fs.promises.writeFile(tmpPath, buffer);
            await fs.promises.rename(tmpPath, filePath);
        } catch (error) {
            try {
                if (fs.existsSync(tmpPath)) {
                    await fs.promises.unlink(tmpPath);
                }
            } catch {
                // ignore
            }
            this.uiDebugChannel.appendLine(`EXT: attach.save.fail | reqId=${reqId} | filename=${filename} | mime=${mime} | err=${String(error)}`);
            return null;
        }

        const relPath = pathModule.relative(workspaceRoot, filePath).replace(/\\/g, '/');
        const sizeBytes = buffer.length;
        this.uiDebugChannel.appendLine(`EXT: attach.save.ok | reqId=${reqId} | token=${token} | filename=${filename} | mime=${mime} | bytes=${sizeBytes} | relPath=${relPath}`);
        return { token, filename, mime, sizeBytes, relPath };
    }

    private scheduleAttachmentCleanup(reason: 'activate' | 'timer' | 'manual'): void {
        setTimeout(() => {
            void this.runAttachmentCleanup(reason);
        }, 0);
    }

    private startAttachmentCleanupTimer(): void {
        if (this.attachmentCleanupTimer) return;
        const intervalMs = 6 * 60 * 60 * 1000;
        this.attachmentCleanupTimer = setInterval(() => {
            void this.runAttachmentCleanup('timer');
        }, intervalMs);
    }

    private async runAttachmentCleanup(reason: 'activate' | 'timer' | 'manual'): Promise<void> {
        if (this.attachmentCleanupInFlight) {
            this.uiDebugChannel.appendLine(`EXT: attach.cleanup.skip | reason=in-flight | trigger=${reason}`);
            return;
        }
        const attachmentsRoot = this.getAttachmentsRootPath();
        if (!attachmentsRoot || !fs.existsSync(attachmentsRoot)) {
            this.uiDebugChannel.appendLine(`EXT: attach.cleanup.skip | reason=missing-root | trigger=${reason}`);
            return;
        }
        this.attachmentCleanupInFlight = true;
        try {
            const ttlMs = 7 * 24 * 60 * 60 * 1000;
            const now = Date.now();
            const sizeCap = 2 * 1024 * 1024 * 1024;
            const sizeTarget = Math.floor(1.8 * 1024 * 1024 * 1024);
            const files: Array<{ path: string; size: number; mtimeMs: number }> = [];

            const walk = async (dir: string): Promise<void> => {
                const entries = await fs.promises.readdir(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const fullPath = pathModule.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        await walk(fullPath);
                        continue;
                    }
                    if (!entry.isFile()) continue;
                    try {
                        const stat = await fs.promises.stat(fullPath);
                        files.push({ path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
                    } catch {
                        // ignore
                    }
                }
            };

            await walk(attachmentsRoot);
            const beforeBytes = files.reduce((sum, file) => sum + file.size, 0);
            let deletedFiles = 0;

            for (const file of files) {
                if (now - file.mtimeMs < ttlMs) continue;
                try {
                    await fs.promises.unlink(file.path);
                    deletedFiles += 1;
                } catch {
                    // ignore
                }
            }

            let remainingFiles = files.filter((file) => fs.existsSync(file.path));
            let totalBytes = remainingFiles.reduce((sum, file) => sum + file.size, 0);
            if (totalBytes > sizeCap) {
                remainingFiles = remainingFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);
                for (const file of remainingFiles) {
                    if (totalBytes <= sizeTarget) break;
                    try {
                        await fs.promises.unlink(file.path);
                        deletedFiles += 1;
                        totalBytes -= file.size;
                    } catch {
                        // ignore
                    }
                }
            }

            this.uiDebugChannel.appendLine(`EXT: attach.cleanup | reason=${reason} | ttlDays=7 | beforeBytes=${beforeBytes} | afterBytes=${totalBytes} | deletedFiles=${deletedFiles}`);
        } catch (error) {
            this.uiDebugChannel.appendLine(`EXT: attach.cleanup.error | reason=${reason} | err=${String(error)}`);
        } finally {
            this.attachmentCleanupInFlight = false;
        }
    }

    public requestAttachmentCleanup(reason: 'manual'): void {
        this.scheduleAttachmentCleanup(reason);
    }

    public recomputeWorkspaceRoot(reason: 'activate' | 'folders-change' | 'delayed-check'): void {
        const workspaceCount = vscode.workspace.workspaceFolders?.length || 0;
        const newRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!newRoot) {
            this.uiDebugChannel.appendLine(`EXT: workspace.root.none | reason=${reason}`);
            return;
        }
        const normalized = this.normalizeWorkspaceRoot(newRoot);
        const currentRoot = this.normalizeWorkspaceRoot(this.client.getWorkspaceRoot() || newRoot);
        this.uiDebugChannel.appendLine(
            `EXT: workspace.root.select | mode=first-folder | root=${newRoot} | count=${workspaceCount}`
        );
        if (normalized === currentRoot) return;
        void this.switchWorkspaceRoot(currentRoot, normalized, reason);
    }

    private async switchWorkspaceRoot(oldRoot: string, newRoot: string, reason: string): Promise<void> {
        if (this.workspaceSwitchInFlight) {
            this.uiDebugChannel.appendLine(`EXT: workspace.switch.skip | reason=in-flight | trigger=${reason}`);
            return;
        }
        this.workspaceSwitchInFlight = true;
        try {
            this.uiDebugChannel.appendLine(`EXT: workspace.changed | reason=${reason} | old=${oldRoot} | new=${newRoot}`);
            const oldPid = this.client.getServerPid();
            await this.client.shutdownServer();
            this.uiDebugChannel.appendLine(`EXT: server.stop | reason=workspace-change | pid=${oldPid || 'null'}`);

            this.client.setWorkspaceRoot(newRoot);
            this.currentWorkspaceKey = this.getWorkspaceKeyForRoot(newRoot);
            this.client.resetSessionState();
            this.currentSessionId = undefined;
            this.revertedSegmentHistory = [];
            this.revertedSegment = undefined;

            await this.client.ensureServer();
            const newPid = this.client.getServerPid();
            this.uiDebugChannel.appendLine(`EXT: server.start | cwd=${newRoot} | pid=${newPid || 'null'}`);

            const liveWebview = this._view?.webview;
            if (liveWebview) {
                await this.sendInit(liveWebview);
            }
        } catch (error) {
            this.uiDebugChannel.appendLine(`EXT: workspace.switch.error | reason=${reason} | err=${String(error)}`);
        } finally {
            this.workspaceSwitchInFlight = false;
        }
    }

    private async resolvePendingUserUpgrade(sessionId: string | undefined, webview: vscode.Webview): Promise<void> {
        if (!sessionId) return;
        const result = await this.client.resolveUserMessageUpgrade(sessionId);
        if (result.status === 'ok' && result.userMsgId && result.userMsgId.startsWith('msg_')) {
            // Update user message ID mapping
            if (result.localKey && result.userMsgId) {
                this.clientMessageIdMap.set(result.localKey, result.userMsgId);
                const ok = this.client.upgradeMessageId(result.localKey, result.userMsgId);
                this.uiDebugChannel.appendLine(`EXT: user.upgrade.client | localKey | ${result.localKey} | msgId | ${result.userMsgId} | ok | ${ok}`);
                this.client.setCurrentTurnUserMsgId(sessionId, result.userMsgId, 'export-user-upgrade');
            } else {
                this.uiDebugChannel.appendLine(`EXT: user.upgrade.client | skip | localKey=${result.localKey || 'null'} userMsgId=${result.userMsgId || 'null'}`);
            }
            
            // Also update assistant message ID mapping if we have a tmpKey
            const tmpKeyFromLocal = result.localKey ? this.pendingAssistantTmpKeyByLocalKey.get(result.localKey) : undefined;
            const tmpKey = tmpKeyFromLocal || this.pendingAssistantTmpKeyBySession.get(sessionId);
            if (tmpKey && tmpKey.startsWith('tmp:') && result.assistantMsgId && result.assistantMsgId.startsWith('msg_')) {
                this.clientMessageIdMap.set(tmpKey, result.assistantMsgId);
                const assistantOk = this.client.upgradeMessageId(tmpKey, result.assistantMsgId);
                this.uiDebugChannel.appendLine(`EXT: assistant.upgrade.client | tmpKey | ${tmpKey} | msgId | ${result.assistantMsgId} | ok | ${assistantOk}`);
                this.client.setCurrentTurnAssistantMsgId(sessionId, result.assistantMsgId, 'export-assistant-upgrade');
                // Clear the pending tmpKey since we've resolved it
                this.pendingAssistantTmpKeyBySession.delete(sessionId);
                if (result.localKey) {
                    this.pendingAssistantTmpKeyByLocalKey.delete(result.localKey);
                }
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

        const tmpKeyFromLocal = result.localKey ? this.pendingAssistantTmpKeyByLocalKey.get(result.localKey) : undefined;
        const tmpKey = tmpKeyFromLocal || this.pendingAssistantTmpKeyBySession.get(sessionId);
        if (result.userMsgId && result.userMsgId.startsWith('msg_')) {
            const pendingPayload = {
                type: 'userMessageUpgrade',
                sessionId,
                localKey: result.localKey,
                userMsgId: result.userMsgId,
                assistantMsgId: null,
                awaitingAssistantIdFromExport: true,
                reason: result.status === 'ok' ? 'pending-assistant' : result.reason,
                tmpKey
            };
            this.uiDebugChannel.appendLine(`EXT: user.upgrade.pending | session=${sessionId} reason=${result.status === 'ok' ? 'pending-assistant' : result.reason} localKey=${result.localKey || 'null'} userMsgId=${result.userMsgId || 'null'}`);
            webview.postMessage(pendingPayload);
        }
    }

    private async applyRestoreSegmentSuccess(
        sessionId: string,
        noticeKey: string,
        anchorMsgId: string,
        endMsgId: string | undefined,
        result: { applied: boolean; conflicts: ConflictDetail[]; touchedFiles: string[] },
        commitsToClear: string[],
        operationId: string | undefined,
        webview: vscode.Webview
    ): Promise<void> {
        if (!result.applied) return;
        const liveWebview = this._view?.webview || webview;
        if (commitsToClear.length) {
            for (const commitHash of commitsToClear) {
                await this.setChangeListReverted(sessionId, commitHash, false, liveWebview);
            }
        }
        liveWebview.postMessage({
            type: 'restoredSegment',
            noticeKey,
            anchorMsgId,
            applied: true,
            conflicts: result.conflicts,
            sessionId
        });
        this.client.discardRevertedSegment();
        const discardedSegment = this.client.getRevertedSegment();
        liveWebview.postMessage({
            type: 'revertedSegmentDiscarded',
            segment: discardedSegment ? { ...discardedSegment, historySegments: this.revertedSegmentHistory, noticeKey } : discardedSegment,
            sessionId: this.currentSessionId
        });
        this.postAddResponse(liveWebview, 'Restore applied.', { operationId });
        this.refreshDiffIfTouched(result.touchedFiles);
    }

    private getInvalidSegmentMessageIds(
        sessionId: string,
        options?: {
            currentNoticeKey?: string;
            rangeStartIndex?: number;
            rangeEndIndex?: number;
            candidateMessageIds?: string[];
        }
    ): Set<string> {
        const invalid = new Set<string>();
        const segMap = this.undoSegmentsBySession.get(sessionId);
        const currentNoticeKey = options?.currentNoticeKey;
        const rangeStartIndex = typeof options?.rangeStartIndex === 'number' ? options.rangeStartIndex : undefined;
        const rangeEndIndex = typeof options?.rangeEndIndex === 'number' ? options.rangeEndIndex : undefined;
        const candidateSet = Array.isArray(options?.candidateMessageIds)
            ? new Set(options!.candidateMessageIds.filter((id) => typeof id === 'string' && id.startsWith('msg_')))
            : undefined;
        const hasRange = typeof rangeStartIndex === 'number' && typeof rangeEndIndex === 'number';
        const shouldCheckRange = hasRange && rangeEndIndex! >= rangeStartIndex!;
        const segmentOverlapsRange = (segment: SegmentState): boolean => {
            if (!shouldCheckRange) return true;
            let segStart = this.client.getMessageIndex(segment.anchorMsgId || '');
            let segEnd = this.client.getMessageIndex(segment.endMsgId || '');
            if (typeof segStart !== 'number' || typeof segEnd !== 'number') {
                const indices = (Array.isArray(segment.memberMsgIds) ? segment.memberMsgIds : [])
                    .map((id) => this.client.getMessageIndex(id))
                    .filter((idx): idx is number => typeof idx === 'number');
                if (!indices.length) return false;
                indices.sort((a, b) => a - b);
                segStart = indices[0];
                segEnd = indices[indices.length - 1];
            }
            return segStart <= rangeEndIndex! && segEnd >= rangeStartIndex!;
        };
        if (segMap) {
            for (const [noticeKey, segment] of segMap.entries()) {
                if (currentNoticeKey && noticeKey === currentNoticeKey) continue;
                if (segment.restoreAllowed !== false) continue;
                if (!segmentOverlapsRange(segment)) continue;
                const ids = Array.isArray(segment.memberMsgIds) ? segment.memberMsgIds : [];
                for (const id of ids) {
                    if (typeof id !== 'string' || !id.startsWith('msg_')) continue;
                    if (candidateSet && !candidateSet.has(id)) continue;
                    invalid.add(id);
                }
            }
        }
        return invalid;
    }

    private buildRestoreMessageScope(
        sessionId: string,
        noticeKey: string | undefined,
        baseMessageIds: string[],
        segment?: SegmentState
    ): { restoreMessageIds: string[]; invalidMessageIds: string[]; activeRestoreMessageIds: string[] } {
        const restoreMessageIds = Array.isArray(baseMessageIds)
            ? Array.from(new Set(baseMessageIds.filter((id) => typeof id === 'string' && id.startsWith('msg_'))))
            : [];
        const invalidMessageIds = Array.from(this.getInvalidSegmentMessageIds(sessionId, {
            currentNoticeKey: noticeKey,
            candidateMessageIds: restoreMessageIds
        }));
        const mergedInvalidIds = Array.isArray(segment?.mergedInvalidSegments)
            ? segment!.mergedInvalidSegments
                .flatMap((child) => Array.isArray(child?.memberMsgIds) ? child.memberMsgIds : [])
                .filter((id): id is string => typeof id === 'string' && id.startsWith('msg_'))
            : [];
        const fullInvalidMessageIds = Array.from(new Set([...invalidMessageIds, ...mergedInvalidIds]));
        const invalidSet = new Set(fullInvalidMessageIds);
        const activeRestoreMessageIds = restoreMessageIds.filter((id) => !invalidSet.has(id));
        return { restoreMessageIds, invalidMessageIds: fullInvalidMessageIds, activeRestoreMessageIds };
    }

    private async handleChatEvent(event: ChatEvent, webview: vscode.Webview): Promise<void> {
        // Handle todoUpdate event for main session only
        if (event.type === 'todoUpdate' && this.isUserOwnedSession(event.sessionId || '')) {
            webview.postMessage({
                type: 'todoUpdate',
                todos: event.todos,
                anchorMessageId: event.assistantMsgId,
                sessionId: event.sessionId,
            });
            return;
        }
        if (event.type === 'assistantPhase' && event.sessionId) {
            webview.postMessage({
                type: 'assistantPhase',
                sessionId: event.sessionId,
                messageId: event.messageId || event.assistantMsgId || '',
                parentId: event.parentId,
                phase: event.phase || '',
                lane: event.lane || 'unknown',
                ts: Date.now()
            });
            return;
        }
        if (event.type === 'appendUserMessage' && event.sessionId) {
            const liveWebview = this._view?.webview || webview;
            liveWebview.postMessage({
                type: 'appendUserMessage',
                sessionId: event.sessionId,
                rootUserMsgId: event.rootUserMsgId,
                appendUserMsgId: event.appendUserMsgId || event.messageId,
                clientMessageId: event.clientMessageId,
                text: event.text || ''
            });
            return;
        }
        if (event.type === 'sessionUsage' && event.sessionId && event.usage) {
            const liveWebview = this._view?.webview || webview;
            liveWebview.postMessage({
                type: 'sessionUsage',
                sessionId: event.sessionId,
                used: event.usage.used,
                size: event.usage.size,
                amount: event.usage.amount
            });
            return;
        }
        if (event.type === 'turnResolved' && event.sessionId) {
            const liveWebview = this._view?.webview || webview;
            await this.finalizeResolvedTurn(event.sessionId, liveWebview, event.assistantMsgId);
            return;
        }
        if (event.type === 'session' && event.sessionId) {
            if (!this.isUserOwnedSession(event.sessionId) && !this.currentSessionId) {
                this.currentSessionId = event.sessionId;
                this.trackUserOwnedSession(this.currentSessionId);
                this.client.setSessionId(this.currentSessionId);
                const liveWebview = this._view?.webview || webview;
                liveWebview.postMessage({ type: 'sessionId', value: event.sessionId, sessionId: event.sessionId });
                this.uiDebugChannel.appendLine(`[SidebarProvider] Promoted first session to currentSessionId: ${event.sessionId}`);
                return;
            }
            if (!this.isUserOwnedSession(event.sessionId) && this.sendInFlightBySession.has(this.currentSessionId!)) {
                this.activeSubagentSessionIds.add(event.sessionId);
                this.client.registerSubagentSession(event.sessionId, this.currentSessionId || '');
                const existing = this.subagentProgressBySession.get(event.sessionId);
                const initialMode = event.mode || event.agent || '';
                const initialModel = event.modelID || '';
                const initialProvider = event.providerID || '';
                if (existing) {
                    if (initialMode) {
                        existing.mode = initialMode;
                        existing.description = existing.description || initialMode;
                    }
                    if (initialModel) {
                        existing.model = initialModel;
                    }
                    if (initialProvider) {
                        existing.providerId = initialProvider;
                    }
                    this.uiDebugChannel.appendLine(`[SidebarProvider] Subagent session event: ${event.sessionId} | mode=${event.mode || 'null'} | agent=${event.agent || 'null'} | modelID=${event.modelID || 'null'} | providerID=${event.providerID || 'null'}`);
                    this.emitSubagentStatus();
                    return;
                }
                this.subagentProgressBySession.set(event.sessionId, {
                    taskId: event.sessionId,
                    parentSessionId: this.currentSessionId || '',
                    description: initialMode,
                    mode: initialMode,
                    model: initialModel,
                    providerId: initialProvider,
                    isDone: false,
                    state: 'queued',
                    lastEventAt: Date.now(),
                    startedAt: Date.now()
                });
                this.uiDebugChannel.appendLine(`[SidebarProvider] Registered subagent session mapping: ${event.sessionId} -> ${this.currentSessionId}`);
                this.uiDebugChannel.appendLine(`[SidebarProvider] Subagent session event: ${event.sessionId} | mode=${event.mode || 'null'} | agent=${event.agent || 'null'} | modelID=${event.modelID || 'null'} | providerID=${event.providerID || 'null'}`);
                const sessionId = event.sessionId;
                this.client.getSessionInfo(sessionId).then((info: any) => {
                    const entry = this.subagentProgressBySession.get(sessionId);
                    if (entry) {
                        entry.title = this.cleanSubagentTitle(info?.title) || '';
                        entry.mode = entry.mode || info?.mode || info?.agent || '';
                        entry.description = entry.description || entry.mode || '';
                        entry.model = entry.model || info?.modelID || info?.model || info?.config?.model || '';
                        entry.providerId = entry.providerId || info?.providerID || info?.providerId || info?.config?.providerID || info?.config?.providerId || '';
                        this.emitSubagentStatus();
                    }
                }).catch(() => {});
                this.emitSubagentStatus(true);
                return;
            }

            // Guard: Prevent subagent session IDs from hijacking currentSessionId
            if (!this.isUserOwnedSession(event.sessionId)) {
                this.activeSubagentSessionIds.add(event.sessionId);
                const existing = this.subagentProgressBySession.get(event.sessionId);
                const initialMode = event.mode || event.agent || '';
                const initialModel = event.modelID || '';
                const initialProvider = event.providerID || '';
                if (existing) {
                    if (initialMode) {
                        existing.mode = initialMode;
                        existing.description = existing.description || initialMode;
                    }
                    if (initialModel) {
                        existing.model = initialModel;
                    }
                    if (initialProvider) {
                        existing.providerId = initialProvider;
                    }
                    this.uiDebugChannel.appendLine(`[SidebarProvider] Subagent session event: ${event.sessionId} | mode=${event.mode || 'null'} | agent=${event.agent || 'null'} | modelID=${event.modelID || 'null'} | providerID=${event.providerID || 'null'}`);
                    this.emitSubagentStatus();
                    return;
                }
                this.subagentProgressBySession.set(event.sessionId, {
                    taskId: event.sessionId,
                    parentSessionId: this.currentSessionId || '',
                    description: initialMode,
                    mode: initialMode,
                    model: initialModel,
                    providerId: initialProvider,
                    isDone: false,
                    state: 'queued',
                    lastEventAt: Date.now(),
                    startedAt: Date.now()
                });
                this.uiDebugChannel.appendLine(`[SidebarProvider] Subagent session event: ${event.sessionId} | mode=${event.mode || 'null'} | agent=${event.agent || 'null'} | modelID=${event.modelID || 'null'} | providerID=${event.providerID || 'null'}`);
                const sessionId = event.sessionId;
                this.client.getSessionInfo(sessionId).then((info: any) => {
                    const entry = this.subagentProgressBySession.get(sessionId);
                    if (entry) {
                        entry.title = this.cleanSubagentTitle(info?.title) || '';
                        entry.mode = entry.mode || info?.mode || info?.agent || '';
                        entry.description = entry.description || entry.mode || '';
                        entry.model = entry.model || info?.modelID || info?.model || info?.config?.model || '';
                        entry.providerId = entry.providerId || info?.providerID || info?.providerId || info?.config?.providerID || info?.config?.providerId || '';
                        this.emitSubagentStatus();
                    }
                }).catch(() => {});
                this.emitSubagentStatus(true);
                return;
            }

            const prevSessionId = this.currentSessionId;
            const nextSessionId = event.sessionId;
            this.currentSessionId = nextSessionId;
            this.client.setSessionId(this.currentSessionId);
            const liveWebview = this._view?.webview || webview;
            if (prevSessionId && prevSessionId !== event.sessionId) {
                liveWebview.postMessage({ type: 'questionOverlayClose', reason: 'session-switch', sessionId: event.sessionId });
                liveWebview.postMessage({ type: 'permissionOverlayClose', reason: 'session-switch', sessionId: event.sessionId });
            }
            liveWebview.postMessage({ type: 'sessionId', value: event.sessionId, sessionId: event.sessionId });
            if (this.pendingBaselineTurnKey) {
                const turnKey = this.pendingBaselineTurnKey;
                this.pendingBaselineTurnKey = undefined;
                if (this.pendingBaselineFailed) {
                    this.pendingBaselineFailed = false;
                    this.baselineReady = false;
                    liveWebview.postMessage({ type: 'baselineStatus', ready: false, message: 'Git baseline failed. Undo unavailable.' });
                    this.setSessionUndoEnabled(event.sessionId, false, liveWebview);
                } else {
                    this.client.ensureBaselineReady(event.sessionId, turnKey).then((result) => {
                        this.baselineReady = result.ok;
                        if (!result.ok) {
                            liveWebview.postMessage({ type: 'baselineStatus', ready: false, message: 'Git baseline failed. Undo unavailable.' });
                            this.setSessionUndoEnabled(event.sessionId, false, liveWebview);
                        } else {
                            liveWebview.postMessage({ type: 'baselineStatus', ready: true });
                            this.setSessionUndoEnabled(event.sessionId, true, liveWebview);
                        }
                    });
                }
            }
            return;
        }

        if (event.sessionId && this.activeSubagentSessionIds.has(event.sessionId)) {
            // Intercept subagent events to update progress
            if (event.type === 'text' && typeof event.text === 'string') {
                const entry = this.subagentProgressBySession.get(event.sessionId);
                if (entry) {
                    if (entry.isDone) {
                        return;
                    }
                    entry.latestText = event.text.length > 200
                        ? event.text.slice(0, 200) + '...'
                        : event.text;
                    this.transitionSubagentState(event.sessionId, entry, 'running', 'progress');
                    this.emitSubagentStatus();
                }
            }
            // Handle generic tool events (e.g., grep, read, etc.)
            if (event.type === 'tool' && event.tool) {
                const entry = this.subagentProgressBySession.get(event.sessionId);
                if (entry) {
                    if (entry.isDone) {
                        return;
                    }
                    const toolName = event.tool;
                    const status = event.toolState?.status || 'running';
                    if (status === 'running' || status === 'pending') {
                        entry.latestTool = toolName;
                        const input = event.toolState?.input;
                        if (input && typeof input === 'object') {
                            // Extract meaningful input display
                            const inputDisplay = input.filePath || input.path || input.pattern || input.query || '';
                            entry.latestToolInput = inputDisplay;
                        } else {
                            entry.latestToolInput = '';
                        }
                        this.transitionSubagentState(event.sessionId, entry, 'running', 'tool-progress');
                        this.emitSubagentStatus();
                    }
                }
            }
            if (event.type === 'toolPatch' && typeof event.text === 'string') {
                const entry = this.subagentProgressBySession.get(event.sessionId);
                if (entry) {
                    if (entry.isDone) {
                        return;
                    }
                    const match = event.text.match(/(?:---\s+a\/|\+\+\+\s+b\/|diff\s+--git\s+[^\s]+\s+b\/)([^\s\n]+)/);
                    const filepath = match ? match[1] : '';
                    const filename = filepath ? pathModule.basename(filepath) : '';
                    entry.latestTool = 'Applying patch' + (filename ? ': ' + filename : '');
                    entry.latestToolInput = filepath || '';
                    this.transitionSubagentState(event.sessionId, entry, 'running', 'tool-patch');
                    this.emitSubagentStatus();
                }
            }
            if (event.type === 'diff' && typeof event.text === 'string') {
                const entry = this.subagentProgressBySession.get(event.sessionId);
                if (entry) {
                    if (entry.isDone) {
                        return;
                    }
                    const match = event.text.match(/(?:---\s+a\/|\+\+\+\s+b\/|diff\s+--git\s+[^\s]+\s+b\/)([^\s\n]+)/);
                    const filepath = match ? match[1] : '';
                    const filename = filepath ? pathModule.basename(filepath) : '';
                    entry.latestTool = 'Editing ' + (filename || 'file');
                    entry.latestToolInput = filepath || '';
                    this.transitionSubagentState(event.sessionId, entry, 'running', 'diff-progress');
                    this.emitSubagentStatus();
                }
            }
            if (event.type === 'files' && event.files && event.files.length && this.currentSessionId) {
                const entry = this.subagentProgressBySession.get(event.sessionId!);
                const isReplay = event.source === 'resync';
                if (!isReplay) {
                    this.client.queueSubagentChanges(this.currentSessionId, event.files);
                }
                if (entry && event.files && event.files.length && !entry.isDone) {
                    const firstFile = typeof event.files[0] === 'string' ? event.files[0] : (event.files[0] as any).path || '';
                    const filename = firstFile ? pathModule.basename(firstFile) : 'file';
                    entry.latestTool = 'Writing ' + filename;
                    entry.latestToolInput = firstFile || '';
                    this.transitionSubagentState(event.sessionId, entry, 'running', 'files-progress');
                    this.emitSubagentStatus();
                }
                const liveWebview = this._view?.webview || webview;
                if (!isReplay) {
                    liveWebview.postMessage({
                        type: 'segmentRestoreLock',
                        sessionId: this.currentSessionId,
                        reason: 'file-change-detected'
                    });
                    event.files.forEach((file, index) => {
                        this.tryOpenDiffForEventFile(file, liveWebview, index, this.currentSessionId || '', 'subagent');
                    });
                    
                    // Detect .md files and send plan file card
                    const mdFiles = event.files
                        .map(f => (typeof f === 'string' ? f : (f as any).path))
                        .filter((path): path is string => typeof path === 'string' && path.endsWith('.md'));
                    if (mdFiles.length) {
                        const anchorMessageId = this.client.getTurnAssistantMsgId(this.currentSessionId);
                        if (anchorMessageId) {
                            liveWebview.postMessage({
                                type: 'planFileCard',
                                files: mdFiles,
                                anchorMessageId,
                                sessionId: this.currentSessionId
                            });
                        }
                    }
                }
                // REMOVED: Mid-stream emitDiffFileList call
                // Change-list should only emit after finalization sequence (chatDone → commit → upgrade → diffList)
                // This prevents premature change-list emission before final assistant message
            }
            if (event.type === 'assistantMessageMeta' && event.sessionId && !event.isStatusUpdate) {
                const entry = this.subagentProgressBySession.get(event.sessionId);
                if (entry) {
                    entry.finalMessageId = event.assistantMsgId || event.messageId;
                    this.transitionSubagentState(event.sessionId, entry, 'done', 'assistant-final-accepted');
                    entry.finishedAt = Date.now();
                    entry.dismissAt = entry.finishedAt + this.subagentDoneRetentionMs;
                    this.scheduleSubagentRetentionSweep();
                    this.emitSubagentStatus();
                }
            }
            return;
        }

        if (event.type === 'questionOverlay' && event.sessionId && event.callId) {
            const liveWebview = this._view?.webview || webview;
            liveWebview.postMessage({
                type: 'questionOverlay',
                sessionId: event.sessionId,
                callId: event.callId,
                requestId: event.requestId,
                title: event.title,
                prompt: event.prompt,
                options: event.options,
                questions: event.questions
            });
            return;
        }

        if (event.type === 'permissionRequest' && event.sessionId && event.permissionId) {
            const liveWebview = this._view?.webview || webview;
            liveWebview.postMessage({
                type: 'permissionOverlay',
                sessionId: event.sessionId,
                permissionId: event.permissionId,
                requestId: event.requestId,
                permission: event.permission || '',
                patterns: Array.isArray(event.patterns) ? event.patterns : [],
                metadata: event.metadata || null,
                callId: event.callId || null
            });
            return;
        }

        if (event.type === 'permissionReplied' && event.sessionId && event.permissionId) {
            const liveWebview = this._view?.webview || webview;
            liveWebview.postMessage({
                type: 'permissionOverlayClose',
                reason: 'permission-replied',
                sessionId: event.sessionId,
                permissionId: event.permissionId,
                response: event.response || 'once'
            });
            return;
        }

        if (event.type === 'autoResumeStallWarn' && event.sessionId) {
            const liveWebview = this._view?.webview || webview;
            liveWebview.postMessage({
                type: 'systemNotice',
                sessionId: event.sessionId,
                level: 'warn',
                message: event.text || 'This session may be stuck. Please reload the extension and continue.'
            });
            return;
        }

        if (event.type === 'autoResumeStallClear' && event.sessionId) {
            const liveWebview = this._view?.webview || webview;
            liveWebview.postMessage({
                type: 'systemNoticeClear',
                sessionId: event.sessionId
            });
            return;
        }

        if (event.type === 'autoResumeHardStop' && event.sessionId) {
            const liveWebview = this._view?.webview || webview;
            this.uiDebugChannel.appendLine(`EXT: autoresume.hardstop | sessionId=${event.sessionId} | action=show-stall-card`);
            this.sendInFlightBySession.delete(event.sessionId);
            liveWebview.postMessage({ type: 'turnInFlight', sessionId: event.sessionId, inFlight: false });
            liveWebview.postMessage({
                type: 'stallCard',
                sessionId: event.sessionId,
                title: event.title || 'Session may be stuck',
                message: event.text || 'This session appears to be unresponsive. Please reload the extension and continue.',
                actionLabel: event.actionLabel || 'Reload Window',
                secondaryActionLabel: event.secondaryActionLabel || 'Keep waiting'
            });
            return;
        }

        if (event.type === 'turnInFlight' && event.sessionId) {
            const liveWebview = this._view?.webview || webview;
            if (event.inFlight === true) {
                this.sendInFlightBySession.add(event.sessionId);
            } else {
                this.sendInFlightBySession.delete(event.sessionId);
            }
            liveWebview.postMessage({
                type: 'turnInFlight',
                sessionId: event.sessionId,
                inFlight: event.inFlight === true,
                ownerMsgId: event.ownerMsgId
            });
            return;
        }

        if (event.type === 'backgroundActivityPulse' && event.sessionId) {
            const liveWebview = this._view?.webview || webview;
            liveWebview.postMessage({
                type: 'backgroundActivityPulse',
                sessionId: event.sessionId,
                assistantMsgId: event.assistantMsgId,
                ts: Date.now()
            });
            return;
        }

        if (event.type === 'assistantMessageMeta' && (event.messageId || event.assistantMsgId)) {
            const liveWebview = this._view?.webview || webview;
            const sessionId = event.sessionId || this.currentSessionId;
            const eventTmpKey = typeof (event as any).tmpKey === 'string' ? (event as any).tmpKey : undefined;
            const sessionTmpKey = sessionId ? this.pendingAssistantTmpKeyBySession.get(sessionId) : undefined;
            const tmpKey = eventTmpKey || sessionTmpKey;
            if (sessionId && tmpKey && tmpKey.startsWith('tmp:')) {
                this.pendingAssistantTmpKeyBySession.set(sessionId, tmpKey);
                const pendingLocalKey = this.pendingLocalKeyBySession.get(sessionId);
                if (pendingLocalKey && pendingLocalKey.startsWith('local-')) {
                    this.pendingAssistantTmpKeyByLocalKey.set(pendingLocalKey, tmpKey);
                }
            }
            if (event.assistantMsgId && sessionId) {
                this.uiDebugChannel.appendLine(`[DBG_ASSIST_ID] session=${sessionId} assistantMsgId=${event.assistantMsgId} tmpKey=${tmpKey || 'null'}`);
            }
            const isSyntheticTurn = this.isCurrentTurnSynthetic(sessionId);
            liveWebview.postMessage({
                type: 'assistantMessageMeta',
                messageId: event.messageId,
                messageIndex: event.messageIndex,
                lastText: event.lastText,
                sessionId,
                assistantMsgId: event.assistantMsgId,
                tmpKey,
                isStatusUpdate: event.isStatusUpdate,
                allowedSessionIds: this.getAssistantMetaAllowedSessionIds(),
                ...(isSyntheticTurn ? { isSyntheticTurn: true } : {})
            });
            if (sessionId && typeof event.assistantMsgId === 'string' && typeof event.messageIndex === 'number') {
                liveWebview.postMessage({
                    type: 'messageIndexMapDelta',
                    sessionId,
                    messageId: event.assistantMsgId,
                    messageIndex: event.messageIndex,
                    phase: 'final-early'
                });
            }
            return;
        }

        if (event.type === 'text' && event.text) {
            const sessionId = event.sessionId || this.currentSessionId;
            if (sessionId) {
                this.appendAssistantBuffer(sessionId, event.text);
                // Push latest chunk to webview (no cumulative text)
                const liveWebview = this._view?.webview || webview;
                const isSyntheticTurn = this.isCurrentTurnSynthetic(sessionId);
                liveWebview?.postMessage({
                    type: 'assistantMessageMeta',
                    sessionId,
                    tmpKey: this.pendingAssistantTmpKeyBySession?.get(sessionId),
                    lastText: event.text,
                    isStatusUpdate: false,
                    allowedSessionIds: this.getAssistantMetaAllowedSessionIds(),
                    ...(isSyntheticTurn ? { isSyntheticTurn: true } : {})
                });
            }
            return;
        }

        if (event.type === 'error' && event.text) {
            const liveWebview = this._view?.webview || webview;
            const sessionId = event.sessionId || this.currentSessionId;
            liveWebview.postMessage({ type: 'addResponse', value: `Error: ${event.text}`, sessionId, skipSnapshot: true });
            // Cleanup before chatDone
            if (sessionId) {
                await this.client.commitPendingTurnChanges(sessionId);
            }
            await this.resolvePendingUserUpgrade(sessionId, liveWebview);
            // Mark all active subagents as done before clearing (error event path)
            this.markAllSubagentsTerminal('failed', 'event-error-finalize');
            this.emitSubagentStatus();
            this.clearSubagentSessions();

            const doneAssistantMsgId = sessionId
                ? this.client.getTurnAssistantMsgId(sessionId)
                : undefined;
            liveWebview.postMessage({
                type: 'chatDone',
                sessionId,
                assistantMsgId: doneAssistantMsgId,
                lastAssistantMsgId: doneAssistantMsgId
            });
            this.emitTurnFinalizePhase(liveWebview, sessionId, 'stream_done');
            this.emitTurnFinalizePhase(liveWebview, sessionId, 'commit_done');
            this.emitTurnFinalizePhase(liveWebview, sessionId, 'upgrade_done');
            const pendingLocalKey = sessionId ? this.pendingLocalKeyBySession.get(sessionId) : undefined;
            if (sessionId && sessionId === this.currentSessionId && pendingLocalKey && this.pendingClientMessageId === pendingLocalKey) {
                this.clearDraft(this.pendingClientMessageId);
                await this.handleAbortedMessage(this.pendingClientMessageId, liveWebview);
                this.pendingClientMessageId = undefined;
            }
            if (sessionId) {
                if (pendingLocalKey) {
                    this.pendingAssistantTmpKeyByLocalKey.delete(pendingLocalKey);
                    this.rawUserTextByLocalKey.delete(pendingLocalKey);
                }
                this.assistantTextBufferBySession.delete(sessionId);
                this.pendingAssistantTmpKeyBySession.delete(sessionId);
                this.pendingLocalKeyBySession.delete(sessionId);
                this.sendInFlightBySession.delete(sessionId);
                liveWebview.postMessage({ type: 'turnInFlight', sessionId, inFlight: false });
                this.client.finishTurn(sessionId);
            }
            this.emitTurnFinalizePhase(liveWebview, sessionId, 'finalize_done');
            return;
        }

        if (event.type === 'permission' && event.text) {
            const liveWebview = this._view?.webview || webview;
            liveWebview.postMessage({ type: 'permissionPrompt', value: event.text, sessionId: this.currentSessionId });
            return;
        }

        if (event.type === 'message' && event.text) {
            const sessionId = event.sessionId || this.currentSessionId;
            const localKey = this.pendingClientMessageId
                || (sessionId ? this.pendingLocalKeyBySession.get(sessionId) : undefined)
                || null;
            if (localKey && sessionId) {
                const mappedMessageIndex = this.client.getMessageIndex(localKey)
                    ?? this.client.registerMessage(localKey);
                this.client.aliasMessageId(localKey, event.text);
                const internalId = this.clientMessageIdMap.get(localKey);
                if (internalId && internalId !== event.text) {
                    this.client.aliasMessageId(internalId, event.text);
                }
                const internalForPending = this.clientMessageIdMap.get(localKey);
                if (internalForPending) {
                    this.client.aliasMessageId(event.text, internalForPending);
                }
                this.clientMessageIdMap.delete(localKey);
                this.clientMessageIdMap.set(event.text, event.text);
                const rawUserText = this.rawUserTextByLocalKey.get(localKey);
                if (typeof rawUserText === 'string') {
                    this.rawUserTextByMsgId.set(event.text, rawUserText);
                    this.rawUserTextByLocalKey.delete(localKey);
                }
                if (this.pendingClientMessageId === localKey) {
                    this.pendingClientMessageId = undefined;
                }
                this.uiDebugChannel.appendLine(`EXT: user.ack.bind | sessionId=${sessionId} | localKey=${localKey} | msgId=${event.text}`);
            }
            return;
        }

        if (event.type === 'diff' && event.text) {
            const liveWebview = this._view?.webview || webview;
            liveWebview.postMessage({ type: 'diffChunk', value: event.text, sessionId: this.currentSessionId });
            return;
        }

        if (event.type === 'files' && event.files && event.files.length) {
            const picked = this.pickActiveFile(event.files);
            if (!picked) return;
            const { file: active, index } = picked;
            const liveWebview = this._view?.webview || webview;
            liveWebview.postMessage({
                type: 'segmentRestoreLock',
                sessionId: event.sessionId || this.currentSessionId,
                reason: 'file-change-detected'
            });
            this.tryOpenDiffForEventFile(active, liveWebview, index, event.sessionId || this.currentSessionId || '', 'main');
            const sessionId = event.sessionId || this.currentSessionId;
            const inGrace = Boolean(sessionId && this.client.isInLateDiffGrace(sessionId));
            const inRecentFinishWindow = Boolean(sessionId && this.client.wasTurnFinishedRecently(sessionId, 5000));
            if (sessionId && (inGrace || inRecentFinishWindow)) {
                this.uiDebugChannel.appendLine(
                    `[LATE_DIFF] event in recovery window | sessionId=${sessionId} eventType=files inGrace=${inGrace} recentFinish=${inRecentFinishWindow}`
                );
                if (!this.client.wasChangeListEmitted(sessionId)) {
                    try {
                        await this.client.commitPendingTurnChanges(sessionId);
                        this.uiDebugChannel.appendLine(`[LATE_DIFF] committed pending turn changes | sessionId=${sessionId} reason=late-event-recovery`);
                    } catch (error) {
                        this.uiDebugChannel.appendLine(`[LATE_DIFF] commit pending failed | sessionId=${sessionId} err=${String(error)}`);
                    }
                    if (!this.hasRenderableDiffPayload(active)) {
                        try {
                            await this.openGitDiffForFile(sessionId, active.filePath, liveWebview);
                            this.uiDebugChannel.appendLine(`[LATE_DIFF] opened git diff | sessionId=${sessionId} file=${active.filePath}`);
                        } catch (error) {
                            this.uiDebugChannel.appendLine(`[LATE_DIFF] open git diff failed | sessionId=${sessionId} file=${active.filePath} err=${String(error)}`);
                        }
                    }
                    this.uiDebugChannel.appendLine(`[LATE_DIFF] emitting change-list | sessionId=${sessionId} reason=late-event-recovery`);
                    void this.emitDiffFileListWithRetry(sessionId, liveWebview);
                } else {
                    this.uiDebugChannel.appendLine(`[LATE_DIFF] change-list already emitted | sessionId=${sessionId} skipping=true`);
                }
            }
            
            // Detect .md files and send plan file card
            const mdFiles = event.files
                .map(f => (typeof f === 'string' ? f : (f as any).path))
                .filter((path): path is string => typeof path === 'string' && path.endsWith('.md'));
            if (mdFiles.length && this.currentSessionId) {
                const anchorMessageId = this.client.getTurnAssistantMsgId(this.currentSessionId);
                if (anchorMessageId) {
                    liveWebview.postMessage({
                        type: 'planFileCard',
                        files: mdFiles,
                        anchorMessageId,
                        sessionId: this.currentSessionId
                    });
                }
            }
            // REMOVED: Mid-stream emitDiffFileList call
            // Change-list should only emit after finalization sequence (chatDone → commit → upgrade → diffList)
            // This prevents premature change-list emission before final assistant message
            return;
        }

        if (event.type === 'raw' && event.text) {
            // Ignore raw streaming chunks for non-streaming UI.
        }
    }

    private appendAssistantBuffer(sessionId: string, chunk: string): void {
        const next = (this.assistantTextBufferBySession.get(sessionId) || '') + chunk;
        this.assistantTextBufferBySession.set(sessionId, next);
    }

    private getAssistantMetaAllowedSessionIds(): string[] {
        const currentSessionId = this.currentSessionId || '';
        if (!currentSessionId) {
            return [];
        }
        try {
            const relatedIds = this.client.getRelatedSessionIds(currentSessionId);
            return Array.from(new Set([currentSessionId, ...relatedIds].filter(Boolean)));
        } catch {
            return currentSessionId ? [currentSessionId] : [];
        }
    }

    /**
     * Check if the current turn for a session is synthetic (hidden-control or stop-continuation).
     * Returns true only when suppression criteria are met — callers tag assistantMessageMeta
     * postMessage events with isSyntheticTurn: true so the webview can skip display.
     * Uses provenance (parent user msg ID linkage), NOT text matching.
     */
    private isCurrentTurnSynthetic(sessionId: string | undefined): boolean {
        if (!sessionId) return false;
        try {
            return this.client.isCurrentTurnSyntheticForSession(sessionId);
        } catch {
            return false;  // safe default: unknown = visible
        }
    }

    private flushAssistantBufferToWebview(sessionId: string, webview: vscode.Webview): void {
        const text = this.assistantTextBufferBySession.get(sessionId) || '';
        this.assistantTextBufferBySession.delete(sessionId);
        if (!text) return;
        const tmpKey = this.pendingAssistantTmpKeyBySession.get(sessionId);
        const isSyntheticTurn = this.isCurrentTurnSynthetic(sessionId);
        webview.postMessage({
            type: 'assistantMessageMeta',
            lastText: text,
            sessionId,
            tmpKey,
            allowedSessionIds: this.getAssistantMetaAllowedSessionIds(),
            ...(isSyntheticTurn ? { isSyntheticTurn: true } : {})
        });
    }

    private async refreshModels(webview: vscode.Webview): Promise<ModelInfo[]> {
        try {
            const models = await this.client.listModels();
            if (models.length) {
                this.lastKnownModels = models;
            }
            webview.postMessage({ type: 'models', models, sessionId: this.currentSessionId });
            await this.postModelQuota(webview, 'refresh-models');
            return models;
        } catch (error) {
            this.postAddResponse(webview, `Failed to refresh models: ${error}`);
        }
        return [];
    }

    private parseModelRef(model?: string): { providerID: string; modelID: string } | undefined {
        if (!model) return undefined;
        const parts = model.split('/');
        if (parts.length < 2) return undefined;
        return { providerID: parts[0], modelID: parts.slice(1).join('/') };
    }

    private async postModelQuota(webview: vscode.Webview, reason: string): Promise<void> {
        if (this.modelQuotaInFlight) {
            await this.modelQuotaInFlight;
        }
        const modelId = this.selectedModel;
        if (!modelId) return;
        const model = this.lastKnownModels.find((item) => item.fullId === modelId);
        if (!model) return;
        this.modelQuotaInFlight = (async () => {
            try {
                const quota = await this.client.fetchModelQuota(model);
                webview.postMessage({
                    type: 'ui-debug',
                    payload: [
                        'quota.fetch.ok',
                        `provider=${model.providerId}`,
                        `summary=${quota?.summaryRemainingPercent ?? 'null'}`,
                        `rows=${quota?.rows?.length ?? 0}`
                    ]
                });
                webview.postMessage({
                    type: 'modelQuota',
                    modelId: model.fullId,
                    providerId: model.providerId,
                    quota,
                    reason
                });
            } catch (error) {
                this.uiDebugChannel.appendLine(`EXT: quota.fetch.fail | reason=${reason} | err=${String(error)}`);
            }
        })();
        await this.modelQuotaInFlight;
        this.modelQuotaInFlight = undefined;
    }

    private async refreshSessions(webview: vscode.Webview, requestId: string): Promise<void> {
        try {
            const sessions = await this.client.listSessions();
            const workspaceRoot = this.client.getWorkspaceRoot() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const filteredSessions = await this.filterSessionsForWorkspace(sessions, workspaceRoot, 'refresh');
            const topSession = filteredSessions?.[0];
            webview.postMessage({ type: 'sessionsList', requestId, sessions: filteredSessions });
        } catch (error) {
            this.postAddResponse(webview, `Failed to refresh sessions: ${error}`);
        }
    }

    private async saveUndoSegmentsState(): Promise<void> {
        const toSave: Record<string, Record<string, SegmentState>> = {};
        for (const [sid, sMap] of this.undoSegmentsBySession) {
            const obj: Record<string, SegmentState> = {};
            for (const [nk, segment] of sMap) {
                obj[nk] = segment;
            }
            toSave[sid] = obj;
        }
        await this._context.globalState.update(this.UNDO_SEGMENTS_KEY, JSON.stringify(toSave));
    }

    private async rmPathIfExists(targetPath: string): Promise<void> {
        if (!targetPath) return;
        if (!fs.existsSync(targetPath)) return;
        await fs.promises.rm(targetPath, { recursive: true, force: true });
    }

    private async clearRecentSessionIfMatches(sessionId: string): Promise<void> {
        const workspaceFolder = this.client.getWorkspaceRoot() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceFolder) return;
        const workspaceKey = this.getWorkspaceKeyForRoot(workspaceFolder);
        const recentKey = `recentSession.${workspaceKey}`;
        const recentSessionId = this._context.globalState.get<string>(recentKey);
        if (recentSessionId === sessionId) {
            await this._context.globalState.update(recentKey, undefined);
        }
    }

    private async cleanupGitArtifactsForDeletedSession(sessionId: string): Promise<void> {
        const workspaceRoot = this.client.getWorkspaceRoot() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return;

        const gitBase = pathModule.join(workspaceRoot, '.opencode', 'git');
        const indexPath = pathModule.join(gitBase, 'index.json');
        const sessionsDir = pathModule.join(gitBase, 'sessions', sessionId);
        const reposDir = pathModule.join(gitBase, 'repos');

        await this.rmPathIfExists(sessionsDir);

        if (!fs.existsSync(indexPath)) {
            return;
        }

        let parsed: any;
        try {
            parsed = JSON.parse(await fs.promises.readFile(indexPath, 'utf-8'));
        } catch {
            return;
        }

        const sessionToRepo: Record<string, string> = { ...(parsed?.sessionToRepo || {}) };
        const turnToRepo: Record<string, string> = { ...(parsed?.turnToRepo || {}) };

        const removedRepoId = sessionToRepo[sessionId];
        delete sessionToRepo[sessionId];

        if (removedRepoId) {
            for (const [turnKey, repoId] of Object.entries(turnToRepo)) {
                if (repoId === removedRepoId) {
                    delete turnToRepo[turnKey];
                }
            }
        }

        await fs.promises.writeFile(indexPath, JSON.stringify({ schemaVersion: 1, sessionToRepo, turnToRepo }, null, 2), 'utf-8');

        if (removedRepoId) {
            const stillReferenced = Object.values(sessionToRepo).includes(removedRepoId)
                || Object.values(turnToRepo).includes(removedRepoId);
            if (!stillReferenced) {
                await this.rmPathIfExists(pathModule.join(reposDir, `${removedRepoId}.git`));
            }
        }
    }

    private async cleanupDeletedSessionArtifacts(sessionId: string): Promise<void> {
        try {
            await this.rmPathIfExists(this.getSnapshotFile(sessionId));
        } catch (error) {
            this.uiDebugChannel.appendLine(`[EXT][SESSION_DELETE_CLEANUP_WARN] sessionId=${sessionId} part=snapshot err=${String(error)}`);
        }

        try {
            await this.clearPersistedSegment(sessionId);
        } catch (error) {
            this.uiDebugChannel.appendLine(`[EXT][SESSION_DELETE_CLEANUP_WARN] sessionId=${sessionId} part=reverted-segment err=${String(error)}`);
        }

        try {
            this.undoSegmentsBySession.delete(sessionId);
            await this.saveUndoSegmentsState();
        } catch (error) {
            this.uiDebugChannel.appendLine(`[EXT][SESSION_DELETE_CLEANUP_WARN] sessionId=${sessionId} part=undo-segments err=${String(error)}`);
        }

        try {
            await this.cleanupGitArtifactsForDeletedSession(sessionId);
        } catch (error) {
            this.uiDebugChannel.appendLine(`[EXT][SESSION_DELETE_CLEANUP_WARN] sessionId=${sessionId} part=git err=${String(error)}`);
        }

        try {
            const attachmentsRoot = this.getAttachmentsRootPath();
            if (attachmentsRoot) {
                await this.rmPathIfExists(pathModule.join(attachmentsRoot, sessionId));
            }
        } catch (error) {
            this.uiDebugChannel.appendLine(`[EXT][SESSION_DELETE_CLEANUP_WARN] sessionId=${sessionId} part=attachments err=${String(error)}`);
        }
    }

    private getRevertedSegmentStorageDir(): string {
        return pathModule.join(this.getOpencodeDataDir(), 'revertedSegments');
    }

    private getLegacyRevertedSegmentPathCandidates(sessionId: string): string[] {
        const legacyRoot = this.getLegacyWorkspaceDataDir('revertedSegments');
        return [
            pathModule.join(legacyRoot, `${sessionId}.json`),
            pathModule.join(legacyRoot, 'revertedSegments', `${sessionId}.json`),
        ];
    }

    private getRevertedSegmentPath(sessionId: string): string {
        return pathModule.join(this.getRevertedSegmentStorageDir(), `${sessionId}.json`);
    }

    private async persistRevertedSegment(
        sessionId: string,
        segment: { isActive: boolean; startMessageId?: string; startMessageIndex?: number; endMessageId?: string; endMessageIndex?: number; opIds?: string[]; collapsed?: boolean; messageIds?: string[]; operationId?: string },
        conflicts: ConflictDetail[],
        discarded?: boolean
    ): Promise<void> {
        const dir = this.getRevertedSegmentStorageDir();
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
        if (!fs.existsSync(filePath)) {
            for (const legacyPath of this.getLegacyRevertedSegmentPathCandidates(sessionId)) {
                if (!fs.existsSync(legacyPath)) continue;
                try {
                    const rawLegacy = await fs.promises.readFile(legacyPath, 'utf-8');
                    await fs.promises.mkdir(this.getRevertedSegmentStorageDir(), { recursive: true });
                    await fs.promises.writeFile(filePath, rawLegacy, 'utf-8');
                    this.uiDebugChannel.appendLine(
                        `[EXT][REVERTED_SEGMENT_MIGRATED] sessionId=${sessionId} from=${legacyPath} to=${filePath}`
                    );
                    break;
                } catch {
                    // Ignore legacy migration failures; treat as missing persisted data.
                }
            }
        }
        if (!fs.existsSync(filePath)) return undefined;
        try {
            const raw = await fs.promises.readFile(filePath, 'utf-8');
            return JSON.parse(raw) as PersistedRevertedSegment;
        } catch {
            return undefined;
        }
    }

    public async shutdownServer(): Promise<void> {
        await this.client.shutdownServer();
    }

    public async dispose(): Promise<void> {
        if (this.attachmentCleanupTimer) {
            clearInterval(this.attachmentCleanupTimer);
            this.attachmentCleanupTimer = undefined;
        }
        if (this.subagentRetentionTimer) {
            clearTimeout(this.subagentRetentionTimer);
            this.subagentRetentionTimer = undefined;
        }
        await this.client.dispose();
    }

    public async debugPrintTuiControlSchema(): Promise<void> {
        try {
            const summary = await this.client.getTuiControlResponseSchemaSummary();
            this.uiDebugChannel.appendLine(`[EXT][TUI_SCHEMA]\n${summary}`);
            OpenCodeClient.outputChannel.appendLine(`[TUI_SCHEMA]\n${summary}`);
            void vscode.window.showInformationMessage('OpenCode: TUI control schema printed to output channels.');
        } catch (error) {
            const message = `OpenCode: Failed to fetch TUI control schema: ${String(error)}`;
            this.uiDebugChannel.appendLine(`[EXT][TUI_SCHEMA_ERR] ${String(error)}`);
            void vscode.window.showErrorMessage(message);
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

    private hasRenderableDiffPayload(file: any): boolean {
        if (!file) return false;
        const changes = file?.changes;
        const hasChanges =
            (Array.isArray(changes) && changes.length > 0) ||
            (typeof changes === 'string' && changes.trim().length > 0);
        const hasDiff = typeof file?.diff === 'string' && file.diff.trim().length > 0;
        const hasPatch = typeof file?.patch === 'string' && file.patch.trim().length > 0;
        const metadataDiff = typeof file?.metadata?.diff === 'string' && file.metadata.diff.trim().length > 0;
        const metadataPatch = typeof file?.metadata?.patch === 'string' && file.metadata.patch.trim().length > 0;
        const hasBeforeAfter = typeof file?.before === 'string' && typeof file?.after === 'string';
        const hasMetadataBeforeAfter =
            typeof file?.metadata?.filediff?.before === 'string' &&
            typeof file?.metadata?.filediff?.after === 'string';
        return hasChanges || hasDiff || hasPatch || metadataDiff || metadataPatch || hasBeforeAfter || hasMetadataBeforeAfter;
    }

    private normalizeFileSnapshot(raw: any): FileSnapshot | undefined {
        if (!raw) return undefined;
        const metadata = raw?.metadata ?? raw?.state?.metadata;
        const filediff = metadata?.filediff;
        const filePath =
            (typeof raw?.filePath === 'string' && raw.filePath) ||
            (typeof raw?.file === 'string' && raw.file) ||
            (typeof raw?.path === 'string' && raw.path) ||
            (typeof raw?.relativePath === 'string' && raw.relativePath) ||
            (typeof filediff?.file === 'string' && filediff.file) ||
            '';
        if (!filePath) return undefined;

        const before =
            typeof raw?.before === 'string'
                ? raw.before
                : (typeof raw?.from === 'string' ? raw.from : (typeof filediff?.before === 'string' ? filediff.before : (typeof filediff?.from === 'string' ? filediff.from : undefined)));
        const after =
            typeof raw?.after === 'string'
                ? raw.after
                : (typeof raw?.to === 'string' ? raw.to : (typeof filediff?.after === 'string' ? filediff.after : (typeof filediff?.to === 'string' ? filediff.to : undefined)));
        const diff = this.getPatchTextFromFile(raw);
        const type = raw?.type as 'update' | 'create' | 'delete' | undefined;

        return {
            filePath,
            relativePath: typeof raw?.relativePath === 'string' ? raw.relativePath : undefined,
            type: type || (diff ? 'update' : undefined),
            diff,
            patch: diff,
            before,
            after,
            existsBefore: typeof raw?.existsBefore === 'boolean' ? raw.existsBefore : undefined,
            existsAfter: typeof raw?.existsAfter === 'boolean' ? raw.existsAfter : undefined,
            additions: typeof raw?.additions === 'number'
                ? raw.additions
                : (typeof filediff?.additions === 'number' ? filediff.additions : undefined),
            deletions: typeof raw?.deletions === 'number'
                ? raw.deletions
                : (typeof filediff?.deletions === 'number' ? filediff.deletions : undefined)
        };
    }

    private getPatchTextFromFile(file: any): string | undefined {
        const metadata = file?.metadata ?? file?.state?.metadata;
        const filediff = metadata?.filediff;
        const candidates = [
            file?.patch,
            file?.diff,
            metadata?.patch,
            metadata?.diff,
            filediff?.patch,
            filediff?.diff,
        ];
        for (const value of candidates) {
            if (typeof value === 'string' && value.trim().length > 0) {
                return value;
            }
        }
        return undefined;
    }

    private wasDiffAlreadyShown(sessionId: string, file: FileSnapshot): boolean {
        if (!sessionId) return false;
        const set = this.shownDiffKeysBySession.get(sessionId) ?? new Set<string>();
        const before = typeof file.before === 'string' ? file.before : '';
        const after = typeof file.after === 'string' ? file.after : '';
        const diff = this.getPatchTextFromFile(file) || '';
        const key = `${file.filePath}|${this.hashText(`${before}\n@@\n${after}\n@@\n${diff}`)}`;
        if (set.has(key)) return true;
        set.add(key);
        this.shownDiffKeysBySession.set(sessionId, set);
        return false;
    }

    private tryOpenDiffForEventFile(rawFile: any, webview: vscode.Webview, index: number, sessionId: string, lane: 'main' | 'subagent'): void {
        if (!this.hasRenderableDiffPayload(rawFile)) {
            this.uiDebugChannel.appendLine(`subagent.diff.skipped | lane=${lane} | reason=no-renderable-payload`);
            return;
        }
        const normalized = this.normalizeFileSnapshot(rawFile);
        if (!normalized) {
            this.uiDebugChannel.appendLine(`subagent.diff.skipped | lane=${lane} | reason=normalize-failed`);
            return;
        }
        this.uiDebugChannel.appendLine(`subagent.diff.detected | lane=${lane} | file=${normalized.filePath}`);
        if (sessionId && this.wasDiffAlreadyShown(sessionId, normalized)) {
            this.uiDebugChannel.appendLine(`subagent.diff.skipped | lane=${lane} | reason=duplicate | file=${normalized.filePath}`);
            return;
        }
        const shouldForceFocus =
            lane === 'subagent'
            && Boolean(sessionId)
            && this.client.isInPostFinalWatchWindow(sessionId)
            && !this.postFinalWatchDiffFocusedBySession.has(sessionId);
        if (shouldForceFocus && sessionId) {
            this.postFinalWatchDiffFocusedBySession.add(sessionId);
            this.forceOpenDiffForFileChange(normalized, webview, index);
            this.uiDebugChannel.appendLine(`subagent.diff.forcefocus | lane=${lane} | file=${normalized.filePath}`);
        } else {
            this.openDiffForFileChange(normalized, webview, index);
        }
        this.uiDebugChannel.appendLine(`subagent.diff.shown | lane=${lane} | file=${normalized.filePath}`);
    }

    private openDiffForFileChange(file: FileSnapshot, webview: vscode.Webview, index: number): void {
        void webview;
        // Only auto-open diff for file changes produced by tool_use write/edit/apply_patch.
        // Ignore session-wide diffs (e.g. session.diff) which can be emitted during read-only work.
        const isToolUseChange =
            file.type === 'update' ||
            file.type === 'create' ||
            file.type === 'delete' ||
            typeof file.existsBefore === 'boolean' ||
            typeof file.existsAfter === 'boolean';
        if (!isToolUseChange) return;

        const patchText = this.getPatchTextFromFile(file);
        if (typeof file.before !== 'string' || typeof file.after !== 'string') {
            if (!patchText) return;
            this.currentDiffFilePath = file.filePath;
            this.diffProvider.markNextChangeAutoFollow();
            void this.diffProvider.updateFromPatchSnapshot(file.filePath, patchText);
            const basename = pathModule.basename(file.filePath);
            OpenCodeClient.outputChannel.appendLine(`[DIFF_PATCH] file=${basename} idx=${index} diff=${patchText.length}`);
            return;
        }
        const beforeText = this.normalizeText(file.before);
        const afterText = this.normalizeText(file.after);
        const beforeHash = this.hashText(beforeText);
        const afterHash = this.hashText(afterText);
        const cache = this.diffHashes.get(file.filePath);
        const shouldUpdate = !cache || cache.before !== beforeHash || cache.after !== afterHash;
        if (!shouldUpdate) {
            return;
        }
        this.diffHashes.set(file.filePath, { before: beforeHash, after: afterHash });
        this.currentDiffFilePath = file.filePath;
        this.diffProvider.markNextChangeAutoFollow();
        this.diffProvider.updateFromSnapshot(file.filePath, beforeText, afterText, patchText);
        const diffLen = patchText ? patchText.length : 0;
        const basename = pathModule.basename(file.filePath);
        OpenCodeClient.outputChannel.appendLine(`[DIFF] file=${basename} idx=${index} before=${beforeText.length} after=${afterText.length} diff=${diffLen}`);
    }

    private forceOpenDiffForFileChange(file: FileSnapshot, webview: vscode.Webview, index: number): void {
        void webview;
        const isToolUseChange =
            file.type === 'update' ||
            file.type === 'create' ||
            file.type === 'delete' ||
            typeof file.existsBefore === 'boolean' ||
            typeof file.existsAfter === 'boolean';
        if (!isToolUseChange) return;
        const patchText = this.getPatchTextFromFile(file);
        if (typeof file.before !== 'string' || typeof file.after !== 'string') {
            if (!patchText) return;
            this.currentDiffFilePath = file.filePath;
            this.diffProvider.markNextChangeAutoFollow();
            void this.diffProvider.updateFromPatchSnapshot(file.filePath, patchText, true);
            const basename = pathModule.basename(file.filePath);
            OpenCodeClient.outputChannel.appendLine(`[DIFF_FORCE_PATCH] file=${basename} idx=${index} diff=${patchText.length}`);
            return;
        }
        const beforeText = this.normalizeText(file.before);
        const afterText = this.normalizeText(file.after);
        const beforeHash = this.hashText(beforeText);
        const afterHash = this.hashText(afterText);
        this.diffHashes.set(file.filePath, { before: beforeHash, after: afterHash });
        this.currentDiffFilePath = file.filePath;
        this.diffProvider.markNextChangeAutoFollow();
        void this.diffProvider.forceOpenFromSnapshot(file.filePath, beforeText, afterText, patchText);
        const diffLen = patchText ? patchText.length : 0;
        const basename = pathModule.basename(file.filePath);
        OpenCodeClient.outputChannel.appendLine(`[DIFF_FORCE] file=${basename} idx=${index} before=${beforeText.length} after=${afterText.length} diff=${diffLen}`);
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

    private mergeSessionMessagesById(baseMessages: SessionMessage[], incomingMessages: SessionMessage[]): SessionMessage[] {
        const merged: SessionMessage[] = Array.isArray(baseMessages) ? [...baseMessages] : [];
        const indexById = new Map<string, number>();

        for (let i = 0; i < merged.length; i += 1) {
            const message = merged[i];
            if (typeof message?.id === 'string' && message.id) {
                indexById.set(message.id, i);
            }
        }

        if (!Array.isArray(incomingMessages)) {
            return merged;
        }

        for (const message of incomingMessages) {
            if (!message || typeof message.text !== 'string') {
                continue;
            }
            const messageId = typeof message.id === 'string' ? message.id : '';
            if (messageId && indexById.has(messageId)) {
                const idx = indexById.get(messageId)!;
                const prev = merged[idx];
                // Same ID means same logical message; prefer the latest payload text/meta.
                merged[idx] = {
                    ...prev,
                    ...message,
                    id: messageId,
                    role: message.role || prev.role,
                    text: typeof message.text === 'string' && message.text.length ? message.text : prev.text
                };
                continue;
            }
            if (messageId) {
                indexById.set(messageId, merged.length);
            }
            merged.push(message);
        }

        return this.normalizeDisplayMessagesForSnapshot(merged);
    }

    private normalizeDisplayMessagesForSnapshot(messages: SessionMessage[]): SessionMessage[] {
        if (!Array.isArray(messages) || messages.length === 0) return [];
        const normalized: SessionMessage[] = [];
        for (const msg of messages) {
            if (!msg || typeof msg.text !== 'string') continue;
            if (msg.role === 'system') {
                if (msg.meta?.kind === 'changeList') {
                    normalized.push(msg);
                }
                continue;
            }
            let role: 'user' | 'assistant' | null = null;
            if (msg.role === 'assistant') role = 'assistant';
            if (msg.role === 'user') role = 'user';
            if (!role) continue;
            if (role === 'user' && msg.meta?.syntheticUser === true) continue;
            const text = role === 'user' ? this.stripModeInjectionBlock(msg.text) : msg.text;
            if (!text.trim()) continue;
            if (role === 'user' && this.isHiddenControlUserText(text)) continue;
            if (role === 'assistant' && this.isHiddenControlAssistantText(text)) continue;
            normalized.push({ ...msg, role, text });
        }
        return normalized;
    }

    private formatMessagesByIds(exportData: any, messageIds: Set<string>): SessionMessage[] {
        if (!(messageIds instanceof Set) || messageIds.size === 0) return [];
        const rawMessages = Array.isArray(exportData?.messages) ? exportData.messages : [];
        const formatted: SessionMessage[] = [];
        const seenIds = new Set<string>();
        for (const message of rawMessages) {
            const resolvedId = typeof message?.info?.id === 'string' ? message.info.id : '';
            if (!resolvedId || !messageIds.has(resolvedId) || seenIds.has(resolvedId)) continue;
            const role = message?.info?.role === 'user' ? 'user' : message?.info?.role === 'assistant' ? 'assistant' : null;
            if (!role) continue;
            const parts = Array.isArray(message?.parts)
                ? message.parts.filter((part: any) => part.type === 'text' && typeof part.text === 'string')
                : [];
            const text = parts.map((part: any) => part.text).join('');
            if (!text) continue;
            const displayText = role === 'user' ? this.stripModeInjectionBlock(text) : text;
            if (!displayText.trim()) continue;
            if (role === 'user' && this.isHiddenControlUserText(displayText)) continue;
            if (role === 'assistant' && this.isHiddenControlAssistantText(displayText)) continue;
            const messageIndex = this.client.registerMessage(resolvedId);
            formatted.push({ role, text: displayText, id: resolvedId, messageIndex });
            seenIds.add(resolvedId);
        }
        return formatted;
    }

    private formatSession(exportData: any): { title: string; messages: SessionMessage[] } {
        const title = exportData?.session?.title || exportData?.info?.title || 'Session';
        const messages: SessionMessage[] = [];
        const rawMessages = Array.isArray(exportData?.messages) ? exportData.messages : [];
        const sessionId =
            exportData?.session?.id ||
            exportData?.info?.id ||
            exportData?.info?.sessionId ||
            this.currentSessionId ||
            'unknown';
        const exportLines: string[] = [];
        const idRoleMap = new Map<string, Set<string>>();
        const seenIds = new Set<string>();
        const syntheticUserIds = new Set<string>();
        let duplicateIds = false;

        const assistantByParent = new Map<string, any[]>();
        const userIds: string[] = [];
        for (const msg of rawMessages) {
            const role = msg?.info?.role;
            const id = msg?.info?.id;
            if (role === 'user' && typeof id === 'string') {
                userIds.push(id);
                const parts = Array.isArray(msg?.parts)
                    ? msg.parts.filter((part: any) => part.type === 'text' && typeof part.text === 'string')
                    : [];
                const text = parts.map((part: any) => part.text).join('');
                const mode = typeof msg?.info?.mode === 'string' ? msg.info.mode.toLowerCase() : '';
                const agent = typeof msg?.info?.agent === 'string' ? msg.info.agent.toLowerCase() : '';
                const isAutoResumeText = text.trimStart().startsWith('[OC_UI_AUTORESUME');
                const isStopContinuationText = this.isHiddenControlUserText(text);
                const isOmoContinuation =
                    text.includes('<!-- OMO_INTERNAL_INITIATOR -->')
                    && (
                        text.includes('[SYSTEM DIRECTIVE: OH-MY-OPENCODE - BOULDER CONTINUATION]')
                        || text.includes('[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]')
                    );
                const isSyntheticUser = isAutoResumeText || isStopContinuationText || isOmoContinuation || mode === 'compaction' || agent === 'compaction';
                if (isSyntheticUser) {
                    syntheticUserIds.add(id);
                }
            }
            if (role === 'assistant') {
                const parentId = msg?.info?.parentID;
                if (typeof parentId === 'string') {
                    const list = assistantByParent.get(parentId) || [];
                    list.push(msg);
                    assistantByParent.set(parentId, list);
                }
            }
        }

        const getTimeCreated = (message: any): number => {
            const v = message?.time?.created;
            return typeof v === 'number' ? v : -Infinity;
        };

        const getTimeCompleted = (message: any): number => {
            const v = message?.time?.completed;
            return typeof v === 'number' ? v : -Infinity;
        };

        const pickFinalAssistantId = (candidates: any[]): string | null => {
            if (!Array.isArray(candidates) || !candidates.length) return null;
            const stopCandidates = candidates.filter((message) => message?.info?.finish === 'stop');
            const pickFrom = stopCandidates.length ? stopCandidates : candidates;
            let best = pickFrom[0];
            let bestScore = Math.max(getTimeCompleted(best), getTimeCreated(best));
            for (let i = 1; i < pickFrom.length; i++) {
                const candidate = pickFrom[i];
                const score = Math.max(getTimeCompleted(candidate), getTimeCreated(candidate));
                if (score > bestScore) {
                    best = candidate;
                    bestScore = score;
                }
            }
            const id = best?.info?.id;
            return typeof id === 'string' ? id : null;
        };

        const finalAssistantIds = new Set<string>();
        for (const userId of userIds) {
            const candidates = assistantByParent.get(userId) || [];
            const picked = pickFinalAssistantId(candidates);
            if (picked) finalAssistantIds.add(picked);
        }

        for (let i = 0; i < rawMessages.length; i++) {
            const message = rawMessages[i];
            const rawRole = message?.info?.role;
            const role = rawRole === 'user' || rawRole === 'assistant' ? rawRole : 'other';
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
        // this.uiDebugChannel.appendLine(`[DBG_EXPORT] session=${sessionId} messages:`);
        // for (const line of exportLines) {
        //     this.uiDebugChannel.appendLine(`[DBG_EXPORT] ${line}`);
        // }
        // this.uiDebugChannel.appendLine(`[DBG_EXPORT] total=${rawMessages.length} duplicateIds=${duplicateIds} multiRoleIds=${multiRoleIds.length}`);
        // if (multiRoleIds.length) {
        //     this.uiDebugChannel.appendLine(`[DBG_EXPORT] multiRoleSample=[${multiRoleIds.slice(0, 5).join(', ')}]`);
        // }

        for (const message of rawMessages) {
            const rawRole = message?.info?.role;
            if (rawRole !== 'user' && rawRole !== 'assistant') {
                continue;
            }
            const role: 'user' | 'assistant' = rawRole;
            const messageId = message?.info?.id;
            const resolvedId = typeof messageId === 'string' ? messageId : '';
            if (!resolvedId.startsWith('msg_')) {
                this.uiDebugChannel.appendLine(`sessionData.skipMessage | reason | invalid-msg-id | id | ${resolvedId || 'null'}`);
                continue;
            }
            if (role === 'assistant' && !finalAssistantIds.has(resolvedId)) {
                continue;
            }
            const parts = Array.isArray(message?.parts)
                ? message.parts.filter((part: any) => part.type === 'text' && typeof part.text === 'string')
                : [];
            const text = parts.map((part: any) => part.text).join('');
            if (!text) continue;
            const mode = typeof message?.info?.mode === 'string' ? message.info.mode.toLowerCase() : '';
            const agent = typeof message?.info?.agent === 'string' ? message.info.agent.toLowerCase() : '';
            const isAutoResumeText = role === 'user' && text.trimStart().startsWith('[OC_UI_AUTORESUME');
            const isStopContinuationText = role === 'user' && this.isHiddenControlUserText(text);
            const isOmoContinuation =
                role === 'user'
                && text.includes('<!-- OMO_INTERNAL_INITIATOR -->')
                && (
                    text.includes('[SYSTEM DIRECTIVE: OH-MY-OPENCODE - BOULDER CONTINUATION]')
                    || text.includes('[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]')
                );
            const isSyntheticUser = role === 'user' && (isAutoResumeText || isStopContinuationText || isOmoContinuation || mode === 'compaction' || agent === 'compaction');
            if (isSyntheticUser) {
                continue;
            }
            const parentId =
                (typeof message?.info?.parentID === 'string' && message.info.parentID)
                || (typeof message?.info?.parentId === 'string' && message.info.parentId)
                || '';
            if (role === 'assistant' && parentId && syntheticUserIds.has(parentId)) {
                continue;
            }
            const displayText = role === 'user' ? this.stripModeInjectionBlock(text) : text;
            if (!displayText.trim()) continue;
            if (role === 'assistant' && this.isHiddenControlAssistantText(displayText)) continue;
            const messageIndex = this.client.registerMessage(resolvedId);
            const meta: Record<string, unknown> | undefined = role === 'assistant'
                ? {
                    ...(parentId ? { parentID: parentId } : {}),
                    tokens: (message?.info as any)?.tokens,
                    cost: (message?.info as any)?.cost,
                    timeCreated: (message?.info as any)?.time?.created,
                    timeCompleted: (message?.info as any)?.time?.completed
                }
                : undefined;
            messages.push({ role, text: displayText, id: resolvedId, messageIndex, ...(meta ? { meta } : {}) });
        }

        return { title, messages };
    }

    private stripModeInjectionBlock(input: string): string {
        if (!input) return '';
        // Remove [analyze-mode]/[search-mode] injected block through trailing separator line,
        // plus trailing blank lines that belong to the injected section.
        let output = input.replace(/^\[(analyze-mode|search-mode)\][\s\S]*?^\s*---\s*(?:\r?\n(?:\s*\r?\n)*)?/im, '');
        output = output.replace(/^\s*\r?\n/, '');
        return output;
    }

    private stripAttachmentManifest(input: string): string {
        if (!input) return '';
        const marker = '---\nAttachments (workspace files; read from disk; DO NOT use any URL):';
        const start = input.indexOf(marker);
        if (start === -1) return input;
        const end = input.indexOf('\n---', start + marker.length);
        if (end === -1) return input;
        const before = input.slice(0, start).trimEnd();
        const after = input.slice(end + '\n---'.length).trimStart();
        return [before, after].filter(Boolean).join('\n\n');
    }

    private rememberDraft(localKey: string | undefined, draft: { text: string; attachments: string[]; model?: string; variant?: string; mode?: string }): void {
        this.lastDraft = { ...draft };
        if (localKey) {
            this.draftByLocalKey.set(localKey, { ...draft });
        }
    }

    private consumeDraft(localKey: string | undefined): { text: string; attachments: string[]; model?: string; variant?: string; mode?: string } | undefined {
        if (localKey) {
            const scoped = this.draftByLocalKey.get(localKey);
            if (scoped) {
                this.draftByLocalKey.delete(localKey);
                return { ...scoped };
            }
            return undefined;
        }
        return undefined;
    }

    private clearDraft(localKey: string | undefined): void {
        if (localKey) {
            this.draftByLocalKey.delete(localKey);
        }
    }

    private normalizeUserTextForSnapshot(input: string): string {
        if (!input) return '';
        const withoutAttachments = this.stripAttachmentManifest(input);
        return this.stripModeInjectionBlock(withoutAttachments).trim();
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
        this.shownDiffKeysBySession.clear();
        this.assistantTextBufferBySession.clear();
        this.pendingAssistantTmpKeyBySession.clear();
        this.pendingAssistantTmpKeyByLocalKey.clear();
        this.pendingLocalKeyBySession.clear();
        this.pendingAssistantMessageIdBySession.clear();
        this.rawUserTextByLocalKey.clear();
        this.rawUserTextByMsgId.clear();
        this.sendInFlightBySession.clear();
    }

    private resetUiState(): void {
        this.resetSessionState();
        if (this._view) {
            this._view.webview.postMessage({ type: 'resetUiState' });
        }
    }

    private async handleAbortedMessage(messageId: string, webview: vscode.Webview): Promise<void> {
        this.client.removeMessageId(messageId);
        this.clientMessageIdMap.delete(messageId);
        this.pendingAssistantTmpKeyByLocalKey.delete(messageId);
        this.rawUserTextByLocalKey.delete(messageId);
        this.rawUserTextByMsgId.delete(messageId);
        if (this.currentSessionId) {
            const tmpKey = this.pendingAssistantTmpKeyBySession.get(this.currentSessionId);
            if (tmpKey === messageId) {
                this.pendingAssistantTmpKeyBySession.delete(this.currentSessionId);
            }
        }
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

        const katexCssUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "katex.min.css")
        );
        const katexScriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "katex.min.js")
        );
        const texmathScriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "texmath.min.js")
        );

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="${styleMainUri}" rel="stylesheet">
                <link href="${highlightStyleUri}" rel="stylesheet">
                <link href="${katexCssUri}" rel="stylesheet">
                <script src="${markdownItUri}"></script>
                <script>window.markdownit = window.markdownit || markdownit;</script>
                <script src="${katexScriptUri}"></script>
                <script src="${texmathScriptUri}"></script>
                <script src="${domPurifyUri}"></script>
                <script src="${highlightScriptUri}"></script>
                <title>OpenCode Chat</title>
            </head>
            <body>
                <div class="session-header">
                    <div class="session-header-left">
                        <span class="server-status-dot status-connected" id="server-status-dot" title="Connected"></span>
                        <span class="session-title" id="session-title">New Session</span>
                        <span class="pending-indicator hidden" id="pending-indicator"></span>
                        <span class="subagent-indicator hidden" id="subagent-indicator"></span>
                        <span class="undo-status hidden" id="undo-status">Undo not available</span>
                    </div>
                    <div class="session-controls">
                        <button class="header-usage hidden" id="header-usage" aria-label="Session context usage">
                            <span class="header-usage-fill" id="header-usage-fill"></span>
                            <span class="header-usage-label" id="header-usage-label">0%</span>
                        </button>
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
                                ↺
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
                    <div class="attachment-list" id="attachment-list"></div>
                    <div class="input-token-list" id="input-token-list"></div>
                    <textarea id="chat-input" placeholder="Ask anything..."></textarea>
                    <div class="file-mention-list hidden" id="file-mention-list"></div>

                    <div class="toolbar">
                        <div class="left-tools">
                            <button class="icon-btn" id="attachment-btn" title="Add attachment" aria-label="Add attachment">＋</button>
                            <div class="select-wrapper mode-wrapper">
                                <select id="mode-select" title="Mode"></select>
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
