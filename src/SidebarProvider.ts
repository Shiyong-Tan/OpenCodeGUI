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
import { handleSidebarChatEvent } from './events/SidebarChatEventHandler';
import { initializeSidebarSession } from './history/SidebarSessionInitializer';
import {
    resolveSidebarWebviewView,
    type SidebarWebviewDependencies,
} from './webview/SidebarWebviewController';
import {
    createUtilityCommandHandler,
    type UtilityCommandHandler,
} from './webview/controllers/UtilityCommandController';
import {
    createSessionCommandHandler,
    type SessionCommandHandler,
} from './webview/controllers/SessionCommandController';
import {
    createTurnCommandHandler,
    type TurnCommandHandler,
} from './webview/controllers/TurnCommandController';
import {
    createUndoCommandHandler,
    type UndoCommandHandler,
} from './webview/controllers/UndoCommandController';
import {
    createWebviewLifecycleController,
    type WebviewLifecycleController,
} from './webview/controllers/WebviewLifecycleController';
import {
    captureCancelTurnOwner,
    type CapturedCancelTurnOwner,
} from './webview/CancelTurnOwner';
import type { SmartSearchMessage } from './search/SmartSearchService';
import { injectChangeListRecords, type ChangeListRecord, type SessionMessage } from './changes/ChangeListInjection';
import { ChangeListStore } from './changes/ChangeListStore';
import { DiffFileViewer } from './changes/DiffFileViewer';
import { ChangeListEmitter } from './changes/ChangeListEmitter';
import { hydrateUndoSegments, serializeUndoSegments, type SegmentState } from './undo/UndoSegmentPersistence';
import { resolveUndoUiVisibleRange, sanitizeUndoRangeMessageIds } from './undo/UndoRangeResolver';
import {
    buildFullExportSnapshotDelta as planFullExportSnapshotDelta,
    classifyRecentAppendCandidates as classifySnapshotAppendCandidates,
    computeRecentVisibleAppend as planRecentVisibleAppend,
    getMaxMessageIndex as findMaxMessageIndex,
    getSnapshotTimelineIds as deriveSnapshotTimelineIds,
} from './history/SnapshotDeltaPlanner';
import { SnapshotStore } from './history/SnapshotStore';
import { createForkSnapshotPayload, normalizeForkOrigin } from './history/ForkSnapshotBoundary';
import { AppendSnapshotMetaStore, type AppendSnapshotMetaRoot } from './continuation/AppendSnapshotMetaStore';
import {
    buildFinalizeTurnIdentity as resolveFinalizeTurnIdentity,
    type FinalizeTurnIdentity,
} from './continuation/TurnIdentityResolver';
import { TurnFinalizationCoordinator } from './continuation/TurnFinalizationCoordinator';
import { ActiveTurnTracker, type ActiveTurnSnapshot as WebviewLivenessActiveTurnSnapshot } from './continuation/ActiveTurnTracker';
import {
    classifyTurnShadowDivergences,
    TurnRuntimeShadow,
    type TurnShadowObservation,
} from './session-runtime/turn/TurnRuntimeShadow';
import { ChatEventActorRouter } from './session-runtime/ChatEventActorRouter';
import { PendingConflictStore, type PendingConflict } from './session-runtime/PendingConflictStore';
import {
    RevertedSegmentHistoryStore,
    type RevertedSegmentHistoryEntry,
} from './session-runtime/RevertedSegmentHistoryStore';
import {
    captureAutomaticEditorContext,
    collectOpenWorkspaceFileRanks,
    getOpenWorkspaceFileUris,
    workspaceFileKey,
} from './context/EditorContextService';
import { WorkspaceLexiconService } from './context/WorkspaceLexiconService';

type CanceledTurnRecord = {
    opId?: string;
    localKey?: string;
    userMsgId?: string;
    assistantMsgId?: string;
    userMessageIds?: string[];
    assistantMessageIds?: string[];
    textHash?: string;
    canceledAt: number;
};

type WorkspaceFileResult = {
    path: string;
    name: string;
    directory: string;
};

