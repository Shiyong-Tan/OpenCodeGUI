import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

describe('session search production state ownership', () => {
  it('creates search state through the feature facade without a parallel object literal', () => {
    expect(source).toContain('const createSessionSearchState = window.__ocFeatures?.createSessionSearchState;');
    expect(source).toContain('let sessionSearch = createSessionSearchState();');
    expect(source).not.toContain('let sessionSearch = {');
  });
});
