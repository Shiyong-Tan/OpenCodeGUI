import { createSessionSearchState } from '../features/search/search-state';

describe('session search state', () => {
  it('navigates the complete text result set independently of mounted DOM hits', () => {
    const state = createSessionSearchState();
    state.openSearch();
    state.setTextQuery('needle');
    state.setTextMatchKeys(['m1', 'm2', 'm3'], true);

    expect(state.snapshot()).toMatchObject({ open: true, activeKeyIndex: 0, fullMatchKeys: ['m1', 'm2', 'm3'] });
    expect(state.navigate(1)).toEqual({ mode: 'text', index: 1, total: 3, targetKey: 'm2' });
    expect(state.navigate(1)).toEqual({ mode: 'text', index: 2, total: 3, targetKey: 'm3' });
    expect(state.navigate(1)).toEqual({ mode: 'text', index: 0, total: 3, targetKey: 'm1' });
  });

  it('correlates Smart Search completion and ignores stale requests', () => {
    const state = createSessionSearchState();
    state.setTextQuery('semantic description');
    expect(state.beginSmartSearch('req-2')).toBe(true);
    expect(state.completeSmartSearch('req-1', ['wrong'])).toBe(false);
    expect(state.snapshot()).toMatchObject({ smartInFlight: true, smartMessageIds: [] });

    expect(state.completeSmartSearch('req-2', ['m2', 'm2', '', 'm3'])).toBe(true);
    expect(state.snapshot()).toMatchObject({
      mode: 'smart', smartInFlight: false, smartMessageIds: ['m2', 'm3'], activeIndex: 0, windowTargetKey: 'm2',
    });
    expect(state.navigate(1)).toEqual({ mode: 'smart', index: 1, total: 2, targetKey: 'm3' });
  });

  it('rekeys both result sets and the virtualization target without changing order', () => {
    const state = createSessionSearchState();
    state.setTextQuery('q');
    state.setTextMatchKeys(['old', 'keep'], true);
    state.setWindowTargetKey('old');
    state.rekey('old', 'new');
    expect(state.snapshot()).toMatchObject({ fullMatchKeys: ['new', 'keep'], windowTargetKey: 'new' });
  });

  it('closes to the same clean state used by a new search', () => {
    const state = createSessionSearchState();
    state.openSearch();
    state.setTextQuery('q');
    state.beginSmartSearch('req');
    state.closeSearch();
    expect(state.snapshot()).toEqual({
      open: false,
      query: '',
      mode: 'text',
      activeIndex: -1,
      smartMessageIds: [],
      smartRequestId: '',
      smartInFlight: false,
      fullMatchKeys: [],
      activeKeyIndex: -1,
      windowTargetKey: '',
    });
  });
});
