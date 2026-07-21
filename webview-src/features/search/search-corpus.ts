import { collectBoundedSmartSearchText, createLinearSearchMatcher, type SearchChunkVisitor } from './search-text';

type SearchMessage = {
  id?: string;
  role?: string;
  text?: string;
  meta?: Record<string, any>;
};

type SearchSession = {
  timeline?: string[];
  messagesById?: { get(id: string): SearchMessage | undefined };
  hiddenSet?: { has(id: string): boolean };
};

type SearchUnit = {
  kind?: string;
  value?: {
    message?: SearchMessage;
    segment?: { memberMsgIds?: Iterable<string>; memberIds?: Iterable<string> };
  };
};

export function pickSearchAgentMode(agent: any): string {
  if (typeof agent?.mode === 'string' && agent.mode.trim()) return agent.mode.trim();
  if (typeof agent?.description === 'string' && agent.description.trim()) return agent.description.trim();
  return '';
}

export function cleanSearchSubagentTitle(title: unknown): string {
  const raw = typeof title === 'string' ? title.trim() : '';
  if (!raw) return 'Subagent';
  return raw.replace(/\s*[（(]\s*@[^()]*[)）]\s*$/i, '').trim() || 'Subagent';
}

export function formatSearchSubagentModel(agent: any): string {
  const modelId = typeof agent?.model === 'string' && agent.model.trim() ? agent.model.trim() : '';
  const providerId = typeof agent?.providerId === 'string' && agent.providerId.trim() ? agent.providerId.trim() : '';
  if (modelId && providerId) return `${modelId}/${providerId}`;
  return modelId || providerId || '';
}

export function visitLoadedChatSearchChunks(
  session: SearchSession | null | undefined,
  unit: SearchUnit | null | undefined,
  visitor: SearchChunkVisitor,
  getAppendItems: (message: SearchMessage) => SearchMessage[] = () => [],
): void {
  if (!unit || typeof visitor !== 'function') return;
  let hasValue = false;
  let stopped = false;
  const visitValue = (value: unknown): void => {
    if (stopped || typeof value !== 'string' || !value) return;
    if (hasValue && visitor(' ') === false) {
      stopped = true;
      return;
    }
    if (visitor(value) === false) {
      stopped = true;
      return;
    }
    hasValue = true;
  };
  const visitMessage = (message: SearchMessage | undefined, subagentsOnly = false): void => {
    if (!message) return;
    const meta = message.meta || {};
    if (!subagentsOnly) {
      if (meta.isDiff === true) {
        visitValue(String(meta.diffText || message.text || ''));
        return;
      }
      visitValue(message.text || '');
      visitValue(meta.diffText || '');
      if (Array.isArray(meta.files)) {
        for (const file of meta.files) {
          visitValue(typeof file === 'string' ? file : file?.path || file?.name || '');
          if (stopped) break;
        }
      }
      if (!stopped && Array.isArray(meta.todos)) {
        for (const todo of meta.todos) visitValue(todo?.content || todo?.text || '');
      }
      return;
    }
    if (!Array.isArray(meta.subagents)) return;
    for (const agent of meta.subagents) {
      if (!agent) continue;
      visitValue(cleanSearchSubagentTitle(agent.title));
      visitValue(pickSearchAgentMode(agent));
      visitValue(formatSearchSubagentModel(agent));
      const latestFullText = typeof agent.latestFullText === 'string' ? agent.latestFullText.trim() : '';
      const latestText = typeof agent.latestText === 'string' ? agent.latestText.trim() : '';
      visitValue(latestFullText || latestText);
      visitValue(typeof agent.latestTool === 'string' ? agent.latestTool.trim() : '');
      visitValue(typeof agent.latestToolInput === 'string' ? agent.latestToolInput.trim() : '');
      if (stopped) break;
    }
  };

  const message = unit.value?.message;
  const memberIds = unit.kind === 'segment'
    ? unit.value?.segment?.memberMsgIds || unit.value?.segment?.memberIds
    : null;
  const appendItems = message ? getAppendItems(message) : [];
  visitMessage(message, false);
  if (!stopped && memberIds && typeof memberIds[Symbol.iterator] === 'function') {
    for (const id of memberIds) {
      visitMessage(session?.messagesById?.get?.(id), false);
      if (stopped) break;
    }
  }
  if (!stopped && Array.isArray(appendItems)) {
    for (const item of appendItems) {
      visitMessage(item, false);
      if (stopped) break;
    }
  }
  if (stopped) return;
  visitMessage(message, true);
  if (!stopped && unit.kind === 'segment' && memberIds && typeof memberIds[Symbol.iterator] === 'function') {
    for (const id of memberIds) {
      visitMessage(session?.messagesById?.get?.(id), true);
      if (stopped) break;
    }
  }
  if (!stopped && Array.isArray(appendItems)) {
    for (const item of appendItems) visitMessage(item, true);
  }
}

export function collectLoadedTextSearchKeys(options: {
  query: string;
  session: SearchSession | null | undefined;
  projectedRows?: Array<{ id?: string }> | null;
  getAppendItems?: (message: SearchMessage) => SearchMessage[];
}): string[] {
  const queryLower = String(options.query || '').trim().toLowerCase();
  if (!options.session || !queryLower || !Array.isArray(options.session.timeline)) return [];
  if (Array.isArray(options.projectedRows)) {
    return options.projectedRows.flatMap((row) => row?.id ? [row.id] : []);
  }
  const keys: string[] = [];
  for (const id of options.session.timeline) {
    const message = options.session.messagesById?.get?.(id);
    if (!message || options.session.hiddenSet?.has?.(id)) continue;
    const matcher = createLinearSearchMatcher(queryLower);
    visitLoadedChatSearchChunks(
      options.session,
      { kind: 'message', value: { message } },
      matcher.visit,
      options.getAppendItems,
    );
    if (matcher.matched()) keys.push(id);
  }
  return keys;
}

export function getLoadedSessionSearchText(message: SearchMessage | null | undefined): string {
  const meta = message?.meta || {};
  if (meta.isDiff === true) return String(meta.diffText || message?.text || '');
  const files = Array.isArray(meta.files)
    ? meta.files.map((file: any) => typeof file === 'string' ? file : file?.path || file?.name || '')
    : [];
  const todos = Array.isArray(meta.todos)
    ? meta.todos.map((todo: any) => todo?.content || todo?.text || '')
    : [];
  return [message?.text || '', meta.diffText || '', ...files, ...todos].filter(Boolean).join(' ');
}

export function collectSmartSearchMessages(options: {
  session: SearchSession | null | undefined;
  projectedRows?: Array<{ id: string; role: string; text: string }> | null;
  getAppendItems?: (message: SearchMessage) => SearchMessage[];
}): Array<{ id: string; role: string; text: string }> {
  const session = options.session;
  if (!session || !Array.isArray(session.timeline)) return [];
  if (Array.isArray(options.projectedRows) && options.projectedRows.length) return options.projectedRows;
  const seen = new Set<string>();
  const rows: Array<{ id: string; role: string; text: string }> = [];
  for (const id of session.timeline) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const message = session.messagesById?.get?.(id);
    if (!message || session.hiddenSet?.has?.(id)) continue;
    const text = collectBoundedSmartSearchText((visit) => {
      visitLoadedChatSearchChunks(
        session,
        { kind: 'message', value: { message } },
        visit,
        options.getAppendItems,
      );
    }, 2200, true);
    if (!text) continue;
    rows.push({ id, role: message.role || 'system', text });
  }
  return rows;
}
