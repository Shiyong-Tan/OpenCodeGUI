import { createMessageIdentityStore } from '../session-runtime/message-identity';

describe('stable message identity store', () => {
  test('keeps one entity while a temporary assistant becomes canonical', () => {
    let sequence = 0;
    const store = createMessageIdentityStore({
      nextEntityId: () => `entity:test:${++sequence}`,
    });
    const message: any = { id: 'tmp:assistant', role: 'assistant', meta: {} };

    expect(store.ensure(message)).toEqual({
      entityId: 'entity:test:1',
      temporaryId: 'tmp:assistant',
    });
    message.id = 'msg_assistant';
    expect(store.bindCanonical(message, 'msg_assistant')).toEqual({
      entityId: 'entity:test:1',
      canonicalId: 'msg_assistant',
    });
    expect(store.ensure(message).entityId).toBe('entity:test:1');
  });

  test('gives hydrated canonical records stable canonical bindings', () => {
    const store = createMessageIdentityStore({ nextEntityId: () => 'entity:hydrated' });
    const message: any = { id: 'msg_assistant', role: 'assistant' };
    expect(store.ensure(message)).toEqual({
      entityId: 'entity:hydrated',
      canonicalId: 'msg_assistant',
    });
  });

  test('rejects rebinding one entity to a different canonical ID', () => {
    const store = createMessageIdentityStore({ nextEntityId: () => 'entity:one' });
    const message: any = { id: 'tmp:assistant' };
    store.bindCanonical(message, 'msg_one');
    expect(() => store.bindCanonical(message, 'msg_two')).toThrow(
      'Message entity entity:one is already bound to msg_one',
    );
  });

  test('compares entity identity independently from current storage key', () => {
    const store = createMessageIdentityStore();
    const left: any = { id: 'tmp:left' };
    store.ensure(left);
    const right: any = { id: 'msg_right', meta: { identity: left.meta.identity } };
    expect(store.sameEntity(left, right)).toBe(true);
  });

  test('ensures backing-only records receive identity before storage', () => {
    const store = createMessageIdentityStore({ nextEntityId: () => 'entity:backing' });
    const messages = new Map<string, any>();
    const message: any = { id: 'msg_backing', role: 'assistant' };
    expect(store.store(messages, message)).toBe(message);
    expect(messages.get('msg_backing').meta.identity).toEqual({
      entityId: 'entity:backing',
      canonicalId: 'msg_backing',
    });
  });
});
