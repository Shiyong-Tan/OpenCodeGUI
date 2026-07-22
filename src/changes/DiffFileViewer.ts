import * as fs from 'fs';
import * as path from 'path';
import type { GitRepoRef } from '../undo/types';
import { runGit as defaultRunGit } from '../undo/GitRunner';

type GitResult = Awaited<ReturnType<typeof defaultRunGit>>;
type GitRunner = (repo: GitRepoRef, args: string[]) => Promise<GitResult>;

export class DiffFileViewer {
    private readonly runGit: GitRunner;
    private readonly readFile: (filePath: string) => Promise<string>;

    constructor(private readonly options: {
        resolveRepo(sessionId: string): Promise<GitRepoRef | null>;
        getHead(repo: GitRepoRef): Promise<string | null>;
        getParent(repo: GitRepoRef, commit: string): Promise<string | null>;
        getWorkspaceRoot(): string;
        updateDiff(relativePath: string, beforeText: string, afterText: string, diffText?: string): Promise<void>;
        runGit?: GitRunner;
        readFile?: (filePath: string) => Promise<string>;
    }) {
        this.runGit = options.runGit || defaultRunGit;
        this.readFile = options.readFile || ((filePath) => fs.promises.readFile(filePath, 'utf-8'));
    }

    private async getFileTextAtCommit(repo: GitRepoRef, commit: string, relativePath: string): Promise<string | null> {
        const normalized = relativePath.replace(/\\/g, '/');
        const exists = await this.runGit(repo, ['cat-file', '-e', `${commit}:${normalized}`]);
        if (exists.code !== 0) return null;
        const result = await this.runGit(repo, ['show', `${commit}:${normalized}`]);
        if (result.code !== 0) return null;
        return result.stdout ?? '';
    }

    private async getWorkingTreeDiff(repo: GitRepoRef, baseCommit: string, relativePath: string): Promise<string> {
        const normalized = relativePath.replace(/\\/g, '/');
        const result = await this.runGit(repo, ['diff', baseCommit, '--', normalized]);
        return result.code === 0 ? result.stdout ?? '' : '';
    }

    private async getCommitDiff(repo: GitRepoRef, baseCommit: string, headCommit: string, relativePath: string): Promise<string> {
        const normalized = relativePath.replace(/\\/g, '/');
        const result = await this.runGit(repo, ['diff', baseCommit, headCommit, '--', normalized]);
        return result.code === 0 ? result.stdout ?? '' : '';
    }

    async open(options: {
        sessionId: string;
        filePath: string;
        commitHead?: string;
        commitBase?: string;
        noBaseline(): void;
    }): Promise<void> {
        if (!options.filePath || !options.sessionId) return;
        const repo = await this.options.resolveRepo(options.sessionId);
        if (!repo) return;
        const headCommit = options.commitHead || await this.options.getHead(repo);
        const baseCommit = options.commitBase || (headCommit ? await this.options.getParent(repo, headCommit) : null);
        if (!headCommit || !baseCommit) {
            options.noBaseline();
            return;
        }
        const workspaceRoot = this.options.getWorkspaceRoot();
        const absolutePath = path.isAbsolute(options.filePath)
            ? options.filePath
            : path.join(workspaceRoot, options.filePath);
        const relativePath = path.relative(workspaceRoot, absolutePath).replace(/\\/g, '/');
        const beforeText = (await this.getFileTextAtCommit(repo, baseCommit, relativePath)) ?? '';
        let afterText = '';
        let diffText = '';
        if (options.commitHead) {
            afterText = (await this.getFileTextAtCommit(repo, headCommit, relativePath)) ?? '';
            diffText = await this.getCommitDiff(repo, baseCommit, headCommit, relativePath);
        } else {
            try {
                afterText = await this.readFile(absolutePath);
            } catch {
                afterText = '';
            }
            diffText = await this.getWorkingTreeDiff(repo, baseCommit, relativePath);
        }
        await this.options.updateDiff(relativePath, beforeText, afterText, diffText || undefined);
    }
}
