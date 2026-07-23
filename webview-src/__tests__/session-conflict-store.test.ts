import { createSessionConflictStore } from '../session-runtime/session-conflict-store';

type Conflict = Readonly<{ conflictId: string; value: string }>;

describe('session conflict store', () => {
  test('keeps conflicts independent across sessions', () => {
    const store = createSessionConflictStore<Conflict>({
      identity: (conflict) => conflict.conflictId,
    });
    store.set('A', { conflictId: 'a1', value: 'A conflict' });
    store.set('B', { conflictId: 'b1', value: 'B conflict' });

    expect(store.get('A')?.value).toBe('A conflict');
    expect(store.get('B')?.value).toBe('B conflict');
    expect(store.clear('A', 'a1')).toBe(true);
    expect(store.get('A')).toBeNull();
    expect(store.get('B')?.conflictId).toBe('b1');
  });

  test('a stale card cannot clear a newer conflict in the same session', () => {
    const store = createSessionConflictStore<Conflict>({
      identity: (conflict) => conflict.conflictId,
    });
    store.set('A', { conflictId: 'new', value: 'new conflict' });

    expect(store.clear('A', 'old')).toBe(false);
    expect(store.get('A')?.conflictId).toBe('new');
  });
});
