import { PendingTurnChangeStore } from '../changes/PendingTurnChangeStore';

describe('PendingTurnChangeStore', () => {
    test('accumulates one turn and updates its latest bindings', () => {
        const store = new PendingTurnChangeStore();
        store.queue({ sessionId: 's1', turnKey: 'u1', tmpKey: 'tmp1', changes: [{ type: 'create', path: 'a.ts' }] });
        store.queue({ sessionId: 's1', turnKey: 'u1', assistantMsgId: 'msg1', changes: [{ type: 'update', path: 'b.ts' }] });
        expect(store.get('s1')).toEqual({
            turnKey: 'u1',
            tmpKey: 'tmp1',
            lastAssistantMsgId: 'msg1',
            changes: [{ type: 'create', path: 'a.ts' }, { type: 'update', path: 'b.ts' }],
        });
    });

    test('replaces stale pending state when the turn owner changes', () => {
        const store = new PendingTurnChangeStore();
        store.queue({ sessionId: 's1', turnKey: 'u1', changes: [{ type: 'create', path: 'old.ts' }] });
        store.queue({ sessionId: 's1', turnKey: 'u2', changes: [{ type: 'delete', path: 'new.ts' }] });
        expect(store.get('s1')).toEqual({
            turnKey: 'u2',
            tmpKey: undefined,
            lastAssistantMsgId: undefined,
            changes: [{ type: 'delete', path: 'new.ts' }],
        });
    });

    test('retains the Map-compatible surface required by migration tests', () => {
        const store = new PendingTurnChangeStore();
        store.set('s1', { turnKey: 'u1', changes: [] });
        expect(store.has('s1')).toBe(true);
        expect(store.delete('s1')).toBe(true);
        expect(store.has('s1')).toBe(false);
    });
});
