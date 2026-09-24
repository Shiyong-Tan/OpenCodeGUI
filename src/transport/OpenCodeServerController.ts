import type { ServerConnection, ServerLock } from './OpenCodeHttpClient';
import { OpenCodeServiceRecordStore, type OwnedServiceRecord } from './OpenCodeServiceRecordStore';
import { ServiceOperationError } from './WindowsServiceJob';
import type { OpenCodeServerLockStore } from './OpenCodeServerLockStore';
import type { OpenCodeServerProcess, ServerSpawnSpec } from './OpenCodeServerProcess';

export type ServerHealth = 'ok' | 'unauthorized' | 'timeout' | 'connrefused' | 'unreachable';

export class OpenCodeServerController {
    private baseUrl?: string;
    private operationTail: Promise<unknown> = Promise.resolve();
    private explicitOperation?: { action: string; workspace: string; result: Promise<string> };
    private connectionGeneration = 0;
    private operationDeadline = Infinity;
    private queuedOperations = 0;
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
        /** Optional metadata preparation for an actual owned launch, never service reuse. */
        prepareSupervisorLaunch?(lock: Readonly<ServerLock>, serviceId?: string): Promise<string | undefined>;
        ownedRecords?: OpenCodeServiceRecordStore;
        activity?(connection: ServerConnection): Promise<'idle' | 'active'>;
        connectionChanged?(): void;
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
        this.connectionGeneration++;
        this.options.process.detach();
        this.clearState();
        this.options.stopEventStream();
    }

    public async ensure(workspaceRoot: string): Promise<void> {
        if (this.baseUrl) {
            await this.waitUntilReady();
            return;
        }
        if (!this.startPromise) this.startPromise = this.options.ownedRecords
            ? this.exclusive(workspaceRoot, () => this.ensureForWorkspace(workspaceRoot))
            : this.ensureForWorkspace(workspaceRoot);
        try {
            await this.startPromise;
        } finally {
            this.startPromise = undefined;
        }
    }

    public async waitUntilReady(): Promise<void> {
        if (this.readyPromise) await this.readyPromise;
    }

    private exclusive<T>(workspace: string, work: () => Promise<T>): Promise<T> {
        const records = this.options.ownedRecords;
        if (!records) return Promise.reject(new ServiceOperationError('service_control_unavailable'));
        if (this.queuedOperations >= 8) return Promise.reject(new ServiceOperationError('operation_busy'));
        this.queuedOperations++;
        const queuedAt = Date.now();
        const operation = this.operationTail.catch(() => undefined).then(async () => {
            if (Date.now() - queuedAt > 30000) throw new ServiceOperationError('operation_queue_timeout');
            const release = await this.options.process.acquireOperation(await records.workspaceKey(workspace));
            this.operationDeadline = Date.now() + 40000;
            try { return await work(); } finally { this.operationDeadline = -Infinity; await release(); }
        });
        this.operationTail = operation;
        void operation.finally(() => { this.queuedOperations--; }).catch(() => undefined);
        return this.bounded(operation, 45000, 'operation_timeout');
    }

    private async bounded<T>(work: Promise<T>, milliseconds: number, reason: string): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { return await Promise.race([work, new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new ServiceOperationError(reason)), milliseconds);
        })]); } finally { if (timer) clearTimeout(timer); }
    }

    private checkOperation(): void {
        if (this.options.ownedRecords && Date.now() >= this.operationDeadline) throw new ServiceOperationError('operation_timeout');
    }

    private connection(lock: ServerLock): ServerConnection {
        return { host: '127.0.0.1', port: lock.port, baseUrl: 'http://127.0.0.1:' + lock.port,
            authHeader: this.options.locks.buildAuthHeader(lock.password), lock };
    }

    private async observation(record: OwnedServiceRecord) {
        if (!record.process) throw new ServiceOperationError('prior_start_unknown');
        return this.options.process.inspectOwned(record.process, false, record.port);
    }

    public operate(workspace: string, action: 'start' | 'stop' | 'restart',
        confirmActive: (action: 'stop' | 'restart') => Promise<boolean>): Promise<string> {
        if (this.explicitOperation?.workspace === workspace && this.explicitOperation.action === action) return this.explicitOperation.result;
        const records = this.options.ownedRecords;
        if (!records) return Promise.reject(new ServiceOperationError('service_control_unavailable'));
        // Capture the target generation before waiting for another window/operation.
        const expected = records.current(workspace);
        void expected.catch(() => undefined);
        const result = this.exclusive(workspace, async () => {
            const prior = await expected;
            const current = await records.current(workspace);
            if (prior?.serviceId !== current?.serviceId) throw new ServiceOperationError('operation_superseded');
            const { lock } = await this.options.locks.readOrCreate(workspace);
            const connection = this.connection(lock);
            const health = await this.checkHealth(workspace, lock.port, lock.password, 1000);
            if (!current) {
                if (action !== 'start' || health === 'ok' || health === 'unauthorized') throw new ServiceOperationError('external_service_not_owned');
                this.clearState(); await this.startWithLock(lock); return 'started';
            }
            if (!records.matches(current, connection)) throw new ServiceOperationError('ownership_connection_mismatch');
            const observed = await this.observation(current);
            if (observed.state === 'stopped' && (health === 'ok' || health === 'unauthorized')) throw new ServiceOperationError('external_service_not_owned');
            if (observed.state !== 'stopped' && observed.listenerOwned !== true) throw new ServiceOperationError('listener_ownership_unknown');
            if (action === 'start' && observed.state === 'running') {
                if (health !== 'ok') throw new ServiceOperationError('owned_service_unhealthy');
                this.setConnection(lock); return 'already_running';
            }
            if (action !== 'start' && observed.state !== 'stopped') {
                if (health !== 'ok' || !this.options.activity) throw new ServiceOperationError('activity_unknown');
                let approved = false;
                for (let check = 0; check < 2; check++) {
                    if (await this.options.activity(connection) === 'active' && !approved) {
                        let timer: ReturnType<typeof setTimeout> | undefined;
                        try { approved = await Promise.race([confirmActive(action), new Promise<boolean>(resolve => {
                            timer = setTimeout(() => resolve(false), 15000);
                        })]); } finally { if (timer) clearTimeout(timer); }
                        if (!approved) throw new ServiceOperationError('active_operation_not_confirmed');
                    }
                }
                const stillCurrent = await records.current(workspace);
                if (stillCurrent?.serviceId !== current.serviceId) throw new ServiceOperationError('operation_superseded');
                this.connectionGeneration++; this.options.connectionChanged?.(); this.options.stopEventStream();
                this.checkOperation();
                const stopped = await this.options.process.inspectOwned(current.process!, true, current.port);
                if (stopped.state !== 'stopped') throw new ServiceOperationError('stop_result_unknown');
            } else if (observed.state !== 'stopped') throw new ServiceOperationError('prior_execution_not_stopped');
            await records.markStopped(workspace, current.serviceId);
            this.options.process.detach(); this.clearState(); this.options.stopEventStream(); this.options.connectionChanged?.();
            if (action === 'stop') return 'stopped';
            await this.startWithLock(lock); return action === 'restart' ? 'restarted' : 'started';
        });
        this.explicitOperation = { action, workspace, result };
        void result.finally(() => { if (this.explicitOperation?.result === result) this.explicitOperation = undefined; }).catch(() => undefined);
        return result;
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
        if (this.options.ownedRecords) return this.exclusive(lock.workspaceRoot, () => this.migratePortWithinOperation(lock, reason));
        return this.migratePortWithinOperation(lock, reason);
    }

    private async migratePortWithinOperation(lock: ServerLock, reason: '401' | 'EADDRINUSE'): Promise<void> {
        const previous = await this.options.ownedRecords?.current(lock.workspaceRoot);
        if (previous && (await this.observation(previous)).state !== 'stopped') throw new ServiceOperationError('prior_execution_not_stopped');
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
        if (this.options.ownedRecords) throw new ServiceOperationError('explicit_verified_operation_required');
        await this.options.process.shutdown();
        this.clearState();
        this.options.stopEventStream();
    }

    private async ensureForWorkspace(workspaceRoot: string): Promise<void> {
        if (this.baseUrl) return;
        const { lock, mtimeMs } = await this.options.locks.readOrCreate(workspaceRoot);
        const owned = await this.options.ownedRecords?.current(workspaceRoot);
        if (owned?.intentionallyStopped && this.options.ownedRecords?.matches(owned, this.connection(lock))) {
            throw new ServiceOperationError('service_explicitly_stopped');
        }
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
            await this.migratePortWithinOperation(lock, '401');
            return;
        }
        await this.startWithLock(lock);
    }

    private async startWithLock(lock: ServerLock): Promise<void> {
        this.checkOperation();
        const generation = this.connectionGeneration;
        const records = this.options.ownedRecords;
        let owned: OwnedServiceRecord | undefined;
        const spawnSpec = await this.bounded(this.options.buildServeSpawn(['serve', '--port', String(lock.port), '--hostname', '127.0.0.1']), 3000, 'command_resolution_timeout');
        this.checkOperation();
        if (records) {
            const previous = await records.current(lock.workspaceRoot);
            if (previous && (await this.observation(previous)).state !== 'stopped') throw new ServiceOperationError('prior_execution_not_stopped');
            owned = await records.begin(lock, previous?.serviceId ?? null);
        }

        let supervisorBinding: string | undefined;
        if (this.options.prepareSupervisorLaunch) {
            try {
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    supervisorBinding = await Promise.race([
                        owned ? this.options.prepareSupervisorLaunch({ ...lock }, owned.serviceId) : this.options.prepareSupervisorLaunch({ ...lock }),
                        new Promise<never>((_resolve, reject) => {
                            timer = setTimeout(() => reject(new Error('Supervisor metadata deadline')), 2000);
                        }),
                    ]);
                } finally { if (timer) clearTimeout(timer); }
            } catch {
                // Metadata failure must not expose secrets or disable ordinary chat.
                this.options.log('EXT: supervisor.launch-binding-unavailable');
            }
        }
        const prepared = supervisorBinding === undefined ? spawnSpec : { ...spawnSpec, supervisorBinding };
        if (generation !== this.connectionGeneration) throw new ServiceOperationError('operation_superseded');
        this.checkOperation();
        const pid = owned && records
            ? await this.options.process.startOwned(prepared, lock.workspaceRoot, lock.password, owned.serviceId,
                identity => records.register(lock.workspaceRoot, identity))
            : this.options.process.start(prepared, lock.workspaceRoot, lock.password);
        this.initReadyPromise();
        this.setConnection(lock);
        this.options.log(`EXT: server.start | port=${lock.port} | pid=${pid || 'null'}`);
        try {
            await this.waitForHealthy(lock);
            if (owned && records) {
                const registered = await records.current(lock.workspaceRoot);
                if (registered?.serviceId !== owned.serviceId || (await this.observation(registered)).listenerOwned !== true) {
                    throw new ServiceOperationError('listener_ownership_unknown');
                }
            }
            if (generation !== this.connectionGeneration) throw new ServiceOperationError('operation_superseded');
            this.markReady();
        } catch (error) {
            if ((error as Error & { code?: string })?.code === 'UNAUTHORIZED') {
                await this.migratePortWithinOperation(lock, '401');
                return;
            }
            const health = await this.checkHealth(lock.workspaceRoot, lock.port, lock.password, 1000);
            if (health === 'unauthorized') {
                await this.migratePortWithinOperation(lock, '401');
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
        for (let attempt = 0; attempt < (this.options.ownedRecords ? 16 : 10); attempt += 1) {
            const result = await this.checkHealth(lock.workspaceRoot, lock.port, lock.password, this.options.ownedRecords ? 500 : 2000);
            if (result === 'ok') return;
            if (result === 'unauthorized') {
                const error = new Error('OpenCode server unauthorized.') as Error & { code?: string };
                error.code = 'UNAUTHORIZED';
                throw error;
            }
            const delay = this.options.ownedRecords ? 200 : Math.min(300 * (2 ** attempt), 3000);
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
        void this.readyPromise.catch(() => undefined);
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
