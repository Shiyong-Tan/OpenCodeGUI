import { join } from 'path';
import type { ServerConnection } from '../transport/OpenCodeHttpClient';
import { NormalSupervisorLaunchStore } from './NormalSupervisorLaunchStore';
import { connectNormalSupervisor, NormalConnectionError } from './NormalSupervisorConnection';
import { SupervisorNotificationCatalog } from './SupervisorNotificationCatalog';
import { SupervisorReader, type SupervisorReadResult } from './SupervisorReader';
import { normalIdentityCodec } from './normal-identity-protocol';
import { parseNormalView } from './normal-view-protocol';
import type { NormalLaunch } from './normal-launch-protocol';
import type { NotificationIdentity } from './notification-identity-protocol';

export type NormalSupervisorStatus = 'disabled' | 'unavailable' | 'connecting' | 'connected' | 'incompatible' | 'disconnected';

/** Owns optional live reads. Durable classification is independent of enable state.
 * No process launch, kill, prompt, cancellation or redispatch capability exists here. */
export class NormalSupervisorIntegration {
    private enabled = false;
    private disposed = false;
    private generation = 0;
    private identityGeneration = 0;
    private state: NormalSupervisorStatus = 'disabled';
    private reader?: SupervisorReader;
    private connectionKey = '';
    private pending?: Promise<SupervisorReader | undefined>;
    private controller?: AbortController;
    private catalog?: SupervisorNotificationCatalog;
    private catalogScope = '';

    constructor(private readonly store: Pick<NormalSupervisorLaunchStore, 'forConnection'> & Partial<Pick<NormalSupervisorLaunchStore, 'forHistory'>>,
        private readonly getConnection: () => Promise<ServerConnection>,
        private readonly fetcher: typeof fetch = fetch,
        private readonly now: () => number = Date.now) {}

    private failureStage = 'not_started';
    diagnostic(): string { return this.failureStage; }
    status(): NormalSupervisorStatus { return this.state; }

    setEnabled(enabled: boolean): void {
        if (this.disposed || this.enabled === enabled) return;
        this.enabled = enabled;
        this.generation++;
        this.controller?.abort();
        this.reader?.dispose();
        this.reader = undefined;
        this.connectionKey = '';
        this.state = enabled ? 'connecting' : 'disabled';
        // Catalog retains immutable, authenticated history while live reads stop.
    }

    private async load(service: ServerConnection): Promise<NormalLaunch | undefined> {
        const generation = this.identityGeneration;
        const launch = await this.store.forConnection(service);
        if (this.disposed || generation !== this.identityGeneration || !launch) return undefined;
        if (this.catalogScope && this.catalogScope !== launch.binding.integrationId) {
            throw new NormalConnectionError('unavailable');
        }
        if (!this.catalog) {
            this.catalog = new SupervisorNotificationCatalog(join(launch.privateDirectory, `${launch.binding.serviceId}.json`),
                launch.binding.integrationId, normalIdentityCodec(launch.binding.integrationId, launch.identityKey).decode);
            this.catalogScope = launch.binding.integrationId;
        }
        return launch;
    }

    private async connect(): Promise<SupervisorReader | undefined> {
        if (!this.enabled || this.disposed) return undefined;
        if (this.pending) {
            if (this.controller?.signal.aborted) this.state = 'disconnected';
            return this.pending;
        }
        const generation = this.generation;
        const controller = new AbortController();
        this.controller = controller;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const work = (async () => {
            this.failureStage = 'service_connection';
            const service = await this.getConnection();
            this.failureStage = 'launch_binding';
            const launch = await this.load(service);
            if (!launch) { this.failureStage = 'launch_binding_missing'; throw new NormalConnectionError('unavailable'); }
            const connection = await connectNormalSupervisor(launch, service, controller.signal, this.fetcher, this.now, stage => {
                if (generation === this.generation && !this.disposed) this.failureStage = stage;
            });
            if (controller.signal.aborted || this.disposed || generation !== this.generation || !this.enabled) return undefined;
            const key = `${launch.binding.serviceId}:${connection.instanceId}`;
            if (this.connectionKey !== key) {
                this.reader?.dispose();
                this.reader = new SupervisorReader(connection, this.fetcher, this.now,
                    value => parseNormalView(value, launch.binding.integrationId, launch.binding.serviceId));
                this.connectionKey = key;
            }
            this.state = 'connected'; this.failureStage = 'connected';
            return this.reader;
        })();
        const pending = Promise.race([work, new Promise<undefined>(resolve => {
            timer = setTimeout(() => { controller.abort(); resolve(undefined); }, 2500);
        })]).catch(error => {
            if (generation === this.generation && !this.disposed && this.enabled) {
                this.state = error instanceof NormalConnectionError ? error.reason : 'unavailable';
            }
            return undefined;
        }).then(reader => {
            if (!reader && generation === this.generation && this.enabled && !this.disposed) {
                if (controller.signal.aborted) this.state = 'disconnected';
                this.reader?.dispose(); this.reader = undefined; this.connectionKey = '';
            }
            return reader;
        });
        this.pending = pending;
        // Keep the slot until actual work settles, even if a fetch ignores abort.
        void work.finally(() => {
            if (timer) clearTimeout(timer);
            if (this.pending === pending) this.pending = undefined;
            if (this.controller === controller) this.controller = undefined;
        }).catch(() => undefined);
        return pending;
    }

