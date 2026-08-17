import {
    createForkSnapshotPayload,
    isEmptyForkBoundarySnapshot,
    normalizeForkOrigin,
} from '../history/ForkSnapshotBoundary';

describe('fork snapshot boundary', () => {
    test('creates an authoritative empty child history with a parent link', () => {
        const payload: any = createForkSnapshotPayload({
            childSessionId: 'session-child',
            parentSessionId: 'session-parent',
            parentTitle: 'Parent title',
            childTitle: 'Parent title (fork #1)',
            createdAt: 123,
        });

        expect(payload).toMatchObject({
            sessionId: 'session-child',
            exportedAt: 123,
            sessionData: {
                sessionId: 'session-child',
                title: 'Parent title (fork #1)',
                messages: [],
                segments: [],
                meta: {
                    timelineMessageIds: [],
                    segmentBackingMessageIds: [],
                    hydrationCoverage: 'authoritativeHistoryComplete',
                    forkOrigin: {
                        version: 1,
                        parentSessionId: 'session-parent',
                        parentTitle: 'Parent title',
                        createdAt: 123,
                    },
                },
            },
        });
        expect(isEmptyForkBoundarySnapshot(payload.sessionData)).toBe(true);
    });

    test('does not treat an invalid or populated snapshot as an empty fork boundary', () => {
        expect(normalizeForkOrigin({ parentSessionId: '' })).toBeNull();
        expect(isEmptyForkBoundarySnapshot({ messages: [], meta: {} })).toBe(false);
        expect(isEmptyForkBoundarySnapshot({
            messages: [{ id: 'msg_child' }],
            meta: {
                timelineMessageIds: ['msg_child'],
                forkOrigin: { parentSessionId: 'session-parent', createdAt: 1 },
            },
        })).toBe(false);
    });
});
