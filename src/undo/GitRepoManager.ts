import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import { GitCapabilities, GitRepoRef, IndexMap, MIN_GIT_VERSION } from './types';

type Logger = (message: string) => void;

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

    public async resolveRepo(sessionId?: string, turnKey?: string): Promise<GitRepoRef> {
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
        this.logger(`resolveRepo | sessionId=${sessionId || 'null'} turnKey=${turnKey || 'null'} repoId=${repoId}`);
        return repoRef;
    }
}
