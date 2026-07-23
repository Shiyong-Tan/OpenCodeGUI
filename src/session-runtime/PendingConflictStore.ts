export type PendingConflict = Readonly<{
    kind: 'undo' | 'restore' | 'restoreSegment';
    sessionId: string;
    operationId: string;
    conflictId: string;
    startMessageId?: string;
    endMessageId?: string;
    visibleMessageIds?: string[];
    forwardMessageIdsFromAnchor?: string[];
    anchorIndex?: number;
    noticeKey?: string;
}>;

export class PendingConflictStore {
    private readonly bySession = new Map<string, PendingConflict>();

    public set(conflict: PendingConflict): void {
        this.bySession.set(conflict.sessionId, conflict);
    }

    public get(sessionId: string): PendingConflict | undefined {
        return this.bySession.get(sessionId);
    }

    public take(sessionId: string): PendingConflict | undefined {
        const conflict = this.bySession.get(sessionId);
        if (conflict) this.bySession.delete(sessionId);
        return conflict;
    }

    public delete(sessionId: string): void {
        this.bySession.delete(sessionId);
    }

    public clear(): void {
        this.bySession.clear();
    }

    public get size(): number {
        return this.bySession.size;
    }
}
