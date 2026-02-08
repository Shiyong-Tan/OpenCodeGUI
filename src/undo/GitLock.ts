import * as fs from 'fs';
import * as path from 'path';
import { GitRepoRef } from './types';

type Logger = (message: string) => void;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type LockHandle = {
    filePath: string;
    handle: fs.promises.FileHandle;
};

const acquireFileLock = async (lockPath: string, timeoutMs = 10000): Promise<LockHandle> => {
    const start = Date.now();
    while (true) {
        try {
            const handle = await fs.promises.open(lockPath, 'wx');
            return { filePath: lockPath, handle };
        } catch (error: any) {
            if (error?.code !== 'EEXIST') {
                throw error;
            }
            if (Date.now() - start > timeoutMs) {
                throw new Error(`Timeout acquiring git lock at ${lockPath}`);
            }
            await wait(50);
        }
    }
};

const releaseFileLock = async (handle: LockHandle): Promise<void> => {
    try {
        await handle.handle.close();
    } catch {
        // ignore
    }
    try {
        await fs.promises.unlink(handle.filePath);
    } catch {
        // ignore
    }
};

export class RepoLockManager {
    private queues = new Map<string, Promise<void>>();
    private queueSizes = new Map<string, number>();

    public async withRepoLock<T>(repo: GitRepoRef, logger: Logger, fn: () => Promise<T>): Promise<T> {
        const repoId = repo.repoId;
        const prev = this.queues.get(repoId) || Promise.resolve();
        const currentSize = (this.queueSizes.get(repoId) || 0) + 1;
        this.queueSizes.set(repoId, currentSize);
        let releaseQueue: () => void = () => undefined;
        const next = new Promise<void>((resolve) => {
            releaseQueue = resolve;
        });
        this.queues.set(repoId, prev.then(() => next));
        await prev;

        const lockPath = path.join(repo.gitDir, '.lock');
        logger(`repoLock.acquire | repoId=${repoId} queueLen=${currentSize}`);
        const handle = await acquireFileLock(lockPath);
        try {
            return await fn();
        } finally {
            await releaseFileLock(handle);
            releaseQueue();
            const updatedSize = (this.queueSizes.get(repoId) || 1) - 1;
            if (updatedSize <= 0) {
                this.queueSizes.delete(repoId);
            } else {
                this.queueSizes.set(repoId, updatedSize);
            }
            if (this.queues.get(repoId) === next) {
                this.queues.delete(repoId);
            }
            logger(`repoLock.release | repoId=${repoId} queueLen=${Math.max(updatedSize, 0)}`);
        }
    }
}
