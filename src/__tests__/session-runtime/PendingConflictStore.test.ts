import { PendingConflictStore } from '../../session-runtime/PendingConflictStore';

describe('PendingConflictStore', () => {
    test('keeps pending conflicts independent across sessions', () => {
        const store = new PendingConflictStore();
        store.set({
            kind: 'undo',
            sessionId: 'A',
            operationId: 'op-A',
            conflictId: 'conflict-A',
        });
        store.set({
            kind: 'restore',
            sessionId: 'B',
            operationId: 'op-B',
            conflictId: 'conflict-B',
        });

        expect(store.take('A')?.conflictId).toBe('conflict-A');
        expect(store.get('A')).toBeUndefined();
        expect(store.get('B')?.conflictId).toBe('conflict-B');
        expect(store.size).toBe(1);
    });

    test('replaces only the pending conflict for the same session', () => {
        const store = new PendingConflictStore();
        store.set({
            kind: 'undo',
            sessionId: 'A',
            operationId: 'op-A1',
            conflictId: 'conflict-A1',
        });
        store.set({
            kind: 'restoreSegment',
            sessionId: 'A',
            operationId: 'op-A2',
            conflictId: 'conflict-A2',
        });

        expect(store.get('A')).toMatchObject({
            kind: 'restoreSegment',
            operationId: 'op-A2',
            conflictId: 'conflict-A2',
        });
        expect(store.size).toBe(1);
    });
});
