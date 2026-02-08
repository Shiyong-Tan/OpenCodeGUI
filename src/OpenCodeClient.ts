import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { GitUndoEngine } from './undo/GitUndoEngine';
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

export class OpenCodeClient {
    public static outputChannel = vscode.window.createOutputChannel("OpenCode CLI");
    private currentChild?: cp.ChildProcess;
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
    }

    constructor() {
        const workspaceRoot = this.getWorkspaceRoot();
        this.gitUndo = new GitUndoEngine(workspaceRoot, (message) => this.logUiDebug(message));
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

    public finishTurn(sessionId: string): void {
        if (!sessionId) return;
        this.turnStateBySession.delete(sessionId);
        this.pendingTurnChangesBySession.delete(sessionId);
        // this.logUiDebug(`[DBG_TURN_END] session=${sessionId}`);
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
                        onEvent({ type: 'assistantMessageMeta', sessionId, assistantMsgId });
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
            return [
                {
                    filePath: input.filePath,
                    type: existsBefore ? 'update' : 'create',
                    before: existsBefore ? undefined : '',
                    after: typeof input.content === 'string' ? input.content : '',
                    existsBefore,
                    existsAfter: true
                }
            ];
        }
        return [];
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


    private getWorkspaceRoot(): string {
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
                    expectedExists: true,
                    currentExists: true,
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
                    expectedExists: true,
                    currentExists: true,
                    diffText: conflict.diffText || ''
                }));
                return { conflicts, touchedFiles: [], applied: false };
            }
            return { conflicts: [], touchedFiles: result.touchedFiles, applied: result.applied };
        }
        return { conflicts: [], touchedFiles: [], applied: false };
    }

    public async restoreFromMessage(startMessageId: string, endMessageId?: string, options?: { force?: boolean }): Promise<{ conflicts: ConflictDetail[]; touchedFiles: string[]; applied: boolean }> {
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
        const result = await this.gitUndo.restoreToMessage(sessionId, targetMsgId, [], options?.force === true);
        if (result.conflicts.length) {
            const conflicts = result.conflicts.map((conflict) => ({
                path: conflict.path,
                expectedExists: true,
                currentExists: true,
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

    public async checkVersion(): Promise<string> {
        return this.execute(['--version']);
    }

    public async chat(
        message: string,
        options: { model?: string; variant?: string; sessionId?: string; continueSession?: boolean; files?: string[]; mode?: string },
        onEvent?: (event: ChatEvent) => void
    ): Promise<void> {
        const args: string[] = ['run', '--format', 'json'];

        if (options.model) args.push('--model', options.model);
        if (options.variant) args.push('--variant', options.variant);
        if (options.mode) args.push('--agent', options.mode);
        if (options.sessionId) args.push('--session', options.sessionId);
        if (options.continueSession) args.push('--continue');
        if (options.files && options.files.length) {
            for (const file of options.files) {
                args.push('--file', file);
            }
        }

        if (message) args.push('--');
        await this.executeStreaming(args, onEvent, message);
    }

    public async listModels(): Promise<ModelInfo[]> {
        const output = await this.execute(['models', '--verbose']);
        const models = this.parseModels(output);
        this.applyCopilotSpeedMultipliers(models);
        return models;
    }

    public async listSessions(): Promise<SessionInfo[]> {
        const output = await this.execute(['session', 'list', '--format', 'json']);
        return this.parseSessions(output);
    }

    public async createSession(): Promise<{ id: string }> {
        const output = await this.execute(['session', 'new']);
        const lines = output.split(/\r?\n/);
        for (const line of lines) {
            const match = line.match(/Created new session with ID:\s*(.+)/);
            if (match && match[1]) {
                return { id: match[1].trim() };
            }
        }
        throw new Error('Failed to parse session creation output.');
    }

    public async exportSession(sessionId: string): Promise<any> {
        const output = await this.execute(['export', sessionId]);
        const jsonStart = output.indexOf('{');
        if (jsonStart === -1) {
            throw new Error('Failed to parse session export output.');
        }
        return JSON.parse(output.slice(jsonStart));
    }

    public cancel(): void {
        if (this.currentChild) {
            OpenCodeClient.outputChannel.appendLine(`[CANCEL] Terminating current process`);
            this.currentChild.kill();
            this.currentChild = undefined;
        }
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
