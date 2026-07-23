import { createSessionOverlayStore } from '../session-runtime/session-overlay-store';

type Question = Readonly<{ callId: string; value: string }>;
type Permission = Readonly<{ permissionId: string; pending: boolean; error: string }>;

function createStore() {
  return createSessionOverlayStore<Question, Permission>({
    questionIdentity: (question) => question.callId,
    permissionIdentity: (permission) => permission.permissionId,
  });
}

describe('session overlay store', () => {
  test('keeps active and queued questions isolated by session', () => {
    const store = createStore();

    expect(store.enqueueQuestion('A', { callId: 'a1', value: 'first' })).toBe('active');
    expect(store.enqueueQuestion('A', { callId: 'a2', value: 'second' })).toBe('queued');
    expect(store.enqueueQuestion('B', { callId: 'b1', value: 'other' })).toBe('active');
    expect(store.enqueueQuestion('A', { callId: 'a2', value: 'duplicate' })).toBe('duplicate');

    expect(store.getQuestion('A')?.callId).toBe('a1');
    expect(store.getQuestion('B')?.callId).toBe('b1');
    expect(store.clearQuestion('A', { advanceQueue: true })?.callId).toBe('a2');
    expect(store.getQuestion('B')?.callId).toBe('b1');
  });

  test('switching presentation does not consume either session state', () => {
    const store = createStore();
    store.enqueueQuestion('A', { callId: 'a1', value: 'A question' });
    store.setPermission('B', {
      permissionId: 'b1',
      pending: false,
      error: '',
    });

    expect(store.getQuestion('A')?.value).toBe('A question');
    expect(store.getPermission('B')?.permissionId).toBe('b1');
    expect(store.getPermission('A')).toBeNull();
    expect(store.getQuestion('B')).toBeNull();
  });

  test('updates and clears only the owning permission session', () => {
    const store = createStore();
    store.setPermission('A', { permissionId: 'a1', pending: false, error: '' });
    store.setPermission('B', { permissionId: 'b1', pending: false, error: '' });

    store.updatePermission('A', (permission) => ({
      ...permission,
      pending: true,
      error: 'retry',
    }));
    store.clearPermission('A');

    expect(store.getPermission('A')).toBeNull();
    expect(store.getPermission('B')).toEqual({
      permissionId: 'b1',
      pending: false,
      error: '',
    });
  });

  test('deleting a session removes only its overlays', () => {
    const store = createStore();
    store.enqueueQuestion('A', { callId: 'a1', value: 'A question' });
    store.enqueueQuestion('B', { callId: 'b1', value: 'B question' });

    store.deleteSession('A');

    expect(store.getQuestion('A')).toBeNull();
    expect(store.getQuestion('B')?.callId).toBe('b1');
  });
});
