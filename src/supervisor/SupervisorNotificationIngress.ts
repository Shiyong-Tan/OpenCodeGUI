import type { NotificationIdentity } from './notification-identity-protocol';

export interface NotificationLookup {
    (sessionId: string, messageId: string): Promise<Readonly<NotificationIdentity> | undefined>;
}

/** Orders asynchronous trust checks within each owning session. No lifecycle state.
 * Capacity/errors fail closed for that session until this connection is reloaded.
 */
export class SupervisorNotificationIngress {
    private readonly lanes = new Map<string, { tail: Promise<void>; pending: number; failed: boolean }>();
    private disposed = false;
    constructor(private readonly lookup: NotificationLookup, private readonly onBlocked: (sessionId: string) => void,
        private readonly haltSessionOnFailure = true) {}

    async route(sessionId: string, messageId: string | undefined, forward: () => void | Promise<void>): Promise<void> {
        if (this.disposed) return;
        let lane = this.lanes.get(sessionId);
        if (!lane) {
            if (this.lanes.size >= 128) { this.onBlocked(sessionId); return; }
            lane = { tail: Promise.resolve(), pending: 0, failed: false };
            this.lanes.set(sessionId, lane);
        }
        if (lane.failed) return;
        if (lane.pending >= 512) { lane.failed = this.haltSessionOnFailure; this.onBlocked(sessionId); return; }
        lane.pending++;
        const current = lane;
        const next = current.tail.then(async () => {
            if (this.disposed || current.failed) return;
            let timer: ReturnType<typeof setTimeout> | undefined;
            let identity: Readonly<NotificationIdentity> | undefined;
            try {
                identity = messageId ? await Promise.race([
                    this.lookup(sessionId, messageId),
                    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Identity read deadline')), 2500); }),
                ]) : undefined;
            } finally { if (timer) clearTimeout(timer); }
            if (this.disposed || current.failed) return;
            if (!identity) await forward();
        }).catch(() => {
            if (!this.disposed && !current.failed) { current.failed = this.haltSessionOnFailure; this.onBlocked(sessionId); }
        }).finally(() => { current.pending--; });
        current.tail = next;
        await next;
    }
    dispose(): void { this.disposed = true; this.lanes.clear(); }
}
