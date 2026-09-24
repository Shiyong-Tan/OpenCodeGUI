import { parseSupervisorView, type SupervisorView } from './protocol';
import type { IsolatedSupervisorConnection } from './IsolatedSupervisorConnection';

export type SupervisorReadResult =
    | { status: 'observed'; view: SupervisorView }
    | { status: 'unavailable'; reason: 'read_failed' | 'backoff' | 'busy' | 'disposed' };

/** Read-only Extension adapter. Session IDs must come from the host's session owner. */
export class SupervisorReader {
    private disposed = false;
    private readonly active = new Map<string, AbortController>();
    private readonly cache = new Map<string, SupervisorView>();
    private readonly failures = new Map<string, { count: number; nextAt: number }>();
    constructor(private readonly connection: IsolatedSupervisorConnection,
        private readonly fetcher: typeof fetch = fetch,
        private readonly now: () => number = Date.now,
        private readonly parse: (value: unknown) => SupervisorView = parseSupervisorView) { this.connection = { ...connection }; }

    async read(parentSessionId: string): Promise<SupervisorReadResult> {
        if (this.disposed) return { status: 'unavailable', reason: 'disposed' };
        if (!/^ses_[A-Za-z0-9_-]{1,160}$/.test(parentSessionId)) return { status: 'unavailable', reason: 'read_failed' };
        if (this.active.has(parentSessionId) || this.active.size >= 2) return { status: 'unavailable', reason: 'busy' };
        if ((this.failures.get(parentSessionId)?.nextAt ?? 0) > this.now()) return { status: 'unavailable', reason: 'backoff' };
        const controller = new AbortController();
        this.active.set(parentSessionId, controller);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const work = (async () => {
            const response = await this.fetcher(`${this.connection.bridgeEndpoint}/v1/snapshot?parentSessionId=${encodeURIComponent(parentSessionId)}`, {
                method: 'GET', headers: { Authorization: `Bearer ${this.connection.bridgeToken}` },
                signal: controller.signal, redirect: 'error', cache: 'no-store',
            });
            if (!response.ok || !response.body) throw new Error('Supervisor read failed');
            const reader = response.body.getReader();
            const chunks: Uint8Array[] = [];
            let total = 0;
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    total += value.byteLength;
                    if (total > 262144 || controller.signal.aborted) throw new Error('Supervisor read bound exceeded');
                    chunks.push(value);
                }
            } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
            const view = this.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
            if (controller.signal.aborted || this.disposed || view.parentSessionId !== parentSessionId ||
                view.instanceId !== this.connection.instanceId || view.isolationId !== this.connection.isolationId ||
                view.openCodeVersion !== this.connection.openCodeVersion || view.pluginVersion !== this.connection.pluginVersion) throw new Error('Stale or foreign supervisor view');
            const prior = this.cache.get(parentSessionId);
            if (prior && (view.revision < prior.revision || Date.parse(view.observedAt) < Date.parse(prior.observedAt))) throw new Error('Regressed supervisor view');
            // Caller mutations cannot change the validated cache.
            if (!this.cache.has(parentSessionId) && this.cache.size >= 128) {
                const oldest = this.cache.keys().next().value as string | undefined;
                if (oldest) this.cache.delete(oldest);
            }
            this.cache.set(parentSessionId, structuredClone(view));
            this.failures.delete(parentSessionId);
            return { status: 'observed', view } as const;
        })();
        // Keep the slot until actual settlement, even if a misbehaving fetch ignores abort.
        void work.finally(() => { this.active.delete(parentSessionId); if (timer) clearTimeout(timer); }).catch(() => undefined);
        try {
            return await Promise.race([work, new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => { controller.abort(); reject(new Error('Supervisor deadline')); }, 2500);
            })]);
        } catch {
            controller.abort();
            if (this.disposed) return { status: 'unavailable', reason: 'disposed' };
            const count = (this.failures.get(parentSessionId)?.count ?? 0) + 1;
            if (!this.failures.has(parentSessionId) && this.failures.size >= 128) {
                const oldest = this.failures.keys().next().value as string | undefined;
                if (oldest) this.failures.delete(oldest);
            }
            this.failures.set(parentSessionId, { count, nextAt: this.now() + Math.min(30000, 1000 * 2 ** Math.min(count - 1, 5)) });
            return { status: 'unavailable', reason: 'read_failed' };
        }
    }

    dispose(): void {
        this.disposed = true;
        for (const controller of this.active.values()) controller.abort();
        this.cache.clear(); this.failures.clear();
    }
}
