import { SupervisorRoundStore, type ParentExecution, type SupervisorRound, type SupervisorRoundStorage } from './SupervisorRoundStore';
import type { SupervisorAssistantActivity } from './SupervisorAssistantObserver';
import type { NotificationIdentity } from './notification-identity-protocol';

export interface SupervisorRoundHost {
    storage(isolationId: string): SupervisorRoundStorage;
    parentExecution(sessionId: string): ParentExecution;
    start(round: SupervisorRound, source: Readonly<NotificationIdentity>): void;
    update(round: SupervisorRound): void;
    unresolved?(round: SupervisorRound): void;
}
/** Called only within the existing owning session actor queue. */
export class SupervisorRoundCoordinator {
    private readonly stores = new Map<string, SupervisorRoundStore>();
    private store(isolationId: string): SupervisorRoundStore {
        let store = this.stores.get(isolationId);
        if (!store) {
            if (this.stores.size >= 8) throw new Error('Supervisor isolation changed too often; reload');
            store = new SupervisorRoundStore(isolationId, this.host.storage(isolationId));
            this.stores.set(isolationId, store);
        }
        return store;
    }
    constructor(private readonly host: SupervisorRoundHost) {}
    async activity(activity: SupervisorAssistantActivity): Promise<'start' | 'continue' | 'drop'> {
        const result = await this.store(activity.source.isolationId).observeActivity({
            source: activity.source, assistantMessageId: activity.assistantMessageId, observedAt: activity.observedAt,
            parent: this.host.parentExecution(activity.source.parentSessionId),
        });
        if (result.disposition === 'unresolved') { this.host.unresolved?.(result.round); return 'drop'; }
        if (result.disposition === 'retired') return 'drop';
        if (result.disposition === 'start') this.host.start(result.round, activity.source);
        else if (result.disposition === 'join') this.host.update(result.round);
        return result.disposition === 'start' ? 'start' : 'continue';
    }
    accepts(source: Readonly<NotificationIdentity>): boolean {
        const round = this.stores.get(source.isolationId)?.peekSource(source.parentSessionId, source.notificationId);
        if (!round) return true;
        const parent = this.host.parentExecution(source.parentSessionId);
        return !round.final && parent.kind === 'active' && parent.executionId === round.executionId;
    }
    async preload(source: Readonly<NotificationIdentity>): Promise<void> { await this.store(source.isolationId).list(source.parentSessionId); }
    metadataFromParent(sessionId: string, parentMessageId: string): SupervisorRound | undefined {
        for (const store of this.stores.values()) {
            const round = store.peekParent(sessionId, parentMessageId);
            if (round) return round;
        }
        return undefined;
    }
    metadata(sessionId: string, assistantMessageId: string): SupervisorRound | undefined {
        for (const store of this.stores.values()) {
            const round = store.peek(sessionId, assistantMessageId);
            if (round) return round;
        }
        return undefined;
    }
    async finish(sessionId: string, assistantMessageId: string, observedAt: number, executionId?: string): Promise<void> {
        for (const store of this.stores.values()) {
            const round = store.peek(sessionId, assistantMessageId);
            const owner = round || (executionId ? store.peekExecution(sessionId, executionId) : undefined);
            if (owner) await store.finish(sessionId, owner.executionId, assistantMessageId, observedAt);
        }
    }
}
