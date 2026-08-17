import type { SessionMessage } from '../changes/ChangeListInjection';

export type ForkOriginMetadata = Readonly<{
    version: 1;
    parentSessionId: string;
    parentTitle: string;
    createdAt: number;
}>;

export function normalizeForkOrigin(value: unknown): ForkOriginMetadata | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Record<string, unknown>;
    const parentSessionId = typeof candidate.parentSessionId === 'string'
        ? candidate.parentSessionId.trim()
        : '';
    if (!parentSessionId) return null;
    const parentTitle = typeof candidate.parentTitle === 'string' && candidate.parentTitle.trim()
        ? candidate.parentTitle.trim()
        : 'Parent session';
    const createdAt = typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)
        ? candidate.createdAt
        : 0;
    return Object.freeze({
        version: 1,
        parentSessionId,
        parentTitle,
        createdAt,
    });
}

export function createForkSnapshotPayload(input: {
    childSessionId: string;
    parentSessionId: string;
    parentTitle?: string;
    childTitle?: string;
    createdAt?: number;
}): Record<string, unknown> {
    const createdAt = typeof input.createdAt === 'number' && Number.isFinite(input.createdAt)
        ? input.createdAt
        : Date.now();
    const forkOrigin = normalizeForkOrigin({
        version: 1,
        parentSessionId: input.parentSessionId,
        parentTitle: input.parentTitle,
        createdAt,
    });
    if (!input.childSessionId || !forkOrigin) {
        throw new Error('A child session and parent session are required for a fork snapshot.');
    }
    return {
        sessionId: input.childSessionId,
        exportedAt: createdAt,
        sessionData: {
            type: 'sessionData',
            sessionId: input.childSessionId,
            title: input.childTitle || `${forkOrigin.parentTitle} (fork)`,
            messages: [] as SessionMessage[],
            segments: [],
            meta: {
                timelineMessageIds: [] as string[],
                segmentBackingMessageIds: [] as string[],
                hydrationCoverage: 'authoritativeHistoryComplete',
                forkOrigin,
            },
        },
    };
}

export function isEmptyForkBoundarySnapshot(sessionData: unknown): boolean {
    if (!sessionData || typeof sessionData !== 'object') return false;
    const candidate = sessionData as {
        messages?: unknown;
        meta?: { timelineMessageIds?: unknown; forkOrigin?: unknown };
    };
    if (!normalizeForkOrigin(candidate.meta?.forkOrigin)) return false;
    const messages = Array.isArray(candidate.messages) ? candidate.messages : [];
    const timelineIds = Array.isArray(candidate.meta?.timelineMessageIds)
        ? candidate.meta.timelineMessageIds.filter((id: unknown) => typeof id === 'string' && id)
        : [];
    return messages.length === 0 && timelineIds.length === 0;
}
