import fs from 'fs';
import path from 'path';
import vm from 'vm';

const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
const css = fs.readFileSync(path.join(process.cwd(), 'media', 'main.css'), 'utf8');

function extractFunction(marker: string): string {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unclosed function ${marker}`);
}

describe('Wave 4 main-script local older contract', () => {
  test('owns one accessible structural root, a persistent button fallback, and optional observer', () => {
    expect(source).toContain('const CHAT_LOCAL_OLDER_BATCH = 40;');
    expect(source).toContain("classifyChatStructuralSurface(surface, 'window:local-older'");
    expect(source).toContain("button.textContent = 'Load older';");
    expect(source).toContain("button.setAttribute('aria-label', 'Load older messages');");
    expect(source).toContain("typeof IntersectionObserver === 'function'");
    expect(source).toContain("button.addEventListener('click'");
    expect(css).toContain('.chat-local-older-surface');
  });

  test('uses presentation-only local units while retaining complete search corpus', () => {
    expect(source).toContain('chatWindowState.allUnits = units;');
    expect(source).toContain('const localWindow = resolveChatLocalHistoryWindow(units);');
    expect(source).toContain('ensureChatWindowAdapter(session, localWindow.visibleUnits)');
    expect(source).toContain('chatLocalHistoryController.revealToKey');
    expect(source).toContain('return chatWindowState.allUnits.map((unit) =>');
  });

  test('captures anchor before reveal, cleans controls on fallback, and preserves accepted caps', () => {
    expect(extractFunction('function activateChatLocalOlder(')).toMatch(/captureChatWindowAnchor\(\);\s+const result = chatLocalHistoryController\.activate/);
    expect(source).toContain('destroyChatLocalOlderSurface();');
    expect(source).toContain('const CHAT_WINDOW_MOUNT_LIMIT = 140;');
    expect(source).toContain('const CHAT_WINDOW_DIRECT_CHILD_LIMIT = 146;');
    expect(source).toContain('const CHAT_STRUCTURAL_SURFACE_LIMIT = 6;');
    expect(source).toContain('if (budget.descendants > 4000)');
    expect(source).toContain('chatLocalHistoryController.complete(reconcileSessionId);');
  });

  test('executable control keeps button without observer and renders terminal states without action', () => {
    const inserted: any[] = [];
    const makeElement = () => ({
      dataset: {}, children: [] as any[], attributes: {} as Record<string, string>,
      replaceChildren() { this.children = []; },
      appendChild(child: any) { this.children.push(child); },
      setAttribute(name: string, value: string) { this.attributes[name] = value; },
      addEventListener(name: string, callback: () => void) { (this as any)[`on${name}`] = callback; },
    });
    const context = vm.createContext({
      chatWindowState: { localOlderSurface: null, localOlderObserver: null, topSpacer: { id: 'top' } },
      document: { createElement: makeElement },
      classifyChatStructuralSurface: (element: any, key: string) => { element.structuralKey = key; return element; },
      chatContainer: { insertBefore: (surface: any) => inserted.push(surface) },
      keyedRoots: () => [], activateChatLocalOlder: () => true,
    });
    vm.runInContext(`${extractFunction('function renderChatLocalOlderSurface(')}; globalThis.render = renderChatLocalOlderSurface;`, context);
    const available = { state: 'localOlderAvailable', label: 'Load older', hint: '', actionable: true };
    (context as any).render(available);
    const surface = inserted.at(-1);
    expect(surface.structuralKey).toBe('window:local-older');
    expect(surface.children).toHaveLength(1);
    expect(surface.children[0]).toMatchObject({ textContent: 'Load older', attributes: { 'aria-label': 'Load older messages' } });
    expect(typeof surface.children[0].onclick).toBe('function');

    (context as any).render({ state: 'localStartReached', label: 'Start of loaded history', hint: '', actionable: false });
    expect(surface.children).toHaveLength(1);
    expect(surface.children[0]).toMatchObject({ textContent: 'Start of loaded history', attributes: { role: 'status' } });
    (context as any).render({
      state: 'remoteOlderUnknown', label: 'No more loaded messages', actionable: false,
      hint: 'Earlier server history is unknown or unavailable until cursor support is available.',
    });
    expect(surface.children.map((child: any) => child.textContent)).toEqual([
      'No more loaded messages', 'Earlier server history is unknown or unavailable until cursor support is available.',
    ]);
    expect(surface.children.some((child: any) => child.textContent === 'Load older')).toBe(false);
  });

  test('executable next/previous search keeps full loaded ordering and jumps unrevealed keys once', () => {
    const jumps: string[] = [];
    const context = vm.createContext({
      sessionSearch: {
        mode: 'text', fullMatchKeys: ['old-unrevealed', 'middle-unrevealed', 'recent'],
        activeKeyIndex: -1, windowTargetKey: '', matches: [], activeIndex: -1,
      },
      ensureChatWindowKeyMounted: (key: string) => { jumps.push(key); return true; },
      updateActiveSessionSearchHit: () => undefined,
    });
    vm.runInContext(`${extractFunction('function goToSessionSearchMatch(')}; globalThis.go = goToSessionSearchMatch;`, context);
    (context as any).go(1);
    (context as any).go(1);
    (context as any).go(-1);
    expect(jumps).toEqual(['old-unrevealed', 'middle-unrevealed', 'old-unrevealed']);
    expect((context as any).sessionSearch.fullMatchKeys).toEqual(['old-unrevealed', 'middle-unrevealed', 'recent']);
  });

  test('observer requires false-to-true re-entry and static intersecting callbacks reveal one batch', () => {
    let observerCallback: ((entries: Array<{ isIntersecting: boolean }>) => void) | undefined;
    let activations = 0;
    class FakeIntersectionObserver {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) { observerCallback = callback; }
      observe() { /* executable observer seam */ }
      disconnect() { /* executable observer seam */ }
    }
    const makeElement = () => ({
      dataset: {}, children: [] as any[], attributes: {} as Record<string, string>,
      replaceChildren() { this.children = []; }, appendChild(child: any) { this.children.push(child); },
      setAttribute(name: string, value: string) { this.attributes[name] = value; },
      addEventListener(name: string, callback: () => void) { (this as any)[`on${name}`] = callback; },
    });
    const context = vm.createContext({
      IntersectionObserver: FakeIntersectionObserver,
      chatWindowState: {
        localOlderSurface: null, localOlderObserver: null, localOlderObserverArmed: true, topSpacer: {},
      },
      document: { createElement: makeElement }, classifyChatStructuralSurface: (element: any) => element,
      chatContainer: { insertBefore: () => undefined }, keyedRoots: () => [],
      activateChatLocalOlder: () => { activations += 1; return true; },
    });
    vm.runInContext(`${extractFunction('function renderChatLocalOlderSurface(')}; globalThis.render = renderChatLocalOlderSurface;`, context);
    const available = { state: 'localOlderAvailable', label: 'Load older', hint: '', actionable: true };
    (context as any).render(available);
    observerCallback?.([{ isIntersecting: true }]);
    (context as any).render(available);
    observerCallback?.([{ isIntersecting: true }]);
    observerCallback?.([{ isIntersecting: true }]);
    expect(activations).toBe(1);
    observerCallback?.([{ isIntersecting: false }]);
    observerCallback?.([{ isIntersecting: true }]);
    expect(activations).toBe(2);
  });

  test('windowed reconcile completes local activation even when adapter creation fails', () => {
    const completions: string[] = [];
    const makeContext = (failAfterCreate: boolean) => vm.createContext({
      activeSessionId: 'session-a', autoScrollPinnedToBottom: false, Map, Set, Object,
      chatWindowState: { rendering: false, pendingRangeRender: false, allUnits: [], pendingScrollKey: '', mountedKeys: new Set() },
      captureChatWindowAnchor: () => undefined,
      resolveChatLocalHistoryWindow: () => ({ visibleUnits: [], presentation: {} }),
      ensureChatWindowAdapter: () => failAfterCreate
        ? ({ getRange: () => ({ items: [], totalSize: 0 }) })
        : (() => { throw new Error('adapter-create'); })(),
      applyKeyedChatReconciliation: () => { throw new Error('post-create-reconcile'); },
      chatLocalHistoryController: { complete: (sessionId: string) => completions.push(sessionId) },
    });
    const beforeCreate = makeContext(false);
    vm.runInContext(`${extractFunction('function applyWindowedKeyedChatReconciliation(')}; globalThis.apply = applyWindowedKeyedChatReconciliation;`, beforeCreate);
    expect(() => (beforeCreate as any).apply({}, [])).toThrow('adapter-create');
    expect((beforeCreate as any).chatWindowState.rendering).toBe(false);
    const afterCreate = makeContext(true);
    vm.runInContext(`${extractFunction('function applyWindowedKeyedChatReconciliation(')}; globalThis.apply = applyWindowedKeyedChatReconciliation;`, afterCreate);
    expect(() => (afterCreate as any).apply({}, [])).toThrow('post-create-reconcile');
    expect(completions).toEqual(['session-a', 'session-a']);
    expect((afterCreate as any).chatWindowState.rendering).toBe(false);
  });

  test('pending search key survives two misses, clears on success, and has a bounded terminal path', () => {
    const diagnostics: unknown[] = [];
    let calls = 0;
    const context = vm.createContext({
      CHAT_PENDING_SCROLL_MAX_ATTEMPTS: 4,
      chatWindowState: {
        pendingScrollKey: 'old-key', pendingScrollAttempts: 0,
        allUnits: [{ key: 'old-key' }],
        adapter: { scrollToKey: () => { calls += 1; return calls >= 3; } },
      },
      keyedRootForKey: () => null,
      vscode: { postMessage: (message: unknown) => diagnostics.push(message) },
    });
    vm.runInContext(`${extractFunction('function clearPendingChatWindowScroll(')}\n${extractFunction('function tryPendingChatWindowScroll(')}; Object.assign(globalThis, { tryPendingChatWindowScroll });`, context);
    expect((context as any).tryPendingChatWindowScroll('first')).toBe(false);
    expect((context as any).chatWindowState.pendingScrollKey).toBe('old-key');
    expect((context as any).tryPendingChatWindowScroll('second')).toBe(false);
    expect((context as any).chatWindowState.pendingScrollKey).toBe('old-key');
    expect((context as any).tryPendingChatWindowScroll('third')).toBe(true);
    expect((context as any).chatWindowState.pendingScrollKey).toBe('');
    expect((context as any).chatWindowState.pendingScrollAttempts).toBe(0);
    expect(diagnostics.some((message: any) => message.payload?.[0] === '[WV][CHAT_WINDOW_SEARCH_PENDING_CLEAR]')).toBe(true);

    (context as any).chatWindowState.pendingScrollKey = 'old-key';
    (context as any).chatWindowState.adapter.scrollToKey = () => false;
    for (let attempt = 0; attempt < 4; attempt += 1) (context as any).tryPendingChatWindowScroll(`terminal-${attempt}`);
    expect((context as any).chatWindowState.pendingScrollKey).toBe('');
    expect(diagnostics.some((message: any) => message.payload?.[0] === '[WV][CHAT_WINDOW_SEARCH_PENDING_TERMINAL]')).toBe(true);
  });
});
