import { createSessionTransientStatusStore } from '../session-runtime/session-transient-status-store';

describe('session transient status store', () => {
  test('keeps notices and stall prompts isolated by session', () => {
    const store = createSessionTransientStatusStore<{ id: string }>();
    store.setNotice('A', 'A notice');
    store.setStall('A', { id: 'stall-A' });
    store.setNotice('B', 'B notice');

    expect(store.get('A')).toEqual({
      notice: 'A notice',
      stall: { id: 'stall-A' },
    });
    expect(store.get('B')).toEqual({
      notice: 'B notice',
      stall: null,
    });

    store.setStall('A', null);
    expect(store.get('A').notice).toBe('A notice');
    expect(store.get('B').notice).toBe('B notice');
  });
});
