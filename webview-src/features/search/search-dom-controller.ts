type SearchElement = Element & {
  disabled?: boolean;
  focus?: () => void;
  select?: () => void;
  textContent: string | null;
};

type SearchStateLike = {
  mode: 'text' | 'smart';
  query: string;
  matches: any[];
  activeIndex: number;
  smartMessageIds: string[];
  smartInFlight: boolean;
  fullMatchKeys: string[];
  activeKeyIndex: number;
};

export type SessionSearchControls = Readonly<{
  current: number;
  total: number;
  countText: string;
  loading: boolean;
  noResults: boolean;
  smartDisabled: boolean;
  smartActive: boolean;
  smartText: string;
  navigationDisabled: boolean;
}>;

export function deriveSessionSearchControls(state: SearchStateLike): SessionSearchControls {
  const textMode = state.mode === 'text';
  const total = textMode ? state.fullMatchKeys.length : state.smartMessageIds.length;
  const activeIndex = textMode ? state.activeKeyIndex : state.activeIndex;
  const current = total > 0 && activeIndex >= 0 ? activeIndex + 1 : 0;
  const hasQuery = Boolean(String(state.query || '').trim());
  return Object.freeze({
    current,
    total,
    countText: state.smartInFlight ? '' : (hasQuery ? `${current}/${total}` : '0/0'),
    loading: state.smartInFlight,
    noResults: !state.smartInFlight && hasQuery && total === 0,
    smartDisabled: state.smartInFlight || !hasQuery,
    smartActive: state.mode === 'smart',
    smartText: state.smartInFlight ? 'Smart...' : 'Smart',
    navigationDisabled: total <= 1,
  });
}

export function createSessionSearchDomController(options: {
  document: Document;
  state: SearchStateLike;
  onManualScroll(): void;
}) {
  const elements = () => ({
    bar: options.document.getElementById('session-search-bar') as SearchElement | null,
    input: options.document.getElementById('session-search-input') as SearchElement | null,
    count: options.document.getElementById('session-search-count') as SearchElement | null,
    smart: options.document.getElementById('session-search-smart') as SearchElement | null,
    prev: options.document.getElementById('session-search-prev') as SearchElement | null,
    next: options.document.getElementById('session-search-next') as SearchElement | null,
  });

  const clearHighlights = (): void => {
    const marks = Array.from(options.document.querySelectorAll('mark.session-search-hit'));
    const parents = new Set<Node>();
    for (const mark of marks) {
      const parent = mark.parentNode;
      if (!parent) continue;
      parents.add(parent);
      parent.replaceChild(options.document.createTextNode(mark.textContent || ''), mark);
    }
    for (const parent of parents) parent.normalize?.();
    const semanticHits = Array.from(options.document.querySelectorAll('.session-search-semantic-hit'));
    for (const hit of semanticHits) hit.classList.remove('session-search-semantic-hit', 'active');
    options.state.matches = [];
  };

  const updateControls = (): void => {
    const { count, prev, next, smart } = elements();
    const presentation = deriveSessionSearchControls(options.state);
    if (count) {
      count.textContent = presentation.countText;
      count.classList.toggle('is-loading', presentation.loading);
      count.classList.toggle('no-results', presentation.noResults);
    }
    if (smart) {
      smart.disabled = presentation.smartDisabled;
      smart.classList.toggle('is-active', presentation.smartActive);
      smart.textContent = presentation.smartText;
    }
    if (prev) prev.disabled = presentation.navigationDisabled;
    if (next) next.disabled = presentation.navigationDisabled;
  };

  const matchKey = (match: any): string => match?.dataset?.renderUnitKey
    || match?.dataset?.messageId || match?.dataset?.segmentKey || '';

  const updateActiveHit = ({ scroll = false }: { scroll?: boolean } = {}): void => {
    const total = options.state.matches.length;
    const smartMode = options.state.mode === 'smart';
    const activeSmartId = smartMode && options.state.activeIndex >= 0
      ? options.state.smartMessageIds[options.state.activeIndex]
      : '';
    for (let index = 0; index < total; index += 1) {
      options.state.matches[index].classList.toggle('active', smartMode
        ? matchKey(options.state.matches[index]) === activeSmartId
        : index === options.state.activeIndex);
    }
    updateControls();
    if (!scroll || total === 0 || options.state.activeIndex < 0) return;
    const active = smartMode
      ? options.state.matches.find((match) => matchKey(match) === activeSmartId)
      : options.state.matches[options.state.activeIndex];
    active?.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'auto' });
  };

  const keyedRoot = (key: string): Element | null => {
    const css = options.document.defaultView?.CSS;
    const escaped = typeof css?.escape === 'function'
      ? css.escape(key)
      : String(key).replace(/["\\]/g, '\\$&');
    return options.document.querySelector(
      `[data-render-unit-key="${escaped}"], [data-message-id="${escaped}"], [data-segment-key="${escaped}"]`,
    );
  };

  const isTextNode = (node: Node, queryLower: string): boolean => {
    const text = node?.nodeValue || '';
    if (!text || !text.toLowerCase().includes(queryLower)) return false;
    const parent = (node as ChildNode).parentElement;
    if (!parent) return false;
    if (parent.closest('button, input, textarea, select, mark.session-search-hit')) return false;
    if (parent.closest('.message-actions, .copy-btn, .message-copy-btn, .session-search-bar')) return false;
    return true;
  };

  const highlightTextNode = (node: Node, query: string, queryLower: string): void => {
    const text = node.nodeValue || '';
    const lower = text.toLowerCase();
    const fragment = options.document.createDocumentFragment();
    let cursor = 0;
    let index = lower.indexOf(queryLower, cursor);
    while (index !== -1) {
      if (index > cursor) fragment.appendChild(options.document.createTextNode(text.slice(cursor, index)));
      const mark = options.document.createElement('mark');
      mark.className = 'session-search-hit';
      mark.textContent = text.slice(index, index + query.length);
      mark.dataset.searchIndex = String(options.state.matches.length);
      const owner = (node as ChildNode).parentElement?.closest?.('[data-render-unit-key], [data-message-id], [data-segment-key]') as HTMLElement | null;
      mark.dataset.searchKey = owner?.dataset?.renderUnitKey || owner?.dataset?.messageId || owner?.dataset?.segmentKey || '';
      options.state.matches.push(mark);
      fragment.appendChild(mark);
      cursor = index + query.length;
      index = lower.indexOf(queryLower, cursor);
    }
    if (cursor < text.length) fragment.appendChild(options.document.createTextNode(text.slice(cursor)));
    node.parentNode?.replaceChild(fragment, node);
  };

  const syncActiveTextHit = ({ scroll = false }: { scroll?: boolean } = {}): void => {
    const activeKeyIndex = options.state.activeKeyIndex;
    const targetKey = activeKeyIndex >= 0 ? options.state.fullMatchKeys[activeKeyIndex] : '';
    let targetOccurrence = 0;
    for (let index = 0; targetKey && index < activeKeyIndex; index += 1) {
      if (options.state.fullMatchKeys[index] === targetKey) targetOccurrence += 1;
    }
    const mountedForKey = options.state.matches.filter((mark) => mark?.dataset?.searchKey === targetKey);
    const target = mountedForKey[Math.min(targetOccurrence, Math.max(0, mountedForKey.length - 1))] || null;
    options.state.activeIndex = target ? options.state.matches.indexOf(target) : -1;
    if (scroll && target) options.onManualScroll();
    updateActiveHit({ scroll });
  };

  return { elements, clearHighlights, updateControls, updateActiveHit, keyedRoot, isTextNode, highlightTextNode, syncActiveTextHit };
}
