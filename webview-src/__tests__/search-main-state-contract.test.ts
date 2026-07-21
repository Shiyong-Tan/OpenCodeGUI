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

  it('delegates highlight refresh, global navigation, and Smart result mounting', () => {
    expect(source).toContain('sessionSearchDomController.refreshTextHighlights({ jumpToFirst });');
    expect(source).toContain('sessionSearchDomController.navigate(delta);');
    expect(source).toContain('sessionSearchDomController.applySmartResults(messageIds, { scroll });');
  });

  it('delegates timeline and Smart candidate projection to the corpus module', () => {
    expect(source).toContain('window.__ocFeatures.collectLoadedTextSearchKeys({');
    expect(source).toContain('window.__ocFeatures.collectSmartSearchMessages({');
    expect(source).toContain('window.__ocFeatures.visitLoadedChatSearchChunks(');
    expect(source).toContain("getAppendItems: (message) => typeof getAppendItems === 'function' ? getAppendItems(message) : []");
  });
});
