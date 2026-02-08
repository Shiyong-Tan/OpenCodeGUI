import * as cp from 'child_process';
import { GitRepoRef, WIN_PATHSPEC_CHUNK } from './types';

type RunGitOptions = {
    paths?: string[];
    commitIdentity?: boolean;
    env?: Record<string, string>;
    timeoutMs?: number;
    cwd?: string;
};

const buildChunks = (paths: string[]): string[][] => {
    const chunks: string[][] = [];
    let current: string[] = [];
    for (const p of paths) {
        current.push(p);
        if (current.length >= WIN_PATHSPEC_CHUNK) {
            chunks.push(current);
            current = [];
        }
    }
    if (current.length) chunks.push(current);
    return chunks;
};

const runOnce = (repo: GitRepoRef, args: string[], opts?: RunGitOptions): Promise<{ stdout: string; stderr: string; code: number }> => {
    return new Promise((resolve) => {
        const commitIdentity = Boolean(opts?.commitIdentity);
        const finalArgs = commitIdentity
            ? ['-c', 'user.name=OpenCode', '-c', 'user.email=opencode@local', ...args]
            : args;
        const env = {
            ...process.env,
            ...opts?.env,
            GIT_INDEX_FILE: repo.indexFile,
            GIT_WORK_TREE: repo.workTree,
            GIT_CONFIG_NOSYSTEM: '1'
        };
        const child = cp.spawn('git', ['--git-dir', repo.gitDir, '--work-tree', repo.workTree, ...finalArgs], {
            env,
            cwd: opts?.cwd || repo.workTree,
            shell: false
        });
        let stdout = '';
        let stderr = '';
        const timeout = typeof opts?.timeoutMs === 'number' ? opts.timeoutMs : 60000;
        const timer = setTimeout(() => {
            child.kill();
        }, timeout);
        child.stdout.on('data', (data) => {
            stdout += String(data);
        });
        child.stderr.on('data', (data) => {
            stderr += String(data);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, code: typeof code === 'number' ? code : 1 });
        });
    });
};

export const runGit = async (
    repo: GitRepoRef,
    args: string[],
    opts?: RunGitOptions
): Promise<{ stdout: string; stderr: string; code: number }> => {
    const paths = Array.isArray(opts?.paths) ? opts.paths : undefined;
    if (paths && paths.length === 0) {
        return { stdout: '', stderr: '', code: 0 };
    }
    if (!paths) {
        return runOnce(repo, args, opts);
    }
    const chunks = buildChunks(paths);
    let stdout = '';
    let stderr = '';
    let code = 0;
    for (const chunk of chunks) {
        const result = await runOnce(repo, [...args, '--', ...chunk], opts);
        stdout += result.stdout;
        stderr += result.stderr;
        if (result.code !== 0) {
            code = result.code;
        }
    }
    return { stdout, stderr, code };
};
