import { deriveContextTokenPresentation } from '../features/composer/context-controller';
import { createComposerContextState } from '../features/composer/context-state';

describe('composer context token presentation', () => {
  it('shows only the append token while append mode is active', () => {
    const state = createComposerContextState();
    state.addContext('selection', { text: 'selected' });
    state.addFileRef({ path: 'src/a.ts' });
    expect(deriveContextTokenPresentation(state, true)).toEqual([
      { kind: 'append', label: 'Append', title: 'Exit append mode', ariaLabel: 'Exit append mode' },
    ]);
  });

  it('preserves context-before-file ordering and labels', () => {
    const state = createComposerContextState();
    state.addContext('selection', { text: 'selected' });
    state.addFileRef({ path: 'src/a.ts' });
    const tokens = deriveContextTokenPresentation(state, false);
    expect(tokens.map(({ kind, label, title, ariaLabel }) => ({ kind, label, title, ariaLabel }))).toEqual([
      { kind: 'context', label: 'selection', title: 'Remove context', ariaLabel: 'Remove selection' },
      { kind: 'file', label: '@src/a.ts', title: 'Remove file reference', ariaLabel: 'Remove src/a.ts' },
    ]);
  });
});
