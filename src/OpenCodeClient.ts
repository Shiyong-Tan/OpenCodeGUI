import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as https from 'https';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import * as vscode from 'vscode';
import { GitUndoEngine } from './undo/GitUndoEngine';
import { normalizeTouchedFiles } from './undo/GitPathUtils';
import { GitCapabilities, FileChangeSpec } from './undo/types';

export type ModelInfo = {
    id: string;
    providerId: string;
    name: string;
    fullId: string;
    variants: string[];
    speedMultiplier?: string;
};

export type AgentInfo = {
    id: string;
    mode: string;
    hidden: boolean;
    description?: string;
};

export type ModelQuotaRow = {
    label: string;
    remainingPercent: number;
    resetText?: string;
};

export type ModelQuota = {
    providerId: string;
    modelId: string;
    summaryRemainingPercent: number;
    rows: ModelQuotaRow[];
    fetchedAt: number;
};

export type SessionInfo = {
    id: string;
    title: string;
    updated: string;
};

export type QuestionOverlayOption = {
    id: string;
    label: string;
};

export type QuestionOverlayPayload = {
    callId: string;
    requestId?: string;
    title: string;
    prompt: string;
    options: QuestionOverlayOption[];
    questions?: Array<{
        title: string;
        prompt: string;
        options: QuestionOverlayOption[];
        multiple?: boolean;
    }>;
};

export type PermissionReply = 'once' | 'always' | 'reject';

export type PermissionOverlayPayload = {
    sessionId: string;
    permissionId: string;
    requestId?: string;
    permission: string;
    patterns: string[];
    metadata?: any;
    toolCallId?: string;
};

export type ChatEvent = {
    type: 'text' | 'session' | 'raw' | 'permission' | 'diff' | 'message' | 'error' | 'tool' | 'toolPatch' | 'files' | 'assistantMessageMeta' | 'assistantPhase' | 'questionOverlay' | 'permissionRequest' | 'permissionReplied' | 'autoResumeStallWarn' | 'autoResumeStallClear' | 'autoResumeHardStop' | 'todoUpdate';
    text?: string;
    sessionId?: string;
    files?: FileSnapshot[];
    messageId?: string;
    messageIndex?: number;
    lastText?: string;
    assistantMsgId?: string;
    tmpKey?: string;
    callId?: string;
    requestId?: string;
    title?: string;
    prompt?: string;
    options?: QuestionOverlayOption[];
    questions?: Array<{
        title: string;
        prompt: string;
        options: QuestionOverlayOption[];
        multiple?: boolean;
    }>;
    permissionId?: string;
    permission?: string;
    patterns?: string[];
    response?: PermissionReply;
    metadata?: any;
    actionLabel?: string;
    secondaryActionLabel?: string;
    isSyntheticUser?: boolean;
    isStatusUpdate?: boolean;
    todos?: Array<{content: string; status: string; priority: string}>;
    tool?: string;
    toolState?: { status?: string; input?: any; output?: any };
    mode?: string;
    agent?: string;
    modelID?: string;
    providerID?: string;
    isDone?: boolean;
    phase?: 'assistant_progress' | 'assistant_final_candidate' | 'assistant_final_accepted';
    lane?: EventLane;
    source?: EventSource;
};
type PendingQuestionControl = {
    callId: string;
    requestId?: string;
    title: string;
    prompt: string;
    options: QuestionOverlayOption[];
    questions: Array<{
        title: string;
        prompt: string;
        options: QuestionOverlayOption[];
        multiple?: boolean;
    }>;
};

type QuestionListItem = {
    id: string;
    sessionID: string;
    questions: Array<{
        header: string;
        question: string;
        options: Array<{ label: string; description?: string }>;
        multiple?: boolean;
    }>;
    tool?: {
        messageID: string;
        callID: string;
    };
};

type PermissionListItem = {
    id: string;
    sessionID: string;
    permission?: string;
    patterns?: string[];
    metadata?: any;
    tool?: {
        messageID?: string;
        callID?: string;
    };
};

export type FileSnapshot = {
    filePath: string;
    relativePath?: string;
    type?: 'update' | 'create' | 'delete';
    diff?: string;
    before?: string;
    after?: string;
    existsBefore?: boolean;
    existsAfter?: boolean;
    additions?: number;
    deletions?: number;
};


export type ConflictDetail = {
    path: string;
    expectedExists: boolean;
    currentExists: boolean;
    diffText: string;
};

type Task1Metrics = {
    finalAcceptCount: number;
    finalAcceptLatencyTotalMs: number;
    falseDoneEvents: number;
    parentMismatchChecks: number;
    parentMismatchCount: number;
    resyncRecoveryAttempts: number;
    resyncRecoverySuccess: number;
};

type EventLane = 'main' | 'subagent' | 'unknown';

type NormalizedEvent = {
    type: string;
    sessionId?: string;
    messageId?: string;
    role?: string;
    parentId?: string;
    finish?: string;
    completedAt?: number;
    partType?: string;
    toolState?: string;
    source: EventSource;
    ts: number;
    lane: EventLane;
};


type TurnState = {
    pendingUserLocalKey?: string;
    pendingAssistantTmpKey?: string;
    assistantMsgId?: string;
    exportInFlight: boolean;
    exportResolved: boolean;
    resolvedUserMsgId?: string;
    lastResolvedAssistantMsgId?: string;
    turnMessageIds?: Set<string>;
};

type PendingTurnChanges = {
    turnKey: string;
    tmpKey?: string;
    changes: FileChangeSpec[];
    lastAssistantMsgId?: string;
};

type RevertedSegment = {
    isActive: boolean;
    discarded: boolean;
    startMessageId: string;
    startMessageIndex: number;
    endMessageId: string;
    endMessageIndex: number;
    opIds: string[];
    collapsed: boolean;
    conflicts: ConflictDetail[];
    messageIds?: string[];
    operationId?: string;
    startCommit?: string;
    startCommits?: string[];
    restoreCommit?: string;
    undoTargetCommit?: string;
    fileSet?: string[];
};

type EventSource = 'sse' | 'resync' | 'session-idle';
type ServerStatus = 'connected' | 'reconnecting' | 'error';

type ServerLock = {
    workspaceRoot: string;
    port: number;
    password: string;
    updatedAt: string;
};

type ServerConn = {
    host: string;
    port: number;
    baseUrl: string;
    authHeader: string;
    lock: ServerLock;
};

type AntigravityOAuthConstants = {
    clientId: string;
    clientSecret: string;
};

type PendingMainFinalGate = {
    messageId: string;
    messageIndex: number;
    parentId?: string;
    completedAt?: number;
    finish?: string;
    source: EventSource;
    createdAt: number;
};

export class OpenCodeClient {
    public static outputChannel = vscode.window.createOutputChannel("OpenCode CLI");
    private currentChild?: cp.ChildProcess;
    private serverProcess?: cp.ChildProcess;
    private serverBaseUrl?: string;
    private serverPort?: number;
    private serverStartPromise?: Promise<void>;
    private serverReadyPromise?: Promise<void>;
    private serverReadyResolve?: () => void;
    private serverReadyReject?: (error: Error) => void;
    private workspaceRoot: string;
    private storage?: vscode.Memento;
    private serverPid?: number;
    private serverPassword?: string;
    private serverLockCache?: { lock: ServerLock; baseUrl: string; authHeader: string; mtimeMs: number };
    private eventStreamAbort?: AbortController;
    private eventStreamActive = false;
    private eventStreamBackoffMs = 1000;
    private readonly eventListeners = new Set<(event: ChatEvent) => void>();
    private readonly serverLockDir = '.opencode';
    private readonly serverLockFile = 'server.lock.json';
    private readonly serverPortBase = 42000;
    private readonly serverPortRange = 256;
    private resolvedBin?: string;
    private useCmdWrapper = false;
    private currentSessionId?: string;
    private messageIndexById = new Map<string, number>();
    private messageOrder: string[] = [];
    private nextMessageIndex = 0;
    private internalMessageSeq = 0;
    private seqCounter = 0;
    private revertedSegment?: RevertedSegment;
    private uiDebugChannel?: vscode.OutputChannel;
    private turnStateBySession = new Map<string, TurnState>();
    private pendingTurnChangesBySession = new Map<string, PendingTurnChanges>();
    private turnWriteStateBySession = new Map<string, { turnKey: string; hasWrites: boolean }>();
    private gitUndo?: GitUndoEngine;
    private gitUndoAvailable = false;
    private sessionUndoEnabled = new Map<string, boolean>();
    private assistantTextLengths = new Map<string, number>();
    private assistantTextById = new Map<string, string>();
    private assistantHasDelta = new Set<string>();
    private assistantStatusCleared = new Set<string>();
    private messageRoleById = new Map<string, string>();
    private lastCwdBySession = new Map<string, string>();
    private canceledActiveTurnBySession = new Map<string, boolean>();
    private activeTurnOpIdBySession = new Map<string, string>();
    private pendingUserMsgIdBySession = new Map<string, string>();
    private pendingAssistantMsgIdBySession = new Map<string, string>();
    private currentTurnUserMsgIdBySession = new Map<string, string>();
    private displayTurnUserMsgIdBySession = new Map<string, string>();
    private currentTurnAssistantMsgIdBySession = new Map<string, string>();
    private currentTurnStartedAtBySession = new Map<string, number>();
    private lastSseAtBySession = new Map<string, number>();
    private lastObservedMsgIdBySession = new Map<string, string>();
    private lastProgressAtBySession = new Map<string, number>();
    private lastProgressKeyBySession = new Map<string, string>();
    private noProgressEpochsBySession = new Map<string, number>();
    private noProgressSinceBySession = new Map<string, number>();
    private autoResumeCountBySession = new Map<string, number>();
    private stallWarnedBySession = new Set<string>();
    private awaitingAutoResumeUserAnchorBySession = new Set<string>();
    private silenceTimerBySession = new Map<string, NodeJS.Timeout>();
    private turnFinalAtBySession = new Map<string, number>();
    private turnFinalMsgIdBySession = new Map<string, string>();
    private finalizingMsgIdBySession = new Map<string, string>();
    private turnFinalQuietTimersBySession = new Map<string, NodeJS.Timeout>();
    private readonly expectedMainAgentBySession = new Map<string, string>();
    private readonly mainFinalDelayMs = 5000;
    private readonly pendingMainFinalGateBySession = new Map<string, PendingMainFinalGate>();
    private readonly pendingMainFinalTimerBySession = new Map<string, NodeJS.Timeout>();
    private readonly finishedMainAgentBySession = new Map<string, string>();
    private readonly finishedTurnAtBySession = new Map<string, number>();
    private readonly lateContinuationGuardWindowMs = 30000;
    private readonly sessionIdleReceivedBySession = new Set<string>();
    private turnFinalWaitersBySession = new Map<string, Array<() => void>>();
    private turnFinalResolvedBySession = new Set<string>();
    private turnFinalSourceBySession = new Map<string, EventSource>();
    private turnRescueTimerBySession = new Map<string, NodeJS.Timeout>();
    private turnRescueRunIdBySession = new Map<string, number>();
    private turnResyncLoopTimerBySession = new Map<string, NodeJS.Timeout>();
    private turnSseDrainTimerBySession = new Map<string, NodeJS.Timeout>();
    private turnSseTextAtBySession = new Map<string, number>();
    private turnSettleAttemptsBySession = new Map<string, number>();
    private turnSettleLastLenBySession = new Map<string, number>();
    private turnSettleStableCountBySession = new Map<string, number>();
    private turnSettleLastFingerprintBySession = new Map<string, string>();
    private turnSettleNoDeltaCountBySession = new Map<string, number>();
    private rescueResumeAtBySession = new Map<string, number>();
    private turnRecoveryModeBySession = new Map<string, 'sse' | 'resync'>();
    private turnResyncEpochBySession = new Map<string, number>();
    private toolRunningByMessageId = new Map<string, number>();
    private toolStatusBySession = new Map<string, Map<string, string>>();
    private modelQuotaInFlight = new Map<string, Promise<ModelQuota | null>>();
    private modelQuotaCache = new Map<string, { ts: number; quota: ModelQuota | null }>();
    private antigravityOAuthConstantsPromise?: Promise<AntigravityOAuthConstants | null>;
    private resyncInFlightBySession = new Map<string, Promise<void>>();
    private resyncCooldownUntilBySession = new Map<string, number>();
    private finalMetaSeenKeysBySession = new Map<string, Set<string>>();
    private phaseSeenKeysBySession = new Map<string, Set<string>>();
    private assistantPhaseByMessageId = new Map<string, 'assistant_progress' | 'assistant_final_candidate' | 'assistant_final_accepted'>();
    private assistantFinalCandidateAtByMessageId = new Map<string, number>();
    private task1Metrics: Task1Metrics = {
        finalAcceptCount: 0,
        finalAcceptLatencyTotalMs: 0,
        falseDoneEvents: 0,
        parentMismatchChecks: 0,
        parentMismatchCount: 0,
        resyncRecoveryAttempts: 0,
        resyncRecoverySuccess: 0
    };
    private questionOverlaySeen = new Set<string>();
    private pendingQuestionsBySession = new Map<string, Map<string, PendingQuestionControl>>();
    private pendingQuestionCallIdsBySession = new Map<string, Set<string>>();
    private pendingPermissionIdsBySession = new Map<string, Set<string>>();
    private ignoredSummaryMessageIdsBySession = new Map<string, Set<string>>();
    private subagentToParentSessionMap = new Map<string, string>();
    private lateDiffGraceBySession = new Map<string, { expiresAt: number; timer?: ReturnType<typeof setTimeout> }>();
    private changeListEmittedBySession = new Map<string, boolean>();
    private lastTurnCommitBaseBySession = new Map<string, string>();
    private readonly resyncCooldownMs = 500;
    private readonly silenceWindowMs = 1800;
    private readonly finalQuietWindowMs = 300;
    private readonly finalBackfillDeltaMs = 500;
    private readonly lateDiffGraceMs = 300;
    private readonly rescueStartDelayMs = 20000;
    private readonly resyncLoopDelayMs = 20000;
    private readonly sseDrainQuietMs = 800;
    private readonly sseDrainPass2DelayMs = 1000;
    private readonly settleNoDeltaThreshold = 3;
    private readonly autoResumePrompt = '[OC_UI_AUTORESUME v1]\nRe-read the last user request and finish the remaining steps.';
    private readonly stopContinuationPrompt = '/stop-continuation';
    private readonly autoResumeEpochThreshold = 5;
    private readonly autoResumeStallMs = 100000;
    private readonly autoResumeWarnMs = 180000;
    private readonly quotaCacheTtlMs = 15000;
    private readonly assistantTextCacheMax = 4000;
    private serverStatus: ServerStatus = 'connected';
    private serverStatusHandler?: (status: ServerStatus, reason?: string) => void;
    private eventStreamFailCount = 0;
    private eventStreamFailureInFlight = false;
    private lastRestartAt = 0;
    private restartWindowStart = 0;
    private restartAttemptCount = 0;
    private readonly restartCooldownMs = 60000;
    private readonly maxRestartsPerWindow = 3;
    private readonly turnAnchorOverrideWindowMs = 120000;
    private readonly groupedResyncActivityEnabled = false;
    private readonly replayMirroredChangeIdsBySession = new Map<string, Set<string>>();

    public resetSessionState(): void {
        this.currentSessionId = undefined;
        this.messageIndexById.clear();
        this.messageOrder = [];
        this.nextMessageIndex = 0;
        this.internalMessageSeq = 0;
        this.seqCounter = 0;
        this.revertedSegment = undefined;
        this.turnStateBySession.clear();
        this.pendingTurnChangesBySession.clear();
        this.sessionUndoEnabled.clear();
        this.assistantTextLengths.clear();
        this.assistantTextById.clear();
        this.assistantHasDelta.clear();
        this.assistantStatusCleared.clear();
        this.messageRoleById.clear();
        this.lastCwdBySession.clear();
        this.canceledActiveTurnBySession.clear();
        this.activeTurnOpIdBySession.clear();
        this.pendingUserMsgIdBySession.clear();
        this.pendingAssistantMsgIdBySession.clear();
        this.currentTurnUserMsgIdBySession.clear();
        this.displayTurnUserMsgIdBySession.clear();
        this.currentTurnAssistantMsgIdBySession.clear();
        this.currentTurnStartedAtBySession.clear();
        this.lastSseAtBySession.clear();
        this.lastObservedMsgIdBySession.clear();
        this.lastProgressAtBySession.clear();
        this.lastProgressKeyBySession.clear();
        this.noProgressEpochsBySession.clear();
        this.noProgressSinceBySession.clear();
        this.autoResumeCountBySession.clear();
        this.stallWarnedBySession.clear();
        this.awaitingAutoResumeUserAnchorBySession.clear();
        this.clearSilenceTimers();
        this.clearTurnFinals();
        this.turnFinalResolvedBySession.clear();
        this.turnFinalSourceBySession.clear();
        this.clearRescueTimers();
        this.clearResyncLoopTimers();
        this.clearSseDrainTimers();
        this.turnSseTextAtBySession.clear();
        this.turnSettleAttemptsBySession.clear();
        this.turnSettleLastLenBySession.clear();
        this.turnSettleStableCountBySession.clear();
        this.turnSettleLastFingerprintBySession.clear();
        this.turnSettleNoDeltaCountBySession.clear();
        this.rescueResumeAtBySession.clear();
        this.turnRecoveryModeBySession.clear();
        this.turnResyncEpochBySession.clear();
        this.toolRunningByMessageId.clear();
        this.toolStatusBySession.clear();
        this.resyncInFlightBySession.clear();
        this.resyncCooldownUntilBySession.clear();
        this.finalMetaSeenKeysBySession.clear();
        this.phaseSeenKeysBySession.clear();
        this.assistantPhaseByMessageId.clear();
        this.assistantFinalCandidateAtByMessageId.clear();
        this.task1Metrics = {
            finalAcceptCount: 0,
            finalAcceptLatencyTotalMs: 0,
            falseDoneEvents: 0,
            parentMismatchChecks: 0,
            parentMismatchCount: 0,
            resyncRecoveryAttempts: 0,
            resyncRecoverySuccess: 0
        };
        this.questionOverlaySeen.clear();
        this.pendingQuestionsBySession.clear();
        this.pendingQuestionCallIdsBySession.clear();
        this.pendingPermissionIdsBySession.clear();
        this.ignoredSummaryMessageIdsBySession.clear();
        for (const entry of this.lateDiffGraceBySession.values()) {
            if (entry.timer) {
                clearTimeout(entry.timer);
            }
        }
        this.lateDiffGraceBySession.clear();
        this.changeListEmittedBySession.clear();
        this.replayMirroredChangeIdsBySession.clear();
    }

    constructor() {
        this.workspaceRoot = this.resolveWorkspaceRoot();
        this.gitUndo = new GitUndoEngine(this.workspaceRoot, (message) => this.logUiDebug(message));
    }

    public getWorkspaceRoot(): string {
        return this.workspaceRoot;
    }

    public setWorkspaceRoot(newRoot: string): void {
        if (!newRoot || newRoot === this.workspaceRoot) return;
        this.workspaceRoot = newRoot;
        this.gitUndo = new GitUndoEngine(this.workspaceRoot, (message) => this.logUiDebug(message));
        this.gitUndoAvailable = false;
        this.serverProcess = undefined;
        this.serverBaseUrl = undefined;
        this.serverPort = undefined;
        this.serverPid = undefined;
        this.serverPassword = undefined;
        this.serverStartPromise = undefined;
        this.serverReadyPromise = undefined;
        this.serverReadyResolve = undefined;
        this.serverReadyReject = undefined;
        this.eventStreamAbort?.abort();
        this.eventStreamActive = false;
    }

    public getServerPid(): number | undefined {
        return this.serverProcess?.pid || this.serverPid;
    }


    public setStorage(storage: vscode.Memento): void {
        this.storage = storage;
    }

    public async ensureServer(): Promise<void> {
        if (this.serverBaseUrl) {
            await this.waitForServerReady();
            if (!this.eventStreamActive) {
                this.connectEventStream();
            }
            return;
        }
        if (!this.serverStartPromise) {
            this.serverStartPromise = this.ensureServerForWorkspace(this.workspaceRoot, 'ensure');
        }
        try {
            await this.serverStartPromise;
        } catch (error) {
            this.serverStartPromise = undefined;
            throw error;
        }
        await this.waitForServerReady();
        if (!this.eventStreamActive) {
            this.connectEventStream();
        }
    }

    public setUiDebugChannel(channel: vscode.OutputChannel): void {
        this.uiDebugChannel = channel;
    }

    public async initGitUndo(): Promise<GitCapabilities> {
        if (!this.gitUndo) {
            return { gitAvailable: false, reason: 'missing-engine' };
        }
        const capabilities = await this.gitUndo.detectGitCapabilities();
        this.gitUndoAvailable = Boolean(capabilities.gitAvailable);
        return capabilities;
    }

    public async ensureBaselineReady(sessionId: string, turnKey?: string): Promise<{ ok: boolean; reason?: string }> {
        if (!this.gitUndoAvailable || !this.gitUndo) {
            return { ok: false, reason: 'git-unavailable' };
        }
        return this.gitUndo.ensureBaselineReady(sessionId, turnKey);
    }

    public async ensureBaselineForTurn(turnKey: string): Promise<{ ok: boolean; reason?: string }> {
        if (!this.gitUndoAvailable || !this.gitUndo) {
            return { ok: false, reason: 'git-unavailable' };
        }
        return this.gitUndo.ensureBaselineForTurn(turnKey);
    }

    public isGitUndoEnabled(): boolean {
        return this.gitUndoAvailable;
    }

    public setSessionUndoEnabled(sessionId: string, enabled: boolean): void {
        if (!sessionId) return;
        this.sessionUndoEnabled.set(sessionId, enabled);
    }

    public isSessionUndoEnabled(sessionId: string | undefined): boolean {
        if (!sessionId) return false;
        if (!this.gitUndoAvailable) return false;
        if (!this.sessionUndoEnabled.has(sessionId)) return true;
        return this.sessionUndoEnabled.get(sessionId) !== false;
    }

    public setPendingAssistantTmpKey(sessionId: string, tmpKey: string): void {
        if (!sessionId || !tmpKey) return;
        if (!tmpKey.startsWith('tmp:') && !tmpKey.startsWith('local-')) return;
        const existing = this.turnStateBySession.get(sessionId);
        if (existing) {
            existing.pendingAssistantTmpKey = tmpKey;
            return;
        }
        this.turnStateBySession.set(sessionId, {
            pendingUserLocalKey: undefined,
            pendingAssistantTmpKey: tmpKey,
            assistantMsgId: undefined,
            exportInFlight: false,
            exportResolved: false,
            resolvedUserMsgId: undefined,
            lastResolvedAssistantMsgId: undefined,
            turnMessageIds: new Set()
        });
    }

    private logUiDebug(message: string): void {
        if (this.uiDebugChannel) {
            this.uiDebugChannel.appendLine(message);
        }
    }

    public setServerStatusHandler(handler: (status: ServerStatus, reason?: string) => void): void {
        this.serverStatusHandler = handler;
        handler(this.serverStatus, 'init');
    }

    private updateServerStatus(status: ServerStatus, reason?: string): void {
        if (this.serverStatus === status) return;
        this.serverStatus = status;
        this.serverStatusHandler?.(status, reason);
    }

    private clearSilenceTimer(sessionId: string): void {
        const timer = this.silenceTimerBySession.get(sessionId);
        if (timer) {
            clearTimeout(timer);
            this.silenceTimerBySession.delete(sessionId);
        }
    }

    private clearSilenceTimers(): void {
        for (const timer of this.silenceTimerBySession.values()) {
            clearTimeout(timer);
        }
        this.silenceTimerBySession.clear();
    }

    private clearTurnFinals(): void {
        for (const timer of this.turnFinalQuietTimersBySession.values()) {
            clearTimeout(timer);
        }
        this.turnFinalQuietTimersBySession.clear();
        for (const timer of this.pendingMainFinalTimerBySession.values()) {
            clearTimeout(timer);
        }
        this.pendingMainFinalTimerBySession.clear();
        this.pendingMainFinalGateBySession.clear();
        this.finishedMainAgentBySession.clear();
        this.finishedTurnAtBySession.clear();
        this.turnFinalAtBySession.clear();
        this.turnFinalMsgIdBySession.clear();
        this.finalizingMsgIdBySession.clear();
        this.turnFinalWaitersBySession.clear();
    }

    private clearRescueTimers(): void {
        for (const timer of this.turnRescueTimerBySession.values()) {
            clearTimeout(timer);
        }
        this.turnRescueTimerBySession.clear();
        this.turnRescueRunIdBySession.clear();
    }

    private clearResyncLoopTimers(): void {
        for (const timer of this.turnResyncLoopTimerBySession.values()) {
            clearTimeout(timer);
        }
        this.turnResyncLoopTimerBySession.clear();
    }

    private clearSseDrainTimers(): void {
        for (const timer of this.turnSseDrainTimerBySession.values()) {
            clearTimeout(timer);
        }
        this.turnSseDrainTimerBySession.clear();
    }

    private clearFinalizeSessionState(sessionId: string, reason: 'turn-start' | 'turn-finish'): void {
        this.clearPendingMainFinalGate(sessionId, `clear:${reason}`);
        this.turnFinalAtBySession.delete(sessionId);
        this.turnFinalMsgIdBySession.delete(sessionId);
        this.finalizingMsgIdBySession.delete(sessionId);
        this.turnFinalResolvedBySession.delete(sessionId);
        this.turnFinalSourceBySession.delete(sessionId);
        this.turnSseTextAtBySession.delete(sessionId);
        this.turnSettleAttemptsBySession.delete(sessionId);
        this.turnSettleLastLenBySession.delete(sessionId);
        this.turnSettleStableCountBySession.delete(sessionId);
        this.turnSettleLastFingerprintBySession.delete(sessionId);
        this.turnSettleNoDeltaCountBySession.delete(sessionId);
        this.rescueResumeAtBySession.delete(sessionId);
        this.expectedMainAgentBySession.delete(sessionId);
        this.sessionIdleReceivedBySession.delete(sessionId);
        this.turnRecoveryModeBySession.delete(sessionId);
        this.turnResyncEpochBySession.delete(sessionId);
        this.lastProgressAtBySession.delete(sessionId);
        this.lastProgressKeyBySession.delete(sessionId);
        this.noProgressEpochsBySession.delete(sessionId);
        this.noProgressSinceBySession.delete(sessionId);
        this.autoResumeCountBySession.delete(sessionId);
        this.stallWarnedBySession.delete(sessionId);
        this.awaitingAutoResumeUserAnchorBySession.delete(sessionId);
        this.stopNonFinalResyncLoop(sessionId, `clear:${reason}`);

        const finalTimer = this.turnFinalQuietTimersBySession.get(sessionId);
        if (finalTimer) {
            clearTimeout(finalTimer);
            this.turnFinalQuietTimersBySession.delete(sessionId);
        }
        const sseDrain = this.turnSseDrainTimerBySession.get(sessionId);
        if (sseDrain) {
            clearTimeout(sseDrain);
            this.turnSseDrainTimerBySession.delete(sessionId);
        }
        this.turnFinalWaitersBySession.delete(sessionId);
        this.stopRescueWatchdog(sessionId, reason);

        this.pendingQuestionCallIdsBySession.delete(sessionId);
        this.pendingPermissionIdsBySession.delete(sessionId);
        this.toolStatusBySession.delete(sessionId);
    }

    private isDelayedMainFinalMode(sessionId: string | undefined): boolean {
        if (!sessionId) return false;
        const mode = (this.expectedMainAgentBySession.get(sessionId) || '').toLowerCase();
        if (!mode) return false;
        return mode.includes('sisyphus') || mode.includes('hephaestus') || mode.includes('atlas') || mode.includes('build');
    }

    private isOmoContinuationText(text: string): boolean {
        if (!text) return false;
        if (!text.includes('<!-- OMO_INTERNAL_INITIATOR -->')) return false;
        return text.includes('[SYSTEM DIRECTIVE: OH-MY-OPENCODE - BOULDER CONTINUATION]')
            || text.includes('[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]');
    }

    private isStopContinuationPromptText(text: unknown): boolean {
        return typeof text === 'string'
            && (
                text.trim() === this.stopContinuationPrompt
                || (text.includes('<auto-slash-command>') && text.includes('/stop-continuation Command'))
                || (text.includes('<command-instruction>') && text.toLowerCase().includes('stop all continuation mechanisms'))
            );
    }

    private shouldStopLateBoulderContinuation(sessionId: string | undefined): boolean {
        if (!sessionId) return false;
        if (this.turnStateBySession.has(sessionId)) return false;
        const mode = (this.finishedMainAgentBySession.get(sessionId) || '').toLowerCase();
        if (!mode) return false;
        const eligible = mode.includes('sisyphus') || mode.includes('hephaestus') || mode.includes('atlas') || mode.includes('build');
        if (!eligible) return false;
        const finishedAt = this.finishedTurnAtBySession.get(sessionId) || 0;
        if (!finishedAt) return false;
        return (Date.now() - finishedAt) <= this.lateContinuationGuardWindowMs;
    }

    private shouldSendStopContinuationOnFinal(sessionId: string | undefined, source: EventSource): boolean {
        if (!sessionId) return false;
        if (source !== 'sse') return false;
        return this.isDelayedMainFinalMode(sessionId);
    }

    private async sendStopContinuationPrompt(sessionId: string): Promise<boolean> {
        if (!sessionId) return false;
        try {
            const agentMode =
                this.finishedMainAgentBySession.get(sessionId)
                || this.expectedMainAgentBySession.get(sessionId)
                || 'plan';
            const payload: any = {
                parts: [{ type: 'text', text: this.stopContinuationPrompt }],
                agent: agentMode
            };
            await this.requestJson('POST', `/session/${sessionId}/prompt_async`, payload);
            this.logUiDebug(`EXT: continuation.stop.sent | sessionId=${sessionId} | agent=${agentMode}`);
            return true;
        } catch (error) {
            this.logUiDebug(`EXT: continuation.stop.fail | sessionId=${sessionId} | err=${String(error)}`);
            return false;
        }
    }

    private clearPendingMainFinalGate(sessionId: string | undefined, reason: string): void {
        if (!sessionId) return;
        const timer = this.pendingMainFinalTimerBySession.get(sessionId);
        if (timer) {
            clearTimeout(timer);
            this.pendingMainFinalTimerBySession.delete(sessionId);
        }
        const pending = this.pendingMainFinalGateBySession.get(sessionId);
        if (pending) {
            this.pendingMainFinalGateBySession.delete(sessionId);
            this.logUiDebug(`EXT: turn.final.pending.clear | sessionId=${sessionId} | msgId=${pending.messageId} | reason=${reason}`);
        }
    }

    private emitAcceptedFinalMetaNow(
        sessionId: string,
        messageId: string,
        messageIndex: number,
        source: EventSource,
        parentId: string | undefined,
        completedAt: number | undefined,
        finish: string | undefined,
        lane: EventLane,
        reason: string
    ): void {
        const phase = lane === 'subagent' ? 'subagent-final-accepted' : 'turn-final-accepted';
        const shouldEmit = source === 'sse' && this.shouldEmitFinalMeta(sessionId, messageId, completedAt, finish, source);
        if (!shouldEmit) return;
        if (!this.consumePhaseOnce(sessionId, messageId, phase)) return;
        const out: ChatEvent[] = [];
        this.emitAssistantPhase(out, {
            sessionId,
            messageId,
            parentId,
            source,
            lane,
            phase: 'assistant_final_accepted',
            reason
        });
        out.push({
            type: 'assistantMessageMeta',
            sessionId,
            assistantMsgId: messageId,
            messageId,
            messageIndex,
            tmpKey: this.getPendingAssistantTmpKey(sessionId),
            source,
        });
        this.emitChatEvents(out);
    }

    private armPendingMainFinalGate(
        sessionId: string,
        payload: PendingMainFinalGate
    ): void {
        this.clearPendingMainFinalGate(sessionId, 'replace');
        this.pendingMainFinalGateBySession.set(sessionId, payload);
        this.logUiDebug(`EXT: turn.final.pending.start | sessionId=${sessionId} | msgId=${payload.messageId} | delayMs=${this.mainFinalDelayMs}`);
        const timer = setTimeout(() => {
            this.pendingMainFinalTimerBySession.delete(sessionId);
            const pending = this.pendingMainFinalGateBySession.get(sessionId);
            if (!pending || pending.messageId !== payload.messageId) return;
            this.pendingMainFinalGateBySession.delete(sessionId);
            if (!this.turnStateBySession.has(sessionId) || this.turnFinalResolvedBySession.has(sessionId)) {
                this.logUiDebug(`EXT: turn.final.pending.drop | sessionId=${sessionId} | msgId=${payload.messageId} | reason=state-closed`);
                return;
            }
            this.logUiDebug(`EXT: turn.final.pending.timeout-accept | sessionId=${sessionId} | msgId=${payload.messageId}`);
            this.markTurnFinal(sessionId, payload.messageId, payload.source);
            this.emitAcceptedFinalMetaNow(
                sessionId,
                payload.messageId,
                payload.messageIndex,
                payload.source,
                payload.parentId,
                payload.completedAt,
                payload.finish,
                'main',
                'turn-final-accepted-delayed'
            );
        }, this.mainFinalDelayMs);
        this.pendingMainFinalTimerBySession.set(sessionId, timer);
    }

    public startTurn(sessionId: string, pendingUserLocalKey: string): void {
        if (!sessionId) return;
        this.changeListEmittedBySession.delete(sessionId);
        this.canceledActiveTurnBySession.set(sessionId, false);
        this.finishedMainAgentBySession.delete(sessionId);
        this.finishedTurnAtBySession.delete(sessionId);
        this.currentTurnUserMsgIdBySession.delete(sessionId);
        this.displayTurnUserMsgIdBySession.delete(sessionId);
        this.currentTurnAssistantMsgIdBySession.delete(sessionId);
        this.clearFinalizeSessionState(sessionId, 'turn-start');
        const now = Date.now();
        this.currentTurnStartedAtBySession.set(sessionId, now);
        this.lastSseAtBySession.set(sessionId, now);
        this.lastProgressAtBySession.set(sessionId, now);
        this.lastProgressKeyBySession.delete(sessionId);
        this.noProgressEpochsBySession.set(sessionId, 0);
        this.noProgressSinceBySession.delete(sessionId);
        this.autoResumeCountBySession.set(sessionId, 0);
        this.stallWarnedBySession.delete(sessionId);
        this.turnRecoveryModeBySession.set(sessionId, 'sse');
        this.turnResyncEpochBySession.set(sessionId, 0);
        const pending = this.pendingTurnChangesBySession.get(sessionId);
        if (pending?.changes?.length) {
            // this.logUiDebug(`[DBG_TURN_START] session=${sessionId} pendingChanges=${pending.changes.length} cleared=true`);
            this.pendingTurnChangesBySession.delete(sessionId);
        }
        const existing = this.turnStateBySession.get(sessionId);
        this.turnStateBySession.set(sessionId, {
            pendingUserLocalKey,
            pendingAssistantTmpKey: undefined,
            assistantMsgId: undefined,
            exportInFlight: false,
            exportResolved: false,
            resolvedUserMsgId: undefined,
            lastResolvedAssistantMsgId: undefined,
            turnMessageIds: new Set()
        });
        this.turnWriteStateBySession.set(sessionId, { turnKey: pendingUserLocalKey, hasWrites: false });
        this.scheduleSilenceResync(sessionId);
        // this.logUiDebug(`[DBG_TURN_START] session=${sessionId} userLocal=${pendingUserLocalKey || 'null'}`);
    }

