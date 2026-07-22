import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as pathModule from "path";
import { OpenCodeClient, ChatEvent, ModelInfo, SessionInfo, FileSnapshot, ConflictDetail, AgentInfo, ChatFilePart, CommitPendingTurnChangesResult, AuthoritativeDiffFileSetResult } from "./OpenCodeClient";
import { OpenCodeDiffProvider } from "./OpenCodeDiffProvider";
import { GitRepoManager } from './undo/GitRepoManager';
import { runGit } from './undo/GitRunner';
import { GitRepoRef, SessionMap } from './undo/types';
import { resolveCurrentVisibleOwnerMsgId, resolveSessionOwnership } from './undo/ownershipResolver';
import { AttachmentStorageService } from './attachments/AttachmentStorageService';
import type { AttachmentPayload, SavedAttachment } from './attachments/AttachmentStorageService';
import { SmartSearchSessionRegistry } from './search/SmartSearchSessionRegistry';
import { SmartSearchService } from './search/SmartSearchService';
import type { SmartSearchMessage } from './search/SmartSearchService';
import { injectChangeListRecords, type ChangeListRecord, type SessionMessage } from './changes/ChangeListInjection';
import { ChangeListStore } from './changes/ChangeListStore';
import { DiffFileViewer } from './changes/DiffFileViewer';
import { ChangeListEmitter, type FinalizeTurnIdentity } from './changes/ChangeListEmitter';
import { hydrateUndoSegments, serializeUndoSegments, type SegmentState } from './undo/UndoSegmentPersistence';
import { resolveUndoUiVisibleRange, sanitizeUndoRangeMessageIds } from './undo/UndoRangeResolver';
import {
    buildFullExportSnapshotDelta as planFullExportSnapshotDelta,
    classifyRecentAppendCandidates as classifySnapshotAppendCandidates,
    computeRecentVisibleAppend as planRecentVisibleAppend,
    getMaxMessageIndex as findMaxMessageIndex,
    getSnapshotTimelineIds as deriveSnapshotTimelineIds,
} from './history/SnapshotDeltaPlanner';

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

type AppendSnapshotMetaRoot = {
    rootMessageId: string;
    appendRootUserKey?: string;
    meta: {
        appendedPrompts: Array<Record<string, unknown>>;
    };
};

type LocalQuestionRequest = {
    sessionId: string;
    resolve: (result: { selectedId?: string; selectedLabel?: string }) => void;
};

type WebviewLivenessRecord = {
    token: string;
    panelId: string;
    sessionId: string;
    webviewInstanceId?: string;
    pingId?: string;
    pingSentAt?: number;
    ackAt?: number;
    suspicionEpisodeId?: string;
    notificationToken?: string;
    pending: boolean;
};

type WebviewAutoRescuePromptMeta = {
    episodeId: string;
    notificationToken: string;
    shownAt: number;
    expiresAt: number;
    expired: boolean;
    handled: boolean;
    repromptCount: number;
};

type WebviewAutoRescueAction = 'Cancel' | 'Rescue Now' | 'dismissed-as-cancel' | 'stale-token' | 'diagnostic-only' | 'soft-rescue';
type WebviewAutoRescueState = 'idle' | 'pending-notification' | 'cancelled' | 'running-soft-rescue' | 'cooldown' | 'failed';
type WebviewAutoRescueSoftRescueResult = {
    ok: boolean;
    phase?: 'snapshot' | 'recent' | 'full' | 'command';
    messages?: number;
    reason?: string;
    branch?: 'fresh-active-turn-command' | 'not-fresh-sessionData';
    rescueAttemptId?: string;
};
type WebviewAutoRescueAckPhase = 'received' | 'render-complete' | 'render-skip' | 'render-fail';
type WebviewAutoRescuePendingAttempt = {
    rescueAttemptId: string;
    sessionId: string;
    panelId: string;
    token?: string;
    webviewInstanceId?: string;
    notificationToken?: string;
    episodeId: string;
    selectionEpoch: number;
    activeTurnId?: string;
    branch: 'fresh-active-turn-command' | 'not-fresh-sessionData';
    startedAt: number;
    timeoutAt: number;
    postedSessionData: boolean;
    postedCommand: boolean;
    receivedAckSeen: boolean;
    renderAckSeen: boolean;
    acceptedSuccess: boolean;
    lastAck?: any;
    lastLivenessAckAt?: number;
    timeout?: NodeJS.Timeout;
    resolve?: (accepted: boolean) => void;
};
type WebviewHardRescuePending = {
    generationToken: string;
    rescueAttemptId: string;
    sessionId: string;
    panelId: string;
    livenessToken: string;
    episodeId: string;
    webview: vscode.Webview;
    oldWebviewInstanceId: string;
    selectionEpoch: number;
    activeTurn: WebviewLivenessActiveTurnSnapshot;
    startedAt: number;
    timeoutAt: number;
    handshakeLifecycle: number;
    previousInitPosted: boolean;
    newWebviewInstanceId?: string;
    handshakeAccepted: boolean;
    timeout?: NodeJS.Timeout;
};
type WebviewCommandReloadPending = {
    commandReloadGeneration: number;
    episodeId: string;
    hardRescueGenerationToken: string;
    terminalReason: string;
    sessionId: string;
    panelId: string;
    webview: vscode.Webview;
    oldWebviewInstanceId: string;
    selectionEpoch: number;
    activeTurn: WebviewLivenessActiveTurnSnapshot;
    startedAt: number;
    deadlineAt: number;
    timeoutMs: number;
    invoked: boolean;
    handshakeAccepted: boolean;
    initSucceeded: boolean;
    readyAckPosted: boolean;
    newWebviewInstanceId?: string;
    timeout?: NodeJS.Timeout;
};
type SendInitOptions = {
    isStillCurrent?: () => boolean;
    hardRescue?: {
        sessionId: string;
        activeTurn: WebviewLivenessActiveTurnSnapshot;
    };
    commandReload?: {
        sessionId: string;
        activeTurn: WebviewLivenessActiveTurnSnapshot;
    };
};
type WebviewLivenessActiveTurnSnapshot = {
    streaming: boolean;
    finalizing: boolean;
    active: boolean;
    fresh: boolean;
    source: string;
    turnId?: string;
    updatedAt: number;
    ageMs: number;
    freshnessWindowMs: number;
};

type SendInitGuardCompensationEntry = {
    sessionId: string;
    panelId: string;
    webviewInstanceId?: string;
    selectionEpoch: number;
    token: string;
    timestamp: number;
    reason: string;
    postedSessionData: boolean;
    spent: boolean;
};

type LiveTurnResumePayload = {
    type: 'liveTurnResume';
    sessionId: string;
    panelId: string;
    webviewInstanceId: string;
    activeTurnId?: string;
    activeTurnSource: string;
    userLocalId?: string;
    userMessageId?: string;
    displayUserText?: string;
    rawUserText?: string;
    tmpAssistantKey?: string;
    assistantMessageId?: string;
    assistantText?: string;
    assistantStatus: 'streaming' | 'finalizing' | 'active';
    timestamp: number;
};
type HydrationCoverage = 'authoritativeHistoryComplete' | 'deltaContinuityUnknown' | 'repairInProgress' | 'repairError';
const SNAPSHOT_DELTA_CONTINUITY_REPAIR_ENABLED = !['0', 'false'].includes(
    String(process.env.SNAPSHOT_DELTA_CONTINUITY_REPAIR_ENABLED || 'true').toLowerCase()
);

type SubagentLifecycleState = 'queued' | 'running' | 'finalizing' | 'done' | 'failed' | 'cancelled' | 'dismissed';

