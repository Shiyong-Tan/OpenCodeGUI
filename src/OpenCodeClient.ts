import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';

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
    type: 'text' | 'session' | 'raw' | 'permission' | 'diff' | 'message' | 'error' | 'toolPatch' | 'files';
    text?: string;
    sessionId?: string;
    files?: FileSnapshot[];
};

export type FileSnapshot = {
    filePath: string;
    relativePath?: string;
    type?: 'update' | 'create' | 'delete';
    diff?: string;
    before?: string;
    after?: string;
    additions?: number;
    deletions?: number;
};

type FileChange = {
    path: string;
    beforeBlobId: string;
    afterBlobId: string;
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
    conflicts: string[];
    messageIds?: string[];
};

export class OpenCodeClient {
    public static outputChannel = vscode.window.createOutputChannel("OpenCode CLI");
    private currentChild?: cp.ChildProcess;
    private resolvedBin?: string;
    private useCmdWrapper = false;
    private messageIndexById = new Map<string, number>();
    private messageOrder: string[] = [];
    private nextMessageIndex = 0;
    private internalMessageSeq = 0;
    private seqCounter = 0;
    private patchOps: PatchOp[] = [];
    private patchOpsByMessageId = new Map<string, string[]>();
    private blobStore = new Map<string, string>();
    private revertedSegment?: RevertedSegment;

    public resetSessionState(): void {
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
                    const messageId = parsed.part?.messageID || parsed.part?.messageId || parsed.messageID || parsed.messageId;
                    if (messageId && onEvent) {
                        onEvent({ type: 'message', text: messageId, sessionId });
                        this.registerMessageId(messageId);
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
                            onEvent({ type: 'text', text: parsed.part.text, sessionId });
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
        if (parsed?.part?.tool !== 'apply_patch') return [];
        if (parsed?.part?.state?.status !== 'completed') return [];
        const stateFiles = Array.isArray(parsed?.part?.state?.metadata?.files)
            ? parsed.part.state.metadata.files
            : [];
        const files: FileSnapshot[] = [];
        for (const file of stateFiles) {
            if (!file?.filePath) continue;
            if (file?.type === 'delete') continue;
            files.push({
                filePath: file.filePath,
                relativePath: file.relativePath,
                type: file.type,
                diff: file.diff,
                before: file.before,
                after: file.after,
                additions: typeof file.additions === 'number' ? file.additions : undefined,
                deletions: typeof file.deletions === 'number' ? file.deletions : undefined
            });
        }
        return files;
    }

    private registerMessageId(messageId: string): number {
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
    }

    private hashText(text: string): string {
        return crypto.createHash('sha1').update(text).digest('hex');
    }

    private normalizeText(text: string): string {
        return text.replace(/\r\n/g, '\n');
    }

    private createPatchOp(messageId: string, files: FileSnapshot[]): PatchOp | undefined {
        const messageIndex = this.registerMessageId(messageId);
        const fileChanges: FileChange[] = [];
        for (const file of files) {
            if (!file.before || !file.after) continue;
            const beforeText = this.normalizeText(file.before);
            const afterText = this.normalizeText(file.after);
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
        return op;
    }

    private getPatchOpsFromIndex(startIndex: number): PatchOp[] {
        return this.patchOps.filter((op) => op.messageIndex >= startIndex);
    }

    public getRevertedSegment(): RevertedSegment | undefined {
        return this.revertedSegment;
    }

    public setRevertedSegment(segment: RevertedSegment | undefined): void {
        this.revertedSegment = segment;
    }

    public async undoFromMessage(startMessageId: string): Promise<{ conflicts: string[]; touchedFiles: string[] }> {
        if (this.revertedSegment?.isActive) {
            this.discardRevertedSegment();
        }
        const startIndex = this.messageIndexById.get(startMessageId);
        if (startIndex === undefined) {
            throw new Error('Unknown message for undo.');
        }
        const endIndex = this.messageOrder.length ? this.messageOrder.length - 1 : startIndex;
        const ops = this.getPatchOpsFromIndex(startIndex);
        const opIds = ops.map((op) => op.opId);
        const conflicts: string[] = [];
        const touchedFiles: string[] = [];

        this.revertedSegment = {
            isActive: true,
            discarded: false,
            startMessageId,
            startMessageIndex: startIndex,
            endMessageId: this.messageOrder[endIndex] || startMessageId,
            endMessageIndex: endIndex,
            opIds,
            collapsed: true,
            conflicts: [],
            messageIds: this.messageOrder.slice(startIndex, endIndex + 1)
        };

        if (!ops.length) {
            return { conflicts, touchedFiles };
        }

        const ordered = ops.slice().sort((a, b) => b.seq - a.seq);
        for (const op of ordered) {
            for (const file of op.files) {
                const afterText = this.blobStore.get(file.afterBlobId) || '';
                const beforeText = this.blobStore.get(file.beforeBlobId) || '';
                const current = await fs.promises.readFile(file.path, 'utf-8').catch(() => '');
                const normalizedCurrent = this.normalizeText(current);
                if (normalizedCurrent !== afterText) {
                    conflicts.push(file.path);
                    continue;
                }
                await fs.promises.mkdir(path.dirname(file.path), { recursive: true });
                await fs.promises.writeFile(file.path, beforeText, 'utf-8');
                touchedFiles.push(file.path);
            }
        }
        this.revertedSegment.conflicts = conflicts;
        return { conflicts, touchedFiles };
    }

    public async restoreAll(): Promise<{ conflicts: string[]; touchedFiles: string[] }> {
        const segment = this.revertedSegment;
        if (!segment?.isActive || segment.discarded) {
            throw new Error('No active reverted segment to restore.');
        }
        const opMap = new Map<string, PatchOp>();
        for (const op of this.patchOps) {
            opMap.set(op.opId, op);
        }
        const ordered = segment.opIds.map((id) => opMap.get(id)).filter(Boolean) as PatchOp[];
        const conflicts: string[] = [];
        const touchedFiles: string[] = [];
        for (const op of ordered) {
            for (const file of op.files) {
                const beforeText = this.blobStore.get(file.beforeBlobId) || '';
                const afterText = this.blobStore.get(file.afterBlobId) || '';
                const current = await fs.promises.readFile(file.path, 'utf-8').catch(() => '');
                const normalizedCurrent = this.normalizeText(current);
                if (normalizedCurrent !== beforeText) {
                    conflicts.push(file.path);
                    continue;
                }
                await fs.promises.mkdir(path.dirname(file.path), { recursive: true });
                await fs.promises.writeFile(file.path, afterText, 'utf-8');
                touchedFiles.push(file.path);
            }
        }
        segment.conflicts = conflicts;
        segment.isActive = false;
        segment.collapsed = false;
        this.revertedSegment = segment;
        return { conflicts, touchedFiles };
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
        const output = await this.execute(['session', 'list']);
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
        const lines = output.split(/\r?\n/);
        const sessions: SessionInfo[] = [];
        for (const line of lines) {
            if (line.startsWith('Session ID') || line.startsWith('─')) {
                continue;
            }
            const trimmed = line.trim();
            if (!trimmed) continue;
            const match = trimmed.match(/^(ses_[A-Za-z0-9]+)\s{2,}(.+?)\s{2,}(.+)$/);
            if (!match) continue;
            sessions.push({
                id: match[1],
                title: match[2],
                updated: match[3]
            });
        }
        return sessions;
    }
}
