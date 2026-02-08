import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitRepoManager } from './GitRepoManager';
import { GitSessionMapStore } from './GitSessionMapStore';
import { RepoLockManager } from './GitLock';
import { normalizeRepoPath, normalizeTouchedFiles } from './GitPathUtils';
import { runGit } from './GitRunner';
import {
    ConflictInfo,
    EMPTY_TREE_HASH,
    FileChangeSpec,
    GitCapabilities,
    GitRepoRef,
    RestoreResult,
    SessionEntry,
    UndoResult
} from './types';

type Logger = (message: string) => void;

type BaselineConfig = {
    mode: 'heuristic' | 'allowGlobsOnly';
    allowGlobs: string[];
    excludeGlobs: string[];
    maxFileSizeBytes: number;
    maxTotalBytes: number;
    denyExts: Set<string>;
};

const flattenChanges = (changes: FileChangeSpec[]): FileChangeSpec[] => {
    const out: FileChangeSpec[] = [];
    for (const change of changes) {
        if (change.type === 'multi') {
            out.push(...flattenChanges(change.items));
        } else {
            out.push(change);
        }
    }
    return out;
};

const unique = (list: string[]): string[] => Array.from(new Set(list));

export class GitUndoEngine {
    private readonly repoManager: GitRepoManager;
    private readonly mapStore: GitSessionMapStore;
    private readonly lockManager: RepoLockManager;
    private readonly workspaceRoot: string;
    private readonly logger: Logger;
    private capabilities: GitCapabilities = { gitAvailable: false, reason: 'unknown' };

    constructor(workspaceRoot: string, logger: Logger) {
        this.workspaceRoot = workspaceRoot;
        this.logger = logger;
        this.repoManager = new GitRepoManager(workspaceRoot, logger);
        this.mapStore = new GitSessionMapStore(workspaceRoot, logger);
        this.lockManager = new RepoLockManager();
    }

    private getBaselineConfig(): BaselineConfig {
        const config = vscode.workspace.getConfiguration('opencode.undo');
        const mode = config.get<string>('baselineMode', 'heuristic') === 'allowGlobsOnly'
            ? 'allowGlobsOnly'
            : 'heuristic';
        const allowGlobs = config.get<string[]>('baselineAllowGlobs', []) || [];
        const excludeGlobs = config.get<string[]>('baselineExcludeGlobs', []) || [];
        const maxFileSizeMb = config.get<number>('baselineMaxFileSizeMB', 5);
        const maxTotalMb = config.get<number>('baselineMaxTotalMB', 200);
        const denyExts = new Set([
            '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.svg', '.tif', '.tiff', '.heic',
            '.mp4', '.mov', '.avi', '.mkv', '.mp3', '.wav', '.ogg', '.flac',
            '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz', '.tgz', '.zst',
            '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.pdb', '.a', '.o', '.obj', '.class', '.jar', '.wasm',
            '.model', '.onnx', '.pt', '.pth', '.gguf', '.npy', '.npz', '.h5', '.hdf5', '.mat',
            '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx',
            '.db', '.sqlite', '.parquet', '.arrow'
        ]);
        return {
            mode,
            allowGlobs,
            excludeGlobs,
            maxFileSizeBytes: Math.max(1, maxFileSizeMb) * 1024 * 1024,
            maxTotalBytes: Math.max(1, maxTotalMb) * 1024 * 1024,
            denyExts
        };
    }

    private buildExcludeGlob(defaults: string[], extra: string[]): string | undefined {
        const merged = [...defaults, ...extra].filter(Boolean);
        if (!merged.length) return undefined;
        if (merged.length === 1) return merged[0];
        return `{${merged.join(',')}}`;
    }

