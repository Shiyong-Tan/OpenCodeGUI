import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import { GitCapabilities, GitRepoRef, IndexMap, MIN_GIT_VERSION } from './types';

type Logger = (message: string) => void;

type ResolvedRepoCacheEntry = {
    ref: GitRepoRef;
    fingerprint: string;
};

type InFlightResolution = {
    promise: Promise<GitRepoRef>;
    coalescedLogged: boolean;
};

const compareVersions = (a: string, b: string): number => {
    const toParts = (v: string) => v.split('.').map((n) => parseInt(n, 10));
    const pa = toParts(a);
    const pb = toParts(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const av = pa[i] ?? 0;
        const bv = pb[i] ?? 0;
        if (av > bv) return 1;
        if (av < bv) return -1;
    }
    return 0;
};

const parseGitVersion = (raw: string): string | null => {
    const match = raw.match(/git version ([0-9.]+)/i);
    if (!match) return null;
    return match[1];
};

const writeJsonAtomic = async (filePath: string, data: unknown): Promise<void> => {
    const tmpPath = `${filePath}.tmp`;
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    try {
        await fs.promises.unlink(filePath);
    } catch {
        // ignore
    }
    await fs.promises.rename(tmpPath, filePath);
};

export class GitRepoManager {
    private readonly workspaceRoot: string;
    private readonly baseDir: string;
    private readonly reposDir: string;
    private readonly indexPath: string;
    private readonly logger: Logger;
    private readonly resolvedRepos = new Map<string, ResolvedRepoCacheEntry>();
    private readonly inFlightResolutions = new Map<string, InFlightResolution>();
    private static readonly indexMutationTails = new Map<string, Promise<void>>();
    private static readonly MAX_RESOLVED_REPOS = 256;
    private static readonly WORKSPACE_IGNORE_BLOCK_START = '# >>> opencode:workspace-gitignore >>>';
    private static readonly WORKSPACE_IGNORE_BLOCK_END = '# <<< opencode:workspace-gitignore <<<';

    constructor(workspaceRoot: string, logger: Logger) {
        this.workspaceRoot = workspaceRoot;
        this.baseDir = path.join(workspaceRoot, '.opencode', 'git');
        this.reposDir = path.join(this.baseDir, 'repos');
        this.indexPath = path.join(this.baseDir, 'index.json');
        this.logger = logger;
    }

    public async detectGitCapabilities(): Promise<GitCapabilities> {
        return new Promise((resolve) => {
            cp.execFile('git', ['--version'], (err, stdout) => {
                if (err) {
                    this.logger(`detectGit.fail | reason=${String(err)}`);
                    resolve({ gitAvailable: false, reason: String(err) });
                    return;
                }
                const version = parseGitVersion(stdout || '');
                if (!version) {
                    this.logger(`detectGit.fail | reason=version-parse-failed`);
                    resolve({ gitAvailable: false, reason: 'version-parse-failed' });
                    return;
                }
                if (compareVersions(version, MIN_GIT_VERSION) < 0) {
                    this.logger(`detectGit.fail | reason=version-too-old | version=${version}`);
                    resolve({ gitAvailable: false, version, reason: 'version-too-old' });
                    return;
                }
                this.logger(`detectGit.ok | version=${version}`);
                resolve({ gitAvailable: true, version });
            });
        });
    }

