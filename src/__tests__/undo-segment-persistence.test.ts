import { hydrateUndoSegments, serializeUndoSegments, type SegmentState } from '../undo/UndoSegmentPersistence';

const segment: SegmentState = {
    noticeKey: 'system:undo:msg_a',
    anchorMsgId: 'msg_a',
    endMsgId: 'msg_b',
    memberMsgIds: ['msg_a', 'msg_b'],
    restoreAllowed: true,
    createdAt: 1,
    updatedAt: 2,
};

describe('undo segment persistence', () => {
    test('round-trips sessions and notice-key maps without rewriting segment fields', () => {
        const source = new Map([['session-a', new Map([[segment.noticeKey, segment]])]]);
        const hydrated = hydrateUndoSegments(serializeUndoSegments(source));
        expect(hydrated.get('session-a')?.get(segment.noticeKey)).toEqual(segment);
    });

    test('uses an empty registry when storage is absent', () => {
        expect(hydrateUndoSegments(undefined).size).toBe(0);
    });

    test('keeps malformed JSON observable to the caller', () => {
        expect(() => hydrateUndoSegments('{')).toThrow();
    });
});