    private async scanBaselineFiles(config: BaselineConfig): Promise<string[]> {
        const defaults = [
            '**/.git/**',
            '**/.opencode/**',
            '**/node_modules/**',
            '**/dist/**',
            '**/build/**',
            '**/.next/**',
            '**/out/**',
            '**/target/**',
            '**/bin/**',
            '**/obj/**'
        ];
        const exclude = this.buildExcludeGlob(defaults, config.excludeGlobs);
        const includePatterns = config.mode === 'allowGlobsOnly' && config.allowGlobs.length
            ? config.allowGlobs
            : ['**/*'];
        const fileSet = new Set<string>();
        let totalBytes = 0;

        for (const pattern of includePatterns) {
            const relative = new vscode.RelativePattern(this.workspaceRoot, pattern);
            const uris = await vscode.workspace.findFiles(relative, exclude);
            for (const uri of uris) {
                const fsPath = uri.fsPath;
                const normalized = normalizeRepoPath(this.workspaceRoot, fsPath);
                if (!normalized) continue;
                if (fileSet.has(normalized)) continue;

                let stat: fs.Stats;
                try {
                    stat = await fs.promises.lstat(fsPath);
                } catch {
                    continue;
                }
                if (stat.isSymbolicLink() || !stat.isFile()) continue;
                if (stat.size > config.maxFileSizeBytes) continue;
                if (totalBytes + stat.size > config.maxTotalBytes) {
                    this.logger(`baseline.maxTotalExceeded | limit=${config.maxTotalBytes}`);
                    continue;
                }
                const ext = path.extname(fsPath).toLowerCase();
                if (ext && config.denyExts.has(ext)) continue;

                let fd: fs.promises.FileHandle | undefined;
                try {
                    fd = await fs.promises.open(fsPath, 'r');
                    const buffer = Buffer.alloc(8192);
                    const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
                    const slice = buffer.subarray(0, bytesRead);
                    if (slice.includes(0)) {
                        continue;
                    }
                } catch {
                    continue;
                } finally {
                    if (fd) {
                        try { await fd.close(); } catch { /* ignore */ }
                    }
                }

                fileSet.add(normalized);
                totalBytes += stat.size;
            }
        }
        return Array.from(fileSet);
    }

    private getBaselineMarkerPath(repo: GitRepoRef): string {
        return path.join(repo.gitDir, 'baseline.json');
    }

    private async readBaselineMarker(repo: GitRepoRef): Promise<string | null> {
        const markerPath = this.getBaselineMarkerPath(repo);
        if (!fs.existsSync(markerPath)) return null;
        try {
            const raw = await fs.promises.readFile(markerPath, 'utf-8');
            const parsed = JSON.parse(raw);
            return typeof parsed?.baselineCommit === 'string' ? parsed.baselineCommit : null;
        } catch {
            return null;
        }
    }

    private async writeBaselineMarker(repo: GitRepoRef, baselineCommit: string): Promise<void> {
        const markerPath = this.getBaselineMarkerPath(repo);
        const tmpPath = `${markerPath}.tmp`;
        await fs.promises.writeFile(tmpPath, JSON.stringify({ baselineCommit }, null, 2), 'utf-8');
        try {
            await fs.promises.unlink(markerPath);
        } catch {
            // ignore
        }
        await fs.promises.rename(tmpPath, markerPath);
    }

