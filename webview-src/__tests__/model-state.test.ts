import {
  createModelState,
  isFreeModel,
  normalizeResetText,
  parseSpeedMultiplier,
} from '../features/models/model-state';

describe('webview model state', () => {
  const models = [
    { fullId: 'copilot/free', providerId: 'github-copilot', name: 'Free', speedMultiplier: '0x', variants: ['fast', 'precise'], contextLimit: 128000 },
    { fullId: 'opencode/free-model', providerId: 'opencode', name: 'Community Free', variants: [] },
    { fullId: 'paid/model', providerId: 'paid', name: 'Paid', variants: ['standard'] },
  ];

  it('preserves free-model and speed parsing rules', () => {
    expect(isFreeModel(models[0])).toBe(true);
    expect(isFreeModel(models[1])).toBe(true);
    expect(isFreeModel(models[2])).toBe(false);
    expect(parseSpeedMultiplier('0.25x')).toBe(0.25);
    expect(parseSpeedMultiplier(undefined)).toBe(Number.POSITIVE_INFINITY);
  });

  it('owns catalog selection, variant fallback, and context limit', () => {
    const state = createModelState({ models, selectedModel: 'copilot/free', selectedVariant: 'precise' });
    expect(state.getSelectedVariant()).toBe('precise');
    expect(state.getContextLimit()).toBe(128000);

    expect(state.selectModel('paid/model')).toEqual({
      selectedModel: 'paid/model',
      selectedVariant: 'standard',
      variantChanged: true,
    });
    expect(state.selectVariant('missing').selectedVariant).toBe('standard');

    expect(state.setCatalog(models.slice(1), 'missing/model', 'legacy')).toEqual({
      selectedModel: 'missing/model',
      selectedVariant: '',
      variantChanged: true,
    });
  });

  it('derives the existing free, warning, danger, and hidden quota visuals', () => {
    const state = createModelState({ models, selectedModel: 'copilot/free' });
    expect(state.deriveQuotaVisual(false)).toMatchObject({ visible: true, remaining: 100, used: 0, severity: 'normal' });

    state.selectModel('paid/model');
    expect(state.deriveQuotaVisual(false).visible).toBe(false);
    state.setQuota({ summaryRemainingPercent: 7 });
    expect(state.deriveQuotaVisual(false)).toMatchObject({ visible: true, remaining: 7, used: 93, severity: 'warning' });
    state.setQuota({ summaryRemainingPercent: 0 });
    expect(state.deriveQuotaVisual(false).severity).toBe('danger');
    expect(state.deriveQuotaVisual(true).visible).toBe(false);
  });

  it('keeps five most recently selected models in order', () => {
    const recentModels = ['a', 'b', 'c', 'd', 'e', 'f'].map((fullId) => ({ fullId }));
    const state = createModelState({ models: recentModels });
    for (const model of recentModels) state.selectModel(model.fullId);
    expect(state.getRecentModels().map((model) => model.fullId)).toEqual(['f', 'e', 'd', 'c', 'b']);
    state.selectModel('c');
    expect(state.getRecentModels().map((model) => model.fullId)).toEqual(['c', 'f', 'e', 'd', 'b']);
  });

  it('normalizes reset labels without changing their remaining text', () => {
    expect(normalizeResetText('resets in 2 hours')).toBe('2 hours');
    expect(normalizeResetText('resets on Tuesday')).toBe('Tuesday');
    expect(normalizeResetText('tomorrow')).toBe('tomorrow');
  });
});
