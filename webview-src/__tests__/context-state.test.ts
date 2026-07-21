import { createComposerContextState } from '../features/composer/context-state';

describe('composer context state', () => {
  it('owns context and deduplicated file reference mutations', () => {
    const state = createComposerContextState();
    expect(state.addContext('selection', { text: 'selected', source: 'editor' })).toBe(true);
    expect(state.addContext('', { text: 'ignored' })).toBe(false);
    expect(state.addFileRef({ path: 'src/a.ts', name: 'a.ts' })).toBe(true);
    expect(state.addFileRef({ path: 'src/a.ts', name: 'duplicate.ts' })).toBe(false);
    expect(state.hasContext()).toBe(true);
    expect(state.hasFileRefs()).toBe(true);

    const context = state.getContextItems()[0];
    expect(state.removeContext(context)).toBe(true);
    expect(state.removeFileRef('missing')).toBe(false);
    expect(state.removeFileRef('src/a.ts')).toBe(true);
  });

  it('preserves message prefix and extension payload shapes', () => {
    const state = createComposerContextState();
    state.addContext('selection', {
      text: 'selected text', source: 'editor', filePath: 'src/a.ts', range: { start: 1, end: 2 },
    });
    state.addFileRef({ path: 'src/b.ts', name: 'b.ts', directory: 'src' });

    expect(state.getDisplayPrefix()).toBe('selection @src/b.ts');
    expect(state.getContextPayload()).toEqual([{
      displayText: 'selection', text: 'selected text', source: 'editor', filePath: 'src/a.ts', range: { start: 1, end: 2 },
    }]);
    expect(state.getFilesPayload()).toEqual(['src/b.ts']);
    state.clear();
    expect(state.getContextItems()).toEqual([]);
    expect(state.getFileRefs()).toEqual([]);
  });
});