    private async createBaselineCommit(repo: GitRepoRef, tag: string): Promise<string | null> {
        const marker = await this.readBaselineMarker(repo);
        if (marker) return marker;
        this.logger(`baseline.init.start | sessionId=${tag}`);
        const config = this.getBaselineConfig();
        const baselineFiles = await this.scanBaselineFiles(config);
        this.logger(`baseline.fileCount | sessionId=${tag} count=${baselineFiles.length}`);
        const filteredFiles: string[] = [];
        const ignoredSamples: string[] = [];
        for (const filePath of baselineFiles) {
            const ignoreResult = await runGit(repo, ['check-ignore', '-q'], { paths: [filePath] });
            if (ignoreResult.code === 0) {
                if (ignoredSamples.length < 5) {
                    ignoredSamples.push(filePath);
                }
                continue;
            }
            filteredFiles.push(filePath);
        }
        const ignoredCount = baselineFiles.length - filteredFiles.length;
        if (ignoredCount) {
            this.logger(`baseline.ignore.filtered | sessionId=${tag} count=${ignoredCount}`);
            if (ignoredSamples.length) {
                this.logger(`baseline.ignore.sample | sessionId=${tag} items=${ignoredSamples.join(',')}`);
            }
        }
        if (filteredFiles.length) {
            const addResult = await runGit(repo, ['add'], { paths: filteredFiles });
            this.logger(`baseline.add.result | sessionId=${tag} code=${addResult.code} stderr=${addResult.stderr.trim() || 'null'}`);
            if (addResult.code !== 0) {
                this.logger(`baseline.failed | sessionId=${tag} reason=add-failed`);
                return null;
            }
        }
        const staged = await runGit(repo, ['diff', '--cached', '--name-only']);
        const stagedList = staged.stdout.trim();
        const stagedEmpty = !stagedList;
        const stagedCount = stagedList ? stagedList.split('\n').filter(Boolean).length : 0;
        this.logger(`baseline.cached.count | sessionId=${tag} count=${stagedCount}`);
        const commitArgs = stagedEmpty
            ? ['commit', '--allow-empty', '-m', 'baseline']
            : ['commit', '-m', 'baseline'];
        const commitResult = await runGit(repo, commitArgs, { commitIdentity: true });
        this.logger(`baseline.commit.result | sessionId=${tag} code=${commitResult.code} stderr=${commitResult.stderr.trim() || 'null'}`);
        if (commitResult.code !== 0) {
            this.logger(`baseline.failed | sessionId=${tag} reason=commit-failed`);
            return null;
        }
        const head = await runGit(repo, ['rev-parse', 'HEAD']);
        const baselineCommit = head.stdout.trim();
        await this.writeBaselineMarker(repo, baselineCommit);
        this.logger(`baseline.commitHash | sessionId=${tag} commit=${baselineCommit}`);
        return baselineCommit;
    }

    private async ensureBaseline(repo: GitRepoRef, sessionId: string, map: import('./types').SessionMap): Promise<import('./types').SessionMap> {
        if (map.baselineCommit) return map;
        if (map.headCommit) {
            const updated = { ...map, baselineCommit: map.headCommit };
            await this.mapStore.saveSessionMap(sessionId, updated);
            return updated;
        }
        const marker = await this.readBaselineMarker(repo);
        if (marker) {
            const next = { ...map, baselineCommit: marker, headCommit: map.headCommit || marker };
            await this.mapStore.saveSessionMap(sessionId, next);
            return next;
        }
        const baselineCommit = await this.createBaselineCommit(repo, sessionId);
        if (!baselineCommit) return map;
        const updated = { ...map, baselineCommit, headCommit: baselineCommit };
        await this.mapStore.saveSessionMap(sessionId, updated);
        return updated;
    }

    public async detectGitCapabilities(): Promise<GitCapabilities> {
        this.capabilities = await this.repoManager.detectGitCapabilities();
        return this.capabilities;
    }

    public async ensureBaselineReady(sessionId: string, turnKey?: string): Promise<{ ok: boolean; reason?: string }> {
        if (!this.isEnabled()) {
            return { ok: false, reason: 'git-disabled' };
        }
        if (!sessionId) {
            return { ok: false, reason: 'missing-session' };
        }
        const repo = await this.repoManager.resolveRepo(sessionId, turnKey);
        return this.lockManager.withRepoLock(repo, this.logger, async () => {
            const map = await this.mapStore.loadSessionMap(sessionId, repo.repoId);
            const updated = await this.ensureBaseline(repo, sessionId, map);
            const ok = Boolean(updated.baselineCommit);
            this.logger(`baseline.ready | sessionId=${sessionId} ok=${String(ok)}`);
            return ok ? { ok: true } : { ok: false, reason: 'baseline-failed' };
        });
    }

