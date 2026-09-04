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
    expect(source).toContain('modelStateController = factory({ recentModelIds });');
    expect(source).toContain('const modelSelection = modelUiController.setCatalog(');
    expect(source).toContain("case 'models': {");
    expect(source).toContain('const selection = modelUiController.setCatalog(');
    expect(source).toContain('const selection = modelUiController.selectModel(e.target.value);');
    expect(source).toContain('modelUiController.setQuota(message.quota || null);');
    expect(source).toContain('modelUiController.updateSendQuotaVisual();');
  });

  it('keeps provider and speed rules in the bundled feature module', () => {
    expect(source).not.toContain('function isFreeModel(model) {');
    expect(source).toContain('window.__ocFeatures?.isCopilotProvider?.(providerId)');
    expect(source).not.toContain('function parseSpeedMultiplier(value) {');
  });

  it('delegates model, variant, and quota DOM ownership to the feature controller', () => {
    expect(source).toContain('const modelUiController = createModelUiController({');
    expect(source).toContain('modelUiController.renderModelSelect();');
    expect(source).toContain('modelUiController.updateVariantOptions(notifyCurrentVariant);');
    expect(source).toContain('modelUiController.showQuotaTooltip();');
    expect(source).toContain("vscode.postMessage({ type: 'refreshModelQuota' });");
  });

  it('provides recent model navigation and cross-provider search', () => {
    const controllerSource = fs.readFileSync(
      path.join(process.cwd(), 'webview-src', 'features', 'models', 'model-controller.ts'),
      'utf8',
    );
    expect(controllerSource).toContain("searchInput.placeholder = 'Search models'");
    expect(controllerSource).toContain("recentHeader.textContent = 'Recent'");
    expect(controllerSource).toContain('model.name || \'\'} ${model.fullId} ${model.providerId || \'\'}');
    expect(controllerSource).toContain('state.getRecentModels()');
    expect(controllerSource).toContain("list?.classList.remove('is-collapsed')");
    expect(controllerSource).toContain('collapsedProviders.has(provider)');
    expect(controllerSource).toContain(".replace(/[^a-z0-9]+/g, ' ')");
    expect(fs.readFileSync(path.join(process.cwd(), 'media', 'main.css'), 'utf8')).toContain('.model-option[hidden]');
  });

  it('refreshes the visible quota tooltip when hover results arrive for send or stop', () => {
    const quotaStart = source.indexOf("case 'modelQuota': {");
    const quotaEnd = source.indexOf("case 'init': {", quotaStart);
    const quotaHandler = source.slice(quotaStart, quotaEnd);
    expect(quotaHandler).toContain("sendBtn?.matches?.(':hover')");
    expect(quotaHandler).toContain('showQuotaTooltip();');

    const controllerSource = fs.readFileSync(
      path.join(process.cwd(), 'webview-src', 'features', 'models', 'model-controller.ts'),
      'utf8',
    );
    const tooltipStart = controllerSource.indexOf('const showQuotaTooltip = () => {');
    const tooltipEnd = controllerSource.indexOf('const hideQuotaTooltip', tooltipStart);
    expect(controllerSource.slice(tooltipStart, tooltipEnd)).not.toContain('if (isBusy()) return;');
  });

  it('redraws quota after the session lifecycle is fully finalized', () => {
    const phaseStart = source.indexOf("case 'turnFinalizePhase': {");
    const phaseEnd = source.indexOf("case 'chatDone': {", phaseStart);
    const finalizePhase = source.slice(phaseStart, phaseEnd);
    const completeEffects = finalizePhase.indexOf('turnLifecycleController.completeEffects(session);');
    const refreshButton = finalizePhase.indexOf('refreshSendButtonState();');
    expect(phaseStart).toBeGreaterThanOrEqual(0);
    expect(completeEffects).toBeGreaterThanOrEqual(0);
    expect(refreshButton).toBeGreaterThan(completeEffects);
  });
});
