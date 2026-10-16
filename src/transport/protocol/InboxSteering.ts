import { BackendOperationError } from './BackendContract';
import type { ProtocolBinding } from './ProtocolConnectionOwner';

export interface SteeringInput { sessionId: string; inboxId: string; generation: number }
export interface SteeringResult { delivery: 'queue' | 'steer' | 'unknown'; canSteer: boolean }
/** Deduplicates one explicit user operation; the backend remains the inbox owner. */
export class InboxSteering {
    private readonly pending = new Map<string, Promise<SteeringResult>>();
    constructor(private readonly binding: () => Promise<ProtocolBinding | undefined>) {}
    steer(input: SteeringInput): Promise<SteeringResult> {
        const key = JSON.stringify([input.generation, input.sessionId, input.inboxId]);
        const existing = this.pending.get(key); if (existing) return existing;
        const work = this.execute(input);
        this.pending.set(key, work);
        void work.finally(() => { if (this.pending.get(key) === work) this.pending.delete(key); }).catch(() => undefined);
        return work;
    }
    private async execute(input: SteeringInput): Promise<SteeringResult> {
        const binding = await this.binding(), api = binding?.native?.sessions;
        if (!binding || !api || !binding.isCurrent() || input.generation !== binding.generation)
            throw new BackendOperationError('superseded', 'steer queued input');
        const read = async () => {
            const item = (await api.inbox(input.sessionId)).find(item => item.id === input.inboxId);
            if (!binding.isCurrent()) throw new BackendOperationError('superseded', 'steer queued input');
            return item;
        };
        const pending = await read();
        if (!pending || pending.kind !== 'user') return { delivery: 'unknown', canSteer: false };
        if (pending.delivery === 'steer') return { delivery: 'steer', canSteer: false };
        try {
            await api.changeDelivery(input.sessionId, input.inboxId, 'steer');
            if (!binding.isCurrent()) throw new BackendOperationError('superseded', 'steer queued input');
            return { delivery: 'steer', canSteer: false };
        } catch (error) {
            if (!(error instanceof BackendOperationError) || !['conflict', 'ambiguous'].includes(error.reason)) throw error;
            const current = await read();
            // Absence means no longer pending, not proof of delivery or completion.
            return { delivery: current?.delivery ?? 'unknown', canSteer: current?.kind === 'user' && current.delivery === 'queue' };
        }
    }
}
