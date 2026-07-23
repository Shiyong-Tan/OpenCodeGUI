import type { FinalizeTurnIdentity } from './TurnIdentityResolver';

export type TurnFinalizationTarget = {
    postMessage(message: unknown): unknown;
};

export class TurnFinalizationCoordinator {
    constructor(private readonly options: {
        getAssistantMessageId(sessionId: string): string | undefined;
        emitPhase(target: TurnFinalizationTarget, sessionId: string, phase: 'stream_done' | 'commit_done' | 'upgrade_done' | 'finalize_done'): void;
        postMessageIndexMap(target: TurnFinalizationTarget, sessionId: string): void;
        buildIdentity(sessionId: string, partial: Partial<FinalizeTurnIdentity>): FinalizeTurnIdentity;
        commitChanges(identity: FinalizeTurnIdentity): Promise<any>;
        finalizeBinding(sessionId: string, assistantMessageId: string): Promise<void>;
        resolvePendingUserUpgrade(sessionId: string, target: TurnFinalizationTarget): Promise<void>;
        promoteContinuationOwner(sessionId: string, assistantMessageId: string): Promise<void>;
        consolidateContinuationOwner(sessionId: string): Promise<void>;
        emitChangeList(identity: FinalizeTurnIdentity, target: TurnFinalizationTarget): Promise<void>;
        writeSnapshot(identity: FinalizeTurnIdentity): Promise<void>;
        clearSendInFlight(sessionId: string): void;
        finishTurn(sessionId: string): void;
        syncTurnInFlight(sessionId: string, target: TurnFinalizationTarget, reason: string): void;
        runSendInitCompensation(sessionId: string, target: TurnFinalizationTarget, reason: string): Promise<void>;
    }) {}

    async finalize(sessionId: string | undefined, target: TurnFinalizationTarget, assistantMessageId?: string): Promise<void> {
        if (!sessionId) return;
        const resolvedAssistantMessageId = assistantMessageId || this.options.getAssistantMessageId(sessionId) || undefined;
        target.postMessage({
            type: 'chatDone',
            sessionId,
            assistantMsgId: resolvedAssistantMessageId,
            lastAssistantMsgId: resolvedAssistantMessageId,
        });
        this.options.emitPhase(target, sessionId, 'stream_done');
        this.options.postMessageIndexMap(target, sessionId);
        const commitResult = await this.options.commitChanges(this.options.buildIdentity(sessionId, {
            assistantMessageId: resolvedAssistantMessageId,
            reqId: 'finalizeResolvedTurn',
        }));
        if (resolvedAssistantMessageId) {
            await this.options.finalizeBinding(sessionId, resolvedAssistantMessageId);
        }
        this.options.emitPhase(target, sessionId, 'commit_done');
        await this.options.resolvePendingUserUpgrade(sessionId, target);
        this.options.emitPhase(target, sessionId, 'upgrade_done');
        if (resolvedAssistantMessageId) {
            await this.options.promoteContinuationOwner(sessionId, resolvedAssistantMessageId);
            await this.options.consolidateContinuationOwner(sessionId);
        }
        this.options.postMessageIndexMap(target, sessionId);
        const identity = this.options.buildIdentity(sessionId, {
            assistantMessageId: resolvedAssistantMessageId,
            commitResult,
            reqId: 'finalizeResolvedTurn',
        });
        await this.options.emitChangeList(identity, target);
        await this.options.writeSnapshot(identity);
        this.options.clearSendInFlight(sessionId);
        target.postMessage({ type: 'turnInFlight', sessionId, inFlight: false });
        this.options.finishTurn(sessionId);
        this.options.syncTurnInFlight(sessionId, target, 'finalizeResolvedTurn');
        this.options.emitPhase(target, sessionId, 'finalize_done');
        await this.options.runSendInitCompensation(sessionId, target, 'finalizeResolvedTurn');
    }
}
