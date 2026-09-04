import type { ModelQuota, ModelSelectionResult, ModelState, WebviewModel } from './model-state';
import { isCopilotProvider, normalizeResetText, parseSpeedMultiplier } from './model-state';

interface SimpleSelectConfig {
  getValue(): string;
  onSelect(value: string): void;
}

export interface ModelUiControllerOptions {
  state: ModelState;
  document: Document;
  window: Window;
  modelSelect: HTMLSelectElement;
  variantSelect: HTMLSelectElement;
  sendButton: HTMLElement;
  postMessage(message: unknown): void;
  getSessionId(): string;
  persistRecentModels?(models: readonly WebviewModel[]): void;
  renderSimpleSelect(select: HTMLSelectElement, config: SimpleSelectConfig): void;
  computePanelWidth(wrapper: HTMLElement, models: readonly WebviewModel[]): number;
  getChevronSvg(): string;
  isBusy(): boolean;
}

export function createModelUiController(options: ModelUiControllerOptions) {
  const {
    state,
    document,
    window,
    modelSelect,
    variantSelect,
    sendButton,
    postMessage,
    renderSimpleSelect,
    computePanelWidth,
    getChevronSvg,
    isBusy,
  } = options;
  const collapsedProviders = new Set<string>();
  let modelDropdownOutsideHandler: ((event: MouseEvent) => void) | null = null;
  let quotaTooltip: HTMLDivElement | null = null;

  const postVariant = (value: string) => postMessage({ type: 'setVariant', value, sessionId: options.getSessionId() });

  const updateVariantOptions = (notifyCurrentVariant = false) => {
    const selectedModel = state.getSelectedModel();
    const variants = Array.from(state.getVariants());
    postMessage({
      type: 'ui-debug',
      payload: [
        '[WV][UPDATE_VARIANTS]',
        'model=' + selectedModel,
        'count=' + variants.length,
        'keys=' + (variants.join(',') || 'none'),
      ],
    });

    variantSelect.innerHTML = '';
    const wrapper = variantSelect.parentElement;
    if (!variants.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'default';
      option.selected = true;
      variantSelect.appendChild(option);
      variantSelect.disabled = true;
      postVariant(state.selectVariant('').selectedVariant);
      if (wrapper) wrapper.style.display = 'none';
      renderVariantSelect();
      return;
    }

    if (wrapper) wrapper.style.display = '';
    variantSelect.disabled = false;
    let selectedVariant = state.getSelectedVariant();
    if (!variants.includes(selectedVariant)) {
      selectedVariant = state.selectVariant(variants[0] || '').selectedVariant;
      postVariant(selectedVariant);
    } else if (notifyCurrentVariant) {
      postVariant(selectedVariant);
    }
    for (const variant of variants) {
      const option = document.createElement('option');
      option.value = variant;
      option.textContent = variant;
      option.selected = variant === selectedVariant;
      variantSelect.appendChild(option);
    }
    renderVariantSelect();
  };

  const selectModel = (modelId: string): ModelSelectionResult => {
    const selection = state.selectModel(modelId);
    options.persistRecentModels?.(state.getRecentModels());
    updateVariantOptions(selection.variantChanged);
    return selection;
  };

  const selectVariant = (variant: string): ModelSelectionResult => state.selectVariant(variant);

  function renderVariantSelect() {
    renderSimpleSelect(variantSelect, {
      getValue: () => state.getSelectedVariant(),
      onSelect: (value) => {
        const selection = selectVariant(value);
        variantSelect.value = selection.selectedVariant;
        postVariant(selection.selectedVariant);
      },
    });
  }

  const renderModelSelect = () => {
    const models = state.getModels();
    const selectedModel = state.getSelectedModel();
    postMessage({
      type: 'ui-debug',
      payload: [
        '[WV][RENDER_MODELS]',
        `count=${models.length}`,
        `selected=${selectedModel || 'none'}`,
      ],
    });
    const wrapper = modelSelect.parentElement;
    if (!wrapper) return;
    wrapper.style.width = '';
    wrapper.style.minWidth = '';
    modelSelect.innerHTML = '';
    for (const model of models) {
      const option = document.createElement('option');
      option.value = model.fullId;
      option.textContent = `${model.name || model.fullId}${model.providerId ? ` (${model.providerId})` : ''}`;
      option.selected = model.fullId === selectedModel;
      modelSelect.appendChild(option);
    }

    modelSelect.classList.add('is-hidden');
    wrapper.querySelector('.model-dropdown')?.remove();
    if (modelDropdownOutsideHandler) document.removeEventListener('click', modelDropdownOutsideHandler);

    const dropdown = document.createElement('div');
    dropdown.className = 'model-dropdown';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'select-button model-toggle';
    toggle.setAttribute('aria-haspopup', 'listbox');
    toggle.setAttribute('aria-expanded', 'false');
    const icon = document.createElement('span');
    icon.className = 'select-icon';
    icon.innerHTML = getChevronSvg();
    const label = document.createElement('span');
    label.className = 'select-label';
    toggle.append(icon, label);
    const panel = document.createElement('div');
    panel.className = 'dropdown-panel hidden';
    panel.setAttribute('role', 'listbox');

    const grouped = new Map<string, WebviewModel[]>();
    const providerOrder: string[] = [];
    for (const model of models) {
      const provider = model.providerId || 'other';
      if (!grouped.has(provider)) {
        grouped.set(provider, []);
        providerOrder.push(provider);
      }
      grouped.get(provider)?.push(model);
    }
    for (const provider of providerOrder) {
      if (!isCopilotProvider(provider)) continue;
      grouped.get(provider)?.sort((left, right) => {
        const speedDelta = parseSpeedMultiplier(left.speedMultiplier) - parseSpeedMultiplier(right.speedMultiplier);
        if (speedDelta !== 0) return speedDelta;
        const leftName = String(left.name || left.fullId).toLowerCase();
        const rightName = String(right.name || right.fullId).toLowerCase();
        if (leftName < rightName) return -1;
        if (leftName > rightName) return 1;
        return 0;
      });
    }
    if (!collapsedProviders.size) providerOrder.forEach((provider) => collapsedProviders.add(provider));

    const updateLabel = () => {
      const current = state.getSelectedModel();
      const selected = models.find((model) => model.fullId === current);
      label.textContent = selected ? selected.name || selected.fullId : 'Select model';
      panel.querySelectorAll<HTMLElement>('.model-option').forEach((option) => {
        option.classList.toggle('is-selected', option.dataset.value === current);
      });
    };
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.className = 'model-search-input';
    searchInput.placeholder = 'Search models';
    searchInput.setAttribute('aria-label', 'Search models');
    panel.appendChild(searchInput);

    const recentModels = state.getRecentModels();
    const recentGroup = document.createElement('div');
    recentGroup.className = 'model-group model-recent-group';
    const recentHeader = document.createElement('div');
    recentHeader.className = 'model-group-header model-recent-header';
    recentHeader.textContent = 'Recent';
    const recentList = document.createElement('div');
    recentList.className = 'model-group-list';
    recentGroup.append(recentHeader, recentList);
    if (recentModels.length) panel.appendChild(recentGroup);

    const selectAndClose = (modelId: string) => {
      const selection = selectModel(modelId);
      postMessage({ type: 'setModel', value: selection.selectedModel, sessionId: options.getSessionId() });
      updateVariantOptions(selection.variantChanged);
      updateLabel();
      updateSendQuotaVisual();
      close();
    };
    for (const model of recentModels) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'model-option model-recent-option';
      option.dataset.value = model.fullId;
      option.textContent = model.name || model.fullId;
      option.addEventListener('click', () => selectAndClose(model.fullId));
      recentList.appendChild(option);
    }
    const close = () => {
      panel.classList.add('hidden');
      toggle.setAttribute('aria-expanded', 'false');
      dropdown.classList.remove('is-open');
    };

    for (const provider of providerOrder) {
      const group = document.createElement('div');
      group.className = 'model-group';
      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'model-group-header';
      header.textContent = provider;
      const list = document.createElement('div');
      list.className = 'model-group-list';
      if (collapsedProviders.has(provider)) {
        list.classList.add('is-collapsed');
        header.classList.add('is-collapsed');
      }
      header.addEventListener('click', () => {
        collapsedProviders.has(provider) ? collapsedProviders.delete(provider) : collapsedProviders.add(provider);
        list.classList.toggle('is-collapsed');
        header.classList.toggle('is-collapsed');
      });
      for (const model of grouped.get(provider) || []) {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'model-option';
        option.dataset.value = model.fullId;
        option.classList.toggle('is-selected', model.fullId === selectedModel);
        const optionLabel = document.createElement('span');
        optionLabel.className = 'model-option-label';
        optionLabel.textContent = model.name || model.fullId;
        option.appendChild(optionLabel);
        if (isCopilotProvider(provider) && typeof model.speedMultiplier === 'string' && model.speedMultiplier) {
          const speed = document.createElement('span');
          speed.className = 'model-option-speed';
          speed.textContent = model.speedMultiplier;
          option.appendChild(speed);
        }
        option.addEventListener('click', () => selectAndClose(model.fullId));
        list.appendChild(option);
      }
      group.append(header, list);
      panel.appendChild(group);
    }

    const width = computePanelWidth(wrapper, models);
    panel.style.width = width > 0 ? `${width}px` : '';
    panel.style.minWidth = panel.style.width;
    dropdown.append(toggle, panel);
    searchInput.addEventListener('input', () => {
      const query = searchInput.value.trim().toLowerCase();
      panel.querySelectorAll<HTMLElement>('.model-option').forEach((option) => {
        const model = models.find((item) => item.fullId === option.dataset.value);
        const haystack = model ? `${model.name || ''} ${model.fullId} ${model.providerId || ''}`.toLowerCase() : '';
        option.hidden = Boolean(query && !haystack.includes(query));
      });
      panel.querySelectorAll<HTMLElement>('.model-group:not(.model-recent-group)').forEach((group) => {
        const hasMatch = Array.from(group.querySelectorAll<HTMLElement>('.model-option')).some((option) => !option.hidden);
        group.hidden = Boolean(query && !hasMatch);
        const list = group.querySelector<HTMLElement>('.model-group-list');
        const header = group.querySelector<HTMLElement>('.model-group-header');
        if (query && hasMatch) {
          list?.classList.remove('is-collapsed');
          header?.classList.remove('is-collapsed');
        } else if (!query && list && header) {
          const provider = header.textContent || '';
          const collapsed = collapsedProviders.has(provider);
          list.classList.toggle('is-collapsed', collapsed);
          header.classList.toggle('is-collapsed', collapsed);
        }
      });
      if (recentModels.length) {
        recentGroup.hidden = Boolean(query && !Array.from(recentList.querySelectorAll<HTMLElement>('.model-option')).some((option) => !option.hidden));
      }
    });
    wrapper.appendChild(dropdown);
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      if (panel.classList.contains('hidden')) {
        panel.classList.remove('hidden');
        toggle.setAttribute('aria-expanded', 'true');
        dropdown.classList.add('is-open');
      } else close();
    });
    modelDropdownOutsideHandler = (event) => {
      if (!dropdown.contains(event.target as Node)) close();
    };
    document.addEventListener('click', modelDropdownOutsideHandler);
    updateLabel();
  };

  const updateSendQuotaVisual = () => {
    const quota = state.getQuota();
    const visual = state.deriveQuotaVisual(isBusy());
    if (!visual.visible) {
      sendButton.classList.remove('has-quota');
      ['--quota-remaining-deg', '--quota-remaining-color', '--quota-used-color'].forEach((name) => sendButton.style.removeProperty(name));
      postMessage({ type: 'ui-debug', payload: ['quota.render.skip', `busy=${String(isBusy())}`, `summary=${quota?.summaryRemainingPercent ?? 'null'}`] });
      return;
    }
    let centerColor = 'var(--vscode-button-background)';
    if (visual.severity === 'danger') {
      sendButton.style.setProperty('--quota-remaining-color', 'var(--quota-danger)');
      sendButton.style.setProperty('--quota-used-color', 'var(--quota-danger)');
      centerColor = 'var(--quota-danger)';
    } else if (visual.severity === 'warning') {
      sendButton.style.setProperty('--quota-remaining-color', 'var(--quota-warning)');
      sendButton.style.setProperty('--quota-used-color', 'var(--quota-warning-light)');
      centerColor = 'var(--quota-warning)';
    } else {
      sendButton.style.removeProperty('--quota-remaining-color');
      sendButton.style.removeProperty('--quota-used-color');
    }
    sendButton.style.setProperty('--quota-used-deg', `${visual.usedDeg}deg`);
    sendButton.style.setProperty('--quota-remaining-deg', `${visual.remainingDeg}deg`);
    sendButton.style.setProperty('--quota-center-color', centerColor);
    sendButton.classList.add('has-quota');
    postMessage({ type: 'ui-debug', payload: ['quota.render.ok', `remaining=${visual.remaining}`, `used=${visual.used}`, `hasQuota=${sendButton.classList.contains('has-quota')}`] });
  };

  const ensureQuotaTooltip = () => {
    if (quotaTooltip) return quotaTooltip;
    quotaTooltip = document.createElement('div');
    quotaTooltip.className = 'quota-tooltip hidden';
    document.body.appendChild(quotaTooltip);
    return quotaTooltip;
  };
  const showQuotaTooltip = () => {
    const tooltip = ensureQuotaTooltip();
    const rows = state.getQuota()?.rows || [];
    tooltip.innerHTML = `<div class="quota-tooltip-header"><span class="quota-tooltip-title"><span class="quota-title-icon">\u25D4</span>Rate limits remaining</span></div>${rows.length
      ? rows.map((row) => `<div class="quota-tooltip-row"><span class="quota-col-label">${row.label}</span><span class="quota-col-pct">${row.remainingPercent}%</span><span class="quota-col-reset">${normalizeResetText(row.resetText)}</span></div>`).join('')
      : '<div class="quota-tooltip-row">Quota unavailable</div>'}`;
    const rect = sendButton.getBoundingClientRect();
    tooltip.classList.remove('hidden');
    tooltip.style.visibility = 'hidden';
    const width = tooltip.offsetWidth || 196;
    const height = tooltip.offsetHeight || 80;
    tooltip.style.left = `${Math.min(window.innerWidth - width - 8, Math.max(8, rect.right - width))}px`;
    tooltip.style.top = `${Math.max(8, rect.top - height - 8)}px`;
    tooltip.style.visibility = 'visible';
    postMessage({ type: 'ui-debug', payload: ['quota.tooltip.show', `rows=${rows.length}`, `busy=${String(isBusy())}`] });
  };
  const hideQuotaTooltip = () => quotaTooltip?.classList.add('hidden');

  return {
    state,
    setCatalog(models: unknown, selectedModel?: string, selectedVariant?: string) {
      return state.setCatalog(models, selectedModel, selectedVariant);
    },
    setQuota(quota: ModelQuota | null | undefined) { state.setQuota(quota); },
    selectModel,
    selectVariant,
    renderModelSelect,
    renderVariantSelect,
    updateVariantOptions,
    updateSendQuotaVisual,
    ensureQuotaTooltip,
    showQuotaTooltip,
    hideQuotaTooltip,
    dispose() {
      if (modelDropdownOutsideHandler) document.removeEventListener('click', modelDropdownOutsideHandler);
      modelDropdownOutsideHandler = null;
      quotaTooltip?.remove();
      quotaTooltip = null;
    },
  };
}

export type ModelUiController = ReturnType<typeof createModelUiController>;
