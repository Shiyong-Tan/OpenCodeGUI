import { SupervisorNotificationCatalog } from './SupervisorNotificationCatalog';
import type { ServerConnection } from '../transport/OpenCodeHttpClient';
import { loadIsolatedSupervisorConnection, type IsolatedSupervisorConnection } from './IsolatedSupervisorConnection';
import { SupervisorReader, type SupervisorReadResult } from './SupervisorReader';

/** Owns only the explicitly selected development connection; never launches a service. */
export class SupervisorExperiment {
    private connection?: IsolatedSupervisorConnection;
    private reader?: SupervisorReader;
    private catalog?: SupervisorNotificationCatalog;
    private connecting?: Promise<void>;
    private disposed = false;
    constructor(private readonly descriptorPath: string,
        private readonly load = loadIsolatedSupervisorConnection,
        private readonly fetcher: typeof fetch = fetch) {
        if (!descriptorPath) throw new Error('Set OPENCODE_GUI_SUPERVISOR_DESCRIPTOR for the isolated development instance');
    }

    async ensure(workspace: string): Promise<void> {
        if (this.disposed) throw new Error('Supervisor development connection disposed');
        if (this.connecting) return this.connecting;
        this.connecting = (async () => {
            const loaded = await this.load(this.descriptorPath, workspace);
            if (this.connection && (loaded.instanceId !== this.connection.instanceId || loaded.isolationId !== this.connection.isolationId ||
                loaded.serviceEndpoint !== this.connection.serviceEndpoint || loaded.bridgeEndpoint !== this.connection.bridgeEndpoint)) {
                this.reader?.dispose();
                throw new Error('Supervisor instance changed; reload the isolated development window');
            }
            const response = await this.fetcher(`${loaded.serviceEndpoint}/global/health`, {
                headers: { Authorization: loaded.serviceAuthorization }, signal: AbortSignal.timeout(2500), redirect: 'error',
            });
            if (!response.ok) throw new Error('Isolated OpenCode health check failed');
            const health = await response.json() as unknown;
            if (!health || typeof health !== 'object' || (health as Record<string, unknown>).version !== loaded.openCodeVersion) {
                throw new Error('Isolated OpenCode version mismatch');
            }
            if (this.disposed) throw new Error('Supervisor development connection disposed');
            this.catalog ??= new SupervisorNotificationCatalog(this.descriptorPath, loaded.isolationId);
            this.reader ??= new SupervisorReader(loaded, this.fetcher);
            this.connection = loaded;
        })();
        try { await this.connecting; } finally { this.connecting = undefined; }
    }

    serverConnection(): ServerConnection {
        const connection = this.connection;
        if (!connection || this.disposed) throw new Error('Isolated supervisor connection unavailable');
        const port = Number(new URL(connection.serviceEndpoint).port);
        return { host: '127.0.0.1', port, baseUrl: connection.serviceEndpoint, authHeader: connection.serviceAuthorization,
            isolatedSupervisor: true,
            // Compatibility transport metadata, never written to a workspace lock.
            lock: { workspaceRoot: connection.workspace, port, password: '', updatedAt: '' } };
    }

    async read(parentSessionId: string): Promise<SupervisorReadResult> {
        return this.reader?.read(parentSessionId) ?? { status: 'unavailable', reason: 'read_failed' };
    }

    knownNotification(sessionId: string, messageId: string) {
        return this.disposed ? undefined : this.catalog?.peek(sessionId, messageId);
    }

    async prepareHistory(sessionId: string, messages: unknown[]): Promise<void> {
        for (const message of messages) {
            if (!message || typeof message !== 'object') continue;
            const info = (message as Record<string, unknown>).info;
            if (!info || typeof info !== 'object') continue;
            const record = info as Record<string, unknown>;
            const id = record.role === 'user' ? record.id : record.parentID;
            if (typeof id === 'string') await this.lookupNotification(sessionId, id);
        }
    }

    async lookupNotification(sessionId: string, messageId: string) {
        if (!this.catalog || this.disposed) throw new Error('Trusted supervisor notification classification unavailable');
        return this.catalog.lookup(sessionId, messageId);
    }

    dispose(): void {
        this.disposed = true;
        this.reader?.dispose();
        this.connection = undefined;
        this.catalog = undefined;
    }
}
