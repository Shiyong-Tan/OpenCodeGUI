import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as crypto from 'crypto';
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

export type SessionInfo = {
    id: string;
    title: string;
    updated: string;
};

export type ChatEvent = {
    type: 'text' | 'session' | 'raw' | 'permission' | 'diff' | 'message' | 'error' | 'toolPatch' | 'files' | 'assistantMessageMeta';
    text?: string;
    sessionId?: string;
    files?: FileSnapshot[];
    messageId?: string;
    messageIndex?: number;
    lastText?: string;
    assistantMsgId?: string;
    tmpKey?: string;
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

export class OpenCodeClient {
    public static outputChannel = vscode.window.createOutputChannel("OpenCode CLI");
    private currentChild?: cp.ChildProcess;
    private serverProcess?: cp.ChildProcess;
    private serverBaseUrl?: string;
    private serverPort?: number;
    private serverStartPromise?: Promise<void>;
    private workspaceRoot: string;
    private storage?: vscode.Memento;
    private serverPid?: number;
    private serverPassword?: string;
    private serverLockCache?: { lock: ServerLock; baseUrl: string; authHeader: string; mtimeMs: number };
    private eventStreamAbort?: AbortController;
    private eventStreamActive = false;
    private eventStreamBackoffMs = 1000;
    private readonly eventListeners = new Set<(event: ChatEvent) => void>();
    private readonly sessionIdleWaiters = new Map<string, Array<() => void>>();
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
    private gitUndo?: GitUndoEngine;
    private gitUndoAvailable = false;
    private sessionUndoEnabled = new Map<string, boolean>();
    private assistantTextLengths = new Map<string, number>();
    private assistantHasDelta = new Set<string>();
    private assistantStatusCleared = new Set<string>();
    private messageRoleById = new Map<string, string>();
    private lastCwdBySession = new Map<string, string>();
    private canceledActiveTurnBySession = new Map<string, boolean>();
    private activeTurnOpIdBySession = new Map<string, string>();
    private pendingUserMsgIdBySession = new Map<string, string>();
    private pendingAssistantMsgIdBySession = new Map<string, string>();

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
        this.assistantHasDelta.clear();
        this.assistantStatusCleared.clear();
        this.messageRoleById.clear();
        this.lastCwdBySession.clear();
        this.canceledActiveTurnBySession.clear();
        this.activeTurnOpIdBySession.clear();
        this.pendingUserMsgIdBySession.clear();
        this.pendingAssistantMsgIdBySession.clear();
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

    public startTurn(sessionId: string, pendingUserLocalKey: string): void {
        if (!sessionId) return;
        this.canceledActiveTurnBySession.set(sessionId, false);
        const pending = this.pendingTurnChangesBySession.get(sessionId);
        if (pending?.changes?.length) {
            // this.logUiDebug(`[DBG_TURN_START] session=${sessionId} pendingChanges=${pending.changes.length} cleared=true`);
            this.pendingTurnChangesBySession.delete(sessionId);
        }
        const existing = this.turnStateBySession.get(sessionId);
        this.turnStateBySession.set(sessionId, {
            pendingUserLocalKey,
            pendingAssistantTmpKey: existing?.pendingAssistantTmpKey,
            assistantMsgId: existing?.assistantMsgId,
            exportInFlight: false,
            exportResolved: false,
            resolvedUserMsgId: undefined,
            lastResolvedAssistantMsgId: undefined,
            turnMessageIds: existing?.turnMessageIds ?? new Set()
        });
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

    public finishTurn(sessionId: string): void {
        if (!sessionId) return;
        this.turnStateBySession.delete(sessionId);
        this.pendingTurnChangesBySession.delete(sessionId);
        this.activeTurnOpIdBySession.delete(sessionId);
        this.canceledActiveTurnBySession.delete(sessionId);
        this.pendingUserMsgIdBySession.delete(sessionId);
        this.pendingAssistantMsgIdBySession.delete(sessionId);
        // this.logUiDebug(`[DBG_TURN_END] session=${sessionId}`);
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
            const exportData = await this.exportSession(sessionId);
            const rawMessages = Array.isArray(exportData?.messages) ? exportData.messages : [];
            const assistantMatches = rawMessages.filter((message: any) =>
                message?.info?.id === assistantMsgId &&
                message?.info?.role === 'assistant'
            );

            if (assistantMatches.length !== 1) {
                const tail = rawMessages.slice(-5).map((message: any) => {
                    const id = message?.info?.id || 'null';
                    const role = message?.info?.role || 'null';
                    const parentID = message?.info?.parentID || 'null';
                    const finish = message?.info?.finish || 'null';
                    return `{id=${id} role=${role} parentID=${parentID} finish=${finish}}`;
                });
                // this.logUiDebug(`[DBG_EXPORT_FOUND] assistantMatches=${assistantMatches.length} parentID=null tail=${tail.join(' ')}`);
                return { status: 'pending', localKey, userMsgId: state.resolvedUserMsgId || null, awaitingAssistantIdFromExport: true, reason: 'assistant-match-count' };
            }

            const parentId = assistantMatches[0]?.info?.parentID;
            const userMsgId = typeof parentId === 'string' ? parentId : null;
            // this.logUiDebug(`[DBG_EXPORT_FOUND] assistantMatches=1 parentID=${userMsgId || 'null'}`);

            if (!userMsgId || !userMsgId.startsWith('msg_')) {
                return { status: 'pending', localKey, userMsgId: null, awaitingAssistantIdFromExport: true, reason: 'invalid-user-parent' };
            }

            if (state.resolvedUserMsgId && state.resolvedUserMsgId !== userMsgId) {
                // this.logUiDebug(`[DBG_EXPORT_STALE] session=${sessionId} resolvedUserMsgId=${state.resolvedUserMsgId} newParentID=${userMsgId} assistantMsgId=${assistantMsgId}`);
                return { status: 'pending', localKey, userMsgId: state.resolvedUserMsgId, awaitingAssistantIdFromExport: true, reason: 'stale-parent-mismatch' };
            }

            state.resolvedUserMsgId = userMsgId;

            const resolved = this.resolveFinalAssistantFromExport(exportData, userMsgId);
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
                        onEvent({
                            type: 'assistantMessageMeta',
                            sessionId,
                            assistantMsgId,
                            tmpKey: this.getPendingAssistantTmpKey(sessionId)
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

    private buildChangeSpecs(files: FileSnapshot[]): FileChangeSpec[] {
        const changes: FileChangeSpec[] = [];
        for (const file of files) {
            const existsBefore = typeof file.existsBefore === 'boolean'
                ? file.existsBefore
                : (file.type === 'create' ? false : file.type === 'delete' ? true : true);
            const existsAfter = typeof file.existsAfter === 'boolean'
                ? file.existsAfter
                : (file.type === 'create' ? true : file.type === 'delete' ? false : true);
            if (!existsAfter) {
                changes.push({ type: 'delete', path: file.filePath });
            } else if (!existsBefore && existsAfter) {
                changes.push({ type: 'create', path: file.filePath });
            } else {
                changes.push({ type: 'update', path: file.filePath });
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

    public getRevertedSegment(): RevertedSegment | undefined {
        return this.revertedSegment;
    }

    public setRevertedSegment(segment: RevertedSegment | undefined): void {
        this.revertedSegment = segment;
    }

    public async undoFromMessage(startMessageId: string, options?: { force?: boolean }): Promise<{ conflicts: ConflictDetail[]; touchedFiles: string[]; applied: boolean }> {
        const force = options?.force === true;
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
        const hasActivePrev = Boolean(prevSeg && prevSeg.isActive && !prevSeg.discarded);
        let prevStartIndex: number | undefined;
        let prevEndIndex: number | undefined;
        if (hasActivePrev && prevSeg) {
            prevStartIndex = typeof prevSeg.startMessageIndex === 'number'
                ? prevSeg.startMessageIndex
                : this.messageIndexById.get(prevSeg.startMessageId);
            prevEndIndex = typeof prevSeg.endMessageIndex === 'number'
                ? prevSeg.endMessageIndex
                : this.messageIndexById.get(prevSeg.endMessageId);
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
            return { conflicts: [], touchedFiles, applied: false };
        }
        if (!this.gitUndoAvailable) {
            this.logUiDebug(`EXT: undo.disabled | reason=git-unavailable`);
            return { conflicts: [], touchedFiles, applied: false };
        }

        if (effectiveEndIndex < startIndex) {
            this.logUiDebug(`EXT: undo.noop | reason | effectiveEndIndex<startIndex | startIndex | ${startIndex} | effectiveEndIndex | ${effectiveEndIndex}`);
            return { conflicts: [], touchedFiles: [], applied: true };
        }

        const messageIds = this.getMessageIdsInRange(startIndex, effectiveEndIndex);
        const firstMsgId = messageIds[0] || 'null';
        const lastMsgId = messageIds.length ? messageIds[messageIds.length - 1] : 'null';
        // this.logUiDebug(`EXT: undo.messageIds | count | ${messageIds.length} | first | ${firstMsgId} | last | ${lastMsgId}`);
        // this.logUiDebug(`EXT: undo.messageIds.full | ids | ${JSON.stringify(messageIds)}`);
        // OpenCodeClient.outputChannel.appendLine(`[UNDO] messageIdsInRange=${messageIds.length}`);

        if (this.gitUndoAvailable && this.gitUndo) {
            const result = await this.gitUndo.undoFromMessage(sessionId, startMessageId, force);
            if (result.conflicts.length) {
                const conflicts = result.conflicts.map((conflict) => ({
                    path: conflict.path,
                    expectedExists: conflict.expectedExists !== undefined ? conflict.expectedExists : true,
                    currentExists: conflict.currentExists !== undefined ? conflict.currentExists : true,
                    diffText: conflict.diffText || ''
                }));
                return { conflicts, touchedFiles, applied: false };
            }

            let mergedEndIndex = effectiveEndIndex;
            let mergedEndId = messageIds.length ? messageIds[messageIds.length - 1] : startMessageId;
            let mergedStartCommits = result.startCommits || (result.startCommit ? [result.startCommit] : []);
            if (hasActivePrev && prevSeg) {
                if (typeof prevEndIndex === 'number') {
                    mergedEndIndex = prevEndIndex;
                }
                if (typeof prevSeg.endMessageId === 'string' && prevSeg.endMessageId.startsWith('msg_')) {
                    mergedEndId = prevSeg.endMessageId;
                }
                if (Array.isArray(prevSeg.startCommits) && prevSeg.startCommits.length) {
                    mergedStartCommits = [...mergedStartCommits, ...prevSeg.startCommits];
                } else if (prevSeg.startCommit) {
                    mergedStartCommits.push(prevSeg.startCommit);
                }
            }
            if (mergedStartCommits.length > 1) {
                mergedStartCommits = Array.from(new Set(mergedStartCommits));
            }
            const mergedMessageIds = hasActivePrev && typeof prevEndIndex === 'number'
                ? this.getMessageIdsInRange(startIndex, prevEndIndex)
                : messageIds;
            if (mergedMessageIds.length) {
                mergedEndId = mergedMessageIds[mergedMessageIds.length - 1];
            }

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
            return { conflicts: [], touchedFiles: result.touchedFiles, applied: result.applied };
        }
        return { conflicts: [], touchedFiles, applied: false };
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
        options?: { force?: boolean; messageIds?: string[] }
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
        const messageIds = Array.isArray(options?.messageIds)
            ? options.messageIds.filter((id) => typeof id === 'string' && id.startsWith('msg_'))
            : [];
        const result = await this.gitUndo.restoreToMessage(sessionId, targetMsgId, messageIds, options?.force === true);
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
        options?: { opName?: string; retry?: boolean; timeoutMs?: number; conn?: ServerConn }
    ): Promise<Response> {
        const opName = options?.opName || 'fetch';
        const retry = options?.retry !== false;
        const timeoutMs = options?.timeoutMs ?? 2000;
        const conn = options?.conn || await this.getServerConn();
        try {
            const response = await this.serverFetchOnce(conn, reqPath, init, opName, timeoutMs);
            if (response.status === 401 && retry) {
                await this.migrateServerPort(conn.lock, '401');
                const nextConn = await this.getServerConn(true);
                return this.serverFetch(reqPath, init, { opName, retry: false, timeoutMs, conn: nextConn });
            }
            return response;
        } catch (error) {
            if (!retry) throw error;
            await this.ensureServerForWorkspace(conn.lock.workspaceRoot, 'fetch-retry');
            const nextConn = await this.getServerConn(true);
            return this.serverFetch(reqPath, init, { opName, retry: false, timeoutMs, conn: nextConn });
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
            const response = await this.serverFetch('/global/health', { method: 'GET' }, { opName: 'health', retry: false, timeoutMs, conn });
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
        } catch (error) {
            const health = await this.checkServerHealth(port, lock.password, 1000);
            if (health === 'unauthorized') {
                await this.migrateServerPort(lock, 'EADDRINUSE');
                return;
            }
            this.serverBaseUrl = undefined;
            this.serverPort = undefined;
            this.serverPid = undefined;
            this.serverPassword = undefined;
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
        this.eventStreamAbort?.abort();
        this.eventStreamActive = false;
    }

    private async buildServeSpawn(args: string[]): Promise<{ command: string; args: string[] }> {
        const bin = await this.resolveBin();
        return this.buildSpawn(bin, args);
    }

    private async waitForServerHealthy(port: number, password: string): Promise<void> {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            const result = await this.checkServerHealth(port, password, 1000);
            if (result === 'ok') return;
            await new Promise((resolve) => setTimeout(resolve, 300));
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
        const response = await this.serverFetch(path, options, { opName: method + ' ' + path });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Server ${method} ${path} failed: ${response.status} ${text}`);
        }
        if (response.status === 204) {
            return {} as T;
        }
        return (await response.json()) as T;
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
                const response = await this.serverFetch('/event', { method: 'GET', signal }, { opName: 'event', retry: false, timeoutMs: 0 });
                if (!response.ok || !response.body) {
                    throw new Error(`Event stream failed: ${response.status}`);
                }
                this.eventStreamBackoffMs = 1000;
                const reader = response.body.getReader();
                let buffer = '';
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
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
            } catch (error) {
                if ((error as Error).name === 'AbortError') return;
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

    private handleServerEvent(payload: string): void {
        let parsed: any;
        try {
            parsed = JSON.parse(payload);
        } catch {
            return;
        }
        const type = parsed?.type as string;
        const props = parsed?.properties || {};
        if (this.shouldLogAssistantSse(type, props)) {
            OpenCodeClient.outputChannel.appendLine(`[SSE_ASSIST] ${payload}`);
        }
        if (type === 'session.status' && props?.sessionID && props?.status?.type === 'idle') {
            const waiters = this.sessionIdleWaiters.get(props.sessionID);
            if (waiters && waiters.length) {
                waiters.splice(0).forEach((resolve) => resolve());
            }
        }
        const events = this.mapServerEventToChatEvents(type, props);
        if (!events.length) return;
        for (const event of events) {
            for (const listener of this.eventListeners) {
                listener(event);
            }
        }
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
            default:
                return null;
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

    private mapServerEventToChatEvents(type: string, props: any): ChatEvent[] {
        const events: ChatEvent[] = [];
        if (type === 'session.created' || type === 'session.updated') {
            if (props?.info?.id) {
                events.push({ type: 'session', sessionId: props.info.id });
            }
            return events;
        }
        if (type === 'message.updated') {
            const info = props?.info || {};
            const messageId = info?.id;
            const sessionId = info?.sessionID;
            const role = info?.role;
            if (sessionId && this.canceledActiveTurnBySession.get(sessionId) === true) {
                return events;
            }
            if (sessionId && role === 'assistant' && typeof messageId === 'string') {
                this.pendingAssistantMsgIdBySession.set(sessionId, messageId);
                if (typeof info?.parentID === 'string' && info.parentID.length) {
                    this.pendingUserMsgIdBySession.set(sessionId, info.parentID);
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
            if (role === 'user' && messageId) {
                events.push({ type: 'message', text: messageId, sessionId });
            }
            if (role === 'assistant' && messageId) {
                const completedAt = info?.time?.completed;
                const isFinal = Boolean(info?.finish) || typeof completedAt === 'number';
                if (isFinal) {
                    const messageIndex = this.registerMessage(messageId);
                    this.recordAssistantMsgId(sessionId, messageId);
                    events.push({
                        type: 'assistantMessageMeta',
                        sessionId,
                        assistantMsgId: messageId,
                        messageId,
                        messageIndex,
                        tmpKey: this.getPendingAssistantTmpKey(sessionId)
                    });
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
            if (part?.type === 'text') {
                const msgId = typeof part?.messageID === 'string' ? part.messageID : '';
                if (sessionId && msgId) {
                    const assistantId = this.pendingAssistantMsgIdBySession.get(sessionId);
                    if (!assistantId || assistantId !== msgId) {
                        this.pendingUserMsgIdBySession.set(sessionId, msgId);
                    }
                }
                if (msgId) {
                    const role = this.messageRoleById.get(msgId);
                    if (role && role !== 'assistant') {
                        return events;
                    }
                }
                let chunk = '';
                if (typeof part?.delta === 'string' && part.delta.length) {
                    chunk = part.delta;
                    if (msgId) {
                        this.assistantHasDelta.add(msgId);
                    }
                } else if (typeof part?.text === 'string') {
                    if (msgId && this.assistantHasDelta.has(msgId)) {
                        chunk = '';
                    } else {
                        const prevLen = msgId ? (this.assistantTextLengths.get(msgId) || 0) : 0;
                        const nextLen = part.text.length;
                        if (nextLen > prevLen) {
                            chunk = part.text.slice(prevLen);
                        }
                        if (msgId) {
                            this.assistantTextLengths.set(msgId, nextLen);
                        }
                    }
                }
                if (!chunk) return events;
                if (msgId && !this.assistantStatusCleared.has(msgId)) {
                    events.push({
                        type: 'assistantMessageMeta',
                        sessionId,
                        assistantMsgId: part?.messageID,
                        lastText: 'Finalizing the response...',
                        tmpKey: this.getPendingAssistantTmpKey(sessionId)
                    });
                    this.assistantStatusCleared.add(msgId);
                }
                events.push({ type: 'text', text: chunk, sessionId, assistantMsgId: part?.messageID, tmpKey: this.getPendingAssistantTmpKey(sessionId) });
            }
            if (part?.type === 'tool') {
                const statusText = this.formatToolStatus(part);
                if (statusText) {
                    const resolvedId = this.getTurnAssistantMsgId(sessionId);
                    const assistantMsgId = resolvedId || part?.messageID;
                    events.push({ type: 'assistantMessageMeta', sessionId, assistantMsgId, lastText: statusText, tmpKey: this.getPendingAssistantTmpKey(sessionId) });
                }
                if (part?.state?.status === 'completed') {
                    const files = this.extractFilesFromToolPart(part);
                    if (files.length) {
                        if (this.gitUndoAvailable && this.isSessionUndoEnabled(sessionId) && sessionId) {
                            const turnState = this.turnStateBySession.get(sessionId);
                            const turnKey = turnState?.pendingUserLocalKey || sessionId;
                            const tmpKey = turnState?.pendingAssistantTmpKey;
                            const assistantId = turnState?.assistantMsgId || turnState?.lastResolvedAssistantMsgId;
                            const changeSpecs = this.buildChangeSpecs(files);
                            this.queueTurnChanges(sessionId, turnKey, tmpKey, assistantId, changeSpecs);
                        }
                        events.push({ type: 'files', files, sessionId });
                    } else if (part?.tool === 'bash' && sessionId) {
                        const command = part?.state?.input?.command;
                        const cwd = this.lastCwdBySession.get(sessionId);
                        const deletePaths = this.extractDeletedPathsFromCommand(command, cwd);
                        if (deletePaths.length) {
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
            if (part?.type === 'tool' && part?.tool === 'apply_patch') {
                const patchText = part?.state?.input?.patchText || part?.state?.input?.patch;
                if (patchText) {
                    events.push({ type: 'toolPatch', text: patchText, sessionId });
                }
            }
            if ((part?.type === 'diff' || part?.type === 'patch') && typeof part?.text === 'string') {
                events.push({ type: 'diff', text: part.text, sessionId });
            }
            return events;
        }
        if (type === 'session.diff' && Array.isArray(props?.diff)) {
            if (props?.sessionID && this.canceledActiveTurnBySession.get(props.sessionID) === true) {
                return events;
            }
            const files = props.diff.map((entry: any) => ({
                filePath: entry.file,
                before: entry.before,
                after: entry.after,
                additions: entry.additions,
                deletions: entry.deletions
            })) as FileSnapshot[];
            if (files.length) {
                if (this.gitUndoAvailable && this.isSessionUndoEnabled(props?.sessionID) && props?.sessionID) {
                    const sessionId = props.sessionID as string;
                    const turnState = this.turnStateBySession.get(sessionId);
                    const turnKey = turnState?.pendingUserLocalKey || sessionId;
                    const tmpKey = turnState?.pendingAssistantTmpKey;
                    const assistantId = turnState?.assistantMsgId || turnState?.lastResolvedAssistantMsgId;
                    const changeSpecs = this.buildChangeSpecs(files);
                    this.queueTurnChanges(sessionId, turnKey, tmpKey, assistantId, changeSpecs);
                }
                events.push({ type: 'files', files, sessionId: props?.sessionID });
            }
            return events;
        }
        if (type === 'session.status' && props?.sessionID && props?.status?.type === 'idle') {
            if (this.canceledActiveTurnBySession.get(props.sessionID) === true) {
                return events;
            }
            this.scheduleSessionResync(props.sessionID);
        }
        if (type === 'session.error') {
            const errorName = props?.error?.name || props?.error?.data?.name;
            const message = props?.error?.data?.message || props?.error?.message;
            if (errorName === 'MessageAbortedError') {
                return events;
            }
            if (message) {
                events.push({ type: 'error', text: message, sessionId: props?.sessionID });
            }
            return events;
        }
        return events;
    }

    private waitForSessionIdle(sessionId: string): Promise<void> {
        return new Promise((resolve) => {
            const list = this.sessionIdleWaiters.get(sessionId) || [];
            list.push(resolve);
            this.sessionIdleWaiters.set(sessionId, list);
            void this.requestJson('GET', `/session/${sessionId}`)
                .then((info: any) => {
                    const status = info?.status?.type;
                    if (status === 'idle') {
                        const waiters = this.sessionIdleWaiters.get(sessionId);
                        if (waiters && waiters.length) {
                            waiters.splice(0).forEach((fn) => fn());
                        }
                    }
                })
                .catch(() => undefined);
        });
    }

    private getPendingAssistantTmpKey(sessionId: string | undefined): string | undefined {
        if (!sessionId) return undefined;
        return this.turnStateBySession.get(sessionId)?.pendingAssistantTmpKey;
    }

    private scheduleSessionResync(sessionId: string): void {
        void this.requestJson<any[]>( 'GET', `/session/${sessionId}/message`)
            .then((messages) => {
                if (!Array.isArray(messages)) return;
                for (const item of messages) {
                    const info = item?.info || {};
                    const messageId = info?.id;
                    if (!messageId) continue;
                    this.handleServerEvent(JSON.stringify({ type: 'message.updated', properties: { info } }));
                }
            })
            .catch(() => undefined);
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
        if (options.files && options.files.length) {
            payload.parts.push(...options.files.map((file) => ({ type: 'file', path: file })));
        }

        await this.requestJson('POST', `/session/${sessionId}/prompt_async`, payload);
        await this.waitForSessionIdle(sessionId);
        if (listener) {
            const resolvedAssistant = this.getTurnAssistantMsgId(sessionId);
            if (!resolvedAssistant) {
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
            this.eventListeners.delete(listener);
        }
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

    public async exportSession(sessionId: string): Promise<any> {
        await this.ensureServer();
        const messages = await this.requestJson<any[]>( 'GET', `/session/${sessionId}/message`);
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
