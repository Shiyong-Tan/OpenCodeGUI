import { createSessionSearchDomController, deriveSessionSearchControls } from '../features/search/search-dom-controller';
import { createSessionSearchState } from '../features/search/search-state';

function fakeElement() {
  const classes = new Map<string, boolean>();
  return {
    textContent: '', disabled: false,
    classList: { toggle: (name: string, active: boolean) => classes.set(name, active) },
    classes,
  };
}

describe('session search DOM controller', () => {
  it('derives count from the global key set rather than mounted hits', () => {
    const state = createSessionSearchState();
    state.setTextQuery('needle');
    state.setTextMatchKeys(Array.from({ length: 25 }, (_, index) => `m${index}`), true);
    state.navigate(1);
    state.matches = Array.from({ length: 8 });
    expect(deriveSessionSearchControls(state)).toMatchObject({ current: 2, total: 25, countText: '2/25' });
  });

  it('updates controls without making mounted hit count authoritative', () => {
    const state = createSessionSearchState();
    state.setTextQuery('related');
    state.setSmartResults(['m1', 'm2', 'm3']);
    state.matches = [{}];
    const count = fakeElement();
    const smart = fakeElement();
    const prev = fakeElement();
    const next = fakeElement();
    const byId: Record<string, any> = {
      'session-search-count': count,
      'session-search-smart': smart,
      'session-search-prev': prev,
      'session-search-next': next,
    };
    const controller = createSessionSearchDomController({
      document: { getElementById: (id: string) => byId[id] || null } as unknown as Document,
      state,
      onManualScroll: () => undefined,
      collectTextMatchKeys: () => [],
      ensureKeyMounted: () => false,
    });
    controller.updateControls();
    expect(count.textContent).toBe('1/3');
    expect(smart.textContent).toBe('Smart');
    expect(smart.classes.get('is-active')).toBe(true);
    expect(prev.disabled).toBe(false);
    expect(next.disabled).toBe(false);
  });

  it('maps the active global key to its mounted mark and marks scrolling as manual', () => {
    const state = createSessionSearchState();
    state.setTextQuery('needle');
    state.setTextMatchKeys(['message-a'], true);
    let active = false;
    let scrolled = false;
    let manual = false;
    state.matches = [{
      dataset: { searchKey: 'message-a' },
      classList: { toggle: (_name: string, value: boolean) => { active = value; } },
      scrollIntoView: () => { scrolled = true; },
    }];
    const controller = createSessionSearchDomController({
      document: { getElementById: () => null } as unknown as Document,
      state,
      onManualScroll: () => { manual = true; },
      collectTextMatchKeys: () => [],
      ensureKeyMounted: () => false,
    });
    controller.syncActiveTextHit({ scroll: true });
    expect(state.activeIndex).toBe(0);
    expect(active).toBe(true);
    expect(manual).toBe(true);
    expect(scrolled).toBe(true);
  });
});
