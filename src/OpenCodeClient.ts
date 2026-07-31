import * as https from 'https';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { GitUndoEngine } from './undo/GitUndoEngine';
import { normalizeTouchedFiles } from './undo/GitPathUtils';
import { runGit } from './undo/GitRunner';
import { GitCapabilities, FileChangeSpec } from './undo/types';
import {
    getCopilotSpeedMultiplierKeys,
    getLocalCopilotSpeedMultiplierMap,
    inferCopilotSpeedMultiplier,
    isCopilotProviderId,
    normalizeCopilotModelKey,
    parseCopilotMultiplierHtml
} from './copilotSpeedMapping';
import { ModelQuotaService } from './models/ModelQuotaService';
import type { ModelInfo, ModelQuota } from './models/types';
import { OpenCodeCommandResolver } from './transport/OpenCodeCommandResolver';
import { OpenCodeProcessRunner } from './transport/OpenCodeProcessRunner';
import { OpenCodeHttpClient, type ServerConnection, type ServerFetchOptions } from './transport/OpenCodeHttpClient';
import { OpenCodeServerLockStore } from './transport/OpenCodeServerLockStore';
import { OpenCodeEventStream } from './transport/OpenCodeEventStream';
import { OpenCodeServerProcess } from './transport/OpenCodeServerProcess';
import { OpenCodeServerController } from './transport/OpenCodeServerController';
import { mapServerEventToChatEvents } from './events/OpenCodeEventMapper';
import {
    buildChangeSpecs,
    extractDeletedPathsFromCommand,
    extractFilesFromEvent,
    extractFilesFromToolPart,
    extractPatchText,
    extractWrittenPathsFromBashCommand,
    mergeChangeSpecs,
    normalizeIncomingFileSnapshots,
    type FileSnapshot,
} from './changes/FileChangeExtractor';
import { PendingTurnChangeStore, type PendingTurnChanges } from './changes/PendingTurnChangeStore';
export type { ModelInfo, ModelQuota, ModelQuotaRow } from './models/types';
export type { FileSnapshot } from './changes/FileChangeExtractor';

export type AgentInfo = {
    id: string;
    mode: string;
    hidden: boolean;
    description?: string;
};

type CopilotSpeedMultiplierCache = {
    fetchedAt: number;
    multipliers: Record<string, string>;
};