    public async ensureBaselineForTurn(turnKey: string): Promise<{ ok: boolean; reason?: string }> {
        if (!this.isEnabled()) {
            return { ok: false, reason: 'git-disabled' };
        }
        if (!turnKey) {
            return { ok: false, reason: 'missing-turnKey' };
        }
        const repo = await this.repoManager.resolveRepo(undefined, turnKey);
        return this.lockManager.withRepoLock(repo, this.logger, async () => {
            const baselineCommit = await this.createBaselineCommit(repo, turnKey);
            const ok = Boolean(baselineCommit);
            this.logger(`baseline.ready | sessionId=${turnKey} ok=${String(ok)}`);
            return ok ? { ok: true } : { ok: false, reason: 'baseline-failed' };
        });
    }

    public getCapabilities(): GitCapabilities {
        return this.capabilities;
    }

    public isEnabled(): boolean {
        return Boolean(this.capabilities.gitAvailable);
    }

    public async commitFileChanges(
        sessionId: string,
        turnKey: string,
        tmpKey: string | undefined,
        assistantMsgId: string | undefined,
        changes: FileChangeSpec[],
        messageIndex?: number
    ): Promise<{ commitHash?: string; touchedFiles: string[] }>
    {
        if (!this.isEnabled()) {
            this.logger(`commit.skip | reason=git-disabled sessionId=${sessionId}`);
            return { touchedFiles: [] };
        }
        if (!sessionId || !turnKey) {
            this.logger(`commit.skip | reason=missing-session-or-turn sessionId=${sessionId || 'null'} turnKey=${turnKey || 'null'}`);
            return { touchedFiles: [] };
        }
        const repo = await this.repoManager.resolveRepo(sessionId, turnKey);
        return this.lockManager.withRepoLock(repo, this.logger, async () => {
            const flat = flattenChanges(changes);
            const normalizedChanges: FileChangeSpec[] = [];
            const rawPaths: string[] = [];
            for (const item of flat) {
                if (item.type === 'rename') {
                    const oldPath = normalizeRepoPath(this.workspaceRoot, item.oldPath);
                    const newPath = normalizeRepoPath(this.workspaceRoot, item.newPath);
                    if (oldPath && newPath) {
                        normalizedChanges.push({ type: 'rename', oldPath, newPath });
                        rawPaths.push(oldPath, newPath);
                    }
                    continue;
                }
                if ('path' in item) {
                    const normalized = normalizeRepoPath(this.workspaceRoot, item.path);
                    if (normalized) {
                        normalizedChanges.push({ type: item.type, path: normalized } as FileChangeSpec);
                        rawPaths.push(normalized);
                    }
                }
            }
            const touchedFiles = normalizeTouchedFiles(this.workspaceRoot, rawPaths);
            if (!touchedFiles.length) {
                this.logger(`commit.noop | reason=no-touched-files sessionId=${sessionId}`);
                return { touchedFiles };
            }
            const map = await this.mapStore.loadSessionMap(sessionId, repo.repoId);
            const ensured = await this.ensureBaseline(repo, sessionId, map);
            if (!ensured.baselineCommit) {
                this.logger(`commit.skip | reason=baseline-not-ready sessionId=${sessionId}`);
                return { touchedFiles: [] };
            }

            for (const item of normalizedChanges) {
                if (item.type === 'delete') {
                    await runGit(repo, ['rm', '--ignore-unmatch'], { paths: [item.path] });
                } else if (item.type === 'rename') {
                    await runGit(repo, ['add', '-A'], { paths: [item.oldPath, item.newPath] });
                } else if (item.type === 'create' || item.type === 'update') {
                    await runGit(repo, ['add'], { paths: [item.path] });
                } else if (item.type === 'multi') {
                    // already flattened
                }
            }

            const staged = await runGit(repo, ['diff', '--cached', '--name-only']);
            const stagedList = staged.stdout.trim();
            if (!stagedList) {
                this.logger(`commit.noop | reason=empty-staged sessionId=${sessionId}`);
                return { touchedFiles };
            }

            const commitMsg = `opencode: ${turnKey} ${Date.now()}`;
            const commitResult = await runGit(repo, ['commit', '-m', commitMsg], { commitIdentity: true });
            if (commitResult.code !== 0) {
                this.logger(`commit.fail | sessionId=${sessionId} err=${commitResult.stderr.trim()}`);
                return { touchedFiles };
            }
            const head = await runGit(repo, ['rev-parse', 'HEAD']);
            const commitHash = head.stdout.trim();
            const entry: SessionEntry = {
                turnKey,
                tmpKey,
                assistantMsgId,
                messageIndex,
                commitHash,
                touchedFiles,
                opType: normalizedChanges.length > 1 ? 'multi' : (normalizedChanges[0]?.type === 'rename' ? 'rename' : (normalizedChanges[0]?.type || 'update')),
                timestamp: Date.now()
            };
            const updated = this.mapStore.appendEntry({ ...ensured, headCommit: commitHash, currentBaseCommit: commitHash }, entry);
            if (tmpKey) {
                updated.tmpToCommit[tmpKey] = commitHash;
            }
            await this.mapStore.saveSessionMap(sessionId, updated);
            this.logger(`commit.ok | sessionId=${sessionId} commitHash=${commitHash} files=${touchedFiles.length}`);
            return { commitHash, touchedFiles };
        });
    }

