import { deriveChangeListPresentation } from '../features/change-list/change-list-renderer';

describe('change-list renderer presentation', () => {
  test('normalizes paths, stats and markdown routing without changing file count', () => {
    const presentation = deriveChangeListPresentation({
      id: 'system:changeList:h1',
      meta: {
        kind: 'changeList',
        files: ['src\\app.ts', 'docs/Guide.MD', null],
        reverted: true,
        commitHead: 'h1',
        commitBase: 'b1',
        statsByPath: { 'src/app.ts': { additions: 123, deletions: 4 } },
      },
    });
    expect(presentation).toMatchObject({ fileCount: 3, reverted: true, deltaColumnWidth: '4ch' });
    expect(presentation?.rows).toEqual([
      expect.objectContaining({ normalizedPath: 'src/app.ts', base: 'app.ts', directory: 'src/', markdown: false, showStats: true }),
      expect.objectContaining({ normalizedPath: 'docs/Guide.MD', base: 'Guide.MD', directory: 'docs/', markdown: true, showStats: false }),
    ]);
  });

  test('rejects non-change-list and empty records', () => {
    expect(deriveChangeListPresentation({ meta: { kind: 'other', files: ['a'] } })).toBeNull();
    expect(deriveChangeListPresentation({ meta: { kind: 'changeList', files: [] } })).toBeNull();
  });
});
