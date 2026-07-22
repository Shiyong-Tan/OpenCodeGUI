import {
    buildFullExportSnapshotDelta,
    classifyRecentAppendCandidates,
    getSnapshotTimelineIds,
} from '../history/SnapshotDeltaPlanner';

const message = (id: string, messageIndex: number, text = id): any => ({ id, messageIndex, role: 'assistant', text, meta: {} });
const visible = () => true;
const appendImmutable = (existing: any[], suffix: any[]) => {
    const seen = new Set(existing.map((item) => item.id));
    return [...existing, ...suffix.filter((item) => item?.id && !seen.has(item.id))];
};

describe('snapshot delta planner', () => {
    test('preserves explicit snapshot timeline ids exactly and deduplicates order', () => {
        expect(getSnapshotTimelineIds({
            sessionData: { meta: { timelineMessageIds: ['msg_b', 'msg_a', 'msg_b'] } },
            formattedMessages: [message('msg_other', 0)],
            collectVisible: (messages) => messages,
        })).toEqual(['msg_b', 'msg_a']);
    });

    test('accepts only the strictly newer suffix after a unique boundary', () => {
        expect(classifyRecentAppendCandidates({
            snapshotTimelineIdSet: new Set(['msg_a', 'msg_b']),
            snapshotMaxMessageIndex: 2,
            recentFormattedMessages: [message('msg_a', 1), message('msg_b', 2), message('msg_c', 3), message('msg_d', 4)],
            isVisible: visible,
        })).toEqual({ proven: true, suffix: [message('msg_c', 3), message('msg_d', 4)] });
    });

    test('rejects missing, duplicate, or non-monotonic boundaries', () => {
        const base = { snapshotTimelineIdSet: new Set(['msg_b']), snapshotMaxMessageIndex: 2, isVisible: visible };
        expect(classifyRecentAppendCandidates({ ...base, recentFormattedMessages: [message('msg_c', 3)] }).proven).toBe(false);
        expect(classifyRecentAppendCandidates({ ...base, recentFormattedMessages: [message('msg_b', 2), message('msg_b', 2)] }).proven).toBe(false);
        expect(classifyRecentAppendCandidates({ ...base, recentFormattedMessages: [message('msg_b', 2), message('msg_c', 2)] }).proven).toBe(false);
    });

    test('appends a full-export suffix without rewriting stored snapshot records', () => {
        const stored = { ...message('msg_b', 2), text: 'snapshot-visible-text' };
        const result = buildFullExportSnapshotDelta({
            existingSnapshotRecords: [stored],
            snapshotTimelineIds: ['msg_b'],
            fullExportRecords: [message('msg_a', 1), message('msg_b', 2, 'remote-text'), message('msg_c', 3)],
            appendImmutable,
        });
        expect(result.proven).toBe(true);
        expect(result.messages).toEqual([stored, message('msg_c', 3)]);
        expect(result.timelineMessageIds).toEqual(['msg_b', 'msg_c']);
    });

    test('repairs only explicitly visible missing snapshot ids and keeps stored fields authoritative', () => {
        const stored = { ...message('msg_a', 1), text: 'kept snapshot text', meta: { hiddenDecision: true } };
        const result = buildFullExportSnapshotDelta({
            existingSnapshotRecords: [stored],
            snapshotTimelineIds: ['msg_a', 'msg_b'],
            fullExportRecords: [message('msg_a', 1, 'remote a'), message('msg_b', 2, 'remote b'), message('msg_c', 3)],
            repairRequiredMessageIds: ['msg_b'],
            appendImmutable,
        });
        expect(result).toMatchObject({ proven: true, repairedSnapshot: true, timelineMessageIds: ['msg_a', 'msg_b', 'msg_c'] });
        expect(result.messages[0]).toMatchObject({ id: 'msg_a', text: 'kept snapshot text', meta: { hiddenDecision: true } });
    });
});
