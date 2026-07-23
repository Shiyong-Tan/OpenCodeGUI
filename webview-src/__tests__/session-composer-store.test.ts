import { createSessionComposerStore } from '../session-runtime/session-composer-store';

describe('session composer store', () => {
  test('preserves independent drafts, attachments, and context', () => {
    const store = createSessionComposerStore<{ path: string }, { text: string }, { path: string }>();
    store.capture('A', {
      draft: 'draft A',
      attachments: [{ path: 'a.txt' }],
      contextItems: [{ text: 'context A' }],
      fileRefs: [{ path: 'src/a.ts' }],
    });
    store.capture('B', {
      draft: 'draft B',
      attachments: [],
      contextItems: [],
      fileRefs: [],
    });

    expect(store.get('A')).toEqual({
      draft: 'draft A',
      attachments: [{ path: 'a.txt' }],
      contextItems: [{ text: 'context A' }],
      fileRefs: [{ path: 'src/a.ts' }],
    });
    expect(store.get('B').draft).toBe('draft B');
  });

  test('an asynchronous draft restore mutates only its owner', () => {
    const store = createSessionComposerStore<{ filePath: string }, never, never>();
    store.setDraft('A', 'old A');
    store.setDraft('B', 'stable B');

    store.restoreDraft('A', 'restored A', [{ filePath: 'a.txt' }]);

    expect(store.get('A')).toMatchObject({
      draft: 'restored A',
      attachments: [{ filePath: 'a.txt' }],
    });
    expect(store.get('B').draft).toBe('stable B');
  });

  test('a background attachment is retained by its owner only', () => {
    const store = createSessionComposerStore<{ filePath: string }, never, never>();
    store.addAttachment('A', { filePath: 'a.txt' });

    expect(store.get('A').attachments).toEqual([{ filePath: 'a.txt' }]);
    expect(store.get('B').attachments).toEqual([]);
  });

  test('a background context token is retained by its owner only', () => {
    const store = createSessionComposerStore<never, { text: string }, never>();
    store.addContext('A', { text: 'selection A' });

    expect(store.get('A').contextItems).toEqual([{ text: 'selection A' }]);
    expect(store.get('B').contextItems).toEqual([]);
  });
});
