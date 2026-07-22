import fs from 'fs';
import path from 'path';
import vm from 'vm';

const root = path.resolve(__dirname, '../..');

describe('webview feature facade', () => {
  it('builds an isolated frozen facade for non-rendering feature modules', () => {
    const bundle = fs.readFileSync(path.join(root, 'media', 'features.bundle.js'), 'utf8');
    const windowObject: Record<string, unknown> = {};
    vm.runInNewContext(bundle, { window: windowObject, URLSearchParams, Map, Set, Object, Array, Number, String, Boolean, Math, Date });
    const facade = windowObject.__ocFeatures as Record<string, unknown>;
    expect(Object.isFrozen(facade)).toBe(true);
    expect(facade.version).toBe(1);
    expect(typeof facade.createModelState).toBe('function');
    expect(typeof facade.createAttachmentState).toBe('function');
    expect(typeof facade.createHeaderState).toBe('function');
    expect(typeof facade.planChangeListMaterialization).toBe('function');
    expect(windowObject.__ocRendering).toBeUndefined();
  });
});