    async read(sessionId: string): Promise<SupervisorReadResult> {
        if (!this.enabled || this.disposed) return { status: 'unavailable', reason: 'disposed' };
        const generation = this.generation;
        const reader = await this.connect();
        if (!reader || generation !== this.generation || !this.enabled || this.disposed) return { status: 'unavailable', reason: 'read_failed' };
        const key = this.connectionKey;
        const result = await reader.read(sessionId);
        if (generation !== this.generation || !this.enabled || this.disposed) return { status: 'unavailable', reason: 'disposed' };
        // Another window may have restarted the service during this request.
        // Re-check the persisted launch generation before publishing its projection.
        let timer: ReturnType<typeof setTimeout> | undefined;
        let current: NormalLaunch | undefined;
        try {
            current = await Promise.race([
                this.getConnection().then(service => this.store.forConnection(service)),
                new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 1000); }),
            ]);
        } catch { /* Missing identity makes this observation unknown. */ }
        finally { if (timer) clearTimeout(timer); }
        if (!current || !key.startsWith(current.binding.serviceId + ':')) {
            if (generation === this.generation && this.enabled && !this.disposed) {
                this.reader?.dispose(); this.reader = undefined; this.connectionKey = ''; this.state = 'disconnected';
            }
            return { status: 'unavailable', reason: 'read_failed' };
        }
        if (generation !== this.generation || !this.enabled || this.disposed) return { status: 'unavailable', reason: 'disposed' };
        if (result.status !== 'observed') this.state = 'disconnected';
        return result;
    }

    knownNotification(sessionId: string, messageId: string): Readonly<NotificationIdentity> | undefined {
        return this.disposed ? undefined : this.catalog?.peek(sessionId, messageId);
    }

    async lookupNotification(sessionId: string, messageId: string) {
        if (this.disposed) throw new Error('Supervisor classification disposed');
        const known = this.knownNotification(sessionId, messageId);
        if (known) return known;
        const generation = this.identityGeneration;
        if (!this.catalog) {
            const connection = await this.getConnection();
            if (this.store.forHistory) {
                const history = await this.store.forHistory(connection.lock.workspaceRoot);
                if (this.disposed || generation !== this.identityGeneration) throw new Error('Supervisor classification changed');
                if (history) {
                    this.catalog = new SupervisorNotificationCatalog(join(history.privateDirectory, 'history.json'), history.integrationId,
                        normalIdentityCodec(history.integrationId, history.identityKey).decode);
                    this.catalogScope = history.integrationId;
                }
            } else await this.load(connection);
        }
        if (this.disposed || generation !== this.identityGeneration) throw new Error('Supervisor classification changed');
        if (!this.catalog) return undefined;
        const identity = await this.catalog.lookup(sessionId, messageId);
        if (this.disposed || generation !== this.identityGeneration) throw new Error('Supervisor classification changed');
        return identity;
    }

    async prepareHistory(sessionId: string, messages: unknown[]): Promise<void> {
        for (const message of messages) {
            const info = (message as { info?: { role?: unknown; id?: unknown; parentID?: unknown } })?.info;
            const id = info?.role === 'user' ? info.id : info?.parentID;
            if (typeof id === 'string') await this.lookupNotification(sessionId, id);
        }
    }

    dispose(): void {
        this.setEnabled(false);
        this.disposed = true;
        this.generation++;
        this.identityGeneration++;
        this.catalog = undefined;
    }

    invalidateServiceConnection(): void {
        const enabled = this.enabled;
        this.setEnabled(false);
        this.setEnabled(enabled);
    }

    resetWorkspace(): void {
        const enabled = this.enabled;
        this.setEnabled(false);
        this.generation++;
        this.identityGeneration++;
        this.catalog = undefined;
        this.catalogScope = '';
        this.setEnabled(enabled);
    }
}
