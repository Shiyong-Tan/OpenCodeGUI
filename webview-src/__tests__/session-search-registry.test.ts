import { createSessionSearchRegistry } from '../session-runtime/session-search-registry';

describe('session search registry', () => {
  test('returns one independent search state per session', () => {
    let sequence = 0;
    const registry = createSessionSearchRegistry(() => ({ id: ++sequence, query: '' }));

    const a = registry.get('A')!;
    const b = registry.get('B')!;
    a.query = 'alpha';
    b.query = 'beta';

    expect(registry.get('A')).toBe(a);
    expect(registry.get('B')).toBe(b);
    expect(a).toEqual({ id: 1, query: 'alpha' });
    expect(b).toEqual({ id: 2, query: 'beta' });
  });

  test('does not create state for ownerless or read-only misses', () => {
    let created = 0;
    const registry = createSessionSearchRegistry(() => ({ id: ++created }));

    expect(registry.get('', true)).toBeNull();
    expect(registry.get('A', false)).toBeNull();
    expect(created).toBe(0);
  });
});
