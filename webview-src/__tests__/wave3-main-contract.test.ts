import fs from 'fs';
import path from 'path';
import vm from 'vm';

const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

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

function executeFunctions(markers: string[], context: Record<string, unknown>) {
  const sandbox = vm.createContext({ ...context });
  const exports = markers.map((marker) => marker.match(/function\s+([^\s(]+)/)?.[1]).filter(Boolean);
  vm.runInContext(`${markers.map(extractFunction).join('\n')}\nObject.assign(globalThis, { ${exports.join(', ')} });`, sandbox);
  return sandbox as Record<string, any>;
}

describe('Wave 3 main-script window contract', () => {
  test('defaults on only with a compatible facade and false is the exact Wave 2 path', () => {
    expect(source).toContain('const TANSTACK_CHAT_WINDOW_ENABLED = window.__ocTanStackChatWindowEnabled !== false;');
    expect(source).toContain("typeof window.__ocRendering?.createTanStackVirtualAdapter === 'function'");
    const coordinator = extractFunction('function renderFromState()');
    expect(coordinator).toContain('applyChatWindowOrWave2(session, units);');
    const route = extractFunction('function applyChatWindowOrWave2(');
    expect(route).toContain('if (!isChatWindowAvailable())');
    expect(route).toContain('applyKeyedChatReconciliation(session, units);');
    expect(route).toContain('applyWindowedKeyedChatReconciliation(session, units);');
    expect(coordinator).not.toContain('renderFromStateLegacy();\n                return;\n            } catch');
  });

  test('owns bounded structural spacers and adapter measurement without canonical contamination', () => {
    expect(source).toContain('const CHAT_WINDOW_INITIAL_TAIL = 80;');
    expect(source).toContain('const CHAT_WINDOW_OVERSCAN = 20;');
    expect(source).toContain('const CHAT_WINDOW_MOUNT_LIMIT = 140;');
    expect(source).toContain('const CHAT_WINDOW_DIRECT_CHILD_LIMIT = 146;');
    expect(source).toContain("classifyChatStructuralSurface(topSpacer, 'window:top-spacer'");
    expect(source).toContain("classifyChatStructuralSurface(bottomSpacer, 'window:bottom-spacer'");
    expect(source).toContain('adapter.observeElement(unit.key, root);');
    expect(source).toContain('chatWindowState.adapter?.invalidateMeasurement?.(targetId);');
    expect(source).toContain('chatWindowState.adapter.setPresentationRevision(targetId');
    expect(source).toContain('const sameMountedRange = snapshot.items.length === chatWindowState.mountedKeys.size');
    expect(source).toContain('window.__ocChatWindowDescendantAcceptanceBlocker');
    expect(source).toContain("console.warn('[Render] chat window descendant acceptance blocker', budget.descendants, 4000);");
    expect(source).not.toContain('session.virtual');
    expect(source).not.toContain('session.measurement');
  });

  test('destroys on session switch, migrates aliases, preserves keyed anchors, and searches loaded state', () => {
    expect(source).toContain('destroyChatWindowAdapter(\'session-switch\')');
    expect(source).toContain('chatWindowState.adapter?.migrateKey?.(oldKey, newKey);');
    expect(source).toContain('chatWindowState.anchorKey === oldKey');
    expect(source).toContain('sessionSearch.windowTargetKey === oldKey');
    expect(source).toContain('rendering.restoreKeyedScrollAnchor');
    expect(extractFunction('function collectSmartSearchMessages()')).toContain('session.timeline');
    expect(source).toContain('ensureChatWindowKeyMounted(targetKey, \'search\')');
  });

  test('programmatic correction is not user scroll and pinned/unpinned behavior is explicit', () => {
    expect(source).toContain('if (!chatWindowState.programmaticScroll)');
    expect(source).toContain('chatWindowState.activityBelow = true;');
    expect(source).toContain("scheduleRenderFromState('window-range-change')");
    expect(source).toContain('scrollToBottom(true);');
  });
});

describe('Wave 3 extracted runtime coordinator', () => {
  function coordinatorHarness(options: { available: boolean; windowError?: Error }) {
    const calls: string[] = [];
    const context = executeFunctions(['function applyChatWindowOrWave2('], {
      activeSessionId: 'session-a',
      isChatWindowAvailable: () => options.available,
      applyWindowedKeyedChatReconciliation: () => {
        calls.push('window');
        if (options.windowError) throw options.windowError;
      },
      disableChatWindowForSession: (reason: string, error: Error) => calls.push(`disable:${reason}:${error.message}`),
      applyKeyedChatReconciliation: () => calls.push('wave2'),
    });
    return { calls, route: context.applyChatWindowOrWave2({}, [{ key: 'a' }]) };
  }

  test('flag/facade unavailable executes exact Wave 2 keyed route', () => {
    expect(coordinatorHarness({ available: false })).toEqual({ calls: ['wave2'], route: 'wave2-disabled' });
  });

  test('adapter error disables the session, cleans up, and executes Wave 2 exactly once', () => {
    expect(coordinatorHarness({ available: true, windowError: new Error('adapter failed') })).toEqual({
      calls: ['window', 'disable:adapter-fail-closed:adapter failed', 'wave2'], route: 'wave2-fail-closed',
    });
  });

  test('4001 descendants blocks Wave 3 while 4000 stays accepted', () => {
    const warnings: unknown[][] = [];
    const windowObject: Record<string, unknown> = {};
    const calls: string[] = [];
    let descendants = 4000;
    const context = executeFunctions([
      'function destroyChatWindowAdapter(', 'function disableChatWindowForSession(',
      'function assertChatWindowDomBudget(', 'function applyChatWindowOrWave2(',
    ], {
      CHAT_WINDOW_MOUNT_LIMIT: 140,
      CHAT_WINDOW_DIRECT_CHILD_LIMIT: 146,
      activeSessionId: 'session-a',
      window: windowObject,
      console: { warn: (...args: unknown[]) => warnings.push(args) },
      Error,
      chatWindowGeneration: 1,
      chatWindowState: {
        adapter: { destroy: () => calls.push('destroy') }, snapshot: {}, mountedKeys: new Set(), sessionId: 'session-a',
        pendingRangeRender: false, topSpacer: { remove: () => calls.push('top') },
        bottomSpacer: { remove: () => calls.push('bottom') }, failedSessionId: '',
      },
      chatContainer: { classList: { remove: () => calls.push('class') } },
      vscode: { postMessage: () => calls.push('diagnostic') },
      isChatWindowAvailable: () => true,
      applyWindowedKeyedChatReconciliation: () => {
        calls.push('window');
        (context as any).assertChatWindowDomBudget({ mountedUnits: 80, directChildren: 82, descendants });
      },
      applyKeyedChatReconciliation: () => calls.push('wave2'),
      Set,
    });
    expect(() => context.assertChatWindowDomBudget({ mountedUnits: 141, directChildren: 143, descendants: 100 }))
      .toThrow(/mounted unit cap exceeded/i);
    expect(() => context.assertChatWindowDomBudget({ mountedUnits: 140, directChildren: 147, descendants: 100 }))
      .toThrow(/direct chat child cap exceeded/i);
    expect(context.applyChatWindowOrWave2({}, [])).toBe('window');
    expect(calls).toEqual(['window']);
    descendants = 4001;
    expect(context.applyChatWindowOrWave2({}, [])).toBe('wave2-fail-closed');
    expect(windowObject.__ocChatWindowDescendantAcceptanceBlocker).toEqual({ sessionId: 'session-a', descendants: 4001 });
    expect(warnings).toHaveLength(1);
    expect(calls).toEqual(['window', 'window', 'destroy', 'top', 'bottom', 'class', 'diagnostic', 'diagnostic', 'wave2']);
    expect((context as any).chatWindowState.failedSessionId).toBe('session-a');
  });

  test('spacers retain top/keyed/bottom ordering and expected offsets', () => {
    const operations: string[] = [];
    const keyedRoot = { id: 'keyed' };
    const top = { id: 'top', style: {} };
    const bottom = { id: 'bottom', style: {} };
    const context = executeFunctions(['function updateChatWindowSpacers('], {
      ensureChatWindowSpacers: () => operations.push('ensure'),
      chatWindowState: { topSpacer: top, bottomSpacer: bottom },
      keyedRoots: () => [keyedRoot],
      chatContainer: {
        insertBefore: (node: any, before: any) => operations.push(`insert:${node.id}:${before.id}`),
        appendChild: (node: any) => operations.push(`append:${node.id}`),
      },
      Math,
    });
    context.updateChatWindowSpacers({ items: [{ start: 120, end: 200 }], totalSize: 500 });
    expect(top.style).toEqual({ height: '120px' });
    expect(bottom.style).toEqual({ height: '300px' });
    expect(operations).toEqual(['ensure', 'insert:top:keyed', 'append:bottom']);
  });

  test('destroy and search mount execute adapter lifecycle without stale ownership', () => {
    const calls: string[] = [];
    const classList = { remove: (name: string) => calls.push(`class:${name}`) };
    const context = executeFunctions(['function destroyChatWindowAdapter(', 'function mountChatWindowSearchKey('], {
      chatWindowGeneration: 4,
      chatWindowState: {
        adapter: { destroy: () => calls.push('destroy'), scrollToKey: () => true }, snapshot: {}, mountedKeys: new Set(['a']),
        sessionId: 'old', pendingRangeRender: true, topSpacer: { remove: () => calls.push('top') },
        bottomSpacer: { remove: () => calls.push('bottom') }, activityBelow: false,
      },
      chatContainer: { classList },
      vscode: { postMessage: () => undefined },
      isChatWindowAvailable: () => true,
      sessionSearch: { windowTargetKey: '' },
      autoScrollPinnedToBottom: false,
      scheduleRenderFromState: (reason: string) => calls.push(reason),
      Set,
    });
    expect(context.mountChatWindowSearchKey('old-key', 'search')).toBe(true);
    expect(calls).toContain('window-search');
    context.destroyChatWindowAdapter('session-switch');
    expect(calls).toEqual(expect.arrayContaining(['destroy', 'top', 'bottom', 'class:chat-window-active']));
  });
});
