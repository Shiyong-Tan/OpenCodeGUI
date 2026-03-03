import * as vscode from "vscode";
import * as crypto from "crypto";
import * as fs from "fs";
import * as pathModule from "path";
import { OpenCodeClient, ChatEvent, ModelInfo, SessionInfo, FileSnapshot, ConflictDetail, AgentInfo } from "./OpenCodeClient";
import { OpenCodeDiffProvider } from "./OpenCodeDiffProvider";
import { GitRepoManager } from './undo/GitRepoManager';
import { runGit } from './undo/GitRunner';
import { GitRepoRef } from './undo/types';

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
    private userOwnedSessionIds = new Set<string>();
    private activeSubagentSessionIds = new Set<string>();
    private subagentProgressBySession = new Map<string, { taskId: string; description: string; startedAt: number; title?: string; model?: string; latestText?: string; latestTool?: string }>();

    private isUserOwnedSession(id: string): boolean {
        return this.userOwnedSessionIds.has(id) || id === this.currentSessionId;
    }

    private trackUserOwnedSession(id: string | undefined): void {
        if (id) {
            this.userOwnedSessionIds.add(id);
        }
    }

    private clearSubagentSessions(): void {
        this.activeSubagentSessionIds.clear();
        this.subagentProgressBySession.clear();
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
            description: entry.description,
            startedAt: entry.startedAt,
            title: entry.title || '',
            model: entry.model || '',
            latestText: entry.latestText || '',
            latestTool: entry.latestTool || ''
        }));
        const isActive = active !== undefined ? active : agents.length > 0;
        liveWebview.postMessage({ type: 'subagentStatus', active: isActive, agents, count: agents.length });
    }
    private selectedModel?: string;
    private selectedVariant?: string;
    private selectedMode?: string;
    private availableModes: string[] = ['plan', 'build'];
    private pendingClientMessageId?: string;
    private lastDraft?: { text: string; attachments: string[]; model?: string; variant?: string; mode?: string };
    private currentDiffFilePath: string | null = null;
    private diffHashes = new Map<string, { before: string; after: string }>();
    private revertedSegment?: { conflicts: ConflictDetail[]; discarded?: boolean };
    private clientMessageIdMap = new Map<string, string>();
    private revertedSegmentHistory: Array<{ isActive: boolean; discarded: boolean; startMessageId?: string; startMessageIndex?: number; endMessageId?: string; endMessageIndex?: number; collapsed: boolean; messageIds?: string[] }> = [];
    private pendingConflict?: { kind: 'undo' | 'restore' | 'restoreSegment'; startMessageId?: string; endMessageId?: string; operationId?: string; noticeKey?: string };
    private uiDebugChannel!: vscode.OutputChannel;
    private undoSegmentsBySession: Map<string, Map<string, SegmentState>> = new Map();
    private readonly UNDO_SEGMENTS_KEY = 'opencode.undoSegmentsBySession.v1';
    private pendingAssistantTmpKeyBySession = new Map<string, string>();
    private pendingAssistantTmpKeyByLocalKey = new Map<string, string>();
    private pendingLocalKeyBySession = new Map<string, string>();
    private pendingAssistantMessageIdBySession = new Map<string, string>();
    private sendInFlightBySession = new Set<string>();
    private gitUndoEnabled = false;
    private gitUndoReason?: string;
    private pendingBaselineTurnKey?: string;
    private baselineReady = true;
    private pendingBaselineFailed = false;
    private serverStatus: 'connected' | 'reconnecting' | 'error' = 'connected';
    private readonly repoManager: GitRepoManager;
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
        const cwd = info?.path?.cwd;
        if (typeof cwd !== 'string' || !cwd) return undefined;
        return cwd;
    }

    private async getSessionWorkspaceMatch(sessionId: string, workspaceRoot: string): Promise<'match' | 'mismatch' | 'unknown'> {
        try {
            const info = await this.client.getSessionInfo(sessionId);
            const sessionCwd = this.getSessionCwd(info);
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

    private getSnapshotDir(): string {
        return pathModule.join(this._context.globalStorageUri.fsPath, 'sessionSnapshots', this.getWorkspaceKey());
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
        return pathModule.join(this._context.globalStorageUri.fsPath, 'sessionChangeLists', this.getWorkspaceKey());
    }

    private getCanceledTurnsDir(): string {
        return pathModule.join(this._context.globalStorageUri.fsPath, 'sessionCanceledTurns', this.getWorkspaceKey());
    }

    private getChangeListPath(sessionId: string): string {
        return pathModule.join(this.getChangeListDir(), `${sessionId}.json`);
    }

    private getCanceledTurnsPath(sessionId: string): string {
        return pathModule.join(this.getCanceledTurnsDir(), `${sessionId}.json`);
    }

    private async readChangeLists(sessionId: string): Promise<ChangeListRecord[]> {
        const filePath = this.getChangeListPath(sessionId);
        if (!fs.existsSync(filePath)) return [];
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
        if (!fs.existsSync(filePath)) return [];
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
        await fs.promises.writeFile(tmpPath, text, 'utf-8');
        await fs.promises.rename(tmpPath, filePath);
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

    private async upsertChangeList(sessionId: string, record: ChangeListRecord): Promise<void> {
        const records = await this.readChangeLists(sessionId);
        const idx = records.findIndex((item) => item.id === record.id);
        if (idx === -1) {
            records.push(record);
        } else {
            records[idx] = { ...records[idx], ...record };
        }
        await this.writeChangeLists(sessionId, records);
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
        formatted = { ...formatted, messages: filteredMessages };
        const records = await this.readChangeLists(sessionId);
        if (!records.length) return formatted;

        const messages = formatted.messages || [];
        const idSet = new Set(messages.map((m) => m.id).filter((id): id is string => typeof id === 'string'));
        const byAnchor = new Map<string, ChangeListRecord[]>();
        for (const record of records) {
            if (!record.anchorMessageId || !idSet.has(record.anchorMessageId)) {
                continue;
            }
            if (!byAnchor.has(record.anchorMessageId)) {
                byAnchor.set(record.anchorMessageId, []);
            }
            byAnchor.get(record.anchorMessageId)?.push(record);
        }
        if (!byAnchor.size) return formatted;

        for (const list of byAnchor.values()) {
            list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        }

        const merged: SessionMessage[] = [];
        const seenIds = new Set<string>();
        for (const message of messages) {
            if (message.id && seenIds.has(message.id)) {
                continue;
            }
            if (message.id) {
                seenIds.add(message.id);
            }
            merged.push(message);
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

        return { ...formatted, messages: merged };
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
        if (!this.client.hasActiveTurnWrites(sessionId) && !this.client.hasPendingTurnChanges(sessionId)) {
            this.uiDebugChannel.appendLine('EXT: diff.skip | reason=no-turn-writes');
            return;
        }
        const repo = await this.resolveInternalRepo(sessionId);
        if (!repo) return;
        let headCommit: string | null = null;
        let baseCommit: string | null = null;
        for (let attempt = 0; attempt < 5; attempt++) {
            headCommit = await this.getInternalHeadCommit(repo);
            if (headCommit) {
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
            this.postAddResponse(webview, 'No baseline available to show changes.');
            return;
        }
        const currentSet = await this.getInternalDiffFileSet(repo, baseCommit, headCommit);
        const files = Array.from(currentSet);
        if (!files.length) return;
        files.sort();
        const statsByPath = await this.getInternalDiffStats(repo, baseCommit, headCommit);
        const anchorMessageId = this.client.getTurnAssistantMsgId(sessionId);
        const changeListId = headCommit ? `system:changeList:${headCommit}` : `changes:${Date.now()}`;
        webview.postMessage({
            type: 'diffFileList',
            sessionId,
            files,
            source: 'git',
            scope: 'turn',
            commitHead: headCommit,
            commitBase: baseCommit,
            statsByPath,
            anchorMessageId,
            changeListId
        });
        if (anchorMessageId && headCommit && baseCommit) {
            await this.upsertChangeList(sessionId, {
                id: changeListId,
                commitHead: headCommit,
                commitBase: baseCommit,
                files,
                statsByPath,
                anchorMessageId,
                createdAt: Date.now()
            });
        }
        this.uiDebugChannel.appendLine(`[EXT][DIFF_LIST] sessionId=${sessionId} count=${files.length} anchor=${anchorMessageId || 'null'}`);
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
        this.client.setServerStatusHandler((status, reason) => {
            this.sendServerStatus(status, reason);
        });
        void this.client.warmServer();
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
                        let modelText = userText;
                        if (this.selectedMode === 'plan' || /prometheus/i.test(this.selectedMode || '')) {
                            modelText = modelText + '\n\nPlease use "question tool" to communicate. Consult Metis for making plans. In the plan, require the executor to make changes directly in the current working directory, instead of in a new working directory.';
                        }
                        this.lastDraft = {
                            text: userText,
                            attachments: [],
                            model: this.selectedModel,
                            variant: this.selectedVariant,
                            mode: this.selectedMode
                        };
                        const clientMessageId = data.clientMessageId || `local-${Date.now()}`;
                        this.pendingClientMessageId = clientMessageId;
                        const opId = typeof data.opId === 'string' ? data.opId : undefined;
                        if (this.currentSessionId) {
                            activeSendSessionId = this.currentSessionId;
                            this.sendInFlightBySession.add(this.currentSessionId);
                            this.pendingLocalKeyBySession.set(this.currentSessionId, clientMessageId);
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
                                mode: this.selectedMode
                            },
                            async (event: ChatEvent) => {
                                await this.handleChatEvent(event, activeWebview);
                            }
                        );

                        OpenCodeClient.outputChannel.appendLine(`[BRIDGE] Chat done`);
                        if (this.currentSessionId) {
                            this.flushAssistantBufferToWebview(this.currentSessionId, liveWebview);
                        }
                        const doneAssistantMsgId = this.currentSessionId
                            ? this.client.getTurnAssistantMsgId(this.currentSessionId)
                            : undefined;
                        liveWebview.postMessage({
                            type: 'chatDone',
                            sessionId: this.currentSessionId,
                            assistantMsgId: doneAssistantMsgId,
                            lastAssistantMsgId: doneAssistantMsgId
                        });
                        this.postMessageIndexMap(liveWebview);
                        if (this.currentSessionId) {
                            this.uiDebugChannel.appendLine(`EXT: finalize.order | sessionId=${this.currentSessionId} | phase=commit-start`);
                            await this.client.commitPendingTurnChanges(this.currentSessionId);
                            this.uiDebugChannel.appendLine(`EXT: finalize.order | sessionId=${this.currentSessionId} | phase=commit-done`);
                        }
                        this.uiDebugChannel.appendLine(`EXT: finalize.order | sessionId=${this.currentSessionId || 'null'} | phase=upgrade-start`);
                        await this.resolvePendingUserUpgrade(this.currentSessionId, liveWebview);
                        this.uiDebugChannel.appendLine(`EXT: finalize.order | sessionId=${this.currentSessionId || 'null'} | phase=upgrade-done`);
                        this.postMessageIndexMap(liveWebview);
                        if (this.currentSessionId) {
                            await this.emitDiffFileList(this.currentSessionId, liveWebview);
                        }
                        if (this.currentSessionId) {
                            this.client.finishTurn(this.currentSessionId);
                        }
                        this.clearSubagentSessions();
                        this.emitSubagentStatus(false);
                        await this.postModelQuota(liveWebview, 'chat-done');
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
                        this.uiDebugChannel.appendLine(`EXT: send.abort | reqId=${reqId} | reason=${String(error)}`);
                        OpenCodeClient.outputChannel.appendLine(`[BRIDGE] Error: ${error}`);
                        vscode.window.showErrorMessage(`OpenCode Error: ${error}`);
                        this.postAddResponse(activeWebview, `Error: ${error}`);
                        const doneAssistantMsgId = this.currentSessionId
                            ? this.client.getTurnAssistantMsgId(this.currentSessionId)
                            : undefined;
                        activeWebview.postMessage({
                            type: 'chatDone',
                            sessionId: this.currentSessionId,
                            assistantMsgId: doneAssistantMsgId,
                            lastAssistantMsgId: doneAssistantMsgId
                        });
                        if (this.currentSessionId) {
                            await this.client.commitPendingTurnChanges(this.currentSessionId);
                        }
                        await this.resolvePendingUserUpgrade(this.currentSessionId, activeWebview);
                        if (this.currentSessionId) {
                            this.client.finishTurn(this.currentSessionId);
                        }
                        this.clearSubagentSessions();
                        this.emitSubagentStatus(false);
                        if (this.pendingClientMessageId) {
                            await this.handleAbortedMessage(this.pendingClientMessageId, activeWebview);
                            this.pendingClientMessageId = undefined;
                        }
                        if (this.currentSessionId) {
                            this.assistantTextBufferBySession.delete(this.currentSessionId);
                        }
                        await this.postModelQuota(activeWebview, 'chat-error');
                    } finally {
                        if (activeSendSessionId) {
                            this.sendInFlightBySession.delete(activeSendSessionId);
                            this.pendingLocalKeyBySession.delete(activeSendSessionId);
                            const liveWebview = this._view?.webview || activeWebview;
                            liveWebview.postMessage({ type: 'turnInFlight', sessionId: activeSendSessionId, inFlight: false });
                        }
                    }
                    break;
                }
                case "setModel": {
                    this.selectedModel = data.value || undefined;
                    await this._context.globalState.update('opencode.model', this.selectedModel);
                    await this.postModelQuota(activeWebview, 'model-change');
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
                        if (persisted?.segment) {
                            this.client.setRevertedSegment({
                                isActive: Boolean(persisted.segment.isActive),
                                discarded: Boolean(persisted.discarded),
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
                        }

                        const segMap = this.undoSegmentsBySession.get(targetSessionId);
                        const segments = segMap ? Array.from(segMap.values()) : [];

                        let baseTitle = 'Session';
                        let baseMessages: SessionMessage[] = [];

                        const snapshotStart = Date.now();
                        try {
                            const snap = await this.readSnapshot(targetSessionId);
                            if (snap?.obj?.sessionData) {
                                const snapPayload = snap.obj.sessionData;
                                const snapshotMessages = Array.isArray(snapPayload.messages) ? snapPayload.messages : [];
                                baseTitle = snapPayload.title || baseTitle;
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

                            const mergedMessages = this.mergeSessionMessagesById(baseMessages, formatted.messages);
                            const sessionPayload = {
                                type: 'sessionData',
                                sessionId: targetSessionId,
                                title: baseTitle,
                                messages: mergedMessages,
                                segments
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
                                try {
                                    const snapshotObj = {
                                        sessionId: targetSessionId,
                                        exportedAt: Date.now(),
                                        sessionData: sessionPayload
                                    };
                                    await this.writeSnapshotAtomic(targetSessionId, snapshotObj);
                                } catch (err) {
                                    this.uiDebugChannel.appendLine(`[EXT][SNAP_SAVE_FAIL] sessionId=${targetSessionId} err=${String(err)}`);
                                }
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
                            segments
                        };
                        const sent = postSessionData(sessionPayload, 'full');
                        if (sent && formatted.messages.length > 0) {
                            sessionDataSent = true;
                        }
                        if (sent) {
                            try {
                                const snapshotObj = {
                                    sessionId: targetSessionId,
                                    exportedAt: Date.now(),
                                    sessionData: sessionPayload
                                };
                                await this.writeSnapshotAtomic(targetSessionId, snapshotObj);
                            } catch (err) {
                                this.uiDebugChannel.appendLine(`[EXT][SNAP_SAVE_FAIL] sessionId=${targetSessionId} err=${String(err)}`);
                            }
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
                        const previousSegment = this.client.getRevertedSegment();
                            const result = await this.client.undoFromMessage(resolvedMessageId);
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
                    if (this.currentSessionId) {
                        await this.client.revertPendingTurnChangesToCurrentBase(this.currentSessionId);
                        const canceledAt = Date.now();
                        const { userMsgId, assistantMsgId } = this.client.getPendingTurnMessageIds(this.currentSessionId);
                        await this.upsertCanceledTurn(this.currentSessionId, {
                            opId: typeof data.opId === 'string' ? data.opId : undefined,
                            localKey: this.pendingClientMessageId,
                            userMsgId,
                            assistantMsgId,
                            canceledAt
                        });
                    }
                    this.client.cancel();
                    const cancelSessionId = typeof data.sessionId === 'string' ? data.sessionId : this.currentSessionId;
                    const cancelOpId = typeof data.opId === 'string' ? data.opId : undefined;
                    if (cancelSessionId) {
                        this.client.cancelTurn(cancelSessionId, cancelOpId);
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
                    if (this.lastDraft) {
                        activeWebview.postMessage({
                            type: 'restoreDraft',
                            payload: { ...this.lastDraft }
                        });
                    }
                    // Cleanup before chatDone
                    if (this.currentSessionId) {
                        await this.client.commitPendingTurnChanges(this.currentSessionId);
                    }
                    if (this.currentSessionId) {
                        this.client.finishTurn(this.currentSessionId);
                    }
                    this.clearSubagentSessions();
                    this.emitSubagentStatus(false);

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
                        const fallbackCommits = Array.isArray(currentSegment?.startCommits) && currentSegment?.startCommits?.length
                            ? currentSegment.startCommits
                            : (currentSegment?.startCommit ? [currentSegment.startCommit] : []);
                        const commitsToClear = sessionId
                            ? await this.resolveChangeListCommits(sessionId, messageIds, fallbackCommits)
                            : fallbackCommits;
                        const result = await this.client.restoreFromMessage(anchorMsgId, endMsgId, { messageIds });
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
                            const result = await this.client.restoreFromMessage(conflictContext.startMessageId, conflictContext.endMessageId, { force: true, messageIds });
                            if (this.currentSessionId && conflictContext.noticeKey) {
                                const currentSegment = this.client.getRevertedSegment();
                            const fallbackCommits = Array.isArray(currentSegment?.startCommits) && currentSegment?.startCommits?.length
                                ? currentSegment.startCommits
                                : (currentSegment?.startCommit ? [currentSegment.startCommit] : []);
                            const commitsToClear = this.currentSessionId
                                ? await this.resolveChangeListCommits(this.currentSessionId, messageIds, fallbackCommits)
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
        // Filter: exclude subagent sessions from UI display
        sessions = sessions.filter(s => this.isUserOwnedSession(s.id));
        const storedModel = this._context.globalState.get<string>('opencode.model');
        const storedVariant = this._context.globalState.get<string>('opencode.variant');
        const storedMode = this._context.globalState.get<string>('opencode.mode');

        const allModes = agents
            .filter((agent) => agent.mode === 'all' && !agent.hidden)
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

        const workspaceRoot = this.client.getWorkspaceRoot() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
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
                        const cwd = workspaceFolder || process.cwd();
                        // this.uiDebugChannel.appendLine(`[EXT][EXPORT_TRY] sessionId=${recentSessionId} cwd=${cwd} cmd="opencode export ${recentSessionId}"`);
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
                                    try {
                                        await this.ensureSessionUndoReady(recentSessionId, liveWebview);
                                    } catch (err) {
                                        this.uiDebugChannel.appendLine(`[EXT][UNDO_WARN] ensureSessionUndoReady failed for ${recentSessionId}: ${err}`);
                                    }
                                    liveWebview.postMessage(payload);
                                    const payloadMessages = Array.isArray(payload?.messages) ? payload.messages.length : 0;
                                    if (payloadMessages > 0) {
                                        sessionDataSent = true;
                                    }
                                    this.uiDebugChannel.appendLine(`[EXT][SNAP_LOAD_HIT] sessionId=${recentSessionId} file=${this.getSnapshotFile(recentSessionId)} bytes=${snap.bytes}`);
                                    this.currentSessionId = recentSessionId;
                                    this.trackUserOwnedSession(this.currentSessionId);
                                    this.client.setSessionId(this.currentSessionId);
                                    snapshotLoaded = true;
                                } else {
                                    this.uiDebugChannel.appendLine(`[EXT][SNAP_LOAD_MISS] sessionId=${recentSessionId} file=${this.getSnapshotFile(recentSessionId)}`);
                                }
                            } catch (err) {
                                this.uiDebugChannel.appendLine(`[EXT][SNAP_LOAD_FAIL] sessionId=${recentSessionId} err=${String(err)}`);
                            }
                            if (sessionDataSent) {
                                this.uiDebugChannel.appendLine(
                                    `EXT: export.warn.nonfatal | sessionId=${recentSessionId} | stderrLastLine=${normalized.stderrLastLine || 'null'}`
                                );
                                return;
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

                        if (!snapshotLoaded) {
                            const exportData = normalized.data;
                            const formattedRaw = this.formatSession(exportData);
                            const formatted = await this.injectChangeLists(recentSessionId, formattedRaw);
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

                        // this.uiDebugChannel.appendLine(
                        //     `[EXT][SEG_HYDRATE_LOAD] sessionId=${recentSessionId} found=${segments.length} ` +
                        //     `keys=[${(segMap ? Array.from(segMap.keys()) : []).join(', ')}]`
                        // );
                        
                        // this.uiDebugChannel.appendLine(
                        //     `[EXT][SEG_HYDRATE_SEND] sessionId=${recentSessionId} count=${segments.length} reason=sendInit`
                        // );
                        
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
                            if (formatted.messages.length > 0) {
                                sessionDataSent = true;
                            }
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
                        const formattedRaw = this.formatSession(exportResult);
                        const formatted = await this.injectChangeLists(this.currentSessionId, formattedRaw);
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
                return 'text/markdown';
            case '.json':
                return 'application/json';
            case '.pdf':
                return 'application/pdf';
            case '.csv':
                return 'text/csv';
            case '.xml':
                return 'application/xml';
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

    private async handleChatEvent(event: ChatEvent, webview: vscode.Webview): Promise<void> {
        if (event.type === 'session' && event.sessionId) {
            if (!this.isUserOwnedSession(event.sessionId) && this.sendInFlightBySession.has(this.currentSessionId!)) {
                this.activeSubagentSessionIds.add(event.sessionId);
                this.subagentProgressBySession.set(event.sessionId, {
                    taskId: event.sessionId,
                    description: '',
                    startedAt: Date.now()
                });
                const sessionId = event.sessionId;
                this.client.getSessionInfo(sessionId).then((info: any) => {
                    const entry = this.subagentProgressBySession.get(sessionId);
                    if (entry) {
                        entry.title = info?.title || '';
                        entry.model = info?.model || info?.config?.model || '';
                        this.emitSubagentStatus();
                    }
                }).catch(() => {});
                this.emitSubagentStatus(true);
                return;
            }

            // Guard: Prevent subagent session IDs from hijacking currentSessionId
            if (!this.isUserOwnedSession(event.sessionId)) {
                this.activeSubagentSessionIds.add(event.sessionId);
                this.subagentProgressBySession.set(event.sessionId, {
                    taskId: event.sessionId,
                    description: '',
                    startedAt: Date.now()
                });
                const sessionId = event.sessionId;
                this.client.getSessionInfo(sessionId).then((info: any) => {
                    const entry = this.subagentProgressBySession.get(sessionId);
                    if (entry) {
                        entry.title = info?.title || '';
                        entry.model = info?.model || info?.config?.model || '';
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
                    entry.latestText = event.text.slice(-80);
                    this.emitSubagentStatus();
                }
            }
            if (event.type === 'toolPatch' && typeof event.text === 'string') {
                const entry = this.subagentProgressBySession.get(event.sessionId);
                if (entry) {
                    const match = event.text.match(/(?:---\s+a\/|\+\+\+\s+b\/|diff\s+--git\s+[^\s]+\s+b\/)([^\s\n]+)/);
                    const filename = match ? pathModule.basename(match[1]) : '';
                    entry.latestTool = 'Applying patch' + (filename ? ': ' + filename : '');
                    this.emitSubagentStatus();
                }
            }
            if (event.type === 'diff' && typeof event.text === 'string') {
                const entry = this.subagentProgressBySession.get(event.sessionId);
                if (entry) {
                    const match = event.text.match(/(?:---\s+a\/|\+\+\+\s+b\/|diff\s+--git\s+[^\s]+\s+b\/)([^\s\n]+)/);
                    const filename = match ? pathModule.basename(match[1]) : '';
                    entry.latestTool = 'Editing ' + (filename || 'file');
                    this.emitSubagentStatus();
                }
            }
            if (event.type === 'files' && event.files && event.files.length && this.currentSessionId) {
                this.client.queueSubagentChanges(this.currentSessionId, event.files);
                const entry = this.subagentProgressBySession.get(event.sessionId!);
                if (entry && event.files && event.files.length) {
                    const firstFile = typeof event.files[0] === 'string' ? event.files[0] : (event.files[0] as any).path || '';
                    const filename = firstFile ? pathModule.basename(firstFile) : 'file';
                    entry.latestTool = 'Writing ' + filename;
                    this.emitSubagentStatus();
                }
                const liveWebview = this._view?.webview || webview;
                event.files.forEach((file, index) => {
                    const fileChange = file as FileSnapshot & { changes?: unknown };
                    if (fileChange.changes) {
                        this.openDiffForFileChange(fileChange, liveWebview, index);
                    }
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
            this.uiDebugChannel.appendLine(`EXT: autoresume.hardstop | sessionId=${event.sessionId} | action=cancel+reload-card`);
            this.client.cancel();
            this.client.cancelTurn(event.sessionId);
            this.sendInFlightBySession.delete(event.sessionId);
            liveWebview.postMessage({ type: 'turnInFlight', sessionId: event.sessionId, inFlight: false });
            liveWebview.postMessage({
                type: 'stallCard',
                sessionId: event.sessionId,
                title: event.title || 'Session may be stuck',
                message: event.text || 'This session appears to be unresponsive. Please reload the extension and continue.',
                actionLabel: event.actionLabel || 'Reload Window'
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
            liveWebview.postMessage({
                type: 'assistantMessageMeta',
                messageId: event.messageId,
                messageIndex: event.messageIndex,
                lastText: event.lastText,
                sessionId,
                assistantMsgId: event.assistantMsgId,
                tmpKey,
                isStatusUpdate: event.isStatusUpdate
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
                // Push accumulated text to webview immediately for real-time streaming
                const liveWebview = this._view?.webview || webview;
                const accumulated = this.assistantTextBufferBySession.get(sessionId) ?? '';
                liveWebview?.postMessage({
                    type: 'assistantMessageMeta',
                    sessionId,
                    tmpKey: this.pendingAssistantTmpKeyBySession?.get(sessionId),
                    lastText: accumulated,
                    isStatusUpdate: false
                });
            }
            return;
        }

        if (event.type === 'error' && event.text) {
            const liveWebview = this._view?.webview || webview;
            liveWebview.postMessage({ type: 'addResponse', value: `Error: ${event.text}`, sessionId: this.currentSessionId });
            // Cleanup before chatDone
            if (this.currentSessionId) {
                await this.client.commitPendingTurnChanges(this.currentSessionId);
            }
            if (this.currentSessionId) {
                this.client.finishTurn(this.currentSessionId);
            }
            this.clearSubagentSessions();
            this.emitSubagentStatus(false);

            const doneAssistantMsgId = this.currentSessionId
                ? this.client.getTurnAssistantMsgId(this.currentSessionId)
                : undefined;
            // Flush any buffered text before chatDone
            if (this.currentSessionId) {
                this.flushAssistantBufferToWebview(this.currentSessionId, liveWebview);
            }

            liveWebview.postMessage({
                type: 'chatDone',
                sessionId: this.currentSessionId,
                assistantMsgId: doneAssistantMsgId,
                lastAssistantMsgId: doneAssistantMsgId
            });
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
            this.openDiffForFileChange(active, liveWebview, index);
            
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

    private flushAssistantBufferToWebview(sessionId: string, webview: vscode.Webview): void {
        const text = this.assistantTextBufferBySession.get(sessionId) || '';
        this.assistantTextBufferBySession.delete(sessionId);
        if (!text) return;
        const tmpKey = this.pendingAssistantTmpKeyBySession.get(sessionId);
        webview.postMessage({
            type: 'assistantMessageMeta',
            lastText: text,
            sessionId,
            tmpKey
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
            const filteredSessions = sessions.filter(s => this.isUserOwnedSession(s.id));
            const topSession = sessions?.[0];
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
        return pathModule.join(this._context.globalStorageUri.fsPath, 'revertedSegments', this.getWorkspaceKey());
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

    public async shutdownServer(): Promise<void> {
        await this.client.shutdownServer();
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

        if (typeof file.before !== 'string' || typeof file.after !== 'string') return;
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
        this.diffProvider.updateFromSnapshot(file.filePath, beforeText, afterText, file.diff);
        const diffLen = file.diff ? file.diff.length : 0;
        const basename = pathModule.basename(file.filePath);
        OpenCodeClient.outputChannel.appendLine(`[DIFF] file=${basename} idx=${index} before=${beforeText.length} after=${afterText.length} diff=${diffLen}`);
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
        const seenIds = new Set<string>();

        for (const message of merged) {
            if (typeof message?.id === 'string' && message.id) {
                seenIds.add(message.id);
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
            if (messageId && seenIds.has(messageId)) {
                continue;
            }
            if (messageId) {
                seenIds.add(messageId);
            }
            merged.push(message);
        }

        return merged;
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
        let duplicateIds = false;

        const assistantByParent = new Map<string, any[]>();
        const userIds: string[] = [];
        for (const msg of rawMessages) {
            const role = msg?.info?.role;
            const id = msg?.info?.id;
            if (role === 'user' && typeof id === 'string') {
                userIds.push(id);
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
        // this.uiDebugChannel.appendLine(`[DBG_EXPORT] session=${sessionId} messages:`);
        // for (const line of exportLines) {
        //     this.uiDebugChannel.appendLine(`[DBG_EXPORT] ${line}`);
        // }
        // this.uiDebugChannel.appendLine(`[DBG_EXPORT] total=${rawMessages.length} duplicateIds=${duplicateIds} multiRoleIds=${multiRoleIds.length}`);
        // if (multiRoleIds.length) {
        //     this.uiDebugChannel.appendLine(`[DBG_EXPORT] multiRoleSample=[${multiRoleIds.slice(0, 5).join(', ')}]`);
        // }

        for (const message of rawMessages) {
            const role = message?.info?.role === 'user' ? 'user' : 'assistant';
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
            const isBoulderContinuation = role === 'user' && text.includes('[SYSTEM DIRECTIVE: OH-MY-OPENCODE - BOULDER CONTINUATION]');
            const isSyntheticUser = role === 'user' && (isAutoResumeText || isBoulderContinuation || mode === 'compaction' || agent === 'compaction');
            const messageIndex = this.client.registerMessage(resolvedId);
            messages.push({ role, text, id: resolvedId, messageIndex, meta: isSyntheticUser ? { syntheticUser: true } : undefined });
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
        this.assistantTextBufferBySession.clear();
        this.pendingAssistantTmpKeyBySession.clear();
        this.pendingAssistantTmpKeyByLocalKey.clear();
        this.pendingLocalKeyBySession.clear();
        this.pendingAssistantMessageIdBySession.clear();
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
                    <span class="server-status-dot status-connected" id="server-status-dot" title="Connected"></span>
                    <span class="pending-indicator hidden" id="pending-indicator"></span>
                    <span class="subagent-indicator hidden" id="subagent-indicator"></span>
                    <span class="undo-status hidden" id="undo-status">Undo not available</span>
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
