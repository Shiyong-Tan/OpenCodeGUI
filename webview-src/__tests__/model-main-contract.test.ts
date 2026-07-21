import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

describe('model state production ownership', () => {
  it('does not retain parallel model selection or quota globals in main.js', () => {
    expect(source).not.toMatch(/^let models = \[\]/m);
    expect(source).not.toMatch(/^let selectedModel =/m);
    expect(source).not.toMatch(/^let selectedVariant =/m);
    expect(source).not.toMatch(/^let currentModelQuota =/m);
    expect(source).not.toMatch(/^let freeModelIds =/m);
  });

  it('routes initialization, catalog refresh, selection, and quota through the model state facade', () => {
    expect(source).toContain('modelStateController = factory();');
    expect(source).toContain('const modelSelection = modelState.setCatalog(');
    expect(source).toContain("case 'models': {");
    expect(source).toContain('const selection = modelState.setCatalog(');
    expect(source).toContain('const selection = getModelStateController().selectModel(e.target.value);');
    expect(source).toContain('modelState.setQuota(message.quota || null);');
    expect(source).toContain('const visual = modelState.deriveQuotaVisual(activeBusy);');
  });

  it('keeps provider and speed rules in the bundled feature module', () => {
    expect(source).not.toContain('function isFreeModel(model) {');
    expect(source).toContain('window.__ocRendering?.isCopilotProvider?.(providerId)');
    expect(source).toContain('window.__ocRendering?.parseSpeedMultiplier?.(value)');
  });
});
