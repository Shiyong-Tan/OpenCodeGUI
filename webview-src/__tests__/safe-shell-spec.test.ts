import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const root = path.resolve(__dirname, '../..');

const MODES = ['normal-rich', 'safe-shell'] as const;
const FAMILIES = [
  'message-user',
  'message-assistant',
  'message-tool-meta',
  'message-subagent',
  'change-list',
  'segment',
  'conflict',
  'message-image',
  'message-code',
  'message-diff',
  'message-table',
  'message-markdown',
] as const;

const BUDGETS = {
  'message-user': [40, 48, 5],
  'message-assistant': [40, 48, 5],
  'message-tool-meta': [44, 52, 5],
  'message-subagent': [48, 64, 5],
  'change-list': [56, 72, 5],
  segment: [56, 72, 5],
  conflict: [64, 80, 5],
  'message-image': [32, 40, 5],
  'message-code': [40, 52, 5],
  'message-diff': [40, 52, 5],
  'message-table': [56, 88, 5],
  'message-markdown': [40, 52, 5],
} as const;

type SpecModule = {
  getSafeShellSpec(input: unknown): any;
};

const loadSpec = (): SpecModule => require('../rendering/safe-shell-spec') as SpecModule;

describe('A1S.0 pure safe-shell specification', () => {
  test('RED-1 exposes exactly two modes, the closed family set, and fixed proof budgets', () => {
    const { getSafeShellSpec } = loadSpec();

    for (const mode of MODES) {
      for (const family of FAMILIES) {
        const result = getSafeShellSpec({ mode, family, shape: {} });
        expect(result).toMatchObject({ allowed: true, mode, family });
        expect(result.budgets).toEqual({
          collapsedDescendants: BUDGETS[family][0],
          openDescendants: BUDGETS[family][1],
          rootDirectChildren: BUDGETS[family][2],
        });
      }
    }

    expect(getSafeShellSpec({ mode: 'safe-shell', family: 'unknown-family' })).toEqual({
      allowed: false,
      reason: 'unknown-family',
    });
    expect(getSafeShellSpec({ mode: 'automatic', family: 'message-user' })).toEqual({
      allowed: false,
      reason: 'unknown-mode',
    });
  });

  test('RED-1 returns deterministic deeply immutable labels, actions, and descriptors', () => {
    const { getSafeShellSpec } = loadSpec();
    const input = {
      mode: 'safe-shell',
      family: 'conflict',
      page: 2,
      contentPage: 3,
      shape: { itemCount: 1_000_000, lineCount: 1_000_000, codeUnitCount: 8 * 1024 * 1024 },
    };
    const first = getSafeShellSpec(input);
    const second = getSafeShellSpec(input);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).not.toBe(second);
    expect(first.actions).toEqual([
      'open-full', 'previous', 'next', 'close', 'copy-full', 'open-diff', 'skip', 'override',
    ]);
    expect(first.labels).toMatchObject({ title: 'Conflict', page: expect.any(String) });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.budgets)).toBe(true);
    expect(Object.isFrozen(first.actions)).toBe(true);
    expect(Object.isFrozen(first.page)).toBe(true);
    expect(() => first.actions.push('invented-action')).toThrow();
  });

  test.each([
    ['message-subagent', 'itemCount', 6],
    ['change-list', 'itemCount', 8],
    ['segment', 'itemCount', 6],
    ['conflict', 'itemCount', 6],
    ['message-image', 'imageCount', 1],
    ['message-code', 'blockCount', 1],
  ])('RED-2 keeps %s item paging O(1) and within its exact maximum', (family, key, maximum) => {
    const { getSafeShellSpec } = loadSpec();
    const result = getSafeShellSpec({
      mode: 'safe-shell',
      family,
      page: 1_000_000,
      shape: { [key]: 1_000_000 },
    });

    expect(result.page.primary.limit).toBe(maximum);
    expect(result.page.primary.total).toBe(Math.ceil(1_000_000 / maximum));
    expect(result.page.primary.index).toBe(result.page.primary.total);
    expect(result.page.primary.atCanonicalEnd).toBe(true);
    expect(Object.keys(result.page.primary).length).toBeLessThanOrEqual(10);
    expect(JSON.stringify(result).length).toBeLessThan(4_096);
  });

  test('RED-2 enforces text/code/diff/markdown pages at 8192 UTF-16 code units and 40 logical lines', () => {
    const { getSafeShellSpec } = loadSpec();
    for (const family of [
      'message-user', 'message-assistant', 'message-tool-meta', 'message-subagent',
      'conflict', 'message-code', 'message-diff', 'message-markdown',
    ]) {
      for (const size of [0, 40, 41, 1_000_000]) {
        const result = getSafeShellSpec({
          mode: 'safe-shell',
          family,
          contentPage: 1,
          shape: { lineCount: size, codeUnitCount: size === 0 ? 0 : 8 * 1024 * 1024 },
        });
        expect(result.page.content.maxCodeUnits).toBe(8_192);
        expect(result.page.content.maxLines).toBe(40);
        expect(result.page.content.total).toBe(Math.max(1, Math.ceil(size / 40), size === 0 ? 0 : 1_024));
      }
    }
  });

  test('RED-2 handles table boundaries without materializing a rows-by-cells shape', () => {
    const { getSafeShellSpec } = loadSpec();
    for (const [rows, columns] of [[0, 0], [8, 6], [9, 7], [1_000_000, 1_000_000]]) {
      const result = getSafeShellSpec({
        mode: 'safe-shell',
        family: 'message-table',
        page: 1_000_000,
        columnPage: 1_000_000,
        shape: { rowCount: rows, columnCount: columns },
      });
      expect(result.page.rows.limit).toBe(8);
      expect(result.page.columns.limit).toBe(6);
      expect(result.page.rows.total).toBe(Math.max(1, Math.ceil(rows / 8)));
      expect(result.page.columns.total).toBe(Math.max(1, Math.ceil(columns / 6)));
      expect(JSON.stringify(result).length).toBeLessThan(4_096);
    }
  });

  test('RED-2 normalizes malformed, negative, non-finite, and huge page shapes safely', () => {
    const { getSafeShellSpec } = loadSpec();
    for (const malformed of [
      undefined, null, '', -1, Number.NaN, Number.POSITIVE_INFINITY, {}, [], 10n,
    ]) {
      const result = getSafeShellSpec({
        mode: 'safe-shell',
        family: 'change-list',
        page: malformed,
        shape: { itemCount: malformed },
      });
      expect(result.page.primary).toMatchObject({
        index: 1,
        total: null,
        extentKnown: false,
        atCanonicalEnd: false,
        hasNext: true,
        label: 'page 1 of unknown extent',
      });
    }

    const huge = getSafeShellSpec({
      mode: 'safe-shell',
      family: 'change-list',
      page: Number.MAX_VALUE,
      shape: { itemCount: Number.MAX_VALUE },
    });
    expect(huge.page.primary.canonicalCount).toBe(Number.MAX_SAFE_INTEGER);
    expect(huge.page.primary.index).toBe(huge.page.primary.total);
  });

  test('RED-2 reports truthful known/unknown extent and never completes before canonical end', () => {
    const { getSafeShellSpec } = loadSpec();
    const boundary = getSafeShellSpec({
      mode: 'safe-shell', family: 'change-list', page: 1, shape: { itemCount: 8 },
    }).page.primary;
    const over = getSafeShellSpec({
      mode: 'safe-shell', family: 'change-list', page: 1, shape: { itemCount: 9 },
    }).page.primary;
    const unknown = getSafeShellSpec({
      mode: 'safe-shell', family: 'change-list', page: 999, shape: {},
    }).page.primary;

    expect(boundary).toMatchObject({ label: 'page 1 of 1', hasNext: false, atCanonicalEnd: true });
    expect(over).toMatchObject({ label: 'page 1 of 2', hasNext: true, atCanonicalEnd: false });
    expect(unknown).toMatchObject({
      label: 'page 999 of unknown extent', total: null, hasNext: true, atCanonicalEnd: false,
    });
  });

  test('RED-2 treats JavaScript string lengths as UTF-16 code units at Unicode boundaries', () => {
    const { getSafeShellSpec } = loadSpec();
    const unicodeBoundary = '😀'.repeat(4_096);
    const unicodeOver = `${unicodeBoundary}x`;
    expect(unicodeBoundary.length).toBe(8_192);
    expect(unicodeOver.length).toBe(8_193);

    const atBoundary = getSafeShellSpec({
      mode: 'safe-shell', family: 'message-markdown', shape: { codeUnitCount: unicodeBoundary.length, lineCount: 1 },
    });
    const overBoundary = getSafeShellSpec({
      mode: 'safe-shell', family: 'message-markdown', shape: { codeUnitCount: unicodeOver.length, lineCount: 1 },
    });
    expect(atBoundary.page.content.total).toBe(1);
    expect(overBoundary.page.content.total).toBe(2);
  });

  test('RED-3 adds only one reviewed dormant facade entry point', () => {
    const indexSource = fs.readFileSync(path.join(root, 'webview-src/rendering/index.ts'), 'utf8');
    expect(indexSource).toContain("import { getSafeShellSpec } from './safe-shell-spec';");
    expect(indexSource).toContain('getSafeShellSpec: hiddenCapability(getSafeShellSpec)');
    expect(indexSource).not.toMatch(/safe.?shell.*(?:threshold|telemetry|pressure)/i);

    const bundleSource = fs.readFileSync(path.join(root, 'media/rendering.bundle.js'), 'utf8');
    let calls = 0;
    const context = vm.createContext({
      window: {},
      document: new Proxy({}, { get: () => { throw new Error('DOM access'); } }),
      __safeShellCall: () => { calls += 1; },
    });
    new vm.Script(bundleSource).runInContext(context);
    expect(calls).toBe(0);
    const facade = (context.window as any).__ocRendering;
    expect(facade.getSafeShellSpec).toEqual(expect.any(Function));
    expect(Object.getOwnPropertyDescriptor(facade, 'getSafeShellSpec')).toMatchObject({
      enumerable: false,
      writable: false,
      configurable: false,
    });
    expect(Object.keys(facade)).toEqual([
      'version',
      'deriveRenderUnits',
      'presentationFingerprint',
      'planReconciliation',
      'restoreScrollAnchor',
      'restoreKeyedScrollAnchor',
      'createTanStackVirtualAdapter',
      'createLocalHistoryPresentationController',
      'deriveLocalOlderPresentation',
      'normalizeHydrationCoverage',
      'throwSourceMapTestError',
      'buildChatPressureAttribution',
    ]);
  });
});
