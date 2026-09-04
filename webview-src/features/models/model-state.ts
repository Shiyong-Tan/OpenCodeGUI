export interface WebviewModel {
  fullId: string;
  id?: string;
  name?: string;
  providerId?: string;
  variants?: string[] | Record<string, unknown>;
  speedMultiplier?: string;
  contextLimit?: number;
  [key: string]: unknown;
}

export interface ModelQuotaRow {
  label: string;
  remainingPercent: number;
  resetText?: string;
}

export interface ModelQuota {
  summaryRemainingPercent?: number;
  rows?: ModelQuotaRow[];
  [key: string]: unknown;
}

export interface QuotaVisual {
  visible: boolean;
  remaining: number;
  used: number;
  remainingDeg: number;
  usedDeg: number;
  severity: 'normal' | 'warning' | 'danger';
}

export interface ModelSelectionResult {
  selectedModel: string;
  selectedVariant: string;
  variantChanged: boolean;
}

export function isCopilotProvider(providerId: unknown): boolean {
  return typeof providerId === 'string' && providerId.toLowerCase().includes('copilot');
}

export function parseSpeedMultiplier(value: unknown): number {
  if (typeof value !== 'string' || !value) return Number.POSITIVE_INFINITY;
  const parsed = Number.parseFloat(value.trim().toLowerCase().replace(/x$/, ''));
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

export function isFreeModel(model: WebviewModel | null | undefined): boolean {
  if (!model) return false;
  const provider = String(model.providerId || '').toLowerCase();
  const fullId = String(model.fullId || '').toLowerCase();
  const name = String(model.name || '').toLowerCase();
  const id = String(model.id || '').toLowerCase();
  const speed = typeof model.speedMultiplier === 'string'
    ? model.speedMultiplier.trim().toLowerCase()
    : '';
  const isCopilot = isCopilotProvider(provider) || fullId.includes('copilot');
  if (isCopilot && speed === '0x') return true;
  const isOpenCode = provider === 'opencode' || fullId.startsWith('opencode/');
  return isOpenCode && (name.includes('free') || fullId.includes('free') || id.includes('free'));
}

export function normalizeResetText(resetText: unknown): string {
  if (typeof resetText !== 'string' || !resetText) return '';
  return resetText.replace(/^resets\s+(at|on|in)\s+/i, '').trim();
}

function normalizeModels(models: unknown): WebviewModel[] {
  if (!Array.isArray(models)) return [];
  return models.filter((model): model is WebviewModel => Boolean(
    model && typeof model === 'object' && typeof model.fullId === 'string' && model.fullId.length,
  ));
}

function variantsFor(model: WebviewModel | undefined): string[] {
  const variants = model?.variants;
  if (Array.isArray(variants)) return variants.filter((value): value is string => typeof value === 'string');
  if (variants && typeof variants === 'object') return Object.keys(variants);
  return [];
}

export function createModelState(initial?: {
  models?: unknown;
  selectedModel?: string;
  selectedVariant?: string;
  quota?: ModelQuota | null;
  recentModelIds?: unknown;
}) {
  let models = normalizeModels(initial?.models);
  let selectedModel = initial?.selectedModel || models[0]?.fullId || '';
  let selectedVariant = initial?.selectedVariant || '';
  let quota = initial?.quota || null;
  let recentModelIds = Array.isArray(initial?.recentModelIds)
    ? initial?.recentModelIds.filter((value): value is string => typeof value === 'string').slice(0, 5)
    : [];
  let freeModelIds = new Set<string>();

  const refreshFreeModels = () => {
    freeModelIds = new Set(models.filter(isFreeModel).map((model) => model.fullId));
  };

  const normalizeSelection = (): ModelSelectionResult => {
    if (!selectedModel) {
      selectedModel = models[0]?.fullId || '';
    }
    const variants = variantsFor(models.find((model) => model.fullId === selectedModel));
    const previousVariant = selectedVariant;
    if (!variants.includes(selectedVariant)) selectedVariant = variants[0] || '';
    return {
      selectedModel,
      selectedVariant,
      variantChanged: previousVariant !== selectedVariant,
    };
  };

  refreshFreeModels();
  normalizeSelection();

  return {
    getModels: (): readonly WebviewModel[] => models,
    getSelectedModel: (): string => selectedModel,
    getSelectedVariant: (): string => selectedVariant,
    getRecentModels: (): readonly WebviewModel[] => recentModelIds
      .map((id) => models.find((model) => model.fullId === id))
      .filter((model): model is WebviewModel => Boolean(model)),
    getQuota: (): ModelQuota | null => quota,
    getVariants: (): readonly string[] => variantsFor(models.find((model) => model.fullId === selectedModel)),
    getContextLimit: (): number => {
      const raw = models.find((model) => model.fullId === selectedModel)?.contextLimit;
      const limit = Number(raw);
      return Number.isFinite(limit) && limit > 0 ? limit : 0;
    },
    isSelectedModelFree: (): boolean => freeModelIds.has(selectedModel),
    setCatalog(nextModels: unknown, preferredModel?: string, preferredVariant?: string): ModelSelectionResult {
      models = normalizeModels(nextModels);
      if (typeof preferredModel === 'string') selectedModel = preferredModel;
      if (typeof preferredVariant === 'string') selectedVariant = preferredVariant;
      refreshFreeModels();
      return normalizeSelection();
    },
    selectModel(modelId: string): ModelSelectionResult {
      if (models.some((model) => model.fullId === modelId)) {
        selectedModel = modelId;
        recentModelIds = [modelId, ...recentModelIds.filter((id) => id !== modelId)].slice(0, 5);
      }
      return normalizeSelection();
    },
    setRecentModelIds(ids: unknown): void {
      recentModelIds = Array.isArray(ids)
        ? ids.filter((value): value is string => typeof value === 'string').slice(0, 5)
        : [];
    },
    selectVariant(variant: string): ModelSelectionResult {
      const variants = variantsFor(models.find((model) => model.fullId === selectedModel));
      selectedVariant = variants.includes(variant) ? variant : variants[0] || '';
      return { selectedModel, selectedVariant, variantChanged: true };
    },
    setQuota(nextQuota: ModelQuota | null | undefined): void {
      quota = nextQuota || null;
    },
    deriveQuotaVisual(busy: boolean): QuotaVisual {
      const isFree = freeModelIds.has(selectedModel);
      const summary = quota?.summaryRemainingPercent;
      if (busy || (!isFree && typeof summary !== 'number')) {
        return { visible: false, remaining: 0, used: 0, remainingDeg: 0, usedDeg: 360, severity: 'normal' };
      }
      const remaining = isFree ? 100 : Math.max(0, Math.min(100, Number(summary || 0)));
      const used = Math.max(0, 100 - remaining);
      return {
        visible: true,
        remaining,
        used,
        remainingDeg: Math.round(remaining * 3.6),
        usedDeg: 360 - Math.round(remaining * 3.6),
        severity: !isFree && remaining <= 0 ? 'danger' : (!isFree && remaining < 10 ? 'warning' : 'normal'),
      };
    },
  };
}

export type ModelState = ReturnType<typeof createModelState>;
