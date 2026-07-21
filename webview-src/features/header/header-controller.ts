import type { HeaderState, SessionUsage } from './header-state';

export type HeaderUiController = {
  install(): void;
  renderTitle(): void;
  renderUsage(): void;
};

export function createHeaderUiController(options: {
  state: HeaderState;
  titleElement: HTMLElement;
  usageElement: HTMLButtonElement;
  usageFillElement: HTMLElement;
  usageLabelElement: HTMLElement;
  getActiveSessionId(): string;
  getContextLimit(): number;
  getRecomputedUsage(sessionId: string): Partial<SessionUsage> | null;
  isCompactDisabled(sessionId: string): boolean;
  compactDisabledTitle: string;
  onCompact(sessionId: string): void;
}): HeaderUiController {
  const {
    state,
    titleElement,
    usageElement,
    usageFillElement,
    usageLabelElement,
  } = options;

  const renderTitle = (): void => {
    titleElement.textContent = state.getDisplayTitle();
    titleElement.classList.toggle('is-waiting', state.isWaiting());
  };

  const renderUsage = (): void => {
    const sessionId = options.getActiveSessionId() || '';
    const presentation = state.deriveUsage({
      sessionId,
      contextLimit: options.getContextLimit(),
      recomputedUsage: sessionId ? options.getRecomputedUsage(sessionId) : null,
      compactDisabled: options.isCompactDisabled(sessionId),
      disabledTitle: options.compactDisabledTitle,
    });
    if (!presentation.visible) {
      usageElement.classList.add('hidden');
      return;
    }

    usageElement.disabled = presentation.disabled;
    usageElement.title = presentation.title;
    usageElement.classList.toggle('usage-high', presentation.high);
    usageElement.classList.toggle('usage-compact-mode', presentation.compactMode);
    usageElement.classList.toggle('usage-compact-running', presentation.compactRunning);
    usageFillElement.style.width = presentation.fillWidth;
    usageLabelElement.textContent = presentation.label;
    usageElement.classList.remove('hidden');
  };

  const install = (): void => {
    usageElement.addEventListener('mouseenter', () => {
      state.setCompactHover(true);
      renderUsage();
    });
    usageElement.addEventListener('mouseleave', () => {
      state.setCompactHover(false);
      renderUsage();
    });
    usageElement.addEventListener('click', () => {
      const sessionId = options.getActiveSessionId() || '';
      if (!state.isCompactHoverActive() || !sessionId || options.isCompactDisabled(sessionId)) return;
      options.onCompact(sessionId);
    });
  };

  return { install, renderTitle, renderUsage };
}
