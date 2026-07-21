import { createSessionSearchInteractionController } from '../features/search/search-interaction-controller';
import { createSessionSearchState } from '../features/search/search-state';

function listenerElement(extra: Record<string, unknown> = {}) {
  const listeners = new Map<string, (event: any) => void>();
  return {
    ...extra,
    listeners,
    addEventListener: (type: string, listener: (event: any) => void) => listeners.set(type, listener),
  };
}

describe('session search interaction controller', () => {
  it('owns the debounce timer and refreshes only the latest query', () => {
    const state = createSessionSearchState();
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    const refreshes: boolean[] = [];
    const input = listenerElement({ value: '', focus: () => undefined });
    const controller = createSessionSearchInteractionController({
      state,
      dom: { elements: () => ({ bar: null, input }), clearHighlights: () => undefined, updateControls: () => undefined },
      refresh: ({ jumpToFirst }) => refreshes.push(jumpToFirst),
      navigate: () => undefined,
      runSmart: () => undefined,
      requestAnimationFrame: (callback) => callback(),
      setTimeout: (callback) => { const id = ++nextTimer; timers.set(id, callback); return id; },
      clearTimeout: (handle) => { timers.delete(handle as number); },
    });
    controller.install({ input: input as any });
    (input as any).value = 'first';
    input.listeners.get('input')?.({});
    (input as any).value = 'second';
    input.listeners.get('input')?.({});
    expect(timers.size).toBe(1);
    Array.from(timers.values())[0]();
    expect(state.query).toBe('second');
    expect(refreshes).toEqual([false]);
  });

  it('routes keyboard and button actions without owning navigation or Smart Search', () => {
    const state = createSessionSearchState();
    const actions: string[] = [];
    const input = listenerElement({ value: 'q', focus: () => actions.push('focus') });
    const smart = listenerElement();
    const next = listenerElement();
    const controller = createSessionSearchInteractionController({
      state,
      dom: { elements: () => ({ bar: null, input }), clearHighlights: () => undefined, updateControls: () => undefined },
      refresh: () => undefined,
      navigate: (delta) => actions.push(`navigate:${delta}`),
      runSmart: () => actions.push('smart'),
      requestAnimationFrame: (callback) => callback(),
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    });
    controller.install({ input: input as any, smart, next });
    input.listeners.get('keydown')?.({ key: 'Enter', shiftKey: true, ctrlKey: false, metaKey: false, preventDefault: () => undefined });
    smart.listeners.get('click')?.({});
    next.listeners.get('click')?.({});
    expect(actions).toEqual(['navigate:-1', 'smart', 'focus', 'navigate:1', 'focus']);
  });
});
