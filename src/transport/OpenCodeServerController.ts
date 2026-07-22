import type { ServerConnection, ServerLock } from './OpenCodeHttpClient';
import type { OpenCodeServerLockStore } from './OpenCodeServerLockStore';
import type { OpenCodeServerProcess, ServerSpawnSpec } from './OpenCodeServerProcess';

export type ServerHealth = 'ok' | 'unauthorized' | 'timeout' | 'connrefused' | 'unreachable';

export class OpenCodeServerController {
    private baseUrl?: string;
    private port?: number;
    private password?: string;
    private startPromise?: Promise<void>;
    private readyPromise?: Promise<void>;
    private readyResolve?: () => void;
    private readyReject?: (error: Error) => void;

    constructor(private readonly options: {
        locks: OpenCodeServerLockStore;
        process: OpenCodeServerProcess;
        buildServeSpawn(args: string[]): Promise<ServerSpawnSpec>;
        fetchHealth(conn: ServerConnection, timeoutMs: number): Promise<Response>;
        stopEventStream(): void;
        log(message: string): void;
        showError(message: string): void;
        delay?(ms: number): Promise<void>;
    }) {}

    public getPid(): number | undefined {
        return this.options.process.getPid();
    }

    public getBaseUrl(): string {
        return this.baseUrl || '';
    }

    public resetForWorkspaceChange(): void {
        this.options.process.detach();
        this.clearState();
        this.options.stopEventStream();
    }

    public async ensure(workspaceRoot: string): Promise<void> {
        if (this.baseUrl) {
            await this.waitUntilReady();
            return;
        }
        if (!this.startPromise) this.startPromise = this.ensureForWorkspace(workspaceRoot);
        try {
            await this.startPromise;
        } finally {
            this.startPromise = undefined;
        }
    }

    public async waitUntilReady(): Promise<void> {
        if (this.readyPromise) await this.readyPromise;
    }

    public async checkHealth(workspaceRoot: string, port: number, password: string, timeoutMs = 1000): Promise<ServerHealth> {
        const conn: ServerConnection = {
            host: '127.0.0.1',
            port,
            baseUrl: `http://127.0.0.1:${port}`,
            authHeader: this.options.locks.buildAuthHeader(password),
            lock: { workspaceRoot, port, password, updatedAt: new Date().toISOString() },
        };
        try {
            const response = await this.options.fetchHealth(conn, timeoutMs);
            if (response.status === 200) return 'ok';
            if (response.status === 401) return 'unauthorized';
            return 'unreachable';
        } catch (error) {
            if ((error as Error)?.name === 'AbortError') return 'timeout';
            if ((error as NodeJS.ErrnoException)?.code === 'ECONNREFUSED') return 'connrefused';
            return 'unreachable';
        }
    }

    public async migratePort(lock: ServerLock, reason: '401' | 'EADDRINUSE'): Promise<void> {
        const startPort = lock.port;
        for (const candidate of this.options.locks.getMigrationPorts(lock.workspaceRoot)) {
            const result = await this.checkHealth(lock.workspaceRoot, candidate, lock.password, 1000);
            this.options.log(`EXT: server.health.try | port=${candidate} | result=${result}`);
            if (result === 'ok') {
                lock.port = candidate;
                const mtimeMs = await this.options.locks.write(lock, lock.workspaceRoot, candidate !== startPort);
                this.setConnection(lock);
                this.options.locks.updateCache(lock, mtimeMs);
                this.options.log(`EXT: server.reuse | port=${candidate}`);
                if (candidate !== startPort) this.options.log(`EXT: server.migrate | fromPort=${startPort} | toPort=${candidate} | reason=${reason}`);
                return;
            }
            if (result === 'unauthorized') continue;
            lock.port = candidate;
            const mtimeMs = await this.options.locks.write(lock, lock.workspaceRoot, candidate !== startPort);
            this.options.locks.updateCache(lock, mtimeMs);
            if (candidate !== startPort) this.options.log(`EXT: server.migrate | fromPort=${startPort} | toPort=${candidate} | reason=${reason}`);
            await this.startWithLock(lock);
            return;
        }
        const message = `OpenCode server failed to find available port in range ${this.options.locks.portBase}-${this.options.locks.portBase + this.options.locks.portRange - 1}.`;
        this.options.showError(message);
        throw new Error(message);
    }

