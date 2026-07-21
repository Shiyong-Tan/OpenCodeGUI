import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

describe('session search production state ownership', () => {
  it('creates search state through the feature facade without a parallel object literal', () => {
    expect(source).toContain('const createSessionSearchState = window.__ocFeatures?.createSessionSearchState;');
    expect(source).toContain('let sessionSearch = createSessionSearchState();');
    expect(source).not.toContain('let sessionSearch = {');
  });

  it('delegates mounted DOM highlighting and control presentation to one controller', () => {
    expect(source).toContain('const sessionSearchDomController = createSessionSearchDomController({');
    expect(source).toContain('sessionSearchDomController.clearHighlights();');
    expect(source).toContain('sessionSearchDomController.updateControls();');
    expect(source).toContain('sessionSearchDomController.updateActiveHit({ scroll });');
    expect(source).toContain('sessionSearchDomController.syncActiveTextHit(options);');
    expect(source).not.toContain("document.querySelectorAll('mark.session-search-hit')");
  });

  it('delegates search listeners and debounce lifecycle to the interaction controller', () => {
    expect(source).toContain('const sessionSearchInteractionController = createSessionSearchInteractionController({');
    expect(source).toContain('sessionSearchInteractionController.install({');
    expect(source).not.toContain('let sessionSearchDebounceTimer');
    expect(source).not.toContain("searchInput?.addEventListener('keydown'");
  });
});
