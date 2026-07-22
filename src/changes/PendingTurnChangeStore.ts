import type { FileChangeSpec } from '../undo/types';

export type PendingTurnChanges = {
    turnKey: string;
    tmpKey?: string;
    changes: FileChangeSpec[];
    lastAssistantMsgId?: string;
};

export class PendingTurnChangeStore {
    private readonly bySession = new Map<string, PendingTurnChanges>();

    public get(sessionId: string): PendingTurnChanges | undefined {
        return this.bySession.get(sessionId);
    }

    public has(sessionId: string): boolean {
        return this.bySession.has(sessionId);
    }

    public set(sessionId: string, value: PendingTurnChanges): this {
        this.bySession.set(sessionId, value);
        return this;
    }

    public delete(sessionId: string): boolean {
        return this.bySession.delete(sessionId);
    }

    public clear(): void {
        this.bySession.clear();
    }

    public hasChanges(sessionId: string): boolean {
        return Boolean(this.bySession.get(sessionId)?.changes.length);
    }

    public queue(input: {
        sessionId: string;
        turnKey: string;
        tmpKey?: string;
        assistantMsgId?: string;
        changes: FileChangeSpec[];
    }): PendingTurnChanges | undefined {
        const { sessionId, turnKey, tmpKey, assistantMsgId, changes } = input;
        if (!sessionId || !turnKey || !changes.length) return undefined;
        const existing = this.bySession.get(sessionId);
        if (existing && existing.turnKey !== turnKey) this.bySession.delete(sessionId);
        const next = this.bySession.get(sessionId) || {
            turnKey,
            tmpKey,
            changes: [],
            lastAssistantMsgId: assistantMsgId,
        };
        if (tmpKey) next.tmpKey = tmpKey;
        if (assistantMsgId) next.lastAssistantMsgId = assistantMsgId;
        next.changes.push(...changes);
        this.bySession.set(sessionId, next);
        return next;
    }
}