    public async finalizeBinding(sessionId: string, tmpKey: string | undefined, finalMsgId: string, userMsgId?: string): Promise<void> {
        if (!this.isEnabled()) return;
        if (!sessionId || !tmpKey || !finalMsgId) {
            this.logger(`finalizeBinding.skip | sessionId=${sessionId || 'null'} tmpKey=${tmpKey || 'null'} finalMsgId=${finalMsgId || 'null'}`);
            return;
        }
        const repo = await this.repoManager.resolveRepo(sessionId, tmpKey);
        await this.lockManager.withRepoLock(repo, this.logger, async () => {
            const map = await this.mapStore.loadSessionMap(sessionId, repo.repoId);
            const commitHash = map.tmpToCommit[tmpKey];
            if (!commitHash) {
                this.logger(`finalizeBinding.noop | reason=missing-tmpKey sessionId=${sessionId} tmpKey=${tmpKey}`);
                return;
            }
            let updated = this.mapStore.bindFinalMsg(map, tmpKey, finalMsgId);
            if (userMsgId) {
                updated.msgToCommit[userMsgId] = commitHash;
            }
            const entryFound = updated.entries.some((entry) => entry.tmpKey === tmpKey && entry.commitHash === commitHash);
            if (!entryFound) {
                this.logger(`finalizeBinding.orphan | sessionId=${sessionId} tmpKey=${tmpKey} finalMsgId=${finalMsgId}`);
            }
            await this.mapStore.saveSessionMap(sessionId, updated);
            this.logger(`finalizeBinding.ok | sessionId=${sessionId} tmpKey=${tmpKey} finalMsgId=${finalMsgId} commitHash=${commitHash}`);
        });
    }

    private async getCommitParent(repo: GitRepoRef, commitHash: string): Promise<string | null> {
        const result = await runGit(repo, ['rev-parse', `${commitHash}^`]);
        if (result.code !== 0) {
            return null;
        }
        const parent = result.stdout.trim();
        return parent || null;
    }

