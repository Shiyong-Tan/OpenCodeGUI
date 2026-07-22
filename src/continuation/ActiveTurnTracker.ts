export type ActiveTurnSnapshot = {
    streaming: boolean;
    finalizing: boolean;
    active: boolean;
    fresh: boolean;
    source: string;
    turnId?: string;
    updatedAt: number;
    ageMs: number;
    freshnessWindowMs: number;
};

export class ActiveTurnTracker {
    private readonly updatedAtBySession = new Map<string, number>();

    constructor(private readonly options: {
        isStreaming(sessionId: string): boolean;
        getPendingAssistantId(sessionId: string): string | undefined;
        getPendingLocalKey(sessionId: string): string | undefined;
        freshnessWindowMs: number;
        now?(): number;
    }) {}

    mark(sessionId: string | undefined): void {
        if (sessionId) this.updatedAtBySession.set(sessionId, this.now());
    }

    snapshot(sessionId: string | undefined): ActiveTurnSnapshot {
        const streaming = Boolean(sessionId && this.options.isStreaming(sessionId));
        const pendingAssistantId = sessionId ? this.options.getPendingAssistantId(sessionId) : undefined;
        const finalizing = Boolean(pendingAssistantId);
        const active = streaming || finalizing;
        const updatedAt = sessionId ? (this.updatedAtBySession.get(sessionId) || 0) : 0;
        const age = updatedAt > 0 ? this.now() - updatedAt : Number.POSITIVE_INFINITY;
        const turnId = sessionId ? (pendingAssistantId || this.options.getPendingLocalKey(sessionId)) : undefined;
        const source = streaming && finalizing
            ? 'sendInFlightBySession+pendingAssistantMessageIdBySession'
            : streaming
                ? 'sendInFlightBySession'
                : finalizing
                    ? 'pendingAssistantMessageIdBySession'
                    : 'none';
        return {
            streaming,
            finalizing,
            active,
            fresh: active && updatedAt > 0 && age >= 0 && age <= this.options.freshnessWindowMs,
            source,
            turnId,
            updatedAt,
            ageMs: Number.isFinite(age) ? age : -1,
            freshnessWindowMs: this.options.freshnessWindowMs,
        };
    }

    describe(sessionId: string | undefined): string {
        const flags = this.snapshot(sessionId);
        return `streaming=${String(flags.streaming)} | finalizing=${String(flags.finalizing)} | activeTurnFresh=${String(flags.fresh)} | activeTurnSource=${flags.source} | activeTurnId=${flags.turnId || 'none'} | activeTurnAgeMs=${flags.ageMs} | activeTurnFreshnessWindowMs=${flags.freshnessWindowMs}`;
    }

    private now(): number {
        return this.options.now ? this.options.now() : Date.now();
    }
}