    public startTurnWithOp(sessionId: string, pendingUserLocalKey: string, opId?: string): void {
        if (!sessionId) return;
        this.startTurn(sessionId, pendingUserLocalKey);
        this.pendingUserMsgIdBySession.delete(sessionId);
        this.pendingAssistantMsgIdBySession.delete(sessionId);
        if (opId && typeof opId === 'string') {
            this.activeTurnOpIdBySession.set(sessionId, opId);
        }
    }

    public cancelTurn(sessionId: string, opId?: string): void {
        if (!sessionId) return;
        this.canceledActiveTurnBySession.set(sessionId, true);
        if (opId && typeof opId === 'string') {
            this.activeTurnOpIdBySession.set(sessionId, opId);
        }
    }

    public markChangeListEmitted(sessionId: string, reason: string): boolean {
        if (!sessionId) return false;
        if (this.changeListEmittedBySession.get(sessionId)) {
            this.logUiDebug(`[LATE_DIFF] change-list already emitted | sessionId=${sessionId} skipping=true reason=${reason}`);
            return false;
        }
        this.changeListEmittedBySession.set(sessionId, true);
        this.logUiDebug(`[LATE_DIFF] change-list marked emitted | sessionId=${sessionId} reason=${reason}`);
        return true;
    }

    public wasChangeListEmitted(sessionId: string): boolean {
        if (!sessionId) return false;
        return this.changeListEmittedBySession.get(sessionId) === true;
    }

    public beginLateDiffGrace(sessionId: string): boolean {
        if (!sessionId) return false;
        if (this.lateDiffGraceBySession.has(sessionId)) {
            return true;
        }
        const expiresAt = Date.now() + this.lateDiffGraceMs;
        const timer = setTimeout(() => {
            this.lateDiffGraceBySession.delete(sessionId);
            this.logUiDebug(`[LATE_DIFF] grace expired | sessionId=${sessionId}`);
        }, this.lateDiffGraceMs);
        this.lateDiffGraceBySession.set(sessionId, { expiresAt, timer });
        this.logUiDebug(`[LATE_DIFF] finishTurn called | sessionId=${sessionId} gracePeriod=${this.lateDiffGraceMs}ms`);
        return true;
    }

    public isInLateDiffGrace(sessionId: string): boolean {
        if (!sessionId) return false;
        const entry = this.lateDiffGraceBySession.get(sessionId);
        if (!entry) return false;
        if (Date.now() <= entry.expiresAt) return true;
        if (entry.timer) {
            clearTimeout(entry.timer);
        }
        this.lateDiffGraceBySession.delete(sessionId);
        return false;
    }

    public finishTurn(sessionId: string): void {
        if (!sessionId) return;
        const finishedMode = this.expectedMainAgentBySession.get(sessionId);
        if (finishedMode) {
            this.finishedMainAgentBySession.set(sessionId, finishedMode);
            this.finishedTurnAtBySession.set(sessionId, Date.now());
        } else {
            this.finishedMainAgentBySession.delete(sessionId);
            this.finishedTurnAtBySession.delete(sessionId);
        }
        const avgFinalAcceptLatencyMs = this.task1Metrics.finalAcceptCount > 0
            ? Math.round(this.task1Metrics.finalAcceptLatencyTotalMs / this.task1Metrics.finalAcceptCount)
            : 0;
        const parentMismatchRate = this.task1Metrics.parentMismatchChecks > 0
            ? (this.task1Metrics.parentMismatchCount / this.task1Metrics.parentMismatchChecks)
            : 0;
        const falseDoneRate = this.task1Metrics.finalAcceptCount > 0
            ? (this.task1Metrics.falseDoneEvents / this.task1Metrics.finalAcceptCount)
            : 0;
        const resyncRecoveryRate = this.task1Metrics.resyncRecoveryAttempts > 0
            ? (this.task1Metrics.resyncRecoverySuccess / this.task1Metrics.resyncRecoveryAttempts)
            : 0;
        this.logUiDebug(
            `EXT: metrics.task1 | sessionId=${sessionId} | final_accept_latency_ms=${avgFinalAcceptLatencyMs} | false_done_rate=${falseDoneRate.toFixed(4)} | parent_mismatch_rate=${parentMismatchRate.toFixed(4)} | resync_recovery_rate=${resyncRecoveryRate.toFixed(4)}`
        );
        this.beginLateDiffGrace(sessionId);
        this.turnStateBySession.delete(sessionId);
        this.pendingTurnChangesBySession.delete(sessionId);
        this.turnWriteStateBySession.delete(sessionId);
        this.activeTurnOpIdBySession.delete(sessionId);
        this.canceledActiveTurnBySession.delete(sessionId);
        this.pendingUserMsgIdBySession.delete(sessionId);
        this.pendingAssistantMsgIdBySession.delete(sessionId);
        this.currentTurnUserMsgIdBySession.delete(sessionId);
        this.displayTurnUserMsgIdBySession.delete(sessionId);
        this.currentTurnAssistantMsgIdBySession.delete(sessionId);
        this.currentTurnStartedAtBySession.delete(sessionId);
        this.lastSseAtBySession.delete(sessionId);
        this.clearSilenceTimer(sessionId);
        this.clearFinalizeSessionState(sessionId, 'turn-finish');
        // this.logUiDebug(`[DBG_TURN_END] session=${sessionId}`);
    }

    private getTurnKeyForSession(sessionId: string): string | undefined {
        const state = this.turnStateBySession.get(sessionId);
        return state?.pendingUserLocalKey || sessionId;
    }

    private markTurnHasWrites(sessionId: string, reason?: string): void {
        if (!sessionId) return;
        const turnKey = this.getTurnKeyForSession(sessionId);
        if (!turnKey) return;
        const existing = this.turnWriteStateBySession.get(sessionId);
        if (!existing || existing.turnKey !== turnKey) {
            this.turnWriteStateBySession.set(sessionId, { turnKey, hasWrites: true });
        } else if (!existing.hasWrites) {
            existing.hasWrites = true;
        }
        if (reason) {
            this.logUiDebug(`EXT: turn.write | sessionId=${sessionId} | turnKey=${turnKey} | reason=${reason}`);
        }
    }

    public hasActiveTurnWrites(sessionId: string): boolean {
        if (!sessionId) return false;
        const turnKey = this.getTurnKeyForSession(sessionId);
        if (!turnKey) return false;
        const state = this.turnWriteStateBySession.get(sessionId);
        if (!state || state.turnKey !== turnKey) return false;
        return state.hasWrites === true;
    }

    public hasPendingTurnChanges(sessionId: string): boolean {
        if (!sessionId) return false;
        const pending = this.pendingTurnChangesBySession.get(sessionId);
        return Boolean(pending?.changes?.length);
    }

    /**
     * Get all related session IDs for grouped diff gating.
     * Returns the session ID plus any mapped subagents (if parent) or the parent (if subagent).
     * Used to check if any session in the group has active writes or pending changes.
     * @param sessionId - The session ID to query (can be parent or subagent)
     * @returns Array of related session IDs [sessionId, ...subagentIds] or [sessionId, parentId]
     */
    public getRelatedSessionIds(sessionId: string): string[] {
        if (!sessionId) return [];
        
        // Check if this is a subagent session - if so, include parent
        const parentId = this.subagentToParentSessionMap.get(sessionId);
        if (parentId) {
            return [sessionId, parentId];
        }
        
        // Check if this is a parent session - if so, include all subagents
        const subagentIds: string[] = [];
        for (const [subagentId, mappedParentId] of this.subagentToParentSessionMap.entries()) {
            if (mappedParentId === sessionId) {
                subagentIds.push(subagentId);
            }
        }
        
        if (subagentIds.length > 0) {
            return [sessionId, ...subagentIds];
        }
        
        // No associations - return just this session
        return [sessionId];
    }

    /**
     * Check if session OR any related session (parent/subagent) has active turn writes.
     * Used for grouped diff gating to allow diffs when any session in the group is active.
     * @param sessionId - The session ID to check (can be parent or subagent)
     * @returns true if any related session has active turn writes
     */
    public hasGroupedActiveTurnWrites(sessionId: string): boolean {
        const relatedIds = this.getRelatedSessionIds(sessionId);
        this.logUiDebug(`[DIFF_GATE] hasGroupedActiveTurnWrites | sessionId=${sessionId} relatedCount=${relatedIds.length} relatedIds=[${relatedIds.join(',')}]`);
        for (const id of relatedIds) {
            const hasWrites = this.hasActiveTurnWrites(id);
            this.logUiDebug(`[DIFF_GATE] check session | sessionId=${id} hasActiveTurnWrites=${hasWrites}`);
            if (hasWrites) {
                this.logUiDebug(`[DIFF_GATE] decision | sessionId=${sessionId} action=allow reason=grouped-active-turn-writes contributingSession=${id}`);
                return true;
            }
        }
        this.logUiDebug(`[DIFF_GATE] decision | sessionId=${sessionId} action=deny reason=no-grouped-active-turn-writes`);
        return false;
    }

    /**
     * Check if session OR any related session (parent/subagent) has pending turn changes.
     * Used for grouped diff gating to allow diffs when any session in the group has pending changes.
     * @param sessionId - The session ID to check (can be parent or subagent)
     * @returns true if any related session has pending turn changes
     */
    public hasGroupedPendingTurnChanges(sessionId: string): boolean {
        const relatedIds = this.getRelatedSessionIds(sessionId);
        this.logUiDebug(`[DIFF_GATE] hasGroupedPendingTurnChanges | sessionId=${sessionId} relatedCount=${relatedIds.length} relatedIds=[${relatedIds.join(',')}]`);
        for (const id of relatedIds) {
            const hasPending = this.hasPendingTurnChanges(id);
            this.logUiDebug(`[DIFF_GATE] check session | sessionId=${id} hasPendingTurnChanges=${hasPending}`);
            if (hasPending) {
                this.logUiDebug(`[DIFF_GATE] decision | sessionId=${sessionId} action=allow reason=grouped-pending-turn-changes contributingSession=${id}`);
                return true;
            }
        }
        this.logUiDebug(`[DIFF_GATE] decision | sessionId=${sessionId} action=deny reason=no-grouped-pending-turn-changes`);
        return false;
    }

    private getGroupedSseFreshness(sessionId: string): number | undefined {
        if (!sessionId) return undefined;
        if (!this.groupedResyncActivityEnabled) {
            return this.lastSseAtBySession.get(sessionId);
        }
        if (this.subagentToParentSessionMap.has(sessionId)) {
            return this.lastSseAtBySession.get(sessionId);
        }
        const relatedIds = this.getRelatedSessionIds(sessionId);
        let maxSseAt: number | undefined;
        for (const id of relatedIds) {
            const sseAt = this.lastSseAtBySession.get(id);
            if (typeof sseAt !== 'number') continue;
            maxSseAt = maxSseAt === undefined ? sseAt : Math.max(maxSseAt, sseAt);
        }
        return maxSseAt;
    }

    private getGroupedProgressFreshness(sessionId: string): number | undefined {
        if (!sessionId) return undefined;
        if (!this.groupedResyncActivityEnabled) {
            return this.lastProgressAtBySession.get(sessionId);
        }
        if (this.subagentToParentSessionMap.has(sessionId)) {
            return this.lastProgressAtBySession.get(sessionId);
        }
        const relatedIds = this.getRelatedSessionIds(sessionId);
        let maxProgressAt: number | undefined;
        for (const id of relatedIds) {
            const progressAt = this.lastProgressAtBySession.get(id);
            if (typeof progressAt !== 'number') continue;
            maxProgressAt = maxProgressAt === undefined ? progressAt : Math.max(maxProgressAt, progressAt);
        }
        return maxProgressAt;
    }

    /**
     * Register a subagent session as a child of a parent session for grouped diff gating.
     * This allows diff events from the subagent to pass gating checks when the parent has active writes.
     * @param subagentSessionId - The subagent session ID
     * @param parentSessionId - The parent session ID
     */
    public registerSubagentSession(subagentSessionId: string, parentSessionId: string): void {
        if (!subagentSessionId || !parentSessionId) return;
        this.subagentToParentSessionMap.set(subagentSessionId, parentSessionId);
        this.logUiDebug(`EXT: session.group.register | subagent=${subagentSessionId} | parent=${parentSessionId}`);
    }

    /**
     * Clear the parent association for a subagent session.
     * @param subagentSessionId - The subagent session ID to unlink
     */
    public clearSubagentSession(subagentSessionId: string): void {
        if (!subagentSessionId) return;
        const hadParent = this.subagentToParentSessionMap.delete(subagentSessionId);
        if (hadParent) {
            this.logUiDebug(`EXT: session.group.clear | subagent=${subagentSessionId}`);
        }
    }

    /**
     * Clear all subagent associations for a parent session.
     * Useful when a parent session is being cleaned up or reset.
     * @param parentSessionId - The parent session ID
     */
    public clearSubagentsForParent(parentSessionId: string): void {
        if (!parentSessionId) return;
        const subagentIds: string[] = [];
        for (const [subagentId, mappedParentId] of this.subagentToParentSessionMap.entries()) {
            if (mappedParentId === parentSessionId) {
                subagentIds.push(subagentId);
            }
        }
        for (const subagentId of subagentIds) {
            this.subagentToParentSessionMap.delete(subagentId);
        }
        if (subagentIds.length > 0) {
            this.logUiDebug(`EXT: session.group.clear-parent | parent=${parentSessionId} | cleared=${subagentIds.length}`);
        }
    }

    private shouldQueueTurnChanges(sessionId: string | undefined, source: EventSource, messageId?: string): boolean {
        if (!sessionId) return false;
        if (!this.gitUndoAvailable || !this.isSessionUndoEnabled(sessionId)) return false;
        if (source !== 'resync') return true;
        const state = this.turnStateBySession.get(sessionId);
        if (!state) return false;
        const turnIds = state.turnMessageIds;
        if (messageId && turnIds && turnIds.size > 0 && !turnIds.has(messageId)) return false;
        return true;
    }

    private isBashCommandReadOnly(command: string | undefined): boolean {
        const raw = typeof command === 'string' ? command.trim() : '';
        if (!raw) return true;
        const lower = raw.toLowerCase();
        if (/[<>]/.test(lower) || /\btee\b/.test(lower)) return false;
        const segments = lower.split(/&&|\|\||;|\|/).map((seg) => seg.trim()).filter(Boolean);
        if (!segments.length) return true;
        return segments.every((segment) => this.isReadOnlyCommandSegment(segment));
    }