export type SessionInfo = {
    id: string;
    title: string;
    updated: string;
    cwd?: string;
    parentID?: string;
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

/**
 * Continuation-turn contract (Task 1 source-of-truth).
 *
 * State machine (must be treated as explicit lifecycle states):
 * sealed -> revive_armed -> bootstrap_buffering -> continuation_active -> continuation_finalized
 *        \-> invalidated
 * bootstrap_buffering/continuation_active -> orphaned (10s silence)
 * any revive-related state -> exhausted (more than 2 continuations)
 */
type ContinuationLifecycleState =
    | 'sealed'
    | 'revive_armed'
    | 'bootstrap_buffering'
    | 'continuation_active'
    | 'continuation_finalized'
    | 'orphaned'
    | 'invalidated'
    | 'exhausted';

type ContinuationSuppressionReason =
    | 'submitted-prompt'
    | 'max-continuations-exhausted'
    | 'ttl-expired'
    | 'invalid-state';

/**
 * Metadata contract for continuation assistant messages.
 * - continuationChainId: stable identity shared by sealed final + all continuations
 * - priorAssistantFinalMsgId: immutable assistant final this continuation follows
 * - continuationSequence: 1..N within the same chain (max N=2 in v1)
 */
export type ContinuationMessageMetadata = {
    continuationChainId: string;
    priorAssistantFinalMsgId: string;
    continuationSequence: number;
};

type ContinuationChainRuntime = {
    continuationChainId: string;
    priorAssistantFinalMsgId: string;
    sealedAt: number;
    state: ContinuationLifecycleState;
    continuationCount: number;
    latestContinuationMeta?: ContinuationMessageMetadata;
    invalidatedReason?: ContinuationSuppressionReason;
    invalidatedAt?: number;
};

type ContinuationSlotDisposition = 're-init in continuation' | 'stay cleared' | 'different key';

type ContinuationStateSlotManifestEntry = {
    slot: string;
    clearedBy: 'finishTurn' | 'clearFinalizeSessionState' | 'clearSilenceTimer';
    disposition: ContinuationSlotDisposition;
    note: string;
};

export const CONTINUATION_TURN_INVARIANTS = Object.freeze({
    reviveTtlMs: 30_000,
    maxContinuationsPerOriginalTurn: 2,
    suppressionRule: 'suppress only after submitted prompt (typing does not suppress)' as const,
    exhaustedPolicy: 'log-and-drop' as const,
    reviveBootstrapBufferWindowMs: 2_000,
    orphanCleanupTimeoutMs: 10_000,
});

/**
 * State-slot manifest for everything cleared by finishTurn() and clearFinalizeSessionState().
 * Implementers MUST use this as the continuation bootstrap checklist.
 */
export const CONTINUATION_STATE_SLOT_MANIFEST: ReadonlyArray<ContinuationStateSlotManifestEntry> = [
    { slot: 'turnStateBySession', clearedBy: 'finishTurn', disposition: 're-init in continuation', note: 'new TurnState for continuation turn' },
    { slot: 'pendingTurnChangesBySession', clearedBy: 'finishTurn', disposition: 're-init in continuation', note: 'new pending queue for continuation turn' },
    { slot: 'turnWriteStateBySession', clearedBy: 'finishTurn', disposition: 'different key', note: 'bind to continuation hidden user anchor turnKey' },
    { slot: 'activeTurnOpIdBySession', clearedBy: 'finishTurn', disposition: 'stay cleared', note: 'continuation gets a fresh op association' },
    { slot: 'canceledActiveTurnBySession', clearedBy: 'finishTurn', disposition: 're-init in continuation', note: 'must restart as not canceled' },
    { slot: 'pendingUserMsgIdBySession', clearedBy: 'finishTurn', disposition: 'different key', note: 'continuation hidden user anchor owns parent link' },
    { slot: 'pendingAssistantMsgIdBySession', clearedBy: 'finishTurn', disposition: 'different key', note: 'fresh continuation assistant id only' },
    { slot: 'currentTurnUserMsgIdBySession', clearedBy: 'finishTurn', disposition: 'different key', note: 'new hidden continuation user anchor' },
    { slot: 'displayTurnUserMsgIdBySession', clearedBy: 'finishTurn', disposition: 'stay cleared', note: 'hidden continuation anchor must stay non-visible' },
    { slot: 'hiddenControlUserMsgIdsBySession', clearedBy: 'finishTurn', disposition: 're-init in continuation', note: 'new hidden-control scope for continuation' },
    { slot: 'hiddenControlAssistantMsgIdsBySession', clearedBy: 'finishTurn', disposition: 're-init in continuation', note: 'new hidden assistant suppression scope' },
    { slot: 'pendingStopContinuationUserBySession', clearedBy: 'finishTurn', disposition: 'stay cleared', note: 'auto stop is not revived in continuation v1' },
    { slot: 'currentTurnAssistantMsgIdBySession', clearedBy: 'finishTurn', disposition: 'different key', note: 'fresh continuation assistant message id' },
    { slot: 'currentTurnStartedAtBySession', clearedBy: 'finishTurn', disposition: 're-init in continuation', note: 'new continuation turn start timestamp' },
    { slot: 'lastSseAtBySession', clearedBy: 'finishTurn', disposition: 're-init in continuation', note: 'resume SSE liveness for continuation turn' },
    { slot: 'silenceTimerBySession', clearedBy: 'clearSilenceTimer', disposition: 're-init in continuation', note: 'new silence timer schedule per continuation turn' },
    { slot: 'turnFinalAtBySession', clearedBy: 'clearFinalizeSessionState', disposition: 're-init in continuation', note: 'new final candidate timestamp for continuation terminal phase' },
    { slot: 'turnFinalMsgIdBySession', clearedBy: 'clearFinalizeSessionState', disposition: 'different key', note: 'must point to continuation assistant id, never sealed final id' },
    { slot: 'finalizingMsgIdBySession', clearedBy: 'clearFinalizeSessionState', disposition: 'different key', note: 'must lock continuation assistant id only' },
    { slot: 'turnFinalResolvedBySession', clearedBy: 'clearFinalizeSessionState', disposition: 're-init in continuation', note: 'continuation final resolver must start unresolved' },
    { slot: 'turnFinalSourceBySession', clearedBy: 'clearFinalizeSessionState', disposition: 're-init in continuation', note: 'rebound to continuation final source' },
    { slot: 'turnSettleAttemptsBySession', clearedBy: 'clearFinalizeSessionState', disposition: 're-init in continuation', note: 'fresh settle loop counters' },
    { slot: 'turnSettleLastLenBySession', clearedBy: 'clearFinalizeSessionState', disposition: 're-init in continuation', note: 'fresh settle baseline' },
    { slot: 'turnSettleStableCountBySession', clearedBy: 'clearFinalizeSessionState', disposition: 're-init in continuation', note: 'fresh settle stability counter' },
    { slot: 'turnSettleLastFingerprintBySession', clearedBy: 'clearFinalizeSessionState', disposition: 're-init in continuation', note: 'fresh settle fingerprint tracking' },
    { slot: 'turnSettleNoDeltaCountBySession', clearedBy: 'clearFinalizeSessionState', disposition: 're-init in continuation', note: 'fresh no-delta settle counter' },
    { slot: 'lockedFinalSettleAttemptsBySession', clearedBy: 'clearFinalizeSessionState', disposition: 're-init in continuation', note: 'locked settle attempts restart per continuation' },
    { slot: 'turnRescueTimerBySession', clearedBy: 'clearFinalizeSessionState', disposition: 're-init in continuation', note: 'fresh rescue watchdog lifecycle' },
    { slot: 'turnRescueRunIdBySession', clearedBy: 'clearFinalizeSessionState', disposition: 're-init in continuation', note: 'fresh rescue run ids' },
    { slot: 'turnSseDrainTimerBySession', clearedBy: 'clearFinalizeSessionState', disposition: 're-init in continuation', note: 'fresh SSE drain timer for continuation settle' },
    { slot: 'turnRecoveryModeBySession', clearedBy: 'clearFinalizeSessionState', disposition: 're-init in continuation', note: 'continuation starts in explicit recovery mode' },
    { slot: 'turnResyncEpochBySession', clearedBy: 'clearFinalizeSessionState', disposition: 're-init in continuation', note: 'resync epoch restarts for continuation flow' },
    { slot: 'finishedTurnAtBySession', clearedBy: 'finishTurn', disposition: 'different key', note: 'sealed timestamp remains chain metadata; continuation timing is separate' },
    { slot: 'turnFinishedBySession', clearedBy: 'finishTurn', disposition: 'different key', note: 'sealed-turn marker remains conceptually sealed; continuation has independent active state' },
];

export type PermissionOverlayPayload = {
    sessionId: string;
    permissionId: string;
    requestId?: string;
    permission: string;
    patterns: string[];
    metadata?: any;
    toolCallId?: string;
};

export type SessionMessageDetail = {
    info?: any;
    parts?: any[];
};

export type AuthoritativeDiffFileSetResult = {
    files: string[];
    queriedIds: string[];
    missingIds: string[];
    source: 'message-summary-diffs';
};

export type CommitPendingTurnChangesResult = {
    status: 'committed' | 'noop' | 'skipped' | 'failed';
    msgToBaseCommit?: string;
    msgToCommit?: string;
    reason?: string;
    touchedFiles?: string[];
};

export type CommitPendingTurnChangesOptions = {
    authoritativeFiles?: string[];
};

export type ChatEvent = {
    type: 'text' | 'session' | 'raw' | 'permission' | 'diff' | 'message' | 'appendUserMessage' | 'error' | 'tool' | 'toolPatch' | 'files' | 'assistantMessageMeta' | 'assistantPhase' | 'questionOverlay' | 'permissionRequest' | 'permissionReplied' | 'autoResumeStallWarn' | 'autoResumeStallClear' | 'autoResumeHardStop' | 'todoUpdate' | 'sessionUsage' | 'turnInFlight' | 'turnResolved' | 'backgroundActivityPulse';
    text?: string;
    sessionId?: string;
    parentSessionId?: string;
    agentSessionId?: string;
    displayTarget?: 'parent' | 'agent-lane';
    files?: FileSnapshot[];
    messageId?: string;
    messageIndex?: number;
    timeCreated?: number;
    completedAt?: number;
    lastText?: string;
    assistantMsgId?: string;
    rootUserMsgId?: string;
    appendUserMsgId?: string;
    clientMessageId?: string;
    parentId?: string;
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
    inFlight?: boolean;
    ownerMsgId?: string;
    finalizeReason?: string;
    isStatusUpdate?: boolean;
    todos?: Array<{content: string; status: string; priority: string}>;
    tool?: string;
    toolState?: { status?: string; input?: any; output?: any };
    mode?: string;
    agent?: string;
    modelID?: string;
    providerID?: string;
    isDone?: boolean;
    usage?: { used: number; size: number; amount: number };
    phase?: 'assistant_progress' | 'assistant_final_candidate' | 'assistant_final_accepted';
    lane?: EventLane;
    source?: EventSource;
    continuationMeta?: ContinuationMessageMetadata;
    appendFollowup?: AppendFollowupIdentity;
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

export type ChatFilePart = string | {
    path?: string;
    url: string;
    mime: string;
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
    noCommitTerminalTmpKey?: string;
    assistantMsgId?: string;
    exportInFlight: boolean;
    exportResolved: boolean;
    resolvedUserMsgId?: string;
    lastResolvedAssistantMsgId?: string;
    turnMessageIds?: Set<string>;
    assistantMessageIds?: Set<string>;
    continuationMeta?: ContinuationMessageMetadata;
    continuationState?: ContinuationLifecycleState;
    appendFollowupHandoff?: AppendFollowupHandoff;
};

type AppendFollowupHandoff = {
    phase: 'tool-calls-complete' | 'followup-active';
    predecessorAssistantMsgId: string;
    appendUserMsgId?: string;
    followupAssistantMsgId?: string;
    generation?: number;
    followupFinishedWithToolCalls?: boolean;
};

type PostFinalWatchState = {
    ownerMsgId: string;
    turnKey: string;
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

type PendingMainFinalGate = {
    messageId: string;
    messageIndex: number;
    parentId?: string;
    completedAt?: number;
    finish?: string;
    source: EventSource;
    createdAt: number;
};

type AppendPendingPrompt = {
    clientMessageId: string;
    text: string;
    serverMsgId?: string;
};

type AppendTurnState = {
    rootUserMsgId: string;
    pending: AppendPendingPrompt[];
    appendUserMsgIds: Set<string>;
    emittedAppendUserMsgIds: Set<string>;
    nextSuccessorGeneration?: number;
    activeSuccessor?: AppendFollowupIdentity;
};

export type AppendFollowupIdentity = {
    kind: 'append-followup';
    mode: 'same-turn-handoff' | 'post-final';
    sessionId: string;
    appendUserMsgId: string;
    predecessorAssistantMsgId: string;
    assistantMsgId: string;
    generation: number;
};

export type BeginAppendPromptResult = {
    sessionId: string;
    rootUserMsgId: string;
    clientMessageId: string;
};

const COPILOT_MODEL_MULTIPLIERS_DOC_URL = 'https://docs.github.com/en/copilot/reference/ai-models/supported-models';
const COPILOT_SPEED_MULTIPLIER_CACHE_KEY = 'opencode.copilotSpeedMultiplierCache.v1';
const COPILOT_SPEED_MULTIPLIER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export class OpenCodeClient {
    private readonly modelQuotaService: ModelQuotaService;
    private readonly commandResolver: OpenCodeCommandResolver;
    private readonly processRunner: OpenCodeProcessRunner;
    private readonly httpClient: OpenCodeHttpClient;
    private readonly serverLocks: OpenCodeServerLockStore;
    private readonly eventStream: OpenCodeEventStream;
    private readonly serverProcessManager: OpenCodeServerProcess;
    private readonly serverController: OpenCodeServerController;
    public static outputChannel = vscode.window.createOutputChannel("OpenCode CLI");
    private workspaceRoot: string;
    private storage?: vscode.Memento;
    private readonly eventListeners = new Set<(event: ChatEvent) => void>();
    private currentSessionId?: string;
    private messageIndexById = new Map<string, number>();
    private messageOrder: string[] = [];
    private messageIndexByIdBySession = new Map<string, Map<string, number>>();
    private messageOrderBySession = new Map<string, string[]>();
    private messageIdAliasBySession = new Map<string, Map<string, string>>();
    private nextMessageIndex = 0;
    private internalMessageSeq = 0;
    private seqCounter = 0;
    private readonly revertedSegmentBySession = new Map<string, RevertedSegment>();
    private uiDebugChannel?: vscode.OutputChannel;
    private turnStateBySession = new Map<string, TurnState>();
    private pendingTurnChangesBySession = new PendingTurnChangeStore();
    private turnWriteStateBySession = new Map<string, { turnKey: string; hasWrites: boolean }>();
    private gitUndo?: GitUndoEngine;
    private gitUndoAvailable = false;
    private sessionUndoEnabled = new Map<string, boolean>();
    private assistantTextLengths = new Map<string, number>();
    private assistantTextLengthsByPart = new Map<string, number>();
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
    private hiddenControlUserMsgIdsBySession = new Map<string, Set<string>>();
    private hiddenControlAssistantMsgIdsBySession = new Map<string, Set<string>>();
    private pendingStopContinuationUserBySession = new Map<string, number>();
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
    private readonly continuationChainsBySession = new Map<string, ContinuationChainRuntime>();
    private continuationChainSeq = 0;
    private readonly lateContinuationGuardWindowMs = CONTINUATION_TURN_INVARIANTS.reviveTtlMs;
    private readonly sessionIdleReceivedBySession = new Set<string>();
    private turnFinalWaitersBySession = new Map<string, Array<() => void>>();
    private turnFinalResolvedBySession = new Set<string>();
    private turnFinalSourceBySession = new Map<string, EventSource>();
    private appendTurnStateBySession = new Map<string, AppendTurnState>();
    private turnFinishedBySession = new Set<string>();
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
    private lockedFinalSettleAttemptsBySession = new Map<string, number>();
    private rescueResumeAtBySession = new Map<string, number>();
    private turnRecoveryModeBySession = new Map<string, 'sse' | 'resync'>();
    private falsePositiveResetCountBySession = new Map<string, number>();
    private watchdogDrainDelayTimerBySession = new Map<string, NodeJS.Timeout>();
    private turnResyncEpochBySession = new Map<string, number>();
    private authoritativeIdleResyncBySession = new Set<string>();
    private toolRunningByMessageId = new Map<string, number>();
    private toolStatusBySession = new Map<string, Map<string, string>>();
    private copilotSpeedMultiplierCache?: CopilotSpeedMultiplierCache;
    private copilotSpeedMultiplierRefreshInFlight?: Promise<CopilotSpeedMultiplierCache>;
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
    private stablePulseRootSessionBySubagent = new Map<string, string>();
    private lateDiffGraceBySession = new Map<string, { expiresAt: number; timer?: ReturnType<typeof setTimeout> }>();
    private changeListEmittedBySession = new Map<string, boolean>();
    private lastTurnCommitBaseBySession = new Map<string, string>();
    private postFinalWatchStateBySession = new Map<string, PostFinalWatchState>();
    private continuationPersistBySession = new Map<string, Promise<void>>();
    private disposePromise?: Promise<void>;
    private readonly resyncCooldownMs = 5000;
    private readonly silenceWindowMs = 1800;
    private readonly finalQuietWindowMs = 300;
    private readonly finalBackfillDeltaMs = 500;
    private readonly lateDiffGraceMs = 500;
    private readonly rescueStartDelayMs = 20000;
    private readonly resyncLoopDelayMs = 20000;
    private readonly sseDrainQuietMs = 800;
    private readonly sseDrainPass2DelayMs = 1000;
    private readonly settleNoDeltaThreshold = 3;
    private readonly lockedFinalSettleMaxAttempts = 3;
    private readonly watchdogDrainDelayMs = 10000;
    private readonly autoResumePrompt = '[OC_UI_AUTORESUME v1]\nRe-read the last user request and finish the remaining steps.';
    private readonly stopContinuationPrompt = '/stop-continuation';
    private readonly maxContinuationCountPerOriginalTurn = CONTINUATION_TURN_INVARIANTS.maxContinuationsPerOriginalTurn;
    private readonly continuationBootstrapBufferWindowMs = CONTINUATION_TURN_INVARIANTS.reviveBootstrapBufferWindowMs;
    private readonly continuationOrphanCleanupTimeoutMs = CONTINUATION_TURN_INVARIANTS.orphanCleanupTimeoutMs;
    private readonly autoResumeEpochThreshold = 5;
    private readonly autoResumeStallMs = 100000;
    private readonly autoResumeWarnMs = 180000;
    private readonly toolRunningAutoResumeMs = 180000;
    private readonly assistantTextCacheMax = 4000;
    private serverStatus: ServerStatus = 'connected';
    private serverStatusHandler?: (status: ServerStatus, reason?: string) => void;
    private eventStreamFailureInFlight = false;
    private lastRestartAt = 0;
    private restartWindowStart = 0;
    private restartAttemptCount = 0;
    private readonly restartCooldownMs = 60000;
    private readonly maxRestartsPerWindow = 3;
    private readonly turnAnchorOverrideWindowMs = 120000;
    private readonly groupedResyncActivityEnabled = false;
    private readonly replayMirroredChangeIdsBySession = new Map<string, Set<string>>();

    public resetSessionState(options?: { preserveInFlightSessionIds?: ReadonlySet<string> }): void {
        const preserveInFlightSessionIds = options?.preserveInFlightSessionIds;
        const retainedTurnStateBySession = new Map<string, TurnState>();
        const retainedPendingTurnChangesBySession = new Map<string, PendingTurnChanges>();
        const retainedTurnWriteStateBySession = new Map<string, { turnKey: string; hasWrites: boolean }>();
        const retainedMessageIdAliasBySession = new Map<string, Map<string, string>>();
        const retainedAssistantMessageIds = new Set<string>();
        const retainedAssistantTextLengths = new Map<string, number>();
        const retainedAssistantTextLengthsByPart = new Map<string, number>();
        const retainedAssistantTextById = new Map<string, string>();
        const retainedAssistantHasDelta = new Set<string>();
        const retainedAssistantStatusCleared = new Set<string>();
        const retainedTurnStartedAtBySession = new Map<string, number>();
        if (preserveInFlightSessionIds?.size) {
            for (const sessionId of preserveInFlightSessionIds) {
                if (typeof sessionId !== 'string' || !sessionId) continue;
                const turnState = this.turnStateBySession.get(sessionId);
                if (turnState) {
                    retainedTurnStateBySession.set(sessionId, {
                        ...turnState,
                        turnMessageIds: turnState.turnMessageIds ? new Set(turnState.turnMessageIds) : undefined,
                        assistantMessageIds: turnState.assistantMessageIds ? new Set(turnState.assistantMessageIds) : undefined,
                    });
                }
                const assistantMessageIds = [
                    turnState?.assistantMsgId,
                    turnState?.lastResolvedAssistantMsgId,
                    this.currentTurnAssistantMsgIdBySession.get(sessionId),
                    this.pendingAssistantMsgIdBySession.get(sessionId),
                    this.finalizingMsgIdBySession.get(sessionId),
                    this.turnFinalMsgIdBySession.get(sessionId),
                ];
                for (const messageId of assistantMessageIds) {
                    if (typeof messageId === 'string' && messageId) {
                        retainedAssistantMessageIds.add(messageId);
                    }
                }
                const pendingChanges = this.pendingTurnChangesBySession.get(sessionId);
                if (pendingChanges) {
                    retainedPendingTurnChangesBySession.set(sessionId, {
                        ...pendingChanges,
                        changes: [...pendingChanges.changes],
                    });
                }
                const writeState = this.turnWriteStateBySession.get(sessionId);
                if (writeState) {
                    retainedTurnWriteStateBySession.set(sessionId, { ...writeState });
                }
                const aliasMap = this.messageIdAliasBySession.get(sessionId);
                if (aliasMap) {
                    retainedMessageIdAliasBySession.set(sessionId, new Map(aliasMap));
                }
                const turnStartedAt = this.currentTurnStartedAtBySession.get(sessionId);
                if (typeof turnStartedAt === 'number' && Number.isFinite(turnStartedAt) && turnStartedAt > 0) {
                    retainedTurnStartedAtBySession.set(sessionId, turnStartedAt);
                }
            }
            for (const messageId of retainedAssistantMessageIds) {
                const textLength = this.assistantTextLengths.get(messageId);
                if (textLength !== undefined) retainedAssistantTextLengths.set(messageId, textLength);
                const text = this.assistantTextById.get(messageId);
                if (text !== undefined) retainedAssistantTextById.set(messageId, text);
                if (this.assistantHasDelta.has(messageId)) retainedAssistantHasDelta.add(messageId);
                if (this.assistantStatusCleared.has(messageId)) retainedAssistantStatusCleared.add(messageId);
            }
            for (const [partKey, textLength] of this.assistantTextLengthsByPart) {
                const separatorIndex = partKey.indexOf(':');
                const messageId = separatorIndex >= 0 ? partKey.slice(0, separatorIndex) : partKey;
                if (retainedAssistantMessageIds.has(messageId)) {
                    retainedAssistantTextLengthsByPart.set(partKey, textLength);
                }
            }
        }
        const subagentMapCount = this.subagentToParentSessionMap.size;
        const stablePulseRootCount = this.stablePulseRootSessionBySubagent.size;
        if (subagentMapCount > 0 || stablePulseRootCount > 0) {
            this.logUiDebug(`[EXT][SUBAGENT_ROUTE] phase=clear scope=global-reset parentSessionId=* agentSessionId=* displayTarget=parent reason=resetSessionState subagentMappings=${subagentMapCount} stablePulseRoots=${stablePulseRootCount}`);
        }
        this.currentSessionId = undefined;
        this.messageIndexById.clear();
        this.messageOrder = [];
        this.messageIndexByIdBySession.clear();
        this.messageOrderBySession.clear();
        this.messageIdAliasBySession.clear();
        this.nextMessageIndex = 0;
        this.internalMessageSeq = 0;
        this.seqCounter = 0;
        this.revertedSegmentBySession.clear();
        this.turnStateBySession.clear();
        this.pendingTurnChangesBySession.clear();
        this.turnWriteStateBySession.clear();
        this.sessionUndoEnabled.clear();
        this.assistantTextLengths.clear();
        this.assistantTextLengthsByPart.clear();
        this.assistantTextById.clear();
        this.assistantHasDelta.clear();
        this.assistantStatusCleared.clear();
        for (const [messageId, textLength] of retainedAssistantTextLengths) {
            this.assistantTextLengths.set(messageId, textLength);
        }
        for (const [partKey, textLength] of retainedAssistantTextLengthsByPart) {
            this.assistantTextLengthsByPart.set(partKey, textLength);
        }
        for (const [messageId, text] of retainedAssistantTextById) {
            this.assistantTextById.set(messageId, text);
        }
        for (const messageId of retainedAssistantHasDelta) {
            this.assistantHasDelta.add(messageId);
        }
        for (const messageId of retainedAssistantStatusCleared) {
            this.assistantStatusCleared.add(messageId);
        }
        this.messageRoleById.clear();
        this.lastCwdBySession.clear();
        this.canceledActiveTurnBySession.clear();
        this.activeTurnOpIdBySession.clear();
        this.pendingUserMsgIdBySession.clear();
        this.pendingAssistantMsgIdBySession.clear();
        this.currentTurnUserMsgIdBySession.clear();
        this.displayTurnUserMsgIdBySession.clear();
        this.hiddenControlUserMsgIdsBySession.clear();
        this.hiddenControlAssistantMsgIdsBySession.clear();
        this.pendingStopContinuationUserBySession.clear();
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
        if (this.appendTurnStateBySession.size) {
            this.logUiDebug(`[EXT][APPEND_RETAIN] preserved sessions=${this.appendTurnStateBySession.size} reason=resetSessionState`);
        }
        this.clearRescueTimers();
        this.clearResyncLoopTimers();
        this.clearSseDrainTimers();
        this.turnSseTextAtBySession.clear();
        this.turnSettleAttemptsBySession.clear();
        this.turnSettleLastLenBySession.clear();
        this.turnSettleStableCountBySession.clear();
        this.turnSettleLastFingerprintBySession.clear();
        this.turnSettleNoDeltaCountBySession.clear();
        this.lockedFinalSettleAttemptsBySession.clear();
        this.rescueResumeAtBySession.clear();
        this.turnRecoveryModeBySession.clear();
        this.turnResyncEpochBySession.clear();
        this.authoritativeIdleResyncBySession.clear();
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
        this.subagentToParentSessionMap.clear();
        this.stablePulseRootSessionBySubagent.clear();
        for (const entry of this.lateDiffGraceBySession.values()) {
            if (entry.timer) {
                clearTimeout(entry.timer);
            }
        }
        this.lateDiffGraceBySession.clear();
        this.changeListEmittedBySession.clear();
        this.postFinalWatchStateBySession.clear();
        this.replayMirroredChangeIdsBySession.clear();
        for (const timer of this.watchdogDrainDelayTimerBySession.values()) {
            clearTimeout(timer);
        }
        this.watchdogDrainDelayTimerBySession.clear();
        this.falsePositiveResetCountBySession.clear();
        this.lockedFinalSettleAttemptsBySession.clear();
        let retainedClientTurnBindingSessions = 0;
        for (const sessionId of preserveInFlightSessionIds || []) {
            if (typeof sessionId !== 'string' || !sessionId) continue;
            let restored = false;
            const turnState = retainedTurnStateBySession.get(sessionId);
            if (turnState) {
                this.turnStateBySession.set(sessionId, turnState);
                restored = true;
            }
            const pendingChanges = retainedPendingTurnChangesBySession.get(sessionId);
            if (pendingChanges) {
                this.pendingTurnChangesBySession.set(sessionId, pendingChanges);
                restored = true;
            }
            const writeState = retainedTurnWriteStateBySession.get(sessionId);
            if (writeState) {
                this.turnWriteStateBySession.set(sessionId, writeState);
                restored = true;
            }
            const aliasMap = retainedMessageIdAliasBySession.get(sessionId);
            if (aliasMap) {
                this.messageIdAliasBySession.set(sessionId, aliasMap);
                restored = true;
            }
            const turnStartedAt = retainedTurnStartedAtBySession.get(sessionId);
            if (turnStartedAt !== undefined) {
                this.currentTurnStartedAtBySession.set(sessionId, turnStartedAt);
                restored = true;
            }
            if (restored) retainedClientTurnBindingSessions += 1;
        }
        if (retainedClientTurnBindingSessions) {
            this.logUiDebug(`[EXT][APPEND_RETAIN] preserved clientTurnBinding sessions=${retainedClientTurnBindingSessions} reason=resetSessionState`);
        }
    }

    constructor() {
        this.modelQuotaService = new ModelQuotaService({ log: (message) => this.logUiDebug(message) });
        this.commandResolver = new OpenCodeCommandResolver((message) => OpenCodeClient.outputChannel.appendLine(message));
        this.processRunner = new OpenCodeProcessRunner({
            resolver: this.commandResolver,
            getCwd: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd(),
            log: (message) => OpenCodeClient.outputChannel.appendLine(message),
        });
        this.serverLocks = new OpenCodeServerLockStore({
            getWorkspaceRoot: () => this.workspaceRoot,
            log: (message) => this.logUiDebug(message),
        });
        this.serverProcessManager = new OpenCodeServerProcess();
        this.serverController = new OpenCodeServerController({
            locks: this.serverLocks,
            process: this.serverProcessManager,
            buildServeSpawn: (args) => this.buildServeSpawn(args),
            fetchHealth: (conn, timeoutMs) => this.serverFetch(
                '/global/health',
                { method: 'GET' },
                { opName: 'health', retry: false, timeoutMs, conn, skipReady: true },
            ),
            stopEventStream: () => this.eventStream?.stop(),
            log: (message) => this.logUiDebug(message),
            showError: (message) => { void vscode.window.showErrorMessage(message); },
        });
        this.httpClient = new OpenCodeHttpClient({
            waitUntilReady: () => this.serverController.waitUntilReady(),
            getConnection: (forceRefresh) => this.getServerConn(forceRefresh),
            migrateUnauthorized: (lock) => this.serverController.migratePort(lock, '401'),
            recoverTransport: () => this.ensureServer(),
            log: (message) => this.logUiDebug(message),
        });
        this.eventStream = new OpenCodeEventStream({
            open: (signal) => this.serverFetch('/event', { method: 'GET', signal }, { opName: 'event', retry: false, noTimeout: true }),
            onPayload: (payload) => this.handleServerEvent(payload),
            onOpen: () => {
                this.updateServerStatus('connected', 'event-stream-open');
            },
            onClosed: () => {
                this.logUiDebug('EXT: event.closed');
                this.triggerImmediateResyncForAwaitingFinals('event-stream-close');
            },
            onError: (failureCount) => {
                this.updateServerStatus('reconnecting', 'event-stream-error');
                this.logUiDebug(`EXT: event.fail | count=${failureCount}`);
                this.triggerImmediateResyncForAwaitingFinals('event-stream-error');
            },
            onRepeatedFailure: () => { void this.handleEventStreamFailure(); },
        });
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
        this.serverController.resetForWorkspaceChange();
    }

    public getServerPid(): number | undefined {
        return this.serverController.getPid();
    }


    public setStorage(storage: vscode.Memento): void {
        this.storage = storage;
    }

    public async ensureServer(): Promise<void> {
        await this.serverController.ensure(this.workspaceRoot);
        await this.serverController.waitUntilReady();
        if (!this.eventStream.isActive()) {
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

    private async delay(ms: number): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }

    public async waitForTurnAssistantMsgId(sessionId: string, pollEveryMs = 500): Promise<string> {
        const pollMs = Math.max(100, Number.isFinite(pollEveryMs) ? pollEveryMs : 500);
        while (true) {
            const assistantMsgId = this.getTurnAssistantMsgId(sessionId);
            if (typeof assistantMsgId === 'string' && assistantMsgId.startsWith('msg_')) {
                return assistantMsgId;
            }
            await this.delay(pollMs);
        }
    }

    public async waitForSessionIdleGate(
        sessionId: string,
        options?: { sseWaitMs?: number; pollEveryMs?: number; maxPolls?: number }
    ): Promise<boolean> {
        if (!sessionId) return false;
        const sseWaitMs = Math.max(0, options?.sseWaitMs ?? 2000);
        const pollEveryMs = Math.max(250, options?.pollEveryMs ?? 2000);
        const maxPolls = Math.max(1, options?.maxPolls ?? 3);

        if (this.sessionIdleReceivedBySession.has(sessionId)) {
            this.logUiDebug(`EXT: idle.gate.hit | sessionId=${sessionId} | source=sse-cached`);
            return true;
        }

        if (sseWaitMs > 0) {
            this.logUiDebug(`EXT: idle.gate.wait | sessionId=${sessionId} | stage=sse | waitMs=${sseWaitMs}`);
            await this.delay(sseWaitMs);
            if (this.sessionIdleReceivedBySession.has(sessionId)) {
                this.logUiDebug(`EXT: idle.gate.hit | sessionId=${sessionId} | source=sse-wait`);
                return true;
            }
        }

        for (let attempt = 1; attempt <= maxPolls; attempt++) {
            if (attempt > 1) {
                await this.delay(pollEveryMs);
            }
            try {
                const statusMap = await this.requestJson<Record<string, { type?: string }>>('GET', '/session/status');
                const status = statusMap?.[sessionId];
                const statusType = typeof status?.type === 'string' ? status.type : '';
                this.logUiDebug(`EXT: idle.gate.poll | sessionId=${sessionId} | attempt=${attempt}/${maxPolls} | status=${statusType || 'unknown'}`);
                if (statusType === 'idle') {
                    this.sessionIdleReceivedBySession.add(sessionId);
                    this.logUiDebug(`EXT: idle.gate.hit | sessionId=${sessionId} | source=poll`);
                    return true;
                }
            } catch (error) {
                this.logUiDebug(`EXT: idle.gate.poll.fail | sessionId=${sessionId} | attempt=${attempt}/${maxPolls} | err=${String(error)}`);
            }
        }

        this.logUiDebug(`EXT: idle.gate.timeout | sessionId=${sessionId} | sseWaitMs=${sseWaitMs} | pollEveryMs=${pollEveryMs} | maxPolls=${maxPolls}`);
        return false;
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
        this.lockedFinalSettleAttemptsBySession.delete(sessionId);
        this.rescueResumeAtBySession.delete(sessionId);
        this.expectedMainAgentBySession.delete(sessionId);
        this.sessionIdleReceivedBySession.delete(sessionId);
        this.turnRecoveryModeBySession.delete(sessionId);
        this.turnResyncEpochBySession.delete(sessionId);
        this.authoritativeIdleResyncBySession.delete(sessionId);
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
        const watchdogDelay = this.watchdogDrainDelayTimerBySession.get(sessionId);
        if (watchdogDelay) {
            clearTimeout(watchdogDelay);
            this.watchdogDrainDelayTimerBySession.delete(sessionId);
        }
        this.falsePositiveResetCountBySession.delete(sessionId);
        this.turnFinalWaitersBySession.delete(sessionId);
        this.stopRescueWatchdog(sessionId, reason);

        this.pendingQuestionCallIdsBySession.delete(sessionId);
        this.pendingPermissionIdsBySession.delete(sessionId);
        this.toolStatusBySession.delete(sessionId);
    }

    private isDelayedMainFinalMode(sessionId: string | undefined): boolean {
        if (!sessionId) return false;
        const mode = this.expectedMainAgentBySession.get(sessionId);
        return this.isDelayedMainFinalModeValue(mode);
    }

    private isDelayedMainFinalModeValue(mode: string | undefined): boolean {
        const normalized = (mode || '').toLowerCase();
        if (!normalized) return false;
        return normalized.includes('sisyphus') || normalized.includes('hephaestus') || normalized.includes('atlas') || normalized.includes('build');
    }

    private ensurePostFinalWatchState(sessionId: string, finishedMode?: string): void {
        if (!sessionId) return;
        const ownerMsgId = this.turnFinalMsgIdBySession.get(sessionId)
            || this.finalizingMsgIdBySession.get(sessionId)
            || this.currentTurnAssistantMsgIdBySession.get(sessionId)
            || this.turnStateBySession.get(sessionId)?.assistantMsgId;
        const existing = this.postFinalWatchStateBySession.get(sessionId);
        if (existing) {
            if (!existing.turnKey) {
                existing.turnKey = this.getTurnKeyForSession(sessionId) || sessionId;
            }
            if (ownerMsgId && existing.ownerMsgId !== ownerMsgId) {
                existing.ownerMsgId = ownerMsgId;
                existing.lastAssistantMsgId = ownerMsgId;
            }
            this.postFinalWatchStateBySession.set(sessionId, existing);
            return;
        }
        if (!this.isDelayedMainFinalModeValue(finishedMode)) return;
        if (!ownerMsgId) return;
        this.postFinalWatchStateBySession.set(sessionId, {
            ownerMsgId,
            turnKey: this.getTurnKeyForSession(sessionId) || sessionId,
            changes: [],
            lastAssistantMsgId: ownerMsgId,
        });
    }

    private appendPostFinalWatchChanges(sessionId: string, turnKey: string, assistantMsgId: string | undefined, changeSpecs: FileChangeSpec[]): boolean {
        if (!sessionId || !changeSpecs.length) return false;
        const existing = this.postFinalWatchStateBySession.get(sessionId);
        if (!existing) return false;
        existing.turnKey = existing.turnKey || turnKey || sessionId;
        if (assistantMsgId) {
            existing.lastAssistantMsgId = assistantMsgId;
        }
        existing.changes.push(...changeSpecs);
        this.postFinalWatchStateBySession.set(sessionId, existing);
        void this.persistContinuationState(sessionId, existing.ownerMsgId, 'watching', existing.changes);
        this.logUiDebug(`EXT: post-final.watch.append | sessionId=${sessionId} | ownerMsgId=${existing.ownerMsgId} | added=${changeSpecs.length} | total=${existing.changes.length}`);
        return true;
    }

    private preserveFailedContinuationPendingChanges(sessionId: string): void {
        if (!sessionId) return;
        const existing = this.postFinalWatchStateBySession.get(sessionId);
        if (!existing) return;
        const pending = this.pendingTurnChangesBySession.get(sessionId);
        if (pending?.changes?.length) {
            existing.changes.push(...pending.changes);
        }
        existing.lastAssistantMsgId = existing.ownerMsgId;
        existing.turnKey = existing.turnKey || this.getTurnKeyForSession(sessionId) || sessionId;
        this.postFinalWatchStateBySession.set(sessionId, existing);
        void this.persistContinuationState(sessionId, existing.ownerMsgId, 'retry-ready', existing.changes);
        this.logUiDebug(`EXT: continuation.revive.fail.preserve | sessionId=${sessionId} | ownerMsgId=${existing.ownerMsgId} | preserved=${pending?.changes?.length || 0} | total=${existing.changes.length}`);
    }

    private persistContinuationState(
        sessionId: string,
        ownerMsgId: string | undefined,
        lifecycleState: 'idle' | 'watching' | 'retry-ready',
        changes: FileChangeSpec[] = []
    ): Promise<void> {
        if (!sessionId || !ownerMsgId || !this.gitUndoAvailable || !this.gitUndo) {
            return Promise.resolve();
        }
        const watchedFiles = normalizeTouchedFiles(this.workspaceRoot, changes.flatMap((change) => {
            if (change.type === 'rename') {
                return [change.oldPath, change.newPath];
            }
            if ('path' in change) {
                return [change.path];
            }
            return [];
        }));
        const previous = this.continuationPersistBySession.get(sessionId) || Promise.resolve();
        const next = previous
            .catch(() => undefined)
            .then(async () => {
                const repo = await this.gitUndo!['repoManager'].resolveRepo(sessionId);
                const map = await this.gitUndo!['mapStore'].loadSessionMap(sessionId, repo.repoId);
                const updated = this.gitUndo!['mapStore'].upsertContinuationState(map, {
                    ownerMsgId,
                    lifecycleState,
                    watchedFiles,
                });
                await this.gitUndo!['mapStore'].saveSessionMap(sessionId, updated);
            })
            .finally(() => {
                if (this.continuationPersistBySession.get(sessionId) === next) {
                    this.continuationPersistBySession.delete(sessionId);
                }
            });
        this.continuationPersistBySession.set(sessionId, next);
        return next;
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

    private createContinuationChainId(sessionId: string): string {
        this.continuationChainSeq += 1;
        return `cont:${sessionId}:${Date.now()}:${this.continuationChainSeq}`;
    }

    private ensureSealedContinuationChain(sessionId: string, sealedAssistantMsgId: string): ContinuationChainRuntime {
        const existing = this.continuationChainsBySession.get(sessionId);
        if (existing && existing.state === 'bootstrap_buffering') {
            existing.state = 'continuation_active';
            existing.latestContinuationMeta = {
                continuationChainId: existing.continuationChainId,
                priorAssistantFinalMsgId: existing.priorAssistantFinalMsgId,
                continuationSequence: existing.continuationCount,
            };
            this.logUiDebug(`EXT: continuation.chain.activate | sessionId=${sessionId} | chainId=${existing.continuationChainId} | continuationMsgId=${sealedAssistantMsgId} | seq=${existing.continuationCount}`);
            return existing;
        }
        if (existing && existing.priorAssistantFinalMsgId === sealedAssistantMsgId) {
            existing.state = 'sealed';
            existing.sealedAt = Date.now();
            return existing;
        }
        const chain: ContinuationChainRuntime = {
            continuationChainId: this.createContinuationChainId(sessionId),
            priorAssistantFinalMsgId: sealedAssistantMsgId,
            sealedAt: Date.now(),
            state: 'sealed',
            continuationCount: 0,
            latestContinuationMeta: {
                continuationChainId: '',
                priorAssistantFinalMsgId: sealedAssistantMsgId,
                continuationSequence: 0,
            },
        };
        chain.latestContinuationMeta!.continuationChainId = chain.continuationChainId;
        this.continuationChainsBySession.set(sessionId, chain);
        this.logUiDebug(`EXT: continuation.chain.seed | sessionId=${sessionId} | chainId=${chain.continuationChainId} | priorAssistantFinalMsgId=${sealedAssistantMsgId} | max=${this.maxContinuationCountPerOriginalTurn} | bufferMs=${this.continuationBootstrapBufferWindowMs} | orphanTimeoutMs=${this.continuationOrphanCleanupTimeoutMs}`);
        return chain;
    }

    private invalidateContinuationChainForSubmittedPrompt(sessionId: string, trigger: string): void {
        const chain = this.continuationChainsBySession.get(sessionId);
        if (!chain) return;
        chain.state = 'invalidated';
        chain.invalidatedReason = 'submitted-prompt';
        chain.invalidatedAt = Date.now();
        this.logUiDebug(`EXT: continuation.revive.suppress | sessionId=${sessionId} | chainId=${chain.continuationChainId} | reason=submitted-prompt | note=${CONTINUATION_TURN_INVARIANTS.suppressionRule} | trigger=${trigger}`);
    }

    private shouldDropLateContinuationByExhaustedPolicy(sessionId: string): boolean {
        const chain = this.continuationChainsBySession.get(sessionId);
        if (!chain) return false;
        const exhausted = chain.continuationCount >= this.maxContinuationCountPerOriginalTurn;
        if (exhausted) {
            chain.state = 'exhausted';
            chain.invalidatedReason = 'max-continuations-exhausted';
            this.logUiDebug(`EXT: continuation.revive.drop | sessionId=${sessionId} | chainId=${chain.continuationChainId} | reason=exhausted | policy=${CONTINUATION_TURN_INVARIANTS.exhaustedPolicy} | max=${this.maxContinuationCountPerOriginalTurn}`);
        }
        return exhausted;
    }

    /**
     * Detects the background completion control signal `[ALL BACKGROUND TASKS COMPLETE]`.
     * Used as an invisible revive gate — must never appear in visible timeline content.
     */
    public isBackgroundCompletionSignal(text: unknown): boolean {
        if (typeof text !== 'string') return false;
        const normalized = text.trim();
        if (normalized === '[ALL BACKGROUND TASKS COMPLETE]') return true;
        return normalized.includes('[ALL BACKGROUND TASKS COMPLETE]')
            && normalized.includes('<system-reminder>');
    }

    /**
     * Transitions a sealed continuation chain to `revive_armed`.
     * Only transitions from `sealed` state — invalidated, exhausted, or
     * any other state is left unchanged.
     */
    public handleReviveGate(sessionId: string): boolean {
        if (!sessionId) return false;
        const chain = this.continuationChainsBySession.get(sessionId);
        if (!chain) return false;
        if (chain.state !== 'sealed') {
            this.logUiDebug(`EXT: continuation.revive.gate.skip | sessionId=${sessionId} | chainId=${chain.continuationChainId} | state=${chain.state} | reason=not-sealed`);
            return false;
        }
        chain.state = 'revive_armed';
        this.logUiDebug(`EXT: continuation.revive.gate | sessionId=${sessionId} | chainId=${chain.continuationChainId} | state=revive_armed`);
        return true;
    }

    /**
     * Bootstraps a new continuation turn by re-initializing turn state
     * WITHOUT invalidating the continuation chain. This re-enters the
     * normal assistant pipeline so that msg B gets explicit IDs via
     * recordAssistantMsgId / markTurnFinal / finishTurn.
     *
     * Transitions: `revive_armed` → `bootstrap_buffering`
     *
     * Key differences from `startTurn`:
     * - Does NOT call `invalidateContinuationChainForSubmittedPrompt`
     * - Does NOT clear post-final watch state
     * - Increments `continuationCount` on the chain
     */
    public bootstrapContinuationTurn(sessionId: string): boolean {
        if (!sessionId) return false;
        const chain = this.continuationChainsBySession.get(sessionId);
        if (!chain || chain.state !== 'revive_armed') {
            this.logUiDebug(`EXT: continuation.bootstrap.skip | sessionId=${sessionId} | reason=not-revive-armed`);
            return false;
        }

        chain.state = 'bootstrap_buffering';
        chain.continuationCount += 1;

        const continuationUserKey = `cont:${sessionId}:${chain.continuationCount}:${Date.now()}`;

        this.changeListEmittedBySession.delete(sessionId);
        this.canceledActiveTurnBySession.set(sessionId, false);
        this.turnFinishedBySession.delete(sessionId);
        this.finishedMainAgentBySession.delete(sessionId);
        this.finishedTurnAtBySession.delete(sessionId);
        this.currentTurnUserMsgIdBySession.delete(sessionId);
        this.displayTurnUserMsgIdBySession.delete(sessionId);
        this.appendTurnStateBySession.delete(sessionId);
        this.hiddenControlUserMsgIdsBySession.delete(sessionId);
        this.hiddenControlAssistantMsgIdsBySession.delete(sessionId);
        this.currentTurnAssistantMsgIdBySession.delete(sessionId);
        this.pendingStopContinuationUserBySession.delete(sessionId);
        this.activeTurnOpIdBySession.delete(sessionId);
        this.pendingUserMsgIdBySession.delete(sessionId);
        this.pendingAssistantMsgIdBySession.delete(sessionId);

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

        this.pendingTurnChangesBySession.delete(sessionId);
        this.turnStateBySession.set(sessionId, {
            pendingUserLocalKey: continuationUserKey,
            pendingAssistantTmpKey: undefined,
            assistantMsgId: undefined,
            exportInFlight: false,
            exportResolved: false,
            resolvedUserMsgId: undefined,
            lastResolvedAssistantMsgId: undefined,
            turnMessageIds: new Set()
        });
        this.turnWriteStateBySession.set(sessionId, { turnKey: continuationUserKey, hasWrites: false });

        this.scheduleSilenceResync(sessionId);

        this.logUiDebug(`EXT: continuation.bootstrap | sessionId=${sessionId} | chainId=${chain.continuationChainId} | continuationCount=${chain.continuationCount} | continuationUserKey=${continuationUserKey}`);
        return true;
    }

    /**
     * Handles a failed continuation revive attempt by resetting the chain
     * back to `sealed` state. This preserves the post-final watch state
     * under the original owner, allowing another revive attempt.
     */
    public handleFailedContinuationRevive(sessionId: string): void {
        if (!sessionId) return;
        const chain = this.continuationChainsBySession.get(sessionId);
        if (!chain) return;
        if (chain.state !== 'bootstrap_buffering' && chain.state !== 'revive_armed' && chain.state !== 'continuation_active' && chain.state !== 'orphaned') {
            this.logUiDebug(`EXT: continuation.revive.fail.skip | sessionId=${sessionId} | chainId=${chain.continuationChainId} | state=${chain.state} | reason=unexpected-state`);
            return;
        }

        this.preserveFailedContinuationPendingChanges(sessionId);
        chain.state = 'sealed';
        chain.sealedAt = Date.now();

        this.turnStateBySession.delete(sessionId);
        this.pendingTurnChangesBySession.delete(sessionId);
        this.turnWriteStateBySession.delete(sessionId);
        this.activeTurnOpIdBySession.delete(sessionId);
        this.canceledActiveTurnBySession.delete(sessionId);
        this.pendingUserMsgIdBySession.delete(sessionId);
        this.pendingAssistantMsgIdBySession.delete(sessionId);
        this.currentTurnUserMsgIdBySession.delete(sessionId);
        this.displayTurnUserMsgIdBySession.delete(sessionId);
        this.appendTurnStateBySession.delete(sessionId);
        this.hiddenControlUserMsgIdsBySession.delete(sessionId);
        this.hiddenControlAssistantMsgIdsBySession.delete(sessionId);
        this.pendingStopContinuationUserBySession.delete(sessionId);
        this.currentTurnAssistantMsgIdBySession.delete(sessionId);
        this.currentTurnStartedAtBySession.delete(sessionId);
        this.lastSseAtBySession.delete(sessionId);
        this.turnFinishedBySession.delete(sessionId);
        this.clearSilenceTimer(sessionId);
        this.clearFinalizeSessionState(sessionId, 'turn-finish');

        this.logUiDebug(`EXT: continuation.revive.fail | sessionId=${sessionId} | chainId=${chain.continuationChainId} | continuationCount=${chain.continuationCount} | state=sealed (retry-ready)`);
    }

    private async fetchTextFromUrl(url: string, redirectCount = 0): Promise<string> {
        return new Promise((resolve, reject) => {
            const request = https.get(url, {
                headers: {
                    'User-Agent': 'OpenCodeGUI/1.0',
                    Accept: 'text/html,application/xhtml+xml',
                    'Accept-Encoding': 'identity'
                }
            }, (response) => {
                const statusCode = response.statusCode || 0;
                const location = response.headers.location;

                if (statusCode >= 300 && statusCode < 400 && location) {
                    response.resume();
                    if (redirectCount >= 5) {
                        reject(new Error(`Too many redirects while fetching ${url}`));
                        return;
                    }
                    const redirectUrl = new URL(location, url).toString();
                    void this.fetchTextFromUrl(redirectUrl, redirectCount + 1).then(resolve, reject);
                    return;
                }

                if (statusCode < 200 || statusCode >= 300) {
                    const chunks: Buffer[] = [];
                    response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
                    response.on('end', () => {
                        const body = Buffer.concat(chunks).toString('utf8');
                        reject(new Error(`Failed to fetch ${url}: ${statusCode} ${body.slice(0, 200)}`));
                    });
                    response.resume();
                    return;
                }

                const chunks: Buffer[] = [];
                response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
                response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            });

            request.setTimeout(8000, () => {
                request.destroy(new Error(`Timeout fetching ${url}`));
            });
            request.on('error', reject);
        });
    }

    private readStoredCopilotSpeedMultiplierCache(): CopilotSpeedMultiplierCache | undefined {
        const storageValue = this.storage?.get<CopilotSpeedMultiplierCache>(COPILOT_SPEED_MULTIPLIER_CACHE_KEY);
        if (!storageValue || typeof storageValue !== 'object') return undefined;
        const fetchedAt = Number(storageValue.fetchedAt);
        const multipliers = storageValue.multipliers;
        if (!Number.isFinite(fetchedAt) || !multipliers || typeof multipliers !== 'object') {
            return undefined;
        }
        return {
            fetchedAt,
            multipliers: Object.fromEntries(
                Object.entries(multipliers).filter(([, value]) => typeof value === 'string' && value.length > 0)
            )
        };
    }

    private async storeCopilotSpeedMultiplierCache(cache: CopilotSpeedMultiplierCache): Promise<void> {
        this.copilotSpeedMultiplierCache = cache;
        if (!this.storage) return;
        try {
            await this.storage.update(COPILOT_SPEED_MULTIPLIER_CACHE_KEY, cache);
        } catch (error) {
            this.logUiDebug(`EXT: copilot.speed.cache.store.fail | err=${String(error)}`);
        }
    }

    private async fetchCopilotSpeedMultipliers(): Promise<CopilotSpeedMultiplierCache> {
        const html = await this.fetchTextFromUrl(COPILOT_MODEL_MULTIPLIERS_DOC_URL);
        const parsed = parseCopilotMultiplierHtml(html);
        if (!parsed.size) {
            throw new Error('No copilot speed multipliers parsed from docs page.');
        }
        return {
            fetchedAt: Date.now(),
            multipliers: Object.fromEntries(parsed.entries())
        };
    }

    private async getCopilotSpeedMultiplierCache(): Promise<CopilotSpeedMultiplierCache> {
        const now = Date.now();
        const memoryCache = this.copilotSpeedMultiplierCache;
        const storedCache = this.readStoredCopilotSpeedMultiplierCache();
        const cache = [memoryCache, storedCache]
            .filter((entry): entry is CopilotSpeedMultiplierCache => Boolean(entry))
            .sort((a, b) => b.fetchedAt - a.fetchedAt)[0];

        if (cache) {
            this.copilotSpeedMultiplierCache = cache;
            if (now - cache.fetchedAt < COPILOT_SPEED_MULTIPLIER_CACHE_TTL_MS) {
                return cache;
            }

            void this.refreshCopilotSpeedMultiplierCache();
            return cache;
        }

        if (!this.copilotSpeedMultiplierRefreshInFlight) {
            void this.refreshCopilotSpeedMultiplierCache();
        }

        return this.copilotSpeedMultiplierRefreshInFlight || {
            fetchedAt: now,
            multipliers: Object.fromEntries(getLocalCopilotSpeedMultiplierMap().entries())
        };
    }

    private async refreshCopilotSpeedMultiplierCache(): Promise<CopilotSpeedMultiplierCache> {
        if (this.copilotSpeedMultiplierRefreshInFlight) {
            return this.copilotSpeedMultiplierRefreshInFlight;
        }

        this.copilotSpeedMultiplierRefreshInFlight = this.fetchCopilotSpeedMultipliers()
            .then(async (fresh) => {
                await this.storeCopilotSpeedMultiplierCache(fresh);
                return fresh;
            })
            .catch((error) => {
                this.logUiDebug(`EXT: copilot.speed.fetch.fail | err=${String(error)}`);
                return this.copilotSpeedMultiplierCache || {
                    fetchedAt: Date.now(),
                    multipliers: Object.fromEntries(getLocalCopilotSpeedMultiplierMap().entries())
                };
            })
            .finally(() => {
                this.copilotSpeedMultiplierRefreshInFlight = undefined;
            });

        return this.copilotSpeedMultiplierRefreshInFlight;
    }

    private isOpenCodeFreeModel(model: ModelInfo | undefined): boolean {
        if (!model) return false;
        const provider = String(model.providerId || '').toLowerCase();
        const fullId = String(model.fullId || '').toLowerCase();
        const name = String(model.name || '').toLowerCase();
        const id = String(model.id || '').toLowerCase();
        const isOpenCode = provider === 'opencode' || fullId.startsWith('opencode/');
        const hasFree = name.includes('free') || fullId.includes('free') || id.includes('free');
        return isOpenCode && hasFree;
    }

    private isCopilotFreeModel(model: ModelInfo | undefined): boolean {
        if (!model) return false;
        const speed = typeof model.speedMultiplier === 'string'
            ? model.speedMultiplier.trim().toLowerCase()
            : '';
        if (speed !== '0x') return false;
        return isCopilotProviderId(model.providerId, model.fullId);
    }

    private async pickStopContinuationFreeModel(): Promise<ModelInfo | null> {
        try {
            const models = await this.listModels();
            return this.pickFreeModel(models) ?? null;
        } catch (error) {
            this.logUiDebug(`EXT: continuation.stop.model.fail | err=${String(error)}`);
            return null;
        }
    }

    public pickFreeModel(models: ModelInfo[], preferredFullId?: string): ModelInfo | undefined {
        if (!Array.isArray(models) || !models.length) return undefined;
        if (preferredFullId) {
            const preferred = models.find((model) => model?.fullId === preferredFullId);
            if (preferred && (this.isOpenCodeFreeModel(preferred) || this.isCopilotFreeModel(preferred))) {
                return preferred;
            }
        }
        const opencodeFree = models.find((model) => this.isOpenCodeFreeModel(model));
        if (opencodeFree) return opencodeFree;
        const copilotFree = models.find((model) => this.isCopilotFreeModel(model));
        if (copilotFree) return copilotFree;
        return undefined;
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
            const freeModel = await this.pickStopContinuationFreeModel();
            if (freeModel) {
                const modelRef = this.parseModelRef(freeModel.fullId);
                if (modelRef) {
                    payload.model = modelRef;
                }
            }
            await this.requestJson('POST', `/session/${sessionId}/prompt_async`, payload);
            this.pendingStopContinuationUserBySession.set(sessionId, Date.now());
            this.logUiDebug(
                `EXT: continuation.stop.sent | sessionId=${sessionId} | agent=${agentMode} | model=${payload.model ? (freeModel?.fullId || 'custom') : 'default'}`
            );
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
        this.invalidateContinuationChainForSubmittedPrompt(sessionId, 'start-turn');
        this.changeListEmittedBySession.delete(sessionId);
        this.canceledActiveTurnBySession.set(sessionId, false);
        this.turnFinishedBySession.delete(sessionId);
        this.finishedMainAgentBySession.delete(sessionId);
        this.finishedTurnAtBySession.delete(sessionId);
        this.currentTurnUserMsgIdBySession.delete(sessionId);
        this.displayTurnUserMsgIdBySession.delete(sessionId);
        this.appendTurnStateBySession.delete(sessionId);
        this.hiddenControlUserMsgIdsBySession.delete(sessionId);
        this.hiddenControlAssistantMsgIdsBySession.delete(sessionId);
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
        const appendState = this.appendTurnStateBySession.get(sessionId);
        if (appendState) appendState.activeSuccessor = undefined;
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

    public wasTurnFinishedRecently(sessionId: string, windowMs: number): boolean {
        if (!sessionId || !Number.isFinite(windowMs) || windowMs <= 0) return false;
        const finishedAt = this.finishedTurnAtBySession.get(sessionId);
        if (!finishedAt) return false;
        return (Date.now() - finishedAt) <= windowMs;
    }

    public finishTurn(sessionId: string): void {
        if (!sessionId) return;

        const chain = this.continuationChainsBySession.get(sessionId);
        const isContinuationActive = chain && (chain.state === 'continuation_active' || chain.state === 'bootstrap_buffering' || chain.state === 'revive_armed');
        const hasAcceptedFinal = this.turnFinalMsgIdBySession.has(sessionId) || this.finalizingMsgIdBySession.has(sessionId);
        const isCanceled = this.canceledActiveTurnBySession.get(sessionId) === true;

        if (isContinuationActive && (!hasAcceptedFinal || isCanceled)) {
            this.handleFailedContinuationRevive(sessionId);
            return;
        }

        this.turnFinishedBySession.add(sessionId);
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
        this.ensurePostFinalWatchState(sessionId, finishedMode);
        const postFinal = this.postFinalWatchStateBySession.get(sessionId);
        if (postFinal) {
            void this.persistContinuationState(sessionId, postFinal.ownerMsgId, 'watching', postFinal.changes);
        }
        this.beginLateDiffGrace(sessionId);
        const appendState = this.appendTurnStateBySession.get(sessionId);
        if (appendState?.activeSuccessor?.mode === 'same-turn-handoff') appendState.activeSuccessor = undefined;
        this.turnStateBySession.delete(sessionId);
        this.pendingTurnChangesBySession.delete(sessionId);
        this.turnWriteStateBySession.delete(sessionId);
        this.activeTurnOpIdBySession.delete(sessionId);
        this.canceledActiveTurnBySession.delete(sessionId);
        this.pendingUserMsgIdBySession.delete(sessionId);
        this.pendingAssistantMsgIdBySession.delete(sessionId);
        this.currentTurnUserMsgIdBySession.delete(sessionId);
        this.displayTurnUserMsgIdBySession.delete(sessionId);
        if (this.appendTurnStateBySession.has(sessionId)) {
            this.logUiDebug(`[EXT][APPEND_RETAIN] preserved sessionId=${sessionId} reason=finishTurn`);
        }
        this.hiddenControlUserMsgIdsBySession.delete(sessionId);
        this.hiddenControlAssistantMsgIdsBySession.delete(sessionId);
        this.pendingStopContinuationUserBySession.delete(sessionId);
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
        if (pending?.changes?.length) return true;
        const postFinal = this.postFinalWatchStateBySession.get(sessionId);
        return Boolean(postFinal?.changes?.length);
    }

    public getPostFinalWatchOverlay(sessionId: string): { ownerMsgId?: string; files: string[]; statsByPath: Record<string, { additions: number | null; deletions: number | null }> } {
        if (!sessionId) {
            return { files: [], statsByPath: {} };
        }
        const postFinal = this.postFinalWatchStateBySession.get(sessionId);
        if (!postFinal?.changes?.length) {
            return { ownerMsgId: postFinal?.ownerMsgId, files: [], statsByPath: {} };
        }
        const rawPaths: string[] = [];
        for (const change of this.mergeChangeSpecs(postFinal.changes)) {
            if (change.type === 'rename') {
                rawPaths.push(change.oldPath, change.newPath);
            } else if ('path' in change) {
                rawPaths.push(change.path);
            }
        }
        const files = normalizeTouchedFiles(this.workspaceRoot, rawPaths);
        const statsByPath = files.reduce<Record<string, { additions: number | null; deletions: number | null }>>((acc, filePath) => {
            acc[filePath] = acc[filePath] || { additions: null, deletions: null };
            return acc;
        }, {});
        return {
            ownerMsgId: postFinal.ownerMsgId,
            files,
            statsByPath
        };
    }

    public isInPostFinalWatchWindow(sessionId: string): boolean {
        if (!sessionId) return false;
        if (this.turnStateBySession.has(sessionId)) return false;
        return this.postFinalWatchStateBySession.has(sessionId);
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
        if (!subagentSessionId || !parentSessionId) {
            this.logUiDebug(`[EXT][SUBAGENT_ROUTE_DROP] phase=register reason=missing-parent parentSessionId=${parentSessionId || 'null'} agentSessionId=${subagentSessionId || 'null'} displayTarget=parent`);
            return;
        }
        const existingParent = this.subagentToParentSessionMap.get(subagentSessionId);
        if (existingParent && existingParent !== parentSessionId) {
            this.logUiDebug(`[EXT][SUBAGENT_ROUTE_DROP] phase=register reason=parent-conflict parentSessionId=${parentSessionId} existingParentSessionId=${existingParent} agentSessionId=${subagentSessionId} displayTarget=parent`);
            return;
        }
        this.subagentToParentSessionMap.set(subagentSessionId, parentSessionId);
        if (!this.stablePulseRootSessionBySubagent.has(subagentSessionId)) {
            this.stablePulseRootSessionBySubagent.set(subagentSessionId, parentSessionId);
        } else {
            const stableParent = this.stablePulseRootSessionBySubagent.get(subagentSessionId);
            if (stableParent !== parentSessionId) {
                this.logUiDebug(`[EXT][SUBAGENT_ROUTE] phase=register parentSessionId=${parentSessionId} stableParentSessionId=${stableParent || 'null'} agentSessionId=${subagentSessionId} displayTarget=parent reason=stable-pulse-root-preserved`);
            }
        }
        this.logUiDebug(`[EXT][SUBAGENT_ROUTE] phase=register parentSessionId=${parentSessionId} agentSessionId=${subagentSessionId} displayTarget=parent reason=mapped`);
        this.logUiDebug(`EXT: session.group.register | subagent=${subagentSessionId} | parent=${parentSessionId}`);
    }

    public getParentSessionForSubagent(subagentSessionId: string | undefined): string | undefined {
        if (!subagentSessionId) return undefined;
        return this.subagentToParentSessionMap.get(subagentSessionId) || this.stablePulseRootSessionBySubagent.get(subagentSessionId);
    }

    /**
     * Clear the parent association for a subagent session.
     * @param subagentSessionId - The subagent session ID to unlink
     */
    public clearSubagentSession(subagentSessionId: string): void {
        if (!subagentSessionId) return;
        const hadParent = this.subagentToParentSessionMap.delete(subagentSessionId);
        const hadStablePulseRoot = this.stablePulseRootSessionBySubagent.delete(subagentSessionId);
        if (hadParent || hadStablePulseRoot) {
            this.logUiDebug(`[EXT][SUBAGENT_ROUTE] phase=clear scope=parent-scoped parentSessionId=null agentSessionId=${subagentSessionId} displayTarget=parent reason=clear-subagent-map stablePulseRootCleared=${hadStablePulseRoot}`);
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
        const stablePulseRootIds: string[] = [];
        for (const [subagentId, mappedParentId] of this.subagentToParentSessionMap.entries()) {
            if (mappedParentId === parentSessionId) {
                subagentIds.push(subagentId);
            }
        }
        for (const [subagentId, stableParentId] of this.stablePulseRootSessionBySubagent.entries()) {
            if (stableParentId === parentSessionId) {
                stablePulseRootIds.push(subagentId);
            }
        }
        for (const subagentId of subagentIds) {
            this.subagentToParentSessionMap.delete(subagentId);
        }
        for (const subagentId of stablePulseRootIds) {
            this.stablePulseRootSessionBySubagent.delete(subagentId);
        }
        if (subagentIds.length > 0 || stablePulseRootIds.length > 0) {
            const clearedAgentIds = Array.from(new Set([...subagentIds, ...stablePulseRootIds]));
            this.logUiDebug(`[EXT][SUBAGENT_ROUTE] phase=clear-parent scope=parent-scoped parentSessionId=${parentSessionId} agentSessionId=${clearedAgentIds.join(',')} displayTarget=parent reason=clear-parent-map subagentMappings=${subagentIds.length} stablePulseRoots=${stablePulseRootIds.length}`);
            this.logUiDebug(`EXT: session.group.clear-parent | parent=${parentSessionId} | cleared=${clearedAgentIds.length}`);
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
            existing.assistantMessageIds = existing.assistantMessageIds || new Set<string>();
            existing.assistantMessageIds.add(assistantMsgId);
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
            turnMessageIds: new Set(),
            assistantMessageIds: new Set([assistantMsgId])
        });
    }

    public getCurrentTurnAssistantMessageIds(sessionId: string | undefined): string[] {
        if (!sessionId) return [];
        const state = this.turnStateBySession.get(sessionId);
        const ids = new Set<string>(state?.assistantMessageIds || []);
        const candidates = [
            state?.assistantMsgId,
            state?.lastResolvedAssistantMsgId,
            this.currentTurnAssistantMsgIdBySession.get(sessionId),
            this.pendingAssistantMsgIdBySession.get(sessionId),
            this.finalizingMsgIdBySession.get(sessionId),
            this.turnFinalMsgIdBySession.get(sessionId),
        ];
        for (const candidate of candidates) {
            if (typeof candidate === 'string' && candidate.startsWith('msg_')) ids.add(candidate);
        }
        return Array.from(ids);
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

    public getAppendRootUserMsgId(sessionId: string | undefined): string | undefined {
        if (!sessionId) return undefined;
        return this.appendTurnStateBySession.get(sessionId)?.rootUserMsgId
            || this.displayTurnUserMsgIdBySession.get(sessionId);
    }

    public getLatestAppendUserMsgId(sessionId: string | undefined): string | undefined {
        if (!sessionId) return undefined;
        const state = this.appendTurnStateBySession.get(sessionId);
        if (!state?.appendUserMsgIds?.size) return undefined;
        return Array.from(state.appendUserMsgIds).pop();
    }

    public getCurrentTurnUserMsgId(sessionId: string | undefined): string | undefined {
        if (!sessionId) return undefined;
        return this.currentTurnUserMsgIdBySession.get(sessionId)
            || this.displayTurnUserMsgIdBySession.get(sessionId);
    }

    public getCurrentTurnStartedAt(sessionId: string | undefined): number | undefined {
        if (!sessionId) return undefined;
        const startedAt = this.currentTurnStartedAtBySession.get(sessionId);
        return typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt > 0
            ? startedAt
            : undefined;
    }

    public getCurrentTurnCompletedAt(sessionId: string | undefined): number | undefined {
        if (!sessionId) return undefined;
        const completedAt = this.turnFinalAtBySession.get(sessionId);
        return typeof completedAt === 'number' && Number.isFinite(completedAt) && completedAt > 0
            ? completedAt
            : undefined;
    }

    private getAppendRootCandidates(sessionId: string): Set<string> {
        const candidates = new Set<string>();
        const appendState = this.appendTurnStateBySession.get(sessionId);
        const add = (value: string | undefined) => {
            if (typeof value === 'string' && value) candidates.add(value);
        };
        add(appendState?.rootUserMsgId);
        add(this.currentTurnUserMsgIdBySession.get(sessionId));
        add(this.displayTurnUserMsgIdBySession.get(sessionId));
        add(this.turnStateBySession.get(sessionId)?.pendingUserLocalKey);
        return candidates;
    }

    private appendRootMatchesCandidate(sessionId: string, requestedRootUserMsgId: string, candidates: Set<string>): boolean {
        if (candidates.has(requestedRootUserMsgId)) return true;
        if (!requestedRootUserMsgId.startsWith('msg_')) return false;

        const turnState = this.turnStateBySession.get(sessionId);
        const pendingUserLocalKey = turnState?.pendingUserLocalKey;
        if (!pendingUserLocalKey || !pendingUserLocalKey.startsWith('local-')) return false;
        if (!candidates.has(pendingUserLocalKey)) return false;

        return turnState?.resolvedUserMsgId === requestedRootUserMsgId
            || this.messageIdsAreSessionAliases(sessionId, pendingUserLocalKey, requestedRootUserMsgId);
    }

    private messageIdsAreSessionAliases(sessionId: string, leftId: string, rightId: string): boolean {
        const aliasMap = this.messageIdAliasBySession.get(sessionId);
        if (!aliasMap) return false;
        return aliasMap.get(leftId) === rightId || aliasMap.get(rightId) === leftId;
    }

    private hasCurrentTurnFinalMarker(sessionId: string): boolean {
        if (this.turnFinalResolvedBySession.has(sessionId)) return true;
        const currentAssistantMsgId = this.currentTurnAssistantMsgIdBySession.get(sessionId)
            || this.turnStateBySession.get(sessionId)?.assistantMsgId;
        const lockedFinalMsgId = this.finalizingMsgIdBySession.get(sessionId);
        const finalMsgId = this.turnFinalMsgIdBySession.get(sessionId);
        if (lockedFinalMsgId) {
            return !currentAssistantMsgId || lockedFinalMsgId === currentAssistantMsgId;
        }
        if (finalMsgId) {
            return !currentAssistantMsgId || finalMsgId === currentAssistantMsgId;
        }
        return this.turnFinalAtBySession.has(sessionId);
    }

    private logCanAppendDeny(sessionId: string | undefined, rootUserMsgId: string | undefined, sub: 'missing-session' | 'no-turn-state' | 'root-not-in-candidates' | 'final-marker-set' | 'canceled' | 'missing-display-root' | 'unknown'): void {
        const id = sessionId || '';
        const rootCandidates = id ? Array.from(this.getAppendRootCandidates(id)) : [];
        const compactCandidates = rootCandidates.slice(0, 6).join(',');
        const turnState = id ? this.turnStateBySession.get(id) : undefined;
        const appendState = id ? this.appendTurnStateBySession.get(id) : undefined;
        const currentAssistantMsgId = id ? this.currentTurnAssistantMsgIdBySession.get(id) : undefined;
        const turnStateAssistantMsgId = turnState?.assistantMsgId;
        const finalMsgId = id ? this.turnFinalMsgIdBySession.get(id) : undefined;
        const finalizingMsgId = id ? this.finalizingMsgIdBySession.get(id) : undefined;
        const canceled = id ? this.canceledActiveTurnBySession.get(id) === true : false;
        this.logUiDebug(`[EXT][CAN_APPEND] result=deny sub=${sub} sessionId=${sessionId || 'null'} rootUserMsgId=${rootUserMsgId || 'null'} rootCandidatesCount=${rootCandidates.length} rootCandidates=[${compactCandidates}] hasTurnState=${!!turnState} hasDisplayRoot=${id ? this.displayTurnUserMsgIdBySession.has(id) : false} hasCurrentRoot=${id && rootUserMsgId ? rootCandidates.includes(rootUserMsgId) : false} hasAppendState=${!!appendState} hasFinalAt=${id ? this.turnFinalAtBySession.has(id) : false} hasFinalResolved=${id ? this.turnFinalResolvedBySession.has(id) : false} hasFinalMsgId=${!!finalMsgId} hasFinalizingMsgId=${!!finalizingMsgId} canceled=${canceled} currentAssistantMsgId=${currentAssistantMsgId || 'null'} turnStateAssistantMsgId=${turnStateAssistantMsgId || 'null'} finalMsgId=${finalMsgId || 'null'} finalizingMsgId=${finalizingMsgId || 'null'}`);
    }

    public canAppendToCurrentTurn(sessionId: string | undefined, rootUserMsgId?: string): boolean {
        if (!sessionId) {
            this.logCanAppendDeny(sessionId, rootUserMsgId, 'missing-session');
            return false;
        }
        if (!this.turnStateBySession.has(sessionId)) {
            this.logCanAppendDeny(sessionId, rootUserMsgId, 'no-turn-state');
            return false;
        }
        const rootCandidates = this.getAppendRootCandidates(sessionId);
        if (rootUserMsgId) {
            if (!this.appendRootMatchesCandidate(sessionId, rootUserMsgId, rootCandidates)) {
                this.logCanAppendDeny(sessionId, rootUserMsgId, 'root-not-in-candidates');
                return false;
            }
        } else if (!this.displayTurnUserMsgIdBySession.has(sessionId)) {
            this.logCanAppendDeny(sessionId, rootUserMsgId, 'missing-display-root');
            return false;
        }
        if (this.hasCurrentTurnFinalMarker(sessionId)) {
            this.logCanAppendDeny(sessionId, rootUserMsgId, 'final-marker-set');
            return false;
        }
        if (this.canceledActiveTurnBySession.get(sessionId) === true) {
            this.logCanAppendDeny(sessionId, rootUserMsgId, 'canceled');
            return false;
        }
        return true;
    }

    public canAppendToCurrentTurnRoot(sessionId: string | undefined, rootUserMsgId: string | undefined): boolean {
        if (!rootUserMsgId) return false;
        return this.canAppendToCurrentTurn(sessionId, rootUserMsgId);
    }

    public beginAppendPrompt(sessionId: string, clientMessageId: string, text: string, rootUserMsgIdFromIngress?: string): BeginAppendPromptResult | null {
        const rootUserMsgId = rootUserMsgIdFromIngress || this.getAppendRootUserMsgId(sessionId);
        if (!this.canAppendToCurrentTurn(sessionId, rootUserMsgId)) return null;
        if (!rootUserMsgId) return null;
        const state = this.appendTurnStateBySession.get(sessionId) || {
            rootUserMsgId,
            pending: [],
            appendUserMsgIds: new Set<string>(),
            emittedAppendUserMsgIds: new Set<string>()
        };
        if (state.rootUserMsgId && state.rootUserMsgId !== rootUserMsgId) {
            this.logUiDebug(`[EXT][APPEND_RETAIN] root-update sessionId=${sessionId} previousRootUserMsgId=${state.rootUserMsgId} rootUserMsgId=${rootUserMsgId}`);
        }
        state.rootUserMsgId = rootUserMsgId;
        state.pending.push({ clientMessageId, text });
        this.appendTurnStateBySession.set(sessionId, state);
        this.logUiDebug(`EXT: append.begin | sessionId=${sessionId} | rootUserMsgId=${rootUserMsgId} | clientMessageId=${clientMessageId}`);
        return { sessionId, rootUserMsgId, clientMessageId };
    }

    public failAppendPrompt(sessionId: string, clientMessageId: string): boolean {
        const state = this.appendTurnStateBySession.get(sessionId);
        if (!state) return false;
        const before = state.pending.length;
        state.pending = state.pending.filter((item) => item.clientMessageId !== clientMessageId);
        const changed = state.pending.length !== before;
        if (!state.pending.length && !state.appendUserMsgIds.size) {
            this.appendTurnStateBySession.delete(sessionId);
        }
        return changed;
    }

    private bindAppendUserMessage(sessionId: string | undefined, userMsgId: string | undefined): AppendPendingPrompt | undefined {
        if (!sessionId || !userMsgId || !userMsgId.startsWith('msg_')) return undefined;
        const state = this.appendTurnStateBySession.get(sessionId);
        if (!state || state.rootUserMsgId === userMsgId) return undefined;
        const existing = state.pending.find((item) => item.serverMsgId === userMsgId);
        if (existing) return existing;
        const next = state.pending.find((item) => !item.serverMsgId);
        if (!next) return undefined;
        next.serverMsgId = userMsgId;
        state.appendUserMsgIds.add(userMsgId);
        this.logUiDebug(`EXT: append.ack | sessionId=${sessionId} | rootUserMsgId=${state.rootUserMsgId} | appendUserMsgId=${userMsgId} | clientMessageId=${next.clientMessageId}`);
        return next;
    }

    private getAppendPromptForUserMessage(sessionId: string | undefined, userMsgId: string | undefined): AppendPendingPrompt | undefined {
        if (!sessionId || !userMsgId) return undefined;
        const state = this.appendTurnStateBySession.get(sessionId);
        if (!state?.appendUserMsgIds.has(userMsgId)) return undefined;
        return state.pending.find((item) => item.serverMsgId === userMsgId);
    }

    private shouldEmitAppendUserMessage(sessionId: string | undefined, userMsgId: string | undefined): boolean {
        if (!sessionId || !userMsgId) return false;
        const state = this.appendTurnStateBySession.get(sessionId);
        if (!state || !state.appendUserMsgIds.has(userMsgId)) return false;
        if (state.emittedAppendUserMsgIds.has(userMsgId)) return false;
        state.emittedAppendUserMsgIds.add(userMsgId);
        return true;
    }

    private rememberHiddenControlUserMsgId(sessionId: string, userMsgId: string): void {
        if (!sessionId || !userMsgId || !userMsgId.startsWith('msg_')) return;
        const set = this.hiddenControlUserMsgIdsBySession.get(sessionId) || new Set<string>();
        set.add(userMsgId);
        if (set.size > 50) {
            const first = set.values().next();
            if (!first.done) set.delete(first.value);
        }
        this.hiddenControlUserMsgIdsBySession.set(sessionId, set);
    }

    private isHiddenControlUserMsgId(sessionId: string | undefined, userMsgId: string | undefined): boolean {
        if (!sessionId || !userMsgId) return false;
        return this.hiddenControlUserMsgIdsBySession.get(sessionId)?.has(userMsgId) === true;
    }

    private rememberHiddenControlAssistantMsgId(sessionId: string, assistantMsgId: string): void {
        if (!sessionId || !assistantMsgId || !assistantMsgId.startsWith('msg_')) return;
        const set = this.hiddenControlAssistantMsgIdsBySession.get(sessionId) || new Set<string>();
        set.add(assistantMsgId);
        if (set.size > 50) {
            const first = set.values().next();
            if (!first.done) set.delete(first.value);
        }
        this.hiddenControlAssistantMsgIdsBySession.set(sessionId, set);
    }

    private isHiddenControlAssistantMsgId(sessionId: string | undefined, assistantMsgId: string | undefined): boolean {
        if (!sessionId || !assistantMsgId) return false;
        return this.hiddenControlAssistantMsgIdsBySession.get(sessionId)?.has(assistantMsgId) === true;
    }

    private shouldSuppressHiddenControlAssistant(sessionId: string | undefined, parentUserMsgId: string | undefined): boolean {
        if (!sessionId || !parentUserMsgId) return false;
        if (!this.isHiddenControlUserMsgId(sessionId, parentUserMsgId)) return false;
        if (this.turnStateBySession.has(sessionId)) return false;
        if (!this.turnFinalAtBySession.has(sessionId)) return false;
        return true;
    }

    private shouldSuppressStopContinuationAssistant(sessionId: string | undefined): boolean {
        if (!sessionId) return false;
        if (this.turnStateBySession.has(sessionId)) return false;
        if (!this.turnFinalAtBySession.has(sessionId)) return false;
        const sentAt = this.pendingStopContinuationUserBySession.get(sessionId) || 0;
        if (!sentAt) return false;
        return (Date.now() - sentAt) <= 15000;
    }

    private shouldSuppressPendingStopControlUser(sessionId: string | undefined): boolean {
        if (!sessionId) return false;
        if (this.turnStateBySession.has(sessionId)) return false;
        if (!this.turnFinalAtBySession.has(sessionId)) return false;
        const sentAt = this.pendingStopContinuationUserBySession.get(sessionId) || 0;
        if (!sentAt) return false;
        return (Date.now() - sentAt) <= 15000;
    }

    /**
     * Public helper for SidebarProvider: checks if the current turn for a session
     * is a synthetic/hidden-control turn whose streaming UI events should be suppressed.
     * Returns true if the turn's parent user message is a hidden-control user msg
     * (shouldSuppressHiddenControlAssistant) OR a stop-continuation window applies
     * (shouldSuppressStopContinuationAssistant).
     * Callers should tag assistantMessageMeta events with isSyntheticTurn: true
     * when this returns true, so the webview can skip display.
     */
    public isCurrentTurnSyntheticForSession(sessionId: string | undefined): boolean {
        if (!sessionId) return false;
        const chain = this.continuationChainsBySession.get(sessionId);
        if (chain && (chain.state === 'revive_armed' || chain.state === 'bootstrap_buffering' || chain.state === 'continuation_active')) {
            return false;
        }
        const currentUserMsgId = this.currentTurnUserMsgIdBySession.get(sessionId);
        if (currentUserMsgId && this.shouldSuppressHiddenControlAssistant(sessionId, currentUserMsgId)) {
            return true;
        }
        if (this.shouldSuppressStopContinuationAssistant(sessionId)) {
            return true;
        }
        return false;
    }

    public setCurrentTurnAssistantMsgId(sessionId: string, assistantMsgId: string, reason = 'unknown'): void {
        if (!sessionId || !assistantMsgId || !assistantMsgId.startsWith('msg_')) return;
        const existing = this.currentTurnAssistantMsgIdBySession.get(sessionId);
        if (existing && existing === assistantMsgId) return;
        this.currentTurnAssistantMsgIdBySession.set(sessionId, assistantMsgId);
        this.logUiDebug(`EXT: turn.anchor.assistant | sessionId=${sessionId} | assistantMsgId=${assistantMsgId} | reason=${reason}`);
    }

    public recordAppendFollowupToolCallsBoundary(sessionId: string | undefined, assistantMsgId: string | undefined, lane: EventLane): void {
        if (!sessionId || !assistantMsgId || lane !== 'main') return;
        const state = this.turnStateBySession.get(sessionId);
        const activeSuccessor = this.appendTurnStateBySession.get(sessionId)?.activeSuccessor;
        if (
            state
            && activeSuccessor?.assistantMsgId === assistantMsgId
            && state.appendFollowupHandoff?.phase === 'followup-active'
            && state.appendFollowupHandoff.followupAssistantMsgId === assistantMsgId
        ) {
            state.appendFollowupHandoff.followupFinishedWithToolCalls = true;
            return;
        }
        if (!state || state.assistantMsgId !== assistantMsgId || activeSuccessor) return;
        if (state.appendFollowupHandoff?.phase === 'tool-calls-complete' && state.appendFollowupHandoff.predecessorAssistantMsgId === assistantMsgId) return;
        state.appendFollowupHandoff = { phase: 'tool-calls-complete', predecessorAssistantMsgId: assistantMsgId };
    }

    public clearAppendFollowupBoundaryForRenewedContent(sessionId: string | undefined, assistantMsgId: string | undefined): void {
        const state = sessionId ? this.turnStateBySession.get(sessionId) : undefined;
        if (state?.appendFollowupHandoff?.phase === 'tool-calls-complete' && state.appendFollowupHandoff.predecessorAssistantMsgId === assistantMsgId) state.appendFollowupHandoff = undefined;
    }

    public tryBindAppendFollowup(sessionId: string | undefined, assistantMsgId: string | undefined, parentId: string | undefined, lane: EventLane): { status: 'new' | 'existing' | 'blocked' | 'conflict'; identity?: AppendFollowupIdentity } {
        if (!sessionId || !assistantMsgId || !parentId || lane !== 'main') return { status: 'blocked' };
        const append = this.appendTurnStateBySession.get(sessionId);
        const state = this.turnStateBySession.get(sessionId);
        const active = append?.activeSuccessor;
        if (active) return active.assistantMsgId === assistantMsgId && active.appendUserMsgId === parentId ? { status: 'existing', identity: { ...active } } : { status: 'conflict' };
        const marker = state?.appendFollowupHandoff;
        if (!append?.appendUserMsgIds.has(parentId) || !state || marker?.phase !== 'tool-calls-complete' || marker.predecessorAssistantMsgId !== state.assistantMsgId || this.turnFinishedBySession.has(sessionId) || this.turnFinalMsgIdBySession.has(sessionId) || this.finalizingMsgIdBySession.has(sessionId)) return { status: 'blocked' };
        const identity: AppendFollowupIdentity = { kind: 'append-followup', mode: 'same-turn-handoff', sessionId, appendUserMsgId: parentId, predecessorAssistantMsgId: marker.predecessorAssistantMsgId, assistantMsgId, generation: (append.nextSuccessorGeneration || 0) + 1 };
        append.nextSuccessorGeneration = identity.generation;
        append.activeSuccessor = identity;
        state.assistantMsgId = assistantMsgId;
        state.pendingAssistantTmpKey = undefined;
        state.turnMessageIds = state.turnMessageIds || new Set<string>();
        state.turnMessageIds.add(marker.predecessorAssistantMsgId);
        state.turnMessageIds.add(assistantMsgId);
        state.appendFollowupHandoff = { phase: 'followup-active', predecessorAssistantMsgId: marker.predecessorAssistantMsgId, appendUserMsgId: parentId, followupAssistantMsgId: assistantMsgId, generation: identity.generation };
        this.currentTurnAssistantMsgIdBySession.set(sessionId, assistantMsgId);
        this.pendingAssistantMsgIdBySession.set(sessionId, assistantMsgId);
        this.currentTurnUserMsgIdBySession.set(sessionId, parentId);
        this.pendingUserMsgIdBySession.set(sessionId, parentId);
        return { status: 'new', identity: { ...identity } };
    }

    public tryAdvanceAppendFollowup(
        sessionId: string | undefined,
        assistantMsgId: string | undefined,
        parentId: string | undefined,
        lane: EventLane
    ): { status: 'new' | 'existing' | 'blocked' | 'conflict'; identity?: AppendFollowupIdentity } {
        if (!sessionId || !assistantMsgId || lane !== 'main') return { status: 'blocked' };
        const append = this.appendTurnStateBySession.get(sessionId);
        const state = this.turnStateBySession.get(sessionId);
        const active = append?.activeSuccessor;
        if (!append || !state || !active) return { status: 'blocked' };
        if (active.assistantMsgId === assistantMsgId) {
            return { status: 'existing', identity: { ...active } };
        }
        const handoff = state.appendFollowupHandoff;
        if (
            (parentId && parentId !== active.appendUserMsgId)
            || handoff?.phase !== 'followup-active'
            || handoff.followupAssistantMsgId !== active.assistantMsgId
            || handoff.followupFinishedWithToolCalls !== true
            || this.turnFinishedBySession.has(sessionId)
            || this.turnFinalMsgIdBySession.has(sessionId)
            || this.finalizingMsgIdBySession.has(sessionId)
        ) {
            return { status: 'conflict' };
        }

        const identity: AppendFollowupIdentity = {
            kind: 'append-followup',
            mode: 'same-turn-handoff',
            sessionId,
            appendUserMsgId: active.appendUserMsgId,
            predecessorAssistantMsgId: active.assistantMsgId,
            assistantMsgId,
            generation: (append.nextSuccessorGeneration || active.generation) + 1
        };
        append.nextSuccessorGeneration = identity.generation;
        append.activeSuccessor = identity;
        state.assistantMsgId = assistantMsgId;
        state.pendingAssistantTmpKey = undefined;
        state.turnMessageIds = state.turnMessageIds || new Set<string>();
        state.turnMessageIds.add(active.assistantMsgId);
        state.turnMessageIds.add(assistantMsgId);
        state.appendFollowupHandoff = {
            phase: 'followup-active',
            predecessorAssistantMsgId: active.assistantMsgId,
            appendUserMsgId: active.appendUserMsgId,
            followupAssistantMsgId: assistantMsgId,
            generation: identity.generation
        };
        this.currentTurnAssistantMsgIdBySession.set(sessionId, assistantMsgId);
        this.pendingAssistantMsgIdBySession.set(sessionId, assistantMsgId);
        this.currentTurnUserMsgIdBySession.set(sessionId, active.appendUserMsgId);
        this.pendingUserMsgIdBySession.set(sessionId, active.appendUserMsgId);
        this.logUiDebug(
            `EXT: append.followup.advance | sessionId=${sessionId} | from=${active.assistantMsgId} | to=${assistantMsgId} | generation=${identity.generation}`
        );
        return { status: 'new', identity: { ...identity } };
    }

    public getActiveAppendFollowup(sessionId: string | undefined): AppendFollowupIdentity | undefined {
        const identity = sessionId ? this.appendTurnStateBySession.get(sessionId)?.activeSuccessor : undefined;
        return identity ? { ...identity } : undefined;
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
        const userMsgId = this.getAppendRootUserMsgId(sessionId)
            || this.currentTurnUserMsgIdBySession.get(sessionId);
        if (!userMsgId) return false;
        const assistantMsgId = this.currentTurnAssistantMsgIdBySession.get(sessionId);
        if (!assistantMsgId) return true;
        return !this.hasSeenFinalForAssistant(sessionId, assistantMsgId);
    }

    private hasAcceptedFinalAssistantForSession(sessionId: string | undefined): boolean {
        if (!sessionId) return false;
        const candidates = [
            this.turnFinalMsgIdBySession.get(sessionId),
            this.finalizingMsgIdBySession.get(sessionId),
            this.currentTurnAssistantMsgIdBySession.get(sessionId),
            this.turnStateBySession.get(sessionId)?.assistantMsgId
        ].filter((id): id is string => typeof id === 'string' && id.startsWith('msg_'));
        for (const messageId of candidates) {
            if (this.assistantPhaseByMessageId.get(messageId) === 'assistant_final_accepted') {
                return true;
            }
        }
        return false;
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
            this.lockedFinalSettleAttemptsBySession.set(sessionId, 0);
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
            if (!this.subagentToParentSessionMap.has(sessionId)) {
                this.ensureSealedContinuationChain(sessionId, targetMsgId);
            } else {
                this.logUiDebug(`EXT: continuation.chain.seed.skip | sessionId=${sessionId} | msgId=${targetMsgId} | reason=subagent-session`);
            }
        }
        this.turnFinalSourceBySession.set(sessionId, source);
        if (!prevMsgId || (targetMsgId && targetMsgId !== prevMsgId)) {
            this.turnSettleAttemptsBySession.set(sessionId, 0);
            this.turnSettleLastLenBySession.delete(sessionId);
            this.turnSettleStableCountBySession.set(sessionId, 0);
            this.turnSettleLastFingerprintBySession.delete(sessionId);
            this.turnSettleNoDeltaCountBySession.set(sessionId, 0);
        }
        this.scheduleTurnFinalQuiet(sessionId);
    }

    public handleSessionIdleFinal(sessionId: string): void {
        if (!sessionId || !this.turnStateBySession.has(sessionId)) return;
        const assistantMsgId = this.getTurnAssistantMsgId(sessionId);
        const state = this.turnStateBySession.get(sessionId);
        const activeSuccessor = this.appendTurnStateBySession.get(sessionId)?.activeSuccessor;
        const handoff = state?.appendFollowupHandoff;
        const deferToolCallsSuccessor = Boolean(
            assistantMsgId
            && activeSuccessor?.assistantMsgId === assistantMsgId
            && handoff?.phase === 'followup-active'
            && handoff.followupAssistantMsgId === assistantMsgId
            && handoff.followupFinishedWithToolCalls === true
            && !this.hasSeenFinalForAssistant(sessionId, assistantMsgId)
        );
        if (!deferToolCallsSuccessor) {
            this.logUiDebug(`EXT: session.idle.final | sessionId=${sessionId} | msgId=${assistantMsgId || 'null'}`);
            this.markTurnFinal(sessionId, assistantMsgId, 'session-idle');
            return;
        }

        this.logUiDebug(
            `EXT: session.idle.final.defer | sessionId=${sessionId} | msgId=${assistantMsgId} | reason=append-successor-tool-calls`
        );
        this.authoritativeIdleResyncBySession.add(sessionId);
        void this.resyncForChatResolve(sessionId, 'session-idle-append-tool-calls')
            .finally(() => {
                this.authoritativeIdleResyncBySession.delete(sessionId);
                if (!this.turnFinalResolvedBySession.has(sessionId) && !this.turnFinalAtBySession.has(sessionId)) {
                    this.startRescueTimer(sessionId);
                }
            });
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
        if (this.authoritativeIdleResyncBySession.has(sessionId)) {
            this.logUiDebug(`EXT: resync.keep.by-sse | sessionId=${sessionId} | msgId=${msgId} | reason=${reason} | owner=session-idle-final`);
            return;
        }
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
        if (this.authoritativeIdleResyncBySession.has(sessionId)) {
            this.logUiDebug(`EXT: resync.keep.by-sse | sessionId=${sessionId} | reason=${reason} | owner=session-idle-final`);
            return;
        }
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
        const resolvedFinalMsgId = this.turnFinalMsgIdBySession.get(sessionId) || this.finalizingMsgIdBySession.get(sessionId);
        const isSubagentSession = this.subagentToParentSessionMap.has(sessionId);
        const allowWithoutFinalMsg = reason === 'session-error' || reason === 'session-error-abort' || isSubagentSession;
        if (!resolvedFinalMsgId && !allowWithoutFinalMsg) {
            this.logUiDebug(`EXT: turn.resolve.skip | sessionId=${sessionId} | reason=${reason} | guard=missing-final-msg`);
            return;
        }
        this.clearPendingMainFinalGate(sessionId, `resolved:${reason}`);
        this.turnFinalResolvedBySession.add(sessionId);
        this.lockedFinalSettleAttemptsBySession.delete(sessionId);
        this.stopNonFinalResyncLoop(sessionId, `resolved:${reason}`);
        this.stopRescueWatchdog(sessionId, reason);
        const waiters = this.turnFinalWaitersBySession.get(sessionId);
        if (waiters && waiters.length) {
            waiters.splice(0).forEach((fn) => fn());
        } else if (!isSubagentSession) {
            this.emitChatEvents([{
                type: 'turnResolved',
                sessionId,
                assistantMsgId: resolvedFinalMsgId,
                messageId: resolvedFinalMsgId,
                finalizeReason: reason,
                source: this.turnFinalSourceBySession.get(sessionId) || 'sse'
            }]);
        }
    }

    private resetFalsePositiveFinal(sessionId: string, reason: string): void {
        if (!sessionId) return;

        const resetCount = (this.falsePositiveResetCountBySession.get(sessionId) || 0) + 1;
        this.falsePositiveResetCountBySession.set(sessionId, resetCount);
        this.logUiDebug(`EXT: fp.reset | sessionId=${sessionId} | reason=${reason} | resetCount=${resetCount}`);

        // Clear all 6 finalization maps
        this.turnFinalAtBySession.delete(sessionId);
        this.finalizingMsgIdBySession.delete(sessionId);
        this.turnFinalMsgIdBySession.delete(sessionId);
        this.turnFinalSourceBySession.delete(sessionId);
        this.turnSseTextAtBySession.delete(sessionId);

        // Clear all 5 settle counters
        this.turnSettleAttemptsBySession.delete(sessionId);
        this.turnSettleLastLenBySession.delete(sessionId);
        this.turnSettleStableCountBySession.delete(sessionId);
        this.turnSettleLastFingerprintBySession.delete(sessionId);
        this.turnSettleNoDeltaCountBySession.delete(sessionId);
        this.lockedFinalSettleAttemptsBySession.delete(sessionId);

        // Cancel SSE drain timer
        const sseDrain = this.turnSseDrainTimerBySession.get(sessionId);
        if (sseDrain) {
            clearTimeout(sseDrain);
            this.turnSseDrainTimerBySession.delete(sessionId);
        }

        // Stop current watchdog and re-arm rescue timer to wait for true final
        this.stopRescueWatchdog(sessionId, `fp-reset:${reason}`);
        this.turnRecoveryModeBySession.set(sessionId, 'sse');
        this.startRescueTimer(sessionId);
        this.logUiDebug(`EXT: fp.reset.complete | sessionId=${sessionId} | resetCount=${resetCount} | mode=sse`);
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
        const isLockedSettle = reason === 'resync-final-locked';
        if (isLockedSettle) {
            const attempts = (this.lockedFinalSettleAttemptsBySession.get(sessionId) || 0) + 1;
            this.lockedFinalSettleAttemptsBySession.set(sessionId, attempts);
            this.logUiDebug(`EXT: settle.locked.attempt | sessionId=${sessionId} | attempts=${attempts} | max=${this.lockedFinalSettleMaxAttempts}`);
            if (attempts >= this.lockedFinalSettleMaxAttempts) {
                this.logUiDebug(`EXT: settle.locked.reset | sessionId=${sessionId} | attempts=${attempts} | action=fp-reset`);
                this.resetFalsePositiveFinal(sessionId, `locked-settle-max:${attempts}`);
                return;
            }
        }
        const inFastPath = reason === 'sse-drain' || reason === 'sse-drain-pass2' || reason === 'tool-terminal' || isLockedSettle;
        if (!inFastPath) {
            await this.resyncForChatResolve(sessionId, `settle:${reason}`);
        }
        if (this.turnFinalResolvedBySession.has(sessionId)) return;
        const finalMsgId = this.getFinalizingMsgId(sessionId);
        if (!finalMsgId) {
            // FP detection: turnFinalAtBySession set but no finalizingMsgId — false-positive state
            if (this.turnFinalAtBySession.has(sessionId)) {
                this.logUiDebug(`EXT: fp.detect | sessionId=${sessionId} | location=settle-check | reason=${reason}`);
                this.resetFalsePositiveFinal(sessionId, `settle:${reason}`);
                return;
            }
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
        if (this.finalizingMsgIdBySession.has(sessionId) && len > 0 && stable >= 1 && !this.hasPendingOrRunningTools(sessionId)) {
            this.logUiDebug(`EXT: settle.fast | sessionId=${sessionId} | reason=final-locked | msgId=${finalMsgId} | len=${len} | stable=${stable}`);
            this.resolveTurnFinal(sessionId, 'settle-fast-final-locked');
            return;
        }
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
        const emptyIdleFinalConfirmed = reason === 'sse-drain-pass2'
            && len === 0
            && this.turnFinalSourceBySession.get(sessionId) === 'session-idle'
            && this.finalizingMsgIdBySession.get(sessionId) === finalMsgId
            && !this.hasPendingOrRunningTools(sessionId);
        if (emptyIdleFinalConfirmed) {
            this.logUiDebug(`EXT: settle.empty-idle | sessionId=${sessionId} | msgId=${finalMsgId} | action=resolve`);
            this.resolveTurnFinal(sessionId, 'settle-empty-idle');
            return;
        }
        if (complete) {
            const reasonLabel = noDeltaCount >= this.settleNoDeltaThreshold && sseSilent
                ? 'settle-no-delta'
                : 'settle-complete';
            this.resolveTurnFinal(sessionId, reasonLabel);
            return;
        }
        if (
            reason === 'sse-drain'
            && !this.hasPendingOrRunningTools(sessionId)
            && ((len > 0 && stable === 1) || (
                len === 0
                && this.turnFinalSourceBySession.get(sessionId) === 'session-idle'
                && this.finalizingMsgIdBySession.get(sessionId) === finalMsgId
            ))
        ) {
            const existing = this.turnSseDrainTimerBySession.get(sessionId);
            if (existing) {
                clearTimeout(existing);
            }
            const timer = setTimeout(() => {
                this.turnSseDrainTimerBySession.delete(sessionId);
                void this.runResyncSettleCheck(sessionId, 'sse-drain-pass2');
            }, this.sseDrainPass2DelayMs);
            this.turnSseDrainTimerBySession.set(sessionId, timer);
            this.logUiDebug(`EXT: settle.pass2.schedule | sessionId=${sessionId} | delayMs=${this.sseDrainPass2DelayMs} | msgId=${finalMsgId} | len=${len}`);
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
        void this.resyncForChatResolve(sessionId, 'watchdog-timeout')
            .finally(() => {
                const delayTimer = setTimeout(() => {
                    this.watchdogDrainDelayTimerBySession.delete(sessionId);
                    if (this.turnFinalResolvedBySession.has(sessionId)) {
                        this.logUiDebug(`EXT: watchdog.drain-delay.resolved-guard | sessionId=${sessionId} | resolved=true`);
                        return;
                    }
                    if (this.turnFinalAtBySession.has(sessionId)) {
                        this.logUiDebug(`EXT: watchdog.drain-delay.final-locked | sessionId=${sessionId} | delayMs=${this.watchdogDrainDelayMs}`);
                        this.scheduleSseDrainConfirm(sessionId);
                        return;
                    }
                    this.logUiDebug(`EXT: watchdog.drain-delay.no-final | sessionId=${sessionId} | delayMs=${this.watchdogDrainDelayMs}`);
                    this.startRescueTimer(sessionId);
                }, this.watchdogDrainDelayMs);
                this.watchdogDrainDelayTimerBySession.set(sessionId, delayTimer);
                this.logUiDebug(`EXT: watchdog.drain-delay.start | sessionId=${sessionId} | delayMs=${this.watchdogDrainDelayMs}`);
            });
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
            const rootUserMsgId = this.getAppendRootUserMsgId(sessionId)
                || userMsgId;
            state.resolvedUserMsgId = rootUserMsgId;
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
                        rootUserMsgId || undefined,
                        {
                            allowNoCommitTerminal: Boolean(
                                state.noCommitTerminalTmpKey
                                && state.pendingAssistantTmpKey
                                && state.noCommitTerminalTmpKey === state.pendingAssistantTmpKey
                            )
                        }
                    );
                }
            }

            return {
                status: 'ok',
                localKey,
                userMsgId: rootUserMsgId,
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

    public async getSessionMessageDetail(sessionId: string, messageID: string): Promise<SessionMessageDetail> {
        const encodedSession = encodeURIComponent(sessionId);
        const encodedMessage = encodeURIComponent(messageID);
        this.logUiDebug(`[EXT][AUTH_DIFF] detail.fetch.start | sessionId=${sessionId} | messageId=${messageID}`);
        const detail = await this.requestJson<SessionMessageDetail>('GET', `/session/${encodedSession}/message/${encodedMessage}`);
        const hasInfo = Boolean(detail?.info);
        const partCount = Array.isArray(detail?.parts) ? detail.parts.length : 0;
        this.logUiDebug(`[EXT][AUTH_DIFF] detail.fetch.done | sessionId=${sessionId} | messageId=${messageID} | hasInfo=${String(hasInfo)} | partCount=${partCount}`);
        return detail;
    }

    /**
     * OpenCode message detail is expected as `{ info, parts }`; changed-file data is exposed
     * at `info.summary.diffs`. Static API inspection in this repository does not provide a
     * narrower type, so this normalizer accepts common diff entry path fields defensively.
     */
    public extractFilesFromMessageSummaryDiffs(detail: SessionMessageDetail | undefined, context: { sessionId?: string; messageId?: string } = {}): string[] {
        const diffs = detail?.info?.summary?.diffs;
        if (!Array.isArray(diffs)) return [];
        const rawPaths: string[] = [];
        for (const diff of diffs) {
            if (!diff || typeof diff !== 'object') continue;
            const candidates = [
                diff.path,
                diff.file,
                diff.filePath,
                diff.filename,
                diff.name,
                diff.oldPath,
                diff.newPath,
                diff.from,
                diff.to
            ];
            for (const candidate of candidates) {
                if (typeof candidate === 'string' && candidate.trim()) rawPaths.push(candidate.trim());
            }
        }
        const files = normalizeTouchedFiles(this.workspaceRoot, rawPaths).sort();
        if (diffs.length > 0 && files.length === 0) {
            this.logUiDebug(`[EXT][AUTH_DIFF] detail.drop | sessionId=${context.sessionId || 'null'} | messageId=${context.messageId || 'null'} | reason=no-files-from-nonempty-diffs | diffCount=${diffs.length}`);
        }
        return files;
    }

    public async getAuthoritativeDiffFileSet(input: {
        sessionId: string;
        rootUserMessageId?: string;
        latestAppendUserMessageId?: string;
    }): Promise<AuthoritativeDiffFileSetResult> {
        const queriedIds = Array.from(new Set([
            input.rootUserMessageId,
            input.latestAppendUserMessageId
        ].filter((id): id is string => typeof id === 'string' && id.startsWith('msg_'))));
        const missingIds: string[] = [];
        const fileSet = new Set<string>();
        this.logUiDebug(`[EXT][AUTH_DIFF] union.start | sessionId=${input.sessionId} | queriedIds=${queriedIds.join(',') || 'none'}`);
        for (const messageId of queriedIds) {
            try {
                const detail = await this.getSessionMessageDetail(input.sessionId, messageId);
                const files = this.extractFilesFromMessageSummaryDiffs(detail, { sessionId: input.sessionId, messageId });
                files.forEach((file) => fileSet.add(file));
                this.logUiDebug(`[EXT][AUTH_DIFF] union.detail | sessionId=${input.sessionId} | messageId=${messageId} | fileCount=${files.length}`);
            } catch (error) {
                missingIds.push(messageId);
                this.logUiDebug(`[EXT][AUTH_DIFF] detail.drop | sessionId=${input.sessionId} | messageId=${messageId} | reason=fetch-failed | err=${String(error)}`);
            }
        }
        const files = Array.from(fileSet).sort();
        this.logUiDebug(`[EXT][AUTH_DIFF] union.done | sessionId=${input.sessionId} | queriedIds=${queriedIds.join(',') || 'none'} | missingIds=${missingIds.join(',') || 'none'} | fileCount=${files.length}`);
        return { files, queriedIds, missingIds, source: 'message-summary-diffs' };
    }

    public async finalizeTurnBindingFromResolvedAssistant(sessionId: string, assistantMsgId: string): Promise<void> {
        if (!sessionId || !assistantMsgId || !assistantMsgId.startsWith('msg_')) return;
        if (!this.gitUndoAvailable) return;
        const state = this.turnStateBySession.get(sessionId);
        const tmpKey = state?.pendingAssistantTmpKey;
        if (!state || !tmpKey) {
            this.logUiDebug(`EXT: finalizeBinding.direct.skip | sessionId=${sessionId} assistantMsgId=${assistantMsgId} reason=missing-tmpKey`);
            return;
        }
        const userMsgId = this.getAppendRootUserMsgId(sessionId) || this.currentTurnUserMsgIdBySession.get(sessionId);
        state.lastResolvedAssistantMsgId = assistantMsgId;
        try {
            await this.gitUndo?.finalizeBinding(sessionId, tmpKey, assistantMsgId, userMsgId || undefined, {
                allowNoCommitTerminal: state.noCommitTerminalTmpKey === tmpKey
            });
            this.logUiDebug(`EXT: finalizeBinding.direct.ok | sessionId=${sessionId} assistantMsgId=${assistantMsgId} tmpKey=${tmpKey}`);
        } catch (error) {
            this.logUiDebug(`EXT: finalizeBinding.direct.fail | sessionId=${sessionId} assistantMsgId=${assistantMsgId} tmpKey=${tmpKey} err=${String(error)}`);
        }
    }

    public async promoteContinuationOwner(sessionId: string, ownerMsgId: string): Promise<void> {
        if (!sessionId || !ownerMsgId || !ownerMsgId.startsWith('msg_')) return;
        const postFinal = this.postFinalWatchStateBySession.get(sessionId);
        const changes = postFinal?.changes || [];
        await this.persistContinuationState(sessionId, ownerMsgId, 'watching', changes);
    }

    public async consolidateCurrentContinuationOwner(sessionId: string): Promise<void> {
        if (!sessionId || !this.gitUndoAvailable || !this.gitUndo) return;
        await this.gitUndo.consolidateCurrentContinuationOwner(sessionId);
    }

    private execute(args: string[]): Promise<string> {
        return this.processRunner.execute(args);
    }

    private executeStreaming(args: string[], sessionId: string, onEvent?: (event: ChatEvent) => void, stdinText?: string): Promise<void> {
        if (!sessionId) {
            throw new Error('Missing session ID for streaming process.');
        }
        return this.processRunner.executeStreaming(
            args,
            (line) => this.handleCliOutputLine(line, sessionId, onEvent),
            stdinText,
        );
    }

    private handleCliOutputLine(trimmed: string, ownerSessionId: string, onEvent?: (event: ChatEvent) => void): void {
        if (!trimmed) return;
                try {
                    const parsed = JSON.parse(trimmed);
                    const sessionId = parsed.sessionID as string | undefined;
                    if (sessionId && onEvent) {
                        onEvent({ type: 'session', sessionId });
                    }
                    // Transport ownership is not UI selection. Concurrent session output
                    // must never replace the session selected through setSessionId().
                    const messageId = parsed.part?.messageID || parsed.part?.messageId || parsed.messageID || parsed.messageId;
                    const assistantMsgId = typeof parsed.part?.messageID === 'string' ? parsed.part.messageID : undefined;
                    // if (assistantMsgId || messageId) {
                    //     this.logUiDebug(`[DBG_STDOUT_ID] type=${parsed.type || 'unknown'} session=${sessionId || 'null'} tmpKey=null messageID=${assistantMsgId || messageId || 'null'}`);
                    // }
                    const resolvedSessionId = sessionId || ownerSessionId;
                    if (assistantMsgId && resolvedSessionId) {
                        this.recordAssistantMsgId(resolvedSessionId, assistantMsgId);
                    }
                    if (messageId && onEvent) {
                        onEvent({ type: 'message', text: messageId, sessionId: resolvedSessionId });
                        this.registerMessageId(messageId, resolvedSessionId);
                        if (resolvedSessionId && typeof messageId === 'string') {
                            this.trackTurnMessageId(resolvedSessionId, messageId);
                        }
                    }
                    if (assistantMsgId && onEvent) {
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
                            onEvent({ type: 'error', text: errMsg, sessionId: resolvedSessionId });
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
                            onEvent({ type: 'toolPatch', text: patchText, sessionId: resolvedSessionId });
                        }
                    }
                    if (parsed.type === 'tool_use' && parsed.part && parsed.part.tool) {
                        const toolName = String(parsed.part.tool);
                        const toolStatus = parsed.part?.state?.status;
                        if (toolStatus === 'completed') {
                            if (['apply_patch', 'edit', 'write'].includes(toolName)) {
                                this.markTurnHasWrites(resolvedSessionId, `tool_use:${toolName}`);
                            } else if (toolName === 'bash') {
                                const command = parsed.part?.state?.input?.command;
                                if (!this.isBashCommandReadOnly(command)) {
                                    this.markTurnHasWrites(resolvedSessionId, 'tool_use:bash');
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
                        onEvent({ type: 'files', files, sessionId: resolvedSessionId });
                    }
                    if (parsed.type === 'text' && parsed.part && typeof parsed.part.text === 'string') {
                        if (onEvent) {
                            onEvent({ type: 'text', text: parsed.part.text, sessionId: resolvedSessionId, assistantMsgId });
                        }
                    }

                    const diffText = (
                        (parsed.part && (parsed.part.diff || parsed.part.patch || parsed.part.text)) ||
                        parsed.diff || parsed.patch
                    );

                    if (parsed.part && parsed.part.type && ['diff', 'patch', 'file-diff'].includes(parsed.part.type)) {
                        if (diffText && onEvent) {
                            onEvent({ type: 'diff', text: diffText, sessionId: resolvedSessionId });
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
    }

    private resolveBin(): Promise<string> {
        return this.commandResolver.resolve();
    }

    private buildSpawn(bin: string, args: string[], stdinText?: string): { command: string; args: string[] } {
        return this.commandResolver.buildSpawn(bin, args, stdinText);
    }

    private extractFilesFromEvent(parsed: any): FileSnapshot[] {
        return extractFilesFromEvent(parsed, (message) => this.logUiDebug(message));
    }

    private extractFilesFromToolPart(part: any): FileSnapshot[] {
        return extractFilesFromToolPart(part, (message) => this.logUiDebug(message));
    }

    private extractDeletedPathsFromCommand(command: unknown, cwd: string | undefined): string[] {
        return extractDeletedPathsFromCommand(command, cwd, (message) => this.logUiDebug(message));
    }

    private extractWrittenPathsFromBashCommand(command: unknown, cwd: string | undefined): string[] {
        return extractWrittenPathsFromBashCommand(command, cwd);
    }

    private normalizeIncomingFileSnapshots(files: any[]): FileSnapshot[] {
        return normalizeIncomingFileSnapshots(files);
    }

    private extractPatchText(raw: any): string | undefined {
        return extractPatchText(raw);
    }

    private buildChangeSpecs(files: FileSnapshot[]): FileChangeSpec[] {
        return buildChangeSpecs(files);
    }

    private mergeChangeSpecs(changes: FileChangeSpec[]): FileChangeSpec[] {
        return mergeChangeSpecs(changes);
    }

    private queueTurnChanges(
        sessionId: string,
        turnKey: string,
        tmpKey: string | undefined,
        assistantMsgId: string | undefined,
        changeSpecs: FileChangeSpec[]
    ): void {
        if (!sessionId || !turnKey || !changeSpecs.length) return;
        if (!this.turnStateBySession.has(sessionId)) {
            this.appendPostFinalWatchChanges(sessionId, turnKey, assistantMsgId, changeSpecs);
            return;
        }
        this.markTurnHasWrites(sessionId, 'file-change');
        this.pendingTurnChangesBySession.queue({
            sessionId,
            turnKey,
            tmpKey,
            assistantMsgId,
            changes: changeSpecs,
        });
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
        const normalizedFiles = this.normalizeIncomingFileSnapshots(files);
        const changeSpecs = this.buildChangeSpecs(normalizedFiles);
        this.logUiDebug(`subagent.queue.normalize | sessionId=${mainSessionId} raw=${files.length} normalized=${normalizedFiles.length} specs=${changeSpecs.length}`);
        if (!changeSpecs.length) return;
        const state = this.turnStateBySession.get(mainSessionId);
        const turnKey = state?.pendingUserLocalKey || mainSessionId;
        const tmpKey = state?.pendingAssistantTmpKey;
        const assistantId = state?.assistantMsgId || state?.lastResolvedAssistantMsgId;
        this.queueTurnChanges(mainSessionId, turnKey, tmpKey, assistantId, changeSpecs);
    }

    private async setSessionBaseCommit(sessionId: string, turnKey: string, baseCommit: string, reason: string): Promise<boolean> {
        if (!this.gitUndo) return false;
        try {
            const repo = await this.gitUndo['repoManager'].resolveRepo(sessionId, turnKey || sessionId);
            const map = await this.gitUndo['mapStore'].loadSessionMap(sessionId, repo.repoId);
            await this.gitUndo['mapStore'].saveSessionMap(sessionId, {
                ...map,
                currentBaseCommit: baseCommit
            });
            this.logUiDebug(`[EXT][COMMIT_BASE] update | sessionId=${sessionId} | base=${baseCommit} | reason=${reason}`);
            return true;
        } catch (error) {
            this.logUiDebug(`[EXT][COMMIT_BASE] update.fail | sessionId=${sessionId} | base=${baseCommit} | reason=${reason} | err=${String(error)}`);
            return false;
        }
    }

    public async updateSessionBaseCommitAfterBind(sessionId: string, msgToCommit: string): Promise<boolean> {
        if (!sessionId || !msgToCommit) {
            this.logUiDebug(`[EXT][COMMIT_BASE] update.skip | sessionId=${sessionId || 'null'} | msgToCommit=${msgToCommit || 'null'} | reason=missing-input`);
            return false;
        }
        return this.setSessionBaseCommit(sessionId, sessionId, msgToCommit, 'commit-bind-success');
    }

    public async bindCommitToMessageIds(sessionId: string, input: {
        messageIds: string[];
        commitHash: string;
        baseCommit?: string;
        reason?: string;
    }): Promise<{ ok: boolean; boundIds: string[] }> {
        const boundIds = Array.from(new Set((Array.isArray(input?.messageIds) ? input.messageIds : [])
            .filter((id): id is string => typeof id === 'string' && id.startsWith('msg_'))));
        if (!sessionId || !input?.commitHash || !boundIds.length || !this.gitUndo) {
            this.logUiDebug(`[EXT][COMMIT_BIND_TOPOLOGY] skip | sessionId=${sessionId || 'null'} | reason=${input?.reason || 'missing-input'} | ids=${boundIds.join(',') || 'none'} | commit=${input?.commitHash || 'null'} | base=${input?.baseCommit || 'null'}`);
            return { ok: false, boundIds };
        }
        try {
            const repo = await this.gitUndo['repoManager'].resolveRepo(sessionId, sessionId);
            const map = await this.gitUndo['mapStore'].loadSessionMap(sessionId, repo.repoId);
            const updated = this.gitUndo['mapStore'].bindMessageIdsToCommit(map, boundIds, input.commitHash, input.baseCommit);
            await this.gitUndo['mapStore'].saveSessionMap(sessionId, updated);
            this.logUiDebug(`[EXT][COMMIT_BIND_TOPOLOGY] bound | sessionId=${sessionId} | reason=${input.reason || 'commit-bind'} | ids=${boundIds.join(',')} | commit=${input.commitHash} | base=${input.baseCommit || 'null'}`);
            return { ok: true, boundIds };
        } catch (error) {
            this.logUiDebug(`[EXT][COMMIT_BIND_TOPOLOGY] fail | sessionId=${sessionId} | reason=${input.reason || 'commit-bind'} | ids=${boundIds.join(',') || 'none'} | commit=${input.commitHash} | base=${input.baseCommit || 'null'} | err=${String(error)}`);
            return { ok: false, boundIds };
        }
    }

    private isConcreteAuthoritativePath(value: string): boolean {
        const trimmed = typeof value === 'string' ? value.trim() : '';
        if (!trimmed) return false;
        if (trimmed.startsWith('-')) return false;
        if (/[\r\n]/.test(trimmed)) return false;
        if (/[*?]/.test(trimmed)) return false;
        if (/[|;&<>`'"]/.test(trimmed)) return false;
        return true;
    }

    private parseStatusPorcelainPath(line: string): string | undefined {
        const raw = line.slice(3).trim();
        if (!raw) return undefined;
        const renameArrow = ' -> ';
        const renameIndex = raw.indexOf(renameArrow);
        const selected = renameIndex >= 0 ? raw.slice(renameIndex + renameArrow.length) : raw;
        return selected.replace(/^"|"$/g, '').replace(/\\/g, '/');
    }

    private normalizeConcreteAuthoritativeFiles(authoritativeFiles: string[]): { normalized: string[]; rejectedCount: number } {
        const concreteInputs = authoritativeFiles.filter((file) => this.isConcreteAuthoritativePath(file));
        const normalized = normalizeTouchedFiles(this.workspaceRoot, concreteInputs).sort();
        const rejectedCount = authoritativeFiles.length - normalized.length;
        return { normalized, rejectedCount };
    }

    private async buildValidatedAuthoritativeChangeSpecs(sessionId: string, turnKey: string, authoritativeFiles: string[]): Promise<FileChangeSpec[]> {
        const { normalized, rejectedCount } = this.normalizeConcreteAuthoritativeFiles(authoritativeFiles);
        if (rejectedCount > 0) {
            this.logUiDebug(`[EXT][TURN_COMMIT] auth.paths.reject | sessionId=${sessionId} | rejected=${rejectedCount}`);
        }
        if (!normalized.length || !this.gitUndo) return [];
        const repo = await this.gitUndo['repoManager'].resolveRepo(sessionId, turnKey || sessionId);
        const status = await runGit(repo, ['status', '--porcelain', '--untracked-files=all'], { paths: normalized });
        const allowed = new Set(normalized);
        const byPath = new Map<string, FileChangeSpec>();
        for (const line of (status.stdout || '').split(/\r?\n/)) {
            if (!line.trim()) continue;
            const xy = line.slice(0, 2);
            const statusPath = this.parseStatusPorcelainPath(line);
            if (!statusPath || !allowed.has(statusPath)) continue;
            if (xy.includes('D')) {
                byPath.set(statusPath, { type: 'delete', path: statusPath });
            } else if (xy === '??' || xy.includes('A')) {
                byPath.set(statusPath, { type: 'create', path: statusPath });
            } else if (xy.trim()) {
                byPath.set(statusPath, { type: 'update', path: statusPath });
            }
        }
        const specs = normalized.map((file) => byPath.get(file)).filter((spec): spec is FileChangeSpec => Boolean(spec));
        this.logUiDebug(`[EXT][TURN_COMMIT] auth.validate | sessionId=${sessionId} | input=${authoritativeFiles.length} | normalized=${normalized.length} | delta=${specs.length}`);
        return specs;
    }

    public async commitPendingTurnChanges(sessionId: string, options: CommitPendingTurnChangesOptions = {}): Promise<CommitPendingTurnChangesResult> {
        if (!sessionId) {
            return { status: 'skipped', reason: 'missing-session-id' };
        }
        this.logUiDebug(`[EXT][TURN_COMMIT] start | sessionId=${sessionId}`);
        if (!this.gitUndoAvailable || !this.gitUndo) {
            const result: CommitPendingTurnChangesResult = { status: 'skipped', reason: 'git-undo-unavailable' };
            this.logUiDebug(`[EXT][TURN_COMMIT] result | sessionId=${sessionId} | status=${result.status} | reason=${result.reason}`);
            return result;
        }
        if (!this.isSessionUndoEnabled(sessionId)) {
            const result: CommitPendingTurnChangesResult = { status: 'skipped', reason: 'session-undo-disabled' };
            this.logUiDebug(`[EXT][TURN_COMMIT] result | sessionId=${sessionId} | status=${result.status} | reason=${result.reason}`);
            return result;
        }
        const pending = this.pendingTurnChangesBySession.get(sessionId);
        const hasPendingTurnChanges = Boolean(pending?.changes?.length);
        const authoritativeFiles = Array.isArray(options.authoritativeFiles) ? options.authoritativeFiles : undefined;
        const normalizedAuthoritativeFiles = authoritativeFiles
            ? this.normalizeConcreteAuthoritativeFiles(authoritativeFiles).normalized
            : [];
        const hasAuthoritativeFiles = normalizedAuthoritativeFiles.length > 0;
        if (!hasPendingTurnChanges && !hasAuthoritativeFiles) {
            const result: CommitPendingTurnChangesResult = { status: 'noop', reason: 'no-pending-turn-changes' };
            this.logUiDebug(`[EXT][TURN_COMMIT] result | sessionId=${sessionId} | status=${result.status} | reason=${result.reason}`);
            return result;
        }
        const state = this.turnStateBySession.get(sessionId);
        const turnKey = pending?.turnKey || state?.pendingUserLocalKey || sessionId;
        const tmpKey = state?.pendingAssistantTmpKey || pending?.tmpKey;
        const assistantMsgId = state?.assistantMsgId || state?.lastResolvedAssistantMsgId || pending?.lastAssistantMsgId;
        const messageIndex = assistantMsgId ? this.getMessageIndex(assistantMsgId, sessionId) : undefined;
        const merged = hasAuthoritativeFiles
            ? await this.buildValidatedAuthoritativeChangeSpecs(sessionId, turnKey, normalizedAuthoritativeFiles)
            : this.mergeChangeSpecs(pending?.changes || []);
        if (hasAuthoritativeFiles) {
            this.logUiDebug(`[EXT][TURN_COMMIT] auth.only | sessionId=${sessionId} | pendingSpecs=${pending?.changes?.length || 0} | commitSpecs=${merged.length}`);
        }
        if (!merged.length) {
            const result: CommitPendingTurnChangesResult = {
                status: 'noop',
                reason: hasAuthoritativeFiles ? 'no-authoritative-git-delta' : 'no-pending-turn-changes'
            };
            this.logUiDebug(`[EXT][TURN_COMMIT] result | sessionId=${sessionId} | status=${result.status} | reason=${result.reason}`);
            this.pendingTurnChangesBySession.delete(sessionId);
            return result;
        }
        // this.logUiDebug(`[DBG_TURN_COMMIT] session=${sessionId} turnKey=${turnKey} changes=${merged.length} assistantMsgId=${assistantMsgId || 'null'}`);
        let msgToBaseCommit: string | undefined;
        try {
            try {
                const repo = await this.gitUndo['repoManager'].resolveRepo(sessionId, turnKey || sessionId);
                const map = await this.gitUndo['mapStore'].loadSessionMap(sessionId, repo.repoId);
                msgToBaseCommit = map.currentBaseCommit || map.headCommit;
                if (msgToBaseCommit) {
                    this.lastTurnCommitBaseBySession.set(sessionId, msgToBaseCommit);
                }
                this.logUiDebug(`[EXT][TURN_COMMIT] old-base | sessionId=${sessionId} | msgToBaseCommit=${msgToBaseCommit || 'null'}`);
            } catch (error) {
                const result: CommitPendingTurnChangesResult = { status: 'failed', reason: `old-base-read-failed:${String(error)}` };
                this.logUiDebug(`[EXT][TURN_COMMIT] result | sessionId=${sessionId} | status=${result.status} | reason=${result.reason}`);
                return result;
            }
            if (!msgToBaseCommit) {
                const result: CommitPendingTurnChangesResult = { status: 'failed', reason: 'old-session-base-unavailable' };
                this.logUiDebug(`[EXT][TURN_COMMIT] result | sessionId=${sessionId} | status=${result.status} | reason=${result.reason}`);
                return result;
            }
            const commitResult = await this.gitUndo.commitFileChanges(
                sessionId,
                turnKey,
                tmpKey,
                assistantMsgId,
                merged,
                messageIndex
            );
            if (!commitResult.commitHash) {
                const status: CommitPendingTurnChangesResult['status'] = commitResult.touchedFiles.length ? 'noop' : 'skipped';
                if (status === 'noop' && tmpKey) {
                    const currentState = this.turnStateBySession.get(sessionId);
                    if (currentState?.pendingAssistantTmpKey === tmpKey) {
                        currentState.noCommitTerminalTmpKey = tmpKey;
                    }
                }
                const result: CommitPendingTurnChangesResult = {
                    status,
                    msgToBaseCommit,
                    reason: commitResult.touchedFiles.length ? 'no-commit-produced' : 'no-touched-files-or-baseline-not-ready',
                    touchedFiles: commitResult.touchedFiles
                };
                this.logUiDebug(`[EXT][TURN_COMMIT] result | sessionId=${sessionId} | status=${result.status} | reason=${result.reason} | msgToBaseCommit=${msgToBaseCommit} | touchedFiles=${commitResult.touchedFiles.length}`);
                return result;
            }
            await this.setSessionBaseCommit(sessionId, turnKey, msgToBaseCommit, 'awaiting-commit-bind');
            const result: CommitPendingTurnChangesResult = {
                status: 'committed',
                msgToBaseCommit,
                msgToCommit: commitResult.commitHash,
                touchedFiles: commitResult.touchedFiles
            };
            this.logUiDebug(`[EXT][TURN_COMMIT] result | sessionId=${sessionId} | status=${result.status} | msgToBaseCommit=${msgToBaseCommit} | msgToCommit=${commitResult.commitHash} | touchedFiles=${commitResult.touchedFiles.length}`);
            return result;
        } catch (error) {
            this.logUiDebug(`[EXT][TURN_COMMIT] result | sessionId=${sessionId} | status=failed | reason=${String(error)} | msgToBaseCommit=${msgToBaseCommit || 'null'}`);
            return { status: 'failed', msgToBaseCommit, reason: String(error) };
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

    private getScopedMessageIndexMap(sessionId?: string): Map<string, number> {
        if (!sessionId) return this.messageIndexById;
        let map = this.messageIndexByIdBySession.get(sessionId);
        if (!map) {
            map = new Map<string, number>();
            this.messageIndexByIdBySession.set(sessionId, map);
        }
        return map;
    }

    private getScopedMessageOrder(sessionId?: string): string[] {
        if (!sessionId) return this.messageOrder;
        let order = this.messageOrderBySession.get(sessionId);
        if (!order) {
            order = [];
            this.messageOrderBySession.set(sessionId, order);
        }
        return order;
    }

    private getReadonlyMessageIndexMap(sessionId?: string): Map<string, number> {
        return sessionId ? (this.messageIndexByIdBySession.get(sessionId) || new Map<string, number>()) : this.messageIndexById;
    }

    private getReadonlyMessageOrder(sessionId?: string): string[] {
        return sessionId ? (this.messageOrderBySession.get(sessionId) || []) : this.messageOrder;
    }

    private registerMessageId(messageId: string, sessionId?: string): number {
        if (!messageId || (!messageId.startsWith('msg_') && !messageId.startsWith('local-'))) {
            return this.getReadonlyMessageIndexMap(sessionId).get(messageId) ?? this.messageIndexById.get(messageId) ?? -1;
        }
        const scopedMap = this.getScopedMessageIndexMap(sessionId);
        const scopedOrder = this.getScopedMessageOrder(sessionId);
        const existing = scopedMap.get(messageId);
        if (existing !== undefined) return existing;
        const index = scopedOrder.length;
        scopedMap.set(messageId, index);
        scopedOrder.push(messageId);
        if (!this.messageIndexById.has(messageId)) {
            this.messageIndexById.set(messageId, this.nextMessageIndex++);
            this.messageOrder.push(messageId);
        }
        return index;
    }

    public registerMessage(messageId: string, sessionId?: string): number {
        return this.registerMessageId(messageId, sessionId);
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

    public getMessageIndex(messageId: string, sessionId?: string): number | undefined {
        return this.getReadonlyMessageIndexMap(sessionId).get(messageId) ?? (!sessionId ? undefined : this.messageIndexById.get(messageId));
    }

    public getMessageIndexMap(sessionId?: string): Array<{ messageId: string; messageIndex: number }> {
        return Array.from(this.getReadonlyMessageIndexMap(sessionId).entries())
            .filter(([messageId]) => messageId.startsWith('msg_'))
            .map(([messageId, messageIndex]) => ({
                messageId,
                messageIndex
            }));
    }

    public getUndoRangeForAnchor(startMessageId: string, sessionId?: string): { startIndex: number; endIndex: number } | undefined {
        const indexMap = this.getReadonlyMessageIndexMap(sessionId);
        const order = this.getReadonlyMessageOrder(sessionId);
        const startIndex = indexMap.get(startMessageId);
        if (typeof startIndex !== 'number') return undefined;
        const tailIndex = order.length ? order.length - 1 : startIndex;
        let effectiveEndIndex = tailIndex;
        const prevSeg = sessionId ? this.revertedSegmentBySession.get(sessionId) : undefined;
        const hasActivePrev = Boolean(prevSeg && prevSeg.isActive && !prevSeg.discarded);
        if (hasActivePrev && prevSeg) {
            const prevStartIndex = typeof prevSeg.startMessageIndex === 'number'
                ? prevSeg.startMessageIndex
                : indexMap.get(prevSeg.startMessageId);
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

    private rememberSessionMessageAlias(sessionId: string, existingId: string, newId: string): void {
        if (!sessionId) return;
        const existingIsLocal = existingId.startsWith('local-');
        const newIsLocal = newId.startsWith('local-');
        const existingIsServer = existingId.startsWith('msg_');
        const newIsServer = newId.startsWith('msg_');
        if (!((existingIsLocal && newIsServer) || (existingIsServer && newIsLocal))) return;
        let aliasMap = this.messageIdAliasBySession.get(sessionId);
        if (!aliasMap) {
            aliasMap = new Map<string, string>();
            this.messageIdAliasBySession.set(sessionId, aliasMap);
        }
        aliasMap.set(existingId, newId);
        aliasMap.set(newId, existingId);
    }

    public aliasMessageId(existingId: string, newId: string): void {
        const aliasIn = (indexMap: Map<string, number>, order: string[], sessionId?: string) => {
            const existingIndex = indexMap.get(existingId);
            if (existingIndex === undefined || indexMap.has(newId)) return;
            indexMap.set(newId, existingIndex);
            const orderIndex = order.indexOf(existingId);
            if (orderIndex !== -1) order[orderIndex] = newId;
            indexMap.delete(existingId);
            if (sessionId) this.rememberSessionMessageAlias(sessionId, existingId, newId);
        };
        aliasIn(this.messageIndexById, this.messageOrder);
        for (const [sessionId, indexMap] of this.messageIndexByIdBySession.entries()) {
            aliasIn(indexMap, this.messageOrderBySession.get(sessionId) || [], sessionId);
        }
    }

    public upgradeMessageId(localKey: string, serverMsgId: string): boolean {
        let upgraded = false;
        const upgradeIn = (indexMap: Map<string, number>, order: string[]) => {
            const existingIndex = indexMap.get(localKey);
            if (existingIndex === undefined || indexMap.has(serverMsgId)) return;
            indexMap.set(serverMsgId, existingIndex);
            const orderIndex = order.indexOf(localKey);
            if (orderIndex !== -1) order[orderIndex] = serverMsgId;
            indexMap.delete(localKey);
            upgraded = true;
        };
        upgradeIn(this.messageIndexById, this.messageOrder);
        for (const [sessionId, indexMap] of this.messageIndexByIdBySession.entries()) {
            upgradeIn(indexMap, this.messageOrderBySession.get(sessionId) || []);
        }
        return upgraded;
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


    private getMessageIdsInRange(startIndex: number, endIndex: number, sessionId?: string): string[] {
        const indexMap = this.getReadonlyMessageIndexMap(sessionId);
        const order = this.getReadonlyMessageOrder(sessionId);
        return order.filter((id) => {
            if (typeof id !== 'string' || !id.startsWith('msg_')) return false;
            const index = indexMap.get(id);
            return typeof index === 'number' && index >= startIndex && index <= endIndex;
        });
    }

    private orderedUnionMessageIds(currentIds: string[], previousIds: string[], sessionId?: string): string[] {
        const indexMap = this.getReadonlyMessageIndexMap(sessionId);
        const merged = new Set<string>();
        for (const id of currentIds) {
            if (typeof id === 'string' && id.startsWith('msg_')) merged.add(id);
        }
        for (const id of previousIds) {
            if (typeof id === 'string' && id.startsWith('msg_')) merged.add(id);
        }
        return Array.from(merged).sort((a, b) => {
            const ai = indexMap.get(a);
            const bi = indexMap.get(b);
            const av = typeof ai === 'number' ? ai : Number.MAX_SAFE_INTEGER;
            const bv = typeof bi === 'number' ? bi : Number.MAX_SAFE_INTEGER;
            return av - bv;
        });
    }

    public getRevertedSegment(sessionId: string): RevertedSegment | undefined {
        return sessionId ? this.revertedSegmentBySession.get(sessionId) : undefined;
    }

    public setRevertedSegment(sessionId: string, segment: RevertedSegment | undefined): void {
        if (!sessionId) return;
        if (segment) {
            this.revertedSegmentBySession.set(sessionId, segment);
        } else {
            this.revertedSegmentBySession.delete(sessionId);
        }
    }

    private isValidActiveRevertedSegmentForUndo(prevSeg: RevertedSegment | undefined, startIndex: number, sessionId?: string): prevSeg is RevertedSegment {
        const indexMap = this.getReadonlyMessageIndexMap(sessionId);
        if (!prevSeg || !prevSeg.isActive || prevSeg.discarded) return false;
        const memberMsgIds = Array.isArray(prevSeg.messageIds)
            ? prevSeg.messageIds.filter((id) => typeof id === 'string' && id.startsWith('msg_'))
            : [];
        if (!memberMsgIds.length) return false;
        const prevStartIndex = typeof prevSeg.startMessageIndex === 'number'
            ? prevSeg.startMessageIndex
            : indexMap.get(prevSeg.startMessageId);
        if (typeof prevStartIndex !== 'number') return false;
        if (prevStartIndex <= startIndex) return false;
        return memberMsgIds.every((id) => typeof indexMap.get(id) === 'number');
    }

    private resolveOperationOrderFallback(startMessageId: string, options?: { visibleMessageIds?: string[]; forwardMessageIdsFromAnchor?: string[] }): string[] {
        const sanitize = (ids: unknown): string[] => Array.isArray(ids)
            ? ids.filter((id): id is string => typeof id === 'string' && id.startsWith('msg_'))
            : [];
        const forward = sanitize(options?.forwardMessageIdsFromAnchor);
        if (forward.length && forward[0] === startMessageId) return Array.from(new Set(forward));
        const visible = sanitize(options?.visibleMessageIds);
        const anchorIndex = visible.indexOf(startMessageId);
        if (anchorIndex >= 0) return Array.from(new Set(visible.slice(anchorIndex)));
        return [];
    }

    public async undoFromMessage(startMessageId: string, options: { sessionId: string; force?: boolean; excludedMessageIds?: string[]; visibleMessageIds?: string[]; forwardMessageIdsFromAnchor?: string[] }): Promise<{ conflicts: ConflictDetail[]; touchedFiles: string[]; applied: boolean; reason?: string }> {
        const force = options?.force === true;
        const excludedMessageIds = new Set(
            Array.isArray(options?.excludedMessageIds)
                ? options!.excludedMessageIds.filter((id) => typeof id === 'string' && id.startsWith('msg_'))
                : []
        );
        const explicitSessionId = typeof options.sessionId === 'string' && options.sessionId.trim()
            ? options.sessionId.trim()
            : undefined;
        if (!explicitSessionId) {
            throw new Error('Missing session ID for undo.');
        }
        const sessionId = explicitSessionId;
        const sessionOrder = this.getReadonlyMessageOrder(explicitSessionId);
        const sessionIndexMap = this.getReadonlyMessageIndexMap(explicitSessionId);
        const fallbackOrder = this.resolveOperationOrderFallback(startMessageId, options);
        const hasSessionCache = Boolean(explicitSessionId && sessionOrder.length && sessionIndexMap.size);
        const cacheStartIndex = sessionIndexMap.get(startMessageId);
        const useFallbackOrder = explicitSessionId && cacheStartIndex === undefined && fallbackOrder.length > 0;
        const orderSource = cacheStartIndex !== undefined ? 'session-cache' : useFallbackOrder ? 'webview-visible' : 'missing';
        const activeOrder = useFallbackOrder ? fallbackOrder : explicitSessionId ? sessionOrder : this.messageOrder;
        const activeIndexMap = useFallbackOrder
            ? new Map(fallbackOrder.map((id, index) => [id, index] as [string, number]))
            : explicitSessionId ? sessionIndexMap : this.messageIndexById;
        const startIndex = activeIndexMap.get(startMessageId);
        this.logUiDebug(`EXT: undo.enter | startMessageId | ${startMessageId || 'null'} | force | ${String(force)} | hasSession | ${String(Boolean(sessionId))} | explicitSession | ${explicitSessionId || 'null'} | currentSession | ${this.currentSessionId || 'null'} | messageOrderLen | ${activeOrder.length} | undo.order.source=${orderSource}`);
        this.logUiDebug(`EXT: undo.order.source=${orderSource} | sessionId=${explicitSessionId} | cacheOrderLen=${sessionOrder.length} | cacheMapSize=${sessionIndexMap.size} | fallbackOrderLen=${fallbackOrder.length}`);
        if (startIndex === undefined) {
            const reason = !startMessageId?.startsWith('msg_')
                ? 'invalid-anchor-id'
                : !sessionId
                    ? 'missing-session'
                    : hasSessionCache
                        ? 'anchor-not-in-session-cache'
                        : fallbackOrder.length
                            ? 'anchor-not-in-ui-visible-order'
                            : 'missing-session-cache-and-ui-order';
            this.logUiDebug(`EXT: undo.anchor.missing | startMessageId | ${startMessageId || 'null'} | startsWithMsg | ${String(startMessageId?.startsWith('msg_'))} | sessionId | ${sessionId || 'null'} | reason | ${reason} | undo.order.source=${orderSource}`);
            throw new Error('Unknown message for undo.');
        }
        this.logUiDebug(`EXT: undo.anchor.ok | startMessageId | ${startMessageId} | startIndex | ${startIndex} | undo.order.source=${orderSource}`);
        const tailIndex = activeOrder.length ? activeOrder.length - 1 : startIndex;
        let effectiveEndIndex = tailIndex;
        const prevSeg = explicitSessionId ? this.revertedSegmentBySession.get(explicitSessionId) : undefined;
        const hasActivePrev = !useFallbackOrder && this.isValidActiveRevertedSegmentForUndo(prevSeg, startIndex, explicitSessionId);
        let prevStartIndex: number | undefined;
        let prevEndIndex: number | undefined;
        let canMergePrev = false;
        if (hasActivePrev && prevSeg) {
            prevStartIndex = typeof prevSeg.startMessageIndex === 'number'
                ? prevSeg.startMessageIndex
                : activeIndexMap.get(prevSeg.startMessageId);
            prevEndIndex = typeof prevSeg.endMessageIndex === 'number'
                ? prevSeg.endMessageIndex
                : activeIndexMap.get(prevSeg.endMessageId);
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

        const messageIds = (useFallbackOrder
            ? activeOrder.filter((id) => {
                const index = activeIndexMap.get(id);
                return typeof index === 'number' && index >= startIndex && index <= effectiveEndIndex;
            })
            : this.getMessageIdsInRange(startIndex, effectiveEndIndex, explicitSessionId))
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
                ? this.orderedUnionMessageIds(messageIds, Array.isArray(prevSeg.messageIds) ? prevSeg.messageIds : [], explicitSessionId)
                : messageIds;
            if (mergedMessageIds.length) {
                mergedEndId = mergedMessageIds[mergedMessageIds.length - 1];
            }
            const mergedEndIndex = activeIndexMap.get(mergedEndId) ?? effectiveEndIndex;

            if (!explicitSessionId) {
                return { conflicts: [], touchedFiles, applied: false, reason: 'missing-session' };
            }
            this.revertedSegmentBySession.set(explicitSessionId, {
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
            });
            this.logUiDebug(`EXT: undo.segment.merged | startIndex | ${startIndex} | endIndex | ${mergedEndIndex} | startId | ${startMessageId} | endId | ${mergedEndId} | messageIds | ${mergedMessageIds.length}`);
            return { conflicts: [], touchedFiles: result.touchedFiles, applied: result.applied, reason: result.reason };
        }
        return { conflicts: [], touchedFiles, applied: false, reason: 'git-undo-unavailable' };
    }

    public async restoreAll(options?: { force?: boolean; sessionId?: string }): Promise<{ conflicts: ConflictDetail[]; touchedFiles: string[]; applied: boolean }> {
        const sessionId = typeof options?.sessionId === 'string' && options.sessionId ? options.sessionId : this.currentSessionId;
        if (!sessionId) {
            return { conflicts: [], touchedFiles: [], applied: false };
        }
        const segment = this.revertedSegmentBySession.get(sessionId);
        if (!segment || segment.discarded) {
            throw new Error('No active reverted segment to restore.');
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
        options?: { force?: boolean; sessionId?: string; messageIds?: string[]; excludedMessageIds?: string[] }
    ): Promise<{ conflicts: ConflictDetail[]; touchedFiles: string[]; applied: boolean }> {
        const sessionId = typeof options?.sessionId === 'string' && options.sessionId ? options.sessionId : this.currentSessionId;
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

    public discardRevertedSegment(sessionId: string): void {
        const segment = this.revertedSegmentBySession.get(sessionId);
        if (!segment?.isActive) return;
        segment.discarded = true;
        segment.isActive = false;
        segment.collapsed = true;
    }

    public setRevertedSegmentCollapsed(sessionId: string, collapsed: boolean): void {
        const segment = this.revertedSegmentBySession.get(sessionId);
        if (!segment) return;
        segment.collapsed = collapsed;
    }

    public removeMessageId(messageId: string): void {
        this.messageIndexById.delete(messageId);
        this.messageOrder = this.messageOrder.filter((id) => id !== messageId);
        for (const [sessionId, indexMap] of this.messageIndexByIdBySession.entries()) {
            if (!indexMap.has(messageId)) continue;
            const order = (this.messageOrderBySession.get(sessionId) || []).filter((id) => id !== messageId);
            this.messageOrderBySession.set(sessionId, order);
            indexMap.clear();
            order.forEach((id, index) => indexMap.set(id, index));
        }
        this.assistantTextLengths.delete(messageId);
        this.assistantTextLengthsByPart.delete(messageId);
        for (const key of Array.from(this.assistantTextLengthsByPart.keys())) {
            if (key.startsWith(`${messageId}:`)) {
                this.assistantTextLengthsByPart.delete(key);
            }
        }
        this.assistantTextById.delete(messageId);
        for (const set of this.ignoredSummaryMessageIdsBySession.values()) {
            set.delete(messageId);
        }
    }

    private getAssistantTextLengthPartKey(msgId: string, part: any): string {
        const partId = typeof part?.id === 'string' && part.id.length > 0 ? part.id : '';
        return partId ? `${msgId}:${partId}` : msgId;
    }

    private appendAssistantText(msgId: string, chunk: string): void {
        if (!msgId || !chunk) return;
        const existing = this.assistantTextById.get(msgId) || '';
        if (existing.length >= this.assistantTextCacheMax) return;
        const next = (existing + chunk).slice(0, this.assistantTextCacheMax);
        this.assistantTextById.set(msgId, next);
        this.assistantTextLengths.set(
            msgId,
            Math.max(this.assistantTextLengths.get(msgId) || 0, next.length),
        );
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

    private async getServerConn(forceRefresh = false): Promise<ServerConnection> {
        return this.serverLocks.getConnection(forceRefresh);
    }

    private async serverFetch(
        reqPath: string,
        init: RequestInit = {},
        options?: ServerFetchOptions
    ): Promise<Response> {
        return this.httpClient.fetch(reqPath, init, options);
    }

    private async checkServerHealth(port: number, password: string, timeoutMs = 1000): Promise<'ok' | 'unauthorized' | 'timeout' | 'connrefused' | 'unreachable'> {
        return this.serverController.checkHealth(this.workspaceRoot, port, password, timeoutMs);
    }

    public async shutdownServer(): Promise<void> {
        await this.serverController.shutdown();
    }

    private async buildServeSpawn(args: string[]): Promise<{ command: string; args: string[] }> {
        const bin = await this.resolveBin();
        return this.buildSpawn(bin, args);
    }

    private async requestJson<T>(method: string, path: string, body?: any): Promise<T> {
        return this.httpClient.requestJson<T>(method, path, body);
    }

    private parseModelRef(model?: string): { providerID: string; modelID: string } | undefined {
        if (!model) return undefined;
        const parts = model.split('/');
        if (parts.length < 2) return undefined;
        return { providerID: parts[0], modelID: parts.slice(1).join('/') };
    }

    private connectEventStream(): void {
        this.eventStream.connect();
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

    public addChatEventListener(listener: (event: ChatEvent) => void): () => void {
        this.eventListeners.add(listener);
        return () => {
            this.eventListeners.delete(listener);
        };
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
            parentId,
            phase,
            lane
        };
        if (lane === 'subagent' && sessionId) {
            const parentSessionId = this.getParentSessionForSubagent(sessionId);
            if (parentSessionId) {
                evt.parentSessionId = parentSessionId;
                evt.agentSessionId = sessionId;
                evt.displayTarget = 'agent-lane';
                this.logUiDebug(`[EXT][SUBAGENT_ROUTE] phase=assistantPhase parentSessionId=${parentSessionId} agentSessionId=${sessionId} displayTarget=agent-lane reason=${reason}`);
            } else {
                this.logUiDebug(`[EXT][SUBAGENT_ROUTE_DROP] phase=assistantPhase reason=missing-parent parentSessionId=null agentSessionId=${sessionId} displayTarget=agent-lane`);
            }
        }
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

    public async fetchModelQuota(model: ModelInfo, force = false): Promise<ModelQuota | null> {
        return this.modelQuotaService.fetch(model, { force });
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
        const isContinuationHiddenControlParent =
            typeof parentId === 'string'
            && this.isHiddenControlUserMsgId(sessionId, parentId)
            && (() => {
                const chain = this.continuationChainsBySession.get(sessionId);
                return chain?.state === 'bootstrap_buffering' || chain?.state === 'continuation_active' || chain?.state === 'revive_armed';
            })();
        if (lockedMsgId && msgId && msgId !== lockedMsgId) {
            this.logUiDebug(`EXT: finalizing.ignore | sessionId=${sessionId} | msgId=${msgId} | reason=not-locked`);
            return false;
        }
        if (!lockedMsgId) {
            this.task1Metrics.parentMismatchChecks += 1;
            if (!this.isAcceptedTurnParent(sessionId, parentId, currentUser, isContinuationHiddenControlParent)) {
                this.task1Metrics.parentMismatchCount += 1;
                this.logUiDebug(`EXT: finalizing.ignore | sessionId=${sessionId} | msgId=${msgId || 'null'} | reason=parent-mismatch`);
                return false;
            }
        }
        if (this.hasRunningToolsForMessage(msgId)) return false;
        return true;
    }

    private isAcceptedTurnParent(
        sessionId: string,
        parentId: unknown,
        currentUser: string | undefined,
        isContinuationHiddenControlParent: boolean
    ): boolean {
        if (typeof parentId !== 'string') return false;
        if (typeof currentUser === 'string' && parentId === currentUser) return true;
        if (isContinuationHiddenControlParent) return true;
        const appendState = this.appendTurnStateBySession.get(sessionId);
        if (!appendState) return false;
        if (parentId === appendState.rootUserMsgId) return true;
        return appendState.appendUserMsgIds.has(parentId);
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
        if (this.turnStateBySession.has(sessionId)) return 'main';
        if (sessionId === this.currentSessionId) {
            this.logUiDebug(`[EXT][SUBAGENT_ROUTE_DROP] phase=classify reason=current-session-fallback-disabled parentSessionId=null agentSessionId=${sessionId} displayTarget=parent`);
        }
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

    private resolveBackgroundPulseTarget(sessionId: string, lane: EventLane): { targetSessionId: string; parentSessionId: string; agentSessionId?: string; anchorAssistantId: string | undefined; displayTarget: 'parent' } | undefined {
        const mappedParent = this.stablePulseRootSessionBySubagent.get(sessionId)
            || this.subagentToParentSessionMap.get(sessionId);
        const isKnownSubagent = lane === 'subagent' || this.subagentToParentSessionMap.has(sessionId) || this.stablePulseRootSessionBySubagent.has(sessionId);
        if (isKnownSubagent && !mappedParent) {
            this.logUiDebug(`[EXT][SUBAGENT_ROUTE_DROP] phase=pulse reason=missing-parent parentSessionId=null agentSessionId=${sessionId} displayTarget=parent`);
            return undefined;
        }
        if (!mappedParent && lane === 'unknown') {
            this.logUiDebug(`[EXT][SUBAGENT_ROUTE_DROP] phase=pulse reason=unknown-session-parent parentSessionId=null agentSessionId=${sessionId} displayTarget=parent`);
            return undefined;
        }
        const targetSessionId = mappedParent || sessionId;
        const anchorAssistantId = this.postFinalWatchStateBySession.get(targetSessionId)?.ownerMsgId
            || this.turnFinalMsgIdBySession.get(targetSessionId)
            || this.finalizingMsgIdBySession.get(targetSessionId)
            || this.currentTurnAssistantMsgIdBySession.get(targetSessionId)
            || this.turnStateBySession.get(targetSessionId)?.assistantMsgId
            || undefined;
        const route = {
            targetSessionId,
            parentSessionId: targetSessionId,
            agentSessionId: mappedParent ? sessionId : undefined,
            anchorAssistantId,
            displayTarget: 'parent' as const
        };
        this.logUiDebug(`[EXT][SUBAGENT_ROUTE] phase=pulse parentSessionId=${route.parentSessionId} agentSessionId=${route.agentSessionId || 'null'} displayTarget=parent reason=resolved`);
        return route;
    }

    private mapServerEventToChatEvents(type: string, props: any, source: EventSource = 'sse'): ChatEvent[] {
        return mapServerEventToChatEvents(this, type, props, source);
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
        const now = Date.now();
        const lastProgressAt = this.lastProgressAtBySession.get(sessionId) || now;
        const stallMs = now - lastProgressAt;
        if (hasBlocker) {
            const pauseReason = hasRunningTools ? 'interactive-blocker+tool-running' : 'interactive-blocker';
            this.pauseResyncStallTracking(sessionId, pauseReason, progressKey);
            return;
        }
        if (hasRunningTools && stallMs < this.toolRunningAutoResumeMs) {
            this.pauseResyncStallTracking(sessionId, 'tool-running', progressKey);
            return;
        }

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
                .finally(async () => {
                    this.resyncInFlightBySession.delete(targetSessionId);
                    this.resyncCooldownUntilBySession.set(targetSessionId, Date.now() + this.resyncCooldownMs);
                    if (this.turnFinalAtBySession.has(targetSessionId) && this.finalizingMsgIdBySession.has(targetSessionId)) {
                        this.logUiDebug(`EXT: resync.settle-handoff | sessionId=${targetSessionId} | reason=final-locked`);
                        await this.runResyncSettleCheck(targetSessionId, 'resync-final-locked');
                        return;
                    }
                    // Secondary FP detection: turnFinalAt set but finalizingMsgId is NOT set
                    if (this.turnFinalAtBySession.has(targetSessionId) && !this.finalizingMsgIdBySession.has(targetSessionId)) {
                        this.logUiDebug(`EXT: fp.detect | sessionId=${targetSessionId} | location=resync-finally | reason=${reason}`);
                        this.resetFalsePositiveFinal(targetSessionId, `resync:${reason}`);
                        return;
                    }
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
                    const messageIndex = this.registerMessage(messageId, sessionId);
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
        options: { model?: string; variant?: string; sessionId: string; continueSession?: boolean; files?: ChatFilePart[]; mode?: string },
        onEvent?: (event: ChatEvent) => void
    ): Promise<void> {
        await this.ensureServer();
        const sessionId = options.sessionId.trim();
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
            payload.parts.push(...options.files.map((file) => {
                if (typeof file === 'string') {
                    return { type: 'file', path: file };
                }
                return {
                    type: 'file',
                    mime: file.mime,
                    url: file.url
                };
            }));
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

    public async appendPrompt(
        sessionId: string,
        message: string,
        options: { model?: string; mode?: string; clientMessageId?: string; rootUserMsgId?: string } = {}
    ): Promise<void> {
        await this.ensureServer();
        if (!sessionId) {
            throw new Error('Missing session ID for append request.');
        }
        const rootUserMsgId = typeof options.rootUserMsgId === 'string' && options.rootUserMsgId
            ? options.rootUserMsgId
            : undefined;
        if (!this.canAppendToCurrentTurn(sessionId, rootUserMsgId)) {
            throw new Error('This turn can no longer be appended to.');
        }
        const clientMessageId = typeof options.clientMessageId === 'string' ? options.clientMessageId : '';
        if (clientMessageId) {
            const appendState = this.appendTurnStateBySession.get(sessionId);
            const pending = appendState?.pending.some((item) => item.clientMessageId === clientMessageId && !item.serverMsgId);
            if (!pending) {
                throw new Error('This append request is no longer pending.');
            }
        }
        const payload: any = {
            parts: [{ type: 'text', text: message }]
        };
        const modelRef = this.parseModelRef(options.model);
        if (modelRef) {
            payload.model = modelRef;
        }
        if (typeof options.mode === 'string' && options.mode) {
            payload.agent = options.mode;
            this.expectedMainAgentBySession.set(sessionId, options.mode);
        }
        await this.requestJson('POST', `/session/${sessionId}/prompt_async`, payload);
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
        const base = this.serverController.getBaseUrl();
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
        sessionId: string;
        callId: string;
        requestId?: string;
        result: unknown;
    }): Promise<void> {
        await this.ensureServer();
        const sessionId = payload.sessionId.trim();
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
        sessionId: string;
        permissionId?: string;
        requestId?: string;
        response: PermissionReply;
    }): Promise<void> {
        await this.ensureServer();
        const sessionId = payload.sessionId.trim();
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
                    const contextLimitRaw = model?.limit?.context;
                    const contextLimit = Number.isFinite(Number(contextLimitRaw)) ? Number(contextLimitRaw) : undefined;
                    models.push({ id, providerId, name, fullId, variants, contextLimit });
                }
            }
            if (models.length) {
                break;
            }
            attempts += 1;
            await new Promise((resolve) => setTimeout(resolve, 300));
        }
        await this.applyCopilotSpeedMultipliers(models);
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
            cwd: typeof session?.path?.cwd === 'string'
                ? session.path.cwd
                : (typeof session?.cwd === 'string' ? session.cwd : undefined),
            parentID: typeof session?.parentID === 'string' && session.parentID
                ? session.parentID
                : undefined,
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

    public async summarizeSession(
        sessionId: string,
        options: { providerID: string; modelID: string; auto?: boolean }
    ): Promise<boolean> {
        await this.ensureServer();
        const payload = {
            providerID: options.providerID,
            modelID: options.modelID,
            auto: options.auto === true
        };
        const result = await this.requestJson<any>('POST', `/session/${sessionId}/summarize`, payload);
        return Boolean(result);
    }

    public async fetchSessionUsage(sessionId: string): Promise<{ used: number; size: number; amount: number } | null> {
        await this.ensureServer();
        try {
            const statusMap = await this.requestJson<Record<string, any>>('GET', '/session/status');
            const status = statusMap?.[sessionId];
            if (!status || typeof status !== 'object') return null;
            const usageCarrier = status?.update || status;
            const usedRaw = usageCarrier?.used ?? status?.used;
            const sizeRaw = usageCarrier?.size ?? status?.size;
            const amountRaw = usageCarrier?.cost?.amount ?? status?.cost?.amount;
            const used = Number(usedRaw);
            const size = Number(sizeRaw);
            const amount = Number(amountRaw);
            if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0) return null;
            return {
                used: used > 0 ? used : 0,
                size,
                amount: Number.isFinite(amount) ? amount : 0
            };
        } catch {
            return null;
        }
    }

    public cancel(): void {
        const sessionId = this.currentSessionId;
        if (!sessionId) return;
        void this.requestJson('POST', `/session/${sessionId}/abort`, {});
    }

    public async abortSession(sessionId: string): Promise<void> {
        if (!sessionId) return;
        await this.ensureServer();
        await this.requestJson('POST', `/session/${encodeURIComponent(sessionId)}/abort`, {});
    }

    public async dispose(): Promise<void> {
        if (this.disposePromise) return this.disposePromise;
        this.disposePromise = (async () => {
            while (true) {
                const pending = Array.from(this.continuationPersistBySession.values());
                if (pending.length) {
                    await Promise.allSettled(pending);
                    continue;
                }
                await Promise.resolve();
                if (!this.continuationPersistBySession.size) break;
            }
            this.resetSessionState();
            this.eventListeners.clear();
            this.serverStatusHandler = undefined;
            await this.shutdownServer();
        })();
        return this.disposePromise;
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
                const contextLimitRaw = parsed?.limit?.context;
                const contextLimit = Number.isFinite(Number(contextLimitRaw)) ? Number(contextLimitRaw) : undefined;
                models.push({ id, providerId, name, fullId, variants, contextLimit });
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

    private async applyCopilotSpeedMultipliers(models: ModelInfo[]): Promise<void> {
        const hasCopilot = models.some((model) => {
            const provider = (model.providerId || '').toLowerCase();
            const fullId = (model.fullId || '').toLowerCase();
            return provider.includes('copilot') || fullId.includes('copilot');
        });
        if (!hasCopilot) return;

        const remoteSpeedMap = await this.getCopilotSpeedMultiplierCache().then((cache) => {
            const map = new Map<string, string>();
            for (const [key, value] of Object.entries(cache.multipliers || {})) {
                map.set(normalizeCopilotModelKey(key), value);
            }
            return map;
        });
        const fallbackSpeedMap = getLocalCopilotSpeedMultiplierMap();

        for (const model of models) {
            const keys = getCopilotSpeedMultiplierKeys(model);
            const speed =
                keys.map((key) => remoteSpeedMap.get(key)).find((value) => typeof value === 'string' && value.length > 0) ||
                keys.map((key) => fallbackSpeedMap.get(key)).find((value) => typeof value === 'string' && value.length > 0);
            model.speedMultiplier = speed || inferCopilotSpeedMultiplier(model) || model.speedMultiplier;
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


