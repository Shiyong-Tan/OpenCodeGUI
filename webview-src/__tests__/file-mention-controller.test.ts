import { findActiveFileMention, normalizeFileRef } from '../features/composer/file-mention-controller';

describe('file mention controller rules', () => {
  it('detects only the active unselected mention immediately before the cursor', () => {
    expect(findActiveFileMention('open @src/fi', 12, 12)).toEqual({ query: 'src/fi', start: 5, end: 12 });
    expect(findActiveFileMention('@', 1, 1)).toEqual({ query: '', start: 0, end: 1 });
    expect(findActiveFileMention('email@example.com', 17, 17)).toBeNull();
    expect(findActiveFileMention('open @src', 5, 9)).toBeNull();
    expect(findActiveFileMention('open @one@two', 13, 13)).toBeNull();
  });

  it('preserves workspace file normalization and fallback names', () => {
    expect(normalizeFileRef({ path: 'src/a.ts', directory: 'src' })).toEqual({
      path: 'src/a.ts', name: 'a.ts', directory: 'src',
    });
    expect(normalizeFileRef({ path: 'README', name: 'Read me' })).toEqual({
      path: 'README', name: 'Read me', directory: '',
    });
    expect(normalizeFileRef({ name: 'missing' })).toBeNull();
  });
});
