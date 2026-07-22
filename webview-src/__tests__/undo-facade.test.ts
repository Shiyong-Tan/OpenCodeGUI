import fs from 'fs';
import path from 'path';
import vm from 'vm';

describe('webview undo facade', () => {
  test('builds a frozen isolated undo facade', () => {
    const bundle = fs.readFileSync(path.join(process.cwd(), 'media', 'undo.bundle.js'), 'utf8');
    const windowObject: Record<string, unknown> = {};
    vm.runInNewContext(bundle, { window: windowObject, Map, Set, Object, Array, Number, String, Boolean, Math, Date });
    const facade = windowObject.__ocUndo as Record<string, unknown>;
    expect(Object.isFrozen(facade)).toBe(true);
    expect(facade.version).toBe(1);
    expect(typeof facade.createSegmentTopology).toBe('function');
    expect(windowObject.__ocFeatures).toBeUndefined();
    expect(windowObject.__ocRendering).toBeUndefined();
  });
});