type AppendSnapshotTurnState = {
    rootUserMessageId?: string;
    orderedIds: string[];
    messagesById: Map<string, SessionMessage>;
    preparedGenerations: Set<number>;
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
    private autoEditorContextTimer?: NodeJS.Timeout;
    private readonly workspaceLexicon = new WorkspaceLexiconService();
    private task1DoneVisibleTotalMs = 0;
    private task1DoneVisibleCount = 0;
    private task1FalseDoneEvents = 0;
    private appendSubmitInFlightBySession = new Set<string>();
    private readonly appendSnapshotMetaStore: AppendSnapshotMetaStore;
    private readonly turnFinalizationCoordinator: TurnFinalizationCoordinator;

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
            this.client.setRevertedSegment(sessionId, undefined);
            return;
        }
        const activeSegments = Array.from(segMap.values())
            .filter((seg) => seg.restoreAllowed === true)
            .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
        const seg = activeSegments[0];
        if (!seg) {
            this.client.setRevertedSegment(sessionId, undefined);
            return;
        }
        const memberMsgIds = Array.isArray(seg.memberMsgIds)
            ? seg.memberMsgIds.filter((id) => typeof id === 'string' && id.startsWith('msg_'))
            : [];
        const startMessageId = seg.anchorMsgId || memberMsgIds[0] || '';
        const endMessageId = seg.endMsgId || memberMsgIds[memberMsgIds.length - 1] || startMessageId;
        const startMessageIndex = this.client.getMessageIndex(startMessageId, sessionId);
        const endMessageIndex = this.client.getMessageIndex(endMessageId, sessionId);
        this.client.setRevertedSegment(sessionId, {
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
        const startMessageId = this.client.getRevertedSegment(sessionId)?.startMessageId;
        if (!startMessageId) return;

        const noticeKey = `system:undo:${startMessageId}`;
        const stored = this.undoSegmentsBySession.get(sessionId)?.get(noticeKey);
        if (stored?.restoreAllowed === false) {
            this.client.setRevertedSegment(sessionId, undefined);
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
        await this.turnFinalizationCoordinator.finalize(sessionId, webview, assistantMsgId);
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
    private draftByLocalKey = new Map<string, { text: string; attachments: string[]; model?: string; variant?: string; mode?: string }>();
    private currentDiffFilePath: string | null = null;
    private diffHashes = new Map<string, { before: string; after: string }>();
    private shownDiffKeysBySession = new Map<string, Set<string>>();
    private postFinalWatchDiffFocusedBySession = new Set<string>();
    private clientMessageIdMap = new Map<string, string>();
    private readonly revertedSegmentHistoryStore = new RevertedSegmentHistoryStore();
    private readonly pendingConflictStore = new PendingConflictStore();
    private uiDebugChannel!: vscode.OutputChannel;
    private undoSegmentsBySession: Map<string, Map<string, SegmentState>> = new Map();
    private readonly UNDO_SEGMENTS_KEY = 'opencode.undoSegmentsBySession.v1';
    private readonly USER_OWNED_SESSIONS_KEY = 'opencode.userOwnedSessionIds.v1';
    private pendingAssistantTmpKeyBySession = new Map<string, string>();
    private pendingAssistantTmpKeyByLocalKey = new Map<string, string>();
    private pendingLocalKeyBySession = new Map<string, string>();
    private turnCommandOwnerBySession = new Map<string, string>();
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
    private readonly utilityCommandHandler: UtilityCommandHandler;
    private readonly sessionCommandHandler: SessionCommandHandler;
    private readonly turnCommandHandler: TurnCommandHandler;
    private readonly undoCommandHandler: UndoCommandHandler;
    private readonly webviewLifecycleController: WebviewLifecycleController;
    private readonly sidebarWebviewDependencies: SidebarWebviewDependencies;
    private uiTimelineBySession = new Map<string, string[]>();
    private lastSnapshotPayloadBySession = new Map<string, any>();
    private readonly sessionTitleOverrideBySession = new Map<string, string>();
    private snapshotStore?: SnapshotStore;
    private changeListStore?: ChangeListStore;
    private readonly diffFileViewer: DiffFileViewer;
    private readonly changeListEmitter: ChangeListEmitter;
    private assistantTextBufferBySession = new Map<string, string>();
    private assistantTextBufferByMessageIdBySession = new Map<string, Map<string, string>>();
    private pendingSnapshotUserTextBySession = new Map<string, string>();
    private pendingSnapshotAttachmentsBySession = new Map<string, SavedAttachment[]>();
    private appendSnapshotTurnStateBySession = new Map<string, AppendSnapshotTurnState>();
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
    private readonly activeTurnTracker: ActiveTurnTracker;
    private readonly turnRuntimeShadow: TurnRuntimeShadow;
    private readonly chatEventActorRouter: ChatEventActorRouter;
    private readonly lastTurnShadowDivergenceBySession = new Map<string, string>();
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
        return this.activeTurnTracker.describe(sessionId);
    }

    private markWebviewActiveTurnUpdated(sessionId: string | undefined, source: string): void {
        if (!sessionId) return;
        this.activeTurnTracker.mark(sessionId);
        this.uiDebugChannel?.appendLine(`EXT: webviewAutoRescue.activeTurn.mark | source=${source} | sessionId=${sessionId} | ${this.describeWebviewLivenessFlags(sessionId)}`);
    }

    private getWebviewLivenessActiveTurnFlags(sessionId: string | undefined): WebviewLivenessActiveTurnSnapshot {
        return this.activeTurnTracker.snapshot(sessionId);
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
        const assistantMessageId = this.client.getTurnAssistantMsgId(sessionId)
            || this.pendingAssistantMessageIdBySession.get(sessionId)
            || undefined;
        const assistantText = this.getAssistantTextBuffer(sessionId, assistantMessageId);
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
            this.turnCommandOwnerBySession.delete(sessionId);
            this.logWebviewAutoRescueActiveTurnCleanup('activeTurnCleanupSkipped', sessionId, before, 'already-inactive');
            return;
        }
        this.sendInFlightBySession.delete(sessionId);
        this.turnCommandOwnerBySession.delete(sessionId);
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

    private beginWebviewLifecycleResolution(webviewView: vscode.WebviewView): string {
        this._view = webviewView;
        const panelId = `panel-${++this.webviewLivenessPanelSeq}`;
        this.resetWebviewLiveness('webview-recreate');
        this.uiDebugChannel.appendLine(`EXT: webviewLiveness.panel | phase=resolve | panelId=${panelId}`);
        this.uiDebugChannel.appendLine(`EXT: webviewReload.external-unobservable | reason=vscode-developer-reload-webviews-command-not-interceptable | observablePoints=resolve,handshake,dispose | panelId=${panelId} | previousWebviewInstanceId=${this._webviewInstanceId || 'null'} | reload=false | recreate=false | sessionMutation=false`);
        this.uiDebugChannel.appendLine(`EXT: webviewReload.expected-new-webview | phase=resolve | panelId=${panelId} | previousWebviewInstanceId=${this._webviewInstanceId || 'null'} | reload=false | recreate=false | sessionMutation=false`);
        return panelId;
    }

    private getLifecycleActiveWebview(fallback?: vscode.Webview): vscode.Webview | undefined {
        return this._view?.webview || fallback;
    }

    private prepareWebviewReady(
        data: any,
        webviewView: vscode.WebviewView,
        panelId: string
    ): {
        accepted: boolean;
        pending?: WebviewHardRescuePending;
        newWebviewInstanceId: string;
        hardRescueGuard?: () => boolean;
    } {
        const pending = this.webviewHardRescuePending;
        const newWebviewInstanceId = typeof data?.webviewInstanceId === 'string'
            ? data.webviewInstanceId.trim()
            : '';
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
                return { accepted: false, pending, newWebviewInstanceId };
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
                return { accepted: false, newWebviewInstanceId };
            }
            if (!newWebviewInstanceId) {
                this.uiDebugChannel.appendLine(`EXT: webviewReload.handshake.rejected | reason=missing-webview-instance-id | panelId=${panelId}`);
                return { accepted: false, newWebviewInstanceId };
            }
            this._view = webviewView;
            this._webviewInstanceId = newWebviewInstanceId;
            ++this.webviewHandshakeLifecycle;
        }
        this.webviewLivenessCurrent = undefined;
        this.uiDebugChannel.appendLine(`[EXT][HANDSHAKE_1_RX] webviewReady | wvId=${this._webviewInstanceId}`);
        this.uiDebugChannel.appendLine(`EXT: webviewReload.handshake.observed | phase=webviewReady | panelId=${panelId} | webviewInstanceId=${this._webviewInstanceId || 'null'} | previousWebviewInstanceId=${data?.previousWebviewInstanceId || 'unknown'} | reload=false | recreate=false | sessionMutation=false`);
        return { accepted: true, pending, newWebviewInstanceId, hardRescueGuard };
    }

    private getLifecycleInitPosted(): boolean {
        return this.initPosted;
    }

    private completeWebviewHardRescueSuccess(pending: WebviewHardRescuePending): void {
        if (pending.timeout) clearTimeout(pending.timeout);
        pending.timeout = undefined;
        if (this.webviewHardRescuePending === pending) {
            this.webviewHardRescuePending = undefined;
        }
        this.uiDebugChannel.appendLine(`EXT: webviewHardRescue.complete | generationToken=${pending.generationToken} | sessionId=${pending.sessionId} | panelId=${pending.panelId} | rescueAttemptId=${pending.rescueAttemptId} | oldWebviewInstanceId=${pending.oldWebviewInstanceId || 'null'} | newWebviewInstanceId=${pending.newWebviewInstanceId || 'null'} | elapsedMs=${Date.now() - pending.startedAt} | initSucceeded=true | webviewReadyAckPosted=true`);
    }

    private handleWebviewLifecycleVisibility(webviewView: vscode.WebviewView): void {
        if (webviewView.visible && this.initPosted) {
            this.initPosted = false;
            this.uiDebugChannel.appendLine('[EXT][INIT_RESET] Webview visible after hidden, resetting initPosted');
            this.startWebviewLivenessProbes();
            void this.triggerWebviewLivenessProbe('visibility-visible');
        } else if (!webviewView.visible) {
            this.stopWebviewLivenessProbes('visibility-hidden');
        }
    }

    private handleWebviewLifecycleDispose(panelId: string): void {
        this.uiDebugChannel.appendLine(`EXT: webviewReload.dispose.begin | panelId=${panelId} | webviewInstanceId=${this._webviewInstanceId || 'null'} | reload=false | recreate=false | sessionMutation=false`);
        this.stopWebviewLivenessProbes('webview-dispose');
        this.uiDebugChannel.appendLine(`EXT: webviewReload.dispose.done | panelId=${panelId} | webviewInstanceId=${this._webviewInstanceId || 'null'} | reload=false | recreate=false | sessionMutation=false`);
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
        const sameSession = !data?.sessionId || data.sessionId === record?.sessionId;
        const samePanel = !data?.panelId || data.panelId === record?.panelId;
        const sameWebview = !data?.webviewInstanceId || data.webviewInstanceId === record?.webviewInstanceId;
        if (!record || record.token !== token || !sameSession || !samePanel || !sameWebview || !this.isCurrentWebviewLivenessRecord(record)) {
            this.uiDebugChannel.appendLine(`EXT: webviewLiveness.ack.drop | reason=stale-or-mismatch | pingId=${pingId || 'null'} | token=${token || 'null'} | currentToken=${record?.token || 'none'} | currentPingId=${record?.pingId || 'none'} | sessionId=${data?.sessionId || 'null'}`);
            return;
        }
        const lateSameToken = record.pingId !== pingId;
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
        this.uiDebugChannel.appendLine(`EXT: webviewLiveness.ack | panelId=${record.panelId} | sessionId=${record.sessionId} | token=${record.token} | pingId=${pingId} | currentPingId=${record.pingId || 'none'} | classification=${lateSameToken ? 'late-same-token' : 'exact'} | rttMs=${record.pingSentAt ? record.ackAt - record.pingSentAt : -1}`);
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

    private noteWebviewLivenessActivity(
        data: any,
        webviewView: vscode.WebviewView,
        panelId: string
    ): void {
        const type = typeof data?.type === 'string' ? data.type : 'unknown';
        if (
            type === 'webviewLivenessAck'
            || type === 'webviewAutoRescueAck'
            || type === 'webviewReady'
            || type === 'ui-debug'
        ) return;
        const record = this.webviewLivenessCurrent;
        if (
            !record
            || this._view !== webviewView
            || record.panelId !== panelId
            || !this.isCurrentWebviewLivenessRecord(record)
        ) {
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
        this.uiDebugChannel.appendLine(
            `EXT: webviewLiveness.activity | panelId=${record.panelId} | sessionId=${record.sessionId} | ` +
            `token=${record.token} | type=${type} | pingId=${record.pingId || 'none'} | ` +
            `ageMs=${record.pingSentAt ? record.ackAt - record.pingSentAt : -1}`
        );
        const promptMeta = record.notificationToken
            ? this.webviewAutoRescuePromptMetaByNotificationToken.get(record.notificationToken)
            : undefined;
        if (promptMeta && !promptMeta.handled && !promptMeta.expired) {
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
        return this.getSnapshotStore().getFile(sessionId);
    }

    private getSnapshotStore(): SnapshotStore {
        if (!this.snapshotStore) {
            this.snapshotStore = new SnapshotStore({
                getDirectory: () => this.getSnapshotDir(),
                ensureDir: (directory) => this.ensureDir(directory),
            });
        }
        return this.snapshotStore;
    }

    private applySessionTitleOverride(sessionId: string, sessionData: any): any {
        const titleOverride = this.sessionTitleOverrideBySession.get(sessionId);
        if (!titleOverride || !sessionData || typeof sessionData !== 'object') return sessionData;
        return { ...sessionData, title: titleOverride };
    }

    private cacheSnapshotPayload(sessionId: string, sessionData: any): void {
        this.lastSnapshotPayloadBySession.set(
            sessionId,
            this.applySessionTitleOverride(sessionId, sessionData)
        );
    }

    private async writeSnapshotAtomic(sessionId: string, payloadObj: unknown): Promise<number> {
        let payload = payloadObj;
        if (payloadObj && typeof payloadObj === 'object') {
            const source = payloadObj as Record<string, any>;
            if (source.sessionData && typeof source.sessionData === 'object') {
                payload = {
                    ...source,
                    sessionData: this.applySessionTitleOverride(sessionId, source.sessionData),
                };
            }
        }
        return this.getSnapshotStore().writeAtomic(sessionId, payload);
    }

    private async readSnapshot(sessionId: string): Promise<{ obj: any; bytes: number } | null> {
        return this.getSnapshotStore().read(sessionId);
    }

    private async persistSessionTitle(sessionId: string, title: string): Promise<void> {
        const normalizedTitle = title.trim();
        if (!sessionId || !normalizedTitle) return;
        this.sessionTitleOverrideBySession.set(sessionId, normalizedTitle);
        const existing = await this.readSnapshot(sessionId);
        if (!existing?.obj?.sessionData) {
            this.uiDebugChannel.appendLine(
                `[EXT][SESSION_RENAME_SNAPSHOT_SKIP] sessionId=${sessionId} reason=no-snapshot`
            );
            return;
        }
        const snapshotObj = {
            ...existing.obj,
            exportedAt: Date.now(),
            sessionData: {
                ...existing.obj.sessionData,
                title: normalizedTitle,
            },
        };
        const bytes = await this.writeSnapshotAtomic(sessionId, snapshotObj);
        this.cacheSnapshotPayload(sessionId, snapshotObj.sessionData);
        this.uiDebugChannel.appendLine(
            `[EXT][SESSION_RENAME_SNAPSHOT] sessionId=${sessionId} bytes=${bytes}`
        );
    }

    private async initializeForkSnapshot(sourceSessionId: string, childSessionId: string): Promise<void> {
        const sourceSnapshot = await this.readSnapshot(sourceSessionId);
        let parentTitle = typeof sourceSnapshot?.obj?.sessionData?.title === 'string'
            ? sourceSnapshot.obj.sessionData.title.trim()
            : '';
        let childTitle = '';
        try {
            const [sourceRecent, childRecent] = await Promise.all([
                this.client.exportSessionRecent(sourceSessionId, 1),
                this.client.exportSessionRecent(childSessionId, 1),
            ]);
            const sourceFormatted = this.formatSession(sourceRecent);
            const childFormatted = this.formatSession(childRecent);
            if (sourceFormatted.title?.trim()) parentTitle = sourceFormatted.title.trim();
            if (childFormatted.title?.trim()) childTitle = childFormatted.title.trim();
        } catch (error) {
            this.uiDebugChannel.appendLine(
                `[EXT][SESSION_FORK_SNAPSHOT_TITLE_FALLBACK] sourceSessionId=${sourceSessionId} childSessionId=${childSessionId} err=${String(error)}`
            );
        }
        const payload = createForkSnapshotPayload({
            childSessionId,
            parentSessionId: sourceSessionId,
            parentTitle: parentTitle || 'Parent session',
            childTitle: childTitle || undefined,
        });
        const bytes = await this.writeSnapshotAtomic(childSessionId, payload);
        const sessionData = (payload as { sessionData: Record<string, unknown> }).sessionData;
        this.cacheSnapshotPayload(childSessionId, sessionData);
        this.uiTimelineBySession.set(childSessionId, []);
        this.uiDebugChannel.appendLine(
            `[EXT][SESSION_FORK_SNAPSHOT_INIT] sourceSessionId=${sourceSessionId} childSessionId=${childSessionId} messages=0 timeline=0 bytes=${bytes}`
        );
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
        const canceledUserIds = new Set(canceled.flatMap((item) => [
            item.userMsgId,
            ...(Array.isArray(item.userMessageIds) ? item.userMessageIds : []),
        ]).filter((id): id is string => typeof id === 'string' && id.length > 0));
        const canceledAssistantIds = new Set(canceled.flatMap((item) => [
            item.assistantMsgId,
            ...(Array.isArray(item.assistantMessageIds) ? item.assistantMessageIds : []),
        ]).filter((id): id is string => typeof id === 'string' && id.length > 0));
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
        const existing = await this.readSnapshot(sessionId);
        const forkOrigin = normalizeForkOrigin(existing?.obj?.sessionData?.meta?.forkOrigin);
        const sessionData = await this.buildSnapshotSessionPayload({
            type: 'sessionData',
            sessionId,
            title,
            messages,
            segments,
            meta: {
                timelineMessageIds,
                ...(forkOrigin ? { forkOrigin } : {})
            }
        });
        const snapshotObj = { sessionId, exportedAt: Date.now(), sessionData };
        const bytes = await this.writeSnapshotAtomic(sessionId, snapshotObj);
        this.cacheSnapshotPayload(sessionId, sessionData);
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
        this.cacheSnapshotPayload(sessionId, payload);
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
        return this.appendSnapshotMetaStore.sanitizeItems(items);
    }

    private sanitizeAppendSnapshotMetaPayload(payload: any): Map<string, AppendSnapshotMetaRoot> {
        return this.appendSnapshotMetaStore.sanitizePayload(payload);
    }

    private cacheAppendSnapshotMeta(payload: any): void {
        this.appendSnapshotMetaStore.cache(payload);
    }

    private applyAppendSnapshotMeta(sessionId: string, messagesById: Map<string, SessionMessage>): number {
        return this.appendSnapshotMetaStore.apply(sessionId, messagesById);
    }

    private async appendSnapshotIncremental(
        sessionId: string,
        timelineIds: string[],
        incomingMessages: SessionMessage[],
        title?: string,
        excludeMessageIds: ReadonlySet<string> = new Set<string>()
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
            ? snapshotObj.sessionData.messages.filter((message: SessionMessage) => (
                typeof message?.id !== 'string' || !excludeMessageIds.has(message.id)
            ))
            : [];
        const canonicalExistingMessages = this.canonicalizeSnapshotMessagesForCurrentOwner(sessionId, existingMessages, ownershipMap);
        const normalizedExisting = this.normalizeSnapshotStoredMessages(canonicalExistingMessages);
        const existingTimelineRaw = this.getSnapshotTimelineIds(snapshotObj.sessionData, normalizedExisting);
        const existingTimeline = Array.from(new Set(existingTimelineRaw.filter((id): id is string => (
            typeof id === 'string' && Boolean(id) && !excludeMessageIds.has(id)
        ))));
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
        // Finalization may revisit an assistant record that was already captured while
        // the turn was active. Keep the immutable visible content, but allow the
        // extension-owned processing timestamps to complete that same record.
        for (const incoming of canonicalIncomingMessages) {
            if (incoming?.role !== 'assistant' || typeof incoming.id !== 'string' || !incoming.id) continue;
            const existingMessage = combinedById.get(incoming.id);
            if (!existingMessage || existingMessage.role !== 'assistant') continue;
            const processingStartedAt = incoming.meta?.processingStartedAt;
            const processingCompletedAt = incoming.meta?.processingCompletedAt;
            const processingPausedAt = incoming.meta?.processingPausedAt;
            const processingPausedMs = incoming.meta?.processingPausedMs;
            const timingMeta: Record<string, unknown> = {
                ...(typeof processingStartedAt === 'number' && Number.isFinite(processingStartedAt) && processingStartedAt > 0
                    ? { processingStartedAt }
                    : {}),
                ...(typeof processingCompletedAt === 'number' && Number.isFinite(processingCompletedAt) && processingCompletedAt > 0
                    ? { processingCompletedAt }
                    : {}),
                ...(typeof processingPausedAt === 'number' && Number.isFinite(processingPausedAt) && processingPausedAt > 0
                    ? { processingPausedAt }
                    : {}),
                ...(typeof processingPausedMs === 'number' && Number.isFinite(processingPausedMs) && processingPausedMs >= 0
                    ? { processingPausedMs }
                    : {})
            };
            if (!Object.keys(timingMeta).length) continue;
            combinedById.set(incoming.id, {
                ...existingMessage,
                meta: { ...(existingMessage.meta || {}), ...timingMeta }
            });
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
        this.cacheSnapshotPayload(sessionId, snapshotObj.sessionData);
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

    private async writeFinalizeSnapshotFromCurrentTurn(identity: FinalizeTurnIdentity, title?: string): Promise<void> {
        const sessionId = identity?.sessionId;
        if (!sessionId) return;
        try {
            await this.writeFinalizeSnapshotFromCurrentTurnIncremental(identity, title);
        } finally {
            this.pendingSnapshotUserTextBySession.delete(sessionId);
            this.pendingSnapshotAttachmentsBySession.delete(sessionId);
            this.clearAssistantTextBuffers(sessionId);
            this.appendSnapshotTurnStateBySession.delete(sessionId);
        }
    }

    private async writeFinalizeSnapshotFromCurrentTurnIncremental(
        identity: FinalizeTurnIdentity,
        title?: string
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
                this.client.getTurnAssistantMsgId(sessionId),
                this.pendingAssistantMessageIdBySession.get(sessionId)
            ].find((id) => this.isResolvableMessageId(id));
            const rawUserText = (userMessageId ? this.rawUserTextByMsgId.get(userMessageId) : undefined)
                ?? this.pendingSnapshotUserTextBySession.get(sessionId)
                ?? (pendingLocalKey ? this.rawUserTextByLocalKey.get(pendingLocalKey) : undefined)
                ?? (pendingLocalKey ? this.draftByLocalKey.get(pendingLocalKey)?.text : undefined)
                ?? '';
            const userText = this.normalizeUserTextForSnapshot(rawUserText);
            const persistedAttachments = this.pendingSnapshotAttachmentsBySession.get(sessionId) || [];
            const userAttachmentMeta = persistedAttachments.length > 0 ? {
                attachments: persistedAttachments.map((attachment) => ({
                    filename: attachment.filename,
                    mime: attachment.mime,
                    sizeBytes: attachment.sizeBytes,
                    path: attachment.relPath,
                })),
                images: persistedAttachments
                    .filter((attachment) => this.attachmentStorage.isImageFileName(attachment.filename))
                    .map((attachment) => attachment.relPath),
            } : undefined;
            const assistantText = this.getAssistantTextBuffer(sessionId, assistantMessageId) || '';
            const appendState = this.appendSnapshotTurnStateBySession.get(sessionId);
            const pendingMessages: SessionMessage[] = [];
            const pendingIds = new Set<string>();
            const addPendingMessage = (message: SessionMessage | undefined) => {
                if (!message || typeof message.id !== 'string' || !message.id || pendingIds.has(message.id)) return;
                pendingMessages.push(message);
                pendingIds.add(message.id);
            };
            for (const id of appendState?.orderedIds || []) {
                const stagedMessage = appendState?.messagesById.get(id);
                // A finalized snapshot mirrors the visible conversation. Append
                // handoffs may retain predecessor assistant stages in memory so
                // the live presentation can transition safely, but those stages
                // are not separate visible messages once the successor is final.
                if (stagedMessage?.role === 'user') addPendingMessage(stagedMessage);
            }
            if (userMessageId && userText && !this.isHiddenControlUserText(userText)) {
                addPendingMessage({
                    role: 'user',
                    id: userMessageId,
                    text: userText,
                    messageIndex: this.client.getMessageIndex(userMessageId, sessionId),
                    ...(userAttachmentMeta ? { meta: userAttachmentMeta } : {})
                });
            }
            if (assistantMessageId && assistantText && !this.isHiddenControlAssistantText(assistantText)) {
                const processingStartedAt = this.client.getCurrentTurnStartedAt(sessionId);
                const processingCompletedAt = this.client.getCurrentTurnCompletedAt(sessionId);
                const processingPausedAt = this.client.getCurrentTurnProcessingPausedAt(sessionId);
                const processingPausedMs = this.client.getCurrentTurnProcessingPausedMs(sessionId);
                const assistantMeta: Record<string, unknown> = {
                    ...(identity.latestAppendUserMessageId
                        ? { parentID: identity.latestAppendUserMessageId }
                        : {}),
                    ...(processingStartedAt !== undefined ? { processingStartedAt } : {}),
                    ...(processingCompletedAt !== undefined ? { processingCompletedAt } : {}),
                    ...(processingPausedAt !== undefined ? { processingPausedAt } : {}),
                    ...(processingPausedMs > 0 ? { processingPausedMs } : {})
                };
                addPendingMessage({
                    role: 'assistant',
                    id: assistantMessageId,
                    text: assistantText,
                    messageIndex: this.client.getMessageIndex(assistantMessageId, sessionId),
                    ...(Object.keys(assistantMeta).length ? { meta: assistantMeta } : {})
                });
            }
            if (!pendingMessages.length) {
                this.uiDebugChannel.appendLine(
                    `[EXT][SNAPSHOT_ROUTE] reason=finalize-incremental-skip source=current-turn sessionId=${sessionId} userMessageId=${userMessageId || 'null'} assistantMessageId=${assistantMessageId || 'null'} userTextLength=${userText.length} assistantTextLength=${assistantText.length} detail=no-canonical-visible-records`
                );
                return;
            }
            const existing = await this.readSnapshot(sessionId);
            const existingMessages: SessionMessage[] = Array.isArray(existing?.obj?.sessionData?.messages)
                ? existing.obj.sessionData.messages
                : [];
            const existingTimelineRaw = this.getSnapshotTimelineIds(existing?.obj?.sessionData, existingMessages);
            const supersededAssistantIds = new Set(
                this.client.getCurrentTurnAssistantMessageIds(sessionId)
                    .filter((id) => id !== assistantMessageId)
            );
            const timelineIds = Array.from(new Set([
                ...existingTimelineRaw.filter((id: unknown): id is string => typeof id === 'string' && Boolean(id)),
                ...pendingMessages.map((message) => message.id).filter((id): id is string => typeof id === 'string' && Boolean(id))
            ])).filter((id) => !supersededAssistantIds.has(id));
            const bytes = await this.appendSnapshotIncremental(
                sessionId,
                timelineIds,
                pendingMessages,
                title,
                supersededAssistantIds
            );
            this.uiTimelineBySession.set(sessionId, timelineIds);
            this.uiDebugChannel.appendLine(
                `[EXT][SNAPSHOT_ROUTE] reason=finalize-incremental-write source=current-turn sessionId=${sessionId} timelineCount=${timelineIds.length} messageCount=${pendingMessages.length} prunedSupersededAssistants=${supersededAssistantIds.size} userMessageId=${userMessageId || 'null'} assistantMessageId=${assistantMessageId || 'null'} bytes=${bytes}`
            );
        } catch (error) {
            this.uiDebugChannel.appendLine(
                `[EXT][SNAPSHOT_ROUTE] reason=finalize-incremental-error source=current-turn sessionId=${sessionId} err=${String(error)}`
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

    private async applyUtilityModelSelection(value: unknown, webview: vscode.Webview): Promise<void> {
        this.selectedModel = (value || undefined) as string | undefined;
        await this._context.globalState.update('opencode.model', this.selectedModel);
        await this.postModelQuota(webview, 'model-change');
    }

    private async applyUtilityModeSelection(value: unknown): Promise<void> {
        const requestedMode = typeof value === 'string' ? value : '';
        const mode = this.availableModes.includes(requestedMode)
            ? requestedMode
            : (this.availableModes[0] || 'plan');
        this.selectedMode = mode || undefined;
        await this._context.globalState.update('opencode.mode', this.selectedMode);
    }

    private async applyUtilityVariantSelection(value: unknown): Promise<void> {
        this.selectedVariant = (value || undefined) as string | undefined;
        await this._context.globalState.update('opencode.variant', this.selectedVariant);
    }

    private resolveUtilityLocalQuestion(
        callId: string,
        result: unknown
    ): { resolved: boolean; sessionId?: string } {
        const pending = callId ? this.pendingLocalQuestionRequests.get(callId) : undefined;
        if (!pending) return { resolved: false };
        this.pendingLocalQuestionRequests.delete(callId);
        const answer = result && typeof result === 'object' ? result as Record<string, unknown> : {};
        pending.resolve({
            selectedId: typeof answer.selectedId === 'string' ? answer.selectedId : undefined,
            selectedLabel: typeof answer.selectedLabel === 'string' ? answer.selectedLabel : undefined
        });
        return { resolved: true, sessionId: pending.sessionId };
    }

    private startSessionSelection(targetSessionId: string): number {
        this.resetWebviewLiveness('session-switch');
        return ++this.sessionSelectionEpoch;
    }

    private adoptSessionSelection(targetSessionId: string): void {
        this.resetUiState(targetSessionId);
        this.currentSessionId = targetSessionId;
        this.trackUserOwnedSession(targetSessionId);
        this.client.setSessionId(targetSessionId);
    }

    private isSessionSelectionCurrent(targetSessionId: string, selectionEpoch: number): boolean {
        return this.currentSessionId === targetSessionId
            && this.sessionSelectionEpoch === selectionEpoch;
    }

    private async persistRecentSessionSelection(sessionId: string | undefined): Promise<void> {
        const workspaceFolder = this.client.getWorkspaceRoot()
            || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceFolder) return;
        const workspaceKey = this.getWorkspaceKeyForRoot(workspaceFolder);
        await this._context.globalState.update(`recentSession.${workspaceKey}`, sessionId);
    }

    private async hydrateSessionUndoPresentation(
        sessionId: string,
        webview: vscode.Webview
    ): Promise<SegmentState[]> {
        await this.ensureSessionUndoReady(sessionId, webview);
        const persisted = await this.loadPersistedSegment(sessionId);
        if (persisted?.segment?.historySegments) {
            this.revertedSegmentHistoryStore.set(sessionId, persisted.segment.historySegments);
        } else {
            this.revertedSegmentHistoryStore.clearSession(sessionId);
        }
        if (persisted?.segment && persisted.segment.isActive === true && persisted.discarded !== true) {
            this.client.setRevertedSegment(sessionId, {
                isActive: true,
                discarded: false,
                startMessageId: persisted.segment.startMessageId || sessionId,
                startMessageIndex: persisted.segment.startMessageIndex ?? 0,
                endMessageId: persisted.segment.endMessageId || sessionId,
                endMessageIndex: persisted.segment.endMessageIndex
                    ?? (persisted.segment.startMessageIndex ?? 0),
                opIds: persisted.segment.opIds || [],
                collapsed: true,
                conflicts: persisted.conflicts || [],
                messageIds: persisted.segment.messageIds,
                operationId: persisted.segment.operationId
            });
        } else {
            this.client.setRevertedSegment(sessionId, undefined);
        }
        const segmentMap = this.undoSegmentsBySession.get(sessionId);
        this.syncClientRevertedSegmentFromUndoSegments(sessionId);
        return segmentMap ? Array.from(segmentMap.values()) : [];
    }

    private clearSelectedSessionAfterDelete(sessionId: string): void {
        if (this.currentSessionId !== sessionId) return;
        this.resetUiState();
        this.currentSessionId = undefined;
        this.client.setSessionId(undefined);
    }

    private async prepareNewSession(): Promise<undefined> {
        if (this.currentSessionId) {
            await this.clearPersistedSegment(this.currentSessionId);
        }
        this.resetSessionState();
        this.currentSessionId = undefined;
        this.client.setSessionId(undefined);
        await this.persistRecentSessionSelection(undefined);
        return undefined;
    }

    private async initializeNewSessionBaseline(webview: vscode.Webview): Promise<void> {
        if (!this.gitUndoEnabled) return;
        this.pendingBaselineTurnKey = `baseline-${Date.now()}`;
        this.pendingBaselineFailed = false;
        webview.postMessage({
            type: 'baselineStatus',
            ready: false,
            message: 'Initializing Git baseline...'
        });
        const baselineResult = await this.client.ensureBaselineForTurn(this.pendingBaselineTurnKey);
        this.baselineReady = baselineResult.ok;
        if (!baselineResult.ok) {
            this.pendingBaselineFailed = true;
            webview.postMessage({
                type: 'baselineStatus',
                ready: false,
                message: 'Git baseline failed. Undo unavailable.'
            });
            return;
        }
        webview.postMessage({ type: 'baselineStatus', ready: true });
    }

    private isTurnCommandInFlight(sessionId: string): boolean {
        return this.sendInFlightBySession.has(sessionId);
    }

    private isTurnCommandOwner(sessionId: string, clientMessageId: string): boolean {
        return Boolean(sessionId && clientMessageId)
            && this.sendInFlightBySession.has(sessionId)
            && this.turnCommandOwnerBySession.get(sessionId) === clientMessageId;
    }

    private markBusySessionInFlight(sessionId: string, reason: string): void {
        if (!sessionId) return;
        this.sendInFlightBySession.add(sessionId);
        this.markWebviewActiveTurnUpdated(sessionId, reason);
    }

    private recoverBusySessionTurnFromMessages(
        sessionId: string,
        messages: SessionMessage[],
        reason: string,
    ): { userMessageId: string; assistantMessageId: string } | null {
        if (!sessionId || !this.sendInFlightBySession.has(sessionId)) return null;
        const timeline = Array.isArray(messages) ? messages : [];
        const latestUser = [...timeline].reverse().find((message) => (
            message?.role === 'user'
            && typeof message.id === 'string'
            && message.id.startsWith('msg_')
        ));
        if (!latestUser || typeof latestUser.id !== 'string') return null;
        const latestUserId = latestUser.id;
        for (let index = timeline.length - 1; index >= 0; index--) {
            const assistant = timeline[index];
            if (assistant?.role !== 'assistant' || typeof assistant.id !== 'string' || !assistant.id.startsWith('msg_')) continue;
            if (typeof assistant.meta?.timeCompleted === 'number' && Number.isFinite(assistant.meta.timeCompleted)) continue;
            const parentId = typeof assistant.meta?.parentID === 'string' ? assistant.meta.parentID : '';
            if (parentId !== latestUserId) continue;
            if (!this.turnCommandOwnerBySession.has(sessionId)) {
                this.turnCommandOwnerBySession.set(sessionId, parentId);
            }
            if (!this.pendingLocalKeyBySession.has(sessionId)) {
                this.pendingLocalKeyBySession.set(sessionId, parentId);
                this.rawUserTextByLocalKey.set(parentId, typeof latestUser.text === 'string' ? latestUser.text : '');
            }
            this.pendingAssistantMessageIdBySession.set(sessionId, assistant.id);
            this.client.recoverActiveTurn(
                sessionId,
                parentId,
                assistant.id,
                typeof assistant.meta?.timeCreated === 'number' ? assistant.meta.timeCreated : undefined,
            );
            this.markWebviewActiveTurnUpdated(sessionId, reason);
            this.uiDebugChannel.appendLine(
                `EXT: session.init.activeTurn.recovered | sessionId=${sessionId} | ` +
                `userMsgId=${parentId} | assistantMsgId=${assistant.id} | reason=${reason}`
            );
            return { userMessageId: parentId, assistantMessageId: assistant.id };
        }
        this.uiDebugChannel.appendLine(
            `EXT: session.init.activeTurn.recover.skip | sessionId=${sessionId} | reason=no-incomplete-assistant`
        );
        return null;
    }

    private async createTurnSession(): Promise<string> {
        const sessionInfo = await this.client.createSession();
        this.currentSessionId = sessionInfo.id;
        this.trackUserOwnedSession(sessionInfo.id);
        this.client.setSessionId(sessionInfo.id);
        const workspaceFolder = this.client.getWorkspaceRoot()
            || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (workspaceFolder) {
            const workspaceKey = this.getWorkspaceKeyForRoot(workspaceFolder);
            await this._context.globalState.update(
                `recentSession.${workspaceKey}`,
                sessionInfo.id
            );
            this.uiDebugChannel.appendLine(
                `[EXT][RECENT_SESSION_UPDATED] sessionId=${sessionInfo.id} reason=sendMessage-createSession workspace=${workspaceFolder}`
            );
        }
        return sessionInfo.id;
    }

    private startTurnCommandState(
        sessionId: string,
        clientMessageId: string,
        userText: string,
        temporaryAssistantKey: string | undefined,
        operationId: string | undefined
    ): void {
        this.rawUserTextByLocalKey.set(clientMessageId, userText);
        this.sendInFlightBySession.add(sessionId);
        this.turnCommandOwnerBySession.set(sessionId, clientMessageId);
        this.markWebviewActiveTurnUpdated(sessionId, 'send:start');
        this.pendingLocalKeyBySession.set(sessionId, clientMessageId);
        this.pendingAssistantTmpKeyBySession.delete(sessionId);
        this.client.startTurnWithOp(sessionId, clientMessageId, operationId);
        this.assistantTextBufferBySession.set(sessionId, '');
        this.assistantTextBufferByMessageIdBySession.delete(sessionId);
        this.appendSnapshotTurnStateBySession.delete(sessionId);
        if (temporaryAssistantKey) {
            this.pendingAssistantTmpKeyBySession.set(sessionId, temporaryAssistantKey);
            this.pendingAssistantTmpKeyByLocalKey.set(clientMessageId, temporaryAssistantKey);
            this.client.setPendingAssistantTmpKey(sessionId, temporaryAssistantKey);
        }
    }

    private setTurnPendingSnapshotUserText(sessionId: string, displayText: string): void {
        this.pendingSnapshotUserTextBySession.set(sessionId, displayText);
    }

    private setTurnPendingSnapshotAttachments(sessionId: string, attachments: SavedAttachment[]): void {
        this.pendingSnapshotAttachmentsBySession.set(
            sessionId,
            attachments.map((attachment) => ({ ...attachment }))
        );
    }

    private bindTurnAssistantMessage(sessionId: string, assistantMessageId: string): void {
        this.pendingAssistantMessageIdBySession.set(sessionId, assistantMessageId);
        this.markWebviewActiveTurnUpdated(sessionId, 'send:assistant-message-bound');
    }

    private getTurnPendingLocalKey(sessionId: string): string | undefined {
        return this.pendingLocalKeyBySession.get(sessionId);
    }

    private isTurnPendingLocalKey(sessionId: string, clientMessageId: string): boolean {
        return this.pendingLocalKeyBySession.get(sessionId) === clientMessageId;
    }

    private clearCompletedTurnPendingUser(sessionId: string, clientMessageId: string): boolean {
        if (this.pendingLocalKeyBySession.get(sessionId) !== clientMessageId) return false;
        this.pendingLocalKeyBySession.delete(sessionId);
        return true;
    }

    private clearFailedTurnCommandState(sessionId: string): string | undefined {
        const pendingLocalKey = this.pendingLocalKeyBySession.get(sessionId);
        if (pendingLocalKey) {
            this.pendingAssistantTmpKeyByLocalKey.delete(pendingLocalKey);
            this.rawUserTextByLocalKey.delete(pendingLocalKey);
        }
        this.pendingLocalKeyBySession.delete(sessionId);
        this.clearAssistantTextBuffers(sessionId);
        this.appendSnapshotTurnStateBySession.delete(sessionId);
        this.pendingAssistantTmpKeyBySession.delete(sessionId);
        return pendingLocalKey;
    }

    private finishTurnCommandState(sessionId: string, clientMessageId: string): boolean {
        const pendingLocalKey = this.pendingLocalKeyBySession.get(sessionId);
        if (
            !clientMessageId
            || !this.sendInFlightBySession.has(sessionId)
            || this.turnCommandOwnerBySession.get(sessionId) !== clientMessageId
        ) {
            return false;
        }
        if (pendingLocalKey) {
            this.rawUserTextByLocalKey.delete(pendingLocalKey);
        }
        this.sendInFlightBySession.delete(sessionId);
        this.turnCommandOwnerBySession.delete(sessionId);
        this.pendingLocalKeyBySession.delete(sessionId);
        this.pendingAssistantTmpKeyBySession.delete(sessionId);
        return true;
    }

    private isAppendSubmissionInFlight(sessionId: string): boolean {
        return this.appendSubmitInFlightBySession.has(sessionId);
    }

    private markAppendSubmissionStarted(sessionId: string): void {
        this.appendSubmitInFlightBySession.add(sessionId);
    }

    private markAppendSubmissionFinished(sessionId: string): void {
        this.appendSubmitInFlightBySession.delete(sessionId);
    }

    private registerTurnTemporaryKey(sessionId: string, temporaryAssistantKey: string): void {
        this.pendingAssistantTmpKeyBySession.set(sessionId, temporaryAssistantKey);
        const pendingLocalKey = this.pendingLocalKeyBySession.get(sessionId);
        if (pendingLocalKey && pendingLocalKey.startsWith('local-')) {
            this.pendingAssistantTmpKeyByLocalKey.set(pendingLocalKey, temporaryAssistantKey);
        }
        this.client.setPendingAssistantTmpKey(sessionId, temporaryAssistantKey);
    }

    private captureTurnCancelOwner(payload: unknown): CapturedCancelTurnOwner {
        const owner = captureCancelTurnOwner(payload, {
            currentSessionId: this.currentSessionId,
            pendingLocalKeyBySession: this.pendingLocalKeyBySession,
            pendingAssistantTmpKeyBySession: this.pendingAssistantTmpKeyBySession,
            pendingAssistantMessageIdBySession: this.pendingAssistantMessageIdBySession,
        });
        const turnIds = typeof this.client.getCurrentTurnMessageIds === 'function'
            ? this.client.getCurrentTurnMessageIds(owner.sessionId)
            : { userMessageIds: [], assistantMessageIds: [] };
        return {
            ...owner,
            userMessageIds: turnIds.userMessageIds,
            assistantMessageIds: turnIds.assistantMessageIds,
        };
    }

    private clearCanceledTurnCommandState(sessionId: string): void {
        this.sendInFlightBySession.delete(sessionId);
        this.turnCommandOwnerBySession.delete(sessionId);
        this.pendingLocalKeyBySession.delete(sessionId);
        this.pendingAssistantTmpKeyBySession.delete(sessionId);
    }

    private clearTurnRawUserText(pendingLocalKey: string | undefined): void {
        if (pendingLocalKey) {
            this.rawUserTextByLocalKey.delete(pendingLocalKey);
        }
    }

    private clearCanceledTurnAssistantState(sessionId: string): void {
        this.pendingAssistantTmpKeyBySession.delete(sessionId);
        this.pendingAssistantMessageIdBySession.delete(sessionId);
        this.clearAssistantTextBuffers(sessionId);
        this.appendSnapshotTurnStateBySession.delete(sessionId);
    }

    private bindTurnMessageIdentity(sourceId: string, targetId: string): void {
        this.clientMessageIdMap.set(sourceId, targetId);
    }

    private resolveTurnMessageIdentity(messageId: string): string | undefined {
        return this.clientMessageIdMap.get(messageId);
    }

    private clearPostFinalWatchDiffFocus(sessionId: string): void {
        this.postFinalWatchDiffFocusedBySession.delete(sessionId);
    }

    private async discardRevertedSegmentAfterBuild(sessionId: string): Promise<void> {
        const segment = this.client.getRevertedSegment(sessionId);
        if (!segment) return;
        segment.discarded = true;
        segment.isActive = true;
        segment.collapsed = true;
        this.client.setRevertedSegment(sessionId, segment);
        await this.persistRevertedSegment(
            sessionId,
            segment,
            segment.conflicts || [],
            true
        );
    }

    private async listWorkspaceFiles(query: string, limit = 50): Promise<WorkspaceFileResult[]> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return [];
        const normalizedQuery = String(query || '').trim().replace(/\\/g, '/').toLowerCase();
        const exclude = '{**/.git/**,**/node_modules/**,**/.opencode/**,**/.sisyphus/**}';
        const maxScan = normalizedQuery.length >= 2 ? 2500 : 500;
        const discoveredUris = await vscode.workspace.findFiles(new vscode.RelativePattern(workspaceRoot, '**/*'), exclude, maxScan);
        const openRanks = collectOpenWorkspaceFileRanks(workspaceRoot);
        const uriByPath = new Map(discoveredUris.map((uri) => [workspaceFileKey(uri.fsPath), uri]));
        for (const uri of getOpenWorkspaceFileUris()) {
            uriByPath.set(workspaceFileKey(uri.fsPath), uri);
        }
        const scored = Array.from(uriByPath.values())
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
                const openRank = openRanks.get(workspaceFileKey(uri.fsPath)) ?? 3;
                return { path: relPath, name, directory: directory === '.' ? '' : directory, score, openRank };
            })
            .filter((item): item is WorkspaceFileResult & { score: number; openRank: number } => Boolean(item))
            .sort((a, b) => a.openRank - b.openRank
                || a.score - b.score
                || a.path.length - b.path.length
                || a.path.localeCompare(b.path))
            .slice(0, limit)
            .map(({ score, openRank, ...item }) => item);
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
        return resolveFinalizeTurnIdentity(this.client, sessionId, partial);
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
            noBaseline: () => this.postAddResponse(webview, 'No baseline available to open diff.', { sessionId }),
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
        this.appendSnapshotMetaStore = new AppendSnapshotMetaStore(
            (line) => this.uiDebugChannel.appendLine(line)
        );
        this.activeTurnTracker = new ActiveTurnTracker({
            isStreaming: (sessionId) => this.sendInFlightBySession.has(sessionId),
            getPendingAssistantId: (sessionId) => this.pendingAssistantMessageIdBySession.get(sessionId),
            getPendingLocalKey: (sessionId) => this.pendingLocalKeyBySession.get(sessionId),
            freshnessWindowMs: this.webviewActiveTurnFreshnessWindowMs,
        });
        this.turnRuntimeShadow = new TurnRuntimeShadow();
        this.chatEventActorRouter = new ChatEventActorRouter({
            handle: async (event) => {
                const liveWebview = this._view?.webview;
                if (!liveWebview) return;
                await this.handleChatEvent(event, liveWebview);
            },
            onError: (event, error) => {
                this.uiDebugChannel.appendLine(
                    `[EXT][SESSION_ACTOR_ERROR] sessionId=${event.sessionId || 'none'} type=${event.type} error=${String(error)}`,
                );
            },
            onDrop: (event, reason) => {
                this.uiDebugChannel.appendLine(
                    `[EXT][SESSION_ACTOR_DROP] sessionId=${event.sessionId || 'none'} type=${event.type} reason=${reason}`,
                );
            },
        });
        this.turnFinalizationCoordinator = new TurnFinalizationCoordinator({
            getAssistantMessageId: (sessionId) => this.client.getTurnAssistantMsgId(sessionId),
            getProcessingStartedAt: (sessionId) => this.client.getCurrentTurnStartedAt(sessionId),
            getProcessingCompletedAt: (sessionId) => this.client.getCurrentTurnCompletedAt(sessionId),
            getProcessingPausedAt: (sessionId) => this.client.getCurrentTurnProcessingPausedAt(sessionId),
            getProcessingPausedMs: (sessionId) => this.client.getCurrentTurnProcessingPausedMs(sessionId),
            emitPhase: (target, sessionId, phase) => this.emitTurnFinalizePhase(target as vscode.Webview, sessionId, phase),
            postMessageIndexMap: (target, sessionId) => this.postMessageIndexMap(target as vscode.Webview, sessionId),
            buildIdentity: (sessionId, partial) => this.buildFinalizeTurnIdentity(sessionId, partial),
            commitChanges: (identity) => this.commitPendingTurnChangesFromAuthoritativeFiles(identity),
            finalizeBinding: (sessionId, messageId) => this.client.finalizeTurnBindingFromResolvedAssistant(sessionId, messageId),
            resolvePendingUserUpgrade: (sessionId, target) => this.resolvePendingUserUpgrade(sessionId, target as vscode.Webview),
            promoteContinuationOwner: (sessionId, messageId) => this.client.promoteContinuationOwner(sessionId, messageId),
            consolidateContinuationOwner: (sessionId) => this.client.consolidateCurrentContinuationOwner(sessionId),
            emitChangeList: (identity, target) => this.emitDiffFileListWithRetry(identity, target as vscode.Webview),
            writeSnapshot: (identity) => this.writeFinalizeSnapshotFromCurrentTurn(identity),
            clearSendInFlight: (sessionId) => { this.sendInFlightBySession.delete(sessionId); },
            finishTurn: (sessionId) => this.client.finishTurn(sessionId),
            syncTurnInFlight: (sessionId, target, reason) => this.syncTurnInFlightAfterFinalize(sessionId, target as vscode.Webview, reason),
            runSendInitCompensation: (sessionId, target, reason) => this.runPendingSendInitGuardCompensation(sessionId, target as vscode.Webview, reason),
        });
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
        this.utilityCommandHandler = createUtilityCommandHandler({
            getLiveWebview: (fallback) => this._view?.webview || fallback,
            log: (message) => this.uiDebugChannel.appendLine(message),
            applyModelSelection: (value, webview) => this.applyUtilityModelSelection(value, webview),
            applyModeSelection: (value) => this.applyUtilityModeSelection(value),
            applyVariantSelection: (value) => this.applyUtilityVariantSelection(value),
            pickCompactionModelId: () => this.client.pickFreeModel(
                this.lastKnownModels,
                this.selectedModel
            )?.fullId,
            parseModelRef: (fullId) => this.parseModelRef(fullId) || undefined,
            summarizeSession: (sessionId, options) => this.client.summarizeSession(sessionId, options),
            fetchSessionUsage: (sessionId) => this.client.fetchSessionUsage(sessionId),
            postAddResponse: (webview, value, meta) => this.postAddResponse(webview, value, meta),
            refreshModels: (webview) => this.refreshModels(webview),
            refreshModelQuota: (webview) => this.postModelQuota(webview, 'send-button-hover', true),
            runSmartSearch: (sessionId, query, messages) => this.smartSearch.run(sessionId, query, messages),
            listWorkspaceFiles: (query) => this.listWorkspaceFiles(query),
            getWorkspaceCompletionTerms: () => this.workspaceLexicon.getTerms(),
            getAutoEditorContext: () => captureAutomaticEditorContext(),
            saveClipboardImage: (dataUrl, mime) => this.attachmentStorage.saveClipboardImage(dataUrl, mime),
            getImageMimeFromName: (name) => this.attachmentStorage.getImageMimeFromName(name),
            isImageFileName: (name) => this.attachmentStorage.isImageFileName(name),
            isGitUndoEnabled: () => this.gitUndoEnabled,
            openGitDiffForFile: (sessionId, filePath, webview, commitHead, commitBase) =>
                this.openGitDiffForFile(sessionId, filePath, webview, commitHead, commitBase),
            sendToolResult: (input) => this.client.sendToolResult(input),
            resolveLocalQuestion: (callId, result) => this.resolveUtilityLocalQuestion(callId, result),
            respondPermission: (input) => this.client.respondPermission(input),
            getWorkspaceRootPath: () => this.getWorkspaceRootPath(),
        });
        this.sessionCommandHandler = createSessionCommandHandler({
            getLiveWebview: (fallback) => this._view?.webview || fallback,
            log: (message) => this.uiDebugChannel.appendLine(message),
            refreshSessions: (webview, requestId) => this.refreshSessions(webview, requestId),
            forkSession: (sessionId) => this.client.forkSession(sessionId),
            renameSession: (sessionId, title) => this.client.renameSession(sessionId, title),
            persistSessionTitle: (sessionId, title) => this.persistSessionTitle(sessionId, title),
            initializeForkSnapshot: (sourceSessionId, childSessionId) =>
                this.initializeForkSnapshot(sourceSessionId, childSessionId),
            hasActiveTurn: (sessionId) => this.client.hasActiveTurn(sessionId),
            getSessionChildren: (sessionId) => this.client.getSessionChildren(sessionId),
            deleteSession: (sessionId) => this.client.deleteSession(sessionId),
            cleanupDeletedSessionArtifacts: (sessionId) => this.cleanupDeletedSessionArtifacts(sessionId),
            clearRecentSessionIfMatches: (sessionId) => this.clearRecentSessionIfMatches(sessionId),
            clearSelectedSessionAfterDelete: (sessionId) => this.clearSelectedSessionAfterDelete(sessionId),
            startSessionSelection: (sessionId) => this.startSessionSelection(sessionId),
            adoptSessionSelection: (sessionId) => this.adoptSessionSelection(sessionId),
            isSessionSelectionCurrent: (sessionId, epoch) =>
                this.isSessionSelectionCurrent(sessionId, epoch),
            applyAppendSnapshotMeta: (sessionId, messagesById) =>
                this.applyAppendSnapshotMeta(sessionId, messagesById),
            persistRecentSessionSelection: (sessionId) => this.persistRecentSessionSelection(sessionId),
            hydrateSessionUndoPresentation: (sessionId, webview) =>
                this.hydrateSessionUndoPresentation(sessionId, webview),
            readSnapshot: (sessionId) => this.readSnapshot(sessionId),
            injectChangeLists: (sessionId, formatted) => this.injectChangeLists(sessionId, formatted),
            getSnapshotTimelineIds: (sessionData, messages) =>
                this.getSnapshotTimelineIds(sessionData, messages),
            getSnapshotFile: (sessionId) => this.getSnapshotFile(sessionId),
            exportSessionRecent: (sessionId, limit) =>
                this.client.exportSessionRecent(sessionId, limit),
            getRecentSessionLoadLimit: () => this.recentSessionLoadLimit,
            formatSession: (exportData) => this.formatSession(exportData),
            getMaxMessageIndex: (messages) => this.getMaxMessageIndex(messages),
            classifyRecentAppendCandidates: (snapshotIds, maxIndex, messages) =>
                this.classifyRecentAppendCandidates(snapshotIds, maxIndex, messages),
            isSnapshotDeltaContinuityRepairEnabled: () =>
                this.snapshotDeltaContinuityRepairEnabled,
            buildImmutableSnapshotWithProvenSuffix: (baseMessages, suffix) =>
                this.buildImmutableSnapshotWithProvenSuffix(baseMessages, suffix),
            extractLastLine: (text) => this.extractLastLine(text),
            exportSession: (sessionId) => this.client.exportSession(sessionId),
            collectSnapshotRepairRequiredMessageIds: (sessionId) =>
                this.collectSnapshotRepairRequiredMessageIds(sessionId),
            buildFullExportSnapshotDelta: (baseMessages, snapshotIds, fullMessages, repairIds) =>
                this.buildFullExportSnapshotDelta(
                    baseMessages,
                    snapshotIds,
                    fullMessages,
                    repairIds
                ),
            persistStructurallyRepairedSnapshot: (
                sessionId,
                title,
                messages,
                timelineMessageIds,
                segments
            ) => this.persistStructurallyRepairedSnapshot(
                sessionId,
                title,
                messages,
                timelineMessageIds,
                segments
            ),
            postAddResponse: (webview, value, meta) =>
                this.postAddResponse(webview, value, meta),
            prepareNewSession: () => this.prepareNewSession(),
            initializeNewSessionBaseline: (webview) =>
                this.initializeNewSessionBaseline(webview),
            handleSnapshotTimelineIds: (payload) => this.handleSnapshotTimelineIds(payload),
        });
        this.turnCommandHandler = createTurnCommandHandler({
            client: {
                abortSession: (sessionId) => this.client.abortSession(sessionId),
                appendPrompt: (sessionId, text, options) =>
                    this.client.appendPrompt(sessionId, text, options),
                beginAppendPrompt: (sessionId, clientMessageId, text, rootUserMsgId) =>
                    this.client.beginAppendPrompt(
                        sessionId,
                        clientMessageId,
                        text,
                        rootUserMsgId
                    ),
                canAppendToCurrentTurn: (sessionId, rootUserMsgId) =>
                    this.client.canAppendToCurrentTurn(sessionId, rootUserMsgId),
                cancelTurn: (sessionId, operationId) =>
                    this.client.cancelTurn(sessionId, operationId),
                chat: (text, options) => this.client.chat(text, options),
                createInternalMessageId: (role, sessionId) =>
                    this.client.createInternalMessageId(role, sessionId),
                failAppendPrompt: (sessionId, clientMessageId) =>
                    this.client.failAppendPrompt(sessionId, clientMessageId),
                finishTurn: (sessionId) => this.client.finishTurn(sessionId),
                getPendingTurnMessageIds: (sessionId) =>
                    this.client.getPendingTurnMessageIds(sessionId),
                getTurnAssistantMsgId: (sessionId) =>
                    this.client.getTurnAssistantMsgId(sessionId),
                registerMessage: (messageId, sessionId) =>
                    this.client.registerMessage(messageId, sessionId),
                revertPendingTurnChangesToCurrentBase: (sessionId) =>
                    this.client.revertPendingTurnChangesToCurrentBase(sessionId),
                waitForSessionIdleGate: (sessionId, options) =>
                    this.client.waitForSessionIdleGate(sessionId, options),
                waitForTurnAssistantMsgId: (sessionId, timeoutMs) =>
                    this.client.waitForTurnAssistantMsgId(sessionId, timeoutMs),
                getCurrentTurnStartedAt: (sessionId) =>
                    this.client.getCurrentTurnStartedAt(sessionId),
                getCurrentTurnCompletedAt: (sessionId) =>
                    this.client.getCurrentTurnCompletedAt(sessionId),
                getCurrentTurnProcessingPausedAt: (sessionId) =>
                    this.client.getCurrentTurnProcessingPausedAt(sessionId),
                getCurrentTurnProcessingPausedMs: (sessionId) =>
                    this.client.getCurrentTurnProcessingPausedMs(sessionId),
            },
            attachments: {
                buildAttachmentManifest: (attachments) =>
                    this.attachmentStorage.buildAttachmentManifest(attachments),
                isImageFileName: (name) =>
                    this.attachmentStorage.isImageFileName(name),
                sanitizeFilename: (name) =>
                    this.attachmentStorage.sanitizeFilename(name),
                saveAttachment: (sessionId, attachment, requestId) =>
                    this.attachmentStorage.saveAttachment(sessionId, attachment, requestId),
            },
            getLiveWebview: (fallback) => this._view?.webview || fallback,
            getCurrentSessionId: () => this.currentSessionId,
            getTurnSelection: () => ({
                model: this.selectedModel,
                variant: this.selectedVariant,
                mode: this.selectedMode,
            }),
            log: (message) => this.uiDebugChannel.appendLine(message),
            logBridge: (message) => OpenCodeClient.outputChannel.appendLine(message),
            createTurnSession: () => this.createTurnSession(),
            trackUserOwnedSession: (sessionId) => this.trackUserOwnedSession(sessionId),
            postAddResponse: (webview, value, meta) =>
                this.postAddResponse(webview, value, meta),
            isTurnCommandInFlight: (sessionId) => this.isTurnCommandInFlight(sessionId),
            isTurnCommandOwner: (sessionId, clientMessageId) =>
                this.isTurnCommandOwner(sessionId, clientMessageId),
            startTurnCommandState: (
                sessionId,
                clientMessageId,
                userText,
                temporaryAssistantKey,
                operationId
            ) => this.startTurnCommandState(
                sessionId,
                clientMessageId,
                userText,
                temporaryAssistantKey,
                operationId
            ),
            rememberDraft: (clientMessageId, draft) =>
                this.rememberDraft(clientMessageId, draft),
            normalizeReferencedWorkspaceFiles: (files) =>
                this.normalizeReferencedWorkspaceFiles(files),
            bindMessageIdentity: (sourceId, targetId) =>
                this.bindTurnMessageIdentity(sourceId, targetId),
            buildContextBlock: (contextItems) => this.buildContextBlock(contextItems),
            setTurnPendingSnapshotUserText: (sessionId, displayText) =>
                this.setTurnPendingSnapshotUserText(sessionId, displayText),
            setTurnPendingSnapshotAttachments: (sessionId, attachments) =>
                this.setTurnPendingSnapshotAttachments(sessionId, attachments),
            bindTurnAssistantMessage: (sessionId, assistantMessageId) =>
                this.bindTurnAssistantMessage(sessionId, assistantMessageId),
            emitTurnFinalizePhase: (webview, sessionId, phase) =>
                this.emitTurnFinalizePhase(webview, sessionId, phase),
            postMessageIndexMap: (webview, sessionId) =>
                this.postMessageIndexMap(webview, sessionId),
            buildFinalizeTurnIdentity: (sessionId, partial) =>
                this.buildFinalizeTurnIdentity(sessionId, partial),
            commitPendingTurnChangesFromAuthoritativeFiles: (identity) =>
                this.commitPendingTurnChangesFromAuthoritativeFiles(identity),
            resolvePendingUserUpgrade: (sessionId, webview) =>
                this.resolvePendingUserUpgrade(sessionId, webview),
            emitDiffFileListWithRetry: (identity, webview) =>
                this.emitDiffFileListWithRetry(identity, webview),
            writeFinalizeSnapshotFromCurrentTurn: (identity) =>
                this.writeFinalizeSnapshotFromCurrentTurn(identity),
            clearPostFinalWatchDiffFocus: (sessionId) =>
                this.clearPostFinalWatchDiffFocus(sessionId),
            markSubagentsTerminalForParent: (sessionId, state, reason) =>
                this.markSubagentsTerminalForParent(sessionId, state, reason),
            emitSubagentStatus: () => this.emitSubagentStatus(),
            clearSubagentSessionsForParent: (sessionId, reason) =>
                this.clearSubagentSessionsForParent(sessionId, reason),
            postModelQuota: (webview, reason) => this.postModelQuota(webview, reason),
            isTurnPendingLocalKey: (sessionId, clientMessageId) =>
                this.isTurnPendingLocalKey(sessionId, clientMessageId),
            clearDraft: (clientMessageId) => this.clearDraft(clientMessageId),
            handleAbortedMessage: (sessionId, messageId, webview) =>
                this.handleAbortedMessage(sessionId, messageId, webview),
            clearCompletedTurnPendingUser: (sessionId, clientMessageId) =>
                this.clearCompletedTurnPendingUser(sessionId, clientMessageId),
            discardRevertedSegmentAfterBuild: (sessionId) =>
                this.discardRevertedSegmentAfterBuild(sessionId),
            getTurnPendingLocalKey: (sessionId) =>
                this.getTurnPendingLocalKey(sessionId),
            clearFailedTurnCommandState: (sessionId) =>
                this.clearFailedTurnCommandState(sessionId),
            finishTurnCommandState: (sessionId, clientMessageId) =>
                this.finishTurnCommandState(sessionId, clientMessageId),
            syncTurnInFlightAfterFinalize: (sessionId, webview, reason) =>
                this.syncTurnInFlightAfterFinalize(sessionId, webview, reason),
            runPendingSendInitGuardCompensation: (sessionId, webview, reason) =>
                this.runPendingSendInitGuardCompensation(sessionId, webview, reason),
            isAppendSubmissionInFlight: (sessionId) =>
                this.isAppendSubmissionInFlight(sessionId),
            markAppendSubmissionStarted: (sessionId) =>
                this.markAppendSubmissionStarted(sessionId),
            markAppendSubmissionFinished: (sessionId) =>
                this.markAppendSubmissionFinished(sessionId),
            cacheAppendSnapshotMeta: (data) => this.cacheAppendSnapshotMeta(data),
            registerTurnTemporaryKey: (sessionId, temporaryAssistantKey) =>
                this.registerTurnTemporaryKey(sessionId, temporaryAssistantKey),
            captureTurnCancelOwner: (payload) => this.captureTurnCancelOwner(payload),
            promptCancelRollbackDecision: (webview, sessionId) =>
                this.promptCancelRollbackDecision(webview, sessionId),
            upsertCanceledTurn: (sessionId, record) =>
                this.upsertCanceledTurn(sessionId, record),
            clearTurnRawUserText: (pendingLocalKey) =>
                this.clearTurnRawUserText(pendingLocalKey),
            clearCanceledTurnCommandState: (sessionId) =>
                this.clearCanceledTurnCommandState(sessionId),
            resolveMessageIdentity: (messageId) =>
                this.resolveTurnMessageIdentity(messageId),
            clearCanceledTurnAssistantState: (sessionId) =>
                this.clearCanceledTurnAssistantState(sessionId),
            consumeDraft: (clientMessageId) => this.consumeDraft(clientMessageId),
        });
        this.undoCommandHandler = createUndoCommandHandler({
            client: {
                discardRevertedSegment: (sessionId) =>
                    this.client.discardRevertedSegment(sessionId),
                getRevertedSegment: (sessionId) =>
                    this.client.getRevertedSegment(sessionId),
                getUndoRangeForAnchor: (messageId, sessionId) =>
                    this.client.getUndoRangeForAnchor(messageId, sessionId),
                restoreAll: (options) => this.client.restoreAll(options),
                restoreFromMessage: (startMessageId, endMessageId, options) =>
                    this.client.restoreFromMessage(startMessageId, endMessageId, options),
                setRevertedSegment: (sessionId, segment) =>
                    this.client.setRevertedSegment(sessionId, segment),
                setRevertedSegmentCollapsed: (sessionId, collapsed) =>
                    this.client.setRevertedSegmentCollapsed(sessionId, collapsed),
                undoFromMessage: (messageId, options) =>
                    this.client.undoFromMessage(messageId, options),
            },
            uiDebugChannel: {
                appendLine: (message) => this.uiDebugChannel.appendLine(message),
            },
            getLiveWebview: (fallback) => this._view?.webview || fallback,
            getCurrentSessionId: () => this.currentSessionId,
            isGitUndoEnabled: () => this.gitUndoEnabled,
            isUndoBaselineReady: () => this.baselineReady,
            resolveUndoMessageId: (messageId) => this.resolveUndoMessageId(messageId),
            getUndoSegmentState: (sessionId, noticeKey) =>
                this.getUndoSegmentState(sessionId, noticeKey),
            setUndoSegmentState: (sessionId, noticeKey, segment) =>
                this.setUndoSegmentState(sessionId, noticeKey, segment),
            deleteUndoSegmentState: (sessionId, noticeKey) =>
                this.deleteUndoSegmentState(sessionId, noticeKey),
            sanitizeUndoRangeMessageIds: (value) => this.sanitizeUndoRangeMessageIds(value),
            resolveUndoUiVisibleRange: (data, anchorMessageId, canonicalMessageIds, extAnchorIndex) =>
                this.resolveUndoUiVisibleRange(
                    data,
                    anchorMessageId,
                    canonicalMessageIds,
                    extAnchorIndex
                ),
            clearClientRevertedSegmentIfNonRestorable: (sessionId) =>
                this.clearClientRevertedSegmentIfNonRestorable(sessionId),
            getInvalidSegmentMessageIds: (sessionId, options) =>
                this.getInvalidSegmentMessageIds(sessionId, options),
            createConflictId: (kind, operationId) =>
                this.createConflictId(kind, operationId),
            setPendingUndoConflict: (conflict) => this.setPendingUndoConflict(conflict),
            getPendingUndoConflict: (sessionId) => this.getPendingUndoConflict(sessionId),
            takePendingUndoConflict: (sessionId) => this.takePendingUndoConflict(sessionId),
            getPendingUndoConflictCount: () => this.getPendingUndoConflictCount(),
            appendRevertedSegmentHistory: (sessionId, entry) =>
                this.appendRevertedSegmentHistory(sessionId, entry),
            trimRevertedSegmentHistory: (sessionId, excludedMessageIds) =>
                this.trimRevertedSegmentHistory(sessionId, excludedMessageIds),
            clearRevertedSegmentHistory: (sessionId) =>
                this.clearRevertedSegmentHistory(sessionId),
            getRevertedSegmentHistory: (sessionId) =>
                this.getRevertedSegmentHistory(sessionId),
            postAddResponse: (webview, value, meta) =>
                this.postAddResponse(webview, value, meta),
            postMessageIndexMap: (webview, sessionId) =>
                this.postMessageIndexMap(webview, sessionId),
            resolveChangeListCommits: (sessionId, messageIds, fallbackCommits) =>
                this.resolveChangeListCommits(sessionId, messageIds, fallbackCommits),
            setChangeListReverted: (sessionId, commitHead, reverted, webview) =>
                this.setChangeListReverted(sessionId, commitHead, reverted, webview),
            persistRevertedSegment: (sessionId, segment, conflicts, discarded) =>
                this.persistRevertedSegment(sessionId, segment, conflicts, discarded),
            clearPersistedSegment: (sessionId) => this.clearPersistedSegment(sessionId),
            refreshDiffIfTouched: (touchedFiles) => this.refreshDiffIfTouched(touchedFiles),
            buildRestoreMessageScope: (sessionId, noticeKey, baseMessageIds, segment) =>
                this.buildRestoreMessageScope(sessionId, noticeKey, baseMessageIds, segment),
            applyRestoreSegmentSuccess: (
                sessionId,
                noticeKey,
                anchorMsgId,
                endMsgId,
                result,
                commitsToClear,
                operationId,
                webview
            ) => this.applyRestoreSegmentSuccess(
                sessionId,
                noticeKey,
                anchorMsgId,
                endMsgId,
                result,
                commitsToClear,
                operationId,
                webview
            ),
        });
        this.webviewLifecycleController = createWebviewLifecycleController({
            beginResolution: (webviewView) =>
                this.beginWebviewLifecycleResolution(webviewView),
            getActiveWebview: (fallback) =>
                this.getLifecycleActiveWebview(fallback),
            handleCommandReloadReady: (data, webviewView, panelId) =>
                this.handleWebviewCommandReloadReady(data, webviewView, panelId),
            prepareReady: (data, webviewView, panelId) => {
                const readiness = this.prepareWebviewReady(data, webviewView, panelId);
                const pending = readiness.pending
                    ? {
                        handle: readiness.pending,
                        generationToken: readiness.pending.generationToken,
                        sessionId: readiness.pending.sessionId,
                        panelId: readiness.pending.panelId,
                        rescueAttemptId: readiness.pending.rescueAttemptId,
                        oldWebviewInstanceId: readiness.pending.oldWebviewInstanceId,
                        newWebviewInstanceId: readiness.pending.newWebviewInstanceId,
                        startedAt: readiness.pending.startedAt,
                        activeTurn: readiness.pending.activeTurn,
                    }
                    : undefined;
                return { ...readiness, pending };
            },
            getInitPosted: () => this.getLifecycleInitPosted(),
            sendInit: (webview, options) => this.sendInit(webview, options),
            finishHardRescueFailure: (pending, marker, reason) =>
                this.finishWebviewHardRescueFailure(
                    pending.handle as WebviewHardRescuePending,
                    marker,
                    reason
                ),
            completeHardRescueSuccess: (pending) =>
                this.completeWebviewHardRescueSuccess(
                    pending.handle as WebviewHardRescuePending
                ),
            startLivenessProbes: () => this.startWebviewLivenessProbes(),
            triggerLivenessProbe: (reason) => this.triggerWebviewLivenessProbe(reason),
            noteActivity: (data, webviewView, panelId) =>
                this.noteWebviewLivenessActivity(data, webviewView, panelId),
            handleLivenessAck: (data) => this.handleWebviewLivenessAck(data),
            handleAutoRescueAck: (data) => this.handleWebviewAutoRescueAck(data),
            handleVisibility: (webviewView) =>
                this.handleWebviewLifecycleVisibility(webviewView),
            handleDispose: (panelId) => this.handleWebviewLifecycleDispose(panelId),
            log: (message) => this.uiDebugChannel.appendLine(message),
        });
        this.sidebarWebviewDependencies = {
            localResourceRoots: [
                this._extensionUri,
                vscode.Uri.file(this.getWorkspaceRootPath()),
            ],
            getHtmlForWebview: (webview) => this._getHtmlForWebview(webview),
            log: (message) => this.uiDebugChannel.appendLine(message),
            utilityCommandHandler: this.utilityCommandHandler,
            sessionCommandHandler: this.sessionCommandHandler,
            turnCommandHandler: this.turnCommandHandler,
            undoCommandHandler: this.undoCommandHandler,
            lifecycleController: this.webviewLifecycleController,
        };
        this.userOwnedSessionsLoaded = this.loadUserOwnedSessions();
        this.client.setServerStatusHandler((status, reason) => {
            this.sendServerStatus(status, reason);
        });
        this.client.addChatEventListener((event) => {
            void this.chatEventActorRouter.route(event);
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
        const sessionId = this.currentSessionId;
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
        this.sendPrefillInput(sessionId, displayText, {
            source: 'editor',
            text,
            filePath,
            range: { startLine, endLine }
        });
    }

    public async sendOutputSelectionToChat(): Promise<void> {
        const sessionId = this.currentSessionId;
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
        this.sendPrefillInput(sessionId, 'vscode output', {
            source: 'output',
            text
        });
    }

    private sendPrefillInput(sessionId: string | undefined, displayText: string, payload: { source: string; text: string; filePath?: string; range?: { startLine?: number; endLine?: number } }): void {
        const liveWebview = this._view?.webview;
        if (!liveWebview) {
            vscode.window.showInformationMessage('Open the OpenCode UI to receive the selection.');
            return;
        }
        liveWebview.postMessage({
            type: 'prefillInput',
            sessionId,
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
    ): void {
        return resolveSidebarWebviewView(
            webviewView,
            context,
            _token,
            this.sidebarWebviewDependencies
        );
    }

    private async sendInit(webview: vscode.Webview, options: SendInitOptions = {}): Promise<void> {
        return initializeSidebarSession(this, webview, options);
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
            const source = item?.source === 'output'
                ? 'VS Code Output'
                : (item?.source === 'editor-auto' ? 'Active Editor' : 'Editor Selection');
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
            this.revertedSegmentHistoryStore.clear();

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
        this.client.discardRevertedSegment(sessionId);
        const discardedSegment = this.client.getRevertedSegment(sessionId);
        liveWebview.postMessage({
            type: 'revertedSegmentDiscarded',
            segment: discardedSegment ? { ...discardedSegment, historySegments: this.revertedSegmentHistoryStore.get(sessionId), noticeKey } : discardedSegment,
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
        const shadowObservation = this.observeTurnRuntimeShadow(event);
        await handleSidebarChatEvent(this, event, webview);
        this.reportTurnRuntimeShadow(event, await shadowObservation);
    }

    public scheduleAutoEditorContextRefresh(delayMs = 100): void {
        if (this.autoEditorContextTimer) clearTimeout(this.autoEditorContextTimer);
        this.autoEditorContextTimer = setTimeout(() => {
            this.autoEditorContextTimer = undefined;
            this._view?.webview.postMessage({
                type: 'autoEditorContextChanged',
                context: captureAutomaticEditorContext(),
            });
        }, Math.max(0, delayMs));
    }

    private async observeTurnRuntimeShadow(event: ChatEvent): Promise<TurnShadowObservation | undefined> {
        if (
            !event.sessionId
            || event.displayTarget === 'agent-lane'
            || !this.isUserOwnedSession(event.sessionId)
        ) {
            return undefined;
        }
        try {
            return await this.turnRuntimeShadow.observe(event);
        } catch (error) {
            this.uiDebugChannel.appendLine(
                `[EXT][TURN_SHADOW_ERROR] sessionId=${event.sessionId} source=${event.type} error=${String(error)}`,
            );
            return undefined;
        }
    }

    private reportTurnRuntimeShadow(
        event: ChatEvent,
        observation: TurnShadowObservation | undefined,
    ): void {
        if (!observation?.observed) return;
        const sessionId = observation.sessionId;
        const divergences = classifyTurnShadowDivergences(observation, {
            inFlight: this.sendInFlightBySession.has(sessionId),
            assistantId: this.client.getTurnAssistantMsgId(sessionId),
            temporaryAssistantId: this.pendingAssistantTmpKeyBySession.get(sessionId),
            bufferedText: this.assistantTextBufferBySession.get(sessionId),
        });
        const unexplained = divergences.filter((item) => item.severity === 'unexplained');
        if (observation.warnings.length > 0 || unexplained.length > 0) {
            const fields = unexplained.map((item) => item.field).join(',') || 'none';
            const signature = `${observation.state.generation}:${observation.state.phase}:${fields}:${observation.warnings.join(',')}`;
            if (this.lastTurnShadowDivergenceBySession.get(sessionId) !== signature) {
                this.lastTurnShadowDivergenceBySession.set(sessionId, signature);
                this.uiDebugChannel.appendLine(
                    `[EXT][TURN_SHADOW_DIVERGENCE] sessionId=${sessionId} source=${event.type} ` +
                    `phase=${observation.state.phase} generation=${observation.state.generation} ` +
                    `fields=${fields} warnings=${observation.warnings.join(',') || 'none'}`,
                );
            }
        } else {
            this.lastTurnShadowDivergenceBySession.delete(sessionId);
        }
        if (
            event.type === 'turnInFlight'
            || event.type === 'turnResolved'
            || event.type === 'error'
            || event.type === 'autoResumeHardStop'
        ) {
            this.uiDebugChannel.appendLine(
                `[EXT][TURN_SHADOW] sessionId=${sessionId} source=${event.type} ` +
                `phase=${observation.state.phase} generation=${observation.state.generation} ` +
                `canonical=${observation.state.assistant?.canonicalId || 'none'} ` +
                `unexplained=${unexplained.length}`,
            );
        }
    }

    private appendAssistantBuffer(sessionId: string, chunk: string, assistantMessageId?: string): void {
        this.markWebviewActiveTurnUpdated(sessionId, 'appendAssistantBuffer');
        const next = (this.assistantTextBufferBySession.get(sessionId) || '') + chunk;
        this.assistantTextBufferBySession.set(sessionId, next);
        if (this.isResolvableMessageId(assistantMessageId)) {
            let byMessageId = this.assistantTextBufferByMessageIdBySession.get(sessionId);
            if (!byMessageId) {
                byMessageId = new Map<string, string>();
                this.assistantTextBufferByMessageIdBySession.set(sessionId, byMessageId);
            }
            byMessageId.set(assistantMessageId, (byMessageId.get(assistantMessageId) || '') + chunk);
        }
    }

    private getAssistantTextBuffer(sessionId: string, assistantMessageId?: string): string | undefined {
        if (this.isResolvableMessageId(assistantMessageId)) {
            const exact = this.assistantTextBufferByMessageIdBySession.get(sessionId)?.get(assistantMessageId);
            if (exact !== undefined) return exact;
        }
        return this.assistantTextBufferBySession.get(sessionId);
    }

    private clearAssistantTextBuffers(sessionId: string): void {
        this.assistantTextBufferBySession.delete(sessionId);
        this.assistantTextBufferByMessageIdBySession.delete(sessionId);
    }

    private getOrCreateAppendSnapshotTurnState(sessionId: string): AppendSnapshotTurnState {
        let state = this.appendSnapshotTurnStateBySession.get(sessionId);
        if (!state) {
            state = {
                orderedIds: [],
                messagesById: new Map<string, SessionMessage>(),
                preparedGenerations: new Set<number>(),
            };
            this.appendSnapshotTurnStateBySession.set(sessionId, state);
        }
        return state;
    }

    private recordAppendSnapshotUserMessage(
        sessionId: string,
        rootUserMessageId: string | undefined,
        appendUserMessageId: string | undefined,
        text: string
    ): void {
        if (!sessionId || !appendUserMessageId || !this.isResolvableMessageId(appendUserMessageId)) return;
        const state = this.getOrCreateAppendSnapshotTurnState(sessionId);
        if (rootUserMessageId && this.isResolvableMessageId(rootUserMessageId)) {
            state.rootUserMessageId = rootUserMessageId;
        }
        const normalizedText = this.normalizeUserTextForSnapshot(text);
        if (normalizedText) {
            this.rawUserTextByMsgId.set(appendUserMessageId, normalizedText);
            state.messagesById.set(appendUserMessageId, {
                role: 'user',
                id: appendUserMessageId,
                text: normalizedText,
                messageIndex: this.client.getMessageIndex(appendUserMessageId, sessionId)
            });
        }
    }

    private prepareAppendSnapshotHandoff(sessionId: string, followup: any): void {
        const generation = Number(followup?.generation);
        const predecessorAssistantMsgId = typeof followup?.predecessorAssistantMsgId === 'string'
            ? followup.predecessorAssistantMsgId
            : '';
        const appendUserMsgId = typeof followup?.appendUserMsgId === 'string'
            ? followup.appendUserMsgId
            : '';
        if (!sessionId || !Number.isFinite(generation) || !predecessorAssistantMsgId || !appendUserMsgId) return;
        const state = this.getOrCreateAppendSnapshotTurnState(sessionId);
        if (state.preparedGenerations.has(generation)) return;

        const addOrdered = (message: SessionMessage | undefined) => {
            if (!message || typeof message.id !== 'string' || !message.id) return;
            state.messagesById.set(message.id, message);
            if (!state.orderedIds.includes(message.id)) state.orderedIds.push(message.id);
        };
        const rootUserMessageId = state.rootUserMessageId
            || this.client.getAppendRootUserMsgId(sessionId);
        const rootUserText = rootUserMessageId
            ? this.normalizeUserTextForSnapshot(
                this.rawUserTextByMsgId.get(rootUserMessageId)
                ?? this.pendingSnapshotUserTextBySession.get(sessionId)
                ?? ''
            )
            : '';
        if (rootUserMessageId && rootUserText) {
            state.rootUserMessageId = rootUserMessageId;
            addOrdered({
                role: 'user',
                id: rootUserMessageId,
                text: rootUserText,
                messageIndex: this.client.getMessageIndex(rootUserMessageId, sessionId)
            });
        }

        const predecessorText = this.getAssistantTextBuffer(sessionId, predecessorAssistantMsgId) || '';

        const appendUser = state.messagesById.get(appendUserMsgId);
        const appendUserText = this.normalizeUserTextForSnapshot(
            appendUser?.text
            ?? this.rawUserTextByMsgId.get(appendUserMsgId)
            ?? ''
        );
        if (appendUserText) {
            addOrdered({
                role: 'user',
                id: appendUserMsgId,
                text: appendUserText,
                messageIndex: this.client.getMessageIndex(appendUserMsgId, sessionId)
            });
        }

        state.preparedGenerations.add(generation);
        this.assistantTextBufferBySession.set(sessionId, '');
        this.uiDebugChannel.appendLine(
            `[EXT][SNAPSHOT_APPEND_STAGE] sessionId=${sessionId} generation=${generation} rootUserMessageId=${rootUserMessageId || 'null'} predecessorAssistantMessageId=${predecessorAssistantMsgId} appendUserMessageId=${appendUserMsgId} predecessorTextLength=${predecessorText.length} appendTextLength=${appendUserText.length}`
        );
    }

    private getAssistantMetaAllowedSessionIds(targetSessionId: string): string[] {
        if (!targetSessionId) {
            return [];
        }
        try {
            const relatedIds = this.client.getRelatedSessionIds(targetSessionId);
            return Array.from(new Set([targetSessionId, ...relatedIds].filter(Boolean)));
        } catch {
            return [targetSessionId];
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
        const assistantMessageId = this.client.getTurnAssistantMsgId(sessionId)
            || this.pendingAssistantMessageIdBySession.get(sessionId);
        const text = this.getAssistantTextBuffer(sessionId, assistantMessageId) || '';
        this.clearAssistantTextBuffers(sessionId);
        if (!text) return;
        const tmpKey = this.pendingAssistantTmpKeyBySession.get(sessionId);
        const isSyntheticTurn = this.isCurrentTurnSynthetic(sessionId);
        webview.postMessage({
            type: 'assistantMessageMeta',
            lastText: text,
            sessionId,
            tmpKey,
            allowedSessionIds: this.getAssistantMetaAllowedSessionIds(sessionId),
            ...(isSyntheticTurn ? { isSyntheticTurn: true } : {})
        });
    }

    private async refreshModels(webview: vscode.Webview): Promise<ModelInfo[]> {
        const sessionId = this.currentSessionId;
        try {
            const models = await this.client.listModels();
            if (models.length) {
                this.lastKnownModels = models;
            }
            webview.postMessage({ type: 'models', models, sessionId });
            await this.postModelQuota(webview, 'refresh-models');
            return models;
        } catch (error) {
            if (sessionId) {
                this.postAddResponse(webview, `Failed to refresh models: ${error}`, { sessionId });
            } else {
                this.uiDebugChannel.appendLine(`[EXT][ADD_RESPONSE_DROP] reason=missing-session-owner source=refreshModels error=${String(error)}`);
            }
        }
        return [];
    }

    private parseModelRef(model?: string): { providerID: string; modelID: string } | undefined {
        if (!model) return undefined;
        const parts = model.split('/');
        if (parts.length < 2) return undefined;
        return { providerID: parts[0], modelID: parts.slice(1).join('/') };
    }

    private async postModelQuota(webview: vscode.Webview, reason: string, force = false): Promise<void> {
        if (this.modelQuotaInFlight) {
            await this.modelQuotaInFlight;
        }
        const modelId = this.selectedModel;
        if (!modelId) return;
        const model = this.lastKnownModels.find((item) => item.fullId === modelId);
        if (!model) return;
        this.modelQuotaInFlight = (async () => {
            try {
                const quota = await this.client.fetchModelQuota(model, force);
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
        const sessionId = this.currentSessionId;
        try {
            const sessions = await this.client.listSessions();
            const workspaceRoot = this.client.getWorkspaceRoot() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const filteredSessions = await this.filterSessionsForWorkspace(sessions, workspaceRoot, 'refresh');
            const topSession = filteredSessions?.[0];
            webview.postMessage({ type: 'sessionsList', requestId, sessions: filteredSessions });
        } catch (error) {
            if (sessionId) {
                this.postAddResponse(webview, `Failed to refresh sessions: ${error}`, { sessionId });
            } else {
                this.uiDebugChannel.appendLine(`[EXT][ADD_RESPONSE_DROP] reason=missing-session-owner source=refreshSessions error=${String(error)}`);
            }
        }
    }

    private async saveUndoSegmentsState(): Promise<void> {
        await this._context.globalState.update(
            this.UNDO_SEGMENTS_KEY,
            serializeUndoSegments(this.undoSegmentsBySession)
        );
    }

    private resolveUndoMessageId(messageId: string): string {
        return this.clientMessageIdMap.get(messageId) || messageId;
    }

    private getUndoSegmentState(sessionId: string, noticeKey: string): SegmentState | undefined {
        return this.undoSegmentsBySession.get(sessionId)?.get(noticeKey);
    }

    private async setUndoSegmentState(
        sessionId: string,
        noticeKey: string,
        segment: SegmentState
    ): Promise<{ before: number; after: number }> {
        let segments = this.undoSegmentsBySession.get(sessionId);
        if (!segments) {
            segments = new Map<string, SegmentState>();
            this.undoSegmentsBySession.set(sessionId, segments);
        }
        const before = segments.size;
        segments.set(noticeKey, segment);
        await this.saveUndoSegmentsState();
        return { before, after: segments.size };
    }

    private async deleteUndoSegmentState(
        sessionId: string,
        noticeKey: string
    ): Promise<{ deleted: boolean; before: number; after: number }> {
        const segments = this.undoSegmentsBySession.get(sessionId);
        const before = segments?.size ?? 0;
        const deleted = segments?.delete(noticeKey) ?? false;
        const after = segments?.size ?? 0;
        if (deleted) {
            await this.saveUndoSegmentsState();
        }
        return { deleted, before, after };
    }

    private getRevertedSegmentHistory(sessionId: string): RevertedSegmentHistoryEntry[] {
        return this.revertedSegmentHistoryStore.get(sessionId);
    }

    private appendRevertedSegmentHistory(
        sessionId: string,
        entry: RevertedSegmentHistoryEntry
    ): void {
        this.revertedSegmentHistoryStore.update(sessionId, (entries) => [...entries, entry]);
    }

    private removeRevertedSegmentHistoryByStartMessage(
        sessionId: string,
        startMessageId: string
    ): void {
        this.revertedSegmentHistoryStore.update(
            sessionId,
            (entries) => entries.filter((entry) => entry.startMessageId !== startMessageId)
        );
    }

    private trimRevertedSegmentHistory(
        sessionId: string,
        excludedMessageIds: ReadonlySet<string>
    ): void {
        this.revertedSegmentHistoryStore.update(
            sessionId,
            (entries) => entries
                .map((entry) => ({
                    ...entry,
                    messageIds: (entry.messageIds ?? []).filter((id) => !excludedMessageIds.has(id))
                }))
                .filter((entry) => (entry.messageIds ?? []).length > 0)
        );
    }

    private clearRevertedSegmentHistory(sessionId: string): void {
        this.revertedSegmentHistoryStore.clearSession(sessionId);
    }

    private setPendingUndoConflict(conflict: PendingConflict): void {
        this.pendingConflictStore.set(conflict);
    }

    private getPendingUndoConflict(sessionId: string): PendingConflict | undefined {
        return this.pendingConflictStore.get(sessionId);
    }

    private takePendingUndoConflict(sessionId: string): PendingConflict | undefined {
        return this.pendingConflictStore.take(sessionId);
    }

    private getPendingUndoConflictCount(): number {
        return this.pendingConflictStore.size;
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
        this.sessionTitleOverrideBySession.delete(sessionId);
        this.lastSnapshotPayloadBySession.delete(sessionId);
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
                historySegments: this.revertedSegmentHistoryStore.get(sessionId)
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
        this.chatEventActorRouter.dispose();
        this.turnRuntimeShadow.dispose();
        if (this.subagentRetentionTimer) {
            clearTimeout(this.subagentRetentionTimer);
            this.subagentRetentionTimer = undefined;
        }
        if (this.autoEditorContextTimer) {
            clearTimeout(this.autoEditorContextTimer);
            this.autoEditorContextTimer = undefined;
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

    private isCompactionSummaryInfo(info: any): boolean {
        if (!info || typeof info !== 'object') return false;
        if (info.summary === true) return true;
        const mode = typeof info.mode === 'string' ? info.mode.toLowerCase() : '';
        const agent = typeof info.agent === 'string' ? info.agent.toLowerCase() : '';
        return mode === 'compaction' || agent === 'compaction';
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
                const isAutoResumeText = text.trimStart().startsWith('[OC_UI_AUTORESUME');
                const isStopContinuationText = this.isHiddenControlUserText(text);
                const isOmoContinuation =
                    text.includes('<!-- OMO_INTERNAL_INITIATOR -->')
                    && (
                        text.includes('[SYSTEM DIRECTIVE: OH-MY-OPENCODE - BOULDER CONTINUATION]')
                        || text.includes('[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]')
                    );
                const isSyntheticUser = isAutoResumeText
                    || isStopContinuationText
                    || isOmoContinuation
                    || this.isCompactionSummaryInfo(msg?.info);
                if (isSyntheticUser) {
                    syntheticUserIds.add(id);
                }
            }
            if (role === 'assistant' && !this.isCompactionSummaryInfo(msg?.info)) {
                const parentId = msg?.info?.parentID;
                if (typeof parentId === 'string') {
                    const list = assistantByParent.get(parentId) || [];
                    list.push(msg);
                    assistantByParent.set(parentId, list);
                }
            }
        }

        const getTimeCreated = (message: any): number => {
            const v = message?.info?.time?.created ?? message?.time?.created;
            return typeof v === 'number' ? v : -Infinity;
        };

        const getTimeCompleted = (message: any): number => {
            const v = message?.info?.time?.completed ?? message?.time?.completed;
            return typeof v === 'number' ? v : -Infinity;
        };

        const getAssistantText = (message: any): string => {
            const parts = Array.isArray(message?.parts)
                ? message.parts.filter((part: any) => part.type === 'text' && typeof part.text === 'string')
                : [];
            return parts.map((part: any) => part.text).join('');
        };

        const pickAssistantPresentation = (candidates: any[]): { ownerId: string; text: string; textSourceId: string } | null => {
            if (!Array.isArray(candidates) || !candidates.length) return null;
            const stopCandidates = candidates.filter((message) => message?.info?.finish === 'stop');
            const pickFrom = stopCandidates.length ? stopCandidates : candidates;
            let best = pickFrom[0];
            let bestScore = Math.max(getTimeCompleted(best), getTimeCreated(best));
            for (let i = 1; i < pickFrom.length; i++) {
                const candidate = pickFrom[i];
                const score = Math.max(getTimeCompleted(candidate), getTimeCreated(candidate));
                // OpenCode returns assistant generations in chronological order.
                // Prefer the later entry on equal or missing timestamps so an
                // active multi-generation tool turn cannot fall back to its
                // oldest assistant stage during full-history hydration.
                if (score >= bestScore) {
                    best = candidate;
                    bestScore = score;
                }
            }
            const ownerId = best?.info?.id;
            if (typeof ownerId !== 'string') return null;
            const ownerIndex = candidates.indexOf(best);
            for (let index = ownerIndex; index >= 0; index--) {
                const textSource = candidates[index];
                const text = getAssistantText(textSource);
                if (!text) continue;
                const textSourceId = textSource?.info?.id;
                if (typeof textSourceId !== 'string') continue;
                return { ownerId, text, textSourceId };
            }
            return null;
        };

        const finalAssistantIds = new Set<string>();
        const assistantPresentationById = new Map<string, { text: string; textSourceId: string }>();
        for (const userId of userIds) {
            const candidates = assistantByParent.get(userId) || [];
            const presentation = pickAssistantPresentation(candidates);
            if (!presentation) continue;
            finalAssistantIds.add(presentation.ownerId);
            assistantPresentationById.set(presentation.ownerId, {
                text: presentation.text,
                textSourceId: presentation.textSourceId,
            });
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
            if (this.isCompactionSummaryInfo(message?.info)) {
                continue;
            }
            const presentation = role === 'assistant' ? assistantPresentationById.get(resolvedId) : undefined;
            const text = presentation?.text ?? getAssistantText(message);
            if (!text) continue;
            const isAutoResumeText = role === 'user' && text.trimStart().startsWith('[OC_UI_AUTORESUME');
            const isStopContinuationText = role === 'user' && this.isHiddenControlUserText(text);
            const isOmoContinuation =
                role === 'user'
                && text.includes('<!-- OMO_INTERNAL_INITIATOR -->')
                && (
                    text.includes('[SYSTEM DIRECTIVE: OH-MY-OPENCODE - BOULDER CONTINUATION]')
                    || text.includes('[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]')
                );
            const isSyntheticUser = role === 'user' && (
                isAutoResumeText
                || isStopContinuationText
                || isOmoContinuation
                || this.isCompactionSummaryInfo(message?.info)
            );
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
                    timeCompleted: (message?.info as any)?.time?.completed,
                    ...(presentation && presentation.textSourceId !== resolvedId
                        ? { inheritedTextFromAssistantId: presentation.textSourceId }
                        : {})
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
        const retainedTurnCommandOwnerBySession = new Map<string, string>();
        const retainedPendingLocalKeyBySession = new Map<string, string>();
        const retainedPendingAssistantTmpKeyBySession = new Map<string, string>();
        const retainedPendingAssistantMessageIdBySession = new Map<string, string>();
        const retainedAssistantTextBufferBySession = new Map<string, string>();
        const retainedAssistantTextBufferByMessageIdBySession = new Map<string, Map<string, string>>();
        const retainedPendingSnapshotUserTextBySession = new Map<string, string>();
        const retainedPendingSnapshotAttachmentsBySession = new Map<string, SavedAttachment[]>();
        const retainedAppendSnapshotTurnStateBySession = new Map<string, AppendSnapshotTurnState>();
        const retainedRawUserTextByLocalKey = new Map<string, string>();
        const retainedPendingAssistantTmpKeyByLocalKey = new Map<string, string>();
        const isRetainableTmpKey = (value: string | undefined): value is string => Boolean(value && (value.startsWith('tmp:') || value.startsWith('local-')));
        for (const sessionId of retainedSendInFlightBySession) {
            if (typeof sessionId !== 'string' || !sessionId) continue;
            const commandOwner = this.turnCommandOwnerBySession.get(sessionId);
            if (commandOwner) {
                retainedTurnCommandOwnerBySession.set(sessionId, commandOwner);
            }
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
            const assistantTextByMessageId = this.assistantTextBufferByMessageIdBySession.get(sessionId);
            if (assistantTextByMessageId) {
                retainedAssistantTextBufferByMessageIdBySession.set(sessionId, new Map(assistantTextByMessageId));
            }
            const pendingSnapshotUserText = this.pendingSnapshotUserTextBySession.get(sessionId);
            if (pendingSnapshotUserText !== undefined) {
                retainedPendingSnapshotUserTextBySession.set(sessionId, pendingSnapshotUserText);
            }
            const pendingSnapshotAttachments = this.pendingSnapshotAttachmentsBySession.get(sessionId);
            if (pendingSnapshotAttachments) {
                retainedPendingSnapshotAttachmentsBySession.set(
                    sessionId,
                    pendingSnapshotAttachments.map((attachment) => ({ ...attachment }))
                );
            }
            const appendSnapshotTurnState = this.appendSnapshotTurnStateBySession.get(sessionId);
            if (appendSnapshotTurnState) {
                retainedAppendSnapshotTurnStateBySession.set(sessionId, appendSnapshotTurnState);
            }
        }
        this.client.resetSessionState({ preserveInFlightSessionIds: retainedSendInFlightBySession });
        this.clientMessageIdMap.clear();
        this.revertedSegmentHistoryStore.clear();
        this.pendingConflictStore.clear();
        this.draftByLocalKey.clear();
        this.appendSubmitInFlightBySession.clear();
        this.pendingBaselineTurnKey = undefined;
        this.currentDiffFilePath = null;
        this.diffHashes.clear();
        this.shownDiffKeysBySession.clear();
        this.uiTimelineBySession.clear();
        this.assistantTextBufferBySession.clear();
        this.assistantTextBufferByMessageIdBySession.clear();
        this.pendingSnapshotUserTextBySession.clear();
        this.pendingSnapshotAttachmentsBySession.clear();
        this.appendSnapshotTurnStateBySession.clear();
        this.pendingAssistantTmpKeyBySession.clear();
        this.pendingAssistantTmpKeyByLocalKey.clear();
        this.pendingLocalKeyBySession.clear();
        this.pendingAssistantMessageIdBySession.clear();
        this.rawUserTextByLocalKey.clear();
        this.rawUserTextByMsgId.clear();
        this.sendInFlightBySession.clear();
        this.turnCommandOwnerBySession.clear();
        for (const sessionId of retainedSendInFlightBySession) {
            this.sendInFlightBySession.add(sessionId);
            const commandOwner = retainedTurnCommandOwnerBySession.get(sessionId);
            if (commandOwner) {
                this.turnCommandOwnerBySession.set(sessionId, commandOwner);
            }
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
            const assistantTextByMessageId = retainedAssistantTextBufferByMessageIdBySession.get(sessionId);
            if (assistantTextByMessageId) {
                this.assistantTextBufferByMessageIdBySession.set(sessionId, assistantTextByMessageId);
                restored = true;
            }
            const pendingSnapshotUserText = retainedPendingSnapshotUserTextBySession.get(sessionId);
            if (pendingSnapshotUserText !== undefined) {
                this.pendingSnapshotUserTextBySession.set(sessionId, pendingSnapshotUserText);
                restored = true;
            }
            const pendingSnapshotAttachments = retainedPendingSnapshotAttachmentsBySession.get(sessionId);
            if (pendingSnapshotAttachments) {
                this.pendingSnapshotAttachmentsBySession.set(
                    sessionId,
                    pendingSnapshotAttachments.map((attachment) => ({ ...attachment }))
                );
                restored = true;
            }
            const appendSnapshotTurnState = retainedAppendSnapshotTurnStateBySession.get(sessionId);
            if (appendSnapshotTurnState) {
                this.appendSnapshotTurnStateBySession.set(sessionId, appendSnapshotTurnState);
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

    private consumeAppendSuccessorTmpKey(sessionId: string, successor: { predecessorAssistantMsgId?: string; generation?: number }): void {
        const tmpKey = this.pendingAssistantTmpKeyBySession.get(sessionId);
        if (!tmpKey || !successor?.predecessorAssistantMsgId || !Number.isFinite(successor.generation)) {
            this.uiDebugChannel.appendLine(`[EXT][APPEND_FOLLOWUP_TMP_RETAIN] sessionId=${sessionId} generation=${successor?.generation ?? 'null'}`);
            return;
        }
        // The host only clears the session pointer after Client has proven canonical A→B ownership.
        this.pendingAssistantTmpKeyBySession.delete(sessionId);
        this.uiDebugChannel.appendLine(`[EXT][APPEND_FOLLOWUP_TMP_CLEAR] sessionId=${sessionId} predecessorAssistantMsgId=${successor.predecessorAssistantMsgId} generation=${successor.generation}`);
    }

    private async handleAbortedMessage(sessionId: string, messageId: string, webview: vscode.Webview): Promise<void> {
        if (!sessionId) {
            this.uiDebugChannel.appendLine(`[EXT][ABORTED_MESSAGE_DROP] reason=missing-session-owner messageId=${messageId || 'null'}`);
            return;
        }
        this.client.removeMessageId(messageId);
        this.clientMessageIdMap.delete(messageId);
        this.pendingAssistantTmpKeyByLocalKey.delete(messageId);
        this.rawUserTextByLocalKey.delete(messageId);
        this.rawUserTextByMsgId.delete(messageId);
        const tmpKey = this.pendingAssistantTmpKeyBySession.get(sessionId);
        if (tmpKey === messageId) {
            this.pendingAssistantTmpKeyBySession.delete(sessionId);
        }
        for (const [key, value] of this.clientMessageIdMap.entries()) {
            if (value === messageId) {
                this.clientMessageIdMap.delete(key);
            }
        }
        webview.postMessage({ type: 'removeMessage', messageId, sessionId });
    }

    private postAddResponse(webview: vscode.Webview, value: string, meta: { sessionId: string; operationId?: string }): void {
        const targetSessionId = meta.sessionId.trim();
        if (!targetSessionId) {
            this.uiDebugChannel.appendLine('[EXT][ADD_RESPONSE_DROP] reason=missing-session-owner');
            return;
        }
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

    private postMessageIndexMap(webview: vscode.Webview, sessionId: string): void {
        if (!sessionId) {
            this.uiDebugChannel.appendLine('[EXT][MESSAGE_INDEX_DROP] reason=missing-session-owner');
            return;
        }
        const map = this.client.getMessageIndexMap(sessionId);
        const liveWebview = this._view?.webview || webview;
        liveWebview.postMessage({
            type: 'messageIndexMap',
            map,
            sessionId
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
        const wordCompletionScriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "word-completion.bundle.js")
        );
        const undoScriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "undo.bundle.js")
        );
        const continuationScriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, "media", "continuation.bundle.js")
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
                        <button class="icon-btn" id="fork-session-btn" title="New branch from current session" aria-label="New branch from current session" disabled>
                            <svg width="16" height="16" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" fill="none" aria-hidden="true"><path d="M2.916 7.914V2.914h5M12.083 2.914h5v5M10 9.997v7.084M10 9.997 3.333 3.331M10 9.997l6.666-6.666" transform="translate(0 20) scale(1 -1)" stroke="currentColor" stroke-linecap="square"/></svg>
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
                    <div class="composer-input-layer">
                        <div class="word-completion-ghost hidden" id="word-completion-ghost" aria-hidden="true">
                            <span class="word-completion-prefix" id="word-completion-prefix"></span><span class="word-completion-suffix" id="word-completion-suffix"></span>
                        </div>
                        <textarea id="chat-input" placeholder="Ask anything..." autocomplete="off" spellcheck="true"></textarea>
                    </div>
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
                <script src="${wordCompletionScriptUri}"></script>
                <script src="${undoScriptUri}"></script>
                <script src="${continuationScriptUri}"></script>
                <script src="${scriptUri}"></script>
            </body>
            </html>`;
    }
}