export class SidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private _webviewInstanceId?: string;
    private client: OpenCodeClient;
    private currentSessionId?: string;
    private userOwnedSessionIds = new Set<string>();
    private userOwnedSessionsLoaded: Promise<void>;
    private activeSubagentSessionIds = new Set<string>();
    private subagentProgressBySession = new Map<string, { taskId: string; parentSessionId: string; description: string; startedAt: number; title?: string; mode?: string; model?: string; providerId?: string; latestText?: string; latestFullText?: string; latestTool?: string; latestToolInput?: string; isDone?: boolean; state?: SubagentLifecycleState; finishedAt?: number; dismissAt?: number; lastEventAt?: number; finalMessageId?: string; finalReason?: string }>();
    private readonly subagentDoneRetentionMs = 5000;
    private subagentRetentionTimer?: NodeJS.Timeout;
    private task1DoneVisibleTotalMs = 0;
    private task1DoneVisibleCount = 0;
    private task1FalseDoneEvents = 0;
    private appendSubmitInFlightBySession = new Set<string>();
    private appendSnapshotMetaBySession = new Map<string, Map<string, AppendSnapshotMetaRoot>>();

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

    private async ensureUserOwnedSessionsLoaded(): Promise<void> {
        await this.userOwnedSessionsLoaded;
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

    private clearSubagentSessions(globalReason: 'global-retention-sweep' | 'global-shutdown' | 'global-reset' = 'global-retention-sweep'): void {
        const now = Date.now();
        this.uiDebugChannel.appendLine(`[EXT][SUBAGENT_ROUTE] phase=clear scope=${globalReason} parentSessionId=* agentSessionId=* displayTarget=parent reason=clear-terminal-retention`);
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

    private clearSubagentSessionsForParent(parentSessionId: string | undefined, reason: string): void {
        if (!parentSessionId) {
            this.uiDebugChannel.appendLine(`[EXT][SUBAGENT_ROUTE_DROP] phase=clear-parent scope=parent-scoped parentSessionId=null agentSessionId=null displayTarget=parent reason=${reason}:missing-parent`);
            return;
        }
        const now = Date.now();
        const clearedSessionIds: string[] = [];
        for (const [sessionId, entry] of this.subagentProgressBySession.entries()) {
            if (entry.parentSessionId !== parentSessionId) continue;
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
            this.activeSubagentSessionIds.delete(sessionId);
            this.subagentProgressBySession.delete(sessionId);
            clearedSessionIds.push(sessionId);
            this.uiDebugChannel.appendLine(`[SidebarProvider] Cleared parent-scoped subagent session mapping: parent=${parentSessionId} subagent=${sessionId}`);
        }
        this.client.clearSubagentsForParent(parentSessionId);
        this.uiDebugChannel.appendLine(`[EXT][SUBAGENT_ROUTE] phase=clear-parent scope=parent-scoped parentSessionId=${parentSessionId} agentSessionId=${clearedSessionIds.join(',') || 'none'} displayTarget=parent reason=${reason} cleared=${clearedSessionIds.length}`);
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
        const startMessageIndex = this.client.getMessageIndex(startMessageId, sessionId);
        const endMessageIndex = this.client.getMessageIndex(endMessageId, sessionId);
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

    private sanitizeUndoRangeMessageIds(value: unknown): string[] {
        return sanitizeUndoRangeMessageIds(value);
    }

    private resolveUndoUiVisibleRange(
        data: any,
        anchorMessageId: string,
        canonicalMessageIds: string[],
        extAnchorIndex: number
    ): { messageIds: string[]; source: 'webview-visible' | 'extension-canonical' | 'fallback'; uiAnchorIndex: number; extAnchorIndex: number } {
        return resolveUndoUiVisibleRange({ data, anchorMessageId, canonicalMessageIds, extAnchorIndex });
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
            (entry as any).latestFullText = 'Task done.';
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

    private logSubagentRoute(phase: string, parentSessionId: string | undefined, agentSessionId: string | undefined, displayTarget: 'parent' | 'agent-lane', reason: string, dropped = false): void {
        const tag = dropped ? '[EXT][SUBAGENT_ROUTE_DROP]' : '[EXT][SUBAGENT_ROUTE]';
        this.uiDebugChannel.appendLine(`${tag} phase=${phase} parentSessionId=${parentSessionId || 'null'} agentSessionId=${agentSessionId || 'null'} displayTarget=${displayTarget} reason=${reason}`);
    }

    private emitSubagentStatus(active?: boolean): void {
        const liveWebview = this._view?.webview;
        if (!liveWebview) return;
        const agentsByParent = new Map<string, any[]>();
        for (const entry of Array.from(this.subagentProgressBySession.values())) {
            if (!entry.parentSessionId) {
                this.logSubagentRoute('status', undefined, entry.taskId, 'parent', 'missing-parent', true);
                continue;
            }
            const agent = {
            sessionId: entry.taskId,
            agentSessionId: entry.taskId,
            parentSessionId: entry.parentSessionId,
            displayTarget: 'parent',
            description: entry.description,
            mode: entry.mode || '',
            startedAt: entry.startedAt,
            title: this.cleanSubagentTitle(entry.title) || '',
            model: entry.model || '',
            providerId: entry.providerId || '',
            latestText: entry.latestText || '',
            latestFullText: entry.latestFullText || entry.latestText || '',
            latestTool: entry.latestTool || '',
            latestToolInput: entry.latestToolInput || '',
            state: entry.state || (entry.isDone ? 'done' : 'running'),
            isDone: (entry.state || (entry.isDone ? 'done' : 'running')) === 'done'
            };
            const group = agentsByParent.get(entry.parentSessionId) || [];
            group.push(agent);
            agentsByParent.set(entry.parentSessionId, group);
        }
        for (const [parentSessionId, agents] of agentsByParent.entries()) {
            const runningCount = agents.filter((a: any) => a.state === 'running').length;
            const finalizingCount = agents.filter((a: any) => a.state === 'finalizing').length;
            const doneJustNowCount = agents.filter((a: any) => a.state === 'done').length;
            const isActive = active !== undefined ? active : (runningCount + finalizingCount) > 0;
            this.logSubagentRoute('status', parentSessionId, agents.map((a: any) => a.agentSessionId).join(','), 'parent', 'emit-parent-status');
            liveWebview.postMessage({ type: 'subagentStatus', active: isActive, agents, count: agents.length, runningCount, finalizingCount, doneJustNowCount, sessionId: parentSessionId, parentSessionId, displayTarget: 'parent' });
        }
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
        const parentSessionId = entry?.parentSessionId;
        if (!parentSessionId) {
            this.logSubagentRoute('stateDelta', undefined, sessionId, 'parent', 'missing-parent', true);
            return;
        }
        liveWebview.postMessage({
            type: 'subagentStateDelta',
            sessionId: parentSessionId,
            parentSessionId,
            agentSessionId: sessionId,
            displayTarget: 'parent',
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

    private emitTurnFinalizePhase(webview: vscode.Webview, sessionId: string | undefined, phase: 'stream_done' | 'commit_done' | 'upgrade_done' | 'finalize_done'): void {
        this.markWebviewActiveTurnUpdated(sessionId, `finalize:${phase}`);
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
        const commitResult = await this.commitPendingTurnChangesFromAuthoritativeFiles(this.buildFinalizeTurnIdentity(sessionId, {
            assistantMessageId: doneAssistantMsgId,
            reqId: 'finalizeResolvedTurn'
        }));
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
        const finalizeIdentity = this.buildFinalizeTurnIdentity(sessionId, {
            assistantMessageId: doneAssistantMsgId,
            commitResult,
            reqId: 'finalizeResolvedTurn'
        });
        await this.emitDiffFileListWithRetry(finalizeIdentity, webview);
        await this.writeFinalizeSnapshotFromCanonicalSession(finalizeIdentity);
        this.sendInFlightBySession.delete(sessionId);
        webview.postMessage({ type: 'turnInFlight', sessionId, inFlight: false });
        this.client.finishTurn(sessionId);
        this.syncTurnInFlightAfterFinalize(sessionId, webview, 'finalizeResolvedTurn');
        this.emitTurnFinalizePhase(webview, sessionId, 'finalize_done');
        await this.runPendingSendInitGuardCompensation(sessionId, webview, 'finalizeResolvedTurn');
    }

    private getRecentSessionIdForWorkspace(workspaceRoot: string | undefined): string | undefined {
        if (!workspaceRoot) return undefined;
        const workspaceKey = this.getWorkspaceKeyForRoot(workspaceRoot);
        return this._context.globalState.get<string>(`recentSession.${workspaceKey}`);
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
    private pendingConflict?: {
        kind: 'undo' | 'restore' | 'restoreSegment';
        sessionId: string;
        operationId: string;
        conflictId: string;
        startMessageId?: string;
        endMessageId?: string;
        visibleMessageIds?: string[];
        forwardMessageIdsFromAnchor?: string[];
        anchorIndex?: number;
        noticeKey?: string;
    };
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
    private readonly attachmentStorage: AttachmentStorageService;
    private readonly smartSearchSessions: SmartSearchSessionRegistry;
    private readonly smartSearch: SmartSearchService;
    private uiTimelineBySession = new Map<string, string[]>();
    private lastSnapshotPayloadBySession = new Map<string, any>();
    private changeListStore?: ChangeListStore;
    private readonly diffFileViewer: DiffFileViewer;
    private readonly changeListEmitter: ChangeListEmitter;
    private assistantTextBufferBySession = new Map<string, string>();
    private pendingSnapshotUserTextBySession = new Map<string, string>();
    private lastKnownModels: ModelInfo[] = [];
    private modelQuotaInFlight?: Promise<void>;
    private workspaceSwitchInFlight = false;
    private currentWorkspaceKey = '';
    private initPosted = false;
    private sessionSelectionEpoch = 0;
    private readonly recentSessionLoadLimit = 200;
    private snapshotDeltaContinuityRepairEnabled = SNAPSHOT_DELTA_CONTINUITY_REPAIR_ENABLED;
    private readonly webviewLivenessPingTimeoutMs = 10000;
    private readonly webviewAutoRescueCooldownMs = 60000;
    private readonly webviewAutoRescueAckTimeoutMs = 5000;
    private readonly webviewAutoRescueFailureCooldownMs = 15000;
    private readonly webviewHardRescueTimeoutMs = 15000;
    private readonly webviewCommandReloadTimeoutMs = 15000;
    private readonly webviewAutoRescueNotificationTtlMs = 60000;
    private readonly webviewAutoRescueRepromptCooldownMs = 60000;
    private readonly webviewAutoRescueMaxReprompts = 2;
    private readonly webviewActiveTurnFreshnessWindowMs = 30000;
    private readonly webviewLivenessProbeIntervalMs = 30000;
    private readonly webviewLivenessActiveTurnMissThreshold = 1;
    private readonly webviewLivenessNonActiveMissThreshold = 2;
    private webviewLivenessPanelSeq = 0;
    private webviewLivenessCurrent?: WebviewLivenessRecord;
    private webviewAutoRescueCooldownUntilByEpisode = new Map<string, number>();
    private webviewLivenessProbeTimer?: NodeJS.Timeout;
    private webviewLivenessMissedAckCountByToken = new Map<string, number>();
    private webviewLivenessSimulatedMissedAckCountByToken = new Map<string, number>();
    private webviewAutoRescueStateByToken = new Map<string, WebviewAutoRescueState>();
    private webviewAutoRescueFailureCountByEpisode = new Map<string, number>();
    private webviewAutoRescuePromptMetaByNotificationToken = new Map<string, WebviewAutoRescuePromptMeta>();
    private webviewAutoRescueNotificationTimerByToken = new Map<string, NodeJS.Timeout>();
    private webviewAutoRescueRepromptCountByEpisode = new Map<string, number>();
    private webviewAutoRescueRepromptDueAtByEpisode = new Map<string, number>();
    private webviewAutoRescueTerminalStopByEpisode = new Set<string>();
    private webviewAutoRescuePendingAttemptById = new Map<string, WebviewAutoRescuePendingAttempt>();
    private webviewHardRescuePending?: WebviewHardRescuePending;
    private webviewHardRescueEpisodeIds = new Set<string>();
    private webviewCommandReloadPending?: WebviewCommandReloadPending;
    private webviewCommandReloadEpisodeIds = new Set<string>();
    private webviewCommandReloadGeneration = 0;
    private webviewHandshakeLifecycle = 0;
    private webviewActiveTurnUpdatedAtBySession = new Map<string, number>();
    private sendInitGuardCompensationByKey = new Map<string, SendInitGuardCompensationEntry>();
    private sendInitGuardSpentCompensationByKey = new Map<string, SendInitGuardCompensationEntry>();
    private liveTurnResumePostedByKey = new Set<string>();

    private getWebviewLivenessPanelId(): string {
        if (!this.webviewLivenessCurrent?.panelId) {
            return `panel-${this.webviewLivenessPanelSeq || 0}`;
        }
        return this.webviewLivenessCurrent.panelId;
    }

    private buildWebviewLivenessToken(panelId: string, sessionId: string): string {
        const wvId = this._webviewInstanceId || 'unknown-wv';
        return `${panelId}:${wvId}:${sessionId}:${this.sessionSelectionEpoch}`;
    }

    private getWebviewLivenessEpisodeId(record: WebviewLivenessRecord): string {
        return `${record.panelId}:${record.sessionId}:${record.token}`;
    }

    private buildWebviewAutoRescueAttemptId(record: WebviewLivenessRecord): string {
        return `webviewAutoRescue:${record.panelId}:${record.sessionId}:${record.token}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    }

    private describeWebviewLivenessFlags(sessionId: string | undefined): string {
        const flags = this.getWebviewLivenessActiveTurnFlags(sessionId);
        return `streaming=${String(flags.streaming)} | finalizing=${String(flags.finalizing)} | activeTurnFresh=${String(flags.fresh)} | activeTurnSource=${flags.source} | activeTurnId=${flags.turnId || 'none'} | activeTurnAgeMs=${flags.ageMs} | activeTurnFreshnessWindowMs=${flags.freshnessWindowMs}`;
    }

    private markWebviewActiveTurnUpdated(sessionId: string | undefined, source: string): void {
        if (!sessionId) return;
        this.webviewActiveTurnUpdatedAtBySession.set(sessionId, Date.now());
        this.uiDebugChannel?.appendLine(`EXT: webviewAutoRescue.activeTurn.mark | source=${source} | sessionId=${sessionId} | ${this.describeWebviewLivenessFlags(sessionId)}`);
    }

    private getWebviewLivenessActiveTurnFlags(sessionId: string | undefined): WebviewLivenessActiveTurnSnapshot {
        const streaming = Boolean(sessionId && this.sendInFlightBySession.has(sessionId));
        const finalizing = Boolean(sessionId && this.pendingAssistantMessageIdBySession.has(sessionId));
        const active = streaming || finalizing;
        const updatedAt = sessionId ? (this.webviewActiveTurnUpdatedAtBySession.get(sessionId) || 0) : 0;
        const now = Date.now();
        const ageMs = updatedAt > 0 ? now - updatedAt : Number.POSITIVE_INFINITY;
        const freshnessWindowMs = this.webviewActiveTurnFreshnessWindowMs;
        const turnId = sessionId
            ? (this.pendingAssistantMessageIdBySession.get(sessionId) || this.pendingLocalKeyBySession.get(sessionId))
            : undefined;
        const source = streaming && finalizing
            ? 'sendInFlightBySession+pendingAssistantMessageIdBySession'
            : streaming
                ? 'sendInFlightBySession'
                : finalizing
                    ? 'pendingAssistantMessageIdBySession'
                    : 'none';
        return {
            streaming,
            finalizing,
            active,
            fresh: active && updatedAt > 0 && ageMs >= 0 && ageMs <= freshnessWindowMs,
            source,
            turnId,
            updatedAt,
            ageMs: Number.isFinite(ageMs) ? ageMs : -1,
            freshnessWindowMs
        };
    }

    private getSendInitGuardCompensationKey(sessionId: string, panelId: string, webviewInstanceId: string | undefined): string {
        return `${sessionId}:${panelId}:${webviewInstanceId || 'null'}`;
    }

    private getLiveTurnResumeKey(sessionId: string, panelId: string, webviewInstanceId: string | undefined, activeTurnId: string | undefined): string {
        return `${sessionId}:${panelId}:${webviewInstanceId || 'null'}:${activeTurnId || 'none'}`;
    }

    private logLiveTurnResume(
        marker: 'discovery' | 'queued' | 'posted' | 'skipped',
        sessionId: string,
        panelId: string,
        webviewInstanceId: string | undefined,
        activeTurnId: string | undefined,
        reason: string
    ): void {
        const markerName = marker === 'discovery'
            ? 'EXT: webviewAutoRescue.liveTurnResume.discovery'
            : marker === 'queued'
                ? 'EXT: webviewAutoRescue.liveTurnResume.queued'
                : marker === 'posted'
                    ? 'EXT: webviewAutoRescue.liveTurnResume.posted'
                    : 'EXT: webviewAutoRescue.liveTurnResume.skipped';
        this.uiDebugChannel.appendLine(
            `${markerName} | ` +
            `sessionId=${sessionId} | panelId=${panelId} | webviewInstanceId=${webviewInstanceId || 'null'} | ` +
            `activeTurnId=${activeTurnId || 'none'} | reason=${reason} | ` +
            `postedSessionData=false | reload=false | recreate=false | sessionMutation=false`
        );
    }

    private buildLiveTurnResumePayload(
        sessionId: string,
        panelId: string,
        webviewInstanceId: string,
        activeTurn: WebviewLivenessActiveTurnSnapshot
    ): LiveTurnResumePayload | undefined {
        const userLocalId = this.pendingLocalKeyBySession.get(sessionId);
        const tmpAssistantKey = this.pendingAssistantTmpKeyBySession.get(sessionId);
        const assistantMessageId = this.pendingAssistantMessageIdBySession.get(sessionId)
            || this.client.getTurnAssistantMsgId(sessionId)
            || undefined;
        const assistantText = this.assistantTextBufferBySession.get(sessionId);
        const draft = userLocalId ? this.draftByLocalKey.get(userLocalId) : undefined;
        const rawUserText = userLocalId ? this.rawUserTextByLocalKey.get(userLocalId) : undefined;
        const userMessageId = userLocalId ? this.clientMessageIdMap.get(userLocalId) : undefined;
        this.logLiveTurnResume('discovery', sessionId, panelId, webviewInstanceId, activeTurn.turnId, 'sendInitGuard.defer');
        return {
            type: 'liveTurnResume',
            sessionId,
            panelId,
            webviewInstanceId,
            activeTurnId: activeTurn.turnId,
            activeTurnSource: activeTurn.source,
            userLocalId,
            userMessageId,
            displayUserText: draft?.text,
            rawUserText,
            tmpAssistantKey,
            assistantMessageId,
            assistantText,
            assistantStatus: activeTurn.streaming && activeTurn.finalizing
                ? 'active'
                : activeTurn.streaming
                    ? 'streaming'
                    : 'finalizing',
            timestamp: Date.now()
        };
    }

    private postLiveTurnResumeForSendInitGuardDefer(
        webview: vscode.Webview,
        sessionId: string,
        activeTurn: WebviewLivenessActiveTurnSnapshot
    ): void {
        const panelId = this.getWebviewLivenessPanelId();
        const webviewInstanceId = this._webviewInstanceId;
        const skip = (reason: string) => {
            this.logLiveTurnResume('skipped', sessionId, panelId, webviewInstanceId, activeTurn.turnId, reason);
        };

        if (!sessionId) {
            skip('missing-session');
            return;
        }
        if (this.currentSessionId !== sessionId) {
            skip('session-mismatch');
            return;
        }
        if (!panelId) {
            skip('missing-panel-id');
            return;
        }
        if (!webviewInstanceId) {
            skip('missing-webview-instance-id');
            return;
        }
        if (this.webviewLivenessCurrent && this.webviewLivenessCurrent.sessionId !== sessionId) {
            skip('active-defer-session-mismatch');
            return;
        }
        if (this.webviewLivenessCurrent && this.webviewLivenessCurrent.panelId !== panelId) {
            skip('panel-mismatch');
            return;
        }
        if (this.webviewLivenessCurrent && (this.webviewLivenessCurrent.webviewInstanceId || '') !== webviewInstanceId) {
            skip('webview-instance-mismatch');
            return;
        }

        const currentActiveTurn = this.getWebviewLivenessActiveTurnFlags(sessionId);
        if (!currentActiveTurn.active) {
            skip('not-active');
            return;
        }
        if (!currentActiveTurn.fresh) {
            skip('not-fresh');
            return;
        }
        if ((currentActiveTurn.turnId || '') !== (activeTurn.turnId || '')) {
            skip('active-turn-mismatch');
            return;
        }
        if (this.client.wasTurnFinishedRecently(sessionId, this.webviewActiveTurnFreshnessWindowMs)) {
            skip('finalized');
            return;
        }

        const key = this.getLiveTurnResumeKey(sessionId, panelId, webviewInstanceId, currentActiveTurn.turnId);
        if (this.liveTurnResumePostedByKey.has(key)) {
            skip('duplicate');
            return;
        }

        const payload = this.buildLiveTurnResumePayload(sessionId, panelId, webviewInstanceId, currentActiveTurn);
        if (!payload) {
            skip('payload-unavailable');
            return;
        }
        this.logLiveTurnResume('queued', sessionId, panelId, webviewInstanceId, currentActiveTurn.turnId, 'sendInitGuard.defer');
        webview.postMessage(payload);
        this.liveTurnResumePostedByKey.add(key);
        this.logLiveTurnResume('posted', sessionId, panelId, webviewInstanceId, currentActiveTurn.turnId, 'sendInitGuard.defer');
    }

    private async postLiveTurnHistoryForSendInitGuardDefer(
        webview: vscode.Webview,
        sessionId: string,
        activeTurn: WebviewLivenessActiveTurnSnapshot
    ): Promise<void> {
        const panelId = this.getWebviewLivenessPanelId();
        const webviewInstanceId = this._webviewInstanceId;
        const selectionEpoch = this.sessionSelectionEpoch;
        const skip = (reason: string) => {
            this.uiDebugChannel.appendLine(
                `EXT: webviewAutoRescue.liveTurnHistory.skipped | ` +
                `sessionId=${sessionId || 'null'} | panelId=${panelId || 'null'} | webviewInstanceId=${webviewInstanceId || 'null'} | ` +
                `selectionEpoch=${selectionEpoch} | activeTurnId=${activeTurn.turnId || 'none'} | reason=${reason} | messageCount=0 | ` +
                `postedSessionData=false | reload=false | recreate=false | sessionMutation=false`
            );
        };

        if (!sessionId) return skip('missing-session');
        if (this.currentSessionId !== sessionId) return skip('session-mismatch');
        if (!panelId) return skip('missing-panel-id');
        if (!webviewInstanceId) return skip('missing-webview-instance-id');

        const currentActiveTurn = this.getWebviewLivenessActiveTurnFlags(sessionId);
        if (!currentActiveTurn.fresh || (currentActiveTurn.turnId || '') !== (activeTurn.turnId || '')) {
            return skip('active-turn-mismatch');
        }

        const activeIds = new Set<string>([
            currentActiveTurn.turnId,
            this.pendingLocalKeyBySession.get(sessionId),
            this.pendingLocalKeyBySession.get(sessionId) ? this.clientMessageIdMap.get(this.pendingLocalKeyBySession.get(sessionId) || '') : undefined,
            this.pendingAssistantTmpKeyBySession.get(sessionId),
            this.pendingAssistantMessageIdBySession.get(sessionId) || this.client.getTurnAssistantMsgId(sessionId) || undefined
        ].filter((id): id is string => typeof id === 'string' && Boolean(id)));

        let baseTitle = 'Session';
        let baseMessages: SessionMessage[] = [];
        let snapshotTimelineIds: string[] = [];
        let historyCoverage: HydrationCoverage = 'deltaContinuityUnknown';
        try {
            const snap = await this.readSnapshot(sessionId);
            if (this.currentSessionId !== sessionId || this.sessionSelectionEpoch !== selectionEpoch) return skip('stale-after-snapshot');
            if (snap?.obj?.sessionData) {
                const snapshotFormatted = await this.injectChangeLists(sessionId, {
                    title: snap.obj.sessionData?.title || baseTitle,
                    messages: Array.isArray(snap.obj.sessionData?.messages) ? snap.obj.sessionData.messages : []
                });
                if (this.currentSessionId !== sessionId || this.sessionSelectionEpoch !== selectionEpoch) return skip('stale-after-snapshot-format');
                baseTitle = snapshotFormatted.title || baseTitle;
                baseMessages = snapshotFormatted.messages;
                snapshotTimelineIds = this.getSnapshotTimelineIds(snap.obj.sessionData, baseMessages);
            }
        } catch (error) {
            this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.liveTurnHistory.snapshotFailed | sessionId=${sessionId} | panelId=${panelId} | webviewInstanceId=${webviewInstanceId} | selectionEpoch=${selectionEpoch} | reason=${String(error)} | postedSessionData=false | reload=false | recreate=false | sessionMutation=false`);
        }

        try {
            const recentExport = await this.client.exportSessionRecent(sessionId, this.recentSessionLoadLimit);
            if (this.currentSessionId !== sessionId || this.sessionSelectionEpoch !== selectionEpoch) return skip('stale-after-recent');
            const formattedRaw = this.formatSession(recentExport);
            const formatted = await this.injectChangeLists(sessionId, formattedRaw);
            if (this.currentSessionId !== sessionId || this.sessionSelectionEpoch !== selectionEpoch) return skip('stale-after-recent-format');
            if (formatted.title) baseTitle = formatted.title;
            const snapshotIdSet = new Set<string>(snapshotTimelineIds);
            const snapshotMaxMessageIndex = this.getMaxMessageIndex(baseMessages);
            const continuity = this.classifyRecentAppendCandidates(snapshotIdSet, snapshotMaxMessageIndex, formatted.messages);
            if (snapshotTimelineIds.length === 0) {
                baseMessages = formatted.messages;
                snapshotTimelineIds = this.collectVisibleSnapshotMessages(formatted.messages)
                    .map((message) => message.id || '').filter(Boolean);
            } else if (continuity.proven) {
                historyCoverage = 'authoritativeHistoryComplete';
                baseMessages = this.buildImmutableSnapshotWithProvenSuffix(baseMessages, continuity.suffix);
                snapshotTimelineIds = [
                    ...snapshotTimelineIds,
                    ...continuity.suffix.map((message) => (typeof message?.id === 'string' ? message.id : '')).filter((id): id is string => Boolean(id))
                ];
            } else if (this.snapshotDeltaContinuityRepairEnabled) {
                const fullExport = await this.client.exportSession(sessionId);
                if (this.currentSessionId !== sessionId || this.sessionSelectionEpoch !== selectionEpoch) return skip('stale-after-full-repair');
                const fullFormattedRaw = this.formatSession(fullExport);
                const repairRequiredMessageIds = await this.collectSnapshotRepairRequiredMessageIds(sessionId);
                const fullDelta = this.buildFullExportSnapshotDelta(
                    baseMessages, snapshotTimelineIds, fullFormattedRaw.messages, repairRequiredMessageIds
                );
                if (fullDelta.repairedSnapshot) {
                    await this.persistStructurallyRepairedSnapshot(
                        sessionId, fullFormattedRaw.title, fullDelta.messages, fullDelta.timelineMessageIds, []
                    );
                }
                const fullFormatted = await this.injectChangeLists(sessionId, { title: fullFormattedRaw.title, messages: fullDelta.messages });
                if (this.currentSessionId !== sessionId || this.sessionSelectionEpoch !== selectionEpoch) return skip('stale-after-full-repair-format');
                baseMessages = fullFormatted.messages;
                snapshotTimelineIds = fullDelta.timelineMessageIds;
                historyCoverage = fullDelta.proven ? 'authoritativeHistoryComplete' : 'deltaContinuityUnknown';
            }
        } catch (error) {
            if (baseMessages.length === 0) return skip(`recent-failed:${String(error)}`);
            if (snapshotTimelineIds.length > 0 && this.snapshotDeltaContinuityRepairEnabled) {
                historyCoverage = 'repairError';
            }
            this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.liveTurnHistory.recentFailedUsingSnapshot | sessionId=${sessionId} | panelId=${panelId} | webviewInstanceId=${webviewInstanceId} | selectionEpoch=${selectionEpoch} | reason=${String(error)} | postedSessionData=false | reload=false | recreate=false | sessionMutation=false`);
        }

        const historyMessages = baseMessages.filter((message) => {
            const id = typeof message?.id === 'string' ? message.id : '';
            return Boolean(id) && !activeIds.has(id);
        });
        const historyIdSet = new Set(historyMessages.map((message) => message.id).filter((id): id is string => typeof id === 'string' && Boolean(id)));
        const timelineMessageIds = snapshotTimelineIds.filter((id) => historyIdSet.has(id) && !activeIds.has(id));
        webview.postMessage({
            type: 'liveTurnHistory',
            sessionId,
            title: baseTitle,
            messages: historyMessages,
            meta: {
                timelineMessageIds,
                hydrationCoverage: historyCoverage,
                historyOnly: true,
                postedSessionData: false,
                reload: false,
                recreate: false,
                sessionMutation: false
            },
            panelId,
            webviewInstanceId,
            selectionEpoch,
            currentSessionId: this.currentSessionId,
            messageCount: historyMessages.length,
            postedSessionData: false,
            reload: false,
            recreate: false,
            sessionMutation: false
        });
        this.uiDebugChannel.appendLine(
            `EXT: webviewAutoRescue.liveTurnHistory.posted | ` +
            `sessionId=${sessionId} | panelId=${panelId} | webviewInstanceId=${webviewInstanceId} | selectionEpoch=${selectionEpoch} | ` +
            `activeTurnId=${currentActiveTurn.turnId || 'none'} | messageCount=${historyMessages.length} | timelineCount=${timelineMessageIds.length} | ` +
            `postedSessionData=false | reload=false | recreate=false | sessionMutation=false`
        );
    }

    private logSendInitGuardCompensation(
        marker: 'compensationQueued' | 'compensationRun' | 'compensationSkipped' | 'turnInFlightSync',
        entry: Pick<SendInitGuardCompensationEntry, 'sessionId' | 'panelId' | 'webviewInstanceId' | 'token' | 'postedSessionData'>,
        activeTurn: WebviewLivenessActiveTurnSnapshot,
        reason: string
    ): void {
        const markerName = marker === 'compensationQueued'
            ? 'EXT: webviewAutoRescue.hardRescue.sendInitGuard.compensationQueued'
            : marker === 'compensationRun'
                ? 'EXT: webviewAutoRescue.hardRescue.sendInitGuard.compensationRun'
                : marker === 'turnInFlightSync'
                    ? 'EXT: webviewAutoRescue.hardRescue.sendInitGuard.turnInFlightSync'
                    : 'EXT: webviewAutoRescue.hardRescue.sendInitGuard.compensationSkipped';
        this.uiDebugChannel.appendLine(
            `${markerName} | ` +
            `sessionId=${entry.sessionId} | panelId=${entry.panelId} | webviewInstanceId=${entry.webviewInstanceId || 'null'} | ` +
            `active=${String(activeTurn.active)} | fresh=${String(activeTurn.fresh)} | reason=${reason} | ` +
            `token=${entry.token} | postedSessionData=${String(entry.postedSessionData)} | ` +
            `reload=false | recreate=false | sessionMutation=false`
        );
    }

    private logWebviewAutoRescueActiveTurnCleanup(
        marker: 'activeTurnCleanup' | 'activeTurnCleanupSkipped',
        sessionId: string,
        activeTurn: WebviewLivenessActiveTurnSnapshot,
        reason: string
    ): void {
        const record = this.webviewLivenessCurrent?.sessionId === sessionId ? this.webviewLivenessCurrent : undefined;
        const token = record?.token || activeTurn.turnId || 'none';
        const episodeId = record ? (record.suspicionEpisodeId || this.getWebviewLivenessEpisodeId(record)) : 'none';
        const missedCount = record
            ? Math.max(
                this.webviewLivenessMissedAckCountByToken.get(record.token) || 0,
                this.webviewLivenessSimulatedMissedAckCountByToken.get(record.token) || 0
            )
            : 0;
        const pendingAgeMs = record ? this.getWebviewAutoRescuePendingAgeMs(record.notificationToken) : -1;
        this.uiDebugChannel.appendLine(
            `EXT: webviewAutoRescue.liveness.${marker} | ` +
            `sessionId=${sessionId} | panelId=${this.getWebviewLivenessPanelId()} | webviewInstanceId=${this._webviewInstanceId || 'null'} | ` +
            `active=${String(activeTurn.active)} | fresh=${String(activeTurn.fresh)} | streaming=${String(activeTurn.streaming)} | finalizing=${String(activeTurn.finalizing)} | ` +
            `reason=${reason} | token=${token} | episodeId=${episodeId} | missedCount=${missedCount} | pendingAgeMs=${pendingAgeMs} | ` +
            `userChoiceOnly=true | reload=false | recreate=false | sessionMutation=false`
        );
    }

    private queueSendInitGuardCompensation(sessionId: string, reason: string, activeTurn: WebviewLivenessActiveTurnSnapshot): void {
        const panelId = this.getWebviewLivenessPanelId();
        const webviewInstanceId = this._webviewInstanceId;
        const key = this.getSendInitGuardCompensationKey(sessionId, panelId, webviewInstanceId);
        const existing = this.sendInitGuardCompensationByKey.get(key);
        if (existing && !existing.spent) {
            existing.spent = true;
            this.sendInitGuardCompensationByKey.delete(key);
            this.sendInitGuardSpentCompensationByKey.set(key, existing);
            this.logSendInitGuardCompensation('compensationSkipped', existing, activeTurn, 'superseded');
        }
        const entry: SendInitGuardCompensationEntry = {
            sessionId,
            panelId,
            webviewInstanceId,
            selectionEpoch: this.sessionSelectionEpoch,
            token: `sendInitGuardComp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            timestamp: Date.now(),
            reason,
            postedSessionData: false,
            spent: false
        };
        this.sendInitGuardCompensationByKey.set(key, entry);
        this.logSendInitGuardCompensation('compensationQueued', entry, activeTurn, reason);
    }

    private syncTurnInFlightAfterFinalize(sessionId: string | undefined, webview: vscode.Webview, reason: string): void {
        if (!sessionId) return;
        const before = this.getWebviewLivenessActiveTurnFlags(sessionId);
        if (!before.active) {
            this.logWebviewAutoRescueActiveTurnCleanup('activeTurnCleanupSkipped', sessionId, before, 'already-inactive');
            return;
        }
        this.sendInFlightBySession.delete(sessionId);
        this.pendingAssistantMessageIdBySession.delete(sessionId);
        this.pendingAssistantTmpKeyBySession.delete(sessionId);
        this.pendingLocalKeyBySession.delete(sessionId);
        this.logWebviewAutoRescueActiveTurnCleanup('activeTurnCleanup', sessionId, before, reason);
        const after = this.getWebviewLivenessActiveTurnFlags(sessionId);
        webview.postMessage({ type: 'turnInFlight', sessionId, inFlight: false });
        this.logSendInitGuardCompensation('turnInFlightSync', {
            sessionId,
            panelId: this.getWebviewLivenessPanelId(),
            webviewInstanceId: this._webviewInstanceId,
            token: 'turnInFlightSync',
            postedSessionData: false
        }, after, reason);
    }

    private async repostSessionDataForSendInitGuardCompensation(
        entry: SendInitGuardCompensationEntry,
        webview: vscode.Webview,
        isStillValid: () => boolean
    ): Promise<{ ok: boolean; phase?: 'snapshot' | 'recent' | 'full'; messages?: number; reason?: string }> {
        const sessionId = entry.sessionId;
        const segMap = this.undoSegmentsBySession.get(sessionId);
        this.syncClientRevertedSegmentFromUndoSegments(sessionId);
        const segments = segMap ? Array.from(segMap.values()) : [];
        let baseTitle = 'Session';
        let baseMessages: SessionMessage[] = [];
        let snapshotTimelineIds: string[] = [];

        try {
            const snap = await this.readSnapshot(sessionId);
            if (!isStillValid()) return { ok: false, reason: 'stale-before-snapshot-post' };
            if (snap?.obj?.sessionData) {
                const snapshotFormatted = await this.injectChangeLists(sessionId, {
                    title: snap.obj.sessionData?.title || baseTitle,
                    messages: Array.isArray(snap.obj.sessionData?.messages) ? snap.obj.sessionData.messages : []
                });
                if (!isStillValid()) return { ok: false, reason: 'stale-before-snapshot-post' };
                baseTitle = snapshotFormatted.title || baseTitle;
                baseMessages = snapshotFormatted.messages;
                snapshotTimelineIds = this.getSnapshotTimelineIds(snap.obj.sessionData, baseMessages);
                webview.postMessage({
                    type: 'sessionData',
                    sessionId,
                    title: baseTitle,
                    messages: baseMessages,
                    segments,
                    meta: {
                        ...(snap.obj.sessionData?.meta || {}),
                        source: 'snapshot',
                        timelineMessageIds: snapshotTimelineIds,
                        hydrationCoverage: 'deltaContinuityUnknown' as HydrationCoverage
                    }
                });
            }
        } catch (error) {
            this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.hardRescue.sendInitGuard.compensationSkipped | sessionId=${sessionId} | panelId=${entry.panelId} | webviewInstanceId=${entry.webviewInstanceId || 'null'} | active=false | fresh=false | reason=snapshot-failed:${String(error)} | token=${entry.token} | postedSessionData=false | reload=false | recreate=false | sessionMutation=false`);
        }

        try {
            const recentExport = await this.client.exportSessionRecent(sessionId, this.recentSessionLoadLimit);
            if (!isStillValid()) return { ok: false, reason: 'stale-before-recent-post' };
            const formattedRaw = this.formatSession(recentExport);
            const formatted = await this.injectChangeLists(sessionId, formattedRaw);
            if (!isStillValid()) return { ok: false, reason: 'stale-before-recent-post' };
            if (formatted.title) baseTitle = formatted.title;
            const snapshotIdSet = new Set<string>(snapshotTimelineIds);
            const snapshotMaxMessageIndex = this.getMaxMessageIndex(baseMessages);
            const continuity = this.classifyRecentAppendCandidates(snapshotIdSet, snapshotMaxMessageIndex, formatted.messages);
            if (snapshotTimelineIds.length > 0 && !continuity.proven) {
                if (!this.snapshotDeltaContinuityRepairEnabled) {
                    return { ok: true, phase: 'snapshot', messages: baseMessages.length, reason: 'repair-disabled' };
                }
                if (!isStillValid()) return { ok: false, reason: 'stale-before-repair' };
                webview.postMessage({
                    type: 'hydrationCoverage',
                    sessionId,
                    hydrationCoverage: 'repairInProgress' as HydrationCoverage
                });
                throw new Error('snapshot-boundary-unproven');
            }
            const appendMessages = continuity.suffix;
            const mergedMessages = snapshotTimelineIds.length > 0
                ? this.buildImmutableSnapshotWithProvenSuffix(baseMessages, appendMessages)
                : formatted.messages;
            const newIds = appendMessages.map((message) => (typeof message?.id === 'string' ? message.id : '')).filter((id): id is string => Boolean(id));
            webview.postMessage({
                type: 'sessionData',
                sessionId,
                title: baseTitle,
                messages: mergedMessages,
                segments,
                meta: {
                    timelineMessageIds: [...snapshotTimelineIds, ...newIds],
                    hydrationCoverage: (snapshotTimelineIds.length > 0
                        ? 'authoritativeHistoryComplete'
                        : 'deltaContinuityUnknown') as HydrationCoverage
                }
            });
            return { ok: true, phase: 'recent', messages: mergedMessages.length };
        } catch (error) {
            this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.hardRescue.sendInitGuard.compensationSkipped | sessionId=${sessionId} | panelId=${entry.panelId} | webviewInstanceId=${entry.webviewInstanceId || 'null'} | active=false | fresh=false | reason=recent-failed:${String(error)} | token=${entry.token} | postedSessionData=false | reload=false | recreate=false | sessionMutation=false`);
        }

        try {
            const exportResult = await this.client.exportSession(sessionId);
            if (!isStillValid()) return { ok: false, reason: 'stale-before-full-post' };
            const formattedRaw = this.formatSession(exportResult);
            const repairRequiredMessageIds = await this.collectSnapshotRepairRequiredMessageIds(sessionId);
            const fullDelta = this.buildFullExportSnapshotDelta(
                baseMessages, snapshotTimelineIds, formattedRaw.messages, repairRequiredMessageIds
            );
            if (fullDelta.repairedSnapshot) {
                await this.persistStructurallyRepairedSnapshot(
                    sessionId, formattedRaw.title, fullDelta.messages, fullDelta.timelineMessageIds, segments
                );
            }
            const formatted = await this.injectChangeLists(sessionId, {
                title: formattedRaw.title,
                messages: fullDelta.messages
            });
            if (!isStillValid()) return { ok: false, reason: 'stale-before-full-post' };
            webview.postMessage({
                type: 'sessionData',
                sessionId,
                title: formatted.title,
                messages: formatted.messages,
                segments,
                meta: {
                    timelineMessageIds: fullDelta.timelineMessageIds,
                    hydrationCoverage: (fullDelta.proven
                        ? 'authoritativeHistoryComplete'
                        : 'deltaContinuityUnknown') as HydrationCoverage
                }
            });
            return { ok: true, phase: 'full', messages: formatted.messages.length };
        } catch (error) {
            if (isStillValid() && snapshotTimelineIds.length > 0) {
                webview.postMessage({ type: 'hydrationCoverage', sessionId, hydrationCoverage: 'repairError' as HydrationCoverage });
            }
            return { ok: false, reason: `full-failed:${String(error)}` };
        }
    }

    private async runPendingSendInitGuardCompensation(sessionId: string | undefined, webview: vscode.Webview, triggerReason: string): Promise<void> {
        if (!sessionId) return;
        const matching = Array.from(this.sendInitGuardCompensationByKey.entries())
            .filter(([, entry]) => entry.sessionId === sessionId);
        if (matching.length === 0) {
            const spent = Array.from(this.sendInitGuardSpentCompensationByKey.entries())
                .find(([, entry]) => entry.sessionId === sessionId);
            if (spent) {
                const [spentKey, spentEntry] = spent;
                this.logSendInitGuardCompensation('compensationSkipped', spentEntry, this.getWebviewLivenessActiveTurnFlags(sessionId), 'already-spent');
                this.sendInitGuardSpentCompensationByKey.delete(spentKey);
            }
            return;
        }

        const currentPanelId = this.getWebviewLivenessPanelId();
        const currentWebviewInstanceId = this._webviewInstanceId;

        for (const [key, entry] of matching) {
            const currentActiveTurn = this.getWebviewLivenessActiveTurnFlags(sessionId);
            const skip = (reason: string, clear = true) => {
                this.logSendInitGuardCompensation('compensationSkipped', entry, this.getWebviewLivenessActiveTurnFlags(sessionId), reason);
                if (clear) {
                    entry.spent = true;
                    this.sendInitGuardCompensationByKey.delete(key);
                    this.sendInitGuardSpentCompensationByKey.set(key, entry);
                }
            };

            if (entry.spent) {
                skip('already-spent');
                continue;
            }
            if (this.currentSessionId !== entry.sessionId) {
                skip('session-switch');
                continue;
            }
            if (entry.selectionEpoch !== this.sessionSelectionEpoch) {
                skip('selection-epoch-changed');
                continue;
            }
            if (entry.panelId !== currentPanelId || (entry.webviewInstanceId || '') !== (currentWebviewInstanceId || '')) {
                skip('webview-identity-changed');
                this.uiDebugChannel.appendLine(
                    `EXT: webviewAutoRescue.hardRescue.sendInitGuard.compensationDrain | ` +
                    `sessionId=${sessionId} | panelId=${entry.panelId} | webviewInstanceId=${entry.webviewInstanceId || 'null'} | ` +
                    `currentPanelId=${currentPanelId || 'null'} | currentWebviewInstanceId=${currentWebviewInstanceId || 'null'} | ` +
                    `reason=webview-identity-changed | token=${entry.token} | postedSessionData=false | ` +
                    `reload=false | recreate=false | sessionMutation=false`
                );
                continue;
            }
            if (currentActiveTurn.active || currentActiveTurn.fresh) {
                skip('active-turn', false);
                return;
            }

            entry.spent = true;
            this.sendInitGuardCompensationByKey.delete(key);
            this.sendInitGuardSpentCompensationByKey.set(key, entry);
            const isStillValid = () => {
                const activeTurn = this.getWebviewLivenessActiveTurnFlags(entry.sessionId);
                return this.currentSessionId === entry.sessionId
                    && this.sessionSelectionEpoch === entry.selectionEpoch
                    && this.getWebviewLivenessPanelId() === entry.panelId
                    && (this._webviewInstanceId || '') === (entry.webviewInstanceId || '')
                    && !activeTurn.active
                    && !activeTurn.fresh;
            };
            const result = await this.repostSessionDataForSendInitGuardCompensation(entry, webview, isStillValid);
            entry.postedSessionData = Boolean(result.ok);
            this.logSendInitGuardCompensation(
                result.ok ? 'compensationRun' : 'compensationSkipped',
                entry,
                this.getWebviewLivenessActiveTurnFlags(sessionId),
                result.ok ? `${triggerReason}:${result.phase || 'unknown'}` : (result.reason || 'repost-failed')
            );
            return;
        }
    }

    private resetWebviewLiveness(reason: string): void {
        const commandReload = this.webviewCommandReloadPending;
        if (commandReload) {
            this.finishWebviewCommandReload(commandReload, 'failed', `liveness-reset:${reason}`);
        }
        const record = this.webviewLivenessCurrent;
        if (record) {
            record.pending = false;
            if (record.notificationToken) {
                this.clearWebviewAutoRescueNotificationTimer(record.notificationToken);
            }
            this.uiDebugChannel.appendLine(`EXT: webviewLiveness.disarm | reason=${reason} | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | notificationToken=${record.notificationToken || 'none'}`);
        }
        this.webviewLivenessCurrent = undefined;
    }

    private getWebviewAutoRescuePendingAgeMs(notificationToken: string | undefined): number {
        if (!notificationToken) return -1;
        const meta = this.webviewAutoRescuePromptMetaByNotificationToken.get(notificationToken);
        return meta ? Math.max(0, Date.now() - meta.shownAt) : -1;
    }

    private getWebviewAutoRescueRepromptCount(record: WebviewLivenessRecord): number {
        const episodeId = record.suspicionEpisodeId || this.getWebviewLivenessEpisodeId(record);
        return this.webviewAutoRescueRepromptCountByEpisode.get(episodeId) || 0;
    }

    private isWebviewAutoRescueTerminalStopped(record: WebviewLivenessRecord): boolean {
        const episodeId = record.suspicionEpisodeId || this.getWebviewLivenessEpisodeId(record);
        return this.webviewAutoRescueTerminalStopByEpisode.has(episodeId);
    }

    private isWebviewAutoRescueStillUnresponsive(record: WebviewLivenessRecord): boolean {
        return this.isCurrentWebviewLivenessRecord(record) && !record.ackAt;
    }

    private clearWebviewAutoRescueNotificationTimer(notificationToken: string): void {
        const timer = this.webviewAutoRescueNotificationTimerByToken.get(notificationToken);
        if (timer) {
            clearTimeout(timer);
            this.webviewAutoRescueNotificationTimerByToken.delete(notificationToken);
        }
    }

    private logWebviewAutoRescuePendingExpired(record: WebviewLivenessRecord, meta: WebviewAutoRescuePromptMeta, reason: string, stillUnresponsive: boolean): void {
        const pendingAgeMs = Math.max(0, Date.now() - meta.shownAt);
        this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.liveness.pendingExpired | sessionId=${record.sessionId} | token=${record.token} | episodeId=${meta.episodeId} | notificationToken=${meta.notificationToken} | pendingAgeMs=${pendingAgeMs} | notificationTtlMs=${this.webviewAutoRescueNotificationTtlMs} | repromptCooldownMs=${this.webviewAutoRescueRepromptCooldownMs} | repromptCount=${meta.repromptCount} | maxReprompts=${this.webviewAutoRescueMaxReprompts} | stillUnresponsive=${String(stillUnresponsive)} | reason=${reason} | userChoiceOnly=true | reload=false | recreate=false | sessionMutation=false`);
    }

    private logWebviewAutoRescueTerminalStopProbeCycle(record: WebviewLivenessRecord, reason: string): void {
        const episodeId = record.suspicionEpisodeId || this.getWebviewLivenessEpisodeId(record);
        this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.liveness.terminal-stop-probe-cycle | reason=${reason} | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | episodeId=${episodeId} | notificationToken=${record.notificationToken || 'none'} | pendingAgeMs=${this.getWebviewAutoRescuePendingAgeMs(record.notificationToken)} | notificationTtlMs=${this.webviewAutoRescueNotificationTtlMs} | repromptCount=${this.getWebviewAutoRescueRepromptCount(record)} | maxReprompts=${this.webviewAutoRescueMaxReprompts} | userChoiceOnly=true | reload=false | recreate=false | sessionMutation=false`);
    }

    private expireWebviewAutoRescueNotification(record: WebviewLivenessRecord, notificationToken: string, reason: string): void {
        const meta = this.webviewAutoRescuePromptMetaByNotificationToken.get(notificationToken);
        if (!meta || meta.expired || meta.handled) return;
        meta.expired = true;
        this.clearWebviewAutoRescueNotificationTimer(notificationToken);
        const stillUnresponsive = this.isWebviewAutoRescueStillUnresponsive(record);
        const episodeId = meta.episodeId;
        if (!stillUnresponsive) {
            this.logWebviewAutoRescuePendingExpired(record, meta, reason, false);
            return;
        }
        if (meta.repromptCount >= this.webviewAutoRescueMaxReprompts) {
            this.webviewAutoRescueTerminalStopByEpisode.add(episodeId);
            this.logWebviewAutoRescuePendingExpired(record, meta, 'max-reprompts-reached', true);
            this.logWebviewAutoRescueTerminalStopProbeCycle(record, 'max-reprompts-reached');
            return;
        }
        this.logWebviewAutoRescuePendingExpired(record, meta, reason, true);
        const nextRepromptCount = meta.repromptCount + 1;
        this.webviewAutoRescueRepromptCountByEpisode.set(episodeId, nextRepromptCount);
        const repromptDueAt = Date.now() + this.webviewAutoRescueRepromptCooldownMs;
        this.webviewAutoRescueRepromptDueAtByEpisode.set(episodeId, repromptDueAt);
        this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.liveness.reprompt | reason=${reason} | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | episodeId=${episodeId} | oldNotificationToken=${notificationToken} | pendingAgeMs=${Math.max(0, Date.now() - meta.shownAt)} | notificationTtlMs=${this.webviewAutoRescueNotificationTtlMs} | repromptCooldownMs=${this.webviewAutoRescueRepromptCooldownMs} | repromptCount=${nextRepromptCount} | maxReprompts=${this.webviewAutoRescueMaxReprompts} | stillUnresponsive=true | userChoiceOnly=true | reload=false | recreate=false | sessionMutation=false`);
        const repromptTimer = setTimeout(() => {
            this.webviewAutoRescueRepromptDueAtByEpisode.delete(episodeId);
            if (this.isWebviewAutoRescueStillUnresponsive(record) && !this.isWebviewAutoRescueTerminalStopped(record)) {
                void this.showWebviewAutoRescueNotification(record);
            }
        }, Math.max(0, repromptDueAt - Date.now()));
        repromptTimer.unref?.();
    }

    private beginWebviewLivenessEpisode(reason: string): WebviewLivenessRecord | undefined {
        const liveWebview = this._view?.webview;
        const sessionId = this.currentSessionId;
        if (!liveWebview || !this._view?.visible || !sessionId) {
            this.uiDebugChannel.appendLine(`EXT: webviewLiveness.skip | reason=${reason}:inactive-or-missing-session | visible=${String(Boolean(this._view?.visible))} | sessionId=${sessionId || 'null'} | panelId=${this.getWebviewLivenessPanelId()}`);
            return undefined;
        }

        const panelId = this.getWebviewLivenessPanelId();
        const token = this.buildWebviewLivenessToken(panelId, sessionId);
        const episodeKey = `${panelId}:${sessionId}:${token}`;
        const now = Date.now();
        const cooldownUntil = this.webviewAutoRescueCooldownUntilByEpisode.get(episodeKey) || 0;
        if (now < cooldownUntil) {
            this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.cooldown | reason=${reason} | panelId=${panelId} | sessionId=${sessionId} | token=${token} | until=${cooldownUntil} | remainingMs=${cooldownUntil - now}`);
            return undefined;
        }
        if (this.webviewLivenessCurrent?.pending && this.webviewLivenessCurrent.token === token) {
            const current = this.webviewLivenessCurrent;
            if (this.isWebviewAutoRescueTerminalStopped(current)) {
                this.logWebviewAutoRescueTerminalStopProbeCycle(current, reason);
            } else {
                this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.liveness.dedupeProbe | reason=${reason} | panelId=${panelId} | sessionId=${sessionId} | token=${token} | episodeId=${current.suspicionEpisodeId || this.getWebviewLivenessEpisodeId(current)} | notificationToken=${current.notificationToken || 'none'} | pendingAgeMs=${this.getWebviewAutoRescuePendingAgeMs(current.notificationToken)} | notificationTtlMs=${this.webviewAutoRescueNotificationTtlMs} | repromptCooldownMs=${this.webviewAutoRescueRepromptCooldownMs} | repromptCount=${this.getWebviewAutoRescueRepromptCount(current)} | maxReprompts=${this.webviewAutoRescueMaxReprompts} | userChoiceOnly=true | reload=false | recreate=false | sessionMutation=false`);
            }
            return current;
        }

        const record: WebviewLivenessRecord = {
            panelId,
            sessionId,
            token,
            webviewInstanceId: this._webviewInstanceId,
            pending: true
        };
        record.suspicionEpisodeId = this.getWebviewLivenessEpisodeId(record);
        this.webviewLivenessCurrent = record;
        this.uiDebugChannel.appendLine(`EXT: webviewLiveness.begin | reason=${reason} | panelId=${panelId} | sessionId=${sessionId} | token=${token} | webviewInstanceId=${record.webviewInstanceId || 'null'} | ${this.describeWebviewLivenessFlags(sessionId)}`);
        return record;
    }

    private isCurrentWebviewLivenessRecord(record: WebviewLivenessRecord): boolean {
        return Boolean(
            this.webviewLivenessCurrent === record &&
            record.pending &&
            this._view?.visible &&
            this.currentSessionId === record.sessionId &&
            this.buildWebviewLivenessToken(record.panelId, record.sessionId) === record.token
        );
    }

    private applyWebviewAutoRescueCooldown(record: WebviewLivenessRecord, action: WebviewAutoRescueAction): void {
        const until = Date.now() + this.webviewAutoRescueCooldownMs;
        const episodeId = record.suspicionEpisodeId || this.getWebviewLivenessEpisodeId(record);
        this.webviewAutoRescueCooldownUntilByEpisode.set(episodeId, until);
        this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.cooldown.set | action=${action} | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | episodeId=${episodeId} | cooldownMs=${this.webviewAutoRescueCooldownMs} | until=${until}`);
    }

    private setWebviewAutoRescueState(record: WebviewLivenessRecord, state: WebviewAutoRescueState, reason: string): void {
        this.webviewAutoRescueStateByToken.set(record.token, state);
        this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.state | state=${state} | reason=${reason} | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | notificationToken=${record.notificationToken || 'none'}`);
    }

    private getWebviewAutoRescueCooldownForSession(sessionId: string): { active: boolean; episodeId?: string; until?: number } {
        const now = Date.now();
        for (const [episodeId, until] of this.webviewAutoRescueCooldownUntilByEpisode.entries()) {
            if (until <= now) continue;
            if (episodeId.includes(`:${sessionId}:`)) {
                return { active: true, episodeId, until };
            }
        }
        return { active: false };
    }

    private shouldSuppressWebviewStuckCardForAutoRescue(sessionId: string, source: string): boolean {
        if (this.webviewLivenessCurrent?.pending && this.webviewLivenessCurrent.sessionId === sessionId) {
            this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.dedupe | source=${source} | decision=suppress-webview-card | sessionId=${sessionId} | token=${this.webviewLivenessCurrent.token} | notificationToken=${this.webviewLivenessCurrent.notificationToken || 'none'} | reason=pending-ide-notification`);
            return true;
        }
        const cooldown = this.getWebviewAutoRescueCooldownForSession(sessionId);
        if (cooldown.active) {
            this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.dedupe | source=${source} | decision=suppress-webview-card | sessionId=${sessionId} | episodeId=${cooldown.episodeId || 'none'} | cooldownUntil=${cooldown.until || 0} | reason=cooldown`);
            return true;
        }
        return false;
    }

    private logWebviewAutoRescueDiagnostics(record: WebviewLivenessRecord, phase: 'pre' | 'post', action: WebviewAutoRescueAction): void {
        const cooldownUntil = this.webviewAutoRescueCooldownUntilByEpisode.get(record.suspicionEpisodeId || this.getWebviewLivenessEpisodeId(record)) || 0;
        this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.diagnostics.${phase} | action=${action} | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | pingId=${record.pingId || 'none'} | pingSentAt=${record.pingSentAt || 0} | ackAt=${record.ackAt || 0} | timeoutMs=${this.webviewLivenessPingTimeoutMs} | notificationToken=${record.notificationToken || 'none'} | cooldownUntil=${cooldownUntil} | visible=${String(Boolean(this._view?.visible))} | currentSessionId=${this.currentSessionId || 'null'} | webviewInstanceId=${record.webviewInstanceId || 'null'} | ${this.describeWebviewLivenessFlags(record.sessionId)}`);
    }

    private executeWebviewAutoRescueDiagnosticOnly(record: WebviewLivenessRecord, action: WebviewAutoRescueAction): void {
        this.logWebviewAutoRescueDiagnostics(record, 'pre', action);
        this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.action | action=diagnostic-only | requestedBy=${action} | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | reload=false | recreate=false | sessionMutation=false`);
        this.logWebviewAutoRescueDiagnostics(record, 'post', 'diagnostic-only');
    }

    private beginWebviewAutoRescuePendingAttempt(record: WebviewLivenessRecord, rescueAttemptId: string, branch: 'fresh-active-turn-command' | 'not-fresh-sessionData'): WebviewAutoRescuePendingAttempt {
        const startedAt = Date.now();
        const attempt: WebviewAutoRescuePendingAttempt = {
            rescueAttemptId,
            sessionId: record.sessionId,
            panelId: record.panelId,
            token: record.token,
            webviewInstanceId: record.webviewInstanceId || this._webviewInstanceId,
            notificationToken: record.notificationToken,
            episodeId: record.suspicionEpisodeId || this.getWebviewLivenessEpisodeId(record),
            selectionEpoch: this.sessionSelectionEpoch,
            activeTurnId: this.getWebviewLivenessActiveTurnFlags(record.sessionId).turnId,
            branch,
            startedAt,
            timeoutAt: startedAt + this.webviewAutoRescueAckTimeoutMs,
            postedSessionData: false,
            postedCommand: false,
            receivedAckSeen: false,
            renderAckSeen: false,
            acceptedSuccess: false,
            lastLivenessAckAt: record.ackAt
        };
        this.webviewAutoRescuePendingAttemptById.set(rescueAttemptId, attempt);
        attempt.timeout = setTimeout(() => this.finishWebviewAutoRescuePendingAttemptTimeout(rescueAttemptId, 'ack-timeout'), this.webviewAutoRescueAckTimeoutMs);
        attempt.timeout.unref?.();
        return attempt;
    }

    private markWebviewAutoRescueAttemptPosted(rescueAttemptId: string, posted: { sessionData?: boolean; command?: boolean }): void {
        const attempt = this.webviewAutoRescuePendingAttemptById.get(rescueAttemptId);
        if (!attempt) return;
        if (posted.sessionData) attempt.postedSessionData = true;
        if (posted.command) attempt.postedCommand = true;
    }

    private formatWebviewAutoRescueAckFields(attempt: WebviewAutoRescuePendingAttempt, extra: string[] = []): string {
        const lastAck = attempt.lastAck || {};
        const record = this.webviewLivenessCurrent;
        return [
            `sessionId=${attempt.sessionId}`,
            `panelId=${attempt.panelId}`,
            `webviewInstanceId=${attempt.webviewInstanceId || 'null'}`,
            `rescueAttemptId=${attempt.rescueAttemptId}`,
            `branch=${attempt.branch}`,
            `postedSessionData=${String(attempt.postedSessionData)}`,
            `postedCommand=${String(attempt.postedCommand)}`,
            `receivedAckSeen=${String(attempt.receivedAckSeen)}`,
            `renderAckSeen=${String(attempt.renderAckSeen)}`,
            `acceptedSuccess=${String(attempt.acceptedSuccess)}`,
            `lastAckPhase=${lastAck.phase || 'none'}`,
            `lastAckResult=${lastAck.result || 'none'}`,
            `lastAckReason=${lastAck.reason || 'none'}`,
            `lastLivenessAckAt=${record?.ackAt || attempt.lastLivenessAckAt || 0}`,
            ...extra
        ].join(' | ');
    }

    private finishWebviewAutoRescuePendingAttemptTimeout(rescueAttemptId: string, reason: string): void {
        const attempt = this.webviewAutoRescuePendingAttemptById.get(rescueAttemptId);
        if (!attempt || attempt.acceptedSuccess) return;
        if (attempt.timeout) {
            clearTimeout(attempt.timeout);
            attempt.timeout = undefined;
        }
        const timeoutMs = Math.max(0, Date.now() - attempt.startedAt);
        this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.ack.timeout | ${this.formatWebviewAutoRescueAckFields(attempt, [`reason=${reason}`, `timeoutMs=${timeoutMs}`, `expectedTimeoutMs=${this.webviewAutoRescueAckTimeoutMs}`])}`);
        if (!attempt.receivedAckSeen) {
            this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.ack.undelivered | ${this.formatWebviewAutoRescueAckFields(attempt, [`reason=${reason}`, `timeoutMs=${timeoutMs}`, `expectedTimeoutMs=${this.webviewAutoRescueAckTimeoutMs}`, 'classification=undelivered-no-receipt', 'nextAction=escalation-needed'])}`);
        }
        const episodeId = attempt.episodeId;
        const failureCount = (this.webviewAutoRescueFailureCountByEpisode.get(episodeId) || 0) + 1;
        this.webviewAutoRescueFailureCountByEpisode.set(episodeId, failureCount);
        this.webviewAutoRescueRepromptDueAtByEpisode.set(episodeId, Date.now() + this.webviewAutoRescueFailureCooldownMs);
        if (failureCount >= 1) {
            this.webviewAutoRescueTerminalStopByEpisode.add(episodeId);
            this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.ack.escalation-needed | ${this.formatWebviewAutoRescueAckFields(attempt, [`reason=${reason}`, `failureCount=${failureCount}`, `failureCooldownMs=${this.webviewAutoRescueFailureCooldownMs}`, 'automaticFollowUpPromptsRemaining=0'])}`);
        }
        const record = this.webviewLivenessCurrent;
        if (record && record.sessionId === attempt.sessionId && record.panelId === attempt.panelId) {
            this.setWebviewAutoRescueState(record, 'failed', 'soft-rescue-ack-timeout');
        }
        if (!attempt.receivedAckSeen) {
            this.beginWebviewHardRescue(attempt);
        }
        this.webviewAutoRescuePendingAttemptById.delete(rescueAttemptId);
        attempt.resolve?.(false);
    }

    private isWebviewHardRescueCurrent(pending: WebviewHardRescuePending): boolean {
        return this.webviewHardRescuePending === pending
            && Date.now() <= pending.timeoutAt
            && this._view?.webview === pending.webview
            && this.currentSessionId === pending.sessionId
            && this.sessionSelectionEpoch === pending.selectionEpoch
            && this.getWebviewLivenessPanelId() === pending.panelId
            && this.webviewHandshakeLifecycle === pending.handshakeLifecycle
            && this._webviewInstanceId === pending.newWebviewInstanceId;
    }

    private finishWebviewHardRescueFailure(pending: WebviewHardRescuePending, marker: 'timeout' | 'failed', reason: string): void {
        if (this.webviewHardRescuePending !== pending) return;
        if (pending.timeout) clearTimeout(pending.timeout);
        pending.timeout = undefined;
        this.initPosted = pending.previousInitPosted;
        this.webviewHardRescuePending = undefined;
        const elapsedMs = Math.max(0, Date.now() - pending.startedAt);
        const markerName = marker === 'timeout' ? 'webviewHardRescue.timeout' : 'webviewHardRescue.failed';
        this.uiDebugChannel.appendLine(
            `EXT: ${markerName} | generationToken=${pending.generationToken} | sessionId=${pending.sessionId} | ` +
            `panelId=${pending.panelId} | rescueAttemptId=${pending.rescueAttemptId} | oldWebviewInstanceId=${pending.oldWebviewInstanceId} | ` +
            `newWebviewInstanceId=${pending.newWebviewInstanceId || 'null'} | elapsedMs=${elapsedMs} | reason=${reason} | ` +
            `initPostedRestored=${String(pending.previousInitPosted)} | nextAction=Reload Window | automaticRetry=false | reload=false | recreate=false | sessionMutation=false`
        );
        // Command reload is a terminal escalation only after the HTML rescue has released ownership.
        void this.beginWebviewCommandReload(pending, reason);
    }

    private isWebviewCommandReloadCurrent(pending: WebviewCommandReloadPending): boolean {
        const expectedWebviewInstanceId = pending.newWebviewInstanceId || pending.oldWebviewInstanceId;
        const activeTurn = this.getWebviewLivenessActiveTurnFlags(pending.sessionId);
        return this.webviewCommandReloadPending === pending
            && Date.now() <= pending.deadlineAt
            && this._view?.webview === pending.webview
            && this.currentSessionId === pending.sessionId
            && this.sessionSelectionEpoch === pending.selectionEpoch
            && this.getWebviewLivenessPanelId() === pending.panelId
            && this.webviewHandshakeLifecycle === pending.commandReloadGeneration
            && this._webviewInstanceId === expectedWebviewInstanceId
            && (activeTurn.turnId || '') === (pending.activeTurn.turnId || '');
    }

    private finishWebviewCommandReload(
        pending: WebviewCommandReloadPending,
        marker: 'timeout' | 'failed',
        reason: string
    ): void {
        if (this.webviewCommandReloadPending !== pending) return;
        if (pending.timeout) clearTimeout(pending.timeout);
        pending.timeout = undefined;
        this.webviewCommandReloadPending = undefined;
        const elapsedMs = Math.max(0, Date.now() - pending.startedAt);
        this.uiDebugChannel.appendLine(
            `EXT: webviewCommandReload.${marker} | commandReloadGeneration=${pending.commandReloadGeneration} | ` +
            `episodeId=${pending.episodeId} | sessionId=${pending.sessionId} | panelId=${pending.panelId} | ` +
            `oldWebviewInstanceId=${pending.oldWebviewInstanceId || 'null'} | newWebviewInstanceId=${pending.newWebviewInstanceId || 'null'} | ` +
            `elapsedMs=${elapsedMs} | reason=${reason} | nextAction=manually-run-Reload-Webviews | automaticRetry=false | reloadWindow=false`
        );
    }

    private async beginWebviewCommandReload(hardRescue: WebviewHardRescuePending, terminalReason: string): Promise<void> {
        const episodeId = hardRescue.episodeId;
        // Consume before the first await: duplicate terminal callbacks cannot issue a second global command.
        if (this.webviewCommandReloadPending || this.webviewCommandReloadEpisodeIds.has(episodeId)) return;
        const currentActiveTurn = this.getWebviewLivenessActiveTurnFlags(hardRescue.sessionId);
        const currentIdentityMatches = this.currentSessionId === hardRescue.sessionId
            && this.sessionSelectionEpoch === hardRescue.selectionEpoch
            && this.getWebviewLivenessPanelId() === hardRescue.panelId
            && this._view?.webview === hardRescue.webview
            && this._webviewInstanceId === hardRescue.oldWebviewInstanceId
            && (currentActiveTurn.turnId || '') === (hardRescue.activeTurn.turnId || '');
        if (!currentIdentityMatches) {
            this.uiDebugChannel.appendLine(`EXT: webviewCommandReload.failed | episodeId=${episodeId} | reason=terminal-hard-rescue-context-stale | automaticRetry=false | reloadWindow=false`);
            return;
        }
        this.webviewCommandReloadEpisodeIds.add(episodeId);
        const startedAt = Date.now();
        const pending: WebviewCommandReloadPending = {
            commandReloadGeneration: ++this.webviewHandshakeLifecycle,
            episodeId,
            hardRescueGenerationToken: hardRescue.generationToken,
            terminalReason,
            sessionId: hardRescue.sessionId,
            panelId: hardRescue.panelId,
            webview: hardRescue.webview,
            oldWebviewInstanceId: hardRescue.oldWebviewInstanceId,
            selectionEpoch: hardRescue.selectionEpoch,
            activeTurn: currentActiveTurn,
            startedAt,
            deadlineAt: startedAt + this.webviewCommandReloadTimeoutMs,
            timeoutMs: this.webviewCommandReloadTimeoutMs,
            invoked: false,
            handshakeAccepted: false,
            initSucceeded: false,
            readyAckPosted: false
        };
        this.webviewCommandReloadPending = pending;
        pending.timeout = setTimeout(
            () => this.finishWebviewCommandReload(pending, 'timeout', 'handshake-init-or-readyAck-timeout'),
            pending.timeoutMs
        );
        pending.timeout.unref?.();
        this.uiDebugChannel.appendLine(`EXT: webviewCommandReload.begin | commandReloadGeneration=${pending.commandReloadGeneration} | episodeId=${episodeId} | sessionId=${pending.sessionId} | panelId=${pending.panelId} | oldWebviewInstanceId=${pending.oldWebviewInstanceId || 'null'} | activeTurnId=${pending.activeTurn.turnId || 'none'} | activeTurnFresh=${String(pending.activeTurn.fresh)} | terminalReason=${terminalReason} | timeoutMs=${pending.timeoutMs}`);

        let commands: readonly string[];
        try {
            commands = await vscode.commands.getCommands(true);
        } catch (error) {
            this.finishWebviewCommandReload(pending, 'failed', `getCommands:${String(error)}`);
            return;
        }
        if (!this.isWebviewCommandReloadCurrent(pending)) return;
        const commandId = 'workbench.action.webview.reloadWebviewAction';
        if (!commands.includes(commandId)) {
            this.uiDebugChannel.appendLine(`EXT: webviewCommandReload.unavailable | commandReloadGeneration=${pending.commandReloadGeneration} | episodeId=${episodeId} | commandId=${commandId} | nextAction=manually-run-Reload-Webviews | reloadWindow=false`);
            this.finishWebviewCommandReload(pending, 'failed', 'command-unavailable');
            return;
        }
        this.uiDebugChannel.appendLine(`EXT: webviewCommandReload.available | commandReloadGeneration=${pending.commandReloadGeneration} | episodeId=${episodeId} | commandId=${commandId}`);
        if (!this.isWebviewCommandReloadCurrent(pending)) return;
        pending.invoked = true;
        this.uiDebugChannel.appendLine(`EXT: webviewCommandReload.invoked | commandReloadGeneration=${pending.commandReloadGeneration} | episodeId=${episodeId} | commandId=${commandId}`);
        try {
            await vscode.commands.executeCommand(commandId);
            if (!this.isWebviewCommandReloadCurrent(pending)) return;
            this.uiDebugChannel.appendLine(`EXT: webviewCommandReload.request.resolved | commandReloadGeneration=${pending.commandReloadGeneration} | episodeId=${episodeId} | resultIsNotSuccess=true`);
        } catch (error) {
            this.uiDebugChannel.appendLine(`EXT: webviewCommandReload.executeFailed | commandReloadGeneration=${pending.commandReloadGeneration} | episodeId=${episodeId} | error=${String(error)}`);
            this.finishWebviewCommandReload(pending, 'failed', `executeCommand:${String(error)}`);
        }
    }

    private async handleWebviewCommandReloadReady(data: any, webviewView: vscode.WebviewView, panelId: string): Promise<boolean> {
        const pending = this.webviewCommandReloadPending;
        if (!pending) return false;
        const newWebviewInstanceId = typeof data?.webviewInstanceId === 'string' ? data.webviewInstanceId.trim() : '';
        const currentActiveTurn = this.getWebviewLivenessActiveTurnFlags(pending.sessionId);
        let rejectionReason = '';
        if (!newWebviewInstanceId) rejectionReason = 'missing-webview-instance-id';
        else if (newWebviewInstanceId === pending.oldWebviewInstanceId) rejectionReason = 'same-webview-instance-id';
        else if (Date.now() > pending.deadlineAt) rejectionReason = 'late-handshake';
        else if (this.webviewHardRescuePending) rejectionReason = 'conflicting-live-html-hard-rescue';
        else if (this._view?.webview !== pending.webview || webviewView.webview !== pending.webview) rejectionReason = 'webview-object-mismatch';
        else if (panelId !== pending.panelId) rejectionReason = 'panel-mismatch';
        else if (this.currentSessionId !== pending.sessionId) rejectionReason = 'session-mismatch';
        else if (this.sessionSelectionEpoch !== pending.selectionEpoch) rejectionReason = 'selection-epoch-changed';
        else if ((currentActiveTurn.turnId || '') !== (pending.activeTurn.turnId || '')) rejectionReason = 'active-turn-changed';
        else if (this.webviewHandshakeLifecycle !== pending.commandReloadGeneration) rejectionReason = 'lifecycle-superseded';
        else if (pending.handshakeAccepted) rejectionReason = 'duplicate-handshake';
        if (rejectionReason) {
            this.uiDebugChannel.appendLine(`EXT: webviewCommandReload.handshake.rejected | commandReloadGeneration=${pending.commandReloadGeneration} | episodeId=${pending.episodeId} | reason=${rejectionReason} | oldWebviewInstanceId=${pending.oldWebviewInstanceId || 'null'} | newWebviewInstanceId=${newWebviewInstanceId || 'null'} | observedHardRescueGenerationToken=${data?.hardRescueGenerationToken || 'none'}`);
            return true;
        }
        // The command lifecycle, not the carried HTML token, owns this adoption. No await before it.
        pending.newWebviewInstanceId = newWebviewInstanceId;
        this._webviewInstanceId = pending.newWebviewInstanceId;
        this._view = webviewView;
        pending.handshakeAccepted = true;
        const commandReloadGuard = () => this.isWebviewCommandReloadCurrent(pending);
        this.uiDebugChannel.appendLine(`EXT: webviewCommandReload.handshake.accepted | commandReloadGeneration=${pending.commandReloadGeneration} | episodeId=${pending.episodeId} | sessionId=${pending.sessionId} | panelId=${pending.panelId} | oldWebviewInstanceId=${pending.oldWebviewInstanceId || 'null'} | newWebviewInstanceId=${newWebviewInstanceId} | selectionEpoch=${pending.selectionEpoch} | activeTurnId=${pending.activeTurn.turnId || 'none'} | observedHardRescueGenerationToken=${data?.hardRescueGenerationToken || 'none'} | tokenAuthoritative=false | elapsedMs=${Date.now() - pending.startedAt}`);
        const liveWebview = this._view.webview;
        const hydrationMode = pending.activeTurn.fresh ? 'fresh-active-turn-metadata-live-resume' : 'idle-normal-hydration';
        this.uiDebugChannel.appendLine(`EXT: webviewCommandReload.hydration.mode | commandReloadGeneration=${pending.commandReloadGeneration} | episodeId=${pending.episodeId} | sessionId=${pending.sessionId} | activeTurnId=${pending.activeTurn.turnId || 'none'} | activeTurnFresh=${String(pending.activeTurn.fresh)} | mode=${hydrationMode} | postedSessionData=${String(!pending.activeTurn.fresh)}`);
        try {
            await this.sendInit(liveWebview, {
                isStillCurrent: commandReloadGuard,
                commandReload: { sessionId: pending.sessionId, activeTurn: pending.activeTurn }
            });
            pending.initSucceeded = true;
        } catch (error) {
            this.finishWebviewCommandReload(pending, 'failed', `sendInit:${String(error)}`);
            return true;
        }
        if (!commandReloadGuard()) return true;
        const readyAckPosted = await liveWebview.postMessage({
            type: 'webviewReadyAck',
            timestamp: Date.now(),
            webviewInstanceId: pending.newWebviewInstanceId
        });
        if (!readyAckPosted || !commandReloadGuard()) {
            this.finishWebviewCommandReload(pending, 'failed', 'webviewReadyAck-post-failed-or-stale');
            return true;
        }
        pending.readyAckPosted = true;
        if (pending.timeout) clearTimeout(pending.timeout);
        pending.timeout = undefined;
        this.webviewCommandReloadPending = undefined;
        this.uiDebugChannel.appendLine(`EXT: webviewCommandReload.complete | commandReloadGeneration=${pending.commandReloadGeneration} | episodeId=${pending.episodeId} | sessionId=${pending.sessionId} | panelId=${pending.panelId} | oldWebviewInstanceId=${pending.oldWebviewInstanceId || 'null'} | newWebviewInstanceId=${pending.newWebviewInstanceId || 'null'} | initSucceeded=true | webviewReadyAckPosted=true | elapsedMs=${Date.now() - pending.startedAt}`);
        this.startWebviewLivenessProbes();
        void this.triggerWebviewLivenessProbe('webviewCommandReloadReadyAck');
        return true;
    }

    private beginWebviewHardRescue(attempt: WebviewAutoRescuePendingAttempt): void {
        const record = this.webviewLivenessCurrent;
        const liveWebview = this._view?.webview;
        const activeTurn = this.getWebviewLivenessActiveTurnFlags(attempt.sessionId);
        const episodeId = attempt.episodeId;
        const missedCount = record
            ? Math.max(
                this.webviewLivenessMissedAckCountByToken.get(record.token) || 0,
                this.webviewLivenessSimulatedMissedAckCountByToken.get(record.token) || 0
            )
            : 0;
        const triggerMatches = Boolean(
            !attempt.receivedAckSeen
            && record
            && !record.ackAt
            && liveWebview
            && this.isCurrentWebviewLivenessRecord(record)
            && record.sessionId === attempt.sessionId
            && record.panelId === attempt.panelId
            && record.token === attempt.token
            && (record.webviewInstanceId || '') === (attempt.webviewInstanceId || '')
            && this.sessionSelectionEpoch === attempt.selectionEpoch
            && (activeTurn.turnId || '') === (attempt.activeTurnId || '')
        );
        if (!triggerMatches || !record || !liveWebview) {
            this.uiDebugChannel.appendLine(`EXT: webviewHardRescue.failed | reason=trigger-gate-mismatch | sessionId=${attempt.sessionId} | panelId=${attempt.panelId} | rescueAttemptId=${attempt.rescueAttemptId} | receivedAckSeen=${String(attempt.receivedAckSeen)} | ackAt=${record?.ackAt || 0} | currentRecord=${String(this.webviewLivenessCurrent === record)} | nextAction=Reload Window | automaticRetry=false`);
            return;
        }
        if (this.webviewHardRescuePending || this.webviewHardRescueEpisodeIds.has(episodeId)) {
            this.uiDebugChannel.appendLine(`EXT: webviewHardRescue.failed | reason=one-per-episode-suppressed | sessionId=${attempt.sessionId} | panelId=${attempt.panelId} | rescueAttemptId=${attempt.rescueAttemptId} | episodeId=${episodeId} | nextAction=Reload Window | automaticRetry=false`);
            return;
        }

        const generationToken = `hard-rescue-${Date.now()}-${crypto.randomBytes(12).toString('hex')}`;
        const startedAt = Date.now();
        const oldWebviewInstanceId = this._webviewInstanceId || attempt.webviewInstanceId || '';
        const previousInitPosted = this.initPosted;
        const pending: WebviewHardRescuePending = {
            generationToken,
            rescueAttemptId: attempt.rescueAttemptId,
            sessionId: attempt.sessionId,
            panelId: attempt.panelId,
            livenessToken: record.token,
            episodeId,
            webview: liveWebview,
            oldWebviewInstanceId,
            selectionEpoch: this.sessionSelectionEpoch,
            activeTurn,
            startedAt,
            timeoutAt: startedAt + this.webviewHardRescueTimeoutMs,
            handshakeLifecycle: ++this.webviewHandshakeLifecycle,
            previousInitPosted,
            handshakeAccepted: false
        };
        this.webviewHardRescuePending = pending;
        this.webviewHardRescueEpisodeIds.add(episodeId);
        this.uiDebugChannel.appendLine(
            `EXT: webviewHardRescue.begin | generationToken=${generationToken} | sessionId=${pending.sessionId} | panelId=${pending.panelId} | ` +
            `oldWebviewInstanceId=${oldWebviewInstanceId || 'null'} | rescueAttemptId=${pending.rescueAttemptId} | selectionEpoch=${pending.selectionEpoch} | ` +
            `activeTurnId=${activeTurn.turnId || 'none'} | activeTurnFresh=${String(activeTurn.fresh)} | missedCount=${missedCount} | ` +
            `lastLivenessAckAt=${record.ackAt || 0} | episodeId=${episodeId} | timeoutMs=${this.webviewHardRescueTimeoutMs}`
        );

        this.stopWebviewLivenessProbes('hard-rescue-document-reset');
        if (attempt.timeout) clearTimeout(attempt.timeout);
        attempt.timeout = undefined;
        this.webviewAutoRescuePendingAttemptById.delete(attempt.rescueAttemptId);
        if (record.notificationToken) {
            this.clearWebviewAutoRescueNotificationTimer(record.notificationToken);
            this.webviewAutoRescuePromptMetaByNotificationToken.delete(record.notificationToken);
        }
        this.webviewAutoRescueStateByToken.delete(record.token);
        for (const [key, entry] of this.sendInitGuardCompensationByKey.entries()) {
            if (entry.panelId === pending.panelId && entry.webviewInstanceId === oldWebviewInstanceId) this.sendInitGuardCompensationByKey.delete(key);
        }
        for (const key of this.liveTurnResumePostedByKey) {
            if (key.includes(`:${pending.panelId}:${oldWebviewInstanceId}:`)) this.liveTurnResumePostedByKey.delete(key);
        }
        this.initPosted = activeTurn.fresh;
        pending.timeout = setTimeout(() => this.finishWebviewHardRescueFailure(pending, 'timeout', 'handshake-or-init-timeout'), this.webviewHardRescueTimeoutMs);
        pending.timeout.unref?.();
        try {
            liveWebview.html = this._getHtmlForWebview(liveWebview, generationToken);
            this.uiDebugChannel.appendLine(`EXT: webviewHardRescue.html.assigned | generationToken=${generationToken} | sessionId=${pending.sessionId} | panelId=${pending.panelId} | rescueAttemptId=${pending.rescueAttemptId} | oldWebviewInstanceId=${oldWebviewInstanceId || 'null'} | assigned=true`);
        } catch (error) {
            this.uiDebugChannel.appendLine(`EXT: webviewHardRescue.html.assigned | generationToken=${generationToken} | sessionId=${pending.sessionId} | panelId=${pending.panelId} | rescueAttemptId=${pending.rescueAttemptId} | oldWebviewInstanceId=${oldWebviewInstanceId || 'null'} | assigned=false | error=${String(error)}`);
            this.finishWebviewHardRescueFailure(pending, 'failed', `html-assignment:${String(error)}`);
        }
    }

    private handleWebviewAutoRescueAck(data: any): void {
        const rescueAttemptId = typeof data?.rescueAttemptId === 'string' ? data.rescueAttemptId : '';
        const phase = typeof data?.phase === 'string' ? data.phase as WebviewAutoRescueAckPhase : undefined;
        const attempt = rescueAttemptId ? this.webviewAutoRescuePendingAttemptById.get(rescueAttemptId) : undefined;
        if (!attempt) {
            this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.ack.result | accepted=false | reason=unknown-attempt | phase=${phase || 'unknown'} | rescueAttemptId=${rescueAttemptId || 'null'} | sessionId=${data?.sessionId || 'null'} | branch=${data?.branch || 'unknown'}`);
            return;
        }
        const sessionMatches = data?.sessionId === attempt.sessionId;
        const branchMatches = data?.branch === attempt.branch;
        attempt.lastAck = data;
        if (phase === 'received') {
            attempt.receivedAckSeen = true;
        } else if (phase === 'render-complete' || phase === 'render-skip' || phase === 'render-fail') {
            attempt.renderAckSeen = true;
        }
        const benignSkip = phase === 'render-skip' && data?.reason === 'already-rendered-current-session';
        const acceptedSuccess = sessionMatches && branchMatches && (phase === 'render-complete' || benignSkip);
        attempt.acceptedSuccess = acceptedSuccess;
        this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.ack.result | phase=${phase || 'unknown'} | result=${data?.result || 'unknown'} | reason=${data?.reason || 'none'} | accepted=${String(acceptedSuccess)} | sessionMatches=${String(sessionMatches)} | branchMatches=${String(branchMatches)} | ${this.formatWebviewAutoRescueAckFields(attempt, [`activeSessionMatches=${String(data?.activeSessionMatches === true)}`, `currentSessionMatches=${String(data?.currentSessionMatches === true)}`, `messages=${data?.messages ?? -1}`, `timeline=${data?.timeline ?? -1}`, `rendered=${data?.rendered ?? -1}`])}`);
        if (!acceptedSuccess) {
            if (phase === 'render-skip' || phase === 'render-fail') {
                this.finishWebviewAutoRescuePendingAttemptTimeout(rescueAttemptId, phase === 'render-fail' ? 'render-fail' : 'render-skip');
            }
            return;
        }
        if (attempt.timeout) {
            clearTimeout(attempt.timeout);
            attempt.timeout = undefined;
        }
        this.webviewAutoRescuePendingAttemptById.delete(rescueAttemptId);
        attempt.resolve?.(true);
    }

    private waitForWebviewAutoRescueRenderAck(rescueAttemptId: string): Promise<boolean> {
        const attempt = this.webviewAutoRescuePendingAttemptById.get(rescueAttemptId);
        if (!attempt) return Promise.resolve(false);
        if (attempt.acceptedSuccess) return Promise.resolve(true);
        return new Promise<boolean>((resolve) => {
            attempt.resolve = resolve;
        });
    }

    private cancelWebviewAutoRescuePendingAttempt(rescueAttemptId: string, reason: string): void {
        const attempt = this.webviewAutoRescuePendingAttemptById.get(rescueAttemptId);
        if (!attempt) return;
        if (attempt.timeout) clearTimeout(attempt.timeout);
        this.webviewAutoRescuePendingAttemptById.delete(rescueAttemptId);
        this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.ack.result | accepted=false | reason=${reason} | ${this.formatWebviewAutoRescueAckFields(attempt)}`);
        attempt.resolve?.(false);
    }

    private async postWebviewAutoRescueFreshActiveTurnCommand(record: WebviewLivenessRecord, activeTurn: WebviewLivenessActiveTurnSnapshot, selectionEpoch: number, rescueAttemptId: string): Promise<WebviewAutoRescueSoftRescueResult> {
        const liveWebview = this._view?.webview;
        if (!liveWebview || !this.isCurrentWebviewLivenessRecord(record) || this.currentSessionId !== record.sessionId || this.sessionSelectionEpoch !== selectionEpoch) {
            this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.branch | action=rescue-force-render-skip | branch=fresh-active-turn-command | reason=inactive-session | panelId=${record.panelId} | sessionId=${record.sessionId} | currentSessionId=${this.currentSessionId || 'null'} | token=${record.token} | notificationToken=${record.notificationToken || 'none'} | rescueAttemptId=${rescueAttemptId} | postedSessionData=false | reload=false | recreate=false | sessionMutation=false`);
            return { ok: false, reason: 'soft-rescue-aborted-stale-token', branch: 'fresh-active-turn-command', rescueAttemptId };
        }
        if (!activeTurn.fresh) {
            return { ok: false, reason: 'active-turn-no-longer-fresh', branch: 'fresh-active-turn-command', rescueAttemptId };
        }
        this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.branch | action=rescue-branch-decision | branch=fresh-active-turn-command | reason=fresh-active-turn | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | notificationToken=${record.notificationToken || 'none'} | rescueAttemptId=${rescueAttemptId} | activeTurnId=${activeTurn.turnId || 'none'} | activeTurnSource=${activeTurn.source} | activeTurnAgeMs=${activeTurn.ageMs} | activeTurnFreshnessWindowMs=${activeTurn.freshnessWindowMs} | postedSessionData=false | reload=false | recreate=false | sessionMutation=false`);
        liveWebview.postMessage({
            type: 'webviewAutoRescueRenderCurrentState',
            sessionId: record.sessionId,
            panelId: record.panelId,
            token: record.token,
            notificationToken: record.notificationToken,
            rescueAttemptId,
            rescueSource: 'webviewAutoRescue',
            rescueRenderMode: 'render-current-state-once',
            branch: 'fresh-active-turn-command'
        });
        this.markWebviewAutoRescueAttemptPosted(rescueAttemptId, { command: true });
        this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.command.post | action=rescue-command-posted | branch=fresh-active-turn-command | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | notificationToken=${record.notificationToken || 'none'} | rescueAttemptId=${rescueAttemptId} | postedSessionData=false | reload=false | recreate=false | sessionMutation=false`);
        return { ok: true, phase: 'command', messages: 0, branch: 'fresh-active-turn-command', rescueAttemptId };
    }

    private async repostActiveSessionDataForWebviewSoftRescue(record: WebviewLivenessRecord, rescueAttemptId: string): Promise<WebviewAutoRescueSoftRescueResult> {
        const liveWebview = this._view?.webview;
        if (!liveWebview || !this.isCurrentWebviewLivenessRecord(record)) {
            return { ok: false, reason: 'soft-rescue-aborted-stale-token' };
        }

        const sessionId = record.sessionId;
        const selectionEpoch = this.sessionSelectionEpoch;
        const isStillActive = () => this.isCurrentWebviewLivenessRecord(record) && this.currentSessionId === sessionId && this.sessionSelectionEpoch === selectionEpoch;
        const postIfStillActive = (payload: any, phase: 'snapshot' | 'recent' | 'full', messageCount: number): 'posted' | 'stale-token' | 'active-turn' => {
            if (!isStillActive()) {
                this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.softRescue.abort | action=soft-rescue-aborted-stale-token | reason=stale-before-post | phase=${phase} | panelId=${record.panelId} | sessionId=${sessionId} | token=${record.token} | currentSessionId=${this.currentSessionId || 'null'}`);
                return 'stale-token';
            }
            const activeTurn = this.getWebviewLivenessActiveTurnFlags(sessionId);
            if (activeTurn.fresh) {
                this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.softRescue.defer | action=soft-rescue-deferred-active-turn | reason=fresh-active-turn | phase=${phase} | panelId=${record.panelId} | sessionId=${sessionId} | token=${record.token} | activeTurnId=${activeTurn.turnId || 'none'} | activeTurnSource=${activeTurn.source} | activeTurnAgeMs=${activeTurn.ageMs} | activeTurnFreshnessWindowMs=${activeTurn.freshnessWindowMs} | streaming=${String(activeTurn.streaming)} | finalizing=${String(activeTurn.finalizing)} | postedSessionData=false | reload=false | recreate=false | sessionMutation=false`);
                return 'active-turn';
            }
            liveWebview.postMessage({
                type: 'webviewAutoRescueRenderCurrentState',
                sessionId,
                panelId: record.panelId,
                token: record.token,
                notificationToken: record.notificationToken,
                rescueAttemptId,
                rescueSource: 'webviewAutoRescue',
                rescueRenderMode: 'force-full-render-once',
                branch: 'not-fresh-sessionData'
            });
            this.markWebviewAutoRescueAttemptPosted(rescueAttemptId, { command: true });
            this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.command.post | action=rescue-command-posted | branch=not-fresh-sessionData | mode=force-full-render-once | phase=${phase} | panelId=${record.panelId} | sessionId=${sessionId} | token=${record.token} | notificationToken=${record.notificationToken || 'none'} | webviewInstanceId=${record.webviewInstanceId || this._webviewInstanceId || 'null'} | rescueAttemptId=${rescueAttemptId} | messages=${messageCount} | rescueRenderMode=force-full-render-once | postedSessionData=false | postedCommand=true | reload=false | recreate=false | sessionMutation=false`);
            liveWebview.postMessage({ ...payload, phase, rescueSource: 'webviewAutoRescue', rescueRenderMode: 'force-full-render-once', rescueAttemptId, branch: 'not-fresh-sessionData' });
            this.markWebviewAutoRescueAttemptPosted(rescueAttemptId, { sessionData: true });
            this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.branch | action=rescue-branch-decision | branch=not-fresh-sessionData | reason=not-fresh-active-turn | phase=${phase} | panelId=${record.panelId} | sessionId=${sessionId} | token=${record.token} | notificationToken=${record.notificationToken || 'none'} | rescueAttemptId=${rescueAttemptId} | messages=${messageCount} | activeTurnSource=${activeTurn.source} | activeTurnAgeMs=${activeTurn.ageMs} | activeTurnFreshnessWindowMs=${activeTurn.freshnessWindowMs} | postedSessionData=true | postedCommand=true | rescueRenderMode=force-full-render-once | reload=false | recreate=false | sessionMutation=false`);
            this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.sessionData.post | action=rescue-sessionData-posted | branch=not-fresh-sessionData | phase=${phase} | panelId=${record.panelId} | sessionId=${sessionId} | token=${record.token} | notificationToken=${record.notificationToken || 'none'} | rescueAttemptId=${rescueAttemptId} | messages=${messageCount} | rescueRenderMode=force-full-render-once | postedSessionData=true | postedCommand=true | reload=false | recreate=false | sessionMutation=false`);
            this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.softRescue.repost | action=soft-rescue-ran | branch=not-fresh-sessionData | phase=${phase} | panelId=${record.panelId} | sessionId=${sessionId} | token=${record.token} | notificationToken=${record.notificationToken || 'none'} | rescueAttemptId=${rescueAttemptId} | messages=${messageCount} | activeTurnSource=${activeTurn.source} | activeTurnAgeMs=${activeTurn.ageMs} | activeTurnFreshnessWindowMs=${activeTurn.freshnessWindowMs} | rescueRenderMode=force-full-render-once | reload=false | recreate=false | sessionMutation=false`);
            return 'posted';
        };

        const segMap = this.undoSegmentsBySession.get(sessionId);
        const segments = segMap ? Array.from(segMap.values()) : [];
        let baseTitle = 'Session';
        let baseMessages: SessionMessage[] = [];
        let snapshotTimelineIds: string[] = [];

        try {
            const snap = await this.readSnapshot(sessionId);
            if (!isStillActive()) return { ok: false, reason: 'soft-rescue-aborted-stale-token' };
            if (snap?.obj?.sessionData) {
                const snapshotFormatted = await this.injectChangeLists(sessionId, {
                    title: snap.obj.sessionData?.title || baseTitle,
                    messages: Array.isArray(snap.obj.sessionData?.messages) ? snap.obj.sessionData.messages : []
                });
                if (!isStillActive()) return { ok: false, reason: 'soft-rescue-aborted-stale-token' };
                baseTitle = snapshotFormatted.title || baseTitle;
                baseMessages = snapshotFormatted.messages;
                snapshotTimelineIds = this.getSnapshotTimelineIds(snap.obj.sessionData, baseMessages);
                const snapshotPayload = {
                    type: 'sessionData',
                    sessionId,
                    title: baseTitle,
                    messages: baseMessages,
                    segments,
                    meta: {
                        ...(snap.obj.sessionData?.meta || {}),
                        source: 'snapshot',
                        timelineMessageIds: snapshotTimelineIds,
                        hydrationCoverage: 'deltaContinuityUnknown' as HydrationCoverage
                    }
                };
                const postResult = postIfStillActive(snapshotPayload, 'snapshot', baseMessages.length);
                if (postResult !== 'posted') {
                    return { ok: false, reason: postResult === 'active-turn' ? 'soft-rescue-deferred-active-turn' : 'soft-rescue-aborted-stale-token' };
                }
            }
        } catch (error) {
            this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.softRescue.snapshot.skip | panelId=${record.panelId} | sessionId=${sessionId} | token=${record.token} | err=${String(error)}`);
        }

        try {
            const recentExport = await this.client.exportSessionRecent(sessionId, this.recentSessionLoadLimit);
            if (!isStillActive()) return { ok: false, reason: 'soft-rescue-aborted-stale-token' };
            const formattedRaw = this.formatSession(recentExport);
            const formatted = await this.injectChangeLists(sessionId, formattedRaw);
            if (!isStillActive()) return { ok: false, reason: 'soft-rescue-aborted-stale-token' };
            const snapshotIdSet = new Set<string>(snapshotTimelineIds);
            const snapshotMaxMessageIndex = this.getMaxMessageIndex(baseMessages);
            const continuity = this.classifyRecentAppendCandidates(snapshotIdSet, snapshotMaxMessageIndex, formatted.messages);
            if (snapshotTimelineIds.length > 0 && !continuity.proven) {
                if (!this.snapshotDeltaContinuityRepairEnabled) {
                    return { ok: true, phase: 'snapshot', messages: baseMessages.length, branch: 'not-fresh-sessionData', rescueAttemptId };
                }
                const repairPost = postIfStillActive({
                    type: 'hydrationCoverage',
                    sessionId,
                    hydrationCoverage: 'repairInProgress' as HydrationCoverage
                }, 'snapshot', baseMessages.length);
                if (repairPost !== 'posted') {
                    return { ok: false, reason: repairPost === 'active-turn' ? 'soft-rescue-deferred-active-turn' : 'soft-rescue-aborted-stale-token' };
                }
                throw new Error('snapshot-boundary-unproven');
            }
            const appendMessages = continuity.suffix;
            const mergedMessages = snapshotTimelineIds.length > 0
                ? this.buildImmutableSnapshotWithProvenSuffix(baseMessages, appendMessages)
                : formatted.messages;
            const newIds = appendMessages.map((message) => (typeof message?.id === 'string' ? message.id : '')).filter((id): id is string => Boolean(id));
            const recentPayload = {
                type: 'sessionData',
                sessionId,
                title: formatted.title || baseTitle,
                messages: mergedMessages,
                segments,
                meta: {
                    timelineMessageIds: [...snapshotTimelineIds, ...newIds],
                    hydrationCoverage: (snapshotTimelineIds.length > 0
                        ? 'authoritativeHistoryComplete'
                        : 'deltaContinuityUnknown') as HydrationCoverage
                }
            };
            const postResult = postIfStillActive(recentPayload, 'recent', mergedMessages.length);
            if (postResult === 'posted') {
                return { ok: true, phase: 'recent', messages: mergedMessages.length, branch: 'not-fresh-sessionData', rescueAttemptId };
            }
            return { ok: false, reason: postResult === 'active-turn' ? 'soft-rescue-deferred-active-turn' : 'soft-rescue-aborted-stale-token' };
        } catch (error) {
            this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.softRescue.recent.fail | panelId=${record.panelId} | sessionId=${sessionId} | token=${record.token} | err=${String(error)}`);
        }

        try {
            const exportResult = await this.client.exportSession(sessionId);
            if (!isStillActive()) return { ok: false, reason: 'soft-rescue-aborted-stale-token' };
            const formattedRaw = this.formatSession(exportResult);
            const repairRequiredMessageIds = await this.collectSnapshotRepairRequiredMessageIds(sessionId);
            const fullDelta = this.buildFullExportSnapshotDelta(
                baseMessages, snapshotTimelineIds, formattedRaw.messages, repairRequiredMessageIds
            );
            if (fullDelta.repairedSnapshot) {
                await this.persistStructurallyRepairedSnapshot(
                    sessionId, formattedRaw.title, fullDelta.messages, fullDelta.timelineMessageIds, segments
                );
            }
            const formatted = await this.injectChangeLists(sessionId, { title: formattedRaw.title, messages: fullDelta.messages });
            if (!isStillActive()) return { ok: false, reason: 'soft-rescue-aborted-stale-token' };
            const fullPayload = {
                type: 'sessionData',
                sessionId,
                title: formatted.title,
                messages: formatted.messages,
                segments,
                meta: {
                    timelineMessageIds: fullDelta.timelineMessageIds,
                    hydrationCoverage: (fullDelta.proven
                        ? 'authoritativeHistoryComplete'
                        : 'deltaContinuityUnknown') as HydrationCoverage
                }
            };
            const postResult = postIfStillActive(fullPayload, 'full', formatted.messages.length);
            if (postResult === 'posted') {
                return { ok: true, phase: 'full', messages: formatted.messages.length, branch: 'not-fresh-sessionData', rescueAttemptId };
            }
            return { ok: false, reason: postResult === 'active-turn' ? 'soft-rescue-deferred-active-turn' : 'soft-rescue-aborted-stale-token' };
        } catch (error) {
            if (isStillActive() && snapshotTimelineIds.length > 0) {
                postIfStillActive({ type: 'hydrationCoverage', sessionId, hydrationCoverage: 'repairError' as HydrationCoverage }, 'full', baseMessages.length);
            }
            return { ok: false, reason: `full-export-failed:${String(error)}` };
        }
    }

    private async executeWebviewAutoRescueSoftRescue(record: WebviewLivenessRecord, action: WebviewAutoRescueAction): Promise<void> {
        this.logWebviewAutoRescueDiagnostics(record, 'pre', action);
        if (!this.isCurrentWebviewLivenessRecord(record)) {
            this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.softRescue.abort | action=soft-rescue-aborted-stale-token | reason=stale-token | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | currentSessionId=${this.currentSessionId || 'null'} | reload=false | recreate=false | sessionMutation=false`);
            this.setWebviewAutoRescueState(record, 'failed', 'stale-token');
            this.logWebviewAutoRescueDiagnostics(record, 'post', 'stale-token');
            return;
        }

        const selectionEpoch = this.sessionSelectionEpoch;
        const rescueAttemptId = this.buildWebviewAutoRescueAttemptId(record);
        const activeTurn = this.getWebviewLivenessActiveTurnFlags(record.sessionId);
        const branch = activeTurn.fresh ? 'fresh-active-turn-command' : 'not-fresh-sessionData';
        this.beginWebviewAutoRescuePendingAttempt(record, rescueAttemptId, branch);
        this.setWebviewAutoRescueState(record, 'running-soft-rescue', 'rescue-now');
        this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.action | action=running-soft-rescue | requestedBy=${action} | method=${activeTurn.fresh ? 'active-session-current-state-command' : 'active-session-sessionData-repost'} | branch=${branch} | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | notificationToken=${record.notificationToken || 'none'} | rescueAttemptId=${rescueAttemptId} | activeTurnFresh=${String(activeTurn.fresh)} | ackTimeoutMs=${this.webviewAutoRescueAckTimeoutMs} | reload=false | recreate=false | sessionMutation=false`);
        const result = activeTurn.fresh
            ? await this.postWebviewAutoRescueFreshActiveTurnCommand(record, activeTurn, selectionEpoch, rescueAttemptId)
            : await this.repostActiveSessionDataForWebviewSoftRescue(record, rescueAttemptId);
        if (result.ok) {
            this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.action | action=soft-rescue-posted-awaiting-ack | requestedBy=${action} | method=${result.branch === 'fresh-active-turn-command' ? 'active-session-current-state-command' : 'active-session-sessionData-repost'} | branch=${result.branch || 'unknown'} | phase=${result.phase || 'unknown'} | messages=${result.messages ?? -1} | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | notificationToken=${record.notificationToken || 'none'} | rescueAttemptId=${result.rescueAttemptId || rescueAttemptId} | ackTimeoutMs=${this.webviewAutoRescueAckTimeoutMs} | reload=false | recreate=false | sessionMutation=false`);
            const accepted = await this.waitForWebviewAutoRescueRenderAck(result.rescueAttemptId || rescueAttemptId);
            if (accepted) {
                this.webviewAutoRescueFailureCountByEpisode.delete(record.suspicionEpisodeId || this.getWebviewLivenessEpisodeId(record));
                this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.action | action=soft-rescue-ran | requestedBy=${action} | method=${result.branch === 'fresh-active-turn-command' ? 'active-session-current-state-command' : 'active-session-sessionData-repost'} | branch=${result.branch || 'unknown'} | phase=${result.phase || 'unknown'} | messages=${result.messages ?? -1} | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | notificationToken=${record.notificationToken || 'none'} | rescueAttemptId=${result.rescueAttemptId || rescueAttemptId} | successSource=webview-render-ack | reload=false | recreate=false | sessionMutation=false`);
                this.setWebviewAutoRescueState(record, 'cooldown', 'soft-rescue-success');
            } else {
                this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.action | action=soft-rescue-not-confirmed | requestedBy=${action} | method=${result.branch === 'fresh-active-turn-command' ? 'active-session-current-state-command' : 'active-session-sessionData-repost'} | branch=${result.branch || 'unknown'} | phase=${result.phase || 'unknown'} | messages=${result.messages ?? -1} | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | notificationToken=${record.notificationToken || 'none'} | rescueAttemptId=${result.rescueAttemptId || rescueAttemptId} | successSource=none | reload=false | recreate=false | sessionMutation=false`);
            }
        } else if (result.reason === 'soft-rescue-deferred-active-turn') {
            this.cancelWebviewAutoRescuePendingAttempt(rescueAttemptId, result.reason);
            this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.action | action=soft-rescue-deferred-active-turn | requestedBy=${action} | method=active-session-sessionData-repost | reason=${result.reason} | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | reload=false | recreate=false | sessionMutation=false`);
            this.setWebviewAutoRescueState(record, 'cooldown', 'soft-rescue-deferred-active-turn');
        } else {
            this.cancelWebviewAutoRescuePendingAttempt(rescueAttemptId, result.reason || 'soft-rescue-failed-before-post');
            const episodeId = record.suspicionEpisodeId || this.getWebviewLivenessEpisodeId(record);
            const failureCount = (this.webviewAutoRescueFailureCountByEpisode.get(episodeId) || 0) + 1;
            this.webviewAutoRescueFailureCountByEpisode.set(episodeId, failureCount);
            const staleTokenAction = result.reason === 'soft-rescue-aborted-stale-token' ? 'soft-rescue-aborted-stale-token' : 'soft-rescue-failed';
            this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.action | action=${staleTokenAction} | requestedBy=${action} | method=active-session-sessionData-repost | reason=${result.reason || 'unknown'} | failureCount=${failureCount} | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | reload=false | recreate=false | sessionMutation=false`);
            if (failureCount >= 2) {
                this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.action | action=hard-rescue-needed | reason=repeated-soft-rescue-failure | failureCount=${failureCount} | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | reload=false | recreate=false | sessionMutation=false`);
            }
            this.setWebviewAutoRescueState(record, 'failed', 'soft-rescue-failed');
        }
        this.logWebviewAutoRescueDiagnostics(record, 'post', 'soft-rescue');
    }

    private async showWebviewAutoRescueNotification(record: WebviewLivenessRecord): Promise<void> {
        if (!this.isCurrentWebviewLivenessRecord(record)) {
            this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.disarm | reason=stale-before-notification | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token}`);
            return;
        }
        if (this.isWebviewAutoRescueTerminalStopped(record)) {
            this.logWebviewAutoRescueTerminalStopProbeCycle(record, 'notification-suppressed-terminal-stop');
            return;
        }
        const episodeId = record.suspicionEpisodeId || this.getWebviewLivenessEpisodeId(record);
        const repromptDueAt = this.webviewAutoRescueRepromptDueAtByEpisode.get(episodeId) || 0;
        if (repromptDueAt > Date.now()) {
            this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.liveness.rearm | reason=reprompt-cooldown | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | episodeId=${episodeId} | notificationToken=${record.notificationToken || 'none'} | pendingAgeMs=${this.getWebviewAutoRescuePendingAgeMs(record.notificationToken)} | notificationTtlMs=${this.webviewAutoRescueNotificationTtlMs} | repromptCooldownMs=${this.webviewAutoRescueRepromptCooldownMs} | repromptCount=${this.getWebviewAutoRescueRepromptCount(record)} | maxReprompts=${this.webviewAutoRescueMaxReprompts} | stillUnresponsive=${String(this.isWebviewAutoRescueStillUnresponsive(record))} | userChoiceOnly=true | reload=false | recreate=false | sessionMutation=false`);
            return;
        }
        const notificationToken = `webviewAutoRescue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const repromptCount = this.webviewAutoRescueRepromptCountByEpisode.get(episodeId) || 0;
        const shownAt = Date.now();
        record.notificationToken = notificationToken;
        const meta: WebviewAutoRescuePromptMeta = {
            episodeId,
            notificationToken,
            shownAt,
            expiresAt: shownAt + this.webviewAutoRescueNotificationTtlMs,
            expired: false,
            handled: false,
            repromptCount
        };
        this.webviewAutoRescuePromptMetaByNotificationToken.set(notificationToken, meta);
        this.setWebviewAutoRescueState(record, 'pending-notification', 'notification-show');
        this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.notification.show | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | episodeId=${episodeId} | notificationToken=${notificationToken} | notificationTtlMs=${this.webviewAutoRescueNotificationTtlMs} | pendingAgeMs=0 | repromptCooldownMs=${this.webviewAutoRescueRepromptCooldownMs} | repromptCount=${repromptCount} | maxReprompts=${this.webviewAutoRescueMaxReprompts} | userChoiceOnly=true | reload=false | recreate=false | sessionMutation=false`);
        const ttlTimer = setTimeout(() => {
            this.expireWebviewAutoRescueNotification(record, notificationToken, 'ttl-expired');
        }, this.webviewAutoRescueNotificationTtlMs);
        ttlTimer.unref?.();
        this.webviewAutoRescueNotificationTimerByToken.set(notificationToken, ttlTimer);
        const selected = await vscode.window.showWarningMessage(
            'OpenCode WebView appears unresponsive. Choose whether to run a guarded soft rescue.',
            'Cancel',
            'Rescue Now'
        ).then((action) => action || 'dismissed-as-cancel');
        const action = selected === 'Rescue Now'
            ? 'Rescue Now'
            : selected === 'dismissed-as-cancel'
                ? 'dismissed-as-cancel'
                : 'Cancel';
        this.clearWebviewAutoRescueNotificationTimer(notificationToken);
        meta.handled = true;
        const currentSameToken = this.isCurrentWebviewLivenessRecord(record) && record.notificationToken === notificationToken && !meta.expired;
        if (!currentSameToken) {
            await this.handleExpiredWebviewAutoRescueLateAction(record, meta, action as WebviewAutoRescueAction, selected);
            return;
        }
        try {
            this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.notification.action | selectedAction=${selected} | action=${action} | currentToken=${String(currentSameToken)} | tokenStatus=${currentSameToken ? 'current' : 'stale'} | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | notificationToken=${notificationToken} | currentSessionId=${this.currentSessionId || 'null'}`);
            this.applyWebviewAutoRescueCooldown(record, action as WebviewAutoRescueAction);
            if (action === 'Rescue Now') {
                await this.executeWebviewAutoRescueSoftRescue(record, action as WebviewAutoRescueAction);
            } else {
                this.setWebviewAutoRescueState(record, 'cancelled', action);
                this.logWebviewAutoRescueDiagnostics(record, 'pre', action as WebviewAutoRescueAction);
                this.logWebviewAutoRescueDiagnostics(record, 'post', action as WebviewAutoRescueAction);
            }
        } finally {
            record.pending = false;
            if (this.webviewLivenessCurrent === record) {
                this.webviewLivenessCurrent = undefined;
            }
            this.setWebviewAutoRescueState(record, 'idle', 'notification-complete');
        }
    }

    private async handleExpiredWebviewAutoRescueLateAction(record: WebviewLivenessRecord, meta: WebviewAutoRescuePromptMeta, action: WebviewAutoRescueAction, selectedAction: string): Promise<void> {
        const pendingAgeMs = Math.max(0, Date.now() - meta.shownAt);
        if (action !== 'Rescue Now') {
            this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.liveness.lateCancelIgnored | selectedAction=${selectedAction} | action=${action} | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | episodeId=${meta.episodeId} | notificationToken=${meta.notificationToken} | pendingAgeMs=${pendingAgeMs} | notificationTtlMs=${this.webviewAutoRescueNotificationTtlMs} | userChoiceOnly=true | reload=false | recreate=false | sessionMutation=false`);
            return;
        }

        const currentRecord = this.webviewLivenessCurrent;
        const newerHandledToken = Array.from(this.webviewAutoRescuePromptMetaByNotificationToken.values()).some((candidate) =>
            candidate.episodeId === meta.episodeId &&
            candidate.notificationToken !== meta.notificationToken &&
            candidate.shownAt > meta.shownAt &&
            candidate.handled
        );
        const valid = Boolean(
            currentRecord === record &&
            this.isWebviewAutoRescueStillUnresponsive(record) &&
            this._view?.webview &&
            this._view?.visible &&
            this.currentSessionId === record.sessionId &&
            !newerHandledToken
        );
        if (!valid) {
            this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.liveness.lateActionIgnored | selectedAction=${selectedAction} | action=${action} | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | episodeId=${meta.episodeId} | notificationToken=${meta.notificationToken} | pendingAgeMs=${pendingAgeMs} | notificationTtlMs=${this.webviewAutoRescueNotificationTtlMs} | newerHandledToken=${String(newerHandledToken)} | stillUnresponsive=${String(this.isWebviewAutoRescueStillUnresponsive(record))} | userChoiceOnly=true | reload=false | recreate=false | sessionMutation=false`);
            return;
        }

        const adoptedNotificationToken = `webviewAutoRescue-late-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        record.notificationToken = adoptedNotificationToken;
        this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.liveness.lateActionRevalidated | action=${action} | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | episodeId=${meta.episodeId} | oldNotificationToken=${meta.notificationToken} | notificationToken=${adoptedNotificationToken} | pendingAgeMs=${pendingAgeMs} | notificationTtlMs=${this.webviewAutoRescueNotificationTtlMs} | userChoiceOnly=true | reload=false | recreate=false | sessionMutation=false`);
        this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.liveness.lateActionExecute | action=${action} | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | episodeId=${meta.episodeId} | oldNotificationToken=${meta.notificationToken} | notificationToken=${adoptedNotificationToken} | userChoiceOnly=true | reload=false | recreate=false | sessionMutation=false`);
        this.applyWebviewAutoRescueCooldown(record, action);
        await this.executeWebviewAutoRescueSoftRescue(record, action);
        record.pending = false;
        if (this.webviewLivenessCurrent === record) {
            this.webviewLivenessCurrent = undefined;
        }
        this.setWebviewAutoRescueState(record, 'idle', 'late-action-complete');
    }

    private async triggerWebviewLivenessProbe(reason: string, options: { simulateMissedAck?: boolean } = {}): Promise<void> {
        const record = this.beginWebviewLivenessEpisode(reason);
        const liveWebview = this._view?.webview;
        if (!record || !liveWebview) return;
        const pingId = `webviewLiveness-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        record.pingId = pingId;
        record.pingSentAt = Date.now();
        this.uiDebugChannel.appendLine(`EXT: webviewLiveness.ping.sent | reason=${reason} | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | pingId=${pingId} | timeoutMs=${this.webviewLivenessPingTimeoutMs} | simulateMissedAck=${String(Boolean(options.simulateMissedAck))}`);
        if (!options.simulateMissedAck) {
            liveWebview.postMessage({ type: 'webviewLivenessPing', pingId, token: record.token, sessionId: record.sessionId, panelId: record.panelId, webviewInstanceId: record.webviewInstanceId });
        }
        setTimeout(() => {
            if (!this.isCurrentWebviewLivenessRecord(record) || record.pingId !== pingId) {
                this.uiDebugChannel.appendLine(`EXT: webviewLiveness.timeout.disarm | reason=stale-token | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | pingId=${pingId}`);
                return;
            }
            if (record.ackAt) {
                this.uiDebugChannel.appendLine(`EXT: webviewLiveness.timeout.skip | reason=ack-received | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | pingId=${pingId} | ackAt=${record.ackAt}`);
                this.webviewLivenessMissedAckCountByToken.delete(record.token);
                record.pending = false;
                if (this.webviewLivenessCurrent === record) this.webviewLivenessCurrent = undefined;
                return;
            }
            const activeTurnFlags = this.getWebviewLivenessActiveTurnFlags(record.sessionId);
            const simulateMissedAck = Boolean(options.simulateMissedAck);
            const useSimulatedActiveTurnCount = simulateMissedAck && activeTurnFlags.active;
            const missedCountByToken = useSimulatedActiveTurnCount
                ? this.webviewLivenessSimulatedMissedAckCountByToken
                : this.webviewLivenessMissedAckCountByToken;
            const missedCount = (missedCountByToken.get(record.token) || 0) + 1;
            missedCountByToken.set(record.token, missedCount);
            const simulatedMissedCount = this.webviewLivenessSimulatedMissedAckCountByToken.get(record.token) || 0;
            const missedAckThreshold = activeTurnFlags.active
                ? this.webviewLivenessActiveTurnMissThreshold
                : this.webviewLivenessNonActiveMissThreshold;
            this.uiDebugChannel.appendLine(`EXT: webviewLiveness.missedAck | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | pingId=${pingId} | timeoutMs=${this.webviewLivenessPingTimeoutMs} | missedCount=${missedCount} | simulatedMissedCount=${simulatedMissedCount} | simulateMissedAck=${String(simulateMissedAck)} | threshold=${missedAckThreshold} | ${this.describeWebviewLivenessFlags(record.sessionId)}`);
            if (missedCount < missedAckThreshold) {
                const deferReason = activeTurnFlags.active ? 'active-streaming-or-finalizing' : 'missed-ack-threshold';
                this.uiDebugChannel.appendLine(`EXT: webviewLiveness.guard.defer | reason=${deferReason} | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | pingId=${pingId} | missedCount=${missedCount} | requiredMisses=${missedAckThreshold} | retryMs=${this.webviewLivenessPingTimeoutMs} | streaming=${String(activeTurnFlags.streaming)} | finalizing=${String(activeTurnFlags.finalizing)}`);
                record.pending = false;
                if (this.webviewLivenessCurrent === record) this.webviewLivenessCurrent = undefined;
                setTimeout(() => {
                    void this.triggerWebviewLivenessProbe(activeTurnFlags.active ? 'active-turn-guard-retry' : 'missed-ack-threshold-retry');
                }, this.webviewLivenessPingTimeoutMs);
                return;
            }
            if (activeTurnFlags.active) {
                this.uiDebugChannel.appendLine(`EXT: webviewLiveness.guard.satisfied | reason=repeated-missed-ack | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | pingId=${pingId} | missedCount=${missedCount} | requiredMisses=${missedAckThreshold} | streaming=${String(activeTurnFlags.streaming)} | finalizing=${String(activeTurnFlags.finalizing)}`);
            }
            if (this.isWebviewAutoRescueTerminalStopped(record)) {
                this.logWebviewAutoRescueTerminalStopProbeCycle(record, 'missed-ack-terminal-stop');
                this.webviewLivenessSimulatedMissedAckCountByToken.delete(record.token);
                return;
            }
            const episodeId = record.suspicionEpisodeId || this.getWebviewLivenessEpisodeId(record);
            const repromptDueAt = this.webviewAutoRescueRepromptDueAtByEpisode.get(episodeId) || 0;
            if (repromptDueAt > Date.now()) {
                this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.liveness.rearm | reason=reprompt-cooldown | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | episodeId=${episodeId} | notificationToken=${record.notificationToken || 'none'} | pendingAgeMs=${this.getWebviewAutoRescuePendingAgeMs(record.notificationToken)} | notificationTtlMs=${this.webviewAutoRescueNotificationTtlMs} | repromptCooldownMs=${this.webviewAutoRescueRepromptCooldownMs} | repromptCount=${this.getWebviewAutoRescueRepromptCount(record)} | maxReprompts=${this.webviewAutoRescueMaxReprompts} | stillUnresponsive=true | userChoiceOnly=true | reload=false | recreate=false | sessionMutation=false`);
                this.webviewLivenessSimulatedMissedAckCountByToken.delete(record.token);
                return;
            }
            if (record.notificationToken) {
                const promptMeta = this.webviewAutoRescuePromptMetaByNotificationToken.get(record.notificationToken);
                const pendingAgeMs = this.getWebviewAutoRescuePendingAgeMs(record.notificationToken);
                if (promptMeta && !promptMeta.expired && !promptMeta.handled) {
                    this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.liveness.rearm | reason=notification-already-pending | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | episodeId=${episodeId} | notificationToken=${record.notificationToken} | pendingAgeMs=${pendingAgeMs} | notificationTtlMs=${this.webviewAutoRescueNotificationTtlMs} | repromptCooldownMs=${this.webviewAutoRescueRepromptCooldownMs} | repromptCount=${promptMeta.repromptCount} | maxReprompts=${this.webviewAutoRescueMaxReprompts} | stillUnresponsive=true | userChoiceOnly=true | reload=false | recreate=false | sessionMutation=false`);
                    this.webviewLivenessSimulatedMissedAckCountByToken.delete(record.token);
                    return;
                }
            }
            void this.showWebviewAutoRescueNotification(record);
            this.webviewLivenessSimulatedMissedAckCountByToken.delete(record.token);
        }, this.webviewLivenessPingTimeoutMs);
    }

    private handleWebviewLivenessAck(data: any): void {
        const record = this.webviewLivenessCurrent;
        const pingId = typeof data?.pingId === 'string' ? data.pingId : '';
        const token = typeof data?.token === 'string' ? data.token : '';
        if (!record || record.pingId !== pingId || record.token !== token || !this.isCurrentWebviewLivenessRecord(record)) {
            this.uiDebugChannel.appendLine(`EXT: webviewLiveness.ack.drop | reason=stale-or-mismatch | pingId=${pingId || 'null'} | token=${token || 'null'} | currentToken=${record?.token || 'none'} | currentPingId=${record?.pingId || 'none'} | sessionId=${data?.sessionId || 'null'}`);
            return;
        }
        record.ackAt = Date.now();
        for (const attempt of this.webviewAutoRescuePendingAttemptById.values()) {
            if (attempt.sessionId === record.sessionId && attempt.panelId === record.panelId && attempt.token === record.token) {
                attempt.lastLivenessAckAt = record.ackAt;
            }
        }
        this.webviewLivenessMissedAckCountByToken.delete(record.token);
        if (!this.getWebviewLivenessActiveTurnFlags(record.sessionId).active) {
            this.webviewLivenessSimulatedMissedAckCountByToken.delete(record.token);
        }
        this.uiDebugChannel.appendLine(`EXT: webviewLiveness.ack | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | pingId=${pingId} | rttMs=${record.pingSentAt ? record.ackAt - record.pingSentAt : -1}`);
        const promptMeta = record.notificationToken
            ? this.webviewAutoRescuePromptMetaByNotificationToken.get(record.notificationToken)
            : undefined;
        if (promptMeta && !promptMeta.handled && !promptMeta.expired) {
            this.uiDebugChannel.appendLine(`EXT: webviewAutoRescue.notification.ackDeferredCleanup | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | pingId=${pingId} | notificationToken=${promptMeta.notificationToken} | ackAt=${record.ackAt}`);
            return;
        }
        record.pending = false;
        if (this.webviewLivenessCurrent === record) {
            this.webviewLivenessCurrent = undefined;
        }
    }

    public async debugTriggerWebviewLivenessMissedAck(): Promise<void> {
        await this.triggerWebviewLivenessProbe('debug-command', { simulateMissedAck: true });
    }

    public async setDebugWebviewLivenessAckDrop(enabled: boolean): Promise<void> {
        const liveWebview = this._view?.webview;
        if (!liveWebview) {
            this.uiDebugChannel.appendLine(`EXT: webviewLiveness.ackDrop.command | enabled=${String(enabled)} | viewReady=${String(Boolean(this._view))} | no-view`);
            return;
        }

        this.uiDebugChannel.appendLine(`EXT: webviewLiveness.ackDrop.command | enabled=${String(enabled)} | viewReady=${String(Boolean(this._view))}`);
        await liveWebview.postMessage({
            type: 'debugWebviewLivenessAckDrop',
            enabled
        });
    }

    private startWebviewLivenessProbes(): void {
        if (this.webviewLivenessProbeTimer) return;
        this.webviewLivenessProbeTimer = setInterval(() => {
            void this.triggerWebviewLivenessProbe('interval');
        }, this.webviewLivenessProbeIntervalMs);
        this.webviewLivenessProbeTimer.unref?.();
        this.uiDebugChannel.appendLine(`EXT: webviewLiveness.timer.start | intervalMs=${this.webviewLivenessProbeIntervalMs}`);
    }

    private stopWebviewLivenessProbes(reason: string): void {
        if (this.webviewLivenessProbeTimer) {
            clearInterval(this.webviewLivenessProbeTimer);
            this.webviewLivenessProbeTimer = undefined;
            this.uiDebugChannel.appendLine(`EXT: webviewLiveness.timer.stop | reason=${reason}`);
        }
        this.resetWebviewLiveness(reason);
    }

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

    private createConflictId(kind: string, operationId: string): string {
        return `conflict_${kind}_${operationId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
            if (candidate.parentID) continue;
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
        await this.ensureUserOwnedSessionsLoaded();
        if (!workspaceRoot) {
            const mainSessions = sessions.filter(s => !s.parentID);
            const excludedChildSessions = sessions.length - mainSessions.length;
            this.uiDebugChannel.appendLine(
                `[EXT][SESSION_LIST_FILTER] reason=${reason} workspace=null total=${sessions.length} included=${mainSessions.length} mainIncluded=${mainSessions.length} excludedChildSessions=${excludedChildSessions}`
            );
            return mainSessions;
        }

        const filtered: SessionInfo[] = [];
        let mainWorkspaceMatch = 0;
        let mainWorkspaceMismatch = 0;
        let mainWorkspaceUnknown = 0;
        let unknownIncluded = 0;
        let excludedChildSessions = 0;
        for (const session of sessions) {
            if (session.parentID) {
                excludedChildSessions++;
                continue;
            }
            const match = await this.getSessionWorkspaceMatch(session.id, workspaceRoot, session.cwd);
            if (match === 'match') {
                filtered.push(session);
                mainWorkspaceMatch++;
            } else if (match === 'mismatch') {
                mainWorkspaceMismatch++;
            } else {
                filtered.push(session);
                mainWorkspaceUnknown++;
                unknownIncluded++;
            }
        }
        this.uiDebugChannel.appendLine(
            `[EXT][SESSION_LIST_FILTER] reason=${reason} workspace=${workspaceRoot} total=${sessions.length} included=${filtered.length} mainIncluded=${filtered.length} excludedChildSessions=${excludedChildSessions} mainWorkspaceMatch=${mainWorkspaceMatch} mainWorkspaceMismatch=${mainWorkspaceMismatch} mainWorkspaceUnknown=${mainWorkspaceUnknown} unknownIncluded=${unknownIncluded}`
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

    private getCanceledTurnsDir(): string {
        return pathModule.join(this.getOpencodeDataDir(), 'sessionCanceledTurns');
    }

    private getLegacyWorkspaceDataDir(kind: 'sessionChangeLists' | 'sessionCanceledTurns' | 'revertedSegments'): string {
        const workspaceRoot = this.getWorkspaceRootPath();
        const workspaceKey = this.getWorkspaceKeyForRoot(workspaceRoot);
        return pathModule.join(this._context.globalStoragePath, kind, workspaceKey);
    }

    private getLegacyCanceledTurnsPath(sessionId: string): string {
        return pathModule.join(this.getLegacyWorkspaceDataDir('sessionCanceledTurns'), `${sessionId}.json`);
    }

    private getCanceledTurnsPath(sessionId: string): string {
        return pathModule.join(this.getCanceledTurnsDir(), `${sessionId}.json`);
    }

    private getChangeListStore(): ChangeListStore {
        if (!this.changeListStore) {
            this.changeListStore = new ChangeListStore({
                getDataDir: () => pathModule.join(this.getOpencodeDataDir(), 'sessionChangeLists'),
                getLegacyDir: () => this.getLegacyWorkspaceDataDir('sessionChangeLists'),
                ensureDir: (dir) => this.ensureDir(dir),
                log: (line) => this.uiDebugChannel.appendLine(line),
            });
        }
        return this.changeListStore;
    }

    private async readChangeLists(sessionId: string): Promise<ChangeListRecord[]> {
        return this.getChangeListStore().read(sessionId);
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
        await this.getChangeListStore().write(sessionId, records);
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
        const resolved = this.resolvePersistedVisibleOwnerMessageId(map, fallbackMessageId || null);
        return typeof resolved === 'string' ? resolved : fallbackMessageId;
    }

    private resolvePersistedVisibleOwnerMessageId(map: SessionMap | null, fallbackMessageId: string | null): string | null {
        if (!fallbackMessageId) return null;
        const currentOwnerMsgId = map?.continuation?.currentOwnerMsgId;
        const hasContinuationChainIdentity = typeof map?.continuation?.chainId === 'string'
            && map.continuation.chainId.length > 0;
        const hasContinuationTurnEntry = Array.isArray(map?.entries)
            && typeof currentOwnerMsgId === 'string'
            && map.entries.some((entry) => {
                const entryOwner = entry.finalAssistantMsgId || entry.assistantMsgId;
                return entryOwner === currentOwnerMsgId
                    && typeof entry.turnKey === 'string'
                    && entry.turnKey.startsWith('cont:');
            });
        if (!hasContinuationChainIdentity && !hasContinuationTurnEntry) return fallbackMessageId;
        return resolveCurrentVisibleOwnerMsgId(map, fallbackMessageId) || fallbackMessageId;
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
            const resolvedMessageId = this.resolvePersistedVisibleOwnerMessageId(map, message.id) || message.id;
            if (role === 'assistant' && resolvedMessageId !== message.id) {
                continue;
            }
            const nextMessage: SessionMessage = { ...message };
            if (role === 'user' && nextMessage.meta && typeof nextMessage.meta === 'object') {
                const currentAssistantId = typeof nextMessage.meta.assistantId === 'string'
                    ? nextMessage.meta.assistantId
                    : undefined;
                if (currentAssistantId) {
                    const resolvedAssistantId = this.resolvePersistedVisibleOwnerMessageId(map, currentAssistantId) || currentAssistantId;
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

    private async upsertChangeList(sessionId: string, record: ChangeListRecord, options: { preserveAuthoritativeFiles?: boolean } = {}): Promise<void> {
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
        const recordsToWrite = options.preserveAuthoritativeFiles
            ? records
            : await this.collapseOwnerChangeLists(
                sessionId,
                records,
                nextRecord.anchorMessageId,
                nextRecord
            );
        await this.writeChangeLists(sessionId, recordsToWrite);
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

        const ownershipMap = await this.readPersistedSessionMap(sessionId);
        const injection = injectChangeListRecords({
            messages: formatted.messages || [],
            records,
            resolveOwner: (candidate) => this.resolvePersistedVisibleOwnerMessageId(ownershipMap, candidate),
            onMissingAnchor: (record, resolvedAnchor) => {
                this.uiDebugChannel.appendLine(
                    `[EXT][CHANGELIST_INJECT_SKIP] sessionId=${sessionId} changeListId=${record.id || 'null'} anchor=${record.anchorMessageId || 'null'} resolvedAnchor=${resolvedAnchor || 'null'} reason=missing-resolvable-anchor`
                );
            },
        });
        const counts = injection.counts;
        this.uiDebugChannel.appendLine(
            `[EXT][CHANGELIST_INJECT] sessionId=${sessionId} read=${counts.read} injectedByResolvedAnchor=${counts.injectedByResolvedAnchor} convertedByExistingId=${counts.convertedByExistingId} skippedMissingAnchor=${counts.skippedMissingAnchor} skippedDuplicate=${counts.skippedDuplicate}`
        );
        return { ...formatted, messages: this.normalizeDisplayMessagesForSnapshot(injection.messages) };
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

    private getSnapshotTimelineIds(sessionData: any, formattedMessages: SessionMessage[]): string[] {
        return deriveSnapshotTimelineIds({
            sessionData,
            formattedMessages,
            collectVisible: (messages) => this.collectVisibleSnapshotMessages(messages),
        });
    }

    private computeRecentVisibleAppend(snapshotTimelineIdSet: Set<string>, recentFormattedMessages: SessionMessage[]): string[] {
        return planRecentVisibleAppend({
            snapshotTimelineIdSet,
            recentFormattedMessages,
            isVisible: (message) => this.collectVisibleSnapshotMessages([message]).length === 1,
        });
    }

    private getMaxMessageIndex(messages: SessionMessage[]): number | null {
        return findMaxMessageIndex(messages);
    }

    private computeRecentAppendCandidates(
        snapshotTimelineIdSet: Set<string>,
        snapshotMaxMessageIndex: number | null,
        recentFormattedMessages: SessionMessage[]
    ): SessionMessage[] {
        return this.classifyRecentAppendCandidates(
            snapshotTimelineIdSet,
            snapshotMaxMessageIndex,
            recentFormattedMessages
        ).suffix;
    }

    private classifyRecentAppendCandidates(
        snapshotTimelineIdSet: Set<string>,
        snapshotMaxMessageIndex: number | null,
        recentFormattedMessages: SessionMessage[]
    ): { proven: boolean; suffix: SessionMessage[] } {
        return classifySnapshotAppendCandidates({
            snapshotTimelineIdSet,
            snapshotMaxMessageIndex,
            recentFormattedMessages,
            isVisible: (message) => this.collectVisibleSnapshotMessages([message]).length === 1,
        });
    }

    private buildFullExportSnapshotDelta(
        existingSnapshotRecords: SessionMessage[],
        snapshotTimelineIds: string[],
        fullExportRecords: SessionMessage[],
        repairRequiredMessageIds: string[] = []
    ): { proven: boolean; messages: SessionMessage[]; timelineMessageIds: string[]; repairedSnapshot?: boolean } {
        return planFullExportSnapshotDelta({
            existingSnapshotRecords,
            snapshotTimelineIds,
            fullExportRecords,
            repairRequiredMessageIds,
            appendImmutable: (existing, suffix) => this.buildImmutableSnapshotWithProvenSuffix(existing, suffix),
        });
    }

    private async collectSnapshotRepairRequiredMessageIds(sessionId: string): Promise<string[]> {
        const [records, map] = await Promise.all([
            this.readChangeLists(sessionId),
            this.readPersistedSessionMap(sessionId)
        ]);
        return Array.from(new Set(records
            .map((record) => this.resolvePersistedVisibleOwnerMessageId(map, record.anchorMessageId || null))
            .filter((id): id is string => typeof id === 'string' && id.startsWith('msg_'))));
    }

    private async persistStructurallyRepairedSnapshot(
        sessionId: string,
        title: string,
        messages: SessionMessage[],
        timelineMessageIds: string[],
        segments: any[]
    ): Promise<void> {
        const sessionData = await this.buildSnapshotSessionPayload({
            type: 'sessionData',
            sessionId,
            title,
            messages,
            segments,
            meta: { timelineMessageIds }
        });
        const snapshotObj = { sessionId, exportedAt: Date.now(), sessionData };
        const bytes = await this.writeSnapshotAtomic(sessionId, snapshotObj);
        this.lastSnapshotPayloadBySession.set(sessionId, sessionData);
        this.uiTimelineBySession.set(sessionId, timelineMessageIds);
        this.uiDebugChannel.appendLine(
            `[EXT][SNAP_REPAIR_WRITE] sessionId=${sessionId} timelineCount=${timelineMessageIds.length} messageCount=${messages.length} bytes=${bytes}`
        );
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
        if (Array.isArray(meta.appendedPrompts)) {
            const appendedPrompts = this.sanitizeAppendSnapshotItems(meta.appendedPrompts);
            if (appendedPrompts.length > 0) {
                out.appendedPrompts = appendedPrompts;
            } else {
                delete out.appendedPrompts;
            }
        }
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

    private sanitizeAppendSnapshotItems(items: unknown): Array<Record<string, unknown>> {
        if (!Array.isArray(items)) return [];
        const out: Array<Record<string, unknown>> = [];
        const seen = new Set<string>();
        for (const raw of items) {
            if (!raw || typeof raw !== 'object') continue;
            const item = raw as Record<string, unknown>;
            const sanitized: Record<string, unknown> = {};
            const copyString = (name: string, maxLen = 20000) => {
                const value = item[name];
                if (typeof value === 'string' && value.length > 0) sanitized[name] = value.slice(0, maxLen);
            };
            copyString('clientMessageId', 512);
            copyString('appendUserMsgId', 512);
            copyString('rootUserMsgId', 512);
            copyString('status', 64);
            copyString('reason', 1000);
            copyString('text', 20000);
            for (const name of ['createdAt', 'updatedAt']) {
                const value = item[name];
                if (typeof value === 'number' && Number.isFinite(value)) sanitized[name] = value;
            }
            if (!Object.keys(sanitized).length) continue;
            const key = String(sanitized.clientMessageId || sanitized.appendUserMsgId || out.length);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(sanitized);
        }
        return out;
    }

    private sanitizeAppendSnapshotMetaPayload(payload: any): Map<string, AppendSnapshotMetaRoot> {
        const out = new Map<string, AppendSnapshotMetaRoot>();
        const roots = Array.isArray(payload?.roots) ? payload.roots : [];
        for (const root of roots) {
            if (!root || typeof root !== 'object') continue;
            const rootMessageId = typeof root.rootMessageId === 'string' ? root.rootMessageId : '';
            if (!rootMessageId || rootMessageId.startsWith('local-') || rootMessageId.startsWith('tmp:')) continue;
            const appendedPrompts = this.sanitizeAppendSnapshotItems(root.meta?.appendedPrompts);
            if (!appendedPrompts.length) continue;
            out.set(rootMessageId, {
                rootMessageId,
                appendRootUserKey: typeof root.appendRootUserKey === 'string' ? root.appendRootUserKey : rootMessageId,
                meta: { appendedPrompts }
            });
        }
        return out;
    }

    private cacheAppendSnapshotMeta(payload: any): void {
        const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
        if (!sessionId) return;
        const incoming = this.sanitizeAppendSnapshotMetaPayload(payload);
        if (!incoming.size) return;
        const existing = this.appendSnapshotMetaBySession.get(sessionId) || new Map<string, AppendSnapshotMetaRoot>();
        for (const [rootMessageId, entry] of incoming.entries()) {
            existing.set(rootMessageId, entry);
        }
        this.appendSnapshotMetaBySession.set(sessionId, existing);
        const appendCount = Array.from(existing.values()).reduce((sum, root) => sum + root.meta.appendedPrompts.length, 0);
        this.uiDebugChannel.appendLine(`[EXT][APPEND_SNAPSHOT_META] cache sessionId=${sessionId} rootCount=${existing.size} appendCount=${appendCount} reason=${typeof payload?.reason === 'string' ? payload.reason : 'unknown'}`);
    }

    private applyAppendSnapshotMeta(sessionId: string, messagesById: Map<string, SessionMessage>): number {
        const cached = this.appendSnapshotMetaBySession.get(sessionId);
        if (!cached?.size) return 0;
        let merged = 0;
        for (const [rootMessageId, entry] of cached.entries()) {
            const message = messagesById.get(rootMessageId);
            if (!message || message.role !== 'user') continue;
            const existingMeta = message.meta && typeof message.meta === 'object' ? message.meta : {};
            message.meta = {
                ...existingMeta,
                appendedPrompts: entry.meta.appendedPrompts,
                appendRootUserKey: entry.appendRootUserKey || rootMessageId
            };
            messagesById.set(rootMessageId, message);
            merged++;
        }
        if (merged > 0) {
            this.uiDebugChannel.appendLine(`[EXT][APPEND_SNAPSHOT_META] merge sessionId=${sessionId} rootCount=${merged}`);
        }
        return merged;
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
        const normalizedExisting = this.normalizeSnapshotStoredMessages(canonicalExistingMessages);
        const existingTimelineRaw = this.getSnapshotTimelineIds(snapshotObj.sessionData, normalizedExisting);
        const existingTimeline = Array.from(new Set(existingTimelineRaw.filter((id): id is string => typeof id === 'string' && Boolean(id))));
        const existingIdSet = new Set(existingTimeline);
        const boundaryId = existingTimeline[existingTimeline.length - 1];
        const boundaryIndex = boundaryId ? canonicalTimelineIds.indexOf(boundaryId) : -1;
        const provenTimelineSuffix = existingTimeline.length === 0
            ? canonicalTimelineIds
            : boundaryIndex >= 0
                ? canonicalTimelineIds.slice(boundaryIndex + 1).filter((id) => !existingIdSet.has(id))
                : [];
        const provenIdSet = new Set(provenTimelineSuffix);
        const provenMessageSuffix = canonicalIncomingMessages.filter((message) => (
            typeof message?.id === 'string' && provenIdSet.has(message.id)
        ));
        const immutableRemoteRecords = this.buildImmutableSnapshotWithProvenSuffix(normalizedExisting, provenMessageSuffix);
        const combinedById = new Map<string, SessionMessage>();
        for (const message of immutableRemoteRecords) {
            if (typeof message.id === 'string' && message.id) combinedById.set(message.id, message);
        }
        // Local change-list records are reapplied only after immutable remote construction.
        for (const message of canonicalIncomingMessages) {
            if (message?.role !== 'system' || message.meta?.kind !== 'changeList') continue;
            if (typeof message.id !== 'string' || !provenIdSet.has(message.id) || combinedById.has(message.id)) continue;
            combinedById.set(message.id, message);
        }
        this.applyAppendSnapshotMeta(sessionId, combinedById);
        const nextTimeline = [...existingTimeline, ...provenTimelineSuffix];
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
        if (!payload || typeof payload.sessionId !== 'string' || !payload.sessionId) {
            this.uiDebugChannel.appendLine(`[EXT][SNAPSHOT_ROUTE] reason=missing-session currentSessionId=${this.currentSessionId || 'null'}`);
            return;
        }
        const { sessionId } = payload;
        const payloadTimelineIds = Array.isArray(payload.timelineIds)
            ? payload.timelineIds.filter((id: unknown): id is string => typeof id === 'string' && Boolean(id))
            : [];
        const source = typeof payload.source === 'string' ? payload.source : 'webview-render';
        const reason = typeof payload.reason === 'string' ? payload.reason : 'legacy-webview-snapshotTimelineIds';
        this.uiDebugChannel.appendLine(
            `[EXT][SNAPSHOT_ROUTE] sessionId=${sessionId} currentSessionId=${this.currentSessionId || 'null'} reason=drop-switch-readonly source=${source} payloadReason=${reason} timelineCount=${payloadTimelineIds.length}`
        );
    }

    private async writeFinalizeSnapshotFromCanonicalSession(identity: FinalizeTurnIdentity, title?: string): Promise<void> {
        const sessionId = identity?.sessionId;
        if (!sessionId) return;
        try {
            const exportData = await this.client.exportSession(sessionId);
            const formatted = this.formatSession(exportData);
            const canonicalMessages = Array.isArray(formatted.messages)
                ? formatted.messages.filter((message): message is SessionMessage => {
                    const id = typeof message?.id === 'string' ? message.id : '';
                    const role = message?.role;
                    return id.startsWith('msg_')
                        && !id.startsWith('local-')
                        && !id.startsWith('tmp:')
                        && (role === 'user' || role === 'assistant' || role === 'system');
                })
                : [];
            const timelineIds = Array.from(new Set(
                canonicalMessages
                    .map((message) => (typeof message.id === 'string' ? message.id : ''))
                    .filter((id): id is string => id.startsWith('msg_') && !id.startsWith('local-') && !id.startsWith('tmp:'))
            ));
            if (!timelineIds.length || !canonicalMessages.length) {
                this.uiDebugChannel.appendLine(
                    `[EXT][SNAPSHOT_ROUTE] reason=finalize-owned-skip source=finalize-extension sessionId=${sessionId} activeSessionId=${this.currentSessionId || 'null'} timelineCount=${timelineIds.length} messageCount=${canonicalMessages.length} userMessageId=${identity.userMessageId || 'null'} assistantMessageId=${identity.assistantMessageId || 'null'} webviewSnapshotTimelineIdsRequired=false detail=empty-canonical-export`
                );
                await this.writeFinalizeSnapshotFromPendingTurn(identity, title, 'empty-canonical-export');
                return;
            }
            const snapshotTitle = typeof title === 'string' && title.trim()
                ? title
                : formatted.title;
            const bytes = await this.appendSnapshotIncremental(sessionId, timelineIds, canonicalMessages, snapshotTitle);
            this.uiTimelineBySession.set(sessionId, timelineIds);
            this.uiDebugChannel.appendLine(
                `[EXT][SNAPSHOT_ROUTE] reason=finalize-owned-write source=finalize-extension sessionId=${sessionId} activeSessionId=${this.currentSessionId || 'null'} timelineCount=${timelineIds.length} messageCount=${canonicalMessages.length} userMessageId=${identity.userMessageId || 'null'} assistantMessageId=${identity.assistantMessageId || 'null'} webviewSnapshotTimelineIdsRequired=false bytes=${bytes}`
            );
        } catch (error) {
            this.uiDebugChannel.appendLine(
                `[EXT][SNAPSHOT_ROUTE] reason=finalize-owned-error source=finalize-extension sessionId=${sessionId} activeSessionId=${this.currentSessionId || 'null'} userMessageId=${identity.userMessageId || 'null'} assistantMessageId=${identity.assistantMessageId || 'null'} webviewSnapshotTimelineIdsRequired=false err=${String(error)}`
            );
            await this.writeFinalizeSnapshotFromPendingTurn(identity, title, `canonical-export-error:${String(error)}`);
        } finally {
            this.pendingSnapshotUserTextBySession.delete(sessionId);
            this.assistantTextBufferBySession.delete(sessionId);
        }
    }

    private async writeFinalizeSnapshotFromPendingTurn(
        identity: FinalizeTurnIdentity,
        title: string | undefined,
        trigger: string
    ): Promise<void> {
        const sessionId = identity.sessionId;
        try {
            const pendingLocalKey = identity.clientMessageId || this.pendingLocalKeyBySession.get(sessionId);
            const mappedUserMessageId = pendingLocalKey ? this.clientMessageIdMap.get(pendingLocalKey) : undefined;
            const userMessageId = [
                identity.userMessageId,
                identity.latestAppendUserMessageId,
                mappedUserMessageId,
                this.client.getCurrentTurnUserMsgId(sessionId)
            ].find((id) => this.isResolvableMessageId(id));
            const assistantMessageId = [
                identity.assistantMessageId,
                this.pendingAssistantMessageIdBySession.get(sessionId),
                this.client.getTurnAssistantMsgId(sessionId)
            ].find((id) => this.isResolvableMessageId(id));
            const rawUserText = this.pendingSnapshotUserTextBySession.get(sessionId)
                ?? (userMessageId ? this.rawUserTextByMsgId.get(userMessageId) : undefined)
                ?? (pendingLocalKey ? this.rawUserTextByLocalKey.get(pendingLocalKey) : undefined)
                ?? (pendingLocalKey ? this.draftByLocalKey.get(pendingLocalKey)?.text : undefined)
                ?? '';
            const userText = this.normalizeUserTextForSnapshot(rawUserText);
            const assistantText = this.assistantTextBufferBySession.get(sessionId) || '';
            const pendingMessages: SessionMessage[] = [];
            if (userMessageId && userText && !this.isHiddenControlUserText(userText)) {
                pendingMessages.push({
                    role: 'user',
                    id: userMessageId,
                    text: userText,
                    messageIndex: this.client.getMessageIndex(userMessageId, sessionId)
                });
            }
            if (assistantMessageId && assistantText && !this.isHiddenControlAssistantText(assistantText)) {
                pendingMessages.push({
                    role: 'assistant',
                    id: assistantMessageId,
                    text: assistantText,
                    messageIndex: this.client.getMessageIndex(assistantMessageId, sessionId)
                });
            }
            if (!pendingMessages.length) {
                this.uiDebugChannel.appendLine(
                    `[EXT][SNAPSHOT_ROUTE] reason=finalize-fallback-skip source=pending-turn sessionId=${sessionId} trigger=${trigger} userMessageId=${userMessageId || 'null'} assistantMessageId=${assistantMessageId || 'null'} userTextLength=${userText.length} assistantTextLength=${assistantText.length} detail=no-canonical-visible-records`
                );
                return;
            }
            const existing = await this.readSnapshot(sessionId);
            const existingMessages: SessionMessage[] = Array.isArray(existing?.obj?.sessionData?.messages)
                ? existing.obj.sessionData.messages
                : [];
            const existingTimelineRaw = this.getSnapshotTimelineIds(existing?.obj?.sessionData, existingMessages);
            const timelineIds = Array.from(new Set([
                ...existingTimelineRaw.filter((id: unknown): id is string => typeof id === 'string' && Boolean(id)),
                ...pendingMessages.map((message) => message.id).filter((id): id is string => typeof id === 'string' && Boolean(id))
            ]));
            const bytes = await this.appendSnapshotIncremental(sessionId, timelineIds, pendingMessages, title);
            this.uiTimelineBySession.set(sessionId, timelineIds);
            this.uiDebugChannel.appendLine(
                `[EXT][SNAPSHOT_ROUTE] reason=finalize-fallback-write source=pending-turn sessionId=${sessionId} trigger=${trigger} timelineCount=${timelineIds.length} messageCount=${pendingMessages.length} userMessageId=${userMessageId || 'null'} assistantMessageId=${assistantMessageId || 'null'} bytes=${bytes}`
            );
        } catch (fallbackError) {
            this.uiDebugChannel.appendLine(
                `[EXT][SNAPSHOT_ROUTE] reason=finalize-fallback-error source=pending-turn sessionId=${sessionId} trigger=${trigger} err=${String(fallbackError)}`
            );
        }
    }

    private markSubagentsTerminalForParent(parentSessionId: string | undefined, kind: 'done' | 'failed' | 'cancelled', reason: string): void {
        if (!parentSessionId) {
            this.uiDebugChannel.appendLine(`[EXT][SUBAGENT_ROUTE_DROP] phase=terminal scope=parent-scoped parentSessionId=null agentSessionId=null displayTarget=parent reason=${reason}:missing-parent terminalState=${kind}`);
            return;
        }
        const now = Date.now();
        const terminalSessionIds: string[] = [];
        for (const [sessionId, entry] of this.subagentProgressBySession.entries()) {
            if (entry.parentSessionId !== parentSessionId) continue;
            const st = entry.state || (entry.isDone ? 'done' : 'running');
            if (st === 'running' || st === 'finalizing' || st === 'queued') {
                this.transitionSubagentState(sessionId, entry, kind, reason);
                entry.finishedAt = now;
                entry.dismissAt = now + this.subagentDoneRetentionMs;
                terminalSessionIds.push(sessionId);
            }
        }
        if (terminalSessionIds.length > 0) {
            this.scheduleSubagentRetentionSweep();
        }
        this.uiDebugChannel.appendLine(`[EXT][SUBAGENT_ROUTE] phase=terminal scope=parent-scoped parentSessionId=${parentSessionId} agentSessionId=${terminalSessionIds.join(',') || 'none'} displayTarget=parent reason=${reason} terminalState=${kind} affected=${terminalSessionIds.length}`);
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
        const mime = this.attachmentStorage.getMimeFromName(name);
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

    private isResolvableMessageId(messageId: string | undefined): messageId is string {
        return typeof messageId === 'string'
            && messageId.startsWith('msg_')
            && !messageId.startsWith('local-')
            && !messageId.startsWith('tmp:');
    }

    private buildFinalizeTurnIdentity(sessionId: string, partial: Partial<FinalizeTurnIdentity> = {}): FinalizeTurnIdentity {
        const rootUserMessageId = partial.rootUserMessageId
            || (typeof (this.client as any).getAppendRootUserMsgId === 'function' ? this.client.getAppendRootUserMsgId(sessionId) : undefined)
            || (typeof (this.client as any).getCurrentTurnUserMsgId === 'function' ? this.client.getCurrentTurnUserMsgId(sessionId) : undefined);
        const latestAppendUserMessageId = partial.latestAppendUserMessageId
            || (typeof (this.client as any).getLatestAppendUserMsgId === 'function' ? this.client.getLatestAppendUserMsgId(sessionId) : undefined);
        const userMessageId = partial.userMessageId
            || latestAppendUserMessageId
            || rootUserMessageId
            || (typeof (this.client as any).getCurrentTurnUserMsgId === 'function' ? this.client.getCurrentTurnUserMsgId(sessionId) : undefined);
        const assistantMessageId = partial.assistantMessageId
            || (typeof (this.client as any).getTurnAssistantMsgId === 'function' ? this.client.getTurnAssistantMsgId(sessionId) : undefined);
        return {
            ...partial,
            sessionId,
            userMessageId,
            assistantMessageId,
            rootUserMessageId: rootUserMessageId || userMessageId,
            latestAppendUserMessageId
        };
    }

    private async resolveAuthoritativeFilesForCommit(identityInput: FinalizeTurnIdentity | string): Promise<AuthoritativeDiffFileSetResult> {
        const identity = typeof identityInput === 'string'
            ? this.buildFinalizeTurnIdentity(identityInput)
            : identityInput;
        const sessionId = identity.sessionId;
        const rootUserMessageId = identity.rootUserMessageId || identity.userMessageId;
        const latestAppendUserMessageId = identity.latestAppendUserMessageId;
        const hasAuthoritativeHelper = typeof (this.client as any).getAuthoritativeDiffFileSet === 'function';
        if (!hasAuthoritativeHelper || !sessionId) {
            this.uiDebugChannel?.appendLine(`[EXT][AUTH_DIFF] commit.resolve.skip | sessionId=${sessionId || 'null'} | reason=helper-unavailable`);
            return { files: [], queriedIds: [], missingIds: [], source: 'message-summary-diffs' };
        }
        if (!this.isResolvableMessageId(rootUserMessageId) && !this.isResolvableMessageId(latestAppendUserMessageId)) {
            this.uiDebugChannel?.appendLine(`[EXT][AUTH_DIFF] commit.resolve.skip | sessionId=${sessionId} | reason=missing-resolvable-message-id | userMessageId=${identity.userMessageId || 'null'} | rootUserMessageId=${rootUserMessageId || 'null'} | latestAppendUserMessageId=${latestAppendUserMessageId || 'null'}`);
            return { files: [], queriedIds: [], missingIds: [], source: 'message-summary-diffs' };
        }
        const result = await this.client.getAuthoritativeDiffFileSet({
            sessionId,
            rootUserMessageId: this.isResolvableMessageId(rootUserMessageId) ? rootUserMessageId : undefined,
            latestAppendUserMessageId: this.isResolvableMessageId(latestAppendUserMessageId) ? latestAppendUserMessageId : undefined
        });
        this.uiDebugChannel?.appendLine(`[EXT][AUTH_DIFF] commit.resolve | sessionId=${sessionId} | queriedIds=${result.queriedIds.join(',') || 'none'} | authCount=${result.files.length} | source=${result.source}`);
        return result;
    }

    private async commitPendingTurnChangesFromAuthoritativeFiles(identityInput: FinalizeTurnIdentity | string): Promise<CommitPendingTurnChangesResult> {
        const identity = typeof identityInput === 'string'
            ? this.buildFinalizeTurnIdentity(identityInput)
            : identityInput;
        const authResult = await this.resolveAuthoritativeFilesForCommit(identity);
        return this.client.commitPendingTurnChanges(identity.sessionId, { authoritativeFiles: authResult.files });
    }

    private async emitDiffFileList(identityInput: FinalizeTurnIdentity | string, webview: vscode.Webview): Promise<void> {
        const identity = typeof identityInput === 'string'
            ? this.buildFinalizeTurnIdentity(identityInput)
            : identityInput;
        await this.changeListEmitter.emit(identity, webview);
    }

    /**
     * Wrapper for emitDiffFileList that retries until anchor message ID is ready.
     * Prevents race condition where anchor is still tmp: during finalization.
     */
    private async emitDiffFileListWithRetry(identity: FinalizeTurnIdentity, webview: vscode.Webview): Promise<void> {
        const maxAttempts = 5;
        const delayMs = 50;
        const sessionId = identity.sessionId;
        
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const anchorMessageId = identity.assistantMessageId || this.client.getTurnAssistantMsgId(sessionId);
            const isReady = anchorMessageId && 
                           !anchorMessageId.startsWith('tmp:') && 
                           !anchorMessageId.startsWith('local-') &&
                           anchorMessageId.startsWith('msg_');
            
            if (isReady) {
                this.uiDebugChannel?.appendLine(`[EXT][DIFF_LIST] anchor ready | attempt=${attempt}/${maxAttempts} anchor=${anchorMessageId}`);
                await this.emitDiffFileList({ ...identity, assistantMessageId: anchorMessageId }, webview);
                return;
            }
            
            this.uiDebugChannel?.appendLine(`[EXT][TURN_BIND] phase=defer_diff_list | attempt=${attempt}/${maxAttempts} | sessionId=${sessionId} | reqId=${identity.reqId || 'null'} | anchor=${anchorMessageId || 'null'} | reason=${!anchorMessageId ? 'missing' : 'tmp/local/non-msg'}`);
            
            if (attempt < maxAttempts) {
                await this.waitMs(delayMs);
            }
        }
        
        const finalAnchor = identity.assistantMessageId || this.client.getTurnAssistantMsgId(sessionId);
        this.uiDebugChannel?.appendLine(`[EXT][TURN_BIND] phase=defer_diff_list | sessionId=${sessionId} | reqId=${identity.reqId || 'null'} | reason=max-retries-final-bind-missing | anchor=${finalAnchor || 'null'}`);
    }

    private async openGitDiffForFile(
        sessionId: string,
        filePath: string,
        webview: vscode.Webview,
        commitHead?: string,
        commitBase?: string
    ): Promise<void> {
        await this.diffFileViewer.open({
            sessionId,
            filePath,
            commitHead,
            commitBase,
            noBaseline: () => this.postAddResponse(webview, 'No baseline available to open diff.'),
        });
    }

    constructor(
        private readonly _context: vscode.ExtensionContext,
        private readonly _extensionUri: vscode.Uri,
        private readonly diffProvider: OpenCodeDiffProvider
    ) {
        this.client = new OpenCodeClient();
        this.diffFileViewer = new DiffFileViewer({
            resolveRepo: (sessionId) => this.resolveInternalRepo(sessionId),
            getHead: (repo) => this.getInternalHeadCommit(repo),
            getParent: (repo, commit) => this.getInternalParentCommit(repo, commit),
            getWorkspaceRoot: () => this.getWorkspaceRootPath(),
            updateDiff: (relativePath, beforeText, afterText, diffText) => this.diffProvider.updateFromSnapshot(
                relativePath,
                beforeText,
                afterText,
                diffText,
            ),
        });
        this.changeListEmitter = new ChangeListEmitter({
            isEnabled: () => this.gitUndoEnabled,
            getClient: () => this.client,
            resolveRepo: (sessionId) => this.resolveInternalRepo(sessionId),
            getHead: (repo) => this.getInternalHeadCommit(repo),
            getParent: (repo, commit) => this.getInternalParentCommit(repo, commit),
            getDiffFileSet: (repo, baseCommit, headCommit) => this.getInternalDiffFileSet(repo, baseCommit, headCommit),
            getDiffStats: (repo, baseCommit, headCommit) => this.getInternalDiffStats(repo, baseCommit, headCommit),
            isResolvableMessageId: (messageId): messageId is string => this.isResolvableMessageId(messageId),
            readRecords: (sessionId) => this.readChangeLists(sessionId),
            readSessionMap: (sessionId) => this.readPersistedSessionMap(sessionId),
            resolveVisibleOwner: (sessionId, messageId) => this.resolveCurrentVisibleOwnerMessageId(sessionId, messageId),
            upsertRecord: (sessionId, record, options) => this.upsertChangeList(sessionId, record, options),
            log: (line) => this.uiDebugChannel?.appendLine(line),
            now: () => Date.now(),
            wait: (delayMs) => this.waitMs(delayMs),
        });
        this.client.setStorage(this._context.globalState);
        this.uiDebugChannel = vscode.window.createOutputChannel('OpenCode UI Debug');
        this.client.setUiDebugChannel(this.uiDebugChannel);
        this.attachmentStorage = new AttachmentStorageService({
            globalStoragePath: this._context.globalStoragePath,
            getWorkspaceRootPath: () => this.getWorkspaceRootPath(),
            log: (message) => this.uiDebugChannel.appendLine(message)
        });
        this.smartSearchSessions = new SmartSearchSessionRegistry({
            storage: this._context.globalState,
            client: this.client,
            getCorpusDir: () => pathModule.join(this.getOpencodeDataDir(), 'smartSearch'),
            log: (message) => this.uiDebugChannel.appendLine(message)
        });
        this.smartSearch = new SmartSearchService({
            client: this.client,
            sessions: this.smartSearchSessions,
            getCachedModels: () => this.lastKnownModels,
            setCachedModels: (models) => { this.lastKnownModels = models; },
            getSelectedModel: () => this.selectedModel,
            log: (message) => this.uiDebugChannel.appendLine(message)
        });
        this.userOwnedSessionsLoaded = this.loadUserOwnedSessions();
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
        this.attachmentStorage.scheduleCleanup('activate');
        this.attachmentStorage.startCleanupTimer();
        void this.smartSearchSessions.cleanupOrphans();
        void this.smartSearchSessions.cleanupStaleCorpora();

        try {
            const raw = this._context.globalState.get<string>(this.UNDO_SEGMENTS_KEY);
            this.undoSegmentsBySession = hydrateUndoSegments(raw);
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
        const panelId = `panel-${++this.webviewLivenessPanelSeq}`;
        this.resetWebviewLiveness('webview-recreate');
        this.uiDebugChannel.appendLine(`EXT: webviewLiveness.panel | phase=resolve | panelId=${panelId}`);
        this.uiDebugChannel.appendLine(`EXT: webviewReload.external-unobservable | reason=vscode-developer-reload-webviews-command-not-interceptable | observablePoints=resolve,handshake,dispose | panelId=${panelId} | previousWebviewInstanceId=${this._webviewInstanceId || 'null'} | reload=false | recreate=false | sessionMutation=false`);
        this.uiDebugChannel.appendLine(`EXT: webviewReload.expected-new-webview | phase=resolve | panelId=${panelId} | previousWebviewInstanceId=${this._webviewInstanceId || 'null'} | reload=false | recreate=false | sessionMutation=false`);

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
                    if (await this.handleWebviewCommandReloadReady(data, webviewView, panelId)) {
                        break;
                    }
                    const pending = this.webviewHardRescuePending;
                    const newWebviewInstanceId = typeof data?.webviewInstanceId === 'string' ? data.webviewInstanceId.trim() : '';
                    let hardRescueGuard: (() => boolean) | undefined;
                    if (pending) {
                        const currentActiveTurn = this.getWebviewLivenessActiveTurnFlags(pending.sessionId);
                        let rejectionReason = '';
                        if (data.hardRescueGenerationToken !== pending.generationToken) rejectionReason = 'generation-token-mismatch';
                        else if (!newWebviewInstanceId) rejectionReason = 'missing-webview-instance-id';
                        else if (newWebviewInstanceId === pending.oldWebviewInstanceId) rejectionReason = 'same-webview-instance-id';
                        else if (Date.now() > pending.timeoutAt) rejectionReason = 'late-handshake';
                        else if (this._view?.webview !== pending.webview || webviewView.webview !== pending.webview) rejectionReason = 'webview-object-mismatch';
                        else if (panelId !== pending.panelId) rejectionReason = 'panel-mismatch';
                        else if (this.currentSessionId !== pending.sessionId) rejectionReason = 'session-mismatch';
                        else if (this.sessionSelectionEpoch !== pending.selectionEpoch) rejectionReason = 'selection-epoch-changed';
                        else if ((currentActiveTurn.turnId || '') !== (pending.activeTurn.turnId || '')) rejectionReason = 'active-turn-changed';
                        else if (this.webviewHandshakeLifecycle !== pending.handshakeLifecycle) rejectionReason = 'lifecycle-superseded';
                        if (rejectionReason) {
                            this.uiDebugChannel.appendLine(`EXT: webviewHardRescue.handshake.rejected | reason=${rejectionReason} | generationToken=${data?.hardRescueGenerationToken || 'null'} | expectedGenerationToken=${pending.generationToken} | sessionId=${pending.sessionId} | panelId=${pending.panelId} | oldWebviewInstanceId=${pending.oldWebviewInstanceId || 'null'} | newWebviewInstanceId=${newWebviewInstanceId || 'null'} | selectionEpoch=${this.sessionSelectionEpoch}`);
                            break;
                        }
                        // No await may occur between the final validation above and identity adoption.
                        this._webviewInstanceId = newWebviewInstanceId;
                        pending.newWebviewInstanceId = newWebviewInstanceId;
                        pending.handshakeAccepted = true;
                        this._view = webviewView;
                        hardRescueGuard = () => this.isWebviewHardRescueCurrent(pending);
                        this.uiDebugChannel.appendLine(`EXT: webviewHardRescue.handshake.accepted | generationToken=${pending.generationToken} | sessionId=${pending.sessionId} | panelId=${pending.panelId} | rescueAttemptId=${pending.rescueAttemptId} | oldWebviewInstanceId=${pending.oldWebviewInstanceId || 'null'} | newWebviewInstanceId=${newWebviewInstanceId} | selectionEpoch=${pending.selectionEpoch} | elapsedMs=${Date.now() - pending.startedAt} | ownershipChecks=passed`);
                    } else {
                        if (data?.hardRescueGenerationToken) {
                            this.uiDebugChannel.appendLine(`EXT: webviewHardRescue.handshake.rejected | reason=unexpected-generation-token | generationToken=${data.hardRescueGenerationToken} | panelId=${panelId} | newWebviewInstanceId=${newWebviewInstanceId || 'null'}`);
                            break;
                        }
                        if (!newWebviewInstanceId) {
                            this.uiDebugChannel.appendLine(`EXT: webviewReload.handshake.rejected | reason=missing-webview-instance-id | panelId=${panelId}`);
                            break;
                        }
                        this._view = webviewView;
                        this._webviewInstanceId = newWebviewInstanceId;
                        ++this.webviewHandshakeLifecycle;
                    }
                    this.webviewLivenessCurrent = undefined;
                    this.uiDebugChannel.appendLine(`[EXT][HANDSHAKE_1_RX] webviewReady | wvId=${this._webviewInstanceId}`);
                    this.uiDebugChannel.appendLine(`EXT: webviewReload.handshake.observed | phase=webviewReady | panelId=${panelId} | webviewInstanceId=${this._webviewInstanceId || 'null'} | previousWebviewInstanceId=${data?.previousWebviewInstanceId || 'unknown'} | reload=false | recreate=false | sessionMutation=false`);
                    
                const liveWebview = this._view?.webview;
                    if (liveWebview) {
                        this.uiDebugChannel.appendLine(`[EXT][HANDSHAKE_2_START] calling sendInit() | initPosted=${this.initPosted}`);
                        let sendInitError: Error | undefined;
                        try {
                            if (pending) {
                                const hydrationMode = pending.activeTurn.fresh ? 'fresh-active-turn-metadata-live-resume' : 'idle-normal-hydration';
                                this.uiDebugChannel.appendLine(`EXT: webviewHardRescue.hydration.mode | generationToken=${pending.generationToken} | sessionId=${pending.sessionId} | panelId=${pending.panelId} | activeTurnId=${pending.activeTurn.turnId || 'none'} | activeTurnFresh=${String(pending.activeTurn.fresh)} | mode=${hydrationMode} | postedSessionData=${String(!pending.activeTurn.fresh)}`);
                            }
                            if (pending && hardRescueGuard) {
                                await this.sendInit(liveWebview, {
                                    isStillCurrent: hardRescueGuard,
                                    hardRescue: { sessionId: pending.sessionId, activeTurn: pending.activeTurn }
                                });
                            } else {
                                await this.sendInit(liveWebview);
                            }
                            this.uiDebugChannel.appendLine(`[EXT][HANDSHAKE_3_DONE] sendInit() complete, sending ack`);
                        } catch (err) {
                            sendInitError = err instanceof Error ? err : new Error(String(err));
                            this.uiDebugChannel.appendLine(`[EXT][SENDINIT_ERROR] sendInit threw: ${sendInitError.message}`);
                        }
                        
                        if (pending && (!hardRescueGuard || !hardRescueGuard())) {
                            this.uiDebugChannel.appendLine(`EXT: webviewHardRescue.failed | reason=stale-sendInit-completion | panelId=${panelId} | newWebviewInstanceId=${newWebviewInstanceId || 'null'} | nextAction=Reload Window | automaticRetry=false`);
                            break;
                        }
                        if (pending) {
                            const readyAckPosted = sendInitError
                                ? await liveWebview.postMessage({
                                    type: 'webviewReadyAck',
                                    timestamp: Date.now(),
                                    webviewInstanceId: this._webviewInstanceId,
                                    error: true,
                                    message: sendInitError.message,
                                    hardRescueGenerationToken: pending.generationToken
                                })
                                : await liveWebview.postMessage({ type: 'webviewReadyAck', timestamp: Date.now(), webviewInstanceId: this._webviewInstanceId, hardRescueGenerationToken: pending.generationToken });
                            this.uiDebugChannel.appendLine(`[EXT][HANDSHAKE_4_ACK] ack sent`);
                            if (sendInitError || !readyAckPosted || !hardRescueGuard || !hardRescueGuard()) {
                                this.finishWebviewHardRescueFailure(pending, 'failed', sendInitError ? `sendInit:${sendInitError.message}` : 'webviewReadyAck-post-failed');
                                break;
                            }
                            if (pending.timeout) clearTimeout(pending.timeout);
                            pending.timeout = undefined;
                            this.webviewHardRescuePending = undefined;
                            this.uiDebugChannel.appendLine(`EXT: webviewHardRescue.complete | generationToken=${pending.generationToken} | sessionId=${pending.sessionId} | panelId=${pending.panelId} | rescueAttemptId=${pending.rescueAttemptId} | oldWebviewInstanceId=${pending.oldWebviewInstanceId || 'null'} | newWebviewInstanceId=${pending.newWebviewInstanceId || 'null'} | elapsedMs=${Date.now() - pending.startedAt} | initSucceeded=true | webviewReadyAckPosted=true`);
                        } else if (sendInitError) {
                            liveWebview.postMessage({
                                type: 'webviewReadyAck',
                                timestamp: Date.now(),
                                webviewInstanceId: this._webviewInstanceId,
                                error: true,
                                message: sendInitError.message
                            });
                            this.uiDebugChannel.appendLine(`[EXT][HANDSHAKE_4_ACK] ack sent`);
                        } else {
                            liveWebview.postMessage({ type: 'webviewReadyAck', timestamp: Date.now(), webviewInstanceId: this._webviewInstanceId });
                            this.uiDebugChannel.appendLine(`[EXT][HANDSHAKE_4_ACK] ack sent`);
                        }
                        this.startWebviewLivenessProbes();
                        void this.triggerWebviewLivenessProbe('webviewReadyAck');
                    }
                    break;
                }
                case "webviewLivenessAck": {
                    this.handleWebviewLivenessAck(data);
                    break;
                }
                case "webviewAutoRescueAck": {
                    this.handleWebviewAutoRescueAck(data);
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

                    const payloadSessionId = typeof data.sessionId === 'string' && data.sessionId.trim()
                        ? data.sessionId.trim()
                        : undefined;
                    const currentSessionIdAtSend = this.currentSessionId;
                    const routeSource = payloadSessionId ? 'payload' : 'current';

                    if (!payloadSessionId && !this.currentSessionId) {
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

                    const targetSessionId = payloadSessionId || this.currentSessionId;
                    if (!targetSessionId) {
                        this.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE_DROP] event=sendMessage reason=missing-target-session reqId=pending payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} routeSource=${routeSource}`);
                        vscode.window.showErrorMessage('OpenCode Error: No active session available for send.');
                        return;
                    }

                    if (payloadSessionId) {
                        this.currentSessionId = payloadSessionId;
                        this.trackUserOwnedSession(payloadSessionId);
                        this.client.setSessionId(payloadSessionId);
                    }

                    if (this.sendInFlightBySession.has(targetSessionId)) {
                        this.uiDebugChannel.appendLine(`EXT: send.blocked | sessionId=${targetSessionId} | payloadSessionId=${payloadSessionId || 'none'} | currentSessionId=${currentSessionIdAtSend || 'none'} | routeSource=${routeSource} | reason=turn-in-flight`);
                        const liveWebview = this._view?.webview || activeWebview;
                        liveWebview.postMessage({ type: 'turnInFlight', sessionId: targetSessionId, inFlight: true });
                        return;
                    }

                    // this.uiDebugChannel.appendLine(`[EXT][SEND_START] sessionId=${this.currentSessionId} attachments=${data.attachments?.length || 0}`);

                    const reqId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                    const targetModel = this.selectedModel;
                    const targetVariant = this.selectedVariant;
                    const targetMode = this.selectedMode;
                    let activeSendSessionId: string | undefined = targetSessionId;
                    let turnClientMessageId: string | undefined;
                    let turnTmpAssistantKey: string | undefined;
                    try {
                        const attachments = Array.isArray(data.attachments) ? data.attachments as AttachmentPayload[] : [];
                        const attachKeys = attachments.length ? Object.keys(attachments[0] || {}).join(',') : '';
                        this.uiDebugChannel.appendLine(`EXT: send.enter | reqId=${reqId} | sessionId=${targetSessionId} | payloadSessionId=${payloadSessionId || 'none'} | currentSessionId=${currentSessionIdAtSend || 'none'} | routeSource=${routeSource} | hasAttachments=${String(Boolean(attachments.length))} | attachmentsCount=${attachments.length} | attachKeys=${attachKeys}`);
                        this.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE] event=sendMessage phase=start reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource}`);
                        const userText = (data.value as string) || '';
                        const referencedFiles = await this.normalizeReferencedWorkspaceFiles(data.files);
                        let modelText = userText;
                        const initialDraft = {
                            text: userText,
                            attachments: [],
                            model: targetModel,
                            variant: targetVariant,
                            mode: targetMode
                        };
                        const clientMessageId = data.clientMessageId || `local-${Date.now()}`;
                        const tmpAssistantKey = typeof data.tmpKey === 'string' && data.tmpKey.startsWith('tmp:') ? data.tmpKey : undefined;
                        turnClientMessageId = clientMessageId;
                        turnTmpAssistantKey = tmpAssistantKey;
                        this.uiDebugChannel.appendLine(`[EXT][TURN_BIND] phase=capture reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource} clientMessageId=${clientMessageId} tmpAssistantKey=${tmpAssistantKey || 'none'}`);
                        this.pendingClientMessageId = clientMessageId;
                        this.rememberDraft(clientMessageId, initialDraft);
                        this.rawUserTextByLocalKey.set(clientMessageId, userText);
                        const opId = typeof data.opId === 'string' ? data.opId : undefined;
                        if (targetSessionId) {
                            activeSendSessionId = targetSessionId;
                            this.sendInFlightBySession.add(targetSessionId);
                            this.markWebviewActiveTurnUpdated(targetSessionId, 'send:start');
                            this.pendingLocalKeyBySession.set(targetSessionId, clientMessageId);
                            this.pendingAssistantTmpKeyBySession.delete(targetSessionId);
                            const liveWebview = this._view?.webview || activeWebview;
                            liveWebview.postMessage({ type: 'turnInFlight', sessionId: targetSessionId, inFlight: true });
                            this.client.startTurnWithOp(targetSessionId, clientMessageId, opId);
                            this.assistantTextBufferBySession.set(targetSessionId, '');
                        }
                        if (tmpAssistantKey) {
                            this.pendingAssistantTmpKeyBySession.set(targetSessionId, tmpAssistantKey);
                            this.pendingAssistantTmpKeyByLocalKey.set(clientMessageId, tmpAssistantKey);
                            this.client.setPendingAssistantTmpKey(targetSessionId, tmpAssistantKey);
                        }

                        const messageIndex = this.client.registerMessage(clientMessageId, targetSessionId);
                        const liveWebview = this._view?.webview || activeWebview;
                        this.clientMessageIdMap.set(clientMessageId, clientMessageId);

                        const attachmentNames = attachments.map((item) => {
                            if (item?.filename) return this.attachmentStorage.sanitizeFilename(item.filename);
                            if (item?.tempPath) return pathModule.basename(item.tempPath);
                            return 'attachment';
                        });
                        const fileNames = attachmentNames.filter((name: string) => !this.attachmentStorage.isImageFileName(name));
                        const attachmentLines = fileNames.map((name: string) => `📄 ${name}`);
                        const displayText = attachmentLines.length
                            ? (userText
                                ? `${userText}

${attachmentLines.join('\n')}`
                                : attachmentLines.join('\n'))
                            : userText;
                        this.pendingSnapshotUserTextBySession.set(targetSessionId, displayText);
                        const pendingUserMessage: SessionMessage = {
                            role: 'user',
                            text: displayText,
                            id: clientMessageId,
                            messageIndex
                        };

                        const assistantMessageId = this.client.createInternalMessageId('assistant', targetSessionId);
                        const assistantMessageIndex = this.client.registerMessage(assistantMessageId, targetSessionId);
                        this.pendingAssistantMessageIdBySession.set(targetSessionId, assistantMessageId);
                        this.markWebviewActiveTurnUpdated(targetSessionId, 'send:assistant-message-bound');
                        liveWebview.postMessage({
                            type: 'messageAppend',
                            message: pendingUserMessage,
                            sessionId: targetSessionId
                        });
                        liveWebview.postMessage({
                            type: 'assistantMessageMeta',
                            messageId: assistantMessageId,
                            messageIndex: assistantMessageIndex,
                            sessionId: targetSessionId
                        });

                        const savedAttachments: SavedAttachment[] = [];
                        if (!attachments.length) {
                            this.uiDebugChannel.appendLine(`EXT: attach.precheck.skip | reqId=${reqId} | reason=no_attachments`);
                        } else if (targetSessionId) {
                            for (const attachment of attachments) {
                                try {
                                    const saved = await this.attachmentStorage.saveAttachment(targetSessionId, attachment, reqId);
                                    if (saved) {
                                        savedAttachments.push(saved);
                                    }
                                } catch (error) {
                                    this.uiDebugChannel.appendLine(`EXT: attach.save.fail | reqId=${reqId} | filename=${attachment?.filename || 'unknown'} | mime=${attachment?.mime || 'unknown'} | err=${String(error)}`);
                                }
                            }
                        if (savedAttachments.length) {
                            const manifest = this.attachmentStorage.buildAttachmentManifest(savedAttachments);
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
                                model: targetModel,
                                variant: targetVariant,
                                sessionId: targetSessionId,
                                mode: targetMode,
                                files: referencedFiles
                            }
                        );

                        await this.client.waitForSessionIdleGate(targetSessionId, {
                            sseWaitMs: 2000,
                            pollEveryMs: 2000,
                            maxPolls: 3
                        });

                        OpenCodeClient.outputChannel.appendLine(`[BRIDGE] Chat done`);
                        this.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE] event=sendMessage phase=stream_done reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource}`);
                        let doneAssistantMsgId = this.client.getTurnAssistantMsgId(targetSessionId) || undefined;
                        if (!doneAssistantMsgId) {
                            this.uiDebugChannel.appendLine(`EXT: chatdone.guard.wait-final | sessionId=${targetSessionId} | reason=missing-assistant-msg-id`);
                            doneAssistantMsgId = await this.client.waitForTurnAssistantMsgId(targetSessionId, 500);
                            this.uiDebugChannel.appendLine(`EXT: chatdone.guard.resolved | sessionId=${targetSessionId} | assistantMsgId=${doneAssistantMsgId}`);
                        }
                        this.uiDebugChannel.appendLine(`[EXT][TURN_BIND] phase=stream_done reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource} clientMessageId=${clientMessageId} assistantMsgId=${doneAssistantMsgId || 'none'} tmpAssistantKey=${tmpAssistantKey || 'none'}`);
                        liveWebview.postMessage({
                            type: 'chatDone',
                            sessionId: targetSessionId,
                            assistantMsgId: doneAssistantMsgId,
                            lastAssistantMsgId: doneAssistantMsgId
                        });
                        this.emitTurnFinalizePhase(liveWebview, targetSessionId, 'stream_done');
                        this.postMessageIndexMap(liveWebview);
                        this.uiDebugChannel.appendLine(`EXT: finalize.order | sessionId=${targetSessionId} | phase=commit-start`);
                        this.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE] event=sendMessage phase=commit_start reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource}`);
                        const preCommitIdentity = this.buildFinalizeTurnIdentity(targetSessionId, {
                            reqId,
                            clientMessageId,
                            assistantMessageId: doneAssistantMsgId
                        });
                        const commitResult = await this.commitPendingTurnChangesFromAuthoritativeFiles(preCommitIdentity);
                        this.uiDebugChannel.appendLine(`EXT: finalize.order | sessionId=${targetSessionId} | phase=commit-done`);
                        this.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE] event=sendMessage phase=commit_done reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource}`);
                        this.emitTurnFinalizePhase(liveWebview, targetSessionId, 'commit_done');
                        this.uiDebugChannel.appendLine(`EXT: finalize.order | sessionId=${targetSessionId} | phase=upgrade-start`);
                        this.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE] event=sendMessage phase=upgrade_start reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource}`);
                        await this.resolvePendingUserUpgrade(targetSessionId, liveWebview);
                        this.uiDebugChannel.appendLine(`EXT: finalize.order | sessionId=${targetSessionId} | phase=upgrade-done`);
                        this.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE] event=sendMessage phase=upgrade_done reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource}`);
                        this.emitTurnFinalizePhase(liveWebview, targetSessionId, 'upgrade_done');
                        this.postMessageIndexMap(liveWebview);
                        this.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE] event=sendMessage phase=diff_list_start reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource}`);
                        const finalizeIdentity = this.buildFinalizeTurnIdentity(targetSessionId, {
                            reqId,
                            clientMessageId,
                            assistantMessageId: doneAssistantMsgId,
                            commitResult
                        });
                        await this.emitDiffFileListWithRetry(finalizeIdentity, liveWebview);
                        this.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE] event=sendMessage phase=diff_list_done reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource}`);
                        await this.writeFinalizeSnapshotFromCanonicalSession(finalizeIdentity);
                        this.client.finishTurn(targetSessionId);
                        this.postFinalWatchDiffFocusedBySession.delete(targetSessionId);
                        // Do not force "done" from main finalize; only subagent final-accepted can set done.
                        // Any still-active subagents at this point are treated as cancelled.
                        this.markSubagentsTerminalForParent(targetSessionId, 'cancelled', 'main-finalize-cancel-active');
                        this.emitSubagentStatus();
                        this.clearSubagentSessionsForParent(targetSessionId, 'main-finalize-cancel-active');
                        this.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE] event=sendMessage phase=finalize_done reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource}`);
                        this.uiDebugChannel.appendLine(`[EXT][TURN_BIND] phase=finalize_done reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource} clientMessageId=${clientMessageId} assistantMsgId=${doneAssistantMsgId || 'none'} tmpAssistantKey=${tmpAssistantKey || 'none'}`);
                        this.emitTurnFinalizePhase(liveWebview, targetSessionId, 'finalize_done');
                        await this.postModelQuota(liveWebview, 'chat-done');
                        if (this.pendingClientMessageId === clientMessageId) {
                            this.clearDraft(clientMessageId);
                            await this.handleAbortedMessage(clientMessageId, liveWebview);
                            this.pendingClientMessageId = undefined;
                        }
                        if (targetMode === 'build') {
                            const segment = this.client.getRevertedSegment();
                            if (segment) {
                                segment.discarded = true;
                                segment.isActive = true;
                                segment.collapsed = true;
                                this.client.setRevertedSegment(segment);
                                await this.persistRevertedSegment(targetSessionId, segment, segment.conflicts || [], true);
                            }
                        }
                    } catch (error) {
                        const sessionId = activeSendSessionId;
                        this.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE] event=sendMessage phase=error reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${sessionId || 'none'} routeSource=${routeSource}`);
                        this.uiDebugChannel.appendLine(`[EXT][TURN_BIND] phase=error reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${sessionId || 'none'} routeSource=${routeSource} clientMessageId=${turnClientMessageId || 'none'} tmpAssistantKey=${turnTmpAssistantKey || 'none'}`);
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
                            await this.commitPendingTurnChangesFromAuthoritativeFiles(this.buildFinalizeTurnIdentity(sessionId, {
                                reqId,
                                assistantMessageId: doneAssistantMsgId
                            }));
                            this.emitTurnFinalizePhase(activeWebview, sessionId, 'commit_done');
                        }
                        await this.resolvePendingUserUpgrade(sessionId, activeWebview);
                        this.emitTurnFinalizePhase(activeWebview, sessionId, 'upgrade_done');
                        const pendingLocalKey = sessionId ? this.pendingLocalKeyBySession.get(sessionId) : undefined;
                        if (sessionId && pendingLocalKey && this.pendingClientMessageId === pendingLocalKey) {
                            this.clearDraft(pendingLocalKey);
                            await this.handleAbortedMessage(pendingLocalKey, activeWebview);
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
                        this.markSubagentsTerminalForParent(sessionId, 'failed', 'main-error-finalize');
                        this.emitSubagentStatus();
                        this.clearSubagentSessionsForParent(sessionId, 'main-error-finalize');
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
                            this.syncTurnInFlightAfterFinalize(activeSendSessionId, liveWebview, 'sendMessage.finally');
                            await this.runPendingSendInitGuardCompensation(activeSendSessionId, liveWebview, 'sendMessage.finally');
                        }
                    }
                    break;
                }
                case "appendMessage": {
                    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
                    const value = typeof data.value === 'string' ? data.value.trim() : '';
                    const clientMessageId = typeof data.clientMessageId === 'string' ? data.clientMessageId : undefined;
                    const liveWebview = this._view?.webview || activeWebview;
                    const requestedRootUserMsgId = typeof data.rootUserKey === 'string' ? data.rootUserKey : undefined;
                    this.uiDebugChannel.appendLine(`[EXT][APPEND_ROUTE] rx sessionId=${sessionId || 'null'} rootUserMsgId=${requestedRootUserMsgId || 'null'} clientMessageId=${clientMessageId || 'null'} currentSessionId=${this.currentSessionId || 'null'}`);
                    if (!sessionId || !requestedRootUserMsgId || !clientMessageId || !value) {
                        const reason = !sessionId || !requestedRootUserMsgId || !clientMessageId ? 'missing-route' : 'empty';
                        this.uiDebugChannel.appendLine(`[EXT][APPEND_ROUTE] rejected sessionId=${sessionId || 'null'} rootUserMsgId=${requestedRootUserMsgId || 'null'} clientMessageId=${clientMessageId || 'null'} reason=${reason}`);
                        liveWebview.postMessage({
                            type: 'appendStatus',
                            sessionId,
                            clientMessageId,
                            status: 'failed',
                            rootUserMsgId: requestedRootUserMsgId,
                            reason
                        });
                        break;
                    }
                    const hasTurnInFlight = this.sendInFlightBySession.has(sessionId);
                    const canAppend = this.client.canAppendToCurrentTurn(sessionId, requestedRootUserMsgId);
                    if (!hasTurnInFlight || !canAppend) {
                        const reason = !hasTurnInFlight ? 'turn-not-in-flight' : 'finalized';
                        this.uiDebugChannel.appendLine(`[EXT][APPEND_ROUTE] rejected sessionId=${sessionId} rootUserMsgId=${requestedRootUserMsgId} clientMessageId=${clientMessageId} reason=${reason}`);
                        liveWebview.postMessage({
                            type: 'appendStatus',
                            sessionId,
                            clientMessageId,
                            status: 'rejected',
                            rootUserMsgId: requestedRootUserMsgId,
                            reason
                        });
                        break;
                    }
                    if (this.appendSubmitInFlightBySession.has(sessionId)) {
                        this.uiDebugChannel.appendLine(`[EXT][APPEND_ROUTE] rejected sessionId=${sessionId} rootUserMsgId=${requestedRootUserMsgId} clientMessageId=${clientMessageId} reason=append-in-flight`);
                        liveWebview.postMessage({
                            type: 'appendStatus',
                            sessionId,
                            clientMessageId,
                            status: 'rejected',
                            rootUserMsgId: requestedRootUserMsgId,
                            reason: 'append-in-flight'
                        });
                        break;
                    }
                    const beginAppend = this.client.beginAppendPrompt(sessionId, clientMessageId, value, requestedRootUserMsgId);
                    if (!beginAppend) {
                        this.uiDebugChannel.appendLine(`[EXT][APPEND_ROUTE] rejected sessionId=${sessionId} rootUserMsgId=${requestedRootUserMsgId} clientMessageId=${clientMessageId} reason=begin-rejected`);
                        liveWebview.postMessage({
                            type: 'appendStatus',
                            sessionId,
                            clientMessageId,
                            status: 'rejected',
                            rootUserMsgId: requestedRootUserMsgId,
                            reason: 'begin-rejected'
                        });
                        break;
                    }
                    this.appendSubmitInFlightBySession.add(sessionId);
                    this.uiDebugChannel.appendLine(`[EXT][APPEND_ROUTE] accepted sessionId=${sessionId} rootUserMsgId=${beginAppend.rootUserMsgId} clientMessageId=${clientMessageId}`);
                    try {
                        await this.client.appendPrompt(sessionId, value, {
                            model: this.selectedModel,
                            mode: this.selectedMode,
                            clientMessageId,
                            rootUserMsgId: beginAppend.rootUserMsgId
                        });
                        liveWebview.postMessage({
                            type: 'appendStatus',
                            sessionId,
                            clientMessageId,
                            rootUserMsgId: beginAppend.rootUserMsgId,
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
                case "appendSnapshotMeta": {
                    this.cacheAppendSnapshotMeta(data);
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
                case "smartSessionSearch": {
                    const requestId = typeof data.requestId === 'string' ? data.requestId : '';
                    const query = typeof data.query === 'string' ? data.query : '';
                    const messages: SmartSearchMessage[] = Array.isArray(data.messages)
                        ? data.messages
                            .filter((item: any) => item && typeof item.id === 'string' && typeof item.text === 'string')
                            .map((item: any) => ({
                                id: item.id,
                                role: typeof item.role === 'string' ? item.role : 'unknown',
                                text: item.text
                            }))
                        : [];
                    const liveWebview = this._view?.webview || activeWebview;
                    try {
                        const result = await this.smartSearch.run(
                            typeof data.sessionId === 'string' ? data.sessionId : this.currentSessionId,
                            query,
                            messages
                        );
                        this.uiDebugChannel.appendLine(
                            `EXT: smartSearch.done | requestId=${requestId || 'null'} | model=${result.modelId || 'default'} | results=${result.messageIds.length}`
                        );
                        liveWebview.postMessage({
                            type: 'smartSessionSearchResult',
                            requestId,
                            sessionId: typeof data.sessionId === 'string' ? data.sessionId : this.currentSessionId,
                            messageIds: result.messageIds,
                            modelId: result.modelId
                        });
                    } catch (error) {
                        this.uiDebugChannel.appendLine(`EXT: smartSearch.fail | requestId=${requestId || 'null'} | err=${String(error)}`);
                        liveWebview.postMessage({
                            type: 'smartSessionSearchError',
                            requestId,
                            sessionId: typeof data.sessionId === 'string' ? data.sessionId : this.currentSessionId,
                            error: String(error)
                        });
                    }
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
                    await this._context.globalState.update(
                        this.UNDO_SEGMENTS_KEY,
                        serializeUndoSegments(this.undoSegmentsBySession)
                    );
                    
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
                        await this._context.globalState.update(
                            this.UNDO_SEGMENTS_KEY,
                            serializeUndoSegments(this.undoSegmentsBySession)
                        );
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
                        await this._context.globalState.update(
                            this.UNDO_SEGMENTS_KEY,
                            serializeUndoSegments(this.undoSegmentsBySession)
                        );
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
                    this.resetWebviewLiveness('session-switch');
                    const selectionEpoch = ++this.sessionSelectionEpoch;
                    try {
                        this.resetUiState(targetSessionId);
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
                        let snapshotTimelineIds: string[] = [];

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
                                snapshotTimelineIds = this.getSnapshotTimelineIds(snapPayload, snapshotMessages);
                                const payload = {
                                    type: 'sessionData',
                                    sessionId: targetSessionId,
                                    title: baseTitle,
                                    messages: snapshotMessages,
                                    segments,
                                    meta: {
                                        ...(snapPayload.meta || {}),
                                        source: 'snapshot',
                                        timelineMessageIds: snapshotTimelineIds,
                                        hydrationCoverage: 'deltaContinuityUnknown' as HydrationCoverage
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

                            const snapshotIds = snapshotTimelineIds;
                            const snapshotIdSet = new Set<string>(snapshotIds);
                            const snapshotMaxMessageIndex = this.getMaxMessageIndex(baseMessages);
                            const continuity = this.classifyRecentAppendCandidates(snapshotIdSet, snapshotMaxMessageIndex, formatted.messages);
                            if (snapshotIds.length > 0 && !continuity.proven) {
                                if (!this.snapshotDeltaContinuityRepairEnabled) {
                                    this.uiDebugChannel.appendLine(`[EXT][SESSION_RECENT_SKIP] sessionId=${targetSessionId} reason=repair-disabled-safe-snapshot`);
                                    break;
                                }
                                postSessionData({
                                    type: 'hydrationCoverage',
                                    sessionId: targetSessionId,
                                    hydrationCoverage: 'repairInProgress' as HydrationCoverage
                                }, 'recent');
                                sessionDataSent = false;
                                throw new Error('snapshot-boundary-unproven');
                            }
                            const appendMessages = continuity.suffix;
                            const mergedMessages = snapshotIds.length > 0
                                ? this.buildImmutableSnapshotWithProvenSuffix(baseMessages, appendMessages)
                                : formatted.messages;
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
                                    timelineMessageIds: [...snapshotIds, ...newIds],
                                    hydrationCoverage: (snapshotIds.length > 0
                                        ? 'authoritativeHistoryComplete'
                                        : 'deltaContinuityUnknown') as HydrationCoverage
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
                        const snapshotIds = snapshotTimelineIds;
                        const repairRequiredMessageIds = await this.collectSnapshotRepairRequiredMessageIds(targetSessionId);
                        const fullDelta = this.buildFullExportSnapshotDelta(
                            baseMessages, snapshotIds, formattedRaw.messages, repairRequiredMessageIds
                        );
                        if (fullDelta.repairedSnapshot) {
                            await this.persistStructurallyRepairedSnapshot(
                                targetSessionId, formattedRaw.title, fullDelta.messages, fullDelta.timelineMessageIds, segments
                            );
                        }
                        const formatted = await this.injectChangeLists(targetSessionId, { title: formattedRaw.title, messages: fullDelta.messages });

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
                                    timelineMessageIds: fullDelta.timelineMessageIds,
                                    hydrationCoverage: (fullDelta.proven
                                        ? 'authoritativeHistoryComplete'
                                        : 'deltaContinuityUnknown') as HydrationCoverage
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
                        const saved = await this.attachmentStorage.saveClipboardImage(data.dataUrl, data.mime);
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
                            const mime = this.attachmentStorage.getImageMimeFromName(name) || 'application/octet-stream';
                            let dataUrl: string | undefined;
                            if (this.attachmentStorage.isImageFileName(name)) {
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
                    const payloadSessionId = typeof data.sessionId === 'string' && data.sessionId.trim() ? data.sessionId.trim() : undefined;
                    const operationId = typeof data.operationId === 'string' && data.operationId.trim() ? data.operationId.trim() : undefined;
                    const payloadMessageId = typeof data.messageId === 'string' && data.messageId.trim() ? data.messageId.trim() : undefined;
                    this.uiDebugChannel.appendLine(`[EXT][UNDO_ROUTE] phase=rx payloadSessionId=${payloadSessionId || 'null'} currentSessionId=${this.currentSessionId || 'null'} opId=${operationId || 'null'} messageId=${payloadMessageId || 'null'}`);
                    this.uiDebugChannel.appendLine(`[EXT][UNDO_CASE] messageId=${payloadMessageId || 'NULL'} checkFailed=${!payloadMessageId}`);
                    if (!payloadSessionId || !operationId || !payloadMessageId) {
                        const missing = [
                            !payloadSessionId ? 'sessionId' : undefined,
                            !operationId ? 'operationId' : undefined,
                            !payloadMessageId ? 'messageId' : undefined
                        ].filter(Boolean).join(',');
                        this.uiDebugChannel.appendLine(`[EXT][UNDO_DROP] reason=missing-${missing} payloadSessionId=${payloadSessionId || 'null'} currentSessionId=${this.currentSessionId || 'null'} opId=${operationId || 'null'} messageId=${payloadMessageId || 'null'}`);
                        return;
                    }
                    const ownerSessionId = payloadSessionId;
                    const resolvedMessageId = this.clientMessageIdMap.get(payloadMessageId) || payloadMessageId;
                    this.uiDebugChannel.appendLine(`[EXT][UNDO_ROUTE] phase=owner-captured ownerSessionId=${ownerSessionId} opId=${operationId} anchorMsgId=${resolvedMessageId}`);
                    if (!this.gitUndoEnabled) {
                        this.uiDebugChannel.appendLine(`[EXT][UNDO_TX] type=addResponse sessionId=${ownerSessionId} opId=${operationId}`);
                        this.postAddResponse(activeWebview, 'Undo unavailable: Git not installed or version too old. Please install/upgrade Git and restart VS Code.', { operationId, sessionId: ownerSessionId });
                        return;
                    }
                    if (!this.baselineReady) {
                        this.uiDebugChannel.appendLine(`[EXT][UNDO_TX] type=addResponse sessionId=${ownerSessionId} opId=${operationId}`);
                        this.postAddResponse(activeWebview, 'Undo unavailable: Git baseline not ready.', { operationId, sessionId: ownerSessionId });
                        return;
                    }
                    try {
                        const noticeKey = `system:undo:${resolvedMessageId}`;
                        this.uiDebugChannel.appendLine(`[EXT][UNDO_CALL] sessionId=${ownerSessionId} opId=${operationId}`);
                        this.uiDebugChannel.appendLine(`[EXT][UNDO_RX] anchorMsgId=${payloadMessageId} resolvedMsgId=${resolvedMessageId} sessionId=${ownerSessionId} opId=${operationId}`);
                        this.clearClientRevertedSegmentIfNonRestorable(ownerSessionId);
                        const previousSegment = this.client.getRevertedSegment();
                        const currentActiveNoticeKey = previousSegment?.startMessageId
                            ? `system:undo:${previousSegment.startMessageId}`
                            : undefined;
                        const undoRange = this.client.getUndoRangeForAnchor(resolvedMessageId, ownerSessionId);
                        const extAnchorIndex = typeof undoRange?.startIndex === 'number' ? undoRange.startIndex : -1;
                        const visibleMessageIds = this.sanitizeUndoRangeMessageIds(data?.visibleMessageIds);
                        const forwardMessageIdsFromAnchor = this.sanitizeUndoRangeMessageIds(data?.forwardMessageIdsFromAnchor);
                        const anchorIndex = typeof data?.anchorIndex === 'number' && Number.isFinite(data.anchorIndex)
                            ? data.anchorIndex
                            : undefined;
                        const invalidMessageIds = undoRange && undoRange.endIndex >= undoRange.startIndex
                            ? Array.from(this.getInvalidSegmentMessageIds(ownerSessionId, {
                                currentNoticeKey: currentActiveNoticeKey,
                                rangeStartIndex: undoRange.startIndex,
                                rangeEndIndex: undoRange.endIndex
                            }))
                            : [];
                        const result = await this.client.undoFromMessage(resolvedMessageId, {
                            excludedMessageIds: invalidMessageIds,
                            sessionId: ownerSessionId,
                            visibleMessageIds,
                            forwardMessageIdsFromAnchor
                        });
                        const currentSegment = this.client.getRevertedSegment();
                        this.uiDebugChannel.appendLine(`[EXT][UNDO_RESULT] applied=${result.applied} conflicts=${result.conflicts.length} touched=${result.touchedFiles.length} reason=${result.reason || 'null'} segmentStart=${currentSegment?.startMessageId || 'null'} segmentEnd=${currentSegment?.endMessageId || 'null'}`);
                        this.uiDebugChannel.appendLine(`[EXT][UNDO_DONE] applied=${result.applied} conflicts=${result.conflicts.length} sessionId=${ownerSessionId}`);
                            if (!result.applied && result.conflicts.length) {
                                const conflictId = this.createConflictId('undo', operationId);
                                this.pendingConflict = {
                                    kind: 'undo',
                                    sessionId: ownerSessionId,
                                    operationId,
                                    conflictId,
                                    startMessageId: resolvedMessageId,
                                    visibleMessageIds,
                                    forwardMessageIdsFromAnchor,
                                    anchorIndex,
                                    noticeKey
                                };
                                const liveWebview = this._view?.webview || activeWebview;
                                this.uiDebugChannel.appendLine(`[EXT][UNDO_TX] type=conflictCard sessionId=${ownerSessionId} opId=${operationId} conflictId=${conflictId} kind=undo`);
                                this.uiDebugChannel.appendLine(`EXT: undo.postToWebview | type=conflictCard | sessionId | ${ownerSessionId} | opId | ${operationId} | conflictId | ${conflictId}`);
                                liveWebview.postMessage({
                                    type: 'conflictCard',
                                    kind: 'undo',
                                    source: 'undoToMessage',
                                    conflictId,
                                    startMessageId: resolvedMessageId,
                                    conflicts: result.conflicts,
                                    sessionId: ownerSessionId,
                                    operationId,
                                    noticeKey
                                });
                                // conflictCard provides the user-facing prompt; no extra system message needed.
                                break;
                            }
                        if (!result.applied && !result.conflicts.length) {
                            this.uiDebugChannel.appendLine(`[EXT][UNDO_CLASSIFY] kind=noop-or-missing reason=${result.reason || 'unknown'} anchor=${resolvedMessageId}`);
                            const liveWebview = this._view?.webview || activeWebview;
                            const finalSessionId = ownerSessionId;
                            const canonicalMessageIds = [resolvedMessageId];
                            const uiRange = this.resolveUndoUiVisibleRange(data, resolvedMessageId, canonicalMessageIds, extAnchorIndex);
                            this.uiDebugChannel.appendLine(`[EXT][UNDO_RANGE] source=${uiRange.source} sessionId=${finalSessionId || 'null'} opId=${operationId || 'null'} uiAnchorIndex=${uiRange.uiAnchorIndex} extAnchorIndex=${uiRange.extAnchorIndex} messageIds=${uiRange.messageIds.length}`);
                            if (uiRange.uiAnchorIndex >= 0 && uiRange.extAnchorIndex >= 0 && uiRange.uiAnchorIndex !== uiRange.extAnchorIndex) {
                                this.uiDebugChannel.appendLine(`[EXT][UNDO_RANGE_MISMATCH] sessionId=${finalSessionId || 'null'} opId=${operationId || 'null'} uiAnchorIndex=${uiRange.uiAnchorIndex} extAnchorIndex=${uiRange.extAnchorIndex} messageIds=${uiRange.messageIds.length}`);
                            }
                            this.uiDebugChannel.appendLine(`[EXT][UNDO_TX] type=revertedSegment sessionId=${finalSessionId || 'null'} anchorMsgId=${resolvedMessageId} endMsgId=${resolvedMessageId} applied=false opId=${operationId || 'null'} messageIds=${uiRange.messageIds.length} reason=missing-startCommit-or-noop`);
                            liveWebview.postMessage({
                                type: 'revertedSegment',
                                conflicts: [],
                                messageIds: uiRange.messageIds,
                                segment: {
                                    isActive: false,
                                    startMessageId: resolvedMessageId,
                                    startMessageIndex: -1,
                                    endMessageId: uiRange.messageIds[uiRange.messageIds.length - 1] || resolvedMessageId,
                                    endMessageIndex: -1,
                                    collapsed: true,
                                    messageIds: uiRange.messageIds,
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
                            this.uiDebugChannel.appendLine(`[EXT][UNDO_TX] type=addResponse sessionId=${ownerSessionId} opId=${operationId}`);
                            this.postAddResponse(activeWebview, reasonText, { operationId, sessionId: ownerSessionId });
                            break;
                        }
                        this.uiDebugChannel.appendLine(`[EXT][UNDO_TX] type=messageIndexMap sessionId=${ownerSessionId} opId=${operationId}`);
                        this.postMessageIndexMap(activeWebview, ownerSessionId);
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
                            const finalSessionId = ownerSessionId;
                            const canonicalMessageIds = Array.isArray(segment.messageIds)
                                ? segment.messageIds.filter((id) => typeof id === 'string' && id.startsWith('msg_'))
                                : [];
                            const observedUiRange = this.resolveUndoUiVisibleRange(data, resolvedMessageId, [], extAnchorIndex);
                            const appliedMessageIds = canonicalMessageIds.length
                                ? canonicalMessageIds
                                : observedUiRange.messageIds;
                            const appliedRangeSource = canonicalMessageIds.length
                                ? 'extension-canonical'
                                : observedUiRange.source;
                            const uiSegment = {
                                ...segment,
                                endMessageId: appliedMessageIds[appliedMessageIds.length - 1] || segment.endMessageId,
                                messageIds: appliedMessageIds
                            };
                            this.uiDebugChannel.appendLine(`[EXT][UNDO_RANGE] source=${appliedRangeSource} sessionId=${finalSessionId || 'null'} opId=${operationId || 'null'} uiAnchorIndex=${observedUiRange.uiAnchorIndex} extAnchorIndex=${observedUiRange.extAnchorIndex} messageIds=${appliedMessageIds.length} uiMessageIds=${observedUiRange.messageIds.length}`);
                            if (observedUiRange.uiAnchorIndex >= 0 && observedUiRange.extAnchorIndex >= 0 && observedUiRange.uiAnchorIndex !== observedUiRange.extAnchorIndex) {
                                this.uiDebugChannel.appendLine(`[EXT][UNDO_RANGE_MISMATCH] sessionId=${finalSessionId || 'null'} opId=${operationId || 'null'} uiAnchorIndex=${observedUiRange.uiAnchorIndex} extAnchorIndex=${observedUiRange.extAnchorIndex} messageIds=${appliedMessageIds.length} uiMessageIds=${observedUiRange.messageIds.length}`);
                            }
                            this.uiDebugChannel.appendLine(`[EXT][UNDO_TX] type=revertedSegment sessionId=${finalSessionId || 'null'} anchorMsgId=${segment.startMessageId} endMsgId=${uiSegment.endMessageId} applied=true opId=${operationId || 'null'} messageIds=${appliedMessageIds.length}`);
                            liveWebview.postMessage({
                                type: 'revertedSegment',
                                conflicts: result.conflicts || [],
                                messageIds: appliedMessageIds,
                                segment: {
                                    isActive: uiSegment.isActive,
                                    startMessageId: uiSegment.startMessageId,
                                    startMessageIndex: uiSegment.startMessageIndex,
                                    endMessageId: uiSegment.endMessageId,
                                    endMessageIndex: uiSegment.endMessageIndex,
                                    collapsed: uiSegment.collapsed,
                                    messageIds: uiSegment.messageIds,
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
                            await this.persistRevertedSegment(ownerSessionId, uiSegment, result.conflicts, false);
                        } else {
                            this.revertedSegment = { conflicts: result.conflicts };
                            const finalSessionId = ownerSessionId;
                            this.uiDebugChannel.appendLine(`[EXT][UNDO_TX] type=revertedSegment sessionId=${finalSessionId || 'null'} anchorMsgId=null endMsgId=null applied=true opId=${operationId || 'null'} messageIds=0`);
                            liveWebview.postMessage({
                                type: 'revertedSegment',
                                conflicts: result.conflicts || [],
                                segment: null,
                                messageIds: [],
                                sessionId: finalSessionId,
                                operationId,
                                noticeKey
                            });
                        }
                        if (!result.touchedFiles.length) {
                            this.uiDebugChannel.appendLine(`[EXT][UNDO_TX] type=addResponse sessionId=${ownerSessionId} opId=${operationId}`);
                            this.postAddResponse(activeWebview, 'Undo applied. No tracked file changes were available to revert. The current model may not support file change tracks. Please consider use OpenAI Codex.', { operationId, sessionId: ownerSessionId });
                        } else {
                            this.uiDebugChannel.appendLine(`[EXT][UNDO_TX] type=addResponse sessionId=${ownerSessionId} opId=${operationId}`);
                            this.postAddResponse(activeWebview, 'Undo applied.', { operationId, sessionId: ownerSessionId });
                        }
                        this.refreshDiffIfTouched(result.touchedFiles);
                    } catch (error) {
                        vscode.window.showErrorMessage(`Undo failed: ${error}`);
                        this.uiDebugChannel.appendLine(`[EXT][UNDO_TX] type=error sessionId=${ownerSessionId} opId=${operationId}`);
                        const liveWebview = this._view?.webview || activeWebview;
                        liveWebview.postMessage({ type: 'addResponse', value: `Undo failed: ${error}`, sessionId: ownerSessionId, operationId, meta: { operationId } });
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
                    if (cancelSessionId) {
                        const tmpKey = this.pendingAssistantTmpKeyBySession.get(cancelSessionId);
                        const mappedAssistant = tmpKey ? this.clientMessageIdMap.get(tmpKey) : undefined;
                        const pendingAssistant = this.pendingAssistantMessageIdBySession.get(cancelSessionId);
                        if (tmpKey) {
                            await this.handleAbortedMessage(tmpKey, activeWebview);
                            this.pendingAssistantTmpKeyBySession.delete(cancelSessionId);
                        }
                        if (pendingAssistant) {
                            await this.handleAbortedMessage(pendingAssistant, activeWebview);
                            this.pendingAssistantMessageIdBySession.delete(cancelSessionId);
                        }
                        if (mappedAssistant && mappedAssistant !== tmpKey) {
                            await this.handleAbortedMessage(mappedAssistant, activeWebview);
                        }
                        this.assistantTextBufferBySession.delete(cancelSessionId);
                    }
                    const draftToRestore = this.consumeDraft(restoreLocalKey);
                    if (draftToRestore) {
                        activeWebview.postMessage({
                            type: 'restoreDraft',
                            payload: draftToRestore
                        });
                    }
                    // Cleanup before chatDone
                    if (cancelSessionId) {
                        await this.commitPendingTurnChangesFromAuthoritativeFiles(this.buildFinalizeTurnIdentity(cancelSessionId, {
                            reqId: 'user-cancel',
                            assistantMessageId: this.client.getTurnAssistantMsgId(cancelSessionId)
                        }));
                    }
                    if (cancelSessionId) {
                        this.client.finishTurn(cancelSessionId);
                        this.postFinalWatchDiffFocusedBySession.delete(cancelSessionId);
                    }
                    this.markSubagentsTerminalForParent(cancelSessionId, 'cancelled', 'user-cancel');
                    this.emitSubagentStatus();
                    this.clearSubagentSessionsForParent(cancelSessionId, 'user-cancel');

                    const doneAssistantMsgId = cancelSessionId
                        ? this.client.getTurnAssistantMsgId(cancelSessionId)
                        : undefined;
                    activeWebview.postMessage({
                        type: 'chatDone',
                        sessionId: cancelSessionId,
                        assistantMsgId: doneAssistantMsgId,
                        lastAssistantMsgId: doneAssistantMsgId
                    });
                    if (cancelSessionId) {
                        this.syncTurnInFlightAfterFinalize(cancelSessionId, activeWebview, 'user-cancel');
                        await this.runPendingSendInitGuardCompensation(cancelSessionId, activeWebview, 'user-cancel');
                    }
                    break;
                }
                case "restoreAll": {
                    const payloadSessionId = typeof data.sessionId === 'string' && data.sessionId.trim() ? data.sessionId.trim() : undefined;
                    const operationId = typeof data.operationId === 'string' && data.operationId.trim() ? data.operationId.trim() : undefined;
                    const noticeKey = typeof data.noticeKey === 'string' ? data.noticeKey : '';
                    this.uiDebugChannel.appendLine(`[EXT][RESTORE_ROUTE] phase=rx type=restoreAll payloadSessionId=${payloadSessionId || 'null'} currentSessionId=${this.currentSessionId || 'null'} opId=${operationId || 'null'} noticeKey=${noticeKey || 'null'}`);
                    if (!payloadSessionId || !operationId) {
                        const missing = [!payloadSessionId ? 'sessionId' : undefined, !operationId ? 'operationId' : undefined].filter(Boolean).join(',');
                        this.uiDebugChannel.appendLine(`[EXT][RESTORE_DROP] type=restoreAll reason=missing-${missing} payloadSessionId=${payloadSessionId || 'null'} currentSessionId=${this.currentSessionId || 'null'} opId=${operationId || 'null'} noticeKey=${noticeKey || 'null'}`);
                        break;
                    }
                    const ownerSessionId = payloadSessionId;
                    this.uiDebugChannel.appendLine(`[EXT][RESTORE_ROUTE] phase=owner-captured type=restoreAll ownerSessionId=${ownerSessionId} opId=${operationId} noticeKey=${noticeKey || 'null'}`);
                    try {
                        if (!this.gitUndoEnabled) {
                            this.uiDebugChannel.appendLine(`[EXT][RESTORE_TX] type=addResponse sessionId=${ownerSessionId} opId=${operationId} reason=git-unavailable`);
                            this.postAddResponse(activeWebview, 'Restore unavailable: Git not installed or version too old. Please install/upgrade Git and restart VS Code.', { operationId, sessionId: ownerSessionId });
                            break;
                        }
                        const currentSegment = this.client.getRevertedSegment();
                        const fallbackCommits = Array.isArray(currentSegment?.startCommits) && currentSegment?.startCommits?.length
                            ? currentSegment.startCommits
                            : (currentSegment?.startCommit ? [currentSegment.startCommit] : []);
                        const commitsToClear = ownerSessionId
                            ? await this.resolveChangeListCommits(ownerSessionId, currentSegment?.messageIds, fallbackCommits)
                            : fallbackCommits;
                        const result = await this.client.restoreAll({ sessionId: ownerSessionId });
                        if (!result.applied && result.conflicts.length) {
                            const conflictId = this.createConflictId('restore', operationId);
                            this.pendingConflict = { kind: 'restore', sessionId: ownerSessionId, operationId, conflictId, noticeKey };
                            const liveWebview = this._view?.webview || activeWebview;
                            this.uiDebugChannel.appendLine(`[EXT][RESTORE_TX] type=conflictCard sessionId=${ownerSessionId} opId=${operationId} conflictId=${conflictId} kind=restore noticeKey=${noticeKey || 'null'}`);
                            liveWebview.postMessage({
                                type: 'conflictCard',
                                kind: 'restore',
                                source: 'restoreAll',
                                conflictId,
                                conflicts: result.conflicts,
                                sessionId: ownerSessionId,
                                operationId,
                                noticeKey
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
                            sessionId: ownerSessionId,
                            operationId
                        });
                        this.uiDebugChannel.appendLine(`[EXT][RESTORE_TX] type=restoredSegment sessionId=${ownerSessionId} opId=${operationId} noticeKey=${noticeKey || 'null'} applied=${result.applied}`);
                        this.client.discardRevertedSegment();
                        const discardedSegment = this.client.getRevertedSegment();
                        this.uiDebugChannel.appendLine(`[EXT][RESTORE_TX] type=revertedSegmentDiscarded sessionId=${ownerSessionId} opId=${operationId}`);
                        activeWebview.postMessage({
                            type: 'revertedSegmentDiscarded',
                            segment: discardedSegment ? { ...discardedSegment, historySegments: this.revertedSegmentHistory } : discardedSegment,
                            sessionId: ownerSessionId,
                            operationId
                        });
                        if (ownerSessionId) {
                            await this.clearPersistedSegment(ownerSessionId);
                        }
                        if (ownerSessionId && commitsToClear.length) {
                            for (const commitHash of commitsToClear) {
                                await this.setChangeListReverted(ownerSessionId, commitHash, false, activeWebview);
                            }
                        }
                        this.uiDebugChannel.appendLine(`[EXT][RESTORE_TX] type=addResponse sessionId=${ownerSessionId} opId=${operationId}`);
                        this.postAddResponse(activeWebview, 'Restore applied.', { operationId, sessionId: ownerSessionId });
                        this.refreshDiffIfTouched(result.touchedFiles);
                        if (ownerSessionId) {
                            await this.clearPersistedSegment(ownerSessionId);
                        }
                    } catch (error) {
                        vscode.window.showErrorMessage(`Restore failed: ${error}`);
                        this.uiDebugChannel.appendLine(`[EXT][RESTORE_TX] type=error sessionId=${ownerSessionId} opId=${operationId}`);
                        activeWebview.postMessage({ type: 'addResponse', value: `Restore failed: ${error}`, sessionId: ownerSessionId, operationId, meta: { operationId, sessionId: ownerSessionId } });
                    }
                    break;
                }
                case "restoreSegment": {
                    const payloadSessionId = typeof data.sessionId === 'string' && data.sessionId.trim() ? data.sessionId.trim() : undefined;
                    const operationId = typeof data.operationId === 'string' && data.operationId.trim() ? data.operationId.trim() : undefined;
                    const anchorMsgId = typeof data.anchorMsgId === 'string' && data.anchorMsgId.trim() ? data.anchorMsgId.trim() : '';
                    const noticeKey = typeof data.noticeKey === 'string' ? data.noticeKey : '';
                    const endMsgId = typeof data.endMsgId === 'string' ? data.endMsgId : undefined;
                    this.uiDebugChannel.appendLine(`[EXT][RESTORE_ROUTE] phase=rx type=restoreSegment payloadSessionId=${payloadSessionId || 'null'} currentSessionId=${this.currentSessionId || 'null'} opId=${operationId || 'null'} noticeKey=${noticeKey || 'null'} anchorMsgId=${anchorMsgId || 'null'} endMsgId=${endMsgId || 'null'}`);
                    if (!payloadSessionId || !operationId || !anchorMsgId) {
                        const missing = [!payloadSessionId ? 'sessionId' : undefined, !operationId ? 'operationId' : undefined, !anchorMsgId ? 'anchorMsgId' : undefined].filter(Boolean).join(',');
                        this.uiDebugChannel.appendLine(`[EXT][RESTORE_DROP] type=restoreSegment reason=missing-${missing} payloadSessionId=${payloadSessionId || 'null'} currentSessionId=${this.currentSessionId || 'null'} opId=${operationId || 'null'} noticeKey=${noticeKey || 'null'} anchorMsgId=${anchorMsgId || 'null'} endMsgId=${endMsgId || 'null'}`);
                        break;
                    }
                    const ownerSessionId = payloadSessionId;
                    this.uiDebugChannel.appendLine(`[EXT][RESTORE_ROUTE] phase=owner-captured type=restoreSegment ownerSessionId=${ownerSessionId} opId=${operationId} noticeKey=${noticeKey || 'null'} anchorMsgId=${anchorMsgId} endMsgId=${endMsgId || 'null'}`);
                    try {
                        const currentSegment = this.client.getRevertedSegment();
                        const segMap = this.undoSegmentsBySession.get(ownerSessionId);
                        const persistedSegment = noticeKey ? segMap?.get(noticeKey) : undefined;
                        const messageIds = Array.isArray(persistedSegment?.memberMsgIds) && persistedSegment?.memberMsgIds?.length
                            ? persistedSegment.memberMsgIds
                            : (Array.isArray(currentSegment?.messageIds) ? currentSegment?.messageIds : []);
                        const restoreScope = this.buildRestoreMessageScope(ownerSessionId, noticeKey, messageIds, persistedSegment);
                        const fallbackCommits = Array.isArray(currentSegment?.startCommits) && currentSegment?.startCommits?.length
                            ? currentSegment.startCommits
                            : (currentSegment?.startCommit ? [currentSegment.startCommit] : []);
                        const commitsToClear = ownerSessionId
                            ? await this.resolveChangeListCommits(ownerSessionId, restoreScope.activeRestoreMessageIds, fallbackCommits)
                            : fallbackCommits;
                            const result = await this.client.restoreFromMessage(anchorMsgId, endMsgId, {
                                sessionId: ownerSessionId,
                                messageIds: restoreScope.activeRestoreMessageIds,
                                excludedMessageIds: restoreScope.invalidMessageIds
                            });
                        const liveWebview = this._view?.webview || activeWebview;
                        this.uiDebugChannel.appendLine(`[EXT][RESTORE_TX] type=restoredSegment sessionId=${ownerSessionId} opId=${operationId} noticeKey=${noticeKey || 'null'} applied=${result.applied}`);
                        if (result.applied) {
                            await this.applyRestoreSegmentSuccess(
                                ownerSessionId,
                                noticeKey,
                                anchorMsgId,
                                endMsgId,
                                result,
                                commitsToClear,
                                operationId,
                                liveWebview
                            );
                        } else if (result.conflicts.length) {
                            const conflictId = this.createConflictId('restoreSegment', operationId);
                            this.pendingConflict = { kind: 'restoreSegment', sessionId: ownerSessionId, operationId, conflictId, startMessageId: anchorMsgId, endMessageId: endMsgId, noticeKey };
                            this.uiDebugChannel.appendLine(`[EXT][RESTORE_TX] type=conflictCard sessionId=${ownerSessionId} opId=${operationId} conflictId=${conflictId} kind=restoreSegment noticeKey=${noticeKey || 'null'} anchorMsgId=${anchorMsgId} endMsgId=${endMsgId || 'null'}`);
                            liveWebview.postMessage({
                                type: 'conflictCard',
                                kind: 'restoreSegment',
                                source: 'restoreSegment',
                                conflictId,
                                conflicts: result.conflicts,
                                sessionId: ownerSessionId,
                                operationId,
                                noticeKey,
                                startMessageId: anchorMsgId,
                                endMessageId: endMsgId
                            });
                            // conflictCard provides the user-facing prompt; no extra system message needed.
                        }
                    } catch (error) {
                        vscode.window.showErrorMessage(`Restore failed: ${error}`);
                        this.uiDebugChannel.appendLine(`[EXT][RESTORE_TX] type=error sessionId=${ownerSessionId} opId=${operationId} noticeKey=${noticeKey || 'null'} anchorMsgId=${anchorMsgId}`);
                        activeWebview.postMessage({ type: 'addResponse', value: `Restore failed: ${error}`, sessionId: ownerSessionId, operationId, meta: { operationId, sessionId: ownerSessionId } });
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
                    const decision = (data.decision === 'override' || data.decision === 'continue' || data.decision === 'skip' || data.decision === 'cancel')
                        ? data.decision as 'override' | 'skip' | 'continue' | 'cancel'
                        : undefined;
                    const payloadSessionId = typeof data.sessionId === 'string' && data.sessionId.trim() ? data.sessionId.trim() : undefined;
                    const operationId = typeof data.operationId === 'string' && data.operationId.trim() ? data.operationId.trim() : undefined;
                    const conflictId = typeof data.conflictId === 'string' && data.conflictId.trim() ? data.conflictId.trim() : undefined;
                    const kind = typeof data.kind === 'string' && data.kind.trim() ? data.kind.trim() : undefined;
                    this.uiDebugChannel.appendLine(`[EXT][CONFLICT_ROUTE] phase=rx decision=${decision || 'null'} payloadSessionId=${payloadSessionId || 'null'} currentSessionId=${this.currentSessionId || 'null'} opId=${operationId || 'null'} conflictId=${conflictId || 'null'} kind=${kind || 'null'}`);
                    if (!decision || !payloadSessionId || !operationId || !conflictId || !kind) {
                        const missing = [!decision ? 'decision' : undefined, !payloadSessionId ? 'sessionId' : undefined, !operationId ? 'operationId' : undefined, !conflictId ? 'conflictId' : undefined, !kind ? 'kind' : undefined].filter(Boolean).join(',');
                        this.uiDebugChannel.appendLine(`[EXT][CONFLICT_DROP] reason=missing-${missing} payloadSessionId=${payloadSessionId || 'null'} opId=${operationId || 'null'} conflictId=${conflictId || 'null'} kind=${kind || 'null'} pending=${this.pendingConflict ? 'yes' : 'no'}`);
                        break;
                    }
                    if (!this.pendingConflict) {
                        this.uiDebugChannel.appendLine(`[EXT][CONFLICT_DROP] reason=no-pending sessionId=${payloadSessionId} opId=${operationId} conflictId=${conflictId} kind=${kind} decision=${decision}`);
                        break;
                    }
                    if (
                        this.pendingConflict.sessionId !== payloadSessionId ||
                        this.pendingConflict.operationId !== operationId ||
                        this.pendingConflict.conflictId !== conflictId ||
                        this.pendingConflict.kind !== kind
                    ) {
                        this.uiDebugChannel.appendLine(`[EXT][CONFLICT_DROP] reason=owner-mismatch payloadSessionId=${payloadSessionId} payloadOpId=${operationId} payloadConflictId=${conflictId} payloadKind=${kind} pendingSessionId=${this.pendingConflict.sessionId} pendingOpId=${this.pendingConflict.operationId} pendingConflictId=${this.pendingConflict.conflictId} pendingKind=${this.pendingConflict.kind} decision=${decision}`);
                        break;
                    }
                    const conflictContext = this.pendingConflict;
                    this.pendingConflict = undefined;
                    const ownerSessionId = conflictContext.sessionId;
                    this.uiDebugChannel.appendLine(`[EXT][CONFLICT_ROUTE] phase=owner-validated sessionId=${ownerSessionId} opId=${conflictContext.operationId} conflictId=${conflictContext.conflictId} kind=${conflictContext.kind} decision=${decision}`);
                    if (decision === 'cancel' || decision === 'skip') {
                        // skip means abandon the operation; do nothing.
                        this.uiDebugChannel.appendLine(`[EXT][CONFLICT_TX] type=skip sessionId=${ownerSessionId} opId=${conflictContext.operationId} conflictId=${conflictContext.conflictId} kind=${conflictContext.kind} decision=${decision}`);
                        break;
                    }
                    try {
                        if (conflictContext.kind === 'undo' && conflictContext.startMessageId) {
                            this.clearClientRevertedSegmentIfNonRestorable(ownerSessionId);
                            const previousSegment = this.client.getRevertedSegment();
                            const currentActiveNoticeKey = previousSegment?.startMessageId
                                ? `system:undo:${previousSegment.startMessageId}`
                                : undefined;
                            const undoRange = this.client.getUndoRangeForAnchor(conflictContext.startMessageId, ownerSessionId);
                            const invalidMessageIds = undoRange && undoRange.endIndex >= undoRange.startIndex
                                ? Array.from(this.getInvalidSegmentMessageIds(ownerSessionId, {
                                    currentNoticeKey: currentActiveNoticeKey,
                                    rangeStartIndex: undoRange.startIndex,
                                    rangeEndIndex: undoRange.endIndex
                                }))
                                : [];
                            const visibleMessageIds = Array.isArray(conflictContext.visibleMessageIds)
                                ? conflictContext.visibleMessageIds
                                : this.sanitizeUndoRangeMessageIds(data?.visibleMessageIds);
                            const forwardMessageIdsFromAnchor = Array.isArray(conflictContext.forwardMessageIdsFromAnchor)
                                ? conflictContext.forwardMessageIdsFromAnchor
                                : this.sanitizeUndoRangeMessageIds(data?.forwardMessageIdsFromAnchor);
                            this.uiDebugChannel.appendLine(`[EXT][CONFLICT_RETRY] kind=undo sessionId=${ownerSessionId} opId=${conflictContext.operationId} conflictId=${conflictContext.conflictId} uiRange=${visibleMessageIds.length} forward=${forwardMessageIdsFromAnchor.length}`);
                            const result = await this.client.undoFromMessage(conflictContext.startMessageId, {
                                force: true,
                                excludedMessageIds: invalidMessageIds,
                                sessionId: ownerSessionId,
                                visibleMessageIds,
                                forwardMessageIdsFromAnchor
                            });
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
                                    sessionId: ownerSessionId,
                                    operationId: conflictContext.operationId,
                                    conflictId: conflictContext.conflictId
                                });
                                await this.persistRevertedSegment(ownerSessionId, segment, result.conflicts, false);
                            }
                            this.uiDebugChannel.appendLine(`[EXT][CONFLICT_TX] type=addResponse sessionId=${ownerSessionId} opId=${conflictContext.operationId} conflictId=${conflictContext.conflictId} kind=undo`);
                            this.postAddResponse(activeWebview, 'Undo applied.', { operationId: conflictContext.operationId, sessionId: ownerSessionId });
                            this.refreshDiffIfTouched(result.touchedFiles);
                        }
                        if (conflictContext.kind === 'restore') {
                            const result = await this.client.restoreAll({ force: true, sessionId: ownerSessionId });
                            this.revertedSegmentHistory = [];
                            this.uiDebugChannel.appendLine(`[EXT][CONFLICT_TX] type=revertedSegment sessionId=${ownerSessionId} opId=${conflictContext.operationId} conflictId=${conflictContext.conflictId} kind=restore`);
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
                                sessionId: ownerSessionId,
                                operationId: conflictContext.operationId,
                                conflictId: conflictContext.conflictId
                            });
                            this.client.discardRevertedSegment();
                            const discardedSegment = this.client.getRevertedSegment();
                            this.uiDebugChannel.appendLine(`[EXT][CONFLICT_TX] type=revertedSegmentDiscarded sessionId=${ownerSessionId} opId=${conflictContext.operationId} conflictId=${conflictContext.conflictId} kind=restore`);
                            activeWebview.postMessage({
                                type: 'revertedSegmentDiscarded',
                                segment: discardedSegment ? { ...discardedSegment, historySegments: this.revertedSegmentHistory } : discardedSegment,
                                sessionId: ownerSessionId,
                                operationId: conflictContext.operationId,
                                conflictId: conflictContext.conflictId
                            });
                            await this.clearPersistedSegment(ownerSessionId);
                            this.uiDebugChannel.appendLine(`[EXT][CONFLICT_TX] type=addResponse sessionId=${ownerSessionId} opId=${conflictContext.operationId} conflictId=${conflictContext.conflictId} kind=restore`);
                            this.postAddResponse(activeWebview, 'Restore applied.', { operationId: conflictContext.operationId, sessionId: ownerSessionId });
                            this.refreshDiffIfTouched(result.touchedFiles);
                        }
                        if (conflictContext.kind === 'restoreSegment' && conflictContext.startMessageId) {
                            const currentSegment = this.client.getRevertedSegment();
                            const segMap = this.undoSegmentsBySession.get(ownerSessionId);
                            const persistedSegment = conflictContext.noticeKey ? segMap?.get(conflictContext.noticeKey) : undefined;
                            const messageIds = Array.isArray(persistedSegment?.memberMsgIds) && persistedSegment?.memberMsgIds?.length
                                ? persistedSegment.memberMsgIds
                                : (Array.isArray(currentSegment?.messageIds) ? currentSegment?.messageIds : []);
                            const restoreScope = this.buildRestoreMessageScope(ownerSessionId, conflictContext.noticeKey, messageIds, persistedSegment);
                            const result = await this.client.restoreFromMessage(
                                conflictContext.startMessageId,
                                conflictContext.endMessageId,
                                {
                                    force: true,
                                    sessionId: ownerSessionId,
                                    messageIds: restoreScope.activeRestoreMessageIds,
                                    excludedMessageIds: restoreScope.invalidMessageIds
                                }
                            );
                            if (conflictContext.noticeKey) {
                                const currentSegment = this.client.getRevertedSegment();
                                const fallbackCommits = Array.isArray(currentSegment?.startCommits) && currentSegment?.startCommits?.length
                                    ? currentSegment.startCommits
                                    : (currentSegment?.startCommit ? [currentSegment.startCommit] : []);
                                const commitsToClear = await this.resolveChangeListCommits(ownerSessionId, restoreScope.activeRestoreMessageIds, fallbackCommits);
                                this.uiDebugChannel.appendLine(`[EXT][CONFLICT_TX] type=applyRestoreSegmentSuccess sessionId=${ownerSessionId} opId=${conflictContext.operationId} conflictId=${conflictContext.conflictId} kind=restoreSegment noticeKey=${conflictContext.noticeKey || 'null'}`);
                                await this.applyRestoreSegmentSuccess(
                                    ownerSessionId,
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
                        this.uiDebugChannel.appendLine(`[EXT][CONFLICT_TX] type=error sessionId=${ownerSessionId} opId=${conflictContext.operationId} conflictId=${conflictContext.conflictId} kind=${conflictContext.kind}`);
                        activeWebview.postMessage({ type: 'addResponse', value: `Conflict resolution failed: ${error}`, sessionId: ownerSessionId, operationId: conflictContext.operationId, meta: { operationId: conflictContext.operationId, sessionId: ownerSessionId } });
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
                this.startWebviewLivenessProbes();
                void this.triggerWebviewLivenessProbe('visibility-visible');
            } else if (!webviewView.visible) {
                this.stopWebviewLivenessProbes('visibility-hidden');
            }
        });
        webviewView.onDidDispose(() => {
            this.uiDebugChannel.appendLine(`EXT: webviewReload.dispose.begin | panelId=${panelId} | webviewInstanceId=${this._webviewInstanceId || 'null'} | reload=false | recreate=false | sessionMutation=false`);
            this.stopWebviewLivenessProbes('webview-dispose');
            this.uiDebugChannel.appendLine(`EXT: webviewReload.dispose.done | panelId=${panelId} | webviewInstanceId=${this._webviewInstanceId || 'null'} | reload=false | recreate=false | sessionMutation=false`);
        });
    }

    private async sendInit(webview: vscode.Webview, options: SendInitOptions = {}): Promise<void> {
        const isStillCurrent = options.isStillCurrent || (() => true);
        if (!isStillCurrent()) throw new Error('stale-handshake-before-sendInit');
        const isHardRescueSendInit = Boolean(options.hardRescue && options.isStillCurrent);
        const rescueHydration = options.hardRescue || options.commandReload;
        const isCommandReloadSendInit = Boolean(options.commandReload && options.isStillCurrent);
        let isGuardedRescueSendInit = false;
        if (isHardRescueSendInit) {
            isGuardedRescueSendInit = true;
        }
        if (isCommandReloadSendInit) {
            isGuardedRescueSendInit = true;
        }
        if (isGuardedRescueSendInit) {
            const sourceWebview = webview;
            webview = new Proxy(sourceWebview, {
                get(target, property) {
                    if (property === 'postMessage') {
                        return (message: any) => {
                            if (!isStillCurrent()) return Promise.resolve(false);
                            return target.postMessage(message);
                        };
                    }
                    const value = Reflect.get(target, property, target);
                    return typeof value === 'function' ? value.bind(target) : value;
                }
            });
        }
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
            if (isStillCurrent()) this.postAddResponse(webview, `Failed to load models: ${error}`);
        }

        try {
            agents = await this.client.listAgents();
        } catch (error) {
            this.uiDebugChannel.appendLine(`EXT: agents.load.fail | err=${String(error)}`);
        }

        try {
            sessions = await this.client.listSessions();
        } catch (error) {
            if (isStillCurrent()) this.postAddResponse(webview, `Failed to load sessions: ${error}`);
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
        if (rescueHydration) {
            recentSessionId = rescueHydration.sessionId;
        }

        let initSessionCandidate = recentSessionId;
        if (!initSessionCandidate && workspaceFolder) {
            const workspaceRecent = await this.findMostRecentWorkspaceSession(sessions, workspaceFolder);
            initSessionCandidate = workspaceRecent?.id;
        }

        if (!this.initPosted && !rescueHydration?.activeTurn.fresh) {
            this.currentSessionId = this.currentSessionId || initSessionCandidate || undefined;
            if (this.currentSessionId) {
                this.client.setSessionId(this.currentSessionId);
            }
            const initSessionId = rescueHydration?.sessionId || initSessionCandidate || this.currentSessionId || '';
            const liveWebview = webview;
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
                sessionId: initSessionId,
                panelId: this.getWebviewLivenessPanelId(),
                webviewInstanceId: this._webviewInstanceId
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

            liveWebview.postMessage({ type: 'serverStatus', status: this.serverStatus, reason: 'init' });

            this.initPosted = true;
        } else {
            const initSessionId = rescueHydration?.sessionId || this.currentSessionId || initSessionCandidate || '';
            const liveWebview = webview;
            this.uiDebugChannel.appendLine(
                `[EXT][INIT_METADATA_RESEND] models=${models.length} sessions=${sessions.length} ` +
                `currentSessionId=${initSessionId || 'null'} selectedModel=${this.selectedModel || 'NULL'} selectedMode=${resolvedMode || 'null'} ` +
                `modeCount=${this.availableModes.length} postedSessionData=false metadataOnly=true`
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
                sessionId: initSessionId,
                panelId: this.getWebviewLivenessPanelId(),
                webviewInstanceId: this._webviewInstanceId,
                metadataOnly: true,
                postedSessionData: false
            });
            if (initSessionId) {
                liveWebview.postMessage({
                    type: 'turnInFlight',
                    sessionId: initSessionId,
                    inFlight: this.sendInFlightBySession.has(initSessionId)
                });
            }
        }

        if (options.hardRescue?.activeTurn.fresh) {
            const hardRescueSessionId = options.hardRescue.sessionId;
            if (!isStillCurrent()) throw new Error('stale-hard-rescue-before-live-hydration');
            await this.postLiveTurnHistoryForSendInitGuardDefer(webview, hardRescueSessionId, options.hardRescue.activeTurn);
            if (!isStillCurrent()) throw new Error('stale-hard-rescue-after-live-history');
            this.postLiveTurnResumeForSendInitGuardDefer(webview, hardRescueSessionId, options.hardRescue.activeTurn);
            this.queueSendInitGuardCompensation(hardRescueSessionId, 'sendInitGuard.defer', options.hardRescue.activeTurn);
            this.uiDebugChannel.appendLine(`[EXT][SENDINIT_END] sendInit completed successfully | hardRescue=true | postedSessionData=false`);
            return;
        }
        if (options.commandReload?.activeTurn.fresh) {
            const commandReloadSessionId = options.commandReload.sessionId;
            if (!isStillCurrent()) throw new Error('stale-command-reload-before-live-hydration');
            await this.postLiveTurnHistoryForSendInitGuardDefer(webview, commandReloadSessionId, options.commandReload.activeTurn);
            if (!isStillCurrent()) throw new Error('stale-command-reload-after-live-history');
            this.postLiveTurnResumeForSendInitGuardDefer(webview, commandReloadSessionId, options.commandReload.activeTurn);
            this.queueSendInitGuardCompensation(commandReloadSessionId, 'sendInitGuard.defer', options.commandReload.activeTurn);
            this.uiDebugChannel.appendLine(`[EXT][SENDINIT_END] sendInit completed successfully | commandReload=true | postedSessionData=false`);
            return;
        }

        let snapshotLoaded = false;
        let sessionDataSent = false;
                if (recentSessionId) {
                    try {
                        this.currentSessionId = recentSessionId;
                        this.trackUserOwnedSession(this.currentSessionId);
                        this.client.setSessionId(this.currentSessionId);
                        const liveWebview = webview;
                        const activeTurn = this.getWebviewLivenessActiveTurnFlags(recentSessionId);
                        if (activeTurn.fresh) {
                            this.uiDebugChannel.appendLine(
                                `EXT: webviewAutoRescue.hardRescue.sendInitGuard.defer | ` +
                                `sessionId=${recentSessionId} | panelId=${this.getWebviewLivenessPanelId()} | ` +
                                `webviewInstanceId=${this._webviewInstanceId || 'null'} | active=${String(activeTurn.active)} | ` +
                                `fresh=${String(activeTurn.fresh)} | activeTurnId=${activeTurn.turnId || 'none'} | ` +
                                `activeTurnSource=${activeTurn.source} | activeTurnAgeMs=${activeTurn.ageMs} | ` +
                                `activeTurnFreshnessWindowMs=${activeTurn.freshnessWindowMs} | ` +
                                `streaming=${String(activeTurn.streaming)} | finalizing=${String(activeTurn.finalizing)} | ` +
                                `postedSessionData=false | reload=false | recreate=false | sessionMutation=false`
                            );
                            await this.postLiveTurnHistoryForSendInitGuardDefer(liveWebview, recentSessionId, activeTurn);
                            this.postLiveTurnResumeForSendInitGuardDefer(liveWebview, recentSessionId, activeTurn);
                            this.queueSendInitGuardCompensation(recentSessionId, 'sendInitGuard.defer', activeTurn);
                            return;
                        }
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
                                snapshotTimelineIds = this.getSnapshotTimelineIds(snap.obj.sessionData, baseMessages);

                                const snapshotPayload = {
                                    type: 'sessionData',
                                    sessionId: recentSessionId,
                                    title: baseTitle,
                                    messages: baseMessages,
                                    segments,
                                    meta: {
                                        ...(snap.obj.sessionData?.meta || {}),
                                        source: 'snapshot',
                                        timelineMessageIds: snapshotTimelineIds,
                                        hydrationCoverage: 'deltaContinuityUnknown' as HydrationCoverage
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
                            const recentSelectionEpoch = this.sessionSelectionEpoch;
                            const recentLivenessOwner = this.webviewLivenessCurrent;
                            const recentWebviewInstanceId = this._webviewInstanceId;
                            const recentHydrationWebview = liveWebview;
                            const isRecentHydrationCurrent = () => (
                                this.currentSessionId === recentSessionId
                                && this.sessionSelectionEpoch === recentSelectionEpoch
                                && this.webviewLivenessCurrent === recentLivenessOwner
                                && this._webviewInstanceId === recentWebviewInstanceId
                                && (this._view?.webview || webview) === recentHydrationWebview
                            );
                            if (!isRecentHydrationCurrent()) throw new Error('stale-before-recent-hydration');
                            const recentExport = await this.client.exportSessionRecent(recentSessionId, this.recentSessionLoadLimit);
                            if (!isRecentHydrationCurrent()) throw new Error('stale-after-recent-export');
                            const formattedRaw = this.formatSession(recentExport);
                            const formatted = await this.injectChangeLists(recentSessionId, formattedRaw);
                            if (!isRecentHydrationCurrent()) throw new Error('stale-after-recent-format');
                            if (formatted.title) {
                                baseTitle = formatted.title;
                            }

                            const snapshotIdSet = new Set<string>(snapshotTimelineIds);
                            const snapshotMaxMessageIndex = this.getMaxMessageIndex(baseMessages);
                            const continuity = this.classifyRecentAppendCandidates(snapshotIdSet, snapshotMaxMessageIndex, formatted.messages);
                            const appendMessages = continuity.suffix;
                            let mergedMessages = snapshotTimelineIds.length > 0
                                ? this.buildImmutableSnapshotWithProvenSuffix(baseMessages, appendMessages)
                                : formatted.messages;
                            const newIds = appendMessages
                                .map((message) => (typeof message?.id === 'string' ? message.id : ''))
                                .filter((id): id is string => Boolean(id));
                            let timelineIds = [...snapshotTimelineIds, ...newIds];
                            let hydrationCoverage: HydrationCoverage = snapshotTimelineIds.length > 0 && continuity.proven
                                ? 'authoritativeHistoryComplete'
                                : 'deltaContinuityUnknown';

                            if (snapshotTimelineIds.length > 0 && !continuity.proven && this.snapshotDeltaContinuityRepairEnabled) {
                                if (!isRecentHydrationCurrent()) throw new Error('stale-before-full-repair');
                                liveWebview.postMessage({ type: 'hydrationCoverage', sessionId: recentSessionId, hydrationCoverage: 'repairInProgress' as HydrationCoverage });
                                const fullExport = await this.client.exportSession(recentSessionId);
                                if (!isRecentHydrationCurrent()) throw new Error('stale-after-full-repair');
                                const fullFormatted = this.formatSession(fullExport);
                                const repairRequiredMessageIds = await this.collectSnapshotRepairRequiredMessageIds(recentSessionId);
                                const fullDelta = this.buildFullExportSnapshotDelta(
                                    baseMessages, snapshotTimelineIds, fullFormatted.messages, repairRequiredMessageIds
                                );
                                if (fullDelta.repairedSnapshot) {
                                    await this.persistStructurallyRepairedSnapshot(
                                        recentSessionId, fullFormatted.title, fullDelta.messages, fullDelta.timelineMessageIds, segments
                                    );
                                }
                                const repaired = await this.injectChangeLists(recentSessionId, { title: fullFormatted.title, messages: fullDelta.messages });
                                if (!isRecentHydrationCurrent()) throw new Error('stale-after-full-repair-format');
                                mergedMessages = repaired.messages;
                                timelineIds = fullDelta.timelineMessageIds;
                                hydrationCoverage = fullDelta.proven ? 'authoritativeHistoryComplete' : 'deltaContinuityUnknown';
                            }

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
                                    timelineMessageIds: timelineIds,
                                    hydrationCoverage
                                }
                            };
                            if (!isRecentHydrationCurrent()) throw new Error('stale-before-recent-publish');
                            liveWebview.postMessage(sessionPayload);
                            if (mergedMessages.length > 0) {
                                sessionDataSent = true;
                            }
                            this.uiDebugChannel.appendLine(`[EXT][SNAP_SAVE_SKIP] sessionId=${recentSessionId} reason=sendInit:recent disabled=incremental-only`);
                        } catch (err) {
                            const recentErr = this.extractLastLine(String(err));
                            this.uiDebugChannel.appendLine(`[EXT][SESSION_RECENT_FAIL] sessionId=${recentSessionId} limit=${this.recentSessionLoadLimit} err=${recentErr || 'null'}`);

                            if (!snapshotLoaded) {
                                const liveWebview = webview;
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

                        const liveWebview = webview;
                        liveWebview.postMessage({
                            type: 'sessionData',
                            sessionId: this.currentSessionId,
                            title: formatted.title,
                            messages: formatted.messages,
                            segments: segments,
                            meta: {
                                timelineMessageIds: this.collectVisibleSnapshotMessages(formatted.messages)
                                    .map((message) => (typeof message?.id === 'string' ? message.id : ''))
                                    .filter((id): id is string => Boolean(id)),
                                hydrationCoverage: 'deltaContinuityUnknown' as HydrationCoverage
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
                                const liveWebview = webview;
                                liveWebview.postMessage({
                                    ...snap.obj.sessionData,
                                    title: snapshotFormatted.title,
                                    messages: snapshotFormatted.messages,
                                    segments,
                                    meta: {
                                        ...(snap.obj.sessionData?.meta || {}),
                                        hydrationCoverage: 'deltaContinuityUnknown' as HydrationCoverage
                                    }
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
                    
                    const liveWebview = webview;
                    liveWebview.postMessage({
                        type: 'sessionData',
                        sessionId: this.currentSessionId,
                        title: 'New Chat',
                        messages: [],
                        segments: [],
                        meta: {
                            hydrationCoverage: 'deltaContinuityUnknown' as HydrationCoverage
                        }
                    });
                } catch (err) {
                    this.uiDebugChannel.appendLine(`[EXT][SESSION_CREATE_FAILED] err=${String(err)}`);
                    // Last resort: set a placeholder to avoid undefined
                    this.currentSessionId = `fallback-${Date.now()}`;
                }
            }
        }

        const liveWebview = webview;

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

    public requestAttachmentCleanup(reason: 'manual'): void {
        this.attachmentStorage.scheduleCleanup(reason);
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
            sessionId,
            operationId
        });
        this.client.discardRevertedSegment();
        const discardedSegment = this.client.getRevertedSegment();
        liveWebview.postMessage({
            type: 'revertedSegmentDiscarded',
            segment: discardedSegment ? { ...discardedSegment, historySegments: this.revertedSegmentHistory, noticeKey } : discardedSegment,
            sessionId,
            operationId
        });
        this.uiDebugChannel.appendLine(`[EXT][RESTORE_TX] type=revertedSegmentDiscarded sessionId=${sessionId} opId=${operationId || 'null'} noticeKey=${noticeKey || 'null'}`);
        this.uiDebugChannel.appendLine(`[EXT][RESTORE_TX] type=addResponse sessionId=${sessionId} opId=${operationId || 'null'} noticeKey=${noticeKey || 'null'}`);
        this.postAddResponse(liveWebview, 'Restore applied.', { operationId, sessionId });
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
            let segStart = this.client.getMessageIndex(segment.anchorMsgId || '', sessionId);
            let segEnd = this.client.getMessageIndex(segment.endMsgId || '', sessionId);
            if (typeof segStart !== 'number' || typeof segEnd !== 'number') {
                const indices = (Array.isArray(segment.memberMsgIds) ? segment.memberMsgIds : [])
                    .map((id) => this.client.getMessageIndex(id, sessionId))
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
        if (this.smartSearchSessions.owns(event.sessionId)) {
            return;
        }
        // Handle todoUpdate event for main session or parent-mapped subagent todos.
        if (event.type === 'todoUpdate' && (this.isUserOwnedSession(event.sessionId || '') || event.displayTarget === 'parent')) {
            webview.postMessage({
                type: 'todoUpdate',
                todos: event.todos,
                anchorMessageId: event.assistantMsgId,
                sessionId: event.sessionId,
                parentSessionId: event.parentSessionId,
                agentSessionId: event.agentSessionId,
                displayTarget: event.displayTarget,
            });
            return;
        }
        if (event.type === 'assistantPhase' && event.sessionId) {
            webview.postMessage({
                type: 'assistantPhase',
                sessionId: event.sessionId,
                messageId: event.messageId || event.assistantMsgId || '',
                parentId: event.parentId,
                parentSessionId: event.parentSessionId,
                agentSessionId: event.agentSessionId,
                displayTarget: event.displayTarget,
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
            const explicitParentSessionId = event.parentSessionId;
            if (!this.isUserOwnedSession(event.sessionId) && explicitParentSessionId) {
                this.activeSubagentSessionIds.add(event.sessionId);
                this.client.registerSubagentSession(event.sessionId, explicitParentSessionId);
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
                    this.logSubagentRoute('register', existing.parentSessionId || explicitParentSessionId, event.sessionId, 'parent', 'existing-entry');
                    this.uiDebugChannel.appendLine(`[SidebarProvider] Subagent session event: ${event.sessionId} | mode=${event.mode || 'null'} | agent=${event.agent || 'null'} | modelID=${event.modelID || 'null'} | providerID=${event.providerID || 'null'}`);
                    this.emitSubagentStatus();
                    return;
                }
                this.subagentProgressBySession.set(event.sessionId, {
                    taskId: event.sessionId,
                    parentSessionId: explicitParentSessionId,
                    description: initialMode,
                    mode: initialMode,
                    model: initialModel,
                    providerId: initialProvider,
                    isDone: false,
                    state: 'queued',
                    lastEventAt: Date.now(),
                    startedAt: Date.now()
                });
                this.logSubagentRoute('register', explicitParentSessionId, event.sessionId, 'parent', 'explicit-parent');
                this.uiDebugChannel.appendLine(`[SidebarProvider] Registered subagent session mapping: ${event.sessionId} -> ${explicitParentSessionId}`);
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
                const mappedParentSessionId = this.subagentProgressBySession.get(event.sessionId)?.parentSessionId
                    || this.client.getParentSessionForSubagent(event.sessionId);
                if (!mappedParentSessionId) {
                    this.logSubagentRoute('register', undefined, event.sessionId, 'parent', 'missing-parent', true);
                    return;
                }
                this.activeSubagentSessionIds.add(event.sessionId);
                this.client.registerSubagentSession(event.sessionId, mappedParentSessionId);
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
                    this.logSubagentRoute('register', existing.parentSessionId || mappedParentSessionId, event.sessionId, 'parent', 'existing-entry');
                    this.uiDebugChannel.appendLine(`[SidebarProvider] Subagent session event: ${event.sessionId} | mode=${event.mode || 'null'} | agent=${event.agent || 'null'} | modelID=${event.modelID || 'null'} | providerID=${event.providerID || 'null'}`);
                    this.emitSubagentStatus();
                    return;
                }
                this.subagentProgressBySession.set(event.sessionId, {
                    taskId: event.sessionId,
                    parentSessionId: mappedParentSessionId,
                    description: initialMode,
                    mode: initialMode,
                    model: initialModel,
                    providerId: initialProvider,
                    isDone: false,
                    state: 'queued',
                    lastEventAt: Date.now(),
                    startedAt: Date.now()
                });
                this.logSubagentRoute('register', mappedParentSessionId, event.sessionId, 'parent', 'mapped-parent');
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
            const subagentEntry = this.subagentProgressBySession.get(event.sessionId);
            const parentSessionId = subagentEntry?.parentSessionId;
            if (!subagentEntry || !parentSessionId) {
                this.logSubagentRoute(String(event.type || 'event'), parentSessionId, event.sessionId, 'parent', subagentEntry ? 'missing-parent' : 'missing-entry', true);
                return;
            }
            if (event.type === 'text' && typeof event.text === 'string') {
                const entry = subagentEntry;
                if (entry) {
                    if (entry.isDone) {
                        return;
                    }
                    entry.latestFullText = event.text;
                    entry.latestText = event.text.length > 200
                        ? event.text.slice(0, 200) + '...'
                        : event.text;
                    this.transitionSubagentState(event.sessionId, entry, 'running', 'progress');
                    this.emitSubagentStatus();
                }
            }
            // Handle generic tool events (e.g., grep, read, etc.)
            if (event.type === 'tool' && event.tool) {
                const entry = subagentEntry;
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
                const entry = subagentEntry;
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
                const entry = subagentEntry;
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
            if (event.type === 'files' && event.files && event.files.length) {
                const entry = subagentEntry;
                const isReplay = event.source === 'resync';
                if (!isReplay) {
                    this.client.queueSubagentChanges(parentSessionId, event.files);
                    this.logSubagentRoute('files', parentSessionId, event.sessionId, 'parent', 'queue-subagent-changes');
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
                        sessionId: parentSessionId,
                        parentSessionId,
                        agentSessionId: event.sessionId,
                        displayTarget: 'parent',
                        reason: 'file-change-detected'
                    });
                    event.files.forEach((file, index) => {
                        this.tryOpenDiffForEventFile(file, liveWebview, index, parentSessionId, 'subagent');
                    });
                    
                    // Detect .md files and send plan file card
                    const mdFiles = event.files
                        .map(f => (typeof f === 'string' ? f : (f as any).path))
                        .filter((path): path is string => typeof path === 'string' && path.endsWith('.md'));
                    if (mdFiles.length) {
                        const anchorMessageId = this.client.getTurnAssistantMsgId(parentSessionId);
                        if (anchorMessageId) {
                            liveWebview.postMessage({
                                type: 'planFileCard',
                                files: mdFiles,
                                anchorMessageId,
                                sessionId: parentSessionId,
                                parentSessionId,
                                agentSessionId: event.sessionId,
                                displayTarget: 'parent'
                            });
                        }
                    }
                }
                // REMOVED: Mid-stream emitDiffFileList call
                // Change-list should only emit after finalization sequence (chatDone → commit → upgrade → diffList)
                // This prevents premature change-list emission before final assistant message
            }
            if (event.type === 'assistantMessageMeta' && event.sessionId && !event.isStatusUpdate) {
                const entry = subagentEntry;
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
            if (this.shouldSuppressWebviewStuckCardForAutoRescue(event.sessionId, 'autoResumeStallWarn')) {
                return;
            }
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
            if (this.shouldSuppressWebviewStuckCardForAutoRescue(event.sessionId, 'autoResumeHardStop')) {
                return;
            }
            const liveWebview = this._view?.webview || webview;
            this.uiDebugChannel.appendLine(`EXT: autoresume.hardstop | sessionId=${event.sessionId} | action=show-stall-card`);
            this.sendInFlightBySession.delete(event.sessionId);
            liveWebview.postMessage({ type: 'turnInFlight', sessionId: event.sessionId, inFlight: false });
            this.syncTurnInFlightAfterFinalize(event.sessionId, liveWebview, 'autoResumeHardStop');
            await this.runPendingSendInitGuardCompensation(event.sessionId, liveWebview, 'autoResumeHardStop');
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
                this.markWebviewActiveTurnUpdated(event.sessionId, 'event:turnInFlight:true');
            } else {
                this.sendInFlightBySession.delete(event.sessionId);
                this.markWebviewActiveTurnUpdated(event.sessionId, 'event:turnInFlight:false');
            }
            liveWebview.postMessage({
                type: 'turnInFlight',
                sessionId: event.sessionId,
                inFlight: event.inFlight === true,
                ownerMsgId: event.ownerMsgId
            });
            if (event.inFlight !== true) {
                this.syncTurnInFlightAfterFinalize(event.sessionId, liveWebview, 'event:turnInFlight:false');
                await this.runPendingSendInitGuardCompensation(event.sessionId, liveWebview, 'event:turnInFlight:false');
            }
            return;
        }

        if (event.type === 'backgroundActivityPulse' && event.sessionId) {
            const liveWebview = this._view?.webview || webview;
            liveWebview.postMessage({
                type: 'backgroundActivityPulse',
                sessionId: event.sessionId,
                parentSessionId: event.parentSessionId,
                agentSessionId: event.agentSessionId,
                displayTarget: event.displayTarget,
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
            if (sessionId) {
                this.markWebviewActiveTurnUpdated(sessionId, 'event:assistantMessageMeta');
            }
            const isSyntheticTurn = this.isCurrentTurnSynthetic(sessionId);
            liveWebview.postMessage({
                type: 'assistantMessageMeta',
                messageId: event.messageId,
                messageIndex: event.messageIndex,
                lastText: event.lastText,
                sessionId,
                parentSessionId: event.parentSessionId,
                agentSessionId: event.agentSessionId,
                displayTarget: event.displayTarget,
                assistantMsgId: event.assistantMsgId,
                tmpKey,
                isStatusUpdate: event.isStatusUpdate,
                allowedSessionIds: event.displayTarget === 'agent-lane' && event.agentSessionId
                    ? [event.agentSessionId, ...(event.parentSessionId ? [event.parentSessionId] : [])]
                    : this.getAssistantMetaAllowedSessionIds(),
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
                this.markWebviewActiveTurnUpdated(sessionId, 'event:text');
                this.appendAssistantBuffer(sessionId, event.text);
                // Push latest chunk to webview (no cumulative text)
                const liveWebview = this._view?.webview || webview;
                const isSyntheticTurn = this.isCurrentTurnSynthetic(sessionId);
                liveWebview?.postMessage({
                    type: 'assistantMessageMeta',
                    sessionId,
                    parentSessionId: event.parentSessionId,
                    agentSessionId: event.agentSessionId,
                    displayTarget: event.displayTarget,
                    tmpKey: this.pendingAssistantTmpKeyBySession?.get(sessionId),
                    lastText: event.text,
                    isStatusUpdate: false,
                    allowedSessionIds: event.displayTarget === 'agent-lane' && event.agentSessionId
                        ? [event.agentSessionId, ...(event.parentSessionId ? [event.parentSessionId] : [])]
                        : this.getAssistantMetaAllowedSessionIds(),
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
                await this.commitPendingTurnChangesFromAuthoritativeFiles(this.buildFinalizeTurnIdentity(sessionId, {
                    reqId: 'event-error-finalize',
                    assistantMessageId: this.client.getTurnAssistantMsgId(sessionId)
                }));
            }
            await this.resolvePendingUserUpgrade(sessionId, liveWebview);
            // Mark all active subagents as done before clearing (error event path)
            this.markSubagentsTerminalForParent(sessionId, 'failed', 'event-error-finalize');
            this.emitSubagentStatus();
            this.clearSubagentSessionsForParent(sessionId, 'event-error-finalize');

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
                this.syncTurnInFlightAfterFinalize(sessionId, liveWebview, 'event-error-finalize');
            }
            this.emitTurnFinalizePhase(liveWebview, sessionId, 'finalize_done');
            await this.runPendingSendInitGuardCompensation(sessionId, liveWebview, 'event-error-finalize');
            return;
        }

        if (event.type === 'permission' && event.text) {
            const liveWebview = this._view?.webview || webview;
            if (!event.sessionId) {
                this.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE_DROP] event=permissionPrompt reason=missing-event-session`);
                return;
            }
            this.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE] event=permissionPrompt targetSessionId=${event.sessionId}`);
            liveWebview.postMessage({ type: 'permissionPrompt', value: event.text, sessionId: event.sessionId });
            return;
        }

        if (event.type === 'message' && event.text) {
            const sessionId = event.sessionId || this.currentSessionId;
            const localKey = this.pendingClientMessageId
                || (sessionId ? this.pendingLocalKeyBySession.get(sessionId) : undefined)
                || null;
            if (localKey && sessionId) {
                const mappedMessageIndex = this.client.getMessageIndex(localKey, sessionId)
                    ?? this.client.registerMessage(localKey, sessionId);
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
                const liveWebview = this._view?.webview || webview;
                liveWebview.postMessage({
                    type: 'userAckBind',
                    sessionId,
                    localKey,
                    msgId: event.text
                });
            }
            return;
        }

        if (event.type === 'diff' && event.text) {
            const liveWebview = this._view?.webview || webview;
            if (!event.sessionId) {
                this.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE_DROP] event=diffChunk reason=missing-event-session`);
                return;
            }
            this.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE] event=diffChunk targetSessionId=${event.sessionId}`);
            liveWebview.postMessage({ type: 'diffChunk', value: event.text, sessionId: event.sessionId });
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
                    let commitResult: CommitPendingTurnChangesResult | undefined;
                    try {
                        commitResult = await this.commitPendingTurnChangesFromAuthoritativeFiles(this.buildFinalizeTurnIdentity(sessionId, {
                            reqId: 'late-event-recovery',
                            assistantMessageId: this.client.getTurnAssistantMsgId(sessionId)
                        }));
                        this.uiDebugChannel.appendLine(`[LATE_DIFF] committed pending turn changes | sessionId=${sessionId} reason=late-event-recovery status=${commitResult?.status || 'missing'}`);
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
                    void this.emitDiffFileListWithRetry(this.buildFinalizeTurnIdentity(sessionId, {
                        reqId: 'late-event-recovery',
                        commitResult
                    }), liveWebview);
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
        this.markWebviewActiveTurnUpdated(sessionId, 'appendAssistantBuffer');
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
        await this._context.globalState.update(
            this.UNDO_SEGMENTS_KEY,
            serializeUndoSegments(this.undoSegmentsBySession)
        );
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
            const attachmentsRoot = this.attachmentStorage.getAttachmentsRootPath();
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
        this.attachmentStorage.dispose();
        if (this.subagentRetentionTimer) {
            clearTimeout(this.subagentRetentionTimer);
            this.subagentRetentionTimer = undefined;
        }
        await this.smartSearchSessions.dispose();
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

    private buildImmutableSnapshotWithProvenSuffix(
        existingSnapshotRecords: SessionMessage[],
        provenSuffix: SessionMessage[]
    ): SessionMessage[] {
        const result = Array.isArray(existingSnapshotRecords) ? [...existingSnapshotRecords] : [];
        const seenCanonicalIds = new Set<string>();
        for (const message of result) {
            if (typeof message?.id === 'string' && message.id) seenCanonicalIds.add(message.id);
        }
        for (const message of Array.isArray(provenSuffix) ? provenSuffix : []) {
            const id = typeof message?.id === 'string' ? message.id : '';
            if (!id.startsWith('msg_') || seenCanonicalIds.has(id)) continue;
            result.push(message);
            seenCanonicalIds.add(id);
        }
        return result;
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
        const sessionId = exportData?.session?.id || exportData?.info?.id || exportData?.info?.sessionId || this.currentSessionId;
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
            const messageIndex = this.client.registerMessage(resolvedId, sessionId);
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
            const messageIndex = this.client.registerMessage(resolvedId, sessionId);
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
        const retainedSendInFlightBySession = new Set(this.sendInFlightBySession);
        const retainedPendingLocalKeyBySession = new Map<string, string>();
        const retainedPendingAssistantTmpKeyBySession = new Map<string, string>();
        const retainedPendingAssistantMessageIdBySession = new Map<string, string>();
        const retainedAssistantTextBufferBySession = new Map<string, string>();
        const retainedPendingSnapshotUserTextBySession = new Map<string, string>();
        const retainedRawUserTextByLocalKey = new Map<string, string>();
        const retainedPendingAssistantTmpKeyByLocalKey = new Map<string, string>();
        const isRetainableTmpKey = (value: string | undefined): value is string => Boolean(value && (value.startsWith('tmp:') || value.startsWith('local-')));
        for (const sessionId of retainedSendInFlightBySession) {
            if (typeof sessionId !== 'string' || !sessionId) continue;
            const pendingLocalKey = this.pendingLocalKeyBySession.get(sessionId);
            if (pendingLocalKey) {
                retainedPendingLocalKeyBySession.set(sessionId, pendingLocalKey);
                const rawUserText = this.rawUserTextByLocalKey.get(pendingLocalKey);
                if (rawUserText !== undefined) {
                    retainedRawUserTextByLocalKey.set(pendingLocalKey, rawUserText);
                }
                const tmpKeyByLocalKey = this.pendingAssistantTmpKeyByLocalKey.get(pendingLocalKey);
                if (isRetainableTmpKey(tmpKeyByLocalKey)) {
                    retainedPendingAssistantTmpKeyByLocalKey.set(pendingLocalKey, tmpKeyByLocalKey);
                }
            }
            const tmpKey = this.pendingAssistantTmpKeyBySession.get(sessionId);
            if (isRetainableTmpKey(tmpKey)) {
                retainedPendingAssistantTmpKeyBySession.set(sessionId, tmpKey);
            }
            const assistantMessageId = this.pendingAssistantMessageIdBySession.get(sessionId);
            if (assistantMessageId) {
                retainedPendingAssistantMessageIdBySession.set(sessionId, assistantMessageId);
            }
            const assistantTextBuffer = this.assistantTextBufferBySession.get(sessionId);
            if (assistantTextBuffer !== undefined) {
                retainedAssistantTextBufferBySession.set(sessionId, assistantTextBuffer);
            }
            const pendingSnapshotUserText = this.pendingSnapshotUserTextBySession.get(sessionId);
            if (pendingSnapshotUserText !== undefined) {
                retainedPendingSnapshotUserTextBySession.set(sessionId, pendingSnapshotUserText);
            }
        }
        this.client.resetSessionState({ preserveInFlightSessionIds: retainedSendInFlightBySession });
        this.clientMessageIdMap.clear();
        this.revertedSegment = undefined;
        this.revertedSegmentHistory = [];
        this.pendingConflict = undefined;
        this.pendingClientMessageId = undefined;
        this.lastDraft = undefined;
        this.draftByLocalKey.clear();
        this.appendSubmitInFlightBySession.clear();
        this.pendingBaselineTurnKey = undefined;
        this.currentDiffFilePath = null;
        this.diffHashes.clear();
        this.shownDiffKeysBySession.clear();
        this.uiTimelineBySession.clear();
        this.assistantTextBufferBySession.clear();
        this.pendingSnapshotUserTextBySession.clear();
        this.pendingAssistantTmpKeyBySession.clear();
        this.pendingAssistantTmpKeyByLocalKey.clear();
        this.pendingLocalKeyBySession.clear();
        this.pendingAssistantMessageIdBySession.clear();
        this.rawUserTextByLocalKey.clear();
        this.rawUserTextByMsgId.clear();
        this.sendInFlightBySession.clear();
        for (const sessionId of retainedSendInFlightBySession) {
            this.sendInFlightBySession.add(sessionId);
        }
        let retainedProviderTurnBindingSessions = 0;
        for (const sessionId of retainedSendInFlightBySession) {
            if (typeof sessionId !== 'string' || !sessionId) continue;
            let restored = false;
            const pendingLocalKey = retainedPendingLocalKeyBySession.get(sessionId);
            if (pendingLocalKey) {
                this.pendingLocalKeyBySession.set(sessionId, pendingLocalKey);
                restored = true;
            }
            const tmpKey = retainedPendingAssistantTmpKeyBySession.get(sessionId);
            if (tmpKey) {
                this.pendingAssistantTmpKeyBySession.set(sessionId, tmpKey);
                restored = true;
            }
            const assistantMessageId = retainedPendingAssistantMessageIdBySession.get(sessionId);
            if (assistantMessageId) {
                this.pendingAssistantMessageIdBySession.set(sessionId, assistantMessageId);
                restored = true;
            }
            const assistantTextBuffer = retainedAssistantTextBufferBySession.get(sessionId);
            if (assistantTextBuffer !== undefined) {
                this.assistantTextBufferBySession.set(sessionId, assistantTextBuffer);
                restored = true;
            }
            const pendingSnapshotUserText = retainedPendingSnapshotUserTextBySession.get(sessionId);
            if (pendingSnapshotUserText !== undefined) {
                this.pendingSnapshotUserTextBySession.set(sessionId, pendingSnapshotUserText);
                restored = true;
            }
            if (restored) retainedProviderTurnBindingSessions += 1;
        }
        for (const [localKey, rawUserText] of retainedRawUserTextByLocalKey) {
            this.rawUserTextByLocalKey.set(localKey, rawUserText);
        }
        for (const [localKey, tmpKey] of retainedPendingAssistantTmpKeyByLocalKey) {
            this.pendingAssistantTmpKeyByLocalKey.set(localKey, tmpKey);
        }
        if (retainedSendInFlightBySession.size) {
            this.uiDebugChannel.appendLine(`[EXT][APPEND_RETAIN] preserved sendInFlight sessions=${retainedSendInFlightBySession.size} reason=ui-reset`);
        }
        if (retainedProviderTurnBindingSessions) {
            this.uiDebugChannel.appendLine(`[EXT][APPEND_RETAIN] preserved turnBinding sessions=${retainedProviderTurnBindingSessions} reason=ui-reset`);
        }
    }

    private resetUiState(sessionId?: string): void {
        this.resetSessionState();
        if (this._view) {
            this._view.webview.postMessage({ type: 'resetUiState', sessionId: sessionId || '' });
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

    private postAddResponse(webview: vscode.Webview, value: string, meta?: { operationId?: string; sessionId?: string }): void {
        const targetSessionId = meta?.sessionId || this.currentSessionId;
        const messageId = this.client.createInternalMessageId('assistant', targetSessionId);
        const messageIndex = this.client.registerMessage(messageId, targetSessionId);
        const liveWebview = this._view?.webview || webview;
        liveWebview.postMessage({
            type: 'addResponse',
            value,
            messageId,
            messageIndex,
            sessionId: targetSessionId,
            operationId: meta?.operationId,
            meta
        });
    }

    private postMessageIndexMap(webview: vscode.Webview, sessionId?: string): void {
        const map = this.client.getMessageIndexMap(sessionId || this.currentSessionId);
        const liveWebview = this._view?.webview || webview;
        liveWebview.postMessage({
            type: 'messageIndexMap',
            map,
            sessionId: sessionId || this.currentSessionId
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview, hardRescueGenerationToken = '') {
        const styleResetUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "reset.css")
        );
        const styleVSCodeUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "vscode.css")
        );
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "main.js")
        );
        const renderingScriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "rendering.bundle.js")
        );
        const featureScriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "features.bundle.js")
        );
        const undoScriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "undo.bundle.js")
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
        const escapedHardRescueGenerationToken = hardRescueGenerationToken
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="opencode-hard-rescue-generation" content="${escapedHardRescueGenerationToken}">
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
                        <button class="icon-btn" id="search-btn" title="Search current session" aria-label="Search current session">
                            <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM1.5 7a5.5 5.5 0 1 1 9.77 3.47l3.13 3.13-.8.8-3.13-3.13A5.5 5.5 0 0 1 1.5 7z"/></svg>
                        </button>
                    </div>
                </div>

                <div class="session-search-bar hidden" id="session-search-bar">
                    <input class="session-search-input" id="session-search-input" type="search" placeholder="Search session..." autocomplete="off" spellcheck="false" />
                    <span class="session-search-count" id="session-search-count">0/0</span>
                    <button class="session-search-smart" id="session-search-smart" type="button" title="Semantic search with a free model">Smart</button>
                    <button class="icon-btn session-search-nav" id="session-search-prev" title="Previous match" aria-label="Previous match">
                        <svg width="14" height="14" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M8 2.5 3.5 7l.7.7L7.5 4.4V14h1V4.4l3.3 3.3.7-.7L8 2.5z"/></svg>
                    </button>
                    <button class="icon-btn session-search-nav" id="session-search-next" title="Next match" aria-label="Next match">
                        <svg width="14" height="14" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M8 13.5 12.5 9l-.7-.7-3.3 3.3V2h-1v9.6L4.2 8.3l-.7.7L8 13.5z"/></svg>
                    </button>
                    <button class="icon-btn session-search-close" id="session-search-close" title="Close search" aria-label="Close search">
                        <svg width="14" height="14" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06z"/></svg>
                    </button>
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

                <div class="chat-scroll-shell">
                    <div class="chat-area" id="chat"></div>
                    <button class="chat-jump-bottom hidden" id="chat-jump-bottom" type="button" title="Jump to latest message" aria-label="Jump to latest message">
                        <svg width="18" height="18" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="currentColor" aria-hidden="true">
                            <path d="M7.5 2h1v9.6l3.3-3.3.7.7-4.5 4.5L3.5 9l.7-.7 3.3 3.3V2z"/>
                        </svg>
                    </button>
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

                <script src="${renderingScriptUri}"></script>
                <script src="${featureScriptUri}"></script>
                <script src="${undoScriptUri}"></script>
                <script src="${scriptUri}"></script>
            </body>
            </html>`;
    }
}
