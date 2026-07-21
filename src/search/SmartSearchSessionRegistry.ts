import * as fs from 'fs';
import * as path from 'path';

const STORAGE_KEY = 'opencode.smartSearchTempSessionIds.v1';

type RegistryStorage = {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void> | Promise<void>;
};

type RegistryClient = {
    abortSession(sessionId: string): Promise<unknown>;
    deleteSession(sessionId: string): Promise<unknown>;
};

export class SmartSearchSessionRegistry {
    private readonly sessionIds = new Set<string>();

    constructor(private readonly options: {
        storage: RegistryStorage;
        client: RegistryClient;
        getCorpusDir(): string;
        log(message: string): void;
    }) {}

    public owns(sessionId: string | undefined): boolean {
        return Boolean(sessionId && this.sessionIds.has(sessionId));
    }

    public async track(sessionId: string): Promise<void> {
        if (!sessionId) return;
        this.sessionIds.add(sessionId);
        await this.persist();
    }

    public async release(sessionId: string): Promise<void> {
        if (!sessionId) return;
        this.sessionIds.delete(sessionId);
        await this.persist();
    }

    public async persist(): Promise<void> {
        try {
            await this.options.storage.update(STORAGE_KEY, [...this.sessionIds]);
        } catch (error) {
            this.options.log(`EXT: smartSearch.registry.persist.fail | err=${String(error)}`);
        }
    }

    public async cleanupOrphans(): Promise<void> {
        const stored = this.options.storage.get<unknown>(STORAGE_KEY);
        const recorded = Array.isArray(stored)
            ? stored.filter((item): item is string => typeof item === 'string' && Boolean(item))
            : [];
        if (recorded.length === 0) return;
        for (const sessionId of recorded) {
            if (!sessionId || this.sessionIds.has(sessionId)) continue;
            try {
                await this.options.client.abortSession(sessionId);
            } catch {
                // The orphan may no longer be running.
            }
            try {
                await this.options.client.deleteSession(sessionId);
            } catch (error) {
                this.sessionIds.add(sessionId);
                this.options.log(`EXT: smartSearch.orphan.cleanup.fail | sessionId=${sessionId} | err=${String(error)}`);
            }
        }
        await this.persist();
    }

    public async cleanupStaleCorpora(): Promise<void> {
        const dir = this.options.getCorpusDir();
        const createdBefore = Date.now();
        try {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            await Promise.all(entries
                .filter((entry) => {
                    if (!entry.isFile()) return false;
                    const match = /^search-(\d+)-[A-Za-z0-9-]+\.jsonl$/.exec(entry.name);
                    return Boolean(match && Number(match[1]) < createdBefore);
                })
                .map((entry) => fs.promises.rm(path.join(dir, entry.name), { force: true })));
            const remaining = await fs.promises.readdir(dir);
            if (remaining.length === 0) await fs.promises.rmdir(dir);
        } catch {
            // No stale search corpus exists.
        }
    }

    public async dispose(): Promise<void> {
        const sessionIds = [...this.sessionIds];
        await Promise.all(sessionIds.map(async (sessionId) => {
            try {
                await this.options.client.abortSession(sessionId);
            } catch {
                // The search may already have completed.
            }
            try {
                await this.options.client.deleteSession(sessionId);
                this.sessionIds.delete(sessionId);
            } catch (error) {
                this.options.log(`EXT: smartSearch.dispose.cleanup.fail | sessionId=${sessionId} | err=${String(error)}`);
            }
        }));
        await this.persist();
    }
}