    private async loadIndexJson(): Promise<IndexMap> {
        if (!fs.existsSync(this.indexPath)) {
            return { schemaVersion: 1, sessionToRepo: {}, turnToRepo: {} };
        }
        try {
            const raw = await fs.promises.readFile(this.indexPath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (parsed?.schemaVersion !== 1) {
                return { schemaVersion: 1, sessionToRepo: {}, turnToRepo: {} };
            }
            return parsed as IndexMap;
        } catch {
            return { schemaVersion: 1, sessionToRepo: {}, turnToRepo: {} };
        }
    }

    private async saveIndexJson(map: IndexMap): Promise<void> {
        await writeJsonAtomic(this.indexPath, map);
    }

    private async initBareRepo(repoId: string): Promise<GitRepoRef> {
        const gitDir = path.join(this.reposDir, `${repoId}.git`);
        await fs.promises.mkdir(gitDir, { recursive: true });
        await new Promise<void>((resolve, reject) => {
            cp.execFile('git', ['--git-dir', gitDir, 'init', '--bare'], (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        const repoRef: GitRepoRef = {
            repoId,
            gitDir,
            indexFile: path.join(gitDir, 'index'),
            workTree: this.workspaceRoot
        };
        await new Promise<void>((resolve) => {
            cp.execFile(
                'git',
                ['--git-dir', gitDir, 'config', 'core.autocrlf', 'false'],
                () => resolve()
            );
        });
        await new Promise<void>((resolve) => {
            cp.execFile(
                'git',
                ['--git-dir', gitDir, 'config', 'core.filemode', 'false'],
                () => resolve()
            );
        });
        await new Promise<void>((resolve) => {
            cp.execFile(
                'git',
                ['--git-dir', gitDir, 'config', 'advice.detachedHead', 'false'],
                () => resolve()
            );
        });
        await new Promise<void>((resolve) => {
            cp.execFile(
                'git',
                ['--git-dir', gitDir, 'config', 'gc.auto', '0'],
                () => resolve()
            );
        });
        return repoRef;
    }

    private async syncWorkspaceGitignoreToInternalRepo(gitDir: string): Promise<boolean> {
        const workspaceGitignorePath = path.join(this.workspaceRoot, '.gitignore');
        const excludePath = path.join(gitDir, 'info', 'exclude');
        let workspaceIgnore = '';
        let readsAccepted = true;
        try {
            if (fs.existsSync(workspaceGitignorePath)) {
                workspaceIgnore = await fs.promises.readFile(workspaceGitignorePath, 'utf-8');
            }
        } catch {
            workspaceIgnore = '';
            readsAccepted = false;
        }

        let existingExclude = '';
        try {
            if (fs.existsSync(excludePath)) {
                existingExclude = await fs.promises.readFile(excludePath, 'utf-8');
            }
        } catch {
            existingExclude = '';
            readsAccepted = false;
        }

        const blockRegex = new RegExp(
            `${GitRepoManager.WORKSPACE_IGNORE_BLOCK_START}[\\s\\S]*?${GitRepoManager.WORKSPACE_IGNORE_BLOCK_END}\\n?`,
            'g'
        );
        const cleaned = existingExclude.replace(blockRegex, '').trimEnd();
        const normalizedIgnore = workspaceIgnore.trim();
        const block = normalizedIgnore
            ? `${GitRepoManager.WORKSPACE_IGNORE_BLOCK_START}\n${normalizedIgnore}\n${GitRepoManager.WORKSPACE_IGNORE_BLOCK_END}`
            : '';
        const next = block
            ? `${cleaned ? `${cleaned}\n\n` : ''}${block}\n`
            : (cleaned ? `${cleaned}\n` : '');
        if (next === existingExclude) return readsAccepted;
        try {
            await fs.promises.mkdir(path.dirname(excludePath), { recursive: true });
            await fs.promises.writeFile(excludePath, next, 'utf-8');
            this.logger(`repo.ignore.sync | gitDir=${gitDir} copied=${normalizedIgnore ? 'true' : 'false'}`);
            return readsAccepted;
        } catch (error) {
            this.logger(`repo.ignore.sync.fail | gitDir=${gitDir} err=${String(error)}`);
            return false;
        }
    }

    private static async withIndexMutationLock<T>(
        indexPath: string,
        action: () => Promise<T>
    ): Promise<T> {
        const lockKey = path.normalize(path.resolve(indexPath)).toLowerCase();
        const previous = GitRepoManager.indexMutationTails.get(lockKey) ?? Promise.resolve();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = previous.catch(() => undefined).then(() => gate);
        GitRepoManager.indexMutationTails.set(lockKey, tail);
        await previous.catch(() => undefined);
        try {
            return await action();
        } finally {
            release();
            if (GitRepoManager.indexMutationTails.get(lockKey) === tail) {
                GitRepoManager.indexMutationTails.delete(lockKey);
            }
        }
    }

    private stableResolutionKey(sessionId?: string, turnKey?: string): string | undefined {
        if (sessionId) return `session:${sessionId}`;
        if (turnKey) return `turn:${turnKey}`;
        return undefined;
    }

    private async contentSignature(filePath: string): Promise<string> {
        try {
            const content = await fs.promises.readFile(filePath);
            return crypto.createHash('sha256').update(content).digest('hex');
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            return code === 'ENOENT' ? 'missing' : `unreadable:${code || 'unknown'}`;
        }
    }

    private async resolutionFingerprint(ref: GitRepoRef): Promise<string> {
        const parts = await Promise.all([
            this.contentSignature(this.indexPath),
            this.contentSignature(path.join(this.workspaceRoot, '.gitignore')),
            this.contentSignature(path.join(ref.gitDir, 'info', 'exclude')),
            this.contentSignature(path.join(ref.gitDir, 'config'))
        ]);
        let repoDirectory = 'missing';
        try {
            repoDirectory = (await fs.promises.stat(ref.gitDir)).isDirectory() ? 'directory' : 'not-directory';
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            repoDirectory = code === 'ENOENT' ? 'missing' : `unreadable:${code || 'unknown'}`;
        }
        return crypto.createHash('sha256').update([...parts, repoDirectory].join('|')).digest('hex');
    }

    private publishResolved(key: string, entry: ResolvedRepoCacheEntry): void {
        this.resolvedRepos.delete(key);
        this.resolvedRepos.set(key, entry);
        while (this.resolvedRepos.size > GitRepoManager.MAX_RESOLVED_REPOS) {
            const oldest = this.resolvedRepos.keys().next().value as string | undefined;
            if (!oldest) break;
            this.resolvedRepos.delete(oldest);
        }
    }

    private async resolveUnderLock(
        stableKey: string | undefined,
        sessionId?: string,
        turnKey?: string
    ): Promise<GitRepoRef> {
        if (stableKey) {
            const cached = this.resolvedRepos.get(stableKey);
            if (cached) {
                const currentFingerprint = await this.resolutionFingerprint(cached.ref);
                if (currentFingerprint === cached.fingerprint) {
                    this.resolvedRepos.delete(stableKey);
                    this.resolvedRepos.set(stableKey, cached);
                    return cached.ref;
                }
                this.resolvedRepos.delete(stableKey);
                this.logger(`resolveRepo.cache.invalidate | key=${stableKey} repoId=${cached.ref.repoId}`);
            }
        }

        this.logger(`resolveRepo.cache.miss | key=${stableKey || 'none'} sessionId=${sessionId || 'null'} turnKey=${turnKey || 'null'}`);
        await fs.promises.mkdir(this.reposDir, { recursive: true });
        const index = await this.loadIndexJson();
        let repoId: string | undefined;
        if (sessionId && index.sessionToRepo[sessionId]) {
            repoId = index.sessionToRepo[sessionId];
        } else if (turnKey && index.turnToRepo[turnKey]) {
            repoId = index.turnToRepo[turnKey];
        }
        if (!repoId) {
            repoId = `repo_${crypto.randomUUID()}`;
            if (turnKey) {
                index.turnToRepo[turnKey] = repoId;
            }
            await this.saveIndexJson(index);
        }
        if (sessionId && index.sessionToRepo[sessionId] !== repoId) {
            index.sessionToRepo[sessionId] = repoId;
            await this.saveIndexJson(index);
        }
        const gitDir = path.join(this.reposDir, `${repoId}.git`);
        let repoRef: GitRepoRef;
        if (!fs.existsSync(gitDir)) {
            repoRef = await this.initBareRepo(repoId);
        } else {
            repoRef = {
                repoId,
                gitDir,
                indexFile: path.join(gitDir, 'index'),
                workTree: this.workspaceRoot
            };
        }
        const ignoreSyncAccepted = await this.syncWorkspaceGitignoreToInternalRepo(gitDir);
        if (stableKey && ignoreSyncAccepted) {
            const fingerprint = await this.resolutionFingerprint(repoRef);
            this.publishResolved(stableKey, { ref: repoRef, fingerprint });
        }
        this.logger(`resolveRepo.cache.resolved | key=${stableKey || 'none'} sessionId=${sessionId || 'null'} turnKey=${turnKey || 'null'} repoId=${repoId} cached=${stableKey && ignoreSyncAccepted ? 'true' : 'false'}`);
        return repoRef;
    }

    public async resolveRepo(sessionId?: string, turnKey?: string): Promise<GitRepoRef> {
        const stableKey = this.stableResolutionKey(sessionId, turnKey);
        if (!stableKey) {
            return GitRepoManager.withIndexMutationLock(
                this.indexPath,
                () => this.resolveUnderLock(undefined, sessionId, turnKey)
            );
        }

        const existing = this.inFlightResolutions.get(stableKey);
        if (existing) {
            if (!existing.coalescedLogged) {
                existing.coalescedLogged = true;
                this.logger(`resolveRepo.cache.coalesced | key=${stableKey} sessionId=${sessionId || 'null'} turnKey=${turnKey || 'null'}`);
            }
            return existing.promise;
        }

        const promise = GitRepoManager.withIndexMutationLock(
            this.indexPath,
            () => this.resolveUnderLock(stableKey, sessionId, turnKey)
        );
        const inFlight: InFlightResolution = { promise, coalescedLogged: false };
        this.inFlightResolutions.set(stableKey, inFlight);
        try {
            return await promise;
        } finally {
            if (this.inFlightResolutions.get(stableKey) === inFlight) {
                this.inFlightResolutions.delete(stableKey);
            }
        }
    }
}
