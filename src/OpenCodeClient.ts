import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { diff_match_patch } from 'diff-match-patch';

export type ModelInfo = {
    id: string;
    providerId: string;
    name: string;
    fullId: string;
    variants: string[];
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

type FileChange = {
    path: string;
    beforeBlobId: string;
    afterBlobId: string;
};

type SnapshotFileMeta = {
    path: string;
    existsBefore: boolean;
    existsAfter: boolean;
    preHash?: string;
    postHash?: string;
};

type MessageSnapshotMeta = {
    messageId: string;
    messageIndex: number;
    timestamp: number;
    files: SnapshotFileMeta[];
};

export type ConflictDetail = {
    path: string;
    expectedExists: boolean;
    currentExists: boolean;
    diffText: string;
};

type PatchOp = {
    opId: string;
    messageId: string;
    messageIndex: number;
    seq: number;
    files: FileChange[];
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
    private patchOps: PatchOp[] = [];
    private patchOpsByMessageId = new Map<string, string[]>();
    private blobStore = new Map<string, string>();
    private revertedSegment?: RevertedSegment;
    private dmp = new diff_match_patch();
    private uiDebugChannel?: vscode.OutputChannel;

    public resetSessionState(): void {
        this.currentSessionId = undefined;
        this.messageIndexById.clear();
        this.messageOrder = [];
        this.nextMessageIndex = 0;
        this.internalMessageSeq = 0;
        this.seqCounter = 0;
        this.patchOps = [];
        this.patchOpsByMessageId.clear();
        this.blobStore.clear();
        this.revertedSegment = undefined;
    }

    constructor() {}

    public setUiDebugChannel(channel: vscode.OutputChannel): void {
        this.uiDebugChannel = channel;
    }

    private logUiDebug(message: string): void {
        if (this.uiDebugChannel) {
            this.uiDebugChannel.appendLine(message);
        }
    }

    public setSessionId(sessionId: string | undefined): void {
        this.currentSessionId = sessionId;
    }

    public getSessionId(): string | undefined {
        return this.currentSessionId;
    }

    private execute(args: string[]): Promise<string> {
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
                    if (assistantMsgId || messageId) {
                        this.logUiDebug(`[DBG_STDOUT_ID] type=${parsed.type || 'unknown'} session=${sessionId || 'null'} tmpKey=null messageID=${assistantMsgId || messageId || 'null'}`);
                    }
                    if (messageId && onEvent) {
                        onEvent({ type: 'message', text: messageId, sessionId });
                        this.registerMessageId(messageId);
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
                        if (messageId) {
                            this.createPatchOp(messageId, files);
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
                        OpenCodeClient.outputChannel.appendLine(`[STDOUT_CHUNK] (dt: ${Date.now() - startTime}ms) ${cleanChunk}`);

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
                        OpenCodeClient.outputChannel.appendLine(`[STDERR_CHUNK] ${this.stripAnsi(rawChunk)}`);
                    });

                    child.on('close', (code) => {
                        const duration = Date.now() - startTime;
                        OpenCodeClient.outputChannel.appendLine(`[CLOSE] Exit code: ${code}, Duration: ${duration}ms`);
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
            if (!input?.filePath) return [];
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

    private registerMessageId(messageId: string): number {
        if (!messageId || !messageId.startsWith('msg_')) {
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
        if (this.patchOpsByMessageId.has(existingId) && !this.patchOpsByMessageId.has(newId)) {
            const list = this.patchOpsByMessageId.get(existingId);
            if (list) {
                this.patchOpsByMessageId.set(newId, list);
            }
            this.patchOpsByMessageId.delete(existingId);
        }
        this.messageIndexById.delete(existingId);
    }

    private hashText(text: string): string {
        return crypto.createHash('sha1').update(text).digest('hex');
    }

    private normalizeText(text: string): string {
        return text.replace(/\r\n/g, '\n');
    }

    private createPatchOp(messageId: string, files: FileSnapshot[]): PatchOp | undefined {
        if (!messageId || !messageId.startsWith('msg_')) {
            return undefined;
        }
        const messageIndex = this.registerMessageId(messageId);
        this.persistMessageCheckpoint(messageId, messageIndex, files).catch((error: unknown) => {
            OpenCodeClient.outputChannel.appendLine(`[UNDO] Failed to persist checkpoint: ${String(error)}`);
        });
        const fileChanges: FileChange[] = [];
        for (const file of files) {
            const existsBefore = typeof file.existsBefore === 'boolean'
                ? file.existsBefore
                : (file.type === 'create' ? false : file.type === 'delete' ? true : true);
            const existsAfter = typeof file.existsAfter === 'boolean'
                ? file.existsAfter
                : (file.type === 'create' ? true : file.type === 'delete' ? false : true);
            const beforeRaw = typeof file.before === 'string'
                ? file.before
                : (existsBefore ? undefined : '');
            const afterRaw = typeof file.after === 'string'
                ? file.after
                : (existsAfter ? undefined : '');
            if (existsBefore && beforeRaw === undefined) continue;
            if (existsAfter && afterRaw === undefined) continue;
            const beforeText = this.normalizeText(beforeRaw || '');
            const afterText = this.normalizeText(afterRaw || '');
            const beforeBlobId = this.hashText(beforeText);
            const afterBlobId = this.hashText(afterText);
            if (!this.blobStore.has(beforeBlobId)) {
                this.blobStore.set(beforeBlobId, beforeText);
            }
            if (!this.blobStore.has(afterBlobId)) {
                this.blobStore.set(afterBlobId, afterText);
            }
            fileChanges.push({
                path: file.filePath,
                beforeBlobId,
                afterBlobId
            });
        }
        if (!fileChanges.length) return undefined;
        const opId = `op_${Date.now()}_${this.seqCounter}`;
        const op: PatchOp = {
            opId,
            messageId,
            messageIndex,
            seq: this.seqCounter++,
            files: fileChanges
        };
        this.patchOps.push(op);
        const list = this.patchOpsByMessageId.get(messageId) || [];
        list.push(opId);
        this.patchOpsByMessageId.set(messageId, list);
        const hasBeforeAfter = files.some((file) => typeof file.before === 'string' || typeof file.after === 'string');
        this.logUiDebug(`snapshot.bind | msgId | ${messageId} | filesCount | ${files.length} | hasBeforeAfter | ${hasBeforeAfter}`);
        return op;
    }

    private getPatchOpsFromIndex(startIndex: number): PatchOp[] {
        return this.patchOps.filter((op) => op.messageIndex >= startIndex);
    }

    private getWorkspaceRoot(): string {
        const workspaceFolder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
            ? vscode.workspace.workspaceFolders[0].uri.fsPath
            : process.cwd();
        return workspaceFolder;
    }

    private getUndoRoot(sessionId: string): string {
        return path.join(this.getWorkspaceRoot(), '.opencode', 'undo', sessionId);
    }

    private getMessageSnapshotDir(sessionId: string, messageId: string): string {
        return path.join(this.getUndoRoot(sessionId), messageId);
    }

    private getMessageMetaPath(sessionId: string, messageId: string): string {
        return path.join(this.getMessageSnapshotDir(sessionId, messageId), 'meta.json');
    }

    private async removeMessageSnapshot(sessionId: string, messageId: string): Promise<void> {
        const dirPath = this.getMessageSnapshotDir(sessionId, messageId);
        if (!fs.existsSync(dirPath)) return;
        await fs.promises.rm(dirPath, { recursive: true, force: true });
    }

    private normalizeRelPath(relPath: string): string {
        return relPath.replace(/\\/g, '/');
    }

    private resolveSnapshotRelPath(filePath: string, workspaceRoot: string): string {
        const rawRel = path.isAbsolute(filePath)
            ? path.relative(workspaceRoot, filePath)
            : filePath;
        if (!rawRel || rawRel.startsWith('..') || path.isAbsolute(rawRel)) {
            const safeBase = path.basename(filePath);
            return this.normalizeRelPath(path.join('_external', safeBase));
        }
        return this.normalizeRelPath(rawRel);
    }

    private async persistMessageCheckpoint(messageId: string, messageIndex: number, files: FileSnapshot[]): Promise<void> {
        const sessionId = this.currentSessionId;
        if (!sessionId) return;
        const workspaceRoot = this.getWorkspaceRoot();
        const messageDir = this.getMessageSnapshotDir(sessionId, messageId);
        const preDir = path.join(messageDir, 'pre');
        const postDir = path.join(messageDir, 'post');
        const meta: MessageSnapshotMeta = {
            messageId,
            messageIndex,
            timestamp: Date.now(),
            files: []
        };

        await fs.promises.mkdir(preDir, { recursive: true });
        await fs.promises.mkdir(postDir, { recursive: true });

        for (const file of files) {
            const relPath = this.resolveSnapshotRelPath(file.filePath, workspaceRoot);
            const existsBefore = typeof file.existsBefore === 'boolean'
                ? file.existsBefore
                : (file.type === 'create' ? false : file.type === 'delete' ? true : true);
            const existsAfter = typeof file.existsAfter === 'boolean'
                ? file.existsAfter
                : (file.type === 'create' ? true : file.type === 'delete' ? false : true);

            let beforeText = typeof file.before === 'string' ? file.before : undefined;
            let afterText = typeof file.after === 'string' ? file.after : undefined;
            if (existsBefore && beforeText === undefined) {
                beforeText = await fs.promises.readFile(file.filePath, 'utf-8').catch(() => '');
            }
            if (existsAfter && afterText === undefined) {
                afterText = await fs.promises.readFile(file.filePath, 'utf-8').catch(() => '');
            }
            const normalizedBefore = typeof beforeText === 'string' ? this.normalizeText(beforeText) : '';
            const normalizedAfter = typeof afterText === 'string' ? this.normalizeText(afterText) : '';
            const preHash = existsBefore ? this.hashText(normalizedBefore) : undefined;
            const postHash = existsAfter ? this.hashText(normalizedAfter) : undefined;
            meta.files.push({
                path: relPath,
                existsBefore,
                existsAfter,
                preHash,
                postHash
            });

            if (existsBefore) {
                const targetPath = path.join(preDir, relPath);
                await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
                await fs.promises.writeFile(targetPath, normalizedBefore, 'utf-8');
            }
            if (existsAfter) {
                const targetPath = path.join(postDir, relPath);
                await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
                await fs.promises.writeFile(targetPath, normalizedAfter, 'utf-8');
            }
        }

        await fs.promises.writeFile(this.getMessageMetaPath(sessionId, messageId), JSON.stringify(meta, null, 2), 'utf-8');
    }

    private async readMessageMeta(sessionId: string, messageId: string): Promise<MessageSnapshotMeta | undefined> {
        const metaPath = this.getMessageMetaPath(sessionId, messageId);
        if (!fs.existsSync(metaPath)) return undefined;
        try {
            const raw = await fs.promises.readFile(metaPath, 'utf-8');
            return JSON.parse(raw) as MessageSnapshotMeta;
        } catch {
            return undefined;
        }
    }

    private async loadMessageSnapshot(sessionId: string, messageId: string): Promise<{ messageId: string; messageIndex: number; files: Array<{ absPath: string; relPath: string; existsBefore: boolean; existsAfter: boolean; beforeText: string; afterText: string; }> } | undefined> {
        const meta = await this.readMessageMeta(sessionId, messageId);
        if (!meta) return undefined;
        const workspaceRoot = this.getWorkspaceRoot();
        const baseDir = this.getMessageSnapshotDir(sessionId, messageId);
        const preDir = path.join(baseDir, 'pre');
        const postDir = path.join(baseDir, 'post');
        const files = [] as Array<{ absPath: string; relPath: string; existsBefore: boolean; existsAfter: boolean; beforeText: string; afterText: string; }>;
        for (const file of meta.files) {
            const relPath = file.path;
            const absPath = path.join(workspaceRoot, relPath);
            const beforeText = file.existsBefore
                ? await fs.promises.readFile(path.join(preDir, relPath), 'utf-8').catch(() => '')
                : '';
            const afterText = file.existsAfter
                ? await fs.promises.readFile(path.join(postDir, relPath), 'utf-8').catch(() => '')
                : '';
            files.push({
                absPath,
                relPath,
                existsBefore: file.existsBefore,
                existsAfter: file.existsAfter,
                beforeText: this.normalizeText(beforeText),
                afterText: this.normalizeText(afterText)
            });
        }
        return { messageId: meta.messageId, messageIndex: meta.messageIndex, files };
    }

    private buildConflictDiff(expectedText: string, currentText: string): string {
        const patches = this.dmp.patch_make(expectedText, currentText);
        const patchText = this.dmp.patch_toText(patches);
        const header = `--- expected\n+++ current\n`;
        return `${header}${patchText}`.trim();
    }

    private async readCurrentFileState(filePath: string): Promise<{ exists: boolean; text: string }>{
        try {
            const stat = await fs.promises.stat(filePath);
            if (!stat.isFile()) {
                return { exists: false, text: '' };
            }
            const text = await fs.promises.readFile(filePath, 'utf-8');
            return { exists: true, text: this.normalizeText(text) };
        } catch {
            return { exists: false, text: '' };
        }
    }

    private async applyFileState(filePath: string, shouldExist: boolean, content: string): Promise<void> {
        if (!shouldExist) {
            if (fs.existsSync(filePath)) {
                await fs.promises.unlink(filePath).catch(() => undefined);
            }
            return;
        }
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(filePath, content, 'utf-8');
    }

    private getMessageIdsInRange(startIndex: number, endIndex: number): string[] {
        return this.messageOrder.filter((id) => {
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
        if (startIndex === undefined) {
            throw new Error('Unknown message for undo.');
        }
        const endIndex = this.messageOrder.length ? this.messageOrder.length - 1 : startIndex;
        OpenCodeClient.outputChannel.appendLine(`[UNDO] startId=${startMessageId} startIndex=${startIndex} endIndex=${endIndex}`);
        const sessionId = this.currentSessionId;
        const touchedFiles: string[] = [];
        if (!sessionId) {
            return { conflicts: [], touchedFiles, applied: false };
        }

        const messageIds = this.getMessageIdsInRange(startIndex, endIndex);
        OpenCodeClient.outputChannel.appendLine(`[UNDO] messageIdsInRange=${messageIds.length}`);
        const snapshots = [] as Array<{ messageId: string; messageIndex: number; files: Array<{ absPath: string; relPath: string; existsBefore: boolean; existsAfter: boolean; beforeText: string; afterText: string; }> }>;
        for (const id of messageIds) {
            const snapshot = await this.loadMessageSnapshot(sessionId, id);
            if (snapshot) snapshots.push(snapshot);
        }

        const conflicts: ConflictDetail[] = [];
        if (!force) {
            const expected = new Map<string, { exists: boolean; text: string }>();
            const orderedSnapshots = snapshots.slice().sort((a, b) => a.messageIndex - b.messageIndex);
            for (const snapshot of orderedSnapshots) {
                for (const file of snapshot.files) {
                    expected.set(file.absPath, {
                        exists: file.existsAfter,
                        text: file.existsAfter ? file.afterText : ''
                    });
                }
            }
            for (const [filePath, expectation] of expected.entries()) {
                const current = await this.readCurrentFileState(filePath);
                const existsMismatch = current.exists !== expectation.exists;
                const contentMismatch = expectation.exists && current.exists && current.text !== expectation.text;
                if (existsMismatch || contentMismatch) {
                    const diffText = this.buildConflictDiff(expectation.text, current.text);
                    conflicts.push({
                        path: filePath,
                        expectedExists: expectation.exists,
                        currentExists: current.exists,
                        diffText
                    });
                }
            }
            if (conflicts.length) {
                return { conflicts, touchedFiles, applied: false };
            }
        }

        const orderedSnapshots = snapshots.slice().sort((a, b) => b.messageIndex - a.messageIndex);
        for (const snapshot of orderedSnapshots) {
            for (const file of snapshot.files) {
                await this.applyFileState(file.absPath, file.existsBefore, file.beforeText);
                touchedFiles.push(file.absPath);
            }
        }

        this.revertedSegment = {
            isActive: true,
            discarded: false,
            startMessageId,
            startMessageIndex: startIndex,
            endMessageId: this.messageOrder[endIndex] || startMessageId,
            endMessageIndex: endIndex,
            opIds: [],
            collapsed: true,
            conflicts: [],
            messageIds: messageIds
        };

        return { conflicts, touchedFiles, applied: true };
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
        const force = options?.force === true;
        const touchedFiles: string[] = [];
        const messageIds = Array.isArray(segment.messageIds)
            ? segment.messageIds
            : this.getMessageIdsInRange(segment.startMessageIndex, segment.endMessageIndex);
        const snapshots = [] as Array<{ messageId: string; messageIndex: number; files: Array<{ absPath: string; relPath: string; existsBefore: boolean; existsAfter: boolean; beforeText: string; afterText: string; }> }>;
        for (const id of messageIds) {
            const snapshot = await this.loadMessageSnapshot(sessionId, id);
            if (snapshot) snapshots.push(snapshot);
        }

        const conflicts: ConflictDetail[] = [];
        if (!force) {
            const expected = new Map<string, { exists: boolean; text: string }>();
            const orderedSnapshots = snapshots.slice().sort((a, b) => a.messageIndex - b.messageIndex);
            for (const snapshot of orderedSnapshots) {
                for (const file of snapshot.files) {
                    if (!expected.has(file.absPath)) {
                        expected.set(file.absPath, {
                            exists: file.existsBefore,
                            text: file.existsBefore ? file.beforeText : ''
                        });
                    }
                }
            }
            for (const [filePath, expectation] of expected.entries()) {
                const current = await this.readCurrentFileState(filePath);
                const existsMismatch = current.exists !== expectation.exists;
                const contentMismatch = expectation.exists && current.exists && current.text !== expectation.text;
                if (existsMismatch || contentMismatch) {
                    const diffText = this.buildConflictDiff(expectation.text, current.text);
                    conflicts.push({
                        path: filePath,
                        expectedExists: expectation.exists,
                        currentExists: current.exists,
                        diffText
                    });
                }
            }
            if (conflicts.length) {
                return { conflicts, touchedFiles, applied: false };
            }
        }

        const orderedSnapshots = snapshots.slice().sort((a, b) => a.messageIndex - b.messageIndex);
        for (const snapshot of orderedSnapshots) {
            for (const file of snapshot.files) {
                await this.applyFileState(file.absPath, file.existsAfter, file.afterText);
                touchedFiles.push(file.absPath);
            }
        }

        segment.conflicts = [];
        segment.isActive = false;
        segment.collapsed = false;
        this.revertedSegment = segment;

        return { conflicts, touchedFiles, applied: true };
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
        this.patchOpsByMessageId.delete(messageId);
    }

    public async rollbackMessageSnapshot(messageId: string): Promise<string[]> {
        const sessionId = this.currentSessionId;
        const touchedFiles: string[] = [];
        if (!sessionId) return touchedFiles;
        const snapshot = await this.loadMessageSnapshot(sessionId, messageId);
        if (!snapshot) return touchedFiles;
        for (const file of snapshot.files) {
            await this.applyFileState(file.absPath, file.existsBefore, file.beforeText);
            touchedFiles.push(file.absPath);
        }
        await this.removeMessageSnapshot(sessionId, messageId);
        return touchedFiles;
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
        return this.parseModels(output);
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

    private parseSessions(output: string): SessionInfo[] {
        try {
            const sessions = JSON.parse(output);
            
            if (!Array.isArray(sessions)) {
                OpenCodeClient.outputChannel.appendLine(`EXT: parseSessions error | expected array, got ${typeof sessions}`);
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
            OpenCodeClient.outputChannel.appendLine(`EXT: parseSessions error | ${String(error)}`);
            return [];
        }
    }
}
