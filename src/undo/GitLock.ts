import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitRepoRef } from './types';

type Logger = (message: string) => void;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type LockHandle = {
    filePath: string;
    handle: fs.promises.FileHandle;
};

type LockOwner = {
    pid: number;
    hostname: string;
    acquiredAt: number;
    repoId?: string;
};

type AcquireOptions = {
    timeoutMs?: number;
    staleWithOwnerMs?: number;
    staleLegacyMs?: number;
    logger?: Logger;
    repoId?: string;
};

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_STALE_WITH_OWNER_MS = 5000;
const DEFAULT_STALE_LEGACY_MS = 30000;

const isProcessAlive = (pid: number): boolean => {
    if (!Number.isFinite(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: any) {
        if (error?.code === 'EPERM') {
            // Process exists but we are not allowed to signal it.
            return true;
        }
        return false;
    }
};

const readLockOwner = async (lockPath: string): Promise<Partial<LockOwner> | undefined> => {
    try {
        const raw = await fs.promises.readFile(lockPath, 'utf-8');
        if (!raw.trim()) return undefined;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return undefined;
        return parsed as Partial<LockOwner>;
    } catch {
        return undefined;
    }
};

const tryReapStaleLock = async (
    lockPath: string,
    logger: Logger,
    repoId: string,
    staleWithOwnerMs: number,
    staleLegacyMs: number
): Promise<boolean> => {
    let stat: fs.Stats;
    try {
        stat = await fs.promises.stat(lockPath);
    } catch (error: any) {
        if (error?.code === 'ENOENT') return false;
        return false;
    }

    const ageMs = Date.now() - stat.mtimeMs;
    const owner = await readLockOwner(lockPath);
    const ownerPid = Number(owner?.pid);
    const hasOwnerPid = Number.isFinite(ownerPid) && ownerPid > 0;

    let shouldReap = false;
    let reason = 'unknown';

    if (hasOwnerPid) {
        if (ageMs >= staleWithOwnerMs && !isProcessAlive(ownerPid)) {
            shouldReap = true;
            reason = 'owner-dead';
        }
    } else if (ageMs >= staleLegacyMs) {
        shouldReap = true;
        reason = 'legacy-stale';
    }

    if (!shouldReap) {
        return false;
    }

    try {
        await fs.promises.unlink(lockPath);
        logger(
            `repoLock.reap | repoId=${repoId} reason=${reason} ageMs=${Math.max(0, Math.floor(ageMs))} ` +
            `ownerPid=${hasOwnerPid ? ownerPid : 'null'}`
        );
        return true;
    } catch (error: any) {
        if (error?.code === 'ENOENT') {
            return true;
        }
        logger(
            `repoLock.reap.fail | repoId=${repoId} ageMs=${Math.max(0, Math.floor(ageMs))} ` +
            `ownerPid=${hasOwnerPid ? ownerPid : 'null'} err=${String(error)}`
        );
        return false;
    }
};

const acquireFileLock = async (lockPath: string, options: AcquireOptions = {}): Promise<LockHandle> => {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const staleWithOwnerMs = options.staleWithOwnerMs ?? DEFAULT_STALE_WITH_OWNER_MS;
    const staleLegacyMs = options.staleLegacyMs ?? DEFAULT_STALE_LEGACY_MS;
    const logger = options.logger ?? (() => undefined);
    const repoId = options.repoId || 'unknown';
    const start = Date.now();
    let attempts = 0;
    while (true) {
        attempts += 1;
        try {
            const handle = await fs.promises.open(lockPath, 'wx');
            try {
                const owner: LockOwner = {
                    pid: process.pid,
                    hostname: os.hostname(),
                    acquiredAt: Date.now(),
                    repoId
                };
                await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf-8');
            } catch {
                // Lock ownership metadata is best-effort only.
            }
            return { filePath: lockPath, handle };
        } catch (error: any) {
            if (error?.code !== 'EEXIST') {
                throw error;
            }
            await tryReapStaleLock(lockPath, logger, repoId, staleWithOwnerMs, staleLegacyMs);
            if (Date.now() - start > timeoutMs) {
                const owner = await readLockOwner(lockPath);
                const ageText = await fs.promises.stat(lockPath)
                    .then((stat) => String(Math.max(0, Math.floor(Date.now() - stat.mtimeMs))))
                    .catch(() => 'unknown');
                const ownerPid = Number(owner?.pid);
                const ownerPidText = Number.isFinite(ownerPid) && ownerPid > 0 ? String(ownerPid) : 'null';
                throw new Error(
                    `Timeout acquiring git lock at ${lockPath} ` +
                    `(repoId=${repoId} attempts=${attempts} ageMs=${ageText} ownerPid=${ownerPidText})`
                );
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
        const handle = await acquireFileLock(lockPath, { logger, repoId });
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
