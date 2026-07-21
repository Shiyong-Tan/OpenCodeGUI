type SearchStateLike = {
  open: boolean;
  openSearch(): void;
  closeSearch(): void;
  setTextQuery(value: unknown): void;
  setTextMode(): void;
};

type SearchDomLike = {
  elements(): {
    bar: any;
    input: any;
  };
  clearHighlights(): void;
  updateControls(): void;
};

type ListenerElement = {
  addEventListener(type: string, listener: (event: any) => void): void;
};

export function createSessionSearchInteractionController(options: {
  state: SearchStateLike;
  dom: SearchDomLike;
  refresh(options: { jumpToFirst: boolean }): void;
  navigate(delta: number): void;
  runSmart(): void;
  requestAnimationFrame(callback: () => void): unknown;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}) {
  let debounceTimer: unknown = null;

  const cancelScheduledRefresh = (): void => {
    if (debounceTimer === null) return;
    options.clearTimeout(debounceTimer);
    debounceTimer = null;
  };

  const scheduleRefresh = ({ jumpToFirst = false }: { jumpToFirst?: boolean } = {}): void => {
    options.state.setTextMode();
    cancelScheduledRefresh();
    debounceTimer = options.setTimeout(() => {
      debounceTimer = null;
      options.refresh({ jumpToFirst });
    }, 120);
  };

  const open = (): void => {
    const { bar, input } = options.dom.elements();
    if (!bar || !input) return;
    options.state.openSearch();
    bar.classList.remove('hidden');
    options.requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    options.refresh({ jumpToFirst: false });
  };

  const close = (): void => {
    const { bar, input } = options.dom.elements();
    options.state.closeSearch();
    cancelScheduledRefresh();
    if (input) input.value = '';
    options.dom.clearHighlights();
    options.dom.updateControls();
    bar?.classList.add('hidden');
  };

  const install = (elements: {
    toggle?: ListenerElement | null;
    input?: (ListenerElement & { value: string; focus(): void }) | null;
    smart?: ListenerElement | null;
    prev?: ListenerElement | null;
    next?: ListenerElement | null;
    close?: ListenerElement | null;
  }): void => {
    elements.toggle?.addEventListener('click', () => {
      if (options.state.open) close(); else open();
    });
    elements.input?.addEventListener('input', () => {
      options.state.setTextQuery(elements.input?.value || '');
      scheduleRefresh({ jumpToFirst: false });
    });
    elements.input?.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        options.runSmart();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        options.navigate(event.shiftKey ? -1 : 1);
      }
    });
    elements.smart?.addEventListener('click', () => {
      options.runSmart();
      elements.input?.focus();
    });
    elements.prev?.addEventListener('click', () => {
      options.navigate(-1);
      elements.input?.focus();
    });
    elements.next?.addEventListener('click', () => {
      options.navigate(1);
      elements.input?.focus();
    });
    elements.close?.addEventListener('click', close);
  };

  return { scheduleRefresh, open, close, install, dispose: cancelScheduledRefresh };
}
