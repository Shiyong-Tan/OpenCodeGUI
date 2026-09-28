import { createSessionComposerStore } from '../session-runtime/session-composer-store';

describe('session composer store', () => {
  test('rejected send restores its composer once, preserving newer typing and other sessions', () => {
    const store = createSessionComposerStore<string, string, string>();
    store.capture('A', { draft: 'sent', attachments: ['image'], contextItems: ['context'], fileRefs: ['file'] });
    store.rememberSubmission('A', 'local-A', 'op-A', 'tmp:A');
    store.capture('A', { draft: 'new typing', attachments: [], contextItems: [], fileRefs: [] });
    store.setDraft('B', 'keep B');
    expect(store.rejectSubmission('B', 'local-A', 'op-A', 'tmp:A')).toBe(false);
    expect(store.rejectSubmission('A', 'local-A', 'op-old', 'tmp:A')).toBe(false);
    expect(store.rejectSubmission('A', 'local-A', 'op-A', 'tmp:A')).toBe(true);
    expect(store.get('A')).toEqual({ draft: 'sent\n\nnew typing', attachments: ['image'], contextItems: ['context'], fileRefs: ['file'] });
    expect(store.get('B').draft).toBe('keep B');
    expect(store.rejectSubmission('A', 'local-A', 'op-A', 'tmp:A')).toBe(false);
  });

  test('accepted, replaced and deleted submissions cannot be rejected by late events', () => {
    const store = createSessionComposerStore();
    store.setDraft('A', 'draft');
    store.rememberSubmission('A', 'local-old', 'op-old', 'tmp:old');
    store.rememberSubmission('A', 'local-new', 'op-new', 'tmp:new');
    expect(store.rejectSubmission('A', 'local-old', 'op-old', 'tmp:old')).toBe(false);
    store.acceptSubmission('A', 'local-new', 'op-new');
    expect(store.rejectSubmission('A', 'local-new', 'op-new', 'tmp:new')).toBe(false);
    store.rememberSubmission('A', 'local-new', 'op-new', 'tmp:new');
    store.deleteSession('A');
    expect(store.rejectSubmission('A', 'local-new', 'op-new', 'tmp:new')).toBe(false);
  });
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
