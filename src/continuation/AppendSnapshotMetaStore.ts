import type { SessionMessage } from '../changes/ChangeListInjection';

export type AppendSnapshotMetaRoot = {
    rootMessageId: string;
    appendRootUserKey?: string;
    meta: { appendedPrompts: Array<Record<string, unknown>> };
};

export class AppendSnapshotMetaStore {
    private readonly bySession = new Map<string, Map<string, AppendSnapshotMetaRoot>>();

    constructor(private readonly log: (line: string) => void) {}

    sanitizeItems(items: unknown): Array<Record<string, unknown>> {
        if (!Array.isArray(items)) return [];
        const output: Array<Record<string, unknown>> = [];
        const seen = new Set<string>();
        for (const raw of items) {
            if (!raw || typeof raw !== 'object') continue;
            const item = raw as Record<string, unknown>;
            const sanitized: Record<string, unknown> = {};
            const copyString = (name: string, maxLength = 20_000) => {
                const value = item[name];
                if (typeof value === 'string' && value.length > 0) sanitized[name] = value.slice(0, maxLength);
            };
            copyString('clientMessageId', 512);
            copyString('appendUserMsgId', 512);
            copyString('rootUserMsgId', 512);
            copyString('status', 64);
            copyString('reason', 1_000);
            copyString('text', 20_000);
            for (const name of ['createdAt', 'updatedAt']) {
                const value = item[name];
                if (typeof value === 'number' && Number.isFinite(value)) sanitized[name] = value;
            }
            if (!Object.keys(sanitized).length) continue;
            const key = String(sanitized.clientMessageId || sanitized.appendUserMsgId || output.length);
            if (seen.has(key)) continue;
            seen.add(key);
            output.push(sanitized);
        }
        return output;
    }

    sanitizePayload(payload: any): Map<string, AppendSnapshotMetaRoot> {
        const output = new Map<string, AppendSnapshotMetaRoot>();
        const roots = Array.isArray(payload?.roots) ? payload.roots : [];
        for (const root of roots) {
            if (!root || typeof root !== 'object') continue;
            const rootMessageId = typeof root.rootMessageId === 'string' ? root.rootMessageId : '';
            if (!rootMessageId || rootMessageId.startsWith('local-') || rootMessageId.startsWith('tmp:')) continue;
            const appendedPrompts = this.sanitizeItems(root.meta?.appendedPrompts);
            if (!appendedPrompts.length) continue;
            output.set(rootMessageId, {
                rootMessageId,
                appendRootUserKey: typeof root.appendRootUserKey === 'string' ? root.appendRootUserKey : rootMessageId,
                meta: { appendedPrompts },
            });
        }
        return output;
    }

    cache(payload: any): void {
        const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
        if (!sessionId) return;
        const incoming = this.sanitizePayload(payload);
        if (!incoming.size) return;
        const existing = this.bySession.get(sessionId) || new Map<string, AppendSnapshotMetaRoot>();
        for (const [rootMessageId, entry] of incoming) existing.set(rootMessageId, entry);
        this.bySession.set(sessionId, existing);
        const appendCount = Array.from(existing.values())
            .reduce((sum, root) => sum + root.meta.appendedPrompts.length, 0);
        this.log(`[EXT][APPEND_SNAPSHOT_META] cache sessionId=${sessionId} rootCount=${existing.size} appendCount=${appendCount} reason=${typeof payload?.reason === 'string' ? payload.reason : 'unknown'}`);
    }

    apply(sessionId: string, messagesById: Map<string, SessionMessage>): number {
        const cached = this.bySession.get(sessionId);
        if (!cached?.size) return 0;
        let merged = 0;
        for (const [rootMessageId, entry] of cached) {
            const message = messagesById.get(rootMessageId);
            if (!message || message.role !== 'user') continue;
            const existingMeta = message.meta && typeof message.meta === 'object' ? message.meta : {};
            message.meta = {
                ...existingMeta,
                appendedPrompts: entry.meta.appendedPrompts,
                appendRootUserKey: entry.appendRootUserKey || rootMessageId,
            };
            messagesById.set(rootMessageId, message);
            merged++;
        }
        if (merged > 0) this.log(`[EXT][APPEND_SNAPSHOT_META] merge sessionId=${sessionId} rootCount=${merged}`);
        return merged;
    }
}
