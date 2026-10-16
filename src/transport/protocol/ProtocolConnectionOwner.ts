import type { ServerConnection } from '../OpenCodeHttpClient';
import { probeProtocol, type ProtocolIdentity } from './ProtocolNegotiator';
import { V2Backend } from './V2Backend';
import { V2Transport } from './V2Transport';

export interface ProtocolBinding {
    readonly identity: ProtocolIdentity; readonly native?: V2Backend;
    readonly generation: number; readonly isCurrent: () => boolean;
}
/** Connection-scoped immutable binding; never owns session history or turn state. */
export class ProtocolConnectionOwner {
    private generation = 0;
    private pending?: { key: string; work: Promise<ProtocolBinding> };
    private cancellation = new AbortController();
    constructor(private readonly fetcher: typeof fetch = fetch) {}
    invalidate(): void {
        this.generation++; this.pending = undefined;
        this.cancellation.abort(); this.cancellation = new AbortController();
    }
    bind(connection: ServerConnection, directory: string): Promise<ProtocolBinding> {
        const key = JSON.stringify([connection.baseUrl, connection.authHeader, directory]);
        if (this.pending?.key === key) return this.pending.work;
        this.invalidate();
        const generation = this.generation, signal = this.cancellation.signal;
        const isCurrent = () => this.generation === generation && !signal.aborted;
        const work = (async () => {
            const identity = await probeProtocol({ baseUrl: connection.baseUrl, authorization: connection.authHeader, signal, isCurrent }, this.fetcher);
            return { identity, generation, isCurrent, ...(identity.family === 'v2' ? {
                native: new V2Backend(new V2Transport({ baseUrl: connection.baseUrl, authorization: connection.authHeader, directory, signal, isCurrent }, this.fetcher)),
            } : {}) };
        })();
        this.pending = { key, work };
        void work.catch(() => { if (this.pending?.work === work) this.pending = undefined; });
        return work;
    }
}