    private isReadOnlyCommandSegment(segment: string): boolean {
        const trimmed = segment.replace(/^\s*\(/, '').replace(/\)\s*$/, '').trim();
        if (!trimmed) return true;
        const parts = trimmed.split(/\s+/);
        const cmd = parts[0];
        if (!cmd) return true;
        if (cmd === 'git') {
            const sub = parts[1] || '';
            const readOnlyGit = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'describe']);
            return readOnlyGit.has(sub);
        }
        const readOnlyCommands = new Set([
            'ls',
            'dir',
            'cat',
            'type',
            'find',
            'rg',
            'grep',
            'pwd',
            'whoami'
        ]);
        return readOnlyCommands.has(cmd);
    }

    public getPendingTurnMessageIds(sessionId: string): { userMsgId?: string; assistantMsgId?: string } {
        return {
            userMsgId: this.pendingUserMsgIdBySession.get(sessionId),
            assistantMsgId: this.pendingAssistantMsgIdBySession.get(sessionId)
        };
    }

    public recordAssistantMsgId(sessionId: string, assistantMsgId: string): void {
        if (!sessionId || !assistantMsgId) return;
        const existing = this.turnStateBySession.get(sessionId);
        if (existing) {
            existing.assistantMsgId = assistantMsgId;
            return;
        }
        this.turnStateBySession.set(sessionId, {
            pendingUserLocalKey: undefined,
            pendingAssistantTmpKey: undefined,
            assistantMsgId,
            exportInFlight: false,
            exportResolved: false,
            resolvedUserMsgId: undefined,
            lastResolvedAssistantMsgId: undefined,
            turnMessageIds: new Set()
        });
    }

    private trackTurnMessageId(sessionId: string, messageId: string): void {
        if (!sessionId || !messageId || !messageId.startsWith('msg_')) return;
        const state = this.turnStateBySession.get(sessionId);
        if (!state) return;
        if (!state.turnMessageIds) {
            state.turnMessageIds = new Set();
        }
        state.turnMessageIds.add(messageId);
    }

    public setCurrentTurnUserMsgId(sessionId: string, userMsgId: string, reason = 'unknown'): void {
        if (!sessionId || !userMsgId || !userMsgId.startsWith('msg_')) return;
        const existing = this.currentTurnUserMsgIdBySession.get(sessionId);
        if (existing && existing === userMsgId) return;
        const startedAt = this.currentTurnStartedAtBySession.get(sessionId);
        const now = Date.now();
        const isOverrideReason = reason === 'synthetic-override' || reason === 'resync-stale-override' || reason === 'user-ack';
        if (isOverrideReason && existing && existing !== userMsgId) {
            if (reason === 'synthetic-override') {
                const pendingParent = this.pendingUserMsgIdBySession.get(sessionId);
                const inWindow = typeof startedAt !== 'number' || (now - startedAt) <= this.turnAnchorOverrideWindowMs;
                if (!inWindow || (pendingParent && pendingParent !== userMsgId)) {
                    this.logUiDebug(`EXT: turn.anchor.user.skip | sessionId=${sessionId} | userMsgId=${userMsgId} | reason=${reason} | guard=window-or-pending-parent`);
                    return;
                }
            }
            if (reason === 'resync-stale-override') {
                const inWindow = typeof startedAt !== 'number' || (now - startedAt) <= this.turnAnchorOverrideWindowMs;
                if (!inWindow) {
                    this.logUiDebug(`EXT: turn.anchor.user.skip | sessionId=${sessionId} | userMsgId=${userMsgId} | reason=${reason} | guard=window`);
                    return;
                }
            }
        }
        this.currentTurnUserMsgIdBySession.set(sessionId, userMsgId);
        if (!this.currentTurnStartedAtBySession.has(sessionId)) {
            this.currentTurnStartedAtBySession.set(sessionId, now);
        }
        this.logUiDebug(`EXT: turn.anchor.user | sessionId=${sessionId} | userMsgId=${userMsgId} | reason=${reason}`);
    }

    private setDisplayTurnUserMsgId(sessionId: string, userMsgId: string, reason = 'unknown'): void {
        if (!sessionId || !userMsgId || !userMsgId.startsWith('msg_')) return;
        const existing = this.displayTurnUserMsgIdBySession.get(sessionId);
        if (existing && existing === userMsgId) return;
        this.displayTurnUserMsgIdBySession.set(sessionId, userMsgId);
        this.logUiDebug(`EXT: turn.anchor.user.display | sessionId=${sessionId} | userMsgId=${userMsgId} | reason=${reason}`);
    }

    private hasDisplayTurnUserMsgId(sessionId: string): boolean {
        return this.displayTurnUserMsgIdBySession.has(sessionId);
    }

    public setCurrentTurnAssistantMsgId(sessionId: string, assistantMsgId: string, reason = 'unknown'): void {
        if (!sessionId || !assistantMsgId || !assistantMsgId.startsWith('msg_')) return;
        const existing = this.currentTurnAssistantMsgIdBySession.get(sessionId);
        if (existing && existing === assistantMsgId) return;
        this.currentTurnAssistantMsgIdBySession.set(sessionId, assistantMsgId);
        this.logUiDebug(`EXT: turn.anchor.assistant | sessionId=${sessionId} | assistantMsgId=${assistantMsgId} | reason=${reason}`);
    }

    private hasSeenFinalForAssistant(sessionId: string, assistantMsgId: string): boolean {
        const seen = this.finalMetaSeenKeysBySession.get(sessionId) || new Set<string>();
        const needle = `|${assistantMsgId}|`;
        for (const key of seen) {
            if (key.includes(needle)) return true;
        }
        return false;
    }

    private isTurnMissingFinal(sessionId: string): boolean {
        const userMsgId = this.currentTurnUserMsgIdBySession.get(sessionId);
        if (!userMsgId) return false;
        const assistantMsgId = this.currentTurnAssistantMsgIdBySession.get(sessionId);
        if (!assistantMsgId) return true;
        return !this.hasSeenFinalForAssistant(sessionId, assistantMsgId);
    }

    private scheduleSilenceResync(sessionId: string): void {
        // Disabled: non-final silence-window resync trigger.
        // Keep non-final recovery on 10s rescue timer only.
        return;
    }

    private scheduleTurnFinalQuiet(sessionId: string): void {
        const existing = this.turnFinalQuietTimersBySession.get(sessionId);
        if (existing) {
            clearTimeout(existing);
        }
        const timer = setTimeout(() => {
            this.turnFinalQuietTimersBySession.delete(sessionId);
            const lastTextAt = this.turnSseTextAtBySession.get(sessionId) || 0;
            const idleFor = Date.now() - lastTextAt;
            if (lastTextAt > 0 && idleFor < this.sseDrainQuietMs) {
                this.scheduleSseDrainConfirm(sessionId);
                return;
            }
            this.scheduleSseDrainConfirm(sessionId);
        }, this.finalQuietWindowMs);
        this.turnFinalQuietTimersBySession.set(sessionId, timer);
    }

    private markTurnFinal(sessionId: string, assistantMsgId?: string, source: EventSource = 'sse'): void {
        if (!sessionId) return;
        if (!this.turnStateBySession.has(sessionId)) return;
        if (this.turnFinalResolvedBySession.has(sessionId)) return;
        const lockedMsgId = this.finalizingMsgIdBySession.get(sessionId);
        if (lockedMsgId && assistantMsgId && assistantMsgId === lockedMsgId) {
            this.logUiDebug(`EXT: turn.final.skip | sessionId=${sessionId} | msgId=${assistantMsgId} | reason=duplicate-final | source=${source}`);
            return;
        }
        if (!lockedMsgId && assistantMsgId) {
            this.finalizingMsgIdBySession.set(sessionId, assistantMsgId);
            this.logUiDebug(`EXT: finalizing.lock | sessionId=${sessionId} | msgId=${assistantMsgId}`);
        }
        const targetMsgId = this.finalizingMsgIdBySession.get(sessionId) || assistantMsgId;
        if (lockedMsgId && assistantMsgId && assistantMsgId !== lockedMsgId) {
            this.logUiDebug(`EXT: finalizing.ignore | sessionId=${sessionId} | msgId=${assistantMsgId} | reason=not-locked`);
        }
        const prevMsgId = this.turnFinalMsgIdBySession.get(sessionId);
        this.turnFinalAtBySession.set(sessionId, Date.now());
        if (targetMsgId) {
            this.turnFinalMsgIdBySession.set(sessionId, targetMsgId);
        }
        this.turnFinalSourceBySession.set(sessionId, source);
        if (!prevMsgId || (targetMsgId && targetMsgId !== prevMsgId)) {
            this.turnSettleAttemptsBySession.set(sessionId, 0);
            this.turnSettleLastLenBySession.delete(sessionId);
            this.turnSettleStableCountBySession.set(sessionId, 0);
            this.turnSettleLastFingerprintBySession.delete(sessionId);
            this.turnSettleNoDeltaCountBySession.set(sessionId, 0);
        }
        if (this.shouldSendStopContinuationOnFinal(sessionId, source)) {
            void this.sendStopContinuationPrompt(sessionId);
        }
        this.scheduleTurnFinalQuiet(sessionId);
    }

    private waitForTurnCompletionFinal(sessionId: string): Promise<EventSource> {
        return new Promise((resolve) => {
            if (!sessionId) {
                resolve('sse');
                return;
            }
            if (this.turnFinalResolvedBySession.has(sessionId)) {
                resolve(this.turnFinalSourceBySession.get(sessionId) || 'sse');
                return;
            }
            const list = this.turnFinalWaitersBySession.get(sessionId) || [];
            list.push(() => {
                resolve(this.turnFinalSourceBySession.get(sessionId) || 'sse');
            });
            this.turnFinalWaitersBySession.set(sessionId, list);
            if (this.turnFinalAtBySession.has(sessionId)) {
                this.scheduleTurnFinalQuiet(sessionId);
            }
            this.startRescueTimer(sessionId);
        });
    }

    private isSessionAwaitingFinal(sessionId: string): boolean {
        if (!sessionId) return false;
        if (this.turnFinalResolvedBySession.has(sessionId)) return false;
        if (!this.turnFinalWaitersBySession.has(sessionId)) return false;
        return this.turnStateBySession.has(sessionId);
    }

    private isNonFinalResyncTakeover(sessionId: string): boolean {
        if (!sessionId) return false;
        if (this.turnFinalResolvedBySession.has(sessionId)) return false;
        if (!this.turnStateBySession.has(sessionId)) return false;
        if ((this.turnRecoveryModeBySession.get(sessionId) || 'sse') !== 'resync') return false;
        if (this.turnFinalAtBySession.has(sessionId)) return false;
        return true;
    }

    private stopNonFinalResyncLoop(sessionId: string, reason: string): void {
        if (!sessionId) return;
        const timer = this.turnResyncLoopTimerBySession.get(sessionId);
        if (timer) {
            clearTimeout(timer);
            this.turnResyncLoopTimerBySession.delete(sessionId);
            this.logUiDebug(`EXT: resync.loop.stop | sessionId=${sessionId} | reason=${reason}`);
        }
    }

    private armNonFinalResyncLoop(sessionId: string, reason: string): void {
        if (!this.isNonFinalResyncTakeover(sessionId)) return;
        if (this.turnFinalWaitersBySession.has(sessionId)) return;
        if (this.hasInteractiveBlocker(sessionId)) {
            this.logUiDebug(`EXT: resync.loop.pause | sessionId=${sessionId} | reason=interactive-blocker`);
            return;
        }
        const existing = this.turnResyncLoopTimerBySession.get(sessionId);
        if (existing) {
            clearTimeout(existing);
        }
        const timer = setTimeout(() => {
            this.turnResyncLoopTimerBySession.delete(sessionId);
            if (!this.isNonFinalResyncTakeover(sessionId)) return;
            if (this.hasInteractiveBlocker(sessionId)) {
                this.logUiDebug(`EXT: resync.loop.pause | sessionId=${sessionId} | reason=interactive-blocker`);
                return;
            }
            this.logUiDebug(`EXT: resync.loop.fire | sessionId=${sessionId}`);
            void this.resyncForChatResolve(sessionId, 'loop-non-final');
        }, this.resyncLoopDelayMs);
        this.turnResyncLoopTimerBySession.set(sessionId, timer);
        this.logUiDebug(`EXT: resync.loop.arm | sessionId=${sessionId} | delayMs=${this.resyncLoopDelayMs} | reason=${reason}`);
    }

    private beginResyncRecovery(sessionId: string, reason: string): number {
        this.stopNonFinalResyncLoop(sessionId, `begin:${reason}`);
        const nextEpoch = (this.turnResyncEpochBySession.get(sessionId) || 0) + 1;
        this.turnResyncEpochBySession.set(sessionId, nextEpoch);
        this.turnRecoveryModeBySession.set(sessionId, 'resync');
        this.logUiDebug(`EXT: resync.mode | sessionId=${sessionId} | mode=resync | epoch=${nextEpoch} | reason=${reason}`);
        return nextEpoch;
    }

    private isResyncRunActive(sessionId: string, epoch: number): boolean {
        if (!sessionId) return false;
        if (this.turnFinalResolvedBySession.has(sessionId)) return false;
        const mode = this.turnRecoveryModeBySession.get(sessionId) || 'sse';
        if (mode !== 'resync') return false;
        return (this.turnResyncEpochBySession.get(sessionId) || 0) === epoch;
    }

    private maybeRecoverSseFromResync(sessionId: string | undefined, msgId: string | undefined, reason: string): void {
        if (!sessionId || !msgId) return;
        if (!this.isSessionAwaitingFinal(sessionId)) return;
        if ((this.turnRecoveryModeBySession.get(sessionId) || 'sse') !== 'resync') return;
        if (this.subagentToParentSessionMap.has(sessionId)) {
            const rootSessionId = this.subagentToParentSessionMap.get(sessionId) || sessionId;
            this.logUiDebug(`EXT: resync.root.recover.blocked | rootSessionId=${rootSessionId} | targetSessionId=${sessionId} | reason=subagent-final | source=sse`);
            return;
        }
        const finalMsgId = this.getFinalizingMsgId(sessionId);
        if (finalMsgId && finalMsgId !== msgId) return;
        const nextEpoch = (this.turnResyncEpochBySession.get(sessionId) || 0) + 1;
        this.turnResyncEpochBySession.set(sessionId, nextEpoch);
        this.turnRecoveryModeBySession.set(sessionId, 'sse');
        this.stopNonFinalResyncLoop(sessionId, `sse-recover-final:${reason}`);
        this.logUiDebug(`EXT: resync.abort.by-sse | sessionId=${sessionId} | msgId=${msgId} | epoch=${nextEpoch} | reason=${reason}`);
        this.startRescueTimer(sessionId);
    }

    private maybeRecoverSseFromResyncBySessionEvent(sessionId: string | undefined, reason: string): void {
        if (!sessionId) return;
        if ((this.turnRecoveryModeBySession.get(sessionId) || 'sse') !== 'resync') return;
        if (!this.turnStateBySession.has(sessionId)) return;
        if (this.turnFinalAtBySession.has(sessionId)) return;
        if (this.subagentToParentSessionMap.has(sessionId)) {
            const rootSessionId = this.subagentToParentSessionMap.get(sessionId) || sessionId;
            this.logUiDebug(`EXT: resync.root.recover.blocked | rootSessionId=${rootSessionId} | targetSessionId=${sessionId} | reason=subagent-sse | source=sse`);
            return;
        }
        const nextEpoch = (this.turnResyncEpochBySession.get(sessionId) || 0) + 1;
        this.turnResyncEpochBySession.set(sessionId, nextEpoch);
        this.turnRecoveryModeBySession.set(sessionId, 'sse');
        this.stopNonFinalResyncLoop(sessionId, `sse-recover-event:${reason}`);
        this.logUiDebug(`EXT: resync.abort.by-sse | sessionId=${sessionId} | epoch=${nextEpoch} | reason=${reason}`);
        this.startRescueTimer(sessionId);
    }

    private triggerImmediateResyncForAwaitingFinals(reason: string): void {
        const sessions = Array.from(this.turnFinalWaitersBySession.keys());
        for (const sessionId of sessions) {
            if (!this.isSessionAwaitingFinal(sessionId)) continue;
            this.logUiDebug(`EXT: rescue.immediate | sessionId=${sessionId} | reason=${reason}`);
            void this.resyncForChatResolve(sessionId, `immediate:${reason}`);
        }
    }

    private resolveTurnFinal(sessionId: string, reason: string): void {
        if (!sessionId) return;
        if (this.turnFinalResolvedBySession.has(sessionId)) return;
        this.clearPendingMainFinalGate(sessionId, `resolved:${reason}`);
        this.turnFinalResolvedBySession.add(sessionId);
        this.stopNonFinalResyncLoop(sessionId, `resolved:${reason}`);
        this.stopRescueWatchdog(sessionId, reason);
        const waiters = this.turnFinalWaitersBySession.get(sessionId);
        if (waiters && waiters.length) {
            waiters.splice(0).forEach((fn) => fn());
        }
    }

    private scheduleSseDrainConfirm(sessionId: string): void {
        if (!sessionId) return;
        if (this.turnFinalResolvedBySession.has(sessionId)) return;
        if (!this.turnFinalAtBySession.has(sessionId)) return;
        const runId = this.turnRescueRunIdBySession.get(sessionId) || 0;
        const existing = this.turnSseDrainTimerBySession.get(sessionId);
        if (existing) {
            clearTimeout(existing);
        }
        this.stopRescueWatchdog(sessionId, 'sse-active');
        this.turnRescueRunIdBySession.set(sessionId, runId);
        const timer = setTimeout(() => {
            this.turnSseDrainTimerBySession.delete(sessionId);
            void this.runResyncSettleCheck(sessionId, 'sse-drain');
        }, this.sseDrainQuietMs);
        this.turnSseDrainTimerBySession.set(sessionId, timer);
    }

    private async runResyncSettleCheck(sessionId: string, reason: string): Promise<void> {
        if (!sessionId) return;
        if (this.turnFinalResolvedBySession.has(sessionId)) return;
        if (this.hasInteractiveBlocker(sessionId)) {
            this.logUiDebug(`EXT: rescue.pause | sessionId=${sessionId} | reason=interactive-blocker`);
            return;
        }
        const inFastPath = reason === 'sse-drain' || reason === 'sse-drain-pass2' || reason === 'tool-terminal';
        if (!inFastPath) {
            await this.resyncForChatResolve(sessionId, `settle:${reason}`);
        }
        if (this.turnFinalResolvedBySession.has(sessionId)) return;
        const finalMsgId = this.getFinalizingMsgId(sessionId);
        if (!finalMsgId) {
            this.startRescueTimer(sessionId);
            return;
        }
        const attempts = (this.turnSettleAttemptsBySession.get(sessionId) || 0) + 1;
        this.turnSettleAttemptsBySession.set(sessionId, attempts);
        const len = this.assistantTextLengths.get(finalMsgId) || 0;
        const prevLen = this.turnSettleLastLenBySession.get(sessionId);
        let stable = this.turnSettleStableCountBySession.get(sessionId) || 0;
        if (len > 0) {
            if (prevLen === len) {
                stable += 1;
            } else {
                stable = 1;
                this.turnSettleLastLenBySession.set(sessionId, len);
            }
        }
        this.turnSettleStableCountBySession.set(sessionId, stable);
        const fingerprint = this.getAssistantFingerprint(finalMsgId);
        const prevFingerprint = this.turnSettleLastFingerprintBySession.get(sessionId);
        let noDeltaCount = this.turnSettleNoDeltaCountBySession.get(sessionId) || 0;
        if (prevFingerprint === fingerprint) {
            noDeltaCount += 1;
        } else {
            noDeltaCount = 0;
            this.turnSettleLastFingerprintBySession.set(sessionId, fingerprint);
        }
        this.turnSettleNoDeltaCountBySession.set(sessionId, noDeltaCount);
        const lastSseAppliedAt = this.lastSseAtBySession.get(sessionId) || 0;
        const sseSilent = !lastSseAppliedAt || (Date.now() - lastSseAppliedAt >= this.rescueStartDelayMs);
        const complete = inFastPath
            ? (len > 0 && stable >= 2)
            : (noDeltaCount >= this.settleNoDeltaThreshold && sseSilent);
        this.logUiDebug(`EXT: settle.check | sessionId=${sessionId} | reason=${reason} | msgId=${finalMsgId} | len=${len} | stable=${stable} | attempts=${attempts} | noDelta=${noDeltaCount} | sseSilent=${String(sseSilent)} | complete=${complete}`);
        if (complete) {
            const reasonLabel = noDeltaCount >= this.settleNoDeltaThreshold && sseSilent
                ? 'settle-no-delta'
                : 'settle-complete';
            this.resolveTurnFinal(sessionId, reasonLabel);
            return;
        }
        if (reason === 'sse-drain' && len > 0 && stable === 1 && !this.hasPendingOrRunningTools(sessionId)) {
            const existing = this.turnSseDrainTimerBySession.get(sessionId);
            if (existing) {
                clearTimeout(existing);
            }
            const timer = setTimeout(() => {
                this.turnSseDrainTimerBySession.delete(sessionId);
                void this.runResyncSettleCheck(sessionId, 'sse-drain-pass2');
            }, this.sseDrainPass2DelayMs);
            this.turnSseDrainTimerBySession.set(sessionId, timer);
            this.logUiDebug(`EXT: settle.pass2.schedule | sessionId=${sessionId} | delayMs=${this.sseDrainPass2DelayMs} | msgId=${finalMsgId}`);
            return;
        }
        this.startRescueTimer(sessionId);
    }

    private startRescueTimer(sessionId: string): void {
        if (!sessionId) return;
        if (this.turnFinalResolvedBySession.has(sessionId)) return;
        if (!this.turnFinalWaitersBySession.has(sessionId)) return;
        if (this.hasInteractiveBlocker(sessionId)) {
            this.logUiDebug(`EXT: rescue.pause | sessionId=${sessionId} | reason=interactive-blocker`);
            return;
        }
        if (this.groupedResyncActivityEnabled) {
            const groupedSseAt = this.getGroupedSseFreshness(sessionId) || 0;
            const groupedProgressAt = this.getGroupedProgressFreshness(sessionId) || 0;
            const activeAt = Math.max(groupedSseAt, groupedProgressAt);
            const rootSseAt = this.lastSseAtBySession.get(sessionId) || 0;
            const rootProgressAt = this.lastProgressAtBySession.get(sessionId) || 0;
            const rootActiveAt = Math.max(rootSseAt, rootProgressAt);
            if (activeAt && (Date.now() - activeAt < this.rescueStartDelayMs)) {
                if (rootActiveAt && (Date.now() - rootActiveAt >= this.rescueStartDelayMs)) {
                    this.logUiDebug(`EXT: rescue.defer.override | sessionId=${sessionId} | reason=root-stale`);
                } else {
                    this.logUiDebug(`EXT: rescue.defer | sessionId=${sessionId} | reason=grouped-activity`);
                    return;
                }
            }
        }
        const existing = this.turnRescueTimerBySession.get(sessionId);
        if (existing) {
            clearTimeout(existing);
        }
        const delayMs = this.rescueStartDelayMs;
        const timer = setTimeout(() => {
            this.startRescueWatchdog(sessionId);
        }, delayMs);
        this.turnRescueTimerBySession.set(sessionId, timer);
        this.logUiDebug(`EXT: wait.final.start | sessionId=${sessionId} | rescueDelayMs=${delayMs}`);
    }

    private resetRescueTimer(sessionId: string): void {
        if (!sessionId) return;
        if (!this.turnFinalWaitersBySession.has(sessionId)) return;
        if (this.turnFinalResolvedBySession.has(sessionId)) return;
        if (this.turnSseDrainTimerBySession.has(sessionId)) return;
        this.startRescueTimer(sessionId);
        this.logUiDebug(`EXT: wait.final.reset | sessionId=${sessionId}`);
    }

    private startRescueWatchdog(sessionId: string): void {
        if (!sessionId) return;
        if (this.turnFinalResolvedBySession.has(sessionId)) return;
        if (!this.turnFinalWaitersBySession.has(sessionId)) return;
        if (this.hasInteractiveBlocker(sessionId)) {
            this.logUiDebug(`EXT: rescue.pause | sessionId=${sessionId} | reason=interactive-blocker`);
            return;
        }
        const runId = Date.now();
        this.turnRescueRunIdBySession.set(sessionId, runId);
        this.logUiDebug(`EXT: watchdog.start | sessionId=${sessionId}`);
        void this.resyncForChatResolve(sessionId, 'watchdog-timeout');
        this.startRescueTimer(sessionId);
    }

    private stopRescueWatchdog(sessionId: string, reason: string): void {
        if (!sessionId) return;
        const existing = this.turnRescueTimerBySession.get(sessionId);
        if (existing) {
            clearTimeout(existing);
        }
        this.turnRescueTimerBySession.delete(sessionId);
        this.turnRescueRunIdBySession.delete(sessionId);
        const drain = this.turnSseDrainTimerBySession.get(sessionId);
        if (drain) {
            clearTimeout(drain);
            this.turnSseDrainTimerBySession.delete(sessionId);
        }
        this.logUiDebug(`EXT: watchdog.stop | sessionId=${sessionId} | reason=${reason}`);
    }


    private resolveFinalAssistantFromExport(exportJson: any, userMsgId: string): {
        userMsgId: string;
        assistantMsgId: string | null;
        assistantMsgIdsAll: string[];
        chosenFinish: string | null;
        chosenTimeCompleted: number | null;
        chosenTimeCreated: number | null;
    } {
        const rawMessages = Array.isArray(exportJson?.messages) ? exportJson.messages : [];
        const candidates = rawMessages.filter((message: any) =>
            message?.info?.role === 'assistant' && message?.info?.parentID === userMsgId
        );

        const getTimeCreated = (message: any): number => {
            const v = message?.time?.created;
            return typeof v === 'number' ? v : -Infinity;
        };

        const getTimeCompleted = (message: any): number => {
            const v = message?.time?.completed;
            return typeof v === 'number' ? v : -Infinity;
        };

        const assistantMsgIdsAll = candidates
            .slice()
            .sort((a: any, b: any) => getTimeCreated(a) - getTimeCreated(b))
            .map((message: any) => message?.info?.id)
            .filter((id: any) => typeof id === 'string');

        if (!candidates.length) {
            return {
                userMsgId,
                assistantMsgId: null,
                assistantMsgIdsAll,
                chosenFinish: null,
                chosenTimeCompleted: null,
                chosenTimeCreated: null
            };
        }

        const stopCandidates = candidates.filter((message: any) => message?.info?.finish === 'stop');
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

        const assistantMsgId = typeof best?.info?.id === 'string' ? best.info.id : null;
        const chosenFinish = typeof best?.info?.finish === 'string' ? best.info.finish : null;
        const chosenTimeCompleted = Number.isFinite(getTimeCompleted(best)) ? getTimeCompleted(best) : null;
        const chosenTimeCreated = Number.isFinite(getTimeCreated(best)) ? getTimeCreated(best) : null;

        return {
            userMsgId,
            assistantMsgId,
            assistantMsgIdsAll,
            chosenFinish,
            chosenTimeCompleted,
            chosenTimeCreated
        };
    }

    public async resolveUserMessageUpgrade(sessionId: string): Promise<
        | { status: 'ok'; localKey: string | null; userMsgId: string | null; assistantMsgId: string | null; assistantMsgIdsAll: string[]; chosenFinish: string | null; chosenTimeCompleted: number | null; chosenTimeCreated: number | null }
        | { status: 'pending'; localKey: string | null; userMsgId: string | null; awaitingAssistantIdFromExport: true; reason: string }
        | { status: 'error'; localKey: string | null; userMsgId: string | null; awaitingAssistantIdFromExport: true; reason: string }
    > {
        if (!sessionId) {
            return { status: 'pending', localKey: null, userMsgId: null, awaitingAssistantIdFromExport: true, reason: 'missing-session' };
        }
        const state = this.turnStateBySession.get(sessionId);
        if (!state) {
            // this.logUiDebug(`[DBG_EXPORT_PENDING] session=${sessionId} reason=no-turn-state`);
            return { status: 'pending', localKey: null, userMsgId: null, awaitingAssistantIdFromExport: true, reason: 'no-turn-state' };
        }
        if (state.exportInFlight) {
            // this.logUiDebug(`[DBG_EXPORT_PENDING] session=${sessionId} reason=in-flight`);
            return { status: 'pending', localKey: state.pendingUserLocalKey || null, userMsgId: state.resolvedUserMsgId || null, awaitingAssistantIdFromExport: true, reason: 'in-flight' };
        }

        const assistantMsgId = state.assistantMsgId;
        const localKey = state.pendingUserLocalKey || null;

        if (!assistantMsgId || !assistantMsgId.startsWith('msg_')) {
            // this.logUiDebug(`[DBG_EXPORT_PENDING] session=${sessionId} reason=missing-assistantMsgId`);
            return { status: 'pending', localKey, userMsgId: state.resolvedUserMsgId || null, awaitingAssistantIdFromExport: true, reason: 'missing-assistantMsgId' };
        }

        // this.logUiDebug(`[DBG_EXPORT_RESOLVE] session=${sessionId} assistantMsgId=${assistantMsgId} userLocal=${localKey || 'null'}`);
        state.exportInFlight = true;

        try {
            const parseExportForUpgrade = (data: any):
                | { ok: true; userMsgId: string; resolved: any; rawMessages: any[] }
                | { ok: false; reason: string; userMsgId: string | null; rawMessages: any[] } => {
                const rawMessages = Array.isArray(data?.messages) ? data.messages : [];
                const assistantMatches = rawMessages.filter((message: any) =>
                    message?.info?.id === assistantMsgId &&
                    message?.info?.role === 'assistant'
                );

                if (assistantMatches.length !== 1) {
                    return {
                        ok: false,
                        reason: 'assistant-match-count',
                        userMsgId: state.resolvedUserMsgId || null,
                        rawMessages
                    };
                }

                const parentId = assistantMatches[0]?.info?.parentID;
                const userMsgId = typeof parentId === 'string' ? parentId : null;
                if (!userMsgId || !userMsgId.startsWith('msg_')) {
                    return { ok: false, reason: 'invalid-user-parent', userMsgId: null, rawMessages };
                }

                if (state.resolvedUserMsgId && state.resolvedUserMsgId !== userMsgId) {
                    return {
                        ok: false,
                        reason: 'stale-parent-mismatch',
                        userMsgId: state.resolvedUserMsgId,
                        rawMessages
                    };
                }

                const resolved = this.resolveFinalAssistantFromExport(data, userMsgId);
                return { ok: true, userMsgId, resolved, rawMessages };
            };

            const fallbackReasons = new Set(['assistant-match-count', 'invalid-user-parent', 'stale-parent-mismatch']);
            let exportSource: 'recent' | 'full' = 'recent';
            let exportData = await this.exportSessionRecent(sessionId, 120);
            let parsed = parseExportForUpgrade(exportData);

            if (!parsed.ok && fallbackReasons.has(parsed.reason)) {
                exportSource = 'full';
                exportData = await this.exportSession(sessionId);
                parsed = parseExportForUpgrade(exportData);
            }

            this.logUiDebug(`EXT: export.resolve.path | sessionId=${sessionId} | source=${exportSource} | ok=${String(parsed.ok)}${parsed.ok ? '' : ` | reason=${parsed.reason}`}`);

            if (!parsed.ok) {
                return {
                    status: 'pending',
                    localKey,
                    userMsgId: parsed.userMsgId,
                    awaitingAssistantIdFromExport: true,
                    reason: parsed.reason
                };
            }

            const { userMsgId, resolved, rawMessages } = parsed;
            state.resolvedUserMsgId = userMsgId;
            // this.logUiDebug(`[DBG_EXPORT_FINAL] userMsgId=${resolved.userMsgId} assistantMsgIdsAll=[${resolved.assistantMsgIdsAll.join(', ')}] chosen=${resolved.assistantMsgId || 'null'} finish=${resolved.chosenFinish || 'null'} completed=${resolved.chosenTimeCompleted ?? 'null'} created=${resolved.chosenTimeCreated ?? 'null'}`);

            if (!resolved.assistantMsgIdsAll.length) {
                const tail = rawMessages.slice(-5).map((message: any) => {
                    const id = message?.info?.id || 'null';
                    const role = message?.info?.role || 'null';
                    const parentID = message?.info?.parentID || 'null';
                    const finish = message?.info?.finish || 'null';
                    return `{id=${id} role=${role} parentID=${parentID} finish=${finish}}`;
                });
                // this.logUiDebug(`[DBG_EXPORT_EMPTY] userMsgId=${userMsgId} tail=${tail.join(' ')}`);
            }

            if (resolved.assistantMsgId && state.lastResolvedAssistantMsgId && resolved.assistantMsgId !== state.lastResolvedAssistantMsgId) {
                // this.logUiDebug(`[DBG_EXPORT_OVERWRITE] assistantId updated from ${state.lastResolvedAssistantMsgId} -> ${resolved.assistantMsgId}`);
            }

            state.exportResolved = true;
            if (resolved.assistantMsgId) {
                state.lastResolvedAssistantMsgId = resolved.assistantMsgId;
            }

            if (resolved.assistantMsgId) {
                if (this.gitUndoAvailable) {
                    await this.gitUndo?.finalizeBinding(
                        sessionId,
                        state.pendingAssistantTmpKey,
                        resolved.assistantMsgId,
                        userMsgId || undefined
                    );
                }
            }

            return {
                status: 'ok',
                localKey,
                userMsgId,
                assistantMsgId: resolved.assistantMsgId,
                assistantMsgIdsAll: resolved.assistantMsgIdsAll,
                chosenFinish: resolved.chosenFinish,
                chosenTimeCompleted: resolved.chosenTimeCompleted,
                chosenTimeCreated: resolved.chosenTimeCreated
            };
        } catch (error) {
            const reason = `export-error:${String(error)}`;
            // this.logUiDebug(`[DBG_EXPORT_PENDING] session=${sessionId} reason=${reason}`);
            return { status: 'error', localKey, userMsgId: state.resolvedUserMsgId || null, awaitingAssistantIdFromExport: true, reason };
        } finally {
            state.exportInFlight = false;
        }
    }

    public setSessionId(sessionId: string | undefined): void {
        this.currentSessionId = sessionId;
    }

    public getSessionId(): string | undefined {
        return this.currentSessionId;
    }

    public getTurnAssistantMsgId(sessionId: string): string | undefined {
        if (!sessionId) return undefined;
        const state = this.turnStateBySession.get(sessionId);
        const candidate = state?.lastResolvedAssistantMsgId || state?.assistantMsgId;
        if (typeof candidate !== 'string') return undefined;
        return candidate.startsWith('msg_') ? candidate : undefined;
    }

    private execute(args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
                ? vscode.workspace.workspaceFolders[0].uri.fsPath
                : process.cwd();

            this.resolveBin()
                .then((bin) => {
                    // OpenCodeClient.outputChannel.appendLine(`[SPAWN] ${bin} ${args.join(' ')} (cwd: ${workspaceFolder})`);
                    const startTime = Date.now();

                    const spawnSpec = this.buildSpawn(bin, args);
                    const child = cp.spawn(spawnSpec.command, spawnSpec.args, {
                        cwd: workspaceFolder,
                        shell: false,
                        timeout: 60000,
                        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
                    });

                    child.stdin.end();

                    let stdout = "";
                    let stderr = "";

                    child.stdout.on('data', (data) => {
                        const rawChunk = data.toString('utf8');
                        const cleanChunk = this.stripAnsi(rawChunk);
                        stdout += rawChunk;
                        OpenCodeClient.outputChannel.appendLine(`[STDOUT_CHUNK] (dt: ${Date.now() - startTime}ms) ${cleanChunk}`);
                    });

                    child.stderr.on('data', (data) => {
                        const rawChunk = data.toString('utf8');
                        stderr += rawChunk;
                        OpenCodeClient.outputChannel.appendLine(`[STDERR_CHUNK] ${this.stripAnsi(rawChunk)}`);
                    });

                    child.on('close', (code) => {
                        const duration = Date.now() - startTime;
                        OpenCodeClient.outputChannel.appendLine(`[CLOSE] Exit code: ${code}, Duration: ${duration}ms`);

                        if (stdout) {
                            resolve(this.stripAnsi(stdout.trim()));
                        } else {
                            reject(this.stripAnsi(stderr.trim()) || `Process finished with no output (Code: ${code})`);
                        }
                    });

                    child.on('error', (err: NodeJS.ErrnoException) => {
                        OpenCodeClient.outputChannel.appendLine(`[SPAWN_ERR] ${err.message}`);
                        if (err.code === 'ENOENT') {
                            reject('Could not find "opencode" on PATH. Please install it or add it to your PATH.');
                            return;
                        }
                        reject(err.message);
                    });
                })
                .catch((error) => {
                    reject(error);
                });
        });
    }

    private executeStreaming(args: string[], onEvent?: (event: ChatEvent) => void, stdinText?: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
                ? vscode.workspace.workspaceFolders[0].uri.fsPath
                : process.cwd();

            this.resolveBin()
                .then((bin) => {
                    OpenCodeClient.outputChannel.appendLine(`[SPAWN] ${bin} ${args.join(' ')} (cwd: ${workspaceFolder})`);
                    const startTime = Date.now();

                    const spawnSpec = this.buildSpawn(bin, args);
                    const child = cp.spawn(spawnSpec.command, spawnSpec.args, {
                        cwd: workspaceFolder,
                        shell: false,
                        timeout: 60000,
                        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
                    });
                    this.currentChild = child;

                    if (typeof stdinText === 'string') {
                        child.stdin.write(stdinText);
                    }
                    child.stdin.end();

                    let stdout = "";
                    let stderr = "";
                    let buffer = "";

            const flushLine = (line: string) => {
                const trimmed = line.trim();
                if (!trimmed) return;
                try {
                    const parsed = JSON.parse(trimmed);
                    const sessionId = parsed.sessionID as string | undefined;
                    if (sessionId && onEvent) {
                        onEvent({ type: 'session', sessionId });
                    }
                    if (sessionId) {
                        this.currentSessionId = sessionId;
                    }
                    const messageId = parsed.part?.messageID || parsed.part?.messageId || parsed.messageID || parsed.messageId;
                    const assistantMsgId = typeof parsed.part?.messageID === 'string' ? parsed.part.messageID : undefined;
                    // if (assistantMsgId || messageId) {
                    //     this.logUiDebug(`[DBG_STDOUT_ID] type=${parsed.type || 'unknown'} session=${sessionId || 'null'} tmpKey=null messageID=${assistantMsgId || messageId || 'null'}`);
                    // }
                    const resolvedSessionId = sessionId || this.currentSessionId;
                    if (assistantMsgId && resolvedSessionId) {
                        this.recordAssistantMsgId(resolvedSessionId, assistantMsgId);
                    }
                    if (messageId && onEvent) {
                        onEvent({ type: 'message', text: messageId, sessionId });
                        this.registerMessageId(messageId);
                        if (resolvedSessionId && typeof messageId === 'string') {
                            this.trackTurnMessageId(resolvedSessionId, messageId);
                        }
                    }
                    if (assistantMsgId && onEvent) {
                        const resolvedSessionId = sessionId || this.currentSessionId;
                        onEvent({
                            type: 'assistantMessageMeta',
                            sessionId: resolvedSessionId,
                            assistantMsgId,
                            tmpKey: this.getPendingAssistantTmpKey(resolvedSessionId)
                        });
                    }
                    if (parsed.type === 'error') {
                        const errMsg = parsed.error?.data?.message || parsed.error?.message || 'Unknown CLI error';
                        if (onEvent) {
                            onEvent({ type: 'error', text: errMsg, sessionId });
                        }
                        return;
                    }
                    if (parsed.type === 'tool_use' && parsed.part && parsed.part.tool === 'apply_patch') {
                        const patchText = parsed.part?.state?.input?.patchText || parsed.part?.state?.input?.patch;
                        const metadata = parsed.part?.state?.metadata;
                        const stateFiles = Array.isArray(metadata?.files) ? metadata.files : [];
                        const firstFile = stateFiles.length ? stateFiles[0] : null;
                        const metadataKeys = metadata && typeof metadata === 'object'
                            ? Object.keys(metadata).slice(0, 8).join(',')
                            : '';
                        const firstFileKeys = firstFile && typeof firstFile === 'object'
                            ? Object.keys(firstFile).slice(0, 10).join(',')
                            : '';
                        OpenCodeClient.outputChannel.appendLine(
                            `[DBG_APPLY_PATCH] status=${parsed.part?.state?.status || 'unknown'} ` +
                            `hasMetadata=${Boolean(metadata)} keys=[${metadataKeys}] files=${stateFiles.length} ` +
                            `firstKeys=[${firstFileKeys}] hasBefore=${Boolean(firstFile?.before)} ` +
                            `hasAfter=${Boolean(firstFile?.after)} hasDiff=${Boolean(firstFile?.diff)} ` +
                            `patchLen=${typeof patchText === 'string' ? patchText.length : 0}`
                        );
                        if (patchText && onEvent) {
                            onEvent({ type: 'toolPatch', text: patchText, sessionId });
                        }
                    }
                    if (parsed.type === 'tool_use' && parsed.part && parsed.part.tool) {
                        const toolName = String(parsed.part.tool);
                        const toolStatus = parsed.part?.state?.status;
                        if (toolStatus === 'completed') {
                            if (['apply_patch', 'edit', 'write'].includes(toolName)) {
                                this.markTurnHasWrites(resolvedSessionId || sessionId || '', `tool_use:${toolName}`);
                            } else if (toolName === 'bash') {
                                const command = parsed.part?.state?.input?.command;
                                if (!this.isBashCommandReadOnly(command)) {
                                    this.markTurnHasWrites(resolvedSessionId || sessionId || '', 'tool_use:bash');
                                }
                            }
                        }
                    }
                    const files = this.extractFilesFromEvent(parsed);
                    if (files.length && onEvent) {
                        if (this.gitUndoAvailable && this.isSessionUndoEnabled(resolvedSessionId) && resolvedSessionId) {
                            const turnState = this.turnStateBySession.get(resolvedSessionId);
                            const turnKey = turnState?.pendingUserLocalKey || resolvedSessionId;
                            const tmpKey = turnState?.pendingAssistantTmpKey;
                            const assistantId = typeof messageId === 'string' && messageId.startsWith('msg_') ? messageId : undefined;
                            const changeSpecs = this.buildChangeSpecs(files);
                            this.queueTurnChanges(resolvedSessionId, turnKey, tmpKey, assistantId, changeSpecs);
                        }
                        onEvent({ type: 'files', files, sessionId });
                    }
                    if (parsed.type === 'text' && parsed.part && typeof parsed.part.text === 'string') {
                        if (onEvent) {
                            onEvent({ type: 'text', text: parsed.part.text, sessionId, assistantMsgId });
                        }
                    }

                    const diffText = (
                        (parsed.part && (parsed.part.diff || parsed.part.patch || parsed.part.text)) ||
                        parsed.diff || parsed.patch
                    );

                    if (parsed.part && parsed.part.type && ['diff', 'patch', 'file-diff'].includes(parsed.part.type)) {
                        if (diffText && onEvent) {
                            onEvent({ type: 'diff', text: diffText, sessionId });
                        }
                    }
                } catch (error) {
                    if (trimmed.includes('Permission required:')) {
                        if (onEvent) {
                            onEvent({ type: 'permission', text: trimmed });
                        }
                        return;
                    }
                    if (onEvent) {
                        onEvent({ type: 'raw', text: trimmed });
                    }
                }
            };

                    child.stdout.on('data', (data) => {
                        const rawChunk = data.toString('utf8');
                        const cleanChunk = this.stripAnsi(rawChunk);
                        stdout += rawChunk;
                        // OpenCodeClient.outputChannel.appendLine(`[STDOUT_CHUNK] (dt: ${Date.now() - startTime}ms) ${cleanChunk}`);

                        buffer += cleanChunk;
                        const lines = buffer.split(/\r?\n/);
                        buffer = lines.pop() || "";
                        for (const line of lines) {
                            flushLine(line);
                        }
                    });

                    child.stderr.on('data', (data) => {
                        const rawChunk = data.toString('utf8');
                        stderr += rawChunk;
                        // OpenCodeClient.outputChannel.appendLine(`[STDERR_CHUNK] ${this.stripAnsi(rawChunk)}`);
                    });

                    child.on('close', (code) => {
                        const duration = Date.now() - startTime;
                        // OpenCodeClient.outputChannel.appendLine(`[CLOSE] Exit code: ${code}, Duration: ${duration}ms`);
                        this.currentChild = undefined;

                        if (buffer.trim()) {
                            flushLine(buffer);
                        }

                        if (code === 0 || stdout) {
                            resolve();
                        } else {
                            reject(this.stripAnsi(stderr.trim()) || `Process finished with no output (Code: ${code})`);
                        }
                    });

                    child.on('error', (err: NodeJS.ErrnoException) => {
                        this.currentChild = undefined;
                        OpenCodeClient.outputChannel.appendLine(`[SPAWN_ERR] ${err.message}`);
                        if (err.code === 'ENOENT') {
                            reject('Could not find "opencode" on PATH. Please install it or add it to your PATH.');
                            return;
                        }
                        reject(err.message);
                    });
                })
                .catch((error) => {
                    reject(error);
                });
        });
    }

    private resolveBin(): Promise<string> {
        if (this.resolvedBin) {
            return Promise.resolve(this.resolvedBin);
        }
        const isWin = process.platform === 'win32';
        const resolver = isWin ? 'where' : 'which';
        const target = isWin ? 'opencode.cmd' : 'opencode';
        return new Promise((resolve, reject) => {
            cp.exec(`${resolver} ${target}`, { encoding: 'utf-8' }, (err: cp.ExecException | null, stdout: string) => {
                if (err || !stdout) {
                    if (isWin && target === 'opencode.cmd') {
                        cp.exec(`${resolver} opencode`, { encoding: 'utf-8' }, (fallbackErr: cp.ExecException | null, fallbackOut: string) => {
                            if (fallbackErr || !fallbackOut) {
                                reject('Could not find "opencode" on PATH. Please install it or add it to your PATH.');
                                return;
                            }
                            const lines = fallbackOut.split(/\r?\n/).map((line: string) => line.trim()).filter(Boolean);
                            if (!lines.length) {
                                reject('Could not find "opencode" on PATH. Please install it or add it to your PATH.');
                                return;
                            }
                            const resolved = this.resolveWindowsCmd(lines[0]);
                            if (!resolved) {
                                reject('Could not find "opencode" on PATH. Please install it or add it to your PATH.');
                                return;
                            }
                            this.resolvedBin = resolved;
                            this.useCmdWrapper = this.shouldUseCmdWrapper(resolved);
                            resolve(resolved);
                        });
                        return;
                    }
                    reject('Could not find "opencode" on PATH. Please install it or add it to your PATH.');
                    return;
                }
                const lines = stdout.split(/\r?\n/).map((line: string) => line.trim()).filter(Boolean);
                if (!lines.length) {
                    reject('Could not find "opencode" on PATH. Please install it or add it to your PATH.');
                    return;
                }
                const resolved = isWin ? this.resolveWindowsCmd(lines[0]) : lines[0];
                if (!resolved) {
                    reject('Could not find "opencode" on PATH. Please install it or add it to your PATH.');
                    return;
                }
                this.resolvedBin = resolved;
                this.useCmdWrapper = this.shouldUseCmdWrapper(resolved);
                resolve(resolved);
            });
        });
    }

    private resolveWindowsCmd(resolvedPath: string): string | undefined {
        const ext = path.extname(resolvedPath).toLowerCase();
        if (ext === '.cmd' || ext === '.exe' || ext === '.bat') {
            return resolvedPath;
        }
        const cmdPath = `${resolvedPath}.cmd`;
        if (fs.existsSync(cmdPath)) {
            return cmdPath;
        }
        const exePath = `${resolvedPath}.exe`;
        if (fs.existsSync(exePath)) {
            return exePath;
        }
        const batPath = `${resolvedPath}.bat`;
        if (fs.existsSync(batPath)) {
            return batPath;
        }
        return undefined;
    }

    private shouldUseCmdWrapper(bin: string): boolean {
        if (process.platform !== 'win32') return false;
        const ext = path.extname(bin).toLowerCase();
        return ext === '.cmd' || ext === '.bat';
    }

    private buildSpawn(bin: string, args: string[], stdinText?: string): { command: string; args: string[] } {
        const multilineArg = args.find((arg) => arg.includes('\n'));
        if (this.useCmdWrapper && multilineArg && !stdinText) {
            const filtered = args.filter((arg) => arg !== multilineArg && arg !== '--');
            const psArgs = filtered.map((arg) => this.psQuote(arg)).join(' ');
            const message = this.psHereString(multilineArg);
            const invocation = psArgs ? `& ${this.psQuote(bin)} ${psArgs} -- $msg` : `& ${this.psQuote(bin)} -- $msg`;
            const command = `$msg = ${message}\n${invocation}`;
            return { command: 'powershell.exe', args: ['-NoProfile', '-Command', command] };
        }
        if (this.useCmdWrapper) {
            return { command: 'cmd.exe', args: ['/c', bin, ...args] };
        }
        return { command: bin, args };
    }

    private psQuote(value: string): string {
        const escaped = value.replace(/'/g, "''");
        return `'${escaped}'`;
    }

    private psHereString(value: string): string {
        const escaped = value.replace(/'@/g, "'`@");
        return `@'\n${escaped}\n'@`;
    }

    private extractFilesFromEvent(parsed: any): FileSnapshot[] {
        if (parsed?.type !== 'tool_use') return [];
        if (parsed?.part?.state?.status !== 'completed') return [];
        const tool = parsed?.part?.tool;
        if (tool === 'apply_patch') {
            const stateFiles = Array.isArray(parsed?.part?.state?.metadata?.files)
                ? parsed.part.state.metadata.files
                : [];
            const files: FileSnapshot[] = [];
            for (const file of stateFiles) {
                if (!file?.filePath) continue;
                const type = file?.type as 'update' | 'create' | 'delete' | undefined;
                const existsBefore = typeof file?.existsBefore === 'boolean'
                    ? file.existsBefore
                    : (type === 'create' ? false : type === 'delete' ? true : true);
                const existsAfter = typeof file?.existsAfter === 'boolean'
                    ? file.existsAfter
                    : (type === 'create' ? true : type === 'delete' ? false : true);
                files.push({
                    filePath: file.filePath,
                    relativePath: file.relativePath,
                    type,
                    diff: file.diff,
                    before: file.before,
                    after: file.after,
                    existsBefore,
                    existsAfter,
                    additions: typeof file.additions === 'number' ? file.additions : undefined,
                    deletions: typeof file.deletions === 'number' ? file.deletions : undefined
                });
            }
            return files;
        }
        if (tool === 'edit') {
            const metadata = parsed?.part?.state?.metadata;
            const filediff = metadata?.filediff;
            if (!filediff?.file) return [];
            return [
                {
                    filePath: filediff.file,
                    type: 'update',
                    diff: typeof metadata?.diff === 'string' ? metadata.diff : undefined,
                    before: typeof filediff.before === 'string' ? filediff.before : undefined,
                    after: typeof filediff.after === 'string' ? filediff.after : undefined,
                    existsBefore: true,
                    existsAfter: true,
                    additions: typeof filediff.additions === 'number' ? filediff.additions : undefined,
                    deletions: typeof filediff.deletions === 'number' ? filediff.deletions : undefined
                }
            ];
        }
        if (tool === 'write') {
            const input = parsed?.part?.state?.input;
            const metadata = parsed?.part?.state?.metadata;
            if (!input?.filePath) {
                this.logUiDebug(`write.skip | reason=missing-filePath`);
                return [];
            }
            const existsBefore = typeof metadata?.exists === 'boolean' ? metadata.exists : false;
            const filediff = metadata?.filediff;
            const beforeText = typeof metadata?.before === 'string'
                ? metadata.before
                : (typeof filediff?.before === 'string' ? filediff.before : undefined);
            const diffText = typeof metadata?.diff === 'string'
                ? metadata.diff
                : (typeof filediff?.diff === 'string' ? filediff.diff : undefined);
            const additions = typeof filediff?.additions === 'number' ? filediff.additions : undefined;
            const deletions = typeof filediff?.deletions === 'number' ? filediff.deletions : undefined;
            return [
                {
                    filePath: input.filePath,
                    type: existsBefore ? 'update' : 'create',
                    before: existsBefore ? beforeText : '',
                    after: typeof input.content === 'string' ? input.content : '',
                    existsBefore,
                    existsAfter: true,
                    diff: diffText,
                    additions,
                    deletions
                }
            ];
        }
        return [];
    }

    private extractFilesFromToolPart(part: any): FileSnapshot[] {
        const tool = part?.tool;
        if (!tool || part?.state?.status !== 'completed') return [];
        if (tool === 'apply_patch') {
            const stateFiles = Array.isArray(part?.state?.metadata?.files)
                ? part.state.metadata.files
                : [];
            const files: FileSnapshot[] = [];
            for (const file of stateFiles) {
                if (!file?.filePath) continue;
                const type = file?.type as 'update' | 'create' | 'delete' | undefined;
                const existsBefore = typeof file?.existsBefore === 'boolean'
                    ? file.existsBefore
                    : (type === 'create' ? false : type === 'delete' ? true : true);
                const existsAfter = typeof file?.existsAfter === 'boolean'
                    ? file.existsAfter
                    : (type === 'create' ? true : type === 'delete' ? false : true);
                files.push({
                    filePath: file.filePath,
                    relativePath: file.relativePath,
                    type,
                    diff: file.diff,
                    before: file.before,
                    after: file.after,
                    existsBefore,
                    existsAfter,
                    additions: typeof file.additions === 'number' ? file.additions : undefined,
                    deletions: typeof file.deletions === 'number' ? file.deletions : undefined
                });
            }
            return files;
        }
        if (tool === 'edit') {
            const metadata = part?.state?.metadata;
            const filediff = metadata?.filediff;
            if (!filediff?.file) return [];
            return [
                {
                    filePath: filediff.file,
                    type: 'update',
                    diff: typeof metadata?.diff === 'string' ? metadata.diff : undefined,
                    before: typeof filediff.before === 'string' ? filediff.before : undefined,
                    after: typeof filediff.after === 'string' ? filediff.after : undefined,
                    existsBefore: true,
                    existsAfter: true,
                    additions: typeof filediff.additions === 'number' ? filediff.additions : undefined,
                    deletions: typeof filediff.deletions === 'number' ? filediff.deletions : undefined
                }
            ];
        }
        if (tool === 'write') {
            const input = part?.state?.input;
            const metadata = part?.state?.metadata;
            if (!input?.filePath) {
                this.logUiDebug(`write.skip | reason=missing-filePath`);
                return [];
            }
            const existsBefore = typeof metadata?.exists === 'boolean' ? metadata.exists : false;
            const filediff = metadata?.filediff;
            const beforeText = typeof metadata?.before === 'string'
                ? metadata.before
                : (typeof filediff?.before === 'string' ? filediff.before : undefined);
            const diffText = typeof metadata?.diff === 'string'
                ? metadata.diff
                : (typeof filediff?.diff === 'string' ? filediff.diff : undefined);
            const additions = typeof filediff?.additions === 'number' ? filediff.additions : undefined;
            const deletions = typeof filediff?.deletions === 'number' ? filediff.deletions : undefined;
            return [
                {
                    filePath: input.filePath,
                    type: existsBefore ? 'update' : 'create',
                    before: existsBefore ? beforeText : '',
                    after: typeof input.content === 'string' ? input.content : '',
                    existsBefore,
                    existsAfter: true,
                    diff: diffText,
                    additions,
                    deletions
                }
            ];
        }
        return [];
    }

    private extractDeletedPathsFromCommand(command: unknown, cwd: string | undefined): string[] {
        if (typeof command !== 'string' || !command.trim()) return [];
        const normalized = command.trim();
        const lower = normalized.toLowerCase();
        let rawPath = '';

        if (lower.startsWith('rm ')) {
            rawPath = normalized.slice(3).trim();
        } else if (lower.startsWith('del ')) {
            rawPath = normalized.slice(4).trim();
        } else if (lower.startsWith('erase ')) {
            rawPath = normalized.slice(6).trim();
        } else if (lower.startsWith('remove-item ')) {
            rawPath = normalized.slice(12).trim();
        }

        if (!rawPath) return [];
        rawPath = rawPath.replace(/^['"]|['"]$/g, '').trim();
        if (!rawPath) return [];

        const abs = path.isAbsolute(rawPath)
            ? rawPath
            : (cwd ? path.join(cwd, rawPath) : rawPath);
        return [abs];
    }

    private normalizeIncomingFileSnapshots(files: any[]): FileSnapshot[] {
        const normalized: FileSnapshot[] = [];
        for (const raw of files || []) {
            if (!raw) continue;
            if (typeof raw === 'string') {
                const p = raw.trim();
                if (!p) continue;
                normalized.push({ filePath: p, type: 'update' });
                continue;
            }
            const filePath =
                (typeof raw.filePath === 'string' && raw.filePath) ||
                (typeof raw.path === 'string' && raw.path) ||
                (typeof raw.relativePath === 'string' && raw.relativePath) ||
                '';
            if (!filePath) continue;
            normalized.push({
                filePath,
                relativePath: typeof raw.relativePath === 'string' ? raw.relativePath : undefined,
                type: raw.type as 'update' | 'create' | 'delete' | undefined,
                diff: typeof raw.diff === 'string' ? raw.diff : undefined,
                before: typeof raw.before === 'string' ? raw.before : undefined,
                after: typeof raw.after === 'string' ? raw.after : undefined,
                existsBefore: typeof raw.existsBefore === 'boolean' ? raw.existsBefore : undefined,
                existsAfter: typeof raw.existsAfter === 'boolean' ? raw.existsAfter : undefined,
                additions: typeof raw.additions === 'number' ? raw.additions : undefined,
                deletions: typeof raw.deletions === 'number' ? raw.deletions : undefined
            });
        }
        return normalized;
    }

    private buildChangeSpecs(files: FileSnapshot[]): FileChangeSpec[] {
        const changes: FileChangeSpec[] = [];
        for (const file of files) {
            const filePath = typeof file?.filePath === 'string' ? file.filePath.trim() : '';
            if (!filePath) continue;
            const existsBefore = typeof file.existsBefore === 'boolean'
                ? file.existsBefore
                : (file.type === 'create' ? false : file.type === 'delete' ? true : true);
            const existsAfter = typeof file.existsAfter === 'boolean'
                ? file.existsAfter
                : (file.type === 'create' ? true : file.type === 'delete' ? false : true);
            if (!existsAfter) {
                changes.push({ type: 'delete', path: filePath });
            } else if (!existsBefore && existsAfter) {
                changes.push({ type: 'create', path: filePath });
            } else {
                changes.push({ type: 'update', path: filePath });
            }
        }
        return changes;
    }

    private mergeChangeSpecs(changes: FileChangeSpec[]): FileChangeSpec[] {
        if (!changes.length) return [];
        const merged: FileChangeSpec[] = [];
        const indexByKey = new Map<string, number>();
        const pushOrReplace = (change: FileChangeSpec, key: string) => {
            const existingIndex = indexByKey.get(key);
            if (existingIndex !== undefined) {
                merged[existingIndex] = change;
                return;
            }
            indexByKey.set(key, merged.length);
            merged.push(change);
        };
        const flatten = (items: FileChangeSpec[]) => {
            for (const item of items) {
                if (item.type === 'multi') {
                    flatten(item.items);
                    continue;
                }
                if (item.type === 'rename') {
                    const key = `rename:${item.oldPath}->${item.newPath}`;
                    pushOrReplace(item, key);
                    continue;
                }
                const key = `path:${item.path}`;
                pushOrReplace(item, key);
            }
        };
        flatten(changes);
        return merged;
    }

    private queueTurnChanges(
        sessionId: string,
        turnKey: string,
        tmpKey: string | undefined,
        assistantMsgId: string | undefined,
        changeSpecs: FileChangeSpec[]
    ): void {
        if (!sessionId || !turnKey || !changeSpecs.length) return;
        this.markTurnHasWrites(sessionId, 'file-change');
        const existing = this.pendingTurnChangesBySession.get(sessionId);
        if (existing && existing.turnKey !== turnKey) {
            // this.logUiDebug(`[DBG_TURN_QUEUE] session=${sessionId} staleTurn=${existing.turnKey} newTurn=${turnKey} cleared=true`);
            this.pendingTurnChangesBySession.delete(sessionId);
        }
        const next = this.pendingTurnChangesBySession.get(sessionId) || {
            turnKey,
            tmpKey,
            changes: [],
            lastAssistantMsgId: assistantMsgId
        };
        next.turnKey = turnKey;
        if (tmpKey) {
            next.tmpKey = tmpKey;
        }
        if (assistantMsgId) {
            next.lastAssistantMsgId = assistantMsgId;
        }
        next.changes.push(...changeSpecs);
        this.pendingTurnChangesBySession.set(sessionId, next);
        // this.logUiDebug(`[DBG_TURN_QUEUE] session=${sessionId} turnKey=${turnKey} added=${changeSpecs.length} total=${next.changes.length}`);
    }

    // Canonical live ingestion path for subagent→parent change tracking.
    // Replay (`source='resync'`) must never feed parent pending changes.
    private mirrorChangesToParentSession(subagentSessionId: string, changeSpecs: FileChangeSpec[], source: EventSource = 'sse'): void {
        if (!subagentSessionId || !changeSpecs.length) return;
        if (source === 'resync') return;
        const parentSessionId = this.subagentToParentSessionMap.get(subagentSessionId);
        if (!parentSessionId) return;
        const replayKey = `${parentSessionId}::${subagentSessionId}`;
        const seen = this.replayMirroredChangeIdsBySession.get(replayKey) || new Set<string>();
        const fingerprint = changeSpecs
            .map((spec) => {
                if (spec.type === 'multi') {
                    return spec.items
                        .map((item) => {
                            if ('path' in item) return `${item.type}:${item.path}`;
                            if ('oldPath' in item && 'newPath' in item) return `${item.type}:${item.oldPath}->${item.newPath}`;
                            return `${item.type}:unknown`;
                        })
                        .join(',');
                }
                if (spec.type === 'rename') return `${spec.type}:${spec.oldPath}->${spec.newPath}`;
                return `${spec.type}:${spec.path}`;
            })
            .sort()
            .join('|');
        if (seen.has(fingerprint)) {
            return;
        }
        seen.add(fingerprint);
        if (seen.size > 2000) {
            seen.clear();
            seen.add(fingerprint);
        }
        this.replayMirroredChangeIdsBySession.set(replayKey, seen);
        const parentState = this.turnStateBySession.get(parentSessionId);
        const turnKey = parentState?.pendingUserLocalKey || parentSessionId;
        const tmpKey = parentState?.pendingAssistantTmpKey;
        const assistantId = parentState?.assistantMsgId || parentState?.lastResolvedAssistantMsgId;
        this.markTurnHasWrites(parentSessionId, 'subagent-file-change');
        this.queueTurnChanges(parentSessionId, turnKey, tmpKey, assistantId, changeSpecs);
        this.logUiDebug(`subagent.queue.mirror | subagent=${subagentSessionId} parent=${parentSessionId} specs=${changeSpecs.length}`);
    }

    // UI-driven helper for live subagent file events (SidebarProvider). Replay should not invoke this path.
    public queueSubagentChanges(mainSessionId: string, files: any[]): void {
        if (!mainSessionId || !files?.length) return;
        let pending = this.pendingTurnChangesBySession.get(mainSessionId);
        if (!pending) {
            const state = this.turnStateBySession.get(mainSessionId);
            const turnKey = state?.pendingUserLocalKey || mainSessionId;
            pending = {
                turnKey,
                tmpKey: state?.pendingAssistantTmpKey,
                changes: [],
                lastAssistantMsgId: state?.assistantMsgId || state?.lastResolvedAssistantMsgId
            };
            this.pendingTurnChangesBySession.set(mainSessionId, pending);
            this.logUiDebug(`subagent.queue.bootstrap | sessionId=${mainSessionId} turnKey=${turnKey} tmpKey=${pending.tmpKey || 'null'}`);
        }
        const normalizedFiles = this.normalizeIncomingFileSnapshots(files);
        const changeSpecs = this.buildChangeSpecs(normalizedFiles);
        this.logUiDebug(`subagent.queue.normalize | sessionId=${mainSessionId} raw=${files.length} normalized=${normalizedFiles.length} specs=${changeSpecs.length}`);
        if (!changeSpecs.length) return;
        this.markTurnHasWrites(mainSessionId, 'subagent-file-change');
        pending.changes.push(...changeSpecs);
        this.pendingTurnChangesBySession.set(mainSessionId, pending);
    }

    public async commitPendingTurnChanges(sessionId: string): Promise<void> {
        if (!sessionId) return;
        if (!this.gitUndoAvailable || !this.gitUndo) return;
        if (!this.isSessionUndoEnabled(sessionId)) return;
        const pending = this.pendingTurnChangesBySession.get(sessionId);
        if (!pending?.changes?.length) return;
        const state = this.turnStateBySession.get(sessionId);
        const turnKey = pending.turnKey || state?.pendingUserLocalKey || sessionId;
        const tmpKey = state?.pendingAssistantTmpKey || pending.tmpKey;
        const assistantMsgId = state?.assistantMsgId || state?.lastResolvedAssistantMsgId || pending.lastAssistantMsgId;
        const messageIndex = assistantMsgId ? this.messageIndexById.get(assistantMsgId) : undefined;
        const merged = this.mergeChangeSpecs(pending.changes);
        // this.logUiDebug(`[DBG_TURN_COMMIT] session=${sessionId} turnKey=${turnKey} changes=${merged.length} assistantMsgId=${assistantMsgId || 'null'}`);
        try {
            try {
                const repo = await this.gitUndo['repoManager'].resolveRepo(sessionId, turnKey || sessionId);
                const map = await this.gitUndo['mapStore'].loadSessionMap(sessionId, repo.repoId);
                const commitBase = map.currentBaseCommit || map.headCommit;
                if (commitBase) {
                    this.lastTurnCommitBaseBySession.set(sessionId, commitBase);
                }
            } catch {
                // Best effort only. Sidebar falls back to HEAD^ when unavailable.
            }
            await this.gitUndo.commitFileChanges(
                sessionId,
                turnKey,
                tmpKey,
                assistantMsgId,
                merged,
                messageIndex
            );
        } catch (error) {
            this.logUiDebug(`commit.fail | sessionId=${sessionId} err=${String(error)}`);
        } finally {
            this.pendingTurnChangesBySession.delete(sessionId);
        }
    }

    public getLastTurnCommitBase(sessionId: string): string | undefined {
        return this.lastTurnCommitBaseBySession.get(sessionId);
    }

    public async revertPendingTurnChangesToCurrentBase(sessionId: string): Promise<void> {
        if (!sessionId) return;
        if (!this.gitUndoAvailable || !this.gitUndo) return;
        if (!this.isSessionUndoEnabled(sessionId)) return;
        const pending = this.pendingTurnChangesBySession.get(sessionId);
        if (!pending?.changes?.length) return;
        const workspaceRoot = this.workspaceRoot;
        const rawPaths: string[] = [];
        for (const change of this.mergeChangeSpecs(pending.changes)) {
            if (change.type === 'rename') {
                rawPaths.push(change.oldPath, change.newPath);
            } else if ('path' in change) {
                rawPaths.push(change.path);
            }
        }
        const fileSet = normalizeTouchedFiles(workspaceRoot, rawPaths);
        if (!fileSet.length) return;
        const repo = await this.gitUndo['repoManager'].resolveRepo(sessionId, pending.turnKey || sessionId);
        const map = await this.gitUndo['mapStore'].loadSessionMap(sessionId, repo.repoId);
        const restoreCommit = map.currentBaseCommit;
        if (!restoreCommit) return;
        await this.gitUndo.forceRestore(sessionId, restoreCommit, fileSet);
    }

    private registerMessageId(messageId: string): number {
        if (!messageId || (!messageId.startsWith('msg_') && !messageId.startsWith('local-'))) {
            return this.messageIndexById.get(messageId) ?? -1;
        }
        const existing = this.messageIndexById.get(messageId);
        if (existing !== undefined) return existing;
        const index = this.nextMessageIndex++;
        this.messageIndexById.set(messageId, index);
        this.messageOrder.push(messageId);
        return index;
    }

    public registerMessage(messageId: string): number {
        return this.registerMessageId(messageId);
    }

    public async getCommitHashesForMessageIds(sessionId: string, messageIds: string[]): Promise<string[]> {
        if (!sessionId || !this.gitUndoAvailable || !this.gitUndo) return [];
        const ids = Array.isArray(messageIds)
            ? messageIds.filter((id) => typeof id === 'string' && id.startsWith('msg_'))
            : [];
        if (!ids.length) return [];
        const repo = await this.gitUndo['repoManager'].resolveRepo(sessionId, sessionId);
        const map = await this.gitUndo['mapStore'].loadSessionMap(sessionId, repo.repoId);
        const commits = ids.map((id) => map.msgToCommit[id]).filter((commit): commit is string => Boolean(commit));
        return Array.from(new Set(commits));
    }

    public getMessageIndex(messageId: string): number | undefined {
        return this.messageIndexById.get(messageId);
    }

    public getMessageIndexMap(): Array<{ messageId: string; messageIndex: number }> {
        return Array.from(this.messageIndexById.entries())
            .filter(([messageId]) => messageId.startsWith('msg_'))
            .map(([messageId, messageIndex]) => ({
                messageId,
                messageIndex
            }));
    }

    public getUndoRangeForAnchor(startMessageId: string): { startIndex: number; endIndex: number } | undefined {
        const startIndex = this.messageIndexById.get(startMessageId);
        if (typeof startIndex !== 'number') return undefined;
        const tailIndex = this.messageOrder.length ? this.messageOrder.length - 1 : startIndex;
        let effectiveEndIndex = tailIndex;
        const prevSeg = this.revertedSegment;
        const hasActivePrev = Boolean(prevSeg && prevSeg.isActive && !prevSeg.discarded);
        if (hasActivePrev && prevSeg) {
            const prevStartIndex = typeof prevSeg.startMessageIndex === 'number'
                ? prevSeg.startMessageIndex
                : this.messageIndexById.get(prevSeg.startMessageId);
            if (typeof prevStartIndex === 'number') {
                effectiveEndIndex = Math.min(effectiveEndIndex, prevStartIndex - 1);
            }
        }
        return { startIndex, endIndex: effectiveEndIndex };
    }

    public createInternalMessageId(role: 'user' | 'assistant', sessionId?: string): string {
        const session = sessionId || 'local';
        const seq = this.internalMessageSeq++;
        return `internal:${role}:${session}:${seq}`;
    }

    public aliasMessageId(existingId: string, newId: string): void {
        const existingIndex = this.messageIndexById.get(existingId);
        if (existingIndex === undefined) return;
        if (this.messageIndexById.has(newId)) return;
        this.messageIndexById.set(newId, existingIndex);
        const orderIndex = this.messageOrder.indexOf(existingId);
        if (orderIndex !== -1) {
            this.messageOrder[orderIndex] = newId;
        }
        this.messageIndexById.delete(existingId);
    }

    public upgradeMessageId(localKey: string, serverMsgId: string): boolean {
        const existingIndex = this.messageIndexById.get(localKey);
        if (existingIndex === undefined) return false;
        if (this.messageIndexById.has(serverMsgId)) return false;

        this.messageIndexById.set(serverMsgId, existingIndex);
        const orderIndex = this.messageOrder.indexOf(localKey);
        if (orderIndex !== -1) {
            this.messageOrder[orderIndex] = serverMsgId;
        }
        this.messageIndexById.delete(localKey);
        return true;
    }

    private hashText(text: string): string {
        return crypto.createHash('sha1').update(text).digest('hex');
    }

    private normalizeText(text: string): string {
        return text.replace(/\r\n/g, '\n');
    }


    private resolveWorkspaceRoot(): string {
        const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
            ? vscode.workspace.workspaceFolders[0].uri.fsPath
            : process.cwd();
        return workspaceFolder;
    }


    private getMessageIdsInRange(startIndex: number, endIndex: number): string[] {
        return this.messageOrder.filter((id) => {
            if (typeof id !== 'string' || !id.startsWith('msg_')) return false;
            const index = this.messageIndexById.get(id);
            return typeof index === 'number' && index >= startIndex && index <= endIndex;
        });
    }

    private orderedUnionMessageIds(currentIds: string[], previousIds: string[]): string[] {
        const merged = new Set<string>();
        for (const id of currentIds) {
            if (typeof id === 'string' && id.startsWith('msg_')) merged.add(id);
        }
        for (const id of previousIds) {
            if (typeof id === 'string' && id.startsWith('msg_')) merged.add(id);
        }
        return Array.from(merged).sort((a, b) => {
            const ai = this.messageIndexById.get(a);
            const bi = this.messageIndexById.get(b);
            const av = typeof ai === 'number' ? ai : Number.MAX_SAFE_INTEGER;
            const bv = typeof bi === 'number' ? bi : Number.MAX_SAFE_INTEGER;
            return av - bv;
        });
    }

    public getRevertedSegment(): RevertedSegment | undefined {
        return this.revertedSegment;
    }

    public setRevertedSegment(segment: RevertedSegment | undefined): void {
        this.revertedSegment = segment;
    }

    private isValidActiveRevertedSegmentForUndo(prevSeg: RevertedSegment | undefined, startIndex: number): prevSeg is RevertedSegment {
        if (!prevSeg || !prevSeg.isActive || prevSeg.discarded) return false;
        const memberMsgIds = Array.isArray(prevSeg.messageIds)
            ? prevSeg.messageIds.filter((id) => typeof id === 'string' && id.startsWith('msg_'))
            : [];
        if (!memberMsgIds.length) return false;
        const prevStartIndex = typeof prevSeg.startMessageIndex === 'number'
            ? prevSeg.startMessageIndex
            : this.messageIndexById.get(prevSeg.startMessageId);
        if (typeof prevStartIndex !== 'number') return false;
        if (prevStartIndex <= startIndex) return false;
        return memberMsgIds.every((id) => typeof this.messageIndexById.get(id) === 'number');
    }

    public async undoFromMessage(startMessageId: string, options?: { force?: boolean; excludedMessageIds?: string[] }): Promise<{ conflicts: ConflictDetail[]; touchedFiles: string[]; applied: boolean; reason?: string }> {
        const force = options?.force === true;
        const excludedMessageIds = new Set(
            Array.isArray(options?.excludedMessageIds)
                ? options!.excludedMessageIds.filter((id) => typeof id === 'string' && id.startsWith('msg_'))
                : []
        );
        const startIndex = this.messageIndexById.get(startMessageId);
        this.logUiDebug(`EXT: undo.enter | startMessageId | ${startMessageId || 'null'} | force | ${String(force)} | hasSession | ${String(Boolean(this.currentSessionId))} | messageOrderLen | ${this.messageOrder.length}`);
        if (startIndex === undefined) {
            this.logUiDebug(`EXT: undo.anchor.missing | startMessageId | ${startMessageId || 'null'} | startsWithMsg | ${String(startMessageId?.startsWith('msg_'))}`);
            throw new Error('Unknown message for undo.');
        }
        this.logUiDebug(`EXT: undo.anchor.ok | startMessageId | ${startMessageId} | startIndex | ${startIndex}`);
        const tailIndex = this.messageOrder.length ? this.messageOrder.length - 1 : startIndex;
        let effectiveEndIndex = tailIndex;
        const prevSeg = this.revertedSegment;
        const hasActivePrev = this.isValidActiveRevertedSegmentForUndo(prevSeg, startIndex);
        let prevStartIndex: number | undefined;
        let prevEndIndex: number | undefined;
        let canMergePrev = false;
        if (hasActivePrev && prevSeg) {
            prevStartIndex = typeof prevSeg.startMessageIndex === 'number'
                ? prevSeg.startMessageIndex
                : this.messageIndexById.get(prevSeg.startMessageId);
            prevEndIndex = typeof prevSeg.endMessageIndex === 'number'
                ? prevSeg.endMessageIndex
                : this.messageIndexById.get(prevSeg.endMessageId);
            const prevMemberIds = Array.isArray(prevSeg.messageIds)
                ? prevSeg.messageIds.filter((id) => typeof id === 'string' && id.startsWith('msg_'))
                : [];
            const prevHasMembers = prevMemberIds.length > 0;
            const prevStrictlyAfterCurrentStart = typeof prevStartIndex === 'number' && prevStartIndex > startIndex;
            canMergePrev = Boolean(prevHasMembers && prevStrictlyAfterCurrentStart);
            if (!canMergePrev) {
                this.logUiDebug(`EXT: undo.merge.skip | reason=precondition-failed | prevHasMembers=${String(prevHasMembers)} | prevStartIndex=${typeof prevStartIndex === 'number' ? prevStartIndex : 'null'} | startIndex=${startIndex}`);
            }
            if (typeof prevStartIndex === 'number') {
                effectiveEndIndex = Math.min(effectiveEndIndex, prevStartIndex - 1);
            }
        }
        // this.logUiDebug(`EXT: undo.segment.state | hasActivePrev | ${String(hasActivePrev)} | prevStartIndex | ${typeof prevStartIndex === 'number' ? prevStartIndex : 'null'} | prevEndIndex | ${typeof prevEndIndex === 'number' ? prevEndIndex : 'null'} | prevStartId | ${prevSeg?.startMessageId || 'null'} | prevEndId | ${prevSeg?.endMessageId || 'null'}`);
        // this.logUiDebug(`EXT: undo.range | tailIndex | ${tailIndex} | effectiveEndIndex | ${effectiveEndIndex} | startIndex | ${startIndex} | selectedEndIndex | ${effectiveEndIndex}`);
        // OpenCodeClient.outputChannel.appendLine(`[UNDO] startId=${startMessageId} startIndex=${startIndex} endIndex=${effectiveEndIndex}`);
        const sessionId = this.currentSessionId;
        const touchedFiles: string[] = [];
        if (!sessionId) {
            return { conflicts: [], touchedFiles, applied: false, reason: 'missing-session' };
        }
        if (!this.gitUndoAvailable) {
            this.logUiDebug(`EXT: undo.disabled | reason=git-unavailable`);
            return { conflicts: [], touchedFiles, applied: false, reason: 'git-unavailable' };
        }

        if (effectiveEndIndex < startIndex) {
            this.logUiDebug(`EXT: undo.noop.empty-range.pre | startIndex | ${startIndex} | effectiveEndIndex | ${effectiveEndIndex} | tailIndex | ${tailIndex}`);
        }
        if (effectiveEndIndex < startIndex) {
            this.logUiDebug(`EXT: undo.noop.empty-range.final | startIndex | ${startIndex} | effectiveEndIndex | ${effectiveEndIndex}`);
            return { conflicts: [], touchedFiles: [], applied: true, reason: 'empty-range' };
        }

        const messageIds = this.getMessageIdsInRange(startIndex, effectiveEndIndex)
            .filter((id) => !excludedMessageIds.has(id));
        const firstMsgId = messageIds[0] || 'null';
        const lastMsgId = messageIds.length ? messageIds[messageIds.length - 1] : 'null';
        // this.logUiDebug(`EXT: undo.messageIds | count | ${messageIds.length} | first | ${firstMsgId} | last | ${lastMsgId}`);
        // this.logUiDebug(`EXT: undo.messageIds.full | ids | ${JSON.stringify(messageIds)}`);
        // OpenCodeClient.outputChannel.appendLine(`[UNDO] messageIdsInRange=${messageIds.length}`);

        if (this.gitUndoAvailable && this.gitUndo) {
            const result = await this.gitUndo.undoFromMessage(sessionId, startMessageId, messageIds, force);
            if (result.conflicts.length) {
                const conflicts = result.conflicts.map((conflict) => ({
                    path: conflict.path,
                    expectedExists: conflict.expectedExists !== undefined ? conflict.expectedExists : true,
                    currentExists: conflict.currentExists !== undefined ? conflict.currentExists : true,
                    diffText: conflict.diffText || ''
                }));
                return { conflicts, touchedFiles, applied: false, reason: result.reason || 'conflict' };
            }

            let mergedEndId = messageIds.length ? messageIds[messageIds.length - 1] : startMessageId;
            let mergedStartCommits = result.startCommits || (result.startCommit ? [result.startCommit] : []);
            if (canMergePrev && prevSeg) {
                if (Array.isArray(prevSeg.startCommits) && prevSeg.startCommits.length) {
                    mergedStartCommits = [...mergedStartCommits, ...prevSeg.startCommits];
                } else if (prevSeg.startCommit) {
                    mergedStartCommits.push(prevSeg.startCommit);
                }
            }
            if (mergedStartCommits.length > 1) {
                mergedStartCommits = Array.from(new Set(mergedStartCommits));
            }
            const mergedMessageIds = canMergePrev && prevSeg
                ? this.orderedUnionMessageIds(messageIds, Array.isArray(prevSeg.messageIds) ? prevSeg.messageIds : [])
                : messageIds;
            if (mergedMessageIds.length) {
                mergedEndId = mergedMessageIds[mergedMessageIds.length - 1];
            }
            const mergedEndIndex = this.messageIndexById.get(mergedEndId) ?? effectiveEndIndex;

            this.revertedSegment = {
                isActive: true,
                discarded: false,
                startMessageId,
                startMessageIndex: startIndex,
                endMessageId: mergedEndId || startMessageId,
                endMessageIndex: mergedEndIndex,
                opIds: [],
                collapsed: true,
                conflicts: [],
                messageIds: mergedMessageIds,
                startCommit: result.startCommit,
                startCommits: mergedStartCommits,
                restoreCommit: result.restoreCommit,
                undoTargetCommit: result.undoTargetCommit,
                fileSet: result.fileSet
            };
            this.logUiDebug(`EXT: undo.segment.merged | startIndex | ${startIndex} | endIndex | ${mergedEndIndex} | startId | ${startMessageId} | endId | ${mergedEndId} | messageIds | ${mergedMessageIds.length}`);
            return { conflicts: [], touchedFiles: result.touchedFiles, applied: result.applied, reason: result.reason };
        }
        return { conflicts: [], touchedFiles, applied: false, reason: 'git-undo-unavailable' };
    }

    public async restoreAll(options?: { force?: boolean }): Promise<{ conflicts: ConflictDetail[]; touchedFiles: string[]; applied: boolean }> {
        const segment = this.revertedSegment;
        if (!segment || segment.discarded) {
            throw new Error('No active reverted segment to restore.');
        }
        const sessionId = this.currentSessionId;
        if (!sessionId) {
            return { conflicts: [], touchedFiles: [], applied: false };
        }
        if (!this.gitUndoAvailable) {
            this.logUiDebug(`EXT: restore.disabled | reason=git-unavailable`);
            return { conflicts: [], touchedFiles: [], applied: false };
        }
        if (this.gitUndoAvailable && this.gitUndo) {
            const canUseSegmentDirect =
                typeof segment.restoreCommit === 'string' &&
                segment.restoreCommit.length > 0 &&
                typeof segment.undoTargetCommit === 'string' &&
                segment.undoTargetCommit.length > 0 &&
                Array.isArray(segment.fileSet) &&
                segment.fileSet.length > 0;
            if (canUseSegmentDirect) {
                const normalizedFileSet = segment.fileSet!.filter((p) => typeof p === 'string' && p.length > 0);
                const result = await this.gitUndo.restoreAll(
                    sessionId,
                    segment.restoreCommit!,
                    normalizedFileSet,
                    segment.undoTargetCommit!
                );
                if (result.conflicts.length) {
                    const conflicts = result.conflicts.map((conflict) => ({
                        path: conflict.path,
                        expectedExists: conflict.expectedExists !== undefined ? conflict.expectedExists : true,
                        currentExists: conflict.currentExists !== undefined ? conflict.currentExists : true,
                        diffText: conflict.diffText || ''
                    }));
                    return { conflicts, touchedFiles: [], applied: false };
                }
                return { conflicts: [], touchedFiles: result.touchedFiles, applied: result.applied };
            }
            const endMsgId = typeof segment.endMessageId === 'string' ? segment.endMessageId : '';
            if (!endMsgId.startsWith('msg_')) {
                return { conflicts: [], touchedFiles: [], applied: false };
            }
            const messageIds = Array.isArray(segment.messageIds)
                ? segment.messageIds.filter((id) => typeof id === 'string' && id.startsWith('msg_'))
                : [];
            const result = await this.gitUndo.restoreToMessage(sessionId, endMsgId, messageIds, options?.force === true);
            if (result.conflicts.length) {
                const conflicts = result.conflicts.map((conflict) => ({
                    path: conflict.path,
                    expectedExists: conflict.expectedExists !== undefined ? conflict.expectedExists : true,
                    currentExists: conflict.currentExists !== undefined ? conflict.currentExists : true,
                    diffText: conflict.diffText || ''
                }));
                return { conflicts, touchedFiles: [], applied: false };
            }
            return { conflicts: [], touchedFiles: result.touchedFiles, applied: result.applied };
        }
        return { conflicts: [], touchedFiles: [], applied: false };
    }

    public async restoreFromMessage(
        startMessageId: string,
        endMessageId?: string,
        options?: { force?: boolean; messageIds?: string[]; excludedMessageIds?: string[] }
    ): Promise<{ conflicts: ConflictDetail[]; touchedFiles: string[]; applied: boolean }> {
        const sessionId = this.currentSessionId;
        const touchedFiles: string[] = [];
        if (!sessionId) {
            return { conflicts: [], touchedFiles, applied: false };
        }
        if (!this.gitUndoAvailable || !this.gitUndo) {
            this.logUiDebug(`EXT: restore.disabled | reason=git-unavailable`);
            return { conflicts: [], touchedFiles, applied: false };
        }
        const targetMsgId = typeof endMessageId === 'string' && endMessageId.startsWith('msg_')
            ? endMessageId
            : startMessageId;
        const excludedMessageIds = new Set(
            Array.isArray(options?.excludedMessageIds)
                ? options!.excludedMessageIds.filter((id) => typeof id === 'string' && id.startsWith('msg_'))
                : []
        );
        const messageIds = Array.isArray(options?.messageIds)
            ? options.messageIds.filter((id) => typeof id === 'string' && id.startsWith('msg_'))
            : [];
        const filteredMessageIds = messageIds.filter((id) => !excludedMessageIds.has(id));
        const result = await this.gitUndo.restoreToMessage(sessionId, targetMsgId, filteredMessageIds, options?.force === true);
        if (result.conflicts.length) {
            const conflicts = result.conflicts.map((conflict) => ({
                path: conflict.path,
                expectedExists: conflict.expectedExists !== undefined ? conflict.expectedExists : true,
                currentExists: conflict.currentExists !== undefined ? conflict.currentExists : true,
                diffText: conflict.diffText || ''
            }));
            return { conflicts, touchedFiles, applied: false };
        }
        return { conflicts: [], touchedFiles: result.touchedFiles, applied: result.applied };
    }

    public discardRevertedSegment(): void {
        if (!this.revertedSegment?.isActive) return;
        this.revertedSegment.discarded = true;
        this.revertedSegment.isActive = false;
        this.revertedSegment.collapsed = true;
    }

    public setRevertedSegmentCollapsed(collapsed: boolean): void {
        if (!this.revertedSegment) return;
        this.revertedSegment.collapsed = collapsed;
    }

    public removeMessageId(messageId: string): void {
        this.messageIndexById.delete(messageId);
        this.messageOrder = this.messageOrder.filter((id) => id !== messageId);
        this.assistantTextById.delete(messageId);
        for (const set of this.ignoredSummaryMessageIdsBySession.values()) {
            set.delete(messageId);
        }
    }

    private appendAssistantText(msgId: string, chunk: string): void {
        if (!msgId || !chunk) return;
        const existing = this.assistantTextById.get(msgId) || '';
        if (existing.length >= this.assistantTextCacheMax) return;
        const next = (existing + chunk).slice(0, this.assistantTextCacheMax);
        this.assistantTextById.set(msgId, next);
    }

    private isCompactionSummaryInfo(info: any): boolean {
        if (!info || typeof info !== 'object') return false;
        if (info.summary === true) return true;
        const mode = typeof info.mode === 'string' ? info.mode.toLowerCase() : '';
        const agent = typeof info.agent === 'string' ? info.agent.toLowerCase() : '';
        return mode === 'compaction' || agent === 'compaction';
    }

    private isSyntheticUserMessageInfo(info: any): boolean {
        if (!info || typeof info !== 'object') return false;
        if (this.isCompactionSummaryInfo(info)) return true;
        const mode = typeof info.mode === 'string' ? info.mode.toLowerCase() : '';
        const agent = typeof info.agent === 'string' ? info.agent.toLowerCase() : '';
        if (mode === 'compaction' || agent === 'compaction') return true;
        return false;
    }

    private rememberIgnoredSummaryMessage(sessionId: string | undefined, messageId: string | undefined): void {
        if (!sessionId || !messageId) return;
        const existing = this.ignoredSummaryMessageIdsBySession.get(sessionId) || new Set<string>();
        existing.add(messageId);
        this.ignoredSummaryMessageIdsBySession.set(sessionId, existing);
    }

    private isIgnoredSummaryMessage(sessionId: string | undefined, messageId: string | undefined): boolean {
        if (!sessionId || !messageId) return false;
        return this.ignoredSummaryMessageIdsBySession.get(sessionId)?.has(messageId) === true;
    }

    private getAssistantFingerprint(msgId: string): string {
        const text = this.assistantTextById.get(msgId) || '';
        let hash = 0;
        for (let i = 0; i < text.length; i++) {
            hash = ((hash * 31) + text.charCodeAt(i)) >>> 0;
        }
        return `${text.length}:${hash.toString(16)}`;
    }


    private stripAnsi(str: string): string {
        return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
    }

    private getServerBaseUrl(): string {
        if (!this.serverBaseUrl) {
            throw new Error('OpenCode server is not initialized.');
        }
        return this.serverBaseUrl;
    }

    private normalizeWorkspaceRootForHash(workspaceRoot: string): string {
        let normalized = workspaceRoot.replace(/\\/g, '/');
        normalized = normalized.replace(/\/+$/, '');
        if (process.platform === 'win32') {
            normalized = normalized.toLowerCase();
        }
        return normalized;
    }

    private hashWorkspaceRoot(workspaceRoot: string): number {
        const normalized = this.normalizeWorkspaceRootForHash(workspaceRoot);
        let hash = 0;
        for (let i = 0; i < normalized.length; i++) {
            hash = ((hash * 31) + normalized.charCodeAt(i)) >>> 0;
        }
        return hash;
    }

    private getLockDirPath(workspaceRoot: string): string {
        return path.join(workspaceRoot, this.serverLockDir);
    }

    private getLockFilePath(workspaceRoot: string): string {
        return path.join(this.getLockDirPath(workspaceRoot), this.serverLockFile);
    }

    private async ensureLockDir(workspaceRoot: string): Promise<void> {
        const dirPath = this.getLockDirPath(workspaceRoot);
        await fs.promises.mkdir(dirPath, { recursive: true });
    }

    private generateServerPassword(): string {
        return crypto.randomBytes(32).toString('base64');
    }

    private getDefaultPort(workspaceRoot: string): number {
        const hash = this.hashWorkspaceRoot(workspaceRoot);
        return this.serverPortBase + (hash % this.serverPortRange);
    }

    private getPasswordPrefix(password: string): string {
        return password.slice(0, 6);
    }

    private async readServerLockFromDisk(workspaceRoot: string): Promise<{ lock: ServerLock; mtimeMs: number } | null> {
        const lockPath = this.getLockFilePath(workspaceRoot);
        try {
            const raw = await fs.promises.readFile(lockPath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return null;
            const port = Number(parsed.port);
            const password = typeof parsed.password === 'string' ? parsed.password : '';
            const lock: ServerLock = {
                workspaceRoot: typeof parsed.workspaceRoot === 'string' ? parsed.workspaceRoot : workspaceRoot,
                port: Number.isFinite(port) ? port : this.getDefaultPort(workspaceRoot),
                password: password || this.generateServerPassword(),
                updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString()
            };
            const stat = await fs.promises.stat(lockPath);
            return { lock, mtimeMs: stat.mtimeMs };
        } catch {
            return null;
        }
    }

    private async writeServerLock(lock: ServerLock, workspaceRoot: string, logUpdate: boolean): Promise<number> {
        const pathFull = this.getLockFilePath(workspaceRoot);
        const tmpPath = `${pathFull}.tmp`;
        const payload: ServerLock = {
            workspaceRoot: lock.workspaceRoot,
            port: lock.port,
            password: lock.password,
            updatedAt: new Date().toISOString()
        };
        await fs.promises.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
        await fs.promises.rename(tmpPath, pathFull);
        const stat = await fs.promises.stat(pathFull);
        if (logUpdate) {
            this.logUiDebug(`EXT: server.lock.update | port=${payload.port} | updatedAt=${payload.updatedAt}`);
        }
        return stat.mtimeMs;
    }

    private updateServerLockCache(lock: ServerLock, mtimeMs: number): void {
        this.serverLockCache = {
            lock,
            baseUrl: `http://127.0.0.1:${lock.port}`,
            authHeader: this.buildAuthHeader(lock.password),
            mtimeMs
        };
    }

    private async readOrCreateServerLock(workspaceRoot: string): Promise<{ lock: ServerLock; mtimeMs: number }> {
        await this.ensureLockDir(workspaceRoot);
        const lockPath = this.getLockFilePath(workspaceRoot);
        const exists = fs.existsSync(lockPath);
        const defaultPort = this.getDefaultPort(workspaceRoot);

        if (!exists) {
            this.logUiDebug(
                `EXT: server.lock.read | path=${lockPath} | exists=false | port=${defaultPort} | hasPassword=false`
            );
            const lock: ServerLock = {
                workspaceRoot,
                port: defaultPort,
                password: this.generateServerPassword(),
                updatedAt: new Date().toISOString()
            };
            await this.writeServerLock(lock, workspaceRoot, false);
            this.logUiDebug(
                `EXT: server.lock.create | path=${lockPath} | port=${lock.port} | passwordHashPrefix=${this.getPasswordPrefix(lock.password)}`
            );
            const reread = await this.readServerLockFromDisk(workspaceRoot);
            if (reread) {
                this.logUiDebug(
                    `EXT: server.lock.read | path=${lockPath} | exists=true | port=${reread.lock.port} | hasPassword=${String(Boolean(reread.lock.password))}`
                );
                return reread;
            }
            const stat = await fs.promises.stat(lockPath);
            return { lock, mtimeMs: stat.mtimeMs };
        }

        const loaded = await this.readServerLockFromDisk(workspaceRoot);
        if (!loaded) {
            this.logUiDebug(
                `EXT: server.lock.read | path=${lockPath} | exists=true | port=${defaultPort} | hasPassword=false`
            );
            const lock: ServerLock = {
                workspaceRoot,
                port: defaultPort,
                password: this.generateServerPassword(),
                updatedAt: new Date().toISOString()
            };
            const mtimeMs = await this.writeServerLock(lock, workspaceRoot, false);
            this.logUiDebug(
                `EXT: server.lock.create | path=${lockPath} | port=${lock.port} | passwordHashPrefix=${this.getPasswordPrefix(lock.password)}`
            );
            return { lock, mtimeMs };
        }

        const lock = loaded.lock;
        this.logUiDebug(
            `EXT: server.lock.read | path=${lockPath} | exists=true | port=${lock.port} | hasPassword=${String(Boolean(lock.password))}`
        );
        let updated = false;
        const prevPort = lock.port;
        if (lock.workspaceRoot !== workspaceRoot) {
            lock.workspaceRoot = workspaceRoot;
            updated = true;
        }
        if (!lock.password) {
            lock.password = this.generateServerPassword();
            updated = true;
        }
        if (!Number.isFinite(lock.port)) {
            lock.port = defaultPort;
            updated = true;
        }
        if (updated) {
            const portChanged = lock.port !== prevPort;
            const mtimeMs = await this.writeServerLock(lock, workspaceRoot, portChanged);
            return { lock, mtimeMs };
        }
        return loaded;
    }

    private async getServerConn(forceRefresh = false): Promise<ServerConn> {
        const lockPath = this.getLockFilePath(this.workspaceRoot);
        if (!forceRefresh && this.serverLockCache) {
            try {
                const stat = await fs.promises.stat(lockPath);
                if (stat.mtimeMs === this.serverLockCache.mtimeMs) {
                    return {
                        host: '127.0.0.1',
                        port: this.serverLockCache.lock.port,
                        baseUrl: this.serverLockCache.baseUrl,
                        authHeader: this.serverLockCache.authHeader,
                        lock: this.serverLockCache.lock
                    };
                }
            } catch {
                // fall through to refresh
            }
        }

        const { lock, mtimeMs } = await this.readOrCreateServerLock(this.workspaceRoot);
        this.updateServerLockCache(lock, mtimeMs);
        return {
            host: '127.0.0.1',
            port: lock.port,
            baseUrl: `http://127.0.0.1:${lock.port}`,
            authHeader: this.buildAuthHeader(lock.password),
            lock
        };
    }

    private buildAuthHeader(password: string): string {
        return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    }

    private initServerReadyPromise(): void {
        if (this.serverReadyPromise) return;
        this.serverReadyPromise = new Promise((resolve, reject) => {
            this.serverReadyResolve = resolve;
            this.serverReadyReject = reject;
        });
    }

    private markServerReady(): void {
        this.serverReadyResolve?.();
        this.serverReadyResolve = undefined;
        this.serverReadyReject = undefined;
    }

    private failServerReady(error: Error): void {
        this.serverReadyReject?.(error);
        this.serverReadyResolve = undefined;
        this.serverReadyReject = undefined;
        this.serverReadyPromise = undefined;
    }

    private async waitForServerReady(): Promise<void> {
        if (this.serverReadyPromise) {
            await this.serverReadyPromise;
        }
    }

    private async serverFetchOnce(
        conn: { baseUrl: string; authHeader: string },
        reqPath: string,
        init: RequestInit,
        opName: string,
        timeoutMs: number
    ): Promise<Response> {
        const url = new URL(reqPath, conn.baseUrl).toString();
        const headers = new Headers(init.headers || undefined);
        headers.set('Authorization', conn.authHeader);
        if (!headers.has('Content-Type') && init.body && typeof init.body === 'string') {
            headers.set('Content-Type', 'application/json');
        }

        let controller: AbortController | undefined;
        let timeoutId: NodeJS.Timeout | undefined;
        if (timeoutMs > 0) {
            controller = new AbortController();
            timeoutId = setTimeout(() => controller?.abort(), timeoutMs);
            if (init.signal) {
                init.signal.addEventListener('abort', () => controller?.abort(), { once: true });
            }
        }

        try {
            const response = await fetch(url, {
                ...init,
                headers,
                signal: controller ? controller.signal : init.signal
            } as any);
            this.logUiDebug(`EXT: server.fetch | url=${url} | op=${opName} | status=${response.status}`);
            return response;
        } catch (error) {
            this.logUiDebug(`EXT: server.fetch | url=${url} | op=${opName} | err=${String(error)}`);
            throw error;
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
        }
    }

    private async serverFetch(
        reqPath: string,
        init: RequestInit = {},
        options?: {
            opName?: string;
            retry?: boolean;
            timeoutMs?: number;
            noTimeout?: boolean;
            retryOnAbort?: boolean;
            retryTimeoutMs?: number;
            conn?: ServerConn;
            skipReady?: boolean;
        }
    ): Promise<Response> {
        const opName = options?.opName || 'fetch';
        const retry = options?.retry !== false;
        const retryOnAbort = options?.retryOnAbort === true;
        const timeoutMs = options?.noTimeout ? 0 : (options?.timeoutMs ?? 2000);
        const retryTimeoutMs = options?.retryTimeoutMs ?? timeoutMs;
        if (!options?.skipReady) {
            await this.waitForServerReady();
        }
        const conn = options?.conn || await this.getServerConn();
        try {
            const response = await this.serverFetchOnce(conn, reqPath, init, opName, timeoutMs);
            if (response.status === 401 && retry) {
                await this.migrateServerPort(conn.lock, '401');
                const nextConn = await this.getServerConn(true);
                return this.serverFetch(reqPath, init, {
                    opName,
                    retry: false,
                    timeoutMs,
                    noTimeout: options?.noTimeout,
                    retryOnAbort,
                    retryTimeoutMs,
                    conn: nextConn,
                    skipReady: true
                });
            }
            return response;
        } catch (error) {
            if (!retry) throw error;
            if (retryOnAbort && (error as Error)?.name === 'AbortError') {
                const nextConn = await this.getServerConn(true);
                return this.serverFetch(reqPath, init, {
                    opName,
                    retry: false,
                    timeoutMs: retryTimeoutMs,
                    noTimeout: options?.noTimeout,
                    retryOnAbort: false,
                    retryTimeoutMs,
                    conn: nextConn,
                    skipReady: true
                });
            }
            await this.ensureServerForWorkspace(conn.lock.workspaceRoot, 'fetch-retry');
            const nextConn = await this.getServerConn(true);
            return this.serverFetch(reqPath, init, {
                opName,
                retry: false,
                timeoutMs,
                noTimeout: options?.noTimeout,
                retryOnAbort,
                retryTimeoutMs,
                conn: nextConn,
                skipReady: true
            });
        }
    }

    private async checkServerHealth(port: number, password: string, timeoutMs = 1000): Promise<'ok' | 'unauthorized' | 'timeout' | 'connrefused' | 'unreachable'> {
        const conn: ServerConn = {
            host: '127.0.0.1',
            port,
            baseUrl: `http://127.0.0.1:${port}`,
            authHeader: this.buildAuthHeader(password),
            lock: { workspaceRoot: this.workspaceRoot, port, password, updatedAt: new Date().toISOString() }
        };
        try {
            const response = await this.serverFetch('/global/health', { method: 'GET' }, { opName: 'health', retry: false, timeoutMs, conn, skipReady: true });
            if (response.status === 200) return 'ok';
            if (response.status === 401) return 'unauthorized';
            return 'unreachable';
        } catch (error) {
            if ((error as Error)?.name === 'AbortError') return 'timeout';
            const err = error as NodeJS.ErrnoException;
            if (err && err.code === 'ECONNREFUSED') return 'connrefused';
            return 'unreachable';
        }
    }

    private async ensureServerForWorkspace(workspaceRoot: string, reason: string): Promise<void> {
        if (this.serverBaseUrl) {
            return;
        }
        const { lock, mtimeMs } = await this.readOrCreateServerLock(workspaceRoot);
        this.updateServerLockCache(lock, mtimeMs);
        const initialHealth = await this.checkServerHealth(lock.port, lock.password, 1000);
        this.logUiDebug(`EXT: server.health.try | port=${lock.port} | result=${initialHealth}`);

        if (initialHealth === 'ok') {
            this.serverBaseUrl = `http://127.0.0.1:${lock.port}`;
            this.serverPort = lock.port;
            this.serverPassword = lock.password;
            this.updateServerLockCache(lock, mtimeMs);
            this.initServerReadyPromise();
            this.markServerReady();
            this.logUiDebug(`EXT: server.reuse | port=${lock.port}`);
            return;
        }

        if (initialHealth === 'unauthorized') {
            await this.migrateServerPort(lock, '401');
            return;
        }

        await this.startServerWithLock(lock);
    }

    private async migrateServerPort(lock: ServerLock, reason: '401' | 'EADDRINUSE'): Promise<void> {
        const baseHash = this.hashWorkspaceRoot(lock.workspaceRoot);
        const startPort = lock.port;
        for (let i = 0; i < this.serverPortRange; i++) {
            const candidate = this.serverPortBase + ((baseHash + i) % this.serverPortRange);
            const result = await this.checkServerHealth(candidate, lock.password, 1000);
            this.logUiDebug(`EXT: server.health.try | port=${candidate} | result=${result}`);
            if (result === 'ok') {
                lock.port = candidate;
                const mtimeMs = await this.writeServerLock(lock, lock.workspaceRoot, candidate !== startPort);
                this.serverBaseUrl = `http://127.0.0.1:${candidate}`;
                this.serverPort = candidate;
                this.serverPassword = lock.password;
                this.updateServerLockCache(lock, mtimeMs);
                this.logUiDebug(`EXT: server.reuse | port=${candidate}`);
                if (candidate !== startPort) {
                    this.logUiDebug(`EXT: server.migrate | fromPort=${startPort} | toPort=${candidate} | reason=${reason}`);
                }
                return;
            }
            if (result === 'unauthorized') {
                continue;
            }
            lock.port = candidate;
            const mtimeMs = await this.writeServerLock(lock, lock.workspaceRoot, candidate !== startPort);
            this.updateServerLockCache(lock, mtimeMs);
            if (candidate !== startPort) {
                this.logUiDebug(`EXT: server.migrate | fromPort=${startPort} | toPort=${candidate} | reason=${reason}`);
            }
            await this.startServerWithLock(lock);
            return;
        }

        const message = `OpenCode server failed to find available port in range ${this.serverPortBase}-${this.serverPortBase + this.serverPortRange - 1}.`;
        vscode.window.showErrorMessage(message);
        throw new Error(message);
    }

    private async startServerWithLock(lock: ServerLock): Promise<void> {
        const port = lock.port;
        this.initServerReadyPromise();
        const spawnSpec = await this.buildServeSpawn(['serve', '--port', String(port), '--hostname', '127.0.0.1']);
        this.serverProcess = cp.spawn(spawnSpec.command, spawnSpec.args, {
            cwd: this.workspaceRoot,
            shell: false,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8', OPENCODE_SERVER_PASSWORD: lock.password }
        });
        this.serverPort = port;
        this.serverPid = this.serverProcess.pid;
        this.serverBaseUrl = `http://127.0.0.1:${port}`;
        this.serverPassword = lock.password;
        this.logUiDebug(`EXT: server.start | port=${port} | pid=${this.serverPid || 'null'}`);

        try {
            await this.waitForServerHealthy(port, lock.password);
            this.markServerReady();
        } catch (error) {
            const err = error as (Error & { code?: string });
            if (err?.code === 'UNAUTHORIZED') {
                await this.migrateServerPort(lock, '401');
                return;
            }
            const health = await this.checkServerHealth(port, lock.password, 1000);
            if (health === 'unauthorized') {
                await this.migrateServerPort(lock, '401');
                return;
            }
            this.serverBaseUrl = undefined;
            this.serverPort = undefined;
            this.serverPid = undefined;
            this.serverPassword = undefined;
            this.failServerReady(error as Error);
            throw error;
        }
    }

    private async killProcessTree(pid: number): Promise<void> {
        if (process.platform === 'win32') {
            await new Promise<void>((resolve) => {
                const attemptKill = () => {
                    cp.exec(`taskkill /PID ${pid} /T /F`, async (_err, stdout, stderr) => {
                        const output = `${String(stdout || '')}\n${String(stderr || '')}`;
                        if (/SUCCESS/i.test(output)) {
                            resolve();
                            return;
                        }
                        const exists = await this.isProcessRunningWindows(pid);
                        if (!exists) {
                            resolve();
                            return;
                        }
                        setTimeout(attemptKill, 500);
                    });
                };
                attemptKill();
            });
            return;
        }
        try {
            process.kill(pid, 'SIGTERM');
        } catch {
            // ignore
        }
    }

    private async isProcessRunningWindows(pid: number): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            cp.exec(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, (err, stdout, stderr) => {
                const output = `${String(stdout || '')}\n${String(stderr || '')}`;
                if (err && /No tasks are running|没有运行的任务|找不到/i.test(output)) {
                    resolve(false);
                    return;
                }
                if (/No tasks are running|没有运行的任务|找不到/i.test(output)) {
                    resolve(false);
                    return;
                }
                resolve(new RegExp(`\\b${pid}\\b`).test(output));
            });
        });
    }

    public async shutdownServer(): Promise<void> {
        const pid = this.serverProcess?.pid || this.serverPid;
        if (pid) {
            await this.killProcessTree(pid);
        }
        this.serverProcess = undefined;
        this.serverBaseUrl = undefined;
        this.serverPort = undefined;
        this.serverPid = undefined;
        this.serverPassword = undefined;
        this.serverStartPromise = undefined;
        this.serverReadyPromise = undefined;
        this.serverReadyResolve = undefined;
        this.serverReadyReject = undefined;
        this.eventStreamAbort?.abort();
        this.eventStreamActive = false;
    }

    private async buildServeSpawn(args: string[]): Promise<{ command: string; args: string[] }> {
        const bin = await this.resolveBin();
        return this.buildSpawn(bin, args);
    }

    private async waitForServerHealthy(port: number, password: string): Promise<void> {
        const maxAttempts = 10;
        const baseDelay = 300;
        const maxDelay = 3000;
        const timeoutMs = 2000;
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            const result = await this.checkServerHealth(port, password, timeoutMs);
            if (result === 'ok') return;
            if (result === 'unauthorized') {
                const err = new Error('OpenCode server unauthorized.');
                (err as Error & { code?: string }).code = 'UNAUTHORIZED';
                throw err;
            }
            const delay = Math.min(baseDelay * (2 ** attempt), maxDelay);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
        throw new Error('OpenCode server failed to start.');
    }

    private async findAvailablePort(start: number, end: number): Promise<number> {
        for (let port = start; port <= end; port++) {
            if (await this.isPortAvailable(port)) {
                return port;
            }
        }
        throw new Error(`No available port found between ${start} and ${end}.`);
    }

    private async isPortAvailable(port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const server = net.createServer();
            server.once('error', () => resolve(false));
            server.once('listening', () => {
                server.close(() => resolve(true));
            });
            server.listen(port, '127.0.0.1');
        });
    }

    private async requestJson<T>(method: string, path: string, body?: any): Promise<T> {
        const options: any = { method };
        if (body !== undefined && method !== 'GET') {
            options.body = JSON.stringify(body);
            options.headers = { 'Content-Type': 'application/json' };
        }
        const fetchOptions = this.getFetchOptionsForPath(method, path);
        const response = await this.serverFetch(path, options, fetchOptions);
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Server ${method} ${path} failed: ${response.status} ${text}`);
        }
        if (response.status === 204) {
            return {} as T;
        }
        return (await response.json()) as T;
    }

    private getFetchOptionsForPath(method: string, reqPath: string): {
        opName: string;
        timeoutMs: number;
        retryOnAbort?: boolean;
        retryTimeoutMs?: number;
    } {
        const messageMatch = /\/session\/[^/]+\/message(?:\?.*)?$/.test(reqPath);
        const promptAsyncMatch = /\/session\/[^/]+\/prompt_async(?:\?.*)?$/.test(reqPath);
        const sessionInfoMatch = /\/session\/[^/?]+(?:\?.*)?$/.test(reqPath);
        if (reqPath === '/global/health') {
            return { opName: 'health', timeoutMs: 1000 };
        }
        if (reqPath === '/config/providers') {
            return { opName: 'models.list', timeoutMs: 5000 };
        }
        if (reqPath === '/session') {
            return { opName: 'sessions.list', timeoutMs: 5000 };
        }
        if (messageMatch) {
            return {
                opName: 'session.message',
                timeoutMs: 20000,
                retryOnAbort: true,
                retryTimeoutMs: 30000
            };
        }
        if (promptAsyncMatch) {
            return {
                opName: 'session.post',
                timeoutMs: 60000,
                retryOnAbort: true,
                retryTimeoutMs: 90000
            };
        }
        if (sessionInfoMatch) {
            return { opName: 'session.info', timeoutMs: 10000, retryOnAbort: true, retryTimeoutMs: 15000 };
        }
        if (reqPath.startsWith('/session/')) {
            return { opName: `session.${method.toLowerCase()}`, timeoutMs: 5000 };
        }
        return { opName: `${method.toLowerCase()} ${reqPath}`, timeoutMs: 5000 };
    }

    private parseModelRef(model?: string): { providerID: string; modelID: string } | undefined {
        if (!model) return undefined;
        const parts = model.split('/');
        if (parts.length < 2) return undefined;
        return { providerID: parts[0], modelID: parts.slice(1).join('/') };
    }

    private connectEventStream(): void {
        if (this.eventStreamActive) return;
        this.eventStreamActive = true;
        this.eventStreamAbort?.abort();
        this.eventStreamAbort = new AbortController();
        const signal = this.eventStreamAbort.signal;

        const start = async () => {
            try {
                const response = await this.serverFetch('/event', { method: 'GET', signal }, { opName: 'event', retry: false, noTimeout: true });
                if (!response.ok || !response.body) {
                    throw new Error(`Event stream failed: ${response.status}`);
                }
                this.eventStreamFailCount = 0;
                this.updateServerStatus('connected', 'event-stream-open');
                this.eventStreamBackoffMs = 1000;
                const reader = response.body.getReader();
                let buffer = '';
                let streamClosed = false;
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) {
                        streamClosed = true;
                        break;
                    }
                    buffer += new TextDecoder('utf-8').decode(value, { stream: true });
                    const lines = buffer.split(/\r?\n/);
                    buffer = lines.pop() || '';
                    for (const line of lines) {
                        if (!line.startsWith('data:')) continue;
                        const payload = line.slice(5).trim();
                        if (!payload) continue;
                        this.handleServerEvent(payload);
                    }
                }
                if (streamClosed) {
                    this.logUiDebug('EXT: event.closed');
                    this.triggerImmediateResyncForAwaitingFinals('event-stream-close');
                }
            } catch (error) {
                if ((error as Error).name === 'AbortError') return;
                this.eventStreamFailCount += 1;
                this.updateServerStatus('reconnecting', 'event-stream-error');
                this.logUiDebug(`EXT: event.fail | count=${this.eventStreamFailCount}`);
                this.triggerImmediateResyncForAwaitingFinals('event-stream-error');
                if (this.eventStreamFailCount >= 3) {
                    void this.handleEventStreamFailure();
                }
            }

            this.eventStreamActive = false;
            await this.scheduleEventStreamReconnect();
        };

        void start();
    }

    private async scheduleEventStreamReconnect(): Promise<void> {
        const delay = this.eventStreamBackoffMs;
        this.eventStreamBackoffMs = Math.min(this.eventStreamBackoffMs * 2, 30000);
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (!this.eventStreamActive) {
            this.connectEventStream();
        }
    }

    private async handleEventStreamFailure(): Promise<void> {
        if (this.eventStreamFailureInFlight) return;
        this.eventStreamFailureInFlight = true;
        try {
            const conn = await this.getServerConn(true);
            const health = await this.checkServerHealth(conn.lock.port, conn.lock.password, 1000);
            this.logUiDebug(`EXT: event.fail.health | result=${health}`);
            if (health === 'ok') {
                if (this.currentSessionId) {
                    this.scheduleSessionResyncLimited(this.currentSessionId, 'event-stream-fail');
                }
                return;
            }
            this.triggerImmediateResyncForAwaitingFinals('event-stream-reconnect-fail');
            await this.restartServerFromEventFailure(`health=${health}`);
        } catch (error) {
            this.logUiDebug(`EXT: event.fail.handler | err=${String(error)}`);
            this.updateServerStatus('error', 'event-stream-fail');
            this.triggerImmediateResyncForAwaitingFinals('event-stream-reconnect-fail');
        } finally {
            this.eventStreamFailureInFlight = false;
        }
    }

    private async restartServerFromEventFailure(reason: string): Promise<void> {
        const now = Date.now();
        if (now - this.restartWindowStart > 5 * 60 * 1000) {
            this.restartWindowStart = now;
            this.restartAttemptCount = 0;
        }
        if (now - this.lastRestartAt < this.restartCooldownMs) {
            this.logUiDebug(`EXT: server.restart.skip | reason=cooldown | detail=${reason}`);
            this.updateServerStatus('error', 'restart-cooldown');
            return;
        }
        if (this.restartAttemptCount >= this.maxRestartsPerWindow) {
            this.logUiDebug(`EXT: server.restart.skip | reason=limit | detail=${reason}`);
            this.updateServerStatus('error', 'restart-limit');
            return;
        }
        this.restartAttemptCount += 1;
        this.lastRestartAt = now;
        this.updateServerStatus('reconnecting', 'restart');
        this.logUiDebug(`EXT: server.restart | reason=${reason}`);
        await this.shutdownServer();
        await this.ensureServer();
        this.updateServerStatus('connected', 'restart-success');
        if (this.currentSessionId) {
            this.scheduleSessionResyncLimited(this.currentSessionId, 'event-stream-restart');
        }
    }

    private emitChatEvents(events: ChatEvent[]): void {
        if (!events.length) return;
        for (const event of events) {
            for (const listener of this.eventListeners) {
                listener(event);
            }
        }
    }

    private makeFinalMetaDedupeKey(sessionId: string | undefined, messageId: string, completedAt: unknown, finish: unknown): string {
        void completedAt;
        void finish;
        return `${sessionId || ''}|${messageId}|final`;
    }

    private shouldEmitFinalMeta(
        sessionId: string | undefined,
        messageId: string,
        completedAt: unknown,
        finish: unknown,
        source: EventSource
    ): boolean {
        if (!messageId) return false;
        const key = this.makeFinalMetaDedupeKey(sessionId, messageId, completedAt, finish);
        const bucketKey = sessionId || '__global__';
        const seen = this.finalMetaSeenKeysBySession.get(bucketKey) || new Set<string>();
        if (seen.has(key)) {
            this.logUiDebug(`EXT: meta.drop.dup | key=${key} | source=${source}`);
            return false;
        }
        seen.add(key);
        if (seen.size > 1200) {
            seen.clear();
            seen.add(key);
        }
        this.finalMetaSeenKeysBySession.set(bucketKey, seen);
        return true;
    }

    private consumePhaseOnce(sessionId: string | undefined, messageId: string | undefined, phase: string): boolean {
        if (!phase) return false;
        const bucketKey = sessionId || '__global__';
        const scopedId = messageId || '__none__';
        const key = `${bucketKey}|${scopedId}|${phase}`;
        const seen = this.phaseSeenKeysBySession.get(bucketKey) || new Set<string>();
        if (seen.has(key)) return false;
        seen.add(key);
        if (seen.size > 2400) {
            seen.clear();
            seen.add(key);
        }
        this.phaseSeenKeysBySession.set(bucketKey, seen);
        return true;
    }

    private emitAssistantPhase(
        events: ChatEvent[] | undefined,
        params: {
            sessionId?: string;
            messageId?: string;
            parentId?: string;
            source: EventSource;
            lane: EventLane;
            phase: 'assistant_progress' | 'assistant_final_candidate' | 'assistant_final_accepted';
            reason: string;
        }
    ): void {
        const { sessionId, messageId, parentId, source, lane, phase, reason } = params;
        if (!messageId) return;
        if (!this.consumePhaseOnce(sessionId, messageId, `assistant:${phase}`)) return;
        const prev = this.assistantPhaseByMessageId.get(messageId) || 'assistant_progress';
        if (prev === 'assistant_final_accepted' && phase !== 'assistant_final_accepted') {
            this.task1Metrics.falseDoneEvents += 1;
        }
        if (phase === 'assistant_final_candidate') {
            this.assistantFinalCandidateAtByMessageId.set(messageId, Date.now());
        }
        if (phase === 'assistant_final_accepted') {
            const candidateAt = this.assistantFinalCandidateAtByMessageId.get(messageId);
            if (typeof candidateAt === 'number') {
                const latency = Math.max(0, Date.now() - candidateAt);
                this.task1Metrics.finalAcceptLatencyTotalMs += latency;
            }
            this.task1Metrics.finalAcceptCount += 1;
        }
        this.assistantPhaseByMessageId.set(messageId, phase);
        this.logUiDebug(
            `EXT: state.transition | from=${prev} | to=${phase} | reason=${reason} | messageId=${messageId} | parentId=${parentId || 'null'} | lane=${lane} | source=${source} | sessionId=${sessionId || 'null'}`
        );
        const evt: ChatEvent = {
            type: 'assistantPhase',
            sessionId,
            messageId,
            assistantMsgId: messageId,
            phase,
            lane
        };
        if (events) {
            events.push(evt);
        } else {
            this.emitChatEvents([evt]);
        }
    }

    private isCompletionFinal(info: any): boolean {
        const finish = info?.finish;
        if (typeof finish === 'string') {
            return finish === 'stop';
        }
        return false;
    }

    private hasRunningToolsForMessage(messageId: string | undefined): boolean {
        if (!messageId) return false;
        const count = this.toolRunningByMessageId.get(messageId) || 0;
        return count > 0;
    }

    private getFinalizingMsgId(sessionId: string | undefined): string | undefined {
        if (!sessionId) return undefined;
        return this.finalizingMsgIdBySession.get(sessionId) || this.turnFinalMsgIdBySession.get(sessionId);
    }

    private updateToolStatus(sessionId: string | undefined, callId: string | null, status: string | undefined): { becameTerminal: boolean; hadActiveBefore: boolean; hasActiveAfter: boolean } {
        if (!sessionId || !callId || !status) {
            return { becameTerminal: false, hadActiveBefore: false, hasActiveAfter: false };
        }
        const bucket = this.toolStatusBySession.get(sessionId) || new Map<string, string>();
        const prev = bucket.get(callId);
        const wasActive = prev === 'pending' || prev === 'running';
        const isActive = status === 'pending' || status === 'running';
        const isTerminal = status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'canceled';
        if (isTerminal) {
            bucket.delete(callId);
        } else {
            bucket.set(callId, status);
        }
        if (bucket.size > 0) {
            this.toolStatusBySession.set(sessionId, bucket);
        } else {
            this.toolStatusBySession.delete(sessionId);
        }
        const hasActiveAfter = Array.from(bucket.values()).some((value) => value === 'pending' || value === 'running');
        return { becameTerminal: isTerminal && wasActive, hadActiveBefore: wasActive, hasActiveAfter };
    }

    private hasPendingOrRunningTools(sessionId: string | undefined): boolean {
        if (!sessionId) return false;
        const bucket = this.toolStatusBySession.get(sessionId);
        if (!bucket || bucket.size === 0) return false;
        for (const status of bucket.values()) {
            if (status === 'pending' || status === 'running') return true;
        }
        return false;
    }

    private getOpencodeDataDirCandidates(): string[] {
        const env = process.env;
        const home = os.homedir();
        const dataBase = (env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim()) || path.join(home, '.local', 'share');
        const dirs = [path.join(dataBase, 'opencode')];
        if (process.platform === 'win32') {
            const appData = (env.APPDATA && env.APPDATA.trim()) || path.join(home, 'AppData', 'Roaming');
            const localAppData = (env.LOCALAPPDATA && env.LOCALAPPDATA.trim()) || path.join(home, 'AppData', 'Local');
            dirs.push(path.join(appData, 'opencode'));
            dirs.push(path.join(localAppData, 'opencode'));
        }
        return Array.from(new Set(dirs));
    }

    private async readAuthJson(): Promise<any | null> {
        const candidates = this.getOpencodeDataDirCandidates().map((dir) => path.join(dir, 'auth.json'));
        for (const candidate of candidates) {
            try {
                const raw = await fs.promises.readFile(candidate, 'utf8');
                return JSON.parse(raw);
            } catch {
                continue;
            }
        }
        return null;
    }

    private async httpsJson(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<any> {
        const method = options.method || 'GET';
        return new Promise((resolve, reject) => {
            const req = https.request(url, { method, headers: options.headers }, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
                        reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage || ''}`.trim()));
                        return;
                    }
                    try {
                        resolve(JSON.parse(raw));
                    } catch (error) {
                        reject(new Error(`Failed to parse JSON: ${String(error)}`));
                    }
                });
            });
            req.on('error', reject);
            if (options.body) {
                req.write(options.body);
            }
            req.end();
        });
    }

    private formatReset(resetAt?: number, resetAfterSeconds?: number): string | undefined {
        if (typeof resetAt === 'number' && Number.isFinite(resetAt) && resetAt > 0) {
            const dt = new Date(resetAt * 1000);
            const now = Date.now();
            if (dt.getTime() - now < 24 * 60 * 60 * 1000) {
                return `resets at ${dt.toLocaleTimeString()}`;
            }
            return `resets on ${dt.toLocaleDateString()}`;
        }
        if (typeof resetAfterSeconds === 'number' && Number.isFinite(resetAfterSeconds) && resetAfterSeconds > 0) {
            const minutes = Math.round(resetAfterSeconds / 60);
            if (minutes >= 60) {
                const hours = Math.floor(minutes / 60);
                const rem = minutes % 60;
                return rem ? `resets in ${hours}h ${rem}m` : `resets in ${hours}h`;
            }
            return `resets in ${minutes}m`;
        }
        return undefined;
    }

    private async fetchOpenAIQuota(): Promise<ModelQuota | null> {
        const auth = await this.readAuthJson();
        const openai = auth?.openai || auth?.codex || auth?.chatgpt || auth?.opencode;
        const access = openai?.access;
        if (!access) return null;
        const headers: Record<string, string> = {
            Authorization: `Bearer ${access}`,
            'User-Agent': 'OpenCode-Quota/1.0'
        };
        if (openai?.accountId) {
            headers['ChatGPT-Account-Id'] = openai.accountId;
        }
        let data: any;
        try {
            data = await this.httpsJson('https://chatgpt.com/backend-api/wham/usage', { headers });
        } catch {
            return null;
        }
        const rate = data?.rate_limit || {};
        const primary = rate?.primary_window || {};
        const secondary = rate?.secondary_window || {};
        const primaryRemain = typeof primary.used_percent === 'number' ? Math.max(0, 100 - primary.used_percent) : null;
        const secondaryRemain = typeof secondary.used_percent === 'number' ? Math.max(0, 100 - secondary.used_percent) : null;
        const rows: ModelQuotaRow[] = [];
        if (primaryRemain !== null) {
            rows.push({
                label: '5h',
                remainingPercent: Math.round(primaryRemain),
                resetText: this.formatReset(primary.reset_at, primary.reset_after_seconds)
            });
        }
        if (secondaryRemain !== null) {
            rows.push({
                label: 'Weekly',
                remainingPercent: Math.round(secondaryRemain),
                resetText: this.formatReset(secondary.reset_at, secondary.reset_after_seconds)
            });
        }
        if (!rows.length) return null;
        const summary = Math.min(...rows.map((r) => r.remainingPercent));
        return {
            providerId: 'openai',
            modelId: 'openai',
            summaryRemainingPercent: summary,
            rows,
            fetchedAt: Date.now()
        };
    }

    private async fetchCopilotQuota(): Promise<ModelQuota | null> {
        const auth = await this.readAuthJson();
        const copilot = auth?.['github-copilot'] || auth?.github;
        const token = copilot?.access || copilot?.refresh;
        if (!token) return null;
        let data: any;
        try {
            data = await this.httpsJson('https://api.github.com/copilot_internal/user', {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/json',
                    'User-Agent': 'GitHubCopilotChat/0.35.0',
                    'Editor-Version': 'vscode/1.107.0',
                    'Editor-Plugin-Version': 'copilot-chat/0.35.0',
                    'Copilot-Integration-Id': 'vscode-chat'
                }
            });
        } catch {
            return null;
        }
        const premium = data?.quota_snapshots?.premium_interactions;
        if (!premium) return null;
        const remaining = typeof premium.percent_remaining === 'number'
            ? Math.max(0, Math.min(100, Math.round(premium.percent_remaining)))
            : null;
        if (remaining === null) return null;
        return {
            providerId: 'github-copilot',
            modelId: 'copilot',
            summaryRemainingPercent: remaining,
            rows: [{
                label: 'Monthly',
                remainingPercent: remaining,
                resetText: data?.quota_reset_date ? `resets on ${new Date(data.quota_reset_date).toLocaleDateString()}` : undefined
            }],
            fetchedAt: Date.now()
        };
    }

    private async fetchAntigravityQuota(modelFullId: string): Promise<ModelQuota | null> {
        const env = process.env;
        const home = os.homedir();
        const configBase = (env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim()) || path.join(home, '.config');
        const candidates = [path.join(configBase, 'opencode', 'antigravity-accounts.json')];
        if (process.platform === 'win32') {
            const appData = (env.APPDATA && env.APPDATA.trim()) || path.join(home, 'AppData', 'Roaming');
            candidates.push(path.join(appData, 'opencode', 'antigravity-accounts.json'));
        }
        let accounts: any = null;
        for (const candidate of candidates) {
            try {
                const raw = await fs.promises.readFile(candidate, 'utf8');
                accounts = JSON.parse(raw);
                break;
            } catch {
                continue;
            }
        }
        const account = accounts?.accounts?.[accounts.activeIndex ?? 0];
        const refresh = account?.refreshToken;
        if (!refresh) return null;

        const oauth = await this.getAntigravityOAuthConstants();
        if (!oauth) {
            this.logUiDebug('EXT: quota.antigravity.skip | reason=missing-oauth-constants');
            return null;
        }

        let tokenData: any;
        try {
            tokenData = await this.httpsJson('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: oauth.clientId,
                    client_secret: oauth.clientSecret,
                    refresh_token: refresh,
                    grant_type: 'refresh_token'
                }).toString()
            });
        } catch {
            return null;
        }
        const accessToken = tokenData?.access_token;
        if (!accessToken) return null;

        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'User-Agent': 'antigravity/1.11.5 windows/amd64',
            'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
            'Client-Metadata': '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
            Authorization: `Bearer ${accessToken}`
        };
        const endpoints = [
            'https://daily-cloudcode-pa.sandbox.googleapis.com',
            'https://autopush-cloudcode-pa.sandbox.googleapis.com',
            'https://cloudcode-pa.googleapis.com'
        ];
        let models: any = null;
        for (const endpoint of endpoints) {
            try {
                const json = await this.httpsJson(`${endpoint}/v1internal:fetchAvailableModels`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(account?.projectId ? { project: account.projectId } : {})
                });
                models = json?.models || null;
                if (models) break;
            } catch {
                continue;
            }
        }
        if (!models) return null;
        const target = modelFullId.toLowerCase();
        let best: { label: string; remainingFraction: number; resetTime?: string } | null = null;
        for (const key of Object.keys(models)) {
            const info = models[key];
            const quota = info?.quotaInfo;
            if (!quota || typeof quota.remainingFraction !== 'number') continue;
            const label = (info.displayName || info.model || key || '').toString();
            const labelKey = label.toLowerCase();
            const modelKey = (info.model || key || '').toString().toLowerCase();
            if (target.includes(labelKey) || target.includes(modelKey)) {
                best = { label, remainingFraction: quota.remainingFraction, resetTime: quota.resetTime };
                break;
            }
            if (!best) {
                best = { label, remainingFraction: quota.remainingFraction, resetTime: quota.resetTime };
            }
        }
        if (!best) return null;
        const remaining = Math.round(best.remainingFraction * 100);
        return {
            providerId: 'google-antigravity',
            modelId: modelFullId,
            summaryRemainingPercent: remaining,
            rows: [{
                label: best.label,
                remainingPercent: remaining,
                resetText: best.resetTime ? `resets on ${new Date(best.resetTime).toLocaleDateString()}` : undefined
            }],
            fetchedAt: Date.now()
        };
    }

    private async getAntigravityOAuthConstants(): Promise<AntigravityOAuthConstants | null> {
        if (!this.antigravityOAuthConstantsPromise) {
            this.antigravityOAuthConstantsPromise = this.resolveAntigravityOAuthConstants();
        }
        return this.antigravityOAuthConstantsPromise;
    }

    private async resolveAntigravityOAuthConstants(): Promise<AntigravityOAuthConstants | null> {
        try {
            const loaded = require('opencode-antigravity-auth/dist/src/constants.js') as Record<string, unknown>;
            const clientId = typeof loaded.ANTIGRAVITY_CLIENT_ID === 'string' ? loaded.ANTIGRAVITY_CLIENT_ID.trim() : '';
            const clientSecret = typeof loaded.ANTIGRAVITY_CLIENT_SECRET === 'string' ? loaded.ANTIGRAVITY_CLIENT_SECRET.trim() : '';
            if (clientId && clientSecret) {
                this.logUiDebug('EXT: quota.antigravity.auth-source | source=opencode-antigravity-auth');
                return { clientId, clientSecret };
            }
        } catch {
            // Fallback to env vars only when runtime package is unavailable.
        }

        const env = process.env;
        const clientId = String(
            env.ANTIGRAVITY_CLIENT_ID
            || env.OPENCODE_ANTIGRAVITY_CLIENT_ID
            || ''
        ).trim();
        const clientSecret = String(
            env.ANTIGRAVITY_CLIENT_SECRET
            || env.OPENCODE_ANTIGRAVITY_CLIENT_SECRET
            || ''
        ).trim();
        if (clientId && clientSecret) {
            this.logUiDebug('EXT: quota.antigravity.auth-source | source=env');
            return { clientId, clientSecret };
        }
        return null;
    }

    public async fetchModelQuota(model: ModelInfo): Promise<ModelQuota | null> {
        const key = model.fullId;
        const cached = this.modelQuotaCache.get(key);
        if (cached && Date.now() - cached.ts < this.quotaCacheTtlMs) {
            return cached.quota;
        }
        const inflight = this.modelQuotaInFlight.get(key);
        if (inflight) return inflight;
        const task = (async () => {
            let quota: ModelQuota | null = null;
            const provider = (model.providerId || '').toLowerCase();
            const fullId = (model.fullId || '').toLowerCase();
            const isCopilot = provider.includes('github') || provider.includes('copilot') || fullId.includes('copilot');
            const isOpenAI = provider.includes('openai') || provider.includes('chatgpt') ||
                fullId.includes('openai') || fullId.includes('chatgpt');
            if (isCopilot) {
                quota = await this.fetchCopilotQuota();
            } else if (isOpenAI) {
                quota = await this.fetchOpenAIQuota();
            } else if (provider.includes('antigravity') || provider.includes('google') || fullId.includes('antigravity') || fullId.includes('gemini')) {
                quota = await this.fetchAntigravityQuota(model.fullId);
            }
            if (quota) {
                quota = { ...quota, providerId: model.providerId, modelId: model.fullId };
            }
            this.modelQuotaCache.set(key, { ts: Date.now(), quota });
            return quota;
        })();
        this.modelQuotaInFlight.set(key, task);
        try {
            return await task;
        } finally {
            this.modelQuotaInFlight.delete(key);
        }
    }

    private shouldAcceptTurnCompletionFinal(sessionId: string | undefined, info: any): boolean {
        if (!sessionId || !info) return false;
        if (!this.turnStateBySession.has(sessionId)) return false;
        if (this.isCompactionSummaryInfo(info)) {
            this.logUiDebug(`EXT: finalizing.ignore | sessionId=${sessionId} | msgId=${String(info?.id || 'null')} | reason=summary-compaction`);
            return false;
        }
        const expectedAgent = this.expectedMainAgentBySession.get(sessionId);
        const idleReceived = this.sessionIdleReceivedBySession.has(sessionId);
        if (expectedAgent && !idleReceived && typeof info.agent === 'string' && info.agent !== expectedAgent) {
            this.logUiDebug(`EXT: turn.final.skip | reason=agent-mismatch | agent=${info.agent} | expected=${expectedAgent} | sessionId=${sessionId}`);
            return false;
        }
        if (!this.isCompletionFinal(info)) return false;
        const parentId = info?.parentID;
        const msgId = info?.id;
        const acceptedMsgId = this.turnFinalMsgIdBySession.get(sessionId);
        if (acceptedMsgId && msgId && acceptedMsgId === msgId) {
            this.logUiDebug(`EXT: turn.final.skip | sessionId=${sessionId} | msgId=${msgId} | reason=duplicate-final | source=accept-check`);
            return false;
        }
        const lockedMsgId = this.finalizingMsgIdBySession.get(sessionId);
        const currentUser = this.currentTurnUserMsgIdBySession.get(sessionId);
        if (lockedMsgId && msgId && msgId !== lockedMsgId) {
            this.logUiDebug(`EXT: finalizing.ignore | sessionId=${sessionId} | msgId=${msgId} | reason=not-locked`);
            return false;
        }
        if (!lockedMsgId) {
            this.task1Metrics.parentMismatchChecks += 1;
            if (!(typeof parentId === 'string' && typeof currentUser === 'string' && parentId === currentUser)) {
                this.task1Metrics.parentMismatchCount += 1;
                this.logUiDebug(`EXT: finalizing.ignore | sessionId=${sessionId} | msgId=${msgId || 'null'} | reason=parent-mismatch`);
                return false;
            }
        }
        if (this.hasRunningToolsForMessage(msgId)) return false;
        return true;
    }

    private shouldAcceptSubagentCompletionFinal(sessionId: string | undefined, info: any): boolean {
        if (!sessionId || !info) return false;
        if (!this.subagentToParentSessionMap.has(sessionId)) return false;
        if (this.isCompactionSummaryInfo(info)) return false;
        if (!this.isCompletionFinal(info)) return false;
        const parentId = typeof info?.parentID === 'string' ? info.parentID : '';
        if (!parentId.startsWith('msg_')) return false;
        const currentUser = this.currentTurnUserMsgIdBySession.get(sessionId);
        const pendingUser = this.pendingUserMsgIdBySession.get(sessionId);
        this.task1Metrics.parentMismatchChecks += 1;
        if (currentUser && parentId !== currentUser) {
            this.task1Metrics.parentMismatchCount += 1;
            return false;
        }
        if (!currentUser && pendingUser && parentId !== pendingUser) {
            this.task1Metrics.parentMismatchCount += 1;
            return false;
        }
        const msgId = typeof info?.id === 'string' ? info.id : undefined;
        if (this.hasRunningToolsForMessage(msgId)) return false;
        return true;
    }

    private maybeBackfillTurnUserAnchor(sessionId: string | undefined, info: any): boolean {
        if (!sessionId || !info) return false;
        if (!this.turnStateBySession.has(sessionId)) return false;
        if (!this.isCompletionFinal(info)) return false;
        const parentId = info?.parentID;
        if (typeof parentId !== 'string' || !parentId.startsWith('msg_')) return false;
        const currentUser = this.currentTurnUserMsgIdBySession.get(sessionId);
        if (currentUser) {
            if (currentUser !== parentId) {
                this.logUiDebug(`EXT: turn.anchor.backfill.skip | reason=conflict | sessionId=${sessionId} | current=${currentUser} | parent=${parentId}`);
            }
            return false;
        }
        const pendingUser = this.pendingUserMsgIdBySession.get(sessionId);
        if (pendingUser && pendingUser !== parentId) {
            this.logUiDebug(`EXT: turn.anchor.backfill.skip | reason=pending-mismatch | sessionId=${sessionId} | pending=${pendingUser} | parent=${parentId}`);
            return false;
        }
        const createdAt = info?.time?.created;
        const startedAt = this.currentTurnStartedAtBySession.get(sessionId);
        if (typeof startedAt === 'number' && typeof createdAt === 'number') {
            if (createdAt < startedAt - this.finalBackfillDeltaMs) {
                this.logUiDebug(`EXT: turn.anchor.backfill.skip | reason=too-early | sessionId=${sessionId} | createdAt=${createdAt} | startedAt=${startedAt}`);
                return false;
            }
        }
        this.setCurrentTurnUserMsgId(sessionId, parentId, 'final-backfill');
        this.logUiDebug(`EXT: turn.anchor.backfill.accept | sessionId=${sessionId} | parent=${parentId}`);
        return true;
    }

    private getSessionIdFromEvent(type: string, props: any): string | undefined {
        if (type === 'message.updated') {
            const sessionId = props?.info?.sessionID;
            return typeof sessionId === 'string' ? sessionId : undefined;
        }
        if (type === 'message.part.updated') {
            const sessionId = props?.part?.sessionID;
            return typeof sessionId === 'string' ? sessionId : undefined;
        }
        if (type === 'session.status' || type === 'session.diff' || type === 'session.error') {
            const sessionId = props?.sessionID;
            return typeof sessionId === 'string' ? sessionId : undefined;
        }
        return undefined;
    }

    private classifyEventLane(sessionId: string | undefined): EventLane {
        if (!sessionId) return 'unknown';
        if (this.subagentToParentSessionMap.has(sessionId)) return 'subagent';
        if (sessionId === this.currentSessionId || this.turnStateBySession.has(sessionId)) return 'main';
        return 'unknown';
    }

    private normalizeEvent(type: string, props: any, source: EventSource): NormalizedEvent {
        const info = props?.info || {};
        const part = props?.part || {};
        const sessionId = this.getSessionIdFromEvent(type, props);
        const fromMessageUpdated = type === 'message.updated';
        const messageId = fromMessageUpdated
            ? (typeof info?.id === 'string' ? info.id : undefined)
            : (typeof part?.messageID === 'string' ? part.messageID : undefined);
        const role = fromMessageUpdated ? (typeof info?.role === 'string' ? info.role : undefined) : undefined;
        const parentId = fromMessageUpdated ? (typeof info?.parentID === 'string' ? info.parentID : undefined) : undefined;
        const finish = fromMessageUpdated ? (typeof info?.finish === 'string' ? info.finish : undefined) : undefined;
        const completedAt = fromMessageUpdated && typeof info?.time?.completed === 'number' ? info.time.completed : undefined;
        const partType = typeof part?.type === 'string' ? part.type : undefined;
        const toolState = typeof part?.state?.status === 'string'
            ? part.state.status
            : (typeof part?.status === 'string' ? part.status : undefined);
        return {
            type,
            sessionId,
            messageId,
            role,
            parentId,
            finish,
            completedAt,
            partType,
            toolState,
            source,
            ts: Date.now(),
            lane: this.classifyEventLane(sessionId)
        };
    }

    private handleServerEvent(payload: string, source: EventSource = 'sse'): void {
        let parsed: any;
        try {
            parsed = JSON.parse(payload);
        } catch {
            return;
        }
        const type = parsed?.type as string;
        const props = parsed?.properties || {};
        if (source === 'sse') {
            const sessionId = this.getSessionIdFromEvent(type, props);
            if (sessionId) {
                this.lastSseAtBySession.set(sessionId, Date.now());
                this.maybeRecoverSseFromResyncBySessionEvent(sessionId, `event:${type}`);
                this.resetRescueTimer(sessionId);
            }
        }
        if (source === 'sse' && this.shouldLogAssistantSse(type, props)) {
            OpenCodeClient.outputChannel.appendLine(`[SSE_ASSIST] ${payload}`);
        }
        const events = this.mapServerEventToChatEvents(type, props, source);
        this.emitChatEvents(events);
    }

    private formatToolStatus(part: any): string | null {
        const tool = part?.tool;
        const input = part?.state?.input || {};
        const rawPath = input.filePath || input.path || input.file || '';
        const fileName = typeof rawPath === 'string' && rawPath
            ? path.basename(rawPath)
            : '';
        if (!tool) return null;
        switch (tool) {
            case 'write':
                return fileName ? `Writing: ${fileName}` : 'Writing file...';
            case 'edit':
                return fileName ? `Editing: ${fileName}` : 'Editing file...';
            case 'read':
                return fileName ? `Reading: ${fileName}` : 'Reading file...';
            case 'apply_patch':
                return fileName ? `Applying patch: ${fileName}` : 'Applying patch...';
            case 'bash':
                return 'Running command...';
            case 'grep':
                return 'Searching...';
            case 'glob':
                return 'Finding files...';
            default:
                if (typeof tool === 'string' && tool.startsWith('lsp_')) return 'Language server...';
                if (typeof tool === 'string' && tool.startsWith('ast_grep')) return 'AST search...';
                return typeof tool === 'string' && tool ? `Running: ${tool}` : null;
        }
    }

    private shouldLogAssistantSse(type: string, props: any): boolean {
        if (type === 'message.part.updated') {
            const part = props?.part || {};
            if (part?.type === 'text' || part?.type === 'tool' || part?.type === 'diff' || part?.type === 'patch') {
                return true;
            }
            return false;
        }
        if (type === 'message.updated') {
            return props?.info?.role === 'assistant';
        }
        return false;
    }

    private extractTextPayload(value: unknown, depth = 0): string {
        if (typeof value === 'string') {
            return value;
        }
        if (!value || typeof value !== 'object' || depth > 2) {
            return '';
        }
        const node = value as Record<string, unknown>;
        const candidates: unknown[] = [
            node.text,
            node.value,
            node.delta,
            node.chunk,
            node.content,
            node.part,
            node.message,
        ];
        for (const candidate of candidates) {
            const extracted = this.extractTextPayload(candidate, depth + 1);
            if (typeof extracted === 'string' && extracted.length > 0) {
                return extracted;
            }
        }
        return '';
    }

    private mapServerEventToChatEvents(type: string, props: any, source: EventSource = 'sse'): ChatEvent[] {
        const events: ChatEvent[] = [];
        const normalized = this.normalizeEvent(type, props, source);
        const sessionId = normalized.sessionId;
        if (sessionId) {
            this.logUiDebug(`EXT: event.normalized | type=${normalized.type} | lane=${normalized.lane} | sessionId=${normalized.sessionId} | messageId=${normalized.messageId || 'null'} | parentId=${normalized.parentId || 'null'} | finish=${normalized.finish || 'null'} | partType=${normalized.partType || 'null'} | source=${normalized.source}`);
        }
        if (source === 'resync' && sessionId && (type === 'files' || type === 'diff' || type === 'toolPatch')) {
            const rootSessionId = this.subagentToParentSessionMap.get(sessionId) || sessionId;
            if (this.subagentToParentSessionMap.has(sessionId)) {
                this.logUiDebug(`EXT: resync.subagent.sideeffect.suppressed | rootSessionId=${rootSessionId} | targetSessionId=${sessionId} | reason=resync-sideeffect-protection | source=resync`);
                return [];
            }
        }
        if (type === 'session.created' || type === 'session.updated') {
            if (props?.info?.id) {
                events.push({
                    type: 'session',
                    sessionId: props.info.id,
                    mode: typeof props.info?.mode === 'string' ? props.info.mode : undefined,
                    agent: typeof props.info?.agent === 'string' ? props.info.agent : undefined,
                    modelID: typeof props.info?.modelID === 'string' ? props.info.modelID : undefined,
                    providerID: typeof props.info?.providerID === 'string' ? props.info.providerID : undefined,
                    source,
                });
            }
            return events;
        }
        if (type === 'permission.asked') {
            const permissionId = typeof props?.id === 'string' ? props.id : '';
            const sessionId = typeof props?.sessionID === 'string' ? props.sessionID : '';
            const permission = typeof props?.permission === 'string' ? props.permission : '';
            const patterns = Array.isArray(props?.patterns)
                ? props.patterns.filter((value: any) => typeof value === 'string' && value.length > 0)
                : [];
            if (sessionId && permissionId) {
                this.rememberPendingPermission(sessionId, permissionId);
                events.push({
                    type: 'permissionRequest',
                    sessionId,
                    permissionId,
                    requestId: permissionId,
                    permission,
                    patterns,
                    metadata: props?.metadata,
                    callId: typeof props?.tool?.callID === 'string' ? props.tool.callID : undefined,
                    source,
                });
            }
            return events;
        }
        if (type === 'permission.replied') {
            const sessionId = typeof props?.sessionID === 'string' ? props.sessionID : '';
            const requestId = typeof props?.requestID === 'string' ? props.requestID : '';
            const reply = typeof props?.reply === 'string' ? props.reply : '';
            if (sessionId && requestId) {
                this.clearPendingPermission(sessionId, requestId);
                events.push({
                    type: 'permissionReplied',
                    sessionId,
                    permissionId: requestId,
                    requestId,
                    response: reply === 'always' || reply === 'reject' ? reply : 'once',
                    source,
                });
            }
            return events;
        }
        if (type === 'message.updated') {
            const info = props?.info || {};
            const messageId = info?.id;
            const sessionId = info?.sessionID;
            const role = info?.role;
            let shouldEmitUserMessageEvent = true;
            if (source === 'sse' && typeof sessionId === 'string' && typeof messageId === 'string' && messageId.startsWith('msg_')) {
                this.lastObservedMsgIdBySession.set(sessionId, messageId);
                this.markSessionProgress(sessionId, 'sse-message-updated', messageId);
            }
            if (sessionId && this.canceledActiveTurnBySession.get(sessionId) === true) {
                return events;
            }
			// Extract mode/model from message.updated for subagent sessions
			if (typeof sessionId === 'string' && role === 'assistant' && this.subagentToParentSessionMap.has(sessionId)) {
				const mode = typeof info?.mode === 'string' ? info.mode : undefined;
				const agent = typeof info?.agent === 'string' ? info.agent : undefined;
				const modelID = typeof info?.modelID === 'string' ? info.modelID : undefined;
				const providerID = typeof info?.providerID === 'string' ? info.providerID : undefined;
				if (mode || agent || modelID || providerID) {
					events.push({
						type: 'session',
						sessionId,
						mode,
						agent,
						modelID,
					providerID,
					source,
					});
				}
			}
            const isCompactionSummary = role === 'assistant' && this.isCompactionSummaryInfo(info);
            if (isCompactionSummary && typeof messageId === 'string') {
                this.rememberIgnoredSummaryMessage(sessionId, messageId);
                this.logUiDebug(`EXT: message.ignore | sessionId=${sessionId || 'null'} | msgId=${messageId} | reason=summary-compaction`);
                return events;
            }
            if (sessionId && role === 'assistant' && typeof messageId === 'string') {
                this.pendingAssistantMsgIdBySession.set(sessionId, messageId);
                if (typeof info?.parentID === 'string' && info.parentID.length) {
                    this.pendingUserMsgIdBySession.set(sessionId, info.parentID);
                }
            }
            if (sessionId && role === 'user' && typeof messageId === 'string' && source === 'sse') {
                const isAutoResumeAnchor = this.awaitingAutoResumeUserAnchorBySession.has(sessionId);
                const isSyntheticUser = isAutoResumeAnchor || this.isSyntheticUserMessageInfo(info);
                if (this.turnStateBySession.has(sessionId)) {
                    this.setCurrentTurnUserMsgId(sessionId, messageId, isSyntheticUser ? 'synthetic-override' : 'sse-user-message');
                    if (!isSyntheticUser && !this.hasDisplayTurnUserMsgId(sessionId)) {
                        this.setDisplayTurnUserMsgId(sessionId, messageId, 'sse-user-message');
                    }
                }
                if (isAutoResumeAnchor) {
                    this.setCurrentTurnUserMsgId(sessionId, messageId, 'autoresume-user-anchor');
                    this.awaitingAutoResumeUserAnchorBySession.delete(sessionId);
                    this.markSessionProgress(sessionId, 'autoresume-user-anchor', messageId);
                }
                if (isSyntheticUser) {
                    this.logUiDebug(`EXT: user.ack.updated.skip | sessionId=${sessionId} | msgId=${messageId} | reason=synthetic-user`);
                    shouldEmitUserMessageEvent = false;
                }
            }
            const cwd = info?.path?.cwd;
            if (sessionId && typeof cwd === 'string' && cwd) {
                this.lastCwdBySession.set(sessionId, cwd);
            }
            if (messageId) {
                this.trackTurnMessageId(sessionId, messageId);
                if (typeof role === 'string') {
                    this.messageRoleById.set(messageId, role);
                }
            }
            if (role === 'user' && messageId && source === 'sse') {
                if (shouldEmitUserMessageEvent) {
                    events.push({ type: 'message', text: messageId, sessionId , source });
                }
            }
            if (role === 'assistant' && messageId) {
                const isSubagentLane = typeof sessionId === 'string' && this.subagentToParentSessionMap.has(sessionId);
                const lane: EventLane = isSubagentLane ? 'subagent' : (sessionId === this.currentSessionId || this.turnStateBySession.has(sessionId || '') ? 'main' : 'unknown');
                if (sessionId && typeof info?.parentID === 'string') {
                    const currentUser = this.currentTurnUserMsgIdBySession.get(sessionId);
                    if (currentUser && info.parentID === currentUser) {
                        this.setCurrentTurnAssistantMsgId(sessionId, messageId, 'assistant-parent-match');
                    }
                }
                const completedAt = info?.time?.completed;
                const isFinal = this.isCompletionFinal(info);
                if (!isFinal || this.hasRunningToolsForMessage(messageId) || info?.finish === 'tool-calls') {
                    this.emitAssistantPhase(events, {
                        sessionId,
                        messageId,
                        parentId: typeof info?.parentID === 'string' ? info.parentID : undefined,
                        source,
                        lane,
                        phase: 'assistant_progress',
                        reason: !isFinal ? 'non-final' : 'running-tools-or-tool-calls'
                    });
                }
                if (isFinal) {
                    this.emitAssistantPhase(events, {
                        sessionId,
                        messageId,
                        parentId: typeof info?.parentID === 'string' ? info.parentID : undefined,
                        source,
                        lane,
                        phase: 'assistant_final_candidate',
                        reason: 'finish-stop'
                    });
                    const messageIndex = this.registerMessage(messageId);
                    this.recordAssistantMsgId(sessionId, messageId);
                    let acceptedFinal = false;
                    if (sessionId && !isSubagentLane) {
                        this.maybeBackfillTurnUserAnchor(sessionId, info);
                        if (this.shouldAcceptTurnCompletionFinal(sessionId, info)) {
                            if (source === 'sse' && this.isDelayedMainFinalMode(sessionId)) {
                                this.armPendingMainFinalGate(sessionId, {
                                    messageId,
                                    messageIndex,
                                    parentId: typeof info?.parentID === 'string' ? info.parentID : undefined,
                                    completedAt,
                                    finish: typeof info?.finish === 'string' ? info.finish : undefined,
                                    source,
                                    createdAt: Date.now()
                                });
                                this.logUiDebug(`EXT: turn.final.defer | sessionId=${sessionId} | msgId=${messageId} | mode=${this.expectedMainAgentBySession.get(sessionId) || 'unknown'} | source=${source}`);
                            } else {
                                this.clearPendingMainFinalGate(sessionId, 'immediate-accept');
                                this.logUiDebug(`EXT: turn.final.accept | sessionId=${sessionId} | msgId=${messageId} | finish=${String(info?.finish || '')} | source=${source}`);
                                this.markTurnFinal(sessionId, messageId, source);
                                acceptedFinal = true;
                            }
                        } else {
                            this.logUiDebug(`EXT: turn.final.skip | sessionId=${sessionId} | msgId=${messageId} | finish=${String(info?.finish || '')} | source=${source}`);
                        }
                    } else if (sessionId && isSubagentLane) {
                        const acceptSubFinal = this.shouldAcceptSubagentCompletionFinal(sessionId, info);
                        if (acceptSubFinal) {
                            acceptedFinal = true;
                            this.logUiDebug(`EXT: subagent.final.accept | sessionId=${sessionId} | msgId=${messageId} | finish=${String(info?.finish || '')} | source=${source}`);
                        } else {
                            this.logUiDebug(`EXT: subagent.final.skip | sessionId=${sessionId} | msgId=${messageId} | finish=${String(info?.finish || '')} | source=${source}`);
                        }
                    }
                    const shouldEmit = source === 'sse' && acceptedFinal && this.shouldEmitFinalMeta(sessionId, messageId, completedAt, info?.finish, source);
                    const phase = isSubagentLane ? 'subagent-final-accepted' : 'turn-final-accepted';
                    if (shouldEmit && this.consumePhaseOnce(sessionId, messageId, phase)) {
                        this.emitAssistantPhase(events, {
                            sessionId,
                            messageId,
                            parentId: typeof info?.parentID === 'string' ? info.parentID : undefined,
                            source,
                            lane,
                            phase: 'assistant_final_accepted',
                            reason: isSubagentLane ? 'subagent-final-accepted' : 'turn-final-accepted'
                        });
                        events.push({
                            type: 'assistantMessageMeta',
                            sessionId,
                            assistantMsgId: messageId,
                            messageId,
                            messageIndex,
                            tmpKey: this.getPendingAssistantTmpKey(sessionId),
                            source,
                        });
                    }
                }
            }
            return events;
        }
        if (type === 'message.part.updated') {
            const part = props?.part || {};
            const sessionId = part?.sessionID;
            if (sessionId && this.canceledActiveTurnBySession.get(sessionId) === true) {
                return events;
            }
            const messageId = typeof part?.messageID === 'string' ? part.messageID : '';
            if (source === 'sse' && typeof sessionId === 'string' && messageId.startsWith('msg_')) {
                this.lastObservedMsgIdBySession.set(sessionId, messageId);
            }
            if (this.isIgnoredSummaryMessage(sessionId, messageId)) {
                return events;
            }
            const questionOverlay = this.extractQuestionOverlayPart(part);
            if (questionOverlay && sessionId) {
                const key = `${sessionId}|${questionOverlay.callId}|running`;
                if (!this.questionOverlaySeen.has(key)) {
                    this.rememberPendingQuestion(sessionId, questionOverlay);
                    this.questionOverlaySeen.add(key);
                    if (this.questionOverlaySeen.size > 2000) {
                        this.questionOverlaySeen.clear();
                        this.questionOverlaySeen.add(key);
                    }
                    events.push({
                        type: 'questionOverlay',
                        sessionId,
                        callId: questionOverlay.callId,
                        requestId: questionOverlay.requestId,
                        title: questionOverlay.title,
                        prompt: questionOverlay.prompt,
                        options: questionOverlay.options,
                        questions: questionOverlay.questions,
                        source,
                    });
                }
            }
            if (part?.type === 'text') {
                const msgId = typeof part?.messageID === 'string' ? part.messageID : '';
                const knownLenBefore = msgId ? (this.assistantTextLengths.get(msgId) || 0) : 0;
                const roleForMsg = msgId ? this.messageRoleById.get(msgId) : undefined;
                const partTextForGate = this.extractTextPayload(part?.text);
                if (source === 'sse' && sessionId && this.pendingMainFinalGateBySession.has(sessionId) && this.isOmoContinuationText(partTextForGate)) {
                    this.clearPendingMainFinalGate(sessionId, 'boulder-continuation');
                    this.logUiDebug(`EXT: turn.final.pending.cancel | sessionId=${sessionId} | reason=boulder-continuation`);
                } else if (source === 'sse' && sessionId && this.isOmoContinuationText(partTextForGate) && this.shouldStopLateBoulderContinuation(sessionId)) {
                    void this.sendStopContinuationPrompt(sessionId);
                    return events;
                }
                if (source === 'sse' && sessionId && msgId && roleForMsg === 'user') {
                    const partText = typeof part?.text === 'string' ? part.text : '';
                    if (
                        this.isAutoResumePromptText(partText) ||
                        this.isStopContinuationPromptText(partText) ||
                        this.isOmoContinuationText(partText)
                    ) {
                        this.setCurrentTurnUserMsgId(sessionId, msgId, 'autoresume-user');
                        this.markSessionProgress(sessionId, 'autoresume-user-seen', msgId);
                        this.logUiDebug(`EXT: user.ack.part.skip | sessionId=${sessionId} | msgId=${msgId} | reason=control-hidden`);
                    } else {
                        this.setCurrentTurnUserMsgId(sessionId, msgId, 'user-ack');
                        if (!this.hasDisplayTurnUserMsgId(sessionId)) {
                            this.setDisplayTurnUserMsgId(sessionId, msgId, 'user-part-ack');
                        }
                        this.markSessionProgress(sessionId, 'user-part-ack', msgId);
                        events.push({ type: 'message', text: msgId, sessionId , source });
                        this.logUiDebug(`EXT: user.ack.part.accept | sessionId=${sessionId} | msgId=${msgId} | reason=role-user`);
                    }
                    return events;
                }
                if (sessionId && msgId) {
                    const assistantId = this.pendingAssistantMsgIdBySession.get(sessionId);
                    if (!assistantId || assistantId !== msgId) {
                        this.pendingUserMsgIdBySession.set(sessionId, msgId);
                    }
                }
                if (msgId) {
                    const role = roleForMsg;
                    if (role && role !== 'assistant') {
                        this.logUiDebug(`EXT: user.ack.part.skip | sessionId=${sessionId || 'null'} | msgId=${msgId} | reason=non-assistant-role:${role}`);
                        return events;
                    }
                }
                if (source === 'sse' && sessionId && msgId) {
                    const finalMsgId = this.getFinalizingMsgId(sessionId);
                    if (finalMsgId && finalMsgId === msgId && typeof part?.text === 'string' && part.text.length >= knownLenBefore) {
                        this.maybeRecoverSseFromResync(sessionId, msgId, 'text-len-gte');
                    }
                }
                let chunk = '';
                const deltaText = this.extractTextPayload(part?.delta);
                if (deltaText.length > 0) {
                    chunk = deltaText;
                    if (msgId) {
                        this.assistantHasDelta.add(msgId);
                    }
                } else {
                    const partText = this.extractTextPayload(part?.text);
                    // Even if we've seen deltas, if there's new full text beyond what we've shown, emit it
                    const nextLen = partText.length;
                    const prevLen = msgId ? (this.assistantTextLengths.get(msgId) || 0) : 0;
                    
                    if (nextLen > prevLen) {
                        chunk = partText.slice(prevLen);
                        if (msgId) {
                            this.assistantTextLengths.set(msgId, nextLen);
                        }
                    } else {
                        chunk = '';
                    }
                }
                if (!chunk) return events;
                if (msgId) {
                    this.appendAssistantText(msgId, chunk);
                }
                if (source === 'sse' && sessionId) {
                    this.markSessionProgress(sessionId, 'sse-text-chunk', msgId || undefined);
                }
                if (source === 'sse' && sessionId && msgId) {
                    this.maybeRecoverSseFromResync(sessionId, msgId, 'text-growth');
                }
                if (source === 'sse' && sessionId && msgId) {
                    const finalMsgId = this.getFinalizingMsgId(sessionId);
                    if (finalMsgId && finalMsgId === msgId) {
                        this.turnSseTextAtBySession.set(sessionId, Date.now());
                        this.scheduleSseDrainConfirm(sessionId);
                    }
                }
                if (msgId && !this.assistantStatusCleared.has(msgId)) {
                    if (msgId === this.getFinalizingMsgId(sessionId)) {
                        events.push({
                            type: 'assistantMessageMeta',
                            sessionId,
                            assistantMsgId: part?.messageID,
                            lastText: 'Finalizing the response...',
                            tmpKey: this.getPendingAssistantTmpKey(sessionId),
                            isStatusUpdate: true,
                            source,
                        });
                    }
                    this.assistantStatusCleared.add(msgId);
                }
                events.push({ type: 'text', text: chunk, sessionId, assistantMsgId: part?.messageID, tmpKey: this.getPendingAssistantTmpKey(sessionId) , source });
            }
            if (part?.type === 'tool') {
                const messageId = typeof part?.messageID === 'string' ? part.messageID : undefined;
                if (source === 'sse' && sessionId) {
                    this.markSessionProgress(sessionId, 'sse-tool-part', messageId);
                }
                const toolCallId = this.extractToolCallId(part);
                const toolStatus = part?.state?.status;
                const toolState = this.updateToolStatus(sessionId, toolCallId, toolStatus);
                if (sessionId && toolCallId && (toolStatus === 'completed' || toolStatus === 'failed' || toolStatus === 'cancelled' || toolStatus === 'canceled')) {
                    this.clearPendingQuestion(sessionId, toolCallId);
                }
                if (messageId && toolStatus) {
                    const current = this.toolRunningByMessageId.get(messageId) || 0;
                    if (toolStatus === 'running') {
                        this.toolRunningByMessageId.set(messageId, current + 1);
                    } else if (toolStatus === 'completed' || toolStatus === 'failed' || toolStatus === 'cancelled' || toolStatus === 'canceled') {
                        const next = Math.max(0, current - 1);
                        if (next === 0) {
                            this.toolRunningByMessageId.delete(messageId);
                        } else {
                            this.toolRunningByMessageId.set(messageId, next);
                        }
                    }
                }
                const statusText = this.formatToolStatus(part);
                if (statusText && source !== 'resync') {
                    const resolvedId = this.getTurnAssistantMsgId(sessionId);
                    const assistantMsgId = resolvedId || part?.messageID;
                    events.push({ type: 'assistantMessageMeta', sessionId, assistantMsgId, lastText: statusText, tmpKey: this.getPendingAssistantTmpKey(sessionId), isStatusUpdate: true , source });
                }
                if (typeof sessionId === 'string' && this.subagentToParentSessionMap.has(sessionId)) {
                    const status = part?.state?.status;
                    if ((status === 'running' || status === 'pending') && source !== 'resync') {
                        events.push({
                            type: 'tool',
                            sessionId,
                            tool: statusText || (typeof part?.tool === 'string' ? part.tool : ''),
                            toolState: {
                                status,
                                input: part?.state?.input,
                                output: part?.state?.output,
                            },
                            source,
                        });
                    }
                }
                const toolName = typeof part?.tool === 'string' ? part.tool : '';
                if (part?.state?.status === 'completed' && sessionId) {
                    if (['apply_patch', 'edit', 'write'].includes(toolName)) {
                        this.markTurnHasWrites(sessionId, `tool:${toolName}`);
                    } else if (toolName === 'bash' && source !== 'resync') {
                        const command = part?.state?.input?.command;
                        if (!this.isBashCommandReadOnly(command)) {
                            this.markTurnHasWrites(sessionId, 'tool:bash');
                        }
                    }
                }
                // Detect todowrite tool completion and emit todoUpdate event
                if (toolName === 'todowrite' && part?.state?.status === 'completed') {
                    const todos = part?.state?.metadata?.todos;
                    if (Array.isArray(todos) && todos.length > 0 && sessionId) {
                        const msgId = this.getTurnAssistantMsgId(sessionId) || part?.messageID || '';
                        events.push({ type: 'todoUpdate', todos, sessionId, assistantMsgId: msgId , source });
                    }
                }
                if (source === 'sse' && sessionId && toolState.becameTerminal && !this.hasPendingOrRunningTools(sessionId) && !this.turnFinalResolvedBySession.has(sessionId)) {
                    void this.runResyncSettleCheck(sessionId, 'tool-terminal');
                }
                if (part?.state?.status === 'completed') {
                    const files = this.extractFilesFromToolPart(part);
                    if (files.length) {
                        const changeSpecs = this.buildChangeSpecs(files);
                        if (this.shouldQueueTurnChanges(sessionId, source, part?.messageID)) {
                            const turnState = this.turnStateBySession.get(sessionId);
                            const turnKey = turnState?.pendingUserLocalKey || sessionId;
                            const tmpKey = turnState?.pendingAssistantTmpKey;
                            const assistantId = turnState?.assistantMsgId || turnState?.lastResolvedAssistantMsgId;
                            this.queueTurnChanges(sessionId, turnKey, tmpKey, assistantId, changeSpecs);
                        }
                        this.mirrorChangesToParentSession(sessionId, changeSpecs, source);
                        events.push({ type: 'files', files, sessionId , source });
                    } else if (part?.tool === 'bash' && sessionId) {
                        const command = part?.state?.input?.command;
                        const cwd = this.lastCwdBySession.get(sessionId);
                        const deletePaths = this.extractDeletedPathsFromCommand(command, cwd);
                        if (deletePaths.length) {
                            if (this.shouldQueueTurnChanges(sessionId, source, part?.messageID)) {
                                const turnState = this.turnStateBySession.get(sessionId);
                                const turnKey = turnState?.pendingUserLocalKey || sessionId;
                                const tmpKey = turnState?.pendingAssistantTmpKey;
                                const assistantId = turnState?.assistantMsgId || turnState?.lastResolvedAssistantMsgId;
                                const changeSpecs = deletePaths.map((filePath: string) => ({ type: 'delete', path: filePath } as FileChangeSpec));
                                this.queueTurnChanges(sessionId, turnKey, tmpKey, assistantId, changeSpecs);
                            }
                        }
                    }
            }
        }
        if (part?.type === 'tool' && part?.tool === 'apply_patch') {
            const patchText = part?.state?.input?.patchText || part?.state?.input?.patch;
            const relatedIds = this.getRelatedSessionIds(sessionId);
            const allowDiff = Boolean(sessionId && (this.hasGroupedActiveTurnWrites(sessionId) || this.hasGroupedPendingTurnChanges(sessionId)));
            this.logUiDebug(`[DIFF_GATE] apply_patch allowDiff check | sessionId=${sessionId} relatedCount=${relatedIds.length} relatedIds=[${relatedIds.join(',')}] allowDiff=${allowDiff}`);
            if (patchText && allowDiff) {
                events.push({ type: 'toolPatch', text: patchText, sessionId , source });
            }
        }
        if ((part?.type === 'diff' || part?.type === 'patch') && typeof part?.text === 'string') {
            const diffMessageId = typeof part?.messageID === 'string' ? part.messageID : undefined;
            if (source === 'sse' && sessionId) {
                this.markSessionProgress(sessionId, 'sse-diff-part', diffMessageId);
            }
            const relatedIds = this.getRelatedSessionIds(sessionId);
            const inGrace = Boolean(sessionId && this.isInLateDiffGrace(sessionId));
            const allowDiff = Boolean(sessionId && (this.hasGroupedActiveTurnWrites(sessionId) || this.hasGroupedPendingTurnChanges(sessionId) || inGrace));
            this.logUiDebug(`[DIFF_GATE] diff/patch allowDiff check | sessionId=${sessionId} relatedCount=${relatedIds.length} relatedIds=[${relatedIds.join(',')}] allowDiff=${allowDiff} inGrace=${inGrace}`);
            if (inGrace && sessionId) {
                this.logUiDebug(`[LATE_DIFF] event in grace window | sessionId=${sessionId} eventType=${part?.type}`);
            }
            if (allowDiff) {
                events.push({ type: 'diff', text: part.text, sessionId , source });
            }
        }
        return events;
    }

    if (type === 'session.diff' && Array.isArray(props?.diff)) {
        if (props?.sessionID && this.canceledActiveTurnBySession.get(props.sessionID) === true) {
            return events;
        }
        const sessionId = props?.sessionID as string | undefined;
        if (!sessionId) return events;
        const relatedIds = this.getRelatedSessionIds(sessionId);
        const hasWrites = this.hasGroupedActiveTurnWrites(sessionId);
        const hasPending = this.hasGroupedPendingTurnChanges(sessionId);
        const inGrace = this.isInLateDiffGrace(sessionId);
        this.logUiDebug(`[DIFF_GATE] session.diff gate check | sessionId=${sessionId} relatedCount=${relatedIds.length} relatedIds=[${relatedIds.join(',')}] hasWrites=${hasWrites} hasPending=${hasPending} inGrace=${inGrace}`);
        if (!hasWrites && !hasPending && !inGrace) {
            this.logUiDebug(`EXT: session.diff.skip | sessionId=${sessionId} | reason=no-turn-writes`);
            return events;
        }
        if (inGrace) {
            this.logUiDebug(`[LATE_DIFF] event in grace window | sessionId=${sessionId} eventType=session.diff`);
        }
        const files = props.diff.map((entry: any) => ({
            filePath: entry.file,
            before: entry.before,
                after: entry.after,
                additions: entry.additions,
                deletions: entry.deletions
            })) as FileSnapshot[];
            if (files.length) {
                const changeSpecs = this.buildChangeSpecs(files);
                if (this.gitUndoAvailable && this.isSessionUndoEnabled(props?.sessionID) && props?.sessionID) {
                    const turnState = this.turnStateBySession.get(sessionId);
                    const turnKey = turnState?.pendingUserLocalKey || sessionId;
                    const tmpKey = turnState?.pendingAssistantTmpKey;
                    const assistantId = turnState?.assistantMsgId || turnState?.lastResolvedAssistantMsgId;
                    this.queueTurnChanges(sessionId, turnKey, tmpKey, assistantId, changeSpecs);
                }
                this.mirrorChangesToParentSession(sessionId, changeSpecs, source);
                events.push({ type: 'files', files, sessionId: props?.sessionID , source });
            }
            return events;
        }
        if (type === 'session.status' && props?.sessionID && props?.status?.type === 'idle') {
            const sessionId = props.sessionID;
            this.sessionIdleReceivedBySession.add(sessionId);
            this.logUiDebug(`EXT: session.idle.received | sessionId=${sessionId}`);
            if (this.canceledActiveTurnBySession.get(sessionId) === true) {
                return events;
            }
            if (this.turnStateBySession.has(sessionId)) {
                this.markTurnFinal(sessionId, undefined, 'session-idle');
            }
            return events;
        }
        if (type === 'session.error') {
            const errorName = props?.error?.name || props?.error?.data?.name;
            const message = props?.error?.data?.message || props?.error?.message;
            if (errorName === 'MessageAbortedError') {
                return events;
            }
            if (message) {
                events.push({ type: 'error', text: message, sessionId: props?.sessionID , source });
            }
            return events;
        }
        return events;
    }

    private getPendingAssistantTmpKey(sessionId: string | undefined): string | undefined {
        if (!sessionId) return undefined;
        return this.turnStateBySession.get(sessionId)?.pendingAssistantTmpKey;
    }

    private scheduleSessionResync(sessionId: string): void {
        this.scheduleSessionResyncLimited(sessionId, 'idle');
    }

    private extractToolCallId(part: any): string | null {
        const callId = part?.callID || part?.callId || part?.call_id || part?.call?.id || part?.call?.callID || part?.id;
        if (typeof callId === 'string' && callId.trim().length) return callId.trim();
        return null;
    }

    private extractToolRequestId(part: any): string | undefined {
        const raw =
            part?.requestID
            ?? part?.requestId
            ?? part?.controlID
            ?? part?.controlId
            ?? part?.state?.input?.requestID
            ?? part?.state?.input?.requestId
            ?? part?.state?.input?.controlID
            ?? part?.state?.input?.controlId
            ?? part?.metadata?.requestID
            ?? part?.metadata?.requestId
            ?? part?.metadata?.openai?.itemId;
        if (typeof raw !== 'string') return undefined;
        const trimmed = raw.trim();
        return trimmed || undefined;
    }

    private normalizeQuestionText(value: any): string | null {
        if (typeof value !== 'string') return null;
        const trimmed = value.trim();
        return trimmed.length ? trimmed : null;
    }

    private normalizeQuestionOptions(rawOptions: any): QuestionOverlayOption[] {
        if (!Array.isArray(rawOptions)) return [];
        const options: QuestionOverlayOption[] = [];
        for (const option of rawOptions) {
            if (!option || typeof option !== 'object') continue;
            const rawId = option.id ?? option.value ?? option.key ?? option.label ?? option.text;
            const rawLabel = option.label ?? option.text ?? option.title ?? option.value ?? option.id;
            const id = this.normalizeQuestionText(rawId);
            const label = this.normalizeQuestionText(rawLabel);
            if (!id || !label) continue;
            options.push({ id, label });
        }
        return options;
    }

    private extractQuestionOverlayPart(part: any): QuestionOverlayPayload | null {
        const toolName = typeof part?.toolName === 'string'
            ? part.toolName
            : (typeof part?.tool === 'string'
                ? part.tool
                : (typeof part?.name === 'string' ? part.name : ''));
        if (toolName !== 'question') return null;

        const status = part?.status ?? part?.state?.status ?? part?.state;
        if (status !== 'running') return null;

        const callId = this.extractToolCallId(part);
        if (!callId) return null;

        const input = part?.state?.input ?? part?.input ?? {};
        const candidates = Array.isArray(input?.questions)
            ? input.questions
            : (input?.question ? [input.question] : (Array.isArray(part?.questions) ? part.questions : (part?.question ? [part.question] : [])));

        const normalizedQuestions: Array<{ title: string; prompt: string; options: QuestionOverlayOption[]; multiple?: boolean }> = [];
        for (const question of candidates) {
            const title = this.normalizeQuestionText(
                question?.title
                ?? question?.header
                ?? question?.name
                ?? question?.label
            );
            const prompt = this.normalizeQuestionText(
                question?.prompt
                ?? question?.question
                ?? question?.text
                ?? question?.description
            );
            const rawOptions = question?.options ?? question?.choices;
            const options = this.normalizeQuestionOptions(rawOptions);
            if (!title || !prompt || !options.length) continue;
            const multiple = question?.multiple === true;
            normalizedQuestions.push({ title, prompt, options, multiple });
        }

        if (!normalizedQuestions.length) {
            const fallbackTitle = this.normalizeQuestionText(part?.header ?? part?.title);
            const fallbackPrompt = this.normalizeQuestionText(part?.questionText ?? part?.prompt ?? part?.text);
            const fallbackOptions = this.normalizeQuestionOptions(input?.options ?? input?.choices ?? part?.options ?? part?.choices);
            if (!fallbackTitle || !fallbackPrompt || !fallbackOptions.length) return null;
            normalizedQuestions.push({ title: fallbackTitle, prompt: fallbackPrompt, options: fallbackOptions, multiple: false });
        }

        const first = normalizedQuestions[0];
        const title = first.title;
        const prompt = first.prompt;
        const options = first.options;

        const requestId = this.extractToolRequestId(part);
        return { callId, requestId, title, prompt, options, questions: normalizedQuestions };
    }

    private rememberPendingQuestion(sessionId: string, payload: QuestionOverlayPayload): void {
        const bucket = this.pendingQuestionsBySession.get(sessionId) || new Map<string, PendingQuestionControl>();
        bucket.set(payload.callId, {
            callId: payload.callId,
            requestId: payload.requestId,
            title: payload.title,
            prompt: payload.prompt,
            options: payload.options,
            questions: Array.isArray(payload.questions) && payload.questions.length
                ? payload.questions
                : [{ title: payload.title, prompt: payload.prompt, options: payload.options, multiple: false }]
        });
        if (bucket.size > 200) {
            const firstKey = bucket.keys().next().value;
            if (firstKey) bucket.delete(firstKey);
        }
        this.pendingQuestionsBySession.set(sessionId, bucket);
        const pendingIds = this.pendingQuestionCallIdsBySession.get(sessionId) || new Set<string>();
        pendingIds.add(payload.callId);
        this.pendingQuestionCallIdsBySession.set(sessionId, pendingIds);
        if (this.isNonFinalResyncTakeover(sessionId)) {
            this.logUiDebug(`EXT: resync.loop.pause | sessionId=${sessionId} | reason=interactive-question`);
            this.stopNonFinalResyncLoop(sessionId, 'interactive-question');
        }
        if (this.turnFinalAtBySession.has(sessionId) && !this.turnFinalResolvedBySession.has(sessionId)) {
            this.logUiDebug(`EXT: rescue.pause | sessionId=${sessionId} | reason=interactive-question`);
            this.stopRescueWatchdog(sessionId, 'interactive-question');
        }
    }

    private getPendingQuestion(sessionId: string, callId: string): PendingQuestionControl | undefined {
        return this.pendingQuestionsBySession.get(sessionId)?.get(callId);
    }

    private clearPendingQuestion(sessionId: string, callId: string): void {
        const hadBlocker = this.hasInteractiveBlocker(sessionId);
        let removed = false;
        const bucket = this.pendingQuestionsBySession.get(sessionId);
        if (bucket) {
            removed = bucket.delete(callId) || removed;
            if (!bucket.size) {
                this.pendingQuestionsBySession.delete(sessionId);
            }
        }
        const pendingIds = this.pendingQuestionCallIdsBySession.get(sessionId);
        if (pendingIds) {
            removed = pendingIds.delete(callId) || removed;
            if (!pendingIds.size) {
                this.pendingQuestionCallIdsBySession.delete(sessionId);
            }
        }
        if (removed && hadBlocker && !this.hasInteractiveBlocker(sessionId)) {
            this.resumeRescueIfInteractiveCleared(sessionId, 'question-cleared');
        }
    }

    private rememberPendingPermission(sessionId: string, permissionId: string): void {
        if (!sessionId || !permissionId) return;
        const pending = this.pendingPermissionIdsBySession.get(sessionId) || new Set<string>();
        pending.add(permissionId);
        this.pendingPermissionIdsBySession.set(sessionId, pending);
        if (this.isNonFinalResyncTakeover(sessionId)) {
            this.logUiDebug(`EXT: resync.loop.pause | sessionId=${sessionId} | reason=interactive-permission`);
            this.stopNonFinalResyncLoop(sessionId, 'interactive-permission');
        }
        if (this.turnFinalAtBySession.has(sessionId) && !this.turnFinalResolvedBySession.has(sessionId)) {
            this.logUiDebug(`EXT: rescue.pause | sessionId=${sessionId} | reason=interactive-permission`);
            this.stopRescueWatchdog(sessionId, 'interactive-permission');
        }
    }

    private clearPendingPermission(sessionId: string, permissionId: string): void {
        if (!sessionId || !permissionId) return;
        const hadBlocker = this.hasInteractiveBlocker(sessionId);
        const pending = this.pendingPermissionIdsBySession.get(sessionId);
        if (!pending) return;
        const removed = pending.delete(permissionId);
        if (!pending.size) {
            this.pendingPermissionIdsBySession.delete(sessionId);
        }
        if (removed && hadBlocker && !this.hasInteractiveBlocker(sessionId)) {
            this.resumeRescueIfInteractiveCleared(sessionId, 'permission-cleared');
        }
    }

    private hasInteractiveBlocker(sessionId: string): boolean {
        if (!sessionId) return false;
        const questionCount = this.pendingQuestionCallIdsBySession.get(sessionId)?.size || 0;
        const permissionCount = this.pendingPermissionIdsBySession.get(sessionId)?.size || 0;
        return questionCount > 0 || permissionCount > 0;
    }

    private resumeRescueIfInteractiveCleared(sessionId: string, reason: string): void {
        if (!sessionId) return;
        if (this.hasInteractiveBlocker(sessionId)) return;
        if (this.isNonFinalResyncTakeover(sessionId)) {
            this.logUiDebug(`EXT: resync.loop.resume | sessionId=${sessionId} | reason=${reason}`);
            this.armNonFinalResyncLoop(sessionId, `resume:${reason}`);
        }
        if (this.turnFinalResolvedBySession.has(sessionId)) return;
        if (!this.turnFinalAtBySession.has(sessionId)) return;
        const now = Date.now();
        const last = this.rescueResumeAtBySession.get(sessionId) || 0;
        if (now - last < 500) return;
        this.rescueResumeAtBySession.set(sessionId, now);
        this.logUiDebug(`EXT: rescue.resume | sessionId=${sessionId} | reason=${reason}`);
        this.startRescueTimer(sessionId);
    }

    private isAutoResumePromptText(text: unknown): boolean {
        if (typeof text !== 'string') return false;
        return text.trimStart().startsWith('[OC_UI_AUTORESUME');
    }

    private buildProgressKey(sessionId: string, newestObservedMsgId?: string): string {
        const observed = newestObservedMsgId || this.lastObservedMsgIdBySession.get(sessionId) || '';
        const finalMsgId = this.getFinalizingMsgId(sessionId) || this.currentTurnAssistantMsgIdBySession.get(sessionId) || '';
        const finalLen = finalMsgId ? (this.assistantTextLengths.get(finalMsgId) || 0) : 0;
        return `${observed}|${finalMsgId}|${finalLen}`;
    }

    private markSessionProgress(sessionId: string | undefined, reason: string, newestObservedMsgId?: string): void {
        if (!sessionId) return;
        const now = Date.now();
        const key = this.buildProgressKey(sessionId, newestObservedMsgId);
        const prev = this.lastProgressKeyBySession.get(sessionId);
        if (prev && prev === key) return;
        const hadWarn = this.stallWarnedBySession.has(sessionId);
        this.lastProgressKeyBySession.set(sessionId, key);
        this.lastProgressAtBySession.set(sessionId, now);
        this.noProgressEpochsBySession.set(sessionId, 0);
        this.noProgressSinceBySession.delete(sessionId);
        this.stallWarnedBySession.delete(sessionId);
        if (hadWarn) {
            this.emitChatEvents([{ type: 'autoResumeStallClear', sessionId }]);
        }
        this.logUiDebug(`EXT: progress.mark | sessionId=${sessionId} | reason=${reason} | key=${key}`);
    }

    private pauseResyncStallTracking(sessionId: string, reason: string, progressKey?: string): void {
        if (!sessionId) return;
        const now = Date.now();
        const hadWarn = this.stallWarnedBySession.has(sessionId);
        if (progressKey) {
            this.lastProgressKeyBySession.set(sessionId, progressKey);
        }
        this.lastProgressAtBySession.set(sessionId, now);
        this.noProgressEpochsBySession.set(sessionId, 0);
        this.noProgressSinceBySession.delete(sessionId);
        this.stallWarnedBySession.delete(sessionId);
        if (hadWarn) {
            this.emitChatEvents([{ type: 'autoResumeStallClear', sessionId }]);
        }
        this.logUiDebug(`EXT: stall.pause | sessionId=${sessionId} | reason=${reason}`);
    }

    private async sendAutoResumePrompt(sessionId: string): Promise<boolean> {
        if (!sessionId) return false;
        try {
            const agentMode = this.expectedMainAgentBySession.get(sessionId) || 'plan';
            const payload: any = {
                parts: [{ type: 'text', text: this.autoResumePrompt }],
                agent: agentMode
            };
            await this.requestJson('POST', `/session/${sessionId}/prompt_async`, payload);
            this.awaitingAutoResumeUserAnchorBySession.add(sessionId);
            this.logUiDebug(`EXT: autoresume.sent | sessionId=${sessionId} | agent=${agentMode}`);
            return true;
        } catch (error) {
            this.logUiDebug(`EXT: autoresume.result | sessionId=${sessionId} | success=false | err=${String(error)}`);
            return false;
        }
    }

    private async updateResyncStallState(
        sessionId: string,
        summary: { replayedFinal: number; replayedTools: number; newestObservedMsgId?: string },
        reason: string
    ): Promise<void> {
        if (!sessionId) return;
        if (!this.turnStateBySession.has(sessionId)) return;
        if ((this.turnRecoveryModeBySession.get(sessionId) || 'sse') !== 'resync') return;
        if (this.turnFinalResolvedBySession.has(sessionId)) return;

        const newestObserved = summary.newestObservedMsgId || this.lastObservedMsgIdBySession.get(sessionId) || '';
        const progressKey = this.buildProgressKey(sessionId, newestObserved);
        const prevKey = this.lastProgressKeyBySession.get(sessionId);
        const progressedByReplay = summary.replayedFinal > 0 || summary.replayedTools > 0;
        const progressedByKey = !!prevKey && prevKey !== progressKey;
        if (progressedByReplay || progressedByKey) {
            this.markSessionProgress(sessionId, `resync:${reason}`, newestObserved);
            return;
        }

        const hasRunningTools = this.hasPendingOrRunningTools(sessionId);
        const hasBlocker = this.hasInteractiveBlocker(sessionId);
        if (hasRunningTools || hasBlocker) {
            const pauseReason = hasBlocker
                ? (hasRunningTools ? 'interactive-blocker+tool-running' : 'interactive-blocker')
                : 'tool-running';
            this.pauseResyncStallTracking(sessionId, pauseReason, progressKey);
            return;
        }

        const now = Date.now();
        if (!this.noProgressSinceBySession.has(sessionId)) {
            this.noProgressSinceBySession.set(sessionId, now);
        }
        const epochs = (this.noProgressEpochsBySession.get(sessionId) || 0) + 1;
        this.noProgressEpochsBySession.set(sessionId, epochs);
        if (!this.lastProgressAtBySession.has(sessionId)) {
            this.lastProgressAtBySession.set(sessionId, now);
        }
        if (!this.lastProgressKeyBySession.has(sessionId)) {
            this.lastProgressKeyBySession.set(sessionId, progressKey);
        }

        const lastProgressAt = this.lastProgressAtBySession.get(sessionId) || now;
        const stallMs = now - lastProgressAt;

        if (stallMs >= this.autoResumeWarnMs && !this.stallWarnedBySession.has(sessionId)) {
            this.stallWarnedBySession.add(sessionId);
            this.emitChatEvents([
                {
                    type: 'autoResumeStallWarn',
                    sessionId,
                    text: 'This session may be stuck. Please reload the extension and continue.'
                }
            ]);
            this.logUiDebug(`EXT: stall.warn | sessionId=${sessionId} | stallMs=${stallMs}`);
        }

        if (epochs < this.autoResumeEpochThreshold || stallMs < this.autoResumeStallMs) {
            return;
        }

        const autoresumeCount = this.autoResumeCountBySession.get(sessionId) || 0;
        if (autoresumeCount >= 1) {
            if (autoresumeCount >= 2) return;
            this.autoResumeCountBySession.set(sessionId, 2);
            this.emitChatEvents([
                {
                    type: 'autoResumeHardStop',
                    sessionId,
                    title: 'Session may be stuck',
                    text: 'This session appears to be unresponsive. Please reload the extension and continue.',
                    actionLabel: 'Reload Window',
                    secondaryActionLabel: 'Keep waiting'
                }
            ]);
            this.logUiDebug(`EXT: autoresume.hardstop | sessionId=${sessionId} | action=cancel+reload-card | epochs=${epochs} | stallMs=${stallMs}`);
            return;
        }

        this.logUiDebug(`EXT: autoresume.trigger | sessionId=${sessionId} | reason=no-progress | epochs=${epochs} | stallMs=${stallMs}`);
        const sent = await this.sendAutoResumePrompt(sessionId);
        if (sent) {
            this.autoResumeCountBySession.set(sessionId, 1);
            this.logUiDebug(`EXT: autoresume.result | sessionId=${sessionId} | success=true`);
        }
    }

    private scheduleSessionResyncLimited(sessionId: string, reason: string): void {
        if (reason === 'idle') {
            const turnSettled = this.turnFinalResolvedBySession.has(sessionId);
            const cleanState = !this.hasPendingOrRunningTools(sessionId)
                && !this.hasInteractiveBlocker(sessionId)
                && !this.hasPendingTurnChanges(sessionId)
                && !this.hasActiveTurnWrites(sessionId);
            if (turnSettled && cleanState) {
                this.logUiDebug(`EXT: resyncLimited.skip | reason=idle-post-settle-clean | sessionId=${sessionId}`);
                return;
            }
        }
        const now = Date.now();
        const cooldownUntil = this.resyncCooldownUntilBySession.get(sessionId) || 0;
        if (now < cooldownUntil) {
            this.logUiDebug(`EXT: resyncLimited.skip | reason=cooldown | sessionId=${sessionId}`);
            return;
        }
        if (this.resyncInFlightBySession.has(sessionId)) {
            this.logUiDebug(`EXT: resyncLimited.skip | reason=inflight | sessionId=${sessionId}`);
            return;
        }

        const startedAt = Date.now();
        const resyncEpoch = this.turnStateBySession.has(sessionId)
            ? this.beginResyncRecovery(sessionId, `limited:${reason}`)
            : undefined;
        this.task1Metrics.resyncRecoveryAttempts += 1;
        this.logUiDebug(`EXT: resyncLimited.start | sessionId=${sessionId} | reason=${reason}${typeof resyncEpoch === 'number' ? ` | epoch=${resyncEpoch}` : ''}`);
        const task = this.resyncLimited(sessionId, resyncEpoch)
            .then(async (summary) => {
                const elapsedMs = Date.now() - startedAt;
                if (summary.replayedFinal > 0) {
                    this.task1Metrics.resyncRecoverySuccess += 1;
                }
                this.logUiDebug(
                    `EXT: resyncLimited.done | sessionId=${sessionId}${typeof resyncEpoch === 'number' ? ` | epoch=${resyncEpoch}` : ''} | replayedFinal=${summary.replayedFinal} | replayedTools=${summary.replayedTools} | elapsedMs=${elapsedMs}`
                );
                await this.updateResyncStallState(sessionId, summary, `limited:${reason}`);
            })
            .catch((error) => {
                this.logUiDebug(`EXT: resyncLimited.fail | sessionId=${sessionId}${typeof resyncEpoch === 'number' ? ` | epoch=${resyncEpoch}` : ''} | err=${String(error)}`);
            })
            .finally(() => {
                this.resyncInFlightBySession.delete(sessionId);
                this.resyncCooldownUntilBySession.set(sessionId, Date.now() + this.resyncCooldownMs);
                this.armNonFinalResyncLoop(sessionId, `post-limited:${reason}`);
            });

        this.resyncInFlightBySession.set(sessionId, task);
    }

    private async resyncForChatResolve(sessionId: string, reason = 'resolve'): Promise<void> {
        if (!sessionId) return;

        const rootSessionId = this.subagentToParentSessionMap.get(sessionId) || sessionId;
        const targetSessionIds = this.groupedResyncActivityEnabled
            ? this.getRelatedSessionIds(rootSessionId)
            : [sessionId];

        if (this.groupedResyncActivityEnabled) {
            this.logUiDebug(
                `EXT: resync.group.activity | rootSessionId=${rootSessionId} | targetSessionId=${sessionId} | reason=${reason} | source=resync | targetCount=${targetSessionIds.length}`
            );
        }

        for (const targetSessionId of targetSessionIds) {
            if (!targetSessionId) continue;
            let blockedBySubagent = false;
            if (!this.subagentToParentSessionMap.has(targetSessionId)) {
                const subagents = Array.from(this.subagentToParentSessionMap.entries())
                    .filter(([, parentId]) => parentId === targetSessionId)
                    .map(([subId]) => subId);
                for (const subId of subagents) {
                    if (this.resyncInFlightBySession.has(subId)) {
                        const blockRootId = this.subagentToParentSessionMap.get(targetSessionId) || targetSessionId;
                        this.logUiDebug(
                            `EXT: resync.root.recover.blocked | rootSessionId=${blockRootId} | targetSessionId=${targetSessionId} | reason=subagent-resync-active | source=resync`
                        );
                        blockedBySubagent = true;
                        break;
                    }
                }
            }
            if (blockedBySubagent) {
                continue;
            }

            const inflight = this.resyncInFlightBySession.get(targetSessionId);
            if (inflight) {
                await inflight.catch(() => undefined);
                continue;
            }

            const resyncEpoch = this.beginResyncRecovery(targetSessionId, reason);
            const startedAt = Date.now();
            if (this.groupedResyncActivityEnabled) {
                this.logUiDebug(
                    `EXT: resync.group.activity | rootSessionId=${rootSessionId} | targetSessionId=${targetSessionId} | reason=${reason} | source=resync`
                );
            }
            this.task1Metrics.resyncRecoveryAttempts += 1;
            this.logUiDebug(`EXT: resyncResolve.start | sessionId=${targetSessionId} | epoch=${resyncEpoch}`);
            const task = this.resyncLimited(targetSessionId, resyncEpoch)
                .then(async (summary) => {
                    const elapsedMs = Date.now() - startedAt;
                    if (summary.replayedFinal > 0) {
                        this.task1Metrics.resyncRecoverySuccess += 1;
                    }
                    this.logUiDebug(
                        `EXT: resyncResolve.done | sessionId=${targetSessionId} | epoch=${resyncEpoch} | replayedFinal=${summary.replayedFinal} | replayedTools=${summary.replayedTools} | elapsedMs=${elapsedMs}`
                    );
                    await this.updateResyncStallState(targetSessionId, summary, reason);
                })
                .catch((error) => {
                    this.logUiDebug(`EXT: resyncResolve.fail | sessionId=${targetSessionId} | epoch=${resyncEpoch} | err=${String(error)}`);
                })
                .finally(() => {
                    this.resyncInFlightBySession.delete(targetSessionId);
                    this.resyncCooldownUntilBySession.set(targetSessionId, Date.now() + this.resyncCooldownMs);
                    this.armNonFinalResyncLoop(targetSessionId, `post-resolve:${reason}`);
                });

            this.resyncInFlightBySession.set(targetSessionId, task);
            await task;
        }
    }

    private shouldReplayResyncMessage(sessionId: string, info: any): boolean {
        if (!sessionId || !info) return false;

        const result = this.shouldReplayResyncMessageInternal(sessionId, info);
        const rootSessionId = this.subagentToParentSessionMap.get(sessionId) || sessionId;
        if (this.subagentToParentSessionMap.has(sessionId)) {
            const marker = result ? 'resync.subagent.replay.accept' : 'resync.subagent.replay.skip';
            this.logUiDebug(`EXT: ${marker} | rootSessionId=${rootSessionId} | targetSessionId=${sessionId} | reason=filter-rules | source=resync`);
        }
        return result;
    }

    private shouldReplayResyncMessageInternal(sessionId: string, info: any): boolean {
        if (!sessionId || !info) return false;

        // Session-local subagent replay filter rules (Task 3)
        const isSubagent = this.subagentToParentSessionMap.has(sessionId);
        if (isSubagent) {
            // Exclude summary=true and mode=compaction for subagent replay
            if (info?.summary === true) return false;
            if (info?.mode === 'compaction') return false;

            // Session-local anchor checks (prioritized)
            const userMsgId = this.currentTurnUserMsgIdBySession.get(sessionId);
            const parentId = info?.parentID;
            const pendingUser = this.pendingUserMsgIdBySession.get(sessionId);

            // 1. Current-turn anchor match
            if (userMsgId && parentId === userMsgId) return true;

            // 2. Pending-user anchor match
            if (pendingUser && parentId === pendingUser) return true;

            // 3. Conservative time fallback when both anchors missing
            if (!userMsgId && !pendingUser) {
                const createdAt = info?.time?.created;
                const startedAt = this.currentTurnStartedAtBySession.get(sessionId);
                if (typeof startedAt === 'number' && typeof createdAt === 'number') {
                    if (createdAt >= startedAt - 2000 && info?.role === 'assistant') {
                        return true;
                    }
                }
            }
            return false;
        }

        // Main-session logic (unchanged)
        const userMsgId = this.currentTurnUserMsgIdBySession.get(sessionId);
        const parentId = info?.parentID;
        if (userMsgId && parentId === userMsgId) return true;
        if (this.isCompactionSummaryInfo(info)) return false;
        const createdAt = info?.time?.created;
        const startedAt = this.currentTurnStartedAtBySession.get(sessionId);
        if (typeof startedAt === 'number' && typeof createdAt === 'number') {
            if (createdAt >= startedAt - 2000 && info?.role === 'assistant') {
                return true;
            }
        }
        return false;
    }

    private getExportTextParts(message: any): Array<{ text: string }> {
        const parts = Array.isArray(message?.parts) ? message.parts : [];
        const textParts = parts.filter((part: any) => part?.type === 'text' && typeof part.text === 'string');
        if (textParts.length) return textParts;
        if (typeof message?.text === 'string' && message.text.length) {
            return [{ text: message.text }];
        }
        if (typeof message?.content?.text === 'string' && message.content.text.length) {
            return [{ text: message.content.text }];
        }
        return [];
    }

    private async resyncLimited(sessionId: string, resyncEpoch?: number): Promise<{ replayedFinal: number; replayedTools: number; newestObservedMsgId?: string }> {
        const result: { replayedFinal: number; replayedTools: number; newestObservedMsgId?: string } = { replayedFinal: 0, replayedTools: 0 };
        const recentLimit = 200;
        const anchorMsgId = this.lastObservedMsgIdBySession.get(sessionId);
        let list: any[] = [];
        let source: 'recent' | 'full' = 'recent';

        const recentMessages = await this.requestJson<any[]>('GET', `/session/${sessionId}/message?limit=${recentLimit}`);
        const recentList = Array.isArray(recentMessages) ? recentMessages : [];
        const hasAnchor = typeof anchorMsgId === 'string' && anchorMsgId.length > 0;
        const anchorHit = hasAnchor && recentList.some((item) => item?.info?.id === anchorMsgId);

        if (!hasAnchor || anchorHit) {
            list = recentList;
            source = 'recent';
        } else {
            const fullMessages = await this.requestJson<any[]>('GET', `/session/${sessionId}/message`);
            list = Array.isArray(fullMessages) ? fullMessages : [];
            source = 'full';
        }
        const newestObserved = [...list].reverse().find((item) => typeof item?.info?.id === 'string' && item.info.id.startsWith('msg_'))?.info?.id;
        if (typeof newestObserved === 'string') {
            this.lastObservedMsgIdBySession.set(sessionId, newestObserved);
            result.newestObservedMsgId = newestObserved;
        }
        this.logUiDebug(`EXT: resync.fetch.path | sessionId=${sessionId} | source=${source} | anchor=${anchorMsgId || 'null'} | anchorHit=${String(anchorHit)} | recentCount=${recentList.length} | usedCount=${list.length}`);
        const rootIdForFetch = this.subagentToParentSessionMap.get(sessionId) || sessionId;
        this.logUiDebug(`EXT: resync.group.fetch | rootSessionId=${rootIdForFetch} | targetSessionId=${sessionId} | reason=resync-limited | source=${source}`);

        // Pre-scan: find the last stop-final message
        let lastStopFinalId: string | undefined;
        for (const m of list) {
            if (m?.info?.role === 'assistant' && m?.info?.finish === 'stop' && typeof m?.info?.id === 'string') {
                lastStopFinalId = m.info.id;
            }
        }

        for (const item of list) {
            if (typeof resyncEpoch === 'number' && !this.isResyncRunActive(sessionId, resyncEpoch)) {
                this.logUiDebug(`EXT: resync.drop.stale | sessionId=${sessionId} | epoch=${resyncEpoch} | stage=scan`);
                return result;
            }
            const info = item?.info || {};
            if (!this.shouldReplayResyncMessage(sessionId, info)) continue;
            const messageId = info?.id;
            const role = info?.role;
            if (role === 'assistant' && typeof messageId === 'string') {
                if (typeof info?.parentID === 'string' && info.parentID.length) {
                    const turnUser = this.currentTurnUserMsgIdBySession.get(sessionId);
                    if (turnUser && info.parentID === turnUser) {
                        this.setCurrentTurnAssistantMsgId(sessionId, messageId, 'resync-limited');
                    }
                }
            }

            const parts = Array.isArray(item?.parts) ? item.parts : [];
            if (parts.length) {
                for (const part of parts) {
                    if (typeof resyncEpoch === 'number' && !this.isResyncRunActive(sessionId, resyncEpoch)) {
                        this.logUiDebug(`EXT: resync.drop.stale | sessionId=${sessionId} | epoch=${resyncEpoch} | stage=parts`);
                        return result;
                    }
                    const normalizedPart = {
                        ...part,
                        sessionID: part?.sessionID || sessionId,
                        messageID: part?.messageID || messageId
                    };
                    const events = this.mapServerEventToChatEvents('message.part.updated', { part: normalizedPart }, 'resync');
                    if (events.length) {
                        const filtered = events;
                        if (filtered.some((event) => event.type === 'files')) {
                            result.replayedTools += 1;
                        }
                        if (filtered.length) {
                            this.emitChatEvents(filtered);
                        }
                    }
                }
            } else if (role === 'assistant' && typeof messageId === 'string') {
                const textParts = this.getExportTextParts(item);
                for (const part of textParts) {
                    if (typeof resyncEpoch === 'number' && !this.isResyncRunActive(sessionId, resyncEpoch)) {
                        this.logUiDebug(`EXT: resync.drop.stale | sessionId=${sessionId} | epoch=${resyncEpoch} | stage=textparts`);
                        return result;
                    }
                    const events = this.mapServerEventToChatEvents(
                        'message.part.updated',
                        { part: { type: 'text', text: part.text, sessionID: sessionId, messageID: messageId } },
                        'resync'
                    );
                    if (events.length) {
                        this.emitChatEvents(events);
                    }
                }
            }

            if (role === 'assistant' && typeof messageId === 'string') {
                const isSubagentLane = this.subagentToParentSessionMap.has(sessionId);
                const lane: EventLane = isSubagentLane ? 'subagent' : (sessionId === this.currentSessionId || this.turnStateBySession.has(sessionId) ? 'main' : 'unknown');
                const completedAt = info?.time?.completed;
                const isFinal = this.isCompletionFinal(info);
                let acceptedFinal = false;
                if (!isFinal || this.hasRunningToolsForMessage(messageId) || info?.finish === 'tool-calls') {
                    this.emitAssistantPhase(undefined, {
                        sessionId,
                        messageId,
                        parentId: typeof info?.parentID === 'string' ? info.parentID : undefined,
                        source: 'resync',
                        lane,
                        phase: 'assistant_progress',
                        reason: !isFinal ? 'non-final' : 'running-tools-or-tool-calls'
                    });
                }
                if (isFinal) {
                    this.emitAssistantPhase(undefined, {
                        sessionId,
                        messageId,
                        parentId: typeof info?.parentID === 'string' ? info.parentID : undefined,
                        source: 'resync',
                        lane,
                        phase: 'assistant_final_candidate',
                        reason: 'finish-stop'
                    });
                    if (!isSubagentLane) {
                        // Stale-override guard: if this is the last stop-final and parentId mismatches currentUser, override
                        if (messageId === lastStopFinalId && info.finish === 'stop') {
                            const currentUser = this.currentTurnUserMsgIdBySession.get(sessionId);
                            const parentId = info?.parentID;
                            if (currentUser !== undefined && typeof parentId === 'string' && parentId.length > 0 && currentUser !== parentId) {
                                this.logUiDebug(
                                    `turn.anchor.stale-override | sessionId=${sessionId} | oldUser=${currentUser} | newUser=${parentId} | triggerMsg=${messageId}`
                                );
                                this.setCurrentTurnUserMsgId(sessionId, parentId, 'resync-stale-override');
                            }
                        }
                        this.maybeBackfillTurnUserAnchor(sessionId, info);
                        if (this.shouldAcceptTurnCompletionFinal(sessionId, info)) {
                            this.logUiDebug(`EXT: turn.final.accept | sessionId=${sessionId} | msgId=${messageId} | finish=${String(info?.finish || '')} | source=resync`);
                            this.markTurnFinal(sessionId, messageId, 'resync');
                            acceptedFinal = true;
                        } else {
                            this.logUiDebug(`EXT: turn.final.skip | sessionId=${sessionId} | msgId=${messageId} | finish=${String(info?.finish || '')} | source=resync`);
                        }
                    } else if (this.shouldAcceptSubagentCompletionFinal(sessionId, info)) {
                        acceptedFinal = true;
                        this.logUiDebug(`EXT: subagent.final.accept | sessionId=${sessionId} | msgId=${messageId} | finish=${String(info?.finish || '')} | source=resync`);
                    } else {
                        this.logUiDebug(`EXT: subagent.final.skip | sessionId=${sessionId} | msgId=${messageId} | finish=${String(info?.finish || '')} | source=resync`);
                    }
                }
                const shouldEmit = isFinal && acceptedFinal && this.shouldEmitFinalMeta(sessionId, messageId, completedAt, info?.finish, 'resync');
                const phase = isSubagentLane ? 'subagent-final-accepted' : 'turn-final-accepted';
                if (shouldEmit && this.consumePhaseOnce(sessionId, messageId, phase)) {
                    this.emitAssistantPhase(undefined, {
                        sessionId,
                        messageId,
                        parentId: typeof info?.parentID === 'string' ? info.parentID : undefined,
                        source: 'resync',
                        lane,
                        phase: 'assistant_final_accepted',
                        reason: isSubagentLane ? 'subagent-final-accepted' : 'turn-final-accepted'
                    });
                    const messageIndex = this.registerMessage(messageId);
                    this.recordAssistantMsgId(sessionId, messageId);
                    this.emitChatEvents([
                        {
                            type: 'assistantMessageMeta',
                            sessionId,
                            assistantMsgId: messageId,
                            messageId,
                            messageIndex,
                            tmpKey: this.getPendingAssistantTmpKey(sessionId)
                        }
                    ]);
                    result.replayedFinal += 1;
                }
            }
        }
        return result;
    }

    public async checkVersion(): Promise<string> {
        try {
            await this.ensureServer();
            const health = await this.requestJson<{ healthy: boolean; version?: string }>('GET', '/global/health');
            return typeof health?.version === 'string' ? health.version : 'unknown';
        } catch {
            return this.execute(['--version']);
        }
    }

    public async chat(
        message: string,
        options: { model?: string; variant?: string; sessionId?: string; continueSession?: boolean; files?: string[]; mode?: string },
        onEvent?: (event: ChatEvent) => void
    ): Promise<void> {
        await this.ensureServer();
        const sessionId = options.sessionId || this.currentSessionId;
        if (!sessionId) {
            throw new Error('Missing session ID for chat request.');
        }
        const listener = onEvent ? (event: ChatEvent) => onEvent(event) : undefined;
        if (listener) {
            this.eventListeners.add(listener);
        }

        const payload: any = {
            parts: [{ type: 'text', text: message }]
        };
        const modelRef = this.parseModelRef(options.model);
        if (modelRef) {
            payload.model = modelRef;
        }
        payload.agent = options.mode || 'plan';
        this.expectedMainAgentBySession.set(sessionId, options.mode || 'plan');
        if (options.files && options.files.length) {
            payload.parts.push(...options.files.map((file) => ({ type: 'file', path: file })));
        }

        await this.requestJson('POST', `/session/${sessionId}/prompt_async`, payload);
        await this.waitForTurnCompletionFinal(sessionId);
        if (listener) {
            const resolvedAssistant = this.getTurnAssistantMsgId(sessionId);
            if (!resolvedAssistant) {
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
            this.eventListeners.delete(listener);
        }
    }

    private toBodyPreview(value: unknown, maxLen = 500): string {
        let text = '';
        if (typeof value === 'string') {
            text = value;
        } else {
            try {
                text = JSON.stringify(value);
            } catch {
                text = String(value);
            }
        }
        if (!text) return '';
        return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
    }

    private getBaseUrlForLog(): string {
        const base = this.serverBaseUrl || '';
        return base.replace(/\/$/, '');
    }

    private getQuestionDirectory(sessionId: string): string {
        return this.lastCwdBySession.get(sessionId) || this.workspaceRoot;
    }

    private getPermissionDirectory(sessionId: string): string {
        return this.lastCwdBySession.get(sessionId) || this.workspaceRoot;
    }

    private buildQuestionListPath(sessionId: string): string {
        const directory = this.getQuestionDirectory(sessionId);
        return `/question?directory=${encodeURIComponent(directory)}`;
    }

    private buildQuestionReplyPath(sessionId: string, requestId: string): string {
        const directory = this.getQuestionDirectory(sessionId);
        return `/question/${encodeURIComponent(requestId)}/reply?directory=${encodeURIComponent(directory)}`;
    }

    private buildPermissionListPath(sessionId: string): string {
        const directory = this.getPermissionDirectory(sessionId);
        return `/permission?directory=${encodeURIComponent(directory)}`;
    }

    private buildPermissionReplyPath(sessionId: string, requestId: string): string {
        const directory = this.getPermissionDirectory(sessionId);
        return `/permission/${encodeURIComponent(requestId)}/reply?directory=${encodeURIComponent(directory)}`;
    }

    private buildSessionPermissionRespondPath(sessionId: string, permissionId: string): string {
        const directory = this.getPermissionDirectory(sessionId);
        return `/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}?directory=${encodeURIComponent(directory)}`;
    }

    private async listQuestions(sessionId: string): Promise<QuestionListItem[]> {
        const reqPath = this.buildQuestionListPath(sessionId);
        const response = await this.serverFetch(reqPath, { method: 'GET' }, {
            opName: 'question.list',
            timeoutMs: 5000,
            retry: false
        });
        const contentType = response.headers.get('content-type') || '';
        const rawText = await response.text();
        const bodyPreview = this.toBodyPreview(rawText, 300);
        this.logUiDebug(`EXT: question.list | status=${response.status} | contentType=${contentType || 'unknown'} | bodyPreview=${bodyPreview || 'empty'}`);
        if (response.status >= 400) {
            return [];
        }
        if (!contentType.toLowerCase().includes('application/json')) {
            return [];
        }
        try {
            const parsed = rawText ? JSON.parse(rawText) : [];
            return Array.isArray(parsed) ? parsed as QuestionListItem[] : [];
        } catch {
            return [];
        }
    }

    private async listPermissions(sessionId: string): Promise<PermissionListItem[]> {
        const reqPath = this.buildPermissionListPath(sessionId);
        const response = await this.serverFetch(reqPath, { method: 'GET' }, {
            opName: 'permission.list',
            timeoutMs: 5000,
            retry: false
        });
        const contentType = response.headers.get('content-type') || '';
        const rawText = await response.text();
        const bodyPreview = this.toBodyPreview(rawText, 300);
        this.logUiDebug(`EXT: permission.list | status=${response.status} | contentType=${contentType || 'unknown'} | bodyPreview=${bodyPreview || 'empty'}`);
        if (response.status >= 400) {
            return [];
        }
        if (!contentType.toLowerCase().includes('application/json')) {
            return [];
        }
        try {
            const parsed = rawText ? JSON.parse(rawText) : [];
            return Array.isArray(parsed) ? parsed as PermissionListItem[] : [];
        } catch {
            return [];
        }
    }

    private extractSelection(result: any): { selectedId?: string; selectedLabel?: string } {
        if (!result || typeof result !== 'object') return {};
        const selectedId = typeof result.selectedId === 'string' && result.selectedId.trim().length
            ? result.selectedId.trim()
            : undefined;
        const selectedLabel = typeof result.selectedLabel === 'string' && result.selectedLabel.trim().length
            ? result.selectedLabel.trim()
            : undefined;
        return { selectedId, selectedLabel };
    }

    private extractMatrixAnswers(result: any): string[][] {
        if (!result || typeof result !== 'object' || !Array.isArray(result.answers)) return [];
        const matrix: string[][] = [];
        for (const row of result.answers) {
            if (!Array.isArray(row)) return [];
            const normalized = row
                .filter((value) => typeof value === 'string')
                .map((value) => value.trim())
                .filter((value) => value.length > 0);
            if (!normalized.length) return [];
            matrix.push(normalized);
        }
        return matrix;
    }

    private async resolveQuestionRequestId(sessionId: string, callId: string, requestId?: string): Promise<string | undefined> {
        const questions = await this.listQuestions(sessionId);
        let match: QuestionListItem | undefined;
        if (requestId) {
            match = questions.find((item) => item?.id === requestId);
        }
        if (!match) {
            match = questions.find((item) => item?.sessionID === sessionId && item?.tool?.callID === callId);
        }
        this.logUiDebug(`EXT: question.match | callId=${callId} | requestId=${requestId || 'none'} | matched=${String(Boolean(match))} | count=${questions.length}`);
        return match?.id;
    }

    private buildQuestionAnswers(selection: { selectedId?: string; selectedLabel?: string }, pending?: PendingQuestionControl, directAnswers?: string[][]): string[][] {
        if (Array.isArray(directAnswers) && directAnswers.length) {
            return directAnswers;
        }
        const direct = selection.selectedLabel || selection.selectedId || '';
        if (!direct) return [];
        if (!pending?.options?.length) return [[direct]];
        const found = pending.options.find((option) => option.id === selection.selectedId || option.label === selection.selectedLabel);
        return [[found?.label || direct]];
    }

    private async postQuestionReply(sessionId: string, requestId: string, answers: string[][]): Promise<void> {
        const reqPath = this.buildQuestionReplyPath(sessionId, requestId);
        const url = `${this.getBaseUrlForLog()}${reqPath.startsWith('/') ? reqPath : `/${reqPath}`}`;
        const response = await this.serverFetch(
            reqPath,
            { method: 'POST', body: JSON.stringify({ answers }), headers: { 'Content-Type': 'application/json' } },
            { opName: 'question.reply', timeoutMs: 5000, retry: false }
        );
        const contentType = response.headers.get('content-type') || '';
        this.logUiDebug(`EXT: toolResult.post | url | ${url} | status | ${response.status} | contentType | ${contentType || 'unknown'}`);

        if (response.status >= 400 || contentType.toLowerCase().includes('text/html')) {
            const text = await response.text();
            const preview = this.toBodyPreview(text, 200);
            this.logUiDebug(`EXT: toolResult.post.body | preview=${preview || 'empty'}`);
            throw new Error(`Question reply rejected: status=${response.status} contentType=${contentType || 'unknown'}`);
        }

        if (contentType.toLowerCase().includes('application/json')) {
            const text = await response.text();
            if (!text.trim()) return;
            try {
                const parsed = JSON.parse(text);
                if (parsed === false) {
                    throw new Error('Question reply returned false');
                }
            } catch (error) {
                throw new Error(`Question reply parse failed: ${String(error)}`);
            }
        }
    }

    public async sendToolResult(payload: {
        sessionId?: string;
        callId: string;
        requestId?: string;
        result: unknown;
    }): Promise<void> {
        await this.ensureServer();
        const sessionId = payload.sessionId || this.currentSessionId;
        if (!sessionId) {
            throw new Error('Missing session ID for tool result.');
        }

        const pending = this.getPendingQuestion(sessionId, payload.callId);
        const matrixAnswers = this.extractMatrixAnswers(payload.result);
        const selection = this.extractSelection(payload.result);
        if (!matrixAnswers.length && !selection.selectedId && !selection.selectedLabel) {
            throw new Error('Missing selected option payload');
        }

        const resolvedRequestId = await this.resolveQuestionRequestId(sessionId, payload.callId, payload.requestId);
        if (!resolvedRequestId) {
            throw new Error('No matching question request found for callId');
        }
        const answers = this.buildQuestionAnswers(selection, pending, matrixAnswers);
        if (!answers.length) {
            throw new Error('Invalid question answer payload');
        }
        await this.postQuestionReply(sessionId, resolvedRequestId, answers);
        this.clearPendingQuestion(sessionId, payload.callId);
    }

    public async respondPermission(payload: {
        sessionId?: string;
        permissionId?: string;
        requestId?: string;
        response: PermissionReply;
    }): Promise<void> {
        await this.ensureServer();
        const sessionId = payload.sessionId || this.currentSessionId;
        if (!sessionId) {
            throw new Error('Missing session ID for permission response.');
        }
        const responseValue: PermissionReply = payload.response === 'always' || payload.response === 'reject'
            ? payload.response
            : 'once';
        const permissionId = typeof payload.permissionId === 'string' && payload.permissionId.length
            ? payload.permissionId
            : (typeof payload.requestId === 'string' ? payload.requestId : '');

        if (permissionId) {
            const reqPath = this.buildSessionPermissionRespondPath(sessionId, permissionId);
            try {
                const result = await this.requestJson<any>('POST', reqPath, { response: responseValue });
                if (result === false) {
                    throw new Error('Permission respond returned false');
                }
                this.clearPendingPermission(sessionId, permissionId);
                return;
            } catch (error) {
                this.logUiDebug(`EXT: permission.respond.fail | sessionId=${sessionId} | permissionId=${permissionId} | err=${String(error)}`);
            }
        }

        let resolvedRequestId = typeof payload.requestId === 'string' && payload.requestId.length
            ? payload.requestId
            : '';
        if (!resolvedRequestId && permissionId) {
            resolvedRequestId = permissionId;
        }
        if (!resolvedRequestId) {
            const pending = await this.listPermissions(sessionId);
            const matched = pending.find((item) => item?.sessionID === sessionId);
            resolvedRequestId = matched?.id || '';
        }
        if (!resolvedRequestId) {
            throw new Error('No permission request ID available');
        }

        const reqPath = this.buildPermissionReplyPath(sessionId, resolvedRequestId);
        const result = await this.requestJson<any>('POST', reqPath, { reply: responseValue });
        if (result === false) {
            throw new Error('Permission reply returned false');
        }
        this.clearPendingPermission(sessionId, resolvedRequestId);
    }

    public async getTuiControlResponseSchemaSummary(): Promise<string> {
        await this.ensureServer();
        const response = await this.serverFetch('/doc', { method: 'GET' }, { opName: 'doc.fetch', timeoutMs: 5000 });
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`Failed to fetch /doc: ${response.status}`);
        }
        let parsed: any;
        try {
            parsed = JSON.parse(text);
        } catch (error) {
            throw new Error(`Invalid /doc JSON: ${String(error)}`);
        }

        const paths = parsed?.paths || {};
        const postResp = paths?.['/tui/control/response']?.post;
        const getNext = paths?.['/tui/control/next']?.get;
        const getQuestion = paths?.['/question']?.get;
        const postQuestionReply = paths?.['/question/{requestID}/reply']?.post;
        const responseSchema = postResp?.requestBody?.content?.['application/json']?.schema || {};
        const nextSchema = getNext?.responses?.['200']?.content?.['application/json']?.schema || {};
        const questionListSchema = getQuestion?.responses?.['200']?.content?.['application/json']?.schema || {};
        const questionReplySchema = postQuestionReply?.requestBody?.content?.['application/json']?.schema || {};

        const lines = [
            `operationId(/tui/control/response): ${postResp?.operationId || 'missing'}`,
            `requestSchema(/tui/control/response): ${JSON.stringify(responseSchema)}`,
            `operationId(/tui/control/next): ${getNext?.operationId || 'missing'}`,
            `responseSchema(/tui/control/next): ${JSON.stringify(nextSchema)}`,
            `operationId(/question): ${getQuestion?.operationId || 'missing'}`,
            `responseSchema(/question): ${JSON.stringify(questionListSchema)}`,
            `operationId(/question/{requestID}/reply): ${postQuestionReply?.operationId || 'missing'}`,
            `requestSchema(/question/{requestID}/reply): ${JSON.stringify(questionReplySchema)}`
        ];
        return lines.join('\n');
    }

    public async listModels(): Promise<ModelInfo[]> {
        await this.ensureServer();
        let attempts = 0;
        let models: ModelInfo[] = [];
        while (attempts < 2) {
            const payload = await this.requestJson<any>('GET', '/config/providers');
            const providers = Array.isArray(payload?.providers) ? payload.providers : [];
            models = [];
            for (const provider of providers) {
                const providerId = typeof provider?.id === 'string' ? provider.id : '';
                const modelMap = provider?.models || {};
                for (const modelId of Object.keys(modelMap)) {
                    const model = modelMap[modelId] || {};
                    const id = typeof model?.id === 'string' ? model.id : modelId;
                    const name = typeof model?.name === 'string' ? model.name : `${providerId}/${id}`;
                    const variants = model?.variants ? Object.keys(model.variants) : [];
                    const fullId = providerId ? `${providerId}/${id}` : id;
                    models.push({ id, providerId, name, fullId, variants });
                }
            }
            if (models.length) {
                break;
            }
            attempts += 1;
            await new Promise((resolve) => setTimeout(resolve, 300));
        }
        this.applyCopilotSpeedMultipliers(models);
        return models;
    }

    public async listAgents(): Promise<AgentInfo[]> {
        await this.ensureServer();
        const payload = await this.requestJson<any[]>('GET', '/agent');
        const list = Array.isArray(payload) ? payload : [];
        const agents: AgentInfo[] = [];
        for (const item of list) {
            const id = typeof item?.name === 'string' ? item.name : '';
            if (!id) continue;
            const mode = typeof item?.mode === 'string' ? item.mode : '';
            const hidden = item?.hidden === true;
            const description = typeof item?.description === 'string' ? item.description : undefined;
            agents.push({ id, mode, hidden, description });
        }
        return agents;
    }

    public async listSessions(): Promise<SessionInfo[]> {
        await this.ensureServer();
        const sessions = await this.requestJson<any[]>('GET', '/session');
        if (!Array.isArray(sessions)) {
            return [];
        }
        const mapped = sessions.map((session) => ({
            id: session.id,
            title: session.title || 'Untitled Session',
            updated: session?.time?.updated ? new Date(session.time.updated).toLocaleString() : '',
            updatedMs: typeof session?.time?.updated === 'number' ? session.time.updated : 0
        }));
        mapped.sort((a, b) => b.updatedMs - a.updatedMs);
        return mapped.map(({ updatedMs, ...rest }) => rest);
    }

    public async createSession(): Promise<{ id: string }> {
        await this.ensureServer();
        const session = await this.requestJson<any>('POST', '/session', {});
        if (session?.id) {
            return { id: session.id };
        }
        throw new Error('Failed to create session.');
    }

    public async getSessionInfo(sessionId: string): Promise<any> {
        await this.ensureServer();
        return this.requestJson<any>('GET', `/session/${sessionId}`);
    }

    public async getSessionChildren(sessionId: string): Promise<any[]> {
        await this.ensureServer();
        const directory = encodeURIComponent(this.workspaceRoot || '.');
        const reqPath = `/session/${encodeURIComponent(sessionId)}/children?directory=${directory}`;
        const children = await this.requestJson<any[]>('GET', reqPath);
        return Array.isArray(children) ? children : [];
    }

    public async deleteSession(sessionId: string): Promise<boolean> {
        await this.ensureServer();
        const directory = encodeURIComponent(this.workspaceRoot || '.');
        const reqPath = `/session/${encodeURIComponent(sessionId)}?directory=${directory}`;
        const result = await this.requestJson<any>('DELETE', reqPath);
        return Boolean(result);
    }

    public async exportSession(sessionId: string): Promise<any> {
        await this.ensureServer();
        const messages = await this.requestJson<any[]>( 'GET', `/session/${sessionId}/message`);
        const info = await this.requestJson<any>('GET', `/session/${sessionId}`);
        return { session: info, messages };
    }

    public async exportSessionRecent(sessionId: string, limit = 200): Promise<any> {
        await this.ensureServer();
        const safeLimit = Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 200));
        const messages = await this.requestJson<any[]>('GET', `/session/${sessionId}/message?limit=${safeLimit}`);
        const info = await this.requestJson<any>('GET', `/session/${sessionId}`);
        return { session: info, messages };
    }

    public async listSessionMessages(sessionId: string): Promise<any[]> {
        await this.ensureServer();
        const messages = await this.requestJson<any[]>('GET', `/session/${sessionId}/message`);
        return Array.isArray(messages) ? messages : [];
    }

    public cancel(): void {
        const sessionId = this.currentSessionId;
        if (!sessionId) return;
        void this.requestJson('POST', `/session/${sessionId}/abort`, {});
    }

    public async warmServer(): Promise<void> {
        await this.ensureServer();
    }

    private parseModels(output: string): ModelInfo[] {
        const lines = output.split(/\r?\n/);
        const models: ModelInfo[] = [];
        let currentLabel = '';
        let jsonLines: string[] = [];
        let braceCount = 0;

        const flush = () => {
            if (!jsonLines.length) return;
            const jsonText = jsonLines.join('\n');
            jsonLines = [];
            try {
                const parsed = JSON.parse(jsonText);
                const providerId = parsed.providerID || '';
                const id = parsed.id || '';
                const name = parsed.name || `${providerId}/${id}`;
                const variants = parsed.variants ? Object.keys(parsed.variants) : [];
                const fullId = currentLabel || (providerId && id ? `${providerId}/${id}` : id);
                models.push({ id, providerId, name, fullId, variants });
            } catch (error) {
                OpenCodeClient.outputChannel.appendLine(`[PARSE_ERR] Failed to parse model JSON`);
            }
        };

        for (const rawLine of lines) {
            const line = rawLine.trimEnd();
            const trimmed = line.trim();
            if (!trimmed && braceCount === 0) {
                continue;
            }

            if (braceCount === 0 && trimmed && !trimmed.startsWith('{')) {
                currentLabel = trimmed;
                continue;
            }

            if (trimmed.startsWith('{') || braceCount > 0) {
                jsonLines.push(line);
                for (let i = 0; i < line.length; i++) {
                    const char = line[i];
                    if (char === '{') braceCount++;
                    if (char === '}') braceCount--;
                }
                if (braceCount === 0) {
                    flush();
                }
            }
        }

        return models;
    }

    private applyCopilotSpeedMultipliers(models: ModelInfo[]): void {
        const hasCopilot = models.some((model) => {
            const provider = (model.providerId || '').toLowerCase();
            const fullId = (model.fullId || '').toLowerCase();
            return provider.includes('copilot') || fullId.includes('copilot');
        });
        if (!hasCopilot) return;

        const speedMap = new Map<string, string>([
            ['GPT-4.1', '0x'],
            ['GPT-4o', '0x'],
            ['Grok Code Fast 1', '0x'],
            ['Raptor mini (Preview)', '0x'],
            ['Claude Haiku 4.5', '0.33x'],
            ['Claude Opus 4.1', '1x'],
            ['Claude Opus 4.5', '3x'],
            ['Claude Opus 4.6', '3x'],
            ['Claude Sonnet 4', '1x'],
            ['Claude Sonnet 4.6', '1x'],
            ['Claude Sonnet 4.5', '1x'],
            ['Gemini 2.5 Pro', '1x'],
            ['Gemini 3 Flash', '0.33x'],
            ['Gemini 3 Pro Preview', '1x'],
            ['GPT-5', '1x'],
            ['GPT-5-Codex (Preview)', '1x'],
            ['GPT-5.1', '1x'],
            ['GPT-5.1-Codex', '1x'],
            ['GPT-5.1-Codex-max', '1x'],
            ['GPT-5.1-Codex-mini', '0.33x'],
            ['GPT-5.2', '1x'],
            ['GPT-5.2-Codex', '1x']
        ]);

        for (const model of models) {
            const speed =
                speedMap.get(model.name) ||
                speedMap.get(model.fullId) ||
                speedMap.get(model.id);
            if (speed) {
                model.speedMultiplier = speed;
            }
        }
    }

    private parseSessions(output: string): SessionInfo[] {
        try {
            const sessions = JSON.parse(output);
            
            if (!Array.isArray(sessions)) {
                console.error(`parseSessions error: expected array, got ${typeof sessions}`);
                return [];
            }
            
            const parsedSessions: SessionInfo[] = sessions.map((session: any) => {
                const updated = session.updated 
                    ? new Date(session.updated).toLocaleString() 
                    : '';
                
                return {
                    id: session.id || '',
                    title: session.title || '',
                    updated: updated
                };
            });
            
            const missingUpdated = parsedSessions.filter(s => !s.updated).length;
            
            OpenCodeClient.outputChannel.appendLine(
                `EXT: parseSessions summary | totalLines | ${sessions.length} | parsed | ${parsedSessions.length} | dropped | 0 | missingUpdated | ${missingUpdated}`
            );
            
            const sampleCount = Math.min(3, parsedSessions.length);
            for (let i = 0; i < sampleCount; i++) {
                const s = parsedSessions[i];
                const titlePreview = s.title.length > 50 ? s.title.substring(0, 50) + '...' : s.title;
                OpenCodeClient.outputChannel.appendLine(
                    `EXT: parseSessions sample | ${i} | ${s.id} | ${titlePreview} | ${s.updated}`
                );
            }
            
            return parsedSessions;
            
        } catch (error) {
            console.error(`parseSessions error: ${String(error)}`);
            return [];
        }
    }
}


