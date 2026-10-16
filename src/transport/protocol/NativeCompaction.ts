import { randomBytes } from 'crypto';
import { BackendOperationError } from './BackendContract';
import type { BackendEvent } from './V2EventAdapter';
import type { ProtocolBinding } from './ProtocolConnectionOwner';

/** Correlates one admitted compaction with native started/ended facts, never an assistant answer. */
export class NativeCompaction {
    private readonly pending = new Map<string, { inboxId: string; started: boolean; finish(error?: Error): void }>();
    constructor(private readonly binding: () => ProtocolBinding | undefined, private readonly deadlineMs = 180000) {}
    observe(event: BackendEvent): void {
        const current = event.sessionId ? this.pending.get(event.sessionId) : undefined;
        if (!current || event.payload.reason !== 'manual') return;
        if (event.type === 'session.compaction.started' && event.payload.inputID === current.inboxId) current.started = true;
        else if (event.type === 'session.compaction.ended' && current.started) current.finish();
        else if (event.type === 'session.compaction.failed' && (current.started || event.payload.inputID === current.inboxId))
            current.finish(new Error('The OpenCode compaction provider failed.'));
    }
    async run(sessionId: string): Promise<void> {
        if (this.pending.has(sessionId)) throw new BackendOperationError('conflict', 'native compaction already pending');
        const binding = this.binding(), backend = binding?.native;
        if (!binding?.isCurrent() || !backend) throw new BackendOperationError('superseded', 'native compaction');
        const inboxId = `msg_${Date.now().toString(36)}_${randomBytes(10).toString('hex')}`;
        let finish!: (error?: Error) => void;
        const complete = new Promise<void>((resolve, reject) => { finish = error => error ? reject(error) : resolve(); });
        void complete.catch(() => undefined);
        const row = { inboxId, started: false, finish }; this.pending.set(sessionId, row);
        const timer = setTimeout(() => finish(new BackendOperationError('ambiguous', 'native compaction outcome unavailable')), this.deadlineMs);
        const abort = () => finish(new BackendOperationError('superseded', 'native compaction service changed'));
        backend.transport.connection.signal?.addEventListener('abort', abort, { once: true });
        try {
            await backend.controls.compact(sessionId, inboxId, 'steer');
            await complete;
            if (!binding.isCurrent()) throw new BackendOperationError('superseded', 'native compaction');
        } finally {
            clearTimeout(timer); backend.transport.connection.signal?.removeEventListener('abort', abort);
            if (this.pending.get(sessionId) === row) this.pending.delete(sessionId);
        }
    }
}
