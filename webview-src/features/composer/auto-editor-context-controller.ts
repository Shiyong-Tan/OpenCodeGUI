import type { ComposerContextItem, ComposerContextState } from './context-state';

export type AutomaticEditorContextResult = ComposerContextItem & {
  displayText: string;
  text: string;
  source: 'editor-auto';
  contextKey: string;
  automatic: true;
};

export function createAutoEditorContextController(options: {
  state: ComposerContextState;
  window: Window;
  postMessage(message: unknown): void;
  onContextChanged(): void;
  getScopeKey(): string;
  createRequestId?(): string;
  timeoutMs?: number;
}) {
  let requestSequence = 0;
  let requestOrdinal = 0;
  const dismissedContexts = new Map<string, { contextKey: string; clearRevision: number }>();
  const latestHandledOrdinalByScope = new Map<string, number>();
  const pending = new Map<string, { resolve(): void; timer: number; scopeKey: string; ordinal: number }>();

  const refresh = (): Promise<void> => {
    const requestId = options.createRequestId?.()
      || `editor-context-${Date.now()}-${++requestSequence}`;
    return new Promise((resolve) => {
      const timer = options.window.setTimeout(() => {
        pending.delete(requestId);
        resolve();
      }, options.timeoutMs ?? 800);
      pending.set(requestId, {
        resolve,
        timer,
        scopeKey: options.getScopeKey(),
        ordinal: ++requestOrdinal,
      });
      options.postMessage({ type: 'getAutoEditorContext', requestId });
    });
  };

  const normalizeContext = (rawContext: unknown): AutomaticEditorContextResult | null => {
    const value = rawContext as Partial<AutomaticEditorContextResult> | null;
    return value
      && value.automatic === true
      && value.source === 'editor-auto'
      && typeof value.contextKey === 'string'
      && typeof value.displayText === 'string'
      && typeof value.text === 'string'
      ? value as AutomaticEditorContextResult
      : null;
  };

  const applyContext = (rawContext: unknown, scopeKey: string): void => {
    const context = normalizeContext(rawContext);
    const dismissed = dismissedContexts.get(scopeKey);
    const isDismissed = Boolean(context
      && dismissed?.contextKey === context.contextKey
      && dismissed.clearRevision === options.state.getClearRevision());
    const changed = options.state.setAutomaticContext(
      context && !isDismissed ? context : null,
    );
    if (changed) options.onContextChanged();
  };

  const handleResult = (requestId: string, rawContext: unknown): boolean => {
    const request = pending.get(requestId);
    if (!request) return false;
    pending.delete(requestId);
    options.window.clearTimeout(request.timer);
    if (request.scopeKey !== options.getScopeKey()) {
      request.resolve();
      return true;
    }
    if (request.ordinal < (latestHandledOrdinalByScope.get(request.scopeKey) || 0)) {
      request.resolve();
      return true;
    }
    latestHandledOrdinalByScope.set(request.scopeKey, request.ordinal);
    applyContext(rawContext, request.scopeKey);
    request.resolve();
    return true;
  };

  const handleChanged = (rawContext: unknown): void => {
    const scopeKey = options.getScopeKey();
    latestHandledOrdinalByScope.set(scopeKey, ++requestOrdinal);
    applyContext(rawContext, scopeKey);
  };

  const dismiss = (item: ComposerContextItem): void => {
    if (item?.automatic === true && typeof item.contextKey === 'string') {
      dismissedContexts.set(options.getScopeKey(), {
        contextKey: item.contextKey,
        clearRevision: options.state.getClearRevision(),
      });
    }
  };

  return Object.freeze({ refresh, handleResult, handleChanged, dismiss });
}