    public async shutdown(): Promise<void> {
        await this.options.process.shutdown();
        this.clearState();
        this.options.stopEventStream();
    }

    private async ensureForWorkspace(workspaceRoot: string): Promise<void> {
        if (this.baseUrl) return;
        const { lock, mtimeMs } = await this.options.locks.readOrCreate(workspaceRoot);
        this.options.locks.updateCache(lock, mtimeMs);
        const initialHealth = await this.checkHealth(workspaceRoot, lock.port, lock.password, 1000);
        this.options.log(`EXT: server.health.try | port=${lock.port} | result=${initialHealth}`);
        if (initialHealth === 'ok') {
            this.setConnection(lock);
            this.options.locks.updateCache(lock, mtimeMs);
            this.initReadyPromise();
            this.markReady();
            this.options.log(`EXT: server.reuse | port=${lock.port}`);
            return;
        }
        if (initialHealth === 'unauthorized') {
            await this.migratePort(lock, '401');
            return;
        }
        await this.startWithLock(lock);
    }

    private async startWithLock(lock: ServerLock): Promise<void> {
        this.initReadyPromise();
        const spawnSpec = await this.options.buildServeSpawn(['serve', '--port', String(lock.port), '--hostname', '127.0.0.1']);
        const pid = this.options.process.start(spawnSpec, lock.workspaceRoot, lock.password);
        this.setConnection(lock);
        this.options.log(`EXT: server.start | port=${lock.port} | pid=${pid || 'null'}`);
        try {
            await this.waitForHealthy(lock);
            this.markReady();
        } catch (error) {
            if ((error as Error & { code?: string })?.code === 'UNAUTHORIZED') {
                await this.migratePort(lock, '401');
                return;
            }
            const health = await this.checkHealth(lock.workspaceRoot, lock.port, lock.password, 1000);
            if (health === 'unauthorized') {
                await this.migratePort(lock, '401');
                return;
            }
            this.baseUrl = undefined;
            this.port = undefined;
            this.password = undefined;
            this.options.process.clearRememberedPid();
            this.failReady(error as Error);
            throw error;
        }
    }

    private async waitForHealthy(lock: ServerLock): Promise<void> {
        for (let attempt = 0; attempt < 10; attempt += 1) {
            const result = await this.checkHealth(lock.workspaceRoot, lock.port, lock.password, 2000);
            if (result === 'ok') return;
            if (result === 'unauthorized') {
                const error = new Error('OpenCode server unauthorized.') as Error & { code?: string };
                error.code = 'UNAUTHORIZED';
                throw error;
            }
            const delay = Math.min(300 * (2 ** attempt), 3000);
            await (this.options.delay ? this.options.delay(delay) : new Promise((resolve) => setTimeout(resolve, delay)));
        }
        throw new Error('OpenCode server failed to start.');
    }

    private setConnection(lock: ServerLock): void {
        this.baseUrl = `http://127.0.0.1:${lock.port}`;
        this.port = lock.port;
        this.password = lock.password;
    }

    private initReadyPromise(): void {
        if (this.readyPromise) return;
        this.readyPromise = new Promise((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
        });
    }

    private markReady(): void {
        this.readyResolve?.();
        this.readyResolve = undefined;
        this.readyReject = undefined;
    }

    private failReady(error: Error): void {
        this.readyReject?.(error);
        this.readyResolve = undefined;
        this.readyReject = undefined;
        this.readyPromise = undefined;
    }

    private clearState(): void {
        this.baseUrl = undefined;
        this.port = undefined;
        this.password = undefined;
        this.startPromise = undefined;
        this.readyPromise = undefined;
        this.readyResolve = undefined;
        this.readyReject = undefined;
    }
}