    private async computeFileSet(repo: GitRepoRef, targetCommit: string, headCommit: string, touchedUnion: string[]): Promise<string[]> {
        const diffResult = await runGit(repo, ['diff', '--name-only', `${targetCommit}..${headCommit}`]);
        const diffPaths = diffResult.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => Boolean(line));
        const fileSet = unique([...diffPaths, ...touchedUnion]);
        this.logger(`fileSet | changed=${diffPaths.length} touched=${touchedUnion.length} total=${fileSet.length}`);
        return fileSet;
    }

    private async ensureWorkspaceMatchesCommit(repo: GitRepoRef, commit: string, fileSet: string[], includeDiff = false): Promise<ConflictInfo[]> {
        const conflicts: ConflictInfo[] = [];
        for (const filePath of fileSet) {
            const existsInCommit = (await runGit(repo, ['cat-file', '-e', `${commit}:${filePath}`])).code === 0;
            const absPath = path.join(repo.workTree, filePath);
            const existsInWorkspace = fs.existsSync(absPath);
            if (!existsInCommit && existsInWorkspace) {
                conflicts.push({ path: filePath });
                continue;
            }
            if (existsInCommit) {
                const diff = await runGit(repo, ['diff', '--name-only', commit], { paths: [filePath] });
                if (diff.stdout.trim()) {
                    let diffText = '';
                    if (includeDiff) {
                        const fullDiff = await runGit(repo, ['diff', commit], { paths: [filePath] });
                        diffText = fullDiff.stdout || '';
                    }
                    conflicts.push({ path: filePath, diffText });
                }
            }
        }
        return conflicts;
    }

    private async applyCheckoutToCommit(repo: GitRepoRef, commit: string, fileSet: string[]): Promise<{ deleted: string[]; checkedOut: string[] }> {
        const deleted: string[] = [];
        const checkedOut: string[] = [];
        for (const filePath of fileSet) {
            const existsInCommit = (await runGit(repo, ['cat-file', '-e', `${commit}:${filePath}`])).code === 0;
            const absPath = path.join(repo.workTree, filePath);
            if (existsInCommit) {
                await runGit(repo, ['checkout', commit], { paths: [filePath] });
                checkedOut.push(filePath);
            } else {
                this.logger(`skipped-missing-in-target | commit=${commit} path=${filePath}`);
            }
        }
        return { deleted, checkedOut };
    }

    private collectTouchedUnion(map: { entries: SessionEntry[] }, startCommit: string, headCommit: string): string[] {
        const startIndex = map.entries.findIndex((entry) => entry.commitHash === startCommit);
        const endIndex = map.entries.findIndex((entry) => entry.commitHash === headCommit);
        if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) return [];
        const slice = map.entries.slice(startIndex, endIndex + 1);
        const paths = slice.flatMap((entry) => entry.touchedFiles || []);
        return unique(paths);
    }

    private async filterTrackedFiles(repo: GitRepoRef, fileSet: string[]): Promise<string[]> {
        const before = fileSet.length;
        const tracked: string[] = [];
        for (const filePath of fileSet) {
            const result = await runGit(repo, ['ls-files', '--error-unmatch'], { paths: [filePath] });
            if (result.code === 0) {
                tracked.push(filePath);
            } else {
                this.logger(`skipped-untracked | path=${filePath}`);
            }
        }
        this.logger(`fileSet.filter | before=${before} after=${tracked.length}`);
        return tracked;
    }

    public async undoFromMessage(sessionId: string, startMsgId: string, force = false): Promise<UndoResult> {
        if (!this.isEnabled()) {
            return { conflicts: [], touchedFiles: [], applied: false };
        }
        const repo = await this.repoManager.resolveRepo(sessionId, startMsgId);
        return this.lockManager.withRepoLock(repo, this.logger, async () => {
            this.logger(`undo.start | sessionId=${sessionId} startMsgId=${startMsgId}`);
            const map = await this.mapStore.loadSessionMap(sessionId, repo.repoId);
            const startCommit = map.msgToCommit[startMsgId];
            if (!startCommit) {
                this.logger(`undo.missing | reason=missing-startCommit sessionId=${sessionId} startMsgId=${startMsgId}`);
                return { conflicts: [], touchedFiles: [], applied: false };
            }
            const headCommit = map.headCommit;
            if (!headCommit) {
                this.logger(`undo.missing | reason=missing-headCommit sessionId=${sessionId}`);
                return { conflicts: [], touchedFiles: [], applied: false };
            }
            const baseCommit = map.currentBaseCommit || headCommit;
            const parent = await this.getCommitParent(repo, startCommit);
            const targetCommit = parent || EMPTY_TREE_HASH;
            if (!parent) {
                this.logger(`undo.target.no-parent | sessionId=${sessionId} startCommit=${startCommit}`);
            }
            const touchedUnion = this.collectTouchedUnion(map, startCommit, headCommit);
            const fileSet = await this.computeFileSet(repo, targetCommit, headCommit, touchedUnion);
            this.logger(`fileSet.beforeFilter | size=${fileSet.length}`);
            const filteredFileSet = await this.filterTrackedFiles(repo, fileSet);
            this.logger(`fileSet.afterFilter | size=${filteredFileSet.length}`);
            if (!filteredFileSet.length) {
                return { conflicts: [], touchedFiles: [], applied: true, startCommit, startCommits: [startCommit], restoreCommit: headCommit, undoTargetCommit: targetCommit, fileSet: filteredFileSet };
            }
            const conflicts = force ? [] : await this.ensureWorkspaceMatchesCommit(repo, baseCommit, filteredFileSet);
            this.logger(`precheck | commit=${baseCommit} fileSet=${filteredFileSet.length} conflicts=${conflicts.length}`);
            if (conflicts.length) {
                return { conflicts, touchedFiles: [], applied: false, startCommit, startCommits: [startCommit], restoreCommit: headCommit, undoTargetCommit: targetCommit, fileSet: filteredFileSet };
            }
            const applied = await this.applyCheckoutToCommit(repo, targetCommit, filteredFileSet);
            this.logger(`undo.apply | sessionId=${sessionId} fileSet=${filteredFileSet.length} deleted=${applied.deleted.length} checkedOut=${applied.checkedOut.length}`);
            const updated = { ...map, currentBaseCommit: targetCommit };
            await this.mapStore.saveSessionMap(sessionId, updated);
            return {
                conflicts: [],
                touchedFiles: [...applied.checkedOut, ...applied.deleted],
                applied: true,
                startCommit,
                startCommits: [startCommit],
                restoreCommit: headCommit,
                undoTargetCommit: targetCommit,
                fileSet: filteredFileSet
            };
        });
    }

    public async restoreAll(sessionId: string, restoreCommit: string, fileSet: string[], undoTargetCommit: string): Promise<RestoreResult> {
        if (!this.isEnabled()) {
            return { conflicts: [], touchedFiles: [], applied: false };
        }
        const repo = await this.repoManager.resolveRepo(sessionId, restoreCommit);
        return this.lockManager.withRepoLock(repo, this.logger, async () => {
            this.logger(`restore.start | sessionId=${sessionId} restoreCommit=${restoreCommit} fileSet=${fileSet.length}`);
            if (!fileSet.length) {
                return { conflicts: [], touchedFiles: [], applied: true };
            }
            const conflicts = await this.ensureWorkspaceMatchesCommit(repo, undoTargetCommit, fileSet);
            this.logger(`precheck | commit=${undoTargetCommit} fileSet=${fileSet.length} conflicts=${conflicts.length}`);
            if (conflicts.length) {
                return { conflicts, touchedFiles: [], applied: false };
            }
            const applied = await this.applyCheckoutToCommit(repo, restoreCommit, fileSet);
            this.logger(`restore.apply | sessionId=${sessionId} deleted=${applied.deleted.length} checkedOut=${applied.checkedOut.length}`);
            const map = await this.mapStore.loadSessionMap(sessionId, repo.repoId);
            const updated = { ...map, currentBaseCommit: restoreCommit };
            await this.mapStore.saveSessionMap(sessionId, updated);
            return { conflicts: [], touchedFiles: [...applied.checkedOut, ...applied.deleted], applied: true };
        });
    }

    public async restoreToMessage(sessionId: string, msgId: string, messageIds: string[] = [], force = false): Promise<RestoreResult> {
        if (!this.isEnabled()) {
            return { conflicts: [], touchedFiles: [], applied: false };
        }
        const repo = await this.repoManager.resolveRepo(sessionId, msgId);
        return this.lockManager.withRepoLock(repo, this.logger, async () => {
            const map = await this.mapStore.loadSessionMap(sessionId, repo.repoId);
            const restoreCommit = map.msgToCommit[msgId];
            if (!restoreCommit) {
                this.logger(`restore.missing | reason=missing-commit sessionId=${sessionId} msgId=${msgId}`);
                return { conflicts: [], touchedFiles: [], applied: false };
            }
            const uniqueMsgIds = Array.isArray(messageIds)
                ? Array.from(new Set(messageIds.filter((id) => typeof id === 'string' && id.startsWith('msg_'))))
                : [];
            const commits = uniqueMsgIds
                .map((id) => map.msgToCommit[id])
                .filter((id): id is string => typeof id === 'string' && id.length > 0);
            const commitOrder = new Map<string, number>();
            for (let i = 0; i < map.entries.length; i++) {
                const entry = map.entries[i];
                commitOrder.set(entry.commitHash, i);
            }
            const orderedCommits = commits.length
                ? Array.from(new Set(commits)).sort((a, b) => (commitOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (commitOrder.get(b) ?? Number.MAX_SAFE_INTEGER))
                : [restoreCommit];

            const firstCommit = orderedCommits[0];
            const parent = await this.getCommitParent(repo, firstCommit);
            const baseCommit = parent || map.baselineCommit || firstCommit;
            const precheckCommit = map.currentBaseCommit || baseCommit;

            let fileSet: string[] = [];
            for (const commitHash of orderedCommits) {
                const parentCommit = await this.getCommitParent(repo, commitHash);
                if (parentCommit) {
                    const diffResult = await runGit(repo, ['diff', '--name-only', `${parentCommit}..${commitHash}`]);
                    const paths = diffResult.stdout
                        .split('\n')
                        .map((line) => line.trim())
                        .filter((line) => Boolean(line));
                    fileSet.push(...paths);
                } else {
                    const diffResult = await runGit(repo, ['diff', '--name-only', commitHash]);
                    const paths = diffResult.stdout
                        .split('\n')
                        .map((line) => line.trim())
                        .filter((line) => Boolean(line));
                    fileSet.push(...paths);
                }
            }
            fileSet = unique(fileSet);
            this.logger(`fileSet.beforeFilter | size=${fileSet.length}`);
            const filteredFileSet = await this.filterTrackedFiles(repo, fileSet);
            this.logger(`fileSet.afterFilter | size=${filteredFileSet.length}`);
            if (!filteredFileSet.length) {
                return { conflicts: [], touchedFiles: [], applied: true };
            }
            const conflicts = force ? [] : await this.ensureWorkspaceMatchesCommit(repo, precheckCommit, filteredFileSet, true);
            this.logger(`precheck | commit=${precheckCommit} fileSet=${filteredFileSet.length} conflicts=${conflicts.length}`);
            if (conflicts.length) {
                return { conflicts, touchedFiles: [], applied: false };
            }
            const applied = await this.applyCheckoutToCommit(repo, restoreCommit, filteredFileSet);
            this.logger(`restore.apply | sessionId=${sessionId} deleted=${applied.deleted.length} checkedOut=${applied.checkedOut.length}`);
            const updated = { ...map, currentBaseCommit: restoreCommit };
            await this.mapStore.saveSessionMap(sessionId, updated);
            return { conflicts: [], touchedFiles: [...applied.checkedOut, ...applied.deleted], applied: true };
        });
    }
}
