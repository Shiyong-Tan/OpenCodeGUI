import { collectBoundedSmartSearchText, createLinearSearchMatcher } from '../features/search/search-text';

describe('search text utilities', () => {
  it('matches case-insensitively across chunk boundaries', () => {
    const matcher = createLinearSearchMatcher('cross boundary');
    matcher.visit('prefix CROSS ');
    matcher.visit('BOUNDARY suffix');
    expect(matcher.matched()).toBe(true);
  });

  it('caps collected text incrementally without visiting later chunks', () => {
    let visits = 0;
    const text = collectBoundedSmartSearchText((visit) => {
      for (const chunk of ['a'.repeat(2195), ' tail', 'not visited']) {
        visits += 1;
        if (visit(chunk) === false) break;
      }
    });
    expect(text).toBe(`${'a'.repeat(2195)} tail`);
    expect(visits).toBe(2);
  });

  it('normalizes whitespace without exceeding the hard cap', () => {
    expect(collectBoundedSmartSearchText((visit) => { visit('  plain\n\tmessage  '); }, 2200, true)).toBe('plain message');
    expect(collectBoundedSmartSearchText((visit) => { visit('x'.repeat(3000)); }, 5000)).toHaveLength(2200);
  });
});
