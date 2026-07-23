import { RevertedSegmentHistoryStore } from '../../session-runtime/RevertedSegmentHistoryStore';

describe('RevertedSegmentHistoryStore', () => {
    test('updates one session without changing another history', () => {
        const store = new RevertedSegmentHistoryStore();
        store.set('A', [{
            isActive: false,
            discarded: true,
            collapsed: true,
            messageIds: ['msg_A'],
        }]);
        store.set('B', [{
            isActive: false,
            discarded: true,
            collapsed: true,
            messageIds: ['msg_B'],
        }]);

        store.update('A', (entries) => [...entries, {
            isActive: false,
            discarded: true,
            collapsed: true,
            messageIds: ['msg_A2'],
        }]);

        expect(store.get('A')).toHaveLength(2);
        expect(store.get('B')).toEqual([expect.objectContaining({ messageIds: ['msg_B'] })]);
    });
});
