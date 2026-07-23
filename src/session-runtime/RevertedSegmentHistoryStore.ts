export type RevertedSegmentHistoryEntry = Readonly<{
    isActive: boolean;
    discarded: boolean;
    startMessageId?: string;
    startMessageIndex?: number;
    endMessageId?: string;
    endMessageIndex?: number;
    collapsed: boolean;
    messageIds?: string[];
    operationId?: string;
}>;

export class RevertedSegmentHistoryStore {
    private readonly bySession = new Map<string, RevertedSegmentHistoryEntry[]>();

    public get(sessionId: string): RevertedSegmentHistoryEntry[] {
        return [...(this.bySession.get(sessionId) || [])];
    }

    public set(sessionId: string, entries: readonly RevertedSegmentHistoryEntry[]): void {
        if (!sessionId) return;
        this.bySession.set(sessionId, [...entries]);
    }

    public update(
        sessionId: string,
        update: (entries: RevertedSegmentHistoryEntry[]) => RevertedSegmentHistoryEntry[],
    ): RevertedSegmentHistoryEntry[] {
        const next = update(this.get(sessionId));
        this.set(sessionId, next);
        return [...next];
    }

    public clearSession(sessionId: string): void {
        this.bySession.delete(sessionId);
    }

    public clear(): void {
        this.bySession.clear();
    }
}
