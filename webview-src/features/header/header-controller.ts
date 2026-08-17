import type { HeaderState, SessionUsage } from './header-state';

export type HeaderUiController = {
  install(): void;
  renderTitle(): void;
  renderUsage(): void;
  handleSessionRenameResult(result: {
    sessionId: string;
    opId: string;
    title?: string;
    success: boolean;
  }): void;
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
  onRename(sessionId: string, title: string, opId: string): void;
}): HeaderUiController {
  const {
    state,
    titleElement,
    usageElement,
    usageFillElement,
    usageLabelElement,
  } = options;
  let editing: { sessionId: string; originalTitle: string } | null = null;
  const pendingRenames = new Map<string, {
    opId: string;
    originalTitle: string;
    requestedTitle: string;
  }>();

  const clearEditingPresentation = (): void => {
    editing = null;
    titleElement.removeAttribute('contenteditable');
    titleElement.removeAttribute('spellcheck');
    titleElement.classList.remove('is-editing');
  };

  const renderTitle = (): void => {
    const activeSessionId = options.getActiveSessionId() || '';
    if (editing?.sessionId === activeSessionId) return;
    if (editing) clearEditingPresentation();
    const pendingRename = pendingRenames.get(activeSessionId);
    if (pendingRename) state.setBaseTitle(pendingRename.requestedTitle);
    titleElement.textContent = state.getDisplayTitle();
    titleElement.classList.toggle('is-waiting', state.isWaiting());
    titleElement.classList.toggle('is-rename-pending', pendingRenames.has(activeSessionId));
  };

  const finishTitleEdit = (commit: boolean): void => {
    if (!editing) return;
    const { sessionId, originalTitle } = editing;
    const nextTitle = (titleElement.textContent || '').trim();
    clearEditingPresentation();
    if (!commit || !nextTitle || nextTitle === originalTitle) {
      state.setBaseTitle(originalTitle);
      renderTitle();
      return;
    }
    const opId = `rename-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pendingRenames.set(sessionId, { opId, originalTitle, requestedTitle: nextTitle });
    state.setBaseTitle(nextTitle);
    renderTitle();
    options.onRename(sessionId, nextTitle, opId);
  };

  const beginTitleEdit = (): void => {
    const sessionId = options.getActiveSessionId() || '';
    if (!sessionId || editing || pendingRenames.has(sessionId)) return;
    const originalTitle = state.getBaseTitle().trim();
    if (!originalTitle) return;
    editing = { sessionId, originalTitle };
    titleElement.textContent = originalTitle;
    titleElement.setAttribute('contenteditable', 'true');
    titleElement.setAttribute('spellcheck', 'false');
    titleElement.classList.remove('is-waiting');
    titleElement.classList.add('is-editing');
    titleElement.focus();
    const selection = titleElement.ownerDocument?.getSelection?.();
    if (selection && titleElement.ownerDocument?.createRange) {
      const range = titleElement.ownerDocument.createRange();
      range.selectNodeContents(titleElement);
      selection.removeAllRanges();
      selection.addRange(range);
    }
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
    titleElement.setAttribute('title', 'Double-click to rename session');
    titleElement.addEventListener('dblclick', (event) => {
      event.preventDefault();
      beginTitleEdit();
    });
    titleElement.addEventListener('keydown', (event) => {
      if (!editing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        finishTitleEdit(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finishTitleEdit(false);
      }
    });
    titleElement.addEventListener('blur', () => {
      if (editing) finishTitleEdit(true);
    });
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

  const handleSessionRenameResult = (result: {
    sessionId: string;
    opId: string;
    title?: string;
    success: boolean;
  }): void => {
    const pending = pendingRenames.get(result.sessionId);
    if (!pending || (result.opId && pending.opId !== result.opId)) return;
    pendingRenames.delete(result.sessionId);
    if (options.getActiveSessionId() === result.sessionId) {
      state.setBaseTitle(
        result.success
          ? ((result.title || '').trim() || pending.requestedTitle)
          : pending.originalTitle
      );
      renderTitle();
    }
  };

  return { install, renderTitle, renderUsage, handleSessionRenameResult };
}
