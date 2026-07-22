export interface SegmentState {
    noticeKey: string;
    anchorMsgId: string;
    endMsgId: string;
    memberMsgIds: string[];
    mergedInvalidSegments?: SegmentState[];
    applied?: boolean;
    restoreAllowed?: boolean;
    collapsed?: boolean;
    createdAt: number;
    updatedAt: number;
}

export type UndoSegmentsBySession = Map<string, Map<string, SegmentState>>;

export function hydrateUndoSegments(raw: string | undefined): UndoSegmentsBySession {
    const hydrated: UndoSegmentsBySession = new Map();
    if (!raw) return hydrated;
    const parsed = JSON.parse(raw) as Record<string, Record<string, SegmentState>>;
    for (const [sessionId, segments] of Object.entries(parsed)) {
        const segmentMap = new Map<string, SegmentState>();
        for (const [noticeKey, segment] of Object.entries(segments)) {
            segmentMap.set(noticeKey, segment);
        }
        hydrated.set(sessionId, segmentMap);
    }
    return hydrated;
}

export function serializeUndoSegments(segmentsBySession: UndoSegmentsBySession): string {
    const serialized: Record<string, Record<string, SegmentState>> = {};
    for (const [sessionId, segmentMap] of segmentsBySession) {
        const segments: Record<string, SegmentState> = {};
        for (const [noticeKey, segment] of segmentMap) segments[noticeKey] = segment;
        serialized[sessionId] = segments;
    }
    return JSON.stringify(serialized);
}
