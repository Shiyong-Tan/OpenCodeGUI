type AppendSnapshotControllerOptions = {
  resolveMessageKey(session: any, key: unknown): string | null;
  getSession(sessionId: string): any;
  postMessage(message: unknown): void;
};

export type AppendFinalizeResult = { items: any[]; changed: boolean };
export type AppendHydrationResult = { rootCount: number; appendCount: number; restoredRootUserKey: string };

export function createAppendSnapshotController(options: AppendSnapshotControllerOptions) {
  function sanitizeItem(item: any, session: any): Record<string, unknown> | null {
    if (!item || typeof item !== 'object') return null;
    const output: Record<string, unknown> = {};
    const copyString = (name: string, maxLength = 20_000) => {
      const value = item[name];
      if (typeof value === 'string' && value.length > 0) output[name] = value.slice(0, maxLength);
    };
    copyString('clientMessageId', 512);
    copyString('status', 64);
    copyString('reason', 1_000);
    copyString('text', 20_000);
    const appendUserMsgId = options.resolveMessageKey(session, item.appendUserMsgId) || item.appendUserMsgId;
    if (typeof appendUserMsgId === 'string' && appendUserMsgId.length && !appendUserMsgId.startsWith('local-') && !appendUserMsgId.startsWith('tmp:')) {
      output.appendUserMsgId = appendUserMsgId;
    }
    const rootUserMsgId = options.resolveMessageKey(session, item.rootUserMsgId) || item.rootUserMsgId;
    if (typeof rootUserMsgId === 'string' && rootUserMsgId.length && !rootUserMsgId.startsWith('local-') && !rootUserMsgId.startsWith('tmp:')) {
      output.rootUserMsgId = rootUserMsgId;
    }
    if (typeof item.createdAt === 'number' && Number.isFinite(item.createdAt)) output.createdAt = item.createdAt;
    if (typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt)) output.updatedAt = item.updatedAt;
    return Object.keys(output).length ? output : null;
  }

  function sanitizeItems(items: unknown, session: any): Array<Record<string, unknown>> {
    if (!Array.isArray(items)) return [];
    const output: Array<Record<string, unknown>> = [];
    const seen = new Set<unknown>();
    for (const item of items) {
      const sanitized = sanitizeItem(item, session);
      if (!sanitized) continue;
      const dedupeKey = sanitized.clientMessageId || sanitized.appendUserMsgId || `${output.length}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      output.push(sanitized);
    }
    return output;
  }

  function normalizeItemsForFinalize(items: unknown): AppendFinalizeResult {
    if (!Array.isArray(items)) return { items: [], changed: false };
    let changed = false;
    const normalized = items.map((item) => {
      if (!item || typeof item !== 'object') return item;
      if (item.status === 'applied' || item.status === 'failed' || item.status === 'rejected') return item;
      if (item.status === 'seen' || ((item.status === 'queued' || item.status === 'sending') && item.appendUserMsgId)) {
        changed = true;
        return { ...item, status: 'applied' };
      }
      if (item.status === 'sending' || item.status === 'queued') {
        changed = true;
        return { ...item, status: 'failed', reason: item.reason || 'append-not-acknowledged' };
      }
      return item;
    });
    return { items: normalized, changed };
  }

  function normalizeSessionForFinalize(session: any): boolean {
    if (!session || !(session.messagesById instanceof Map)) return false;
    let changed = false;
    for (const message of session.messagesById.values()) {
      if (!message || message.role !== 'user' || !Array.isArray(message.meta?.appendedPrompts)) continue;
      const result = normalizeItemsForFinalize(message.meta.appendedPrompts);
      if (!result.changed) continue;
      message.meta = { ...(message.meta || {}), appendedPrompts: result.items };
      changed = true;
    }
    return changed;
  }

  function collect(session: any): any[] {
    if (!session || !(session.messagesById instanceof Map)) return [];
    const entries: any[] = [];
    const seenRoots = new Set<string>();
    for (const message of session.messagesById.values()) {
      if (!message || message.role !== 'user') continue;
      const items = sanitizeItems(message.meta?.appendedPrompts, session);
      if (!items.length) continue;
      const rootMessageId = options.resolveMessageKey(session, message.id) || message.id;
      if (typeof rootMessageId !== 'string' || !rootMessageId.length || rootMessageId.startsWith('local-') || rootMessageId.startsWith('tmp:')) continue;
      if (seenRoots.has(rootMessageId)) continue;
      seenRoots.add(rootMessageId);
      entries.push({ rootMessageId, appendRootUserKey: rootMessageId, meta: { appendedPrompts: items } });
    }
    return entries;
  }

  function hasProtectedInflightRoot(session: any): boolean {
    if (!session || !(session.messagesById instanceof Map)) return false;
    if (session.backendTurnInFlight !== true || session.turnFullyFinalized === true || session.canceledActiveTurn === true) return false;
    if (typeof session.finalAssistantLock?.assistantMsgId === 'string' && session.finalAssistantLock.assistantMsgId.length) return false;
    const key = session.appendRootUserKey;
    if (typeof key !== 'string' || !key.length) return false;
    const candidates = new Set<string>([key]);
    const resolved = options.resolveMessageKey(session, key);
    if (typeof resolved === 'string' && resolved.length) candidates.add(resolved);
    const mappedServer = session.clientKeyToServerId?.get?.(key);
    if (typeof mappedServer === 'string' && mappedServer.length) candidates.add(mappedServer);
    const mappedClient = session.serverIdToClientKey?.get?.(key);
    if (typeof mappedClient === 'string' && mappedClient.length) candidates.add(mappedClient);
    for (const candidate of candidates) {
      if (session.messagesById.get(candidate)?.role === 'user') return true;
    }
    return false;
  }

  function sync(sessionId: string, reason = 'unknown'): void {
    if (typeof sessionId !== 'string' || !sessionId.length) return;
    const session = options.getSession(sessionId);
    if (!session) return;
    const roots = collect(session);
    if (!roots.length) return;
    options.postMessage({ type: 'appendSnapshotMeta', sessionId, roots, reason });
    options.postMessage({
      type: 'ui-debug',
      payload: ['[WV][APPEND_SNAPSHOT_META]', `sessionId=${sessionId}`, `reason=${reason}`, `rootCount=${roots.length}`, `appendCount=${roots.reduce((sum, root) => sum + (Array.isArray(root.meta?.appendedPrompts) ? root.meta.appendedPrompts.length : 0), 0)}`],
    });
  }

  function restore(sessionId: string, session: any): AppendHydrationResult {
    if (!session || !(session.messagesById instanceof Map)) return { rootCount: 0, appendCount: 0, restoredRootUserKey: '' };
    let rootCount = 0;
    let appendCount = 0;
    let restoredRootUserKey = '';
    const protectInflightAppendRoot = hasProtectedInflightRoot(session);
    const shouldNormalizeFinalizedAppendItems = session.turnFullyFinalized === true;
    for (const message of session.messagesById.values()) {
      if (!message || message.role !== 'user') continue;
      let items = sanitizeItems(message.meta?.appendedPrompts, session);
      if (!items.length) continue;
      if (shouldNormalizeFinalizedAppendItems) items = normalizeItemsForFinalize(items).items;
      message.meta = { ...(message.meta || {}), appendedPrompts: items };
      rootCount++;
      appendCount += items.length;
      if (!restoredRootUserKey && typeof message.id === 'string' && message.id.length && !message.id.startsWith('local-') && !message.id.startsWith('tmp:')) {
        restoredRootUserKey = message.id;
      }
    }
    if (restoredRootUserKey && !protectInflightAppendRoot) session.appendRootUserKey = restoredRootUserKey;
    if (rootCount > 0) {
      options.postMessage({
        type: 'ui-debug',
        payload: ['[WV][APPEND_HYDRATE_META]', `sessionId=${sessionId || 'null'}`, `rootCount=${rootCount}`, `appendCount=${appendCount}`, `appendRootUserKey=${restoredRootUserKey || 'null'}`],
      });
    }
    return { rootCount, appendCount, restoredRootUserKey };
  }

  function getItems(message: any): any[] {
    return Array.isArray(message?.meta?.appendedPrompts) ? message.meta.appendedPrompts : [];
  }

  function canAppend(session: any, message: any, activeSessionId: string | null | undefined): boolean {
    if (!session || !message || message.role !== 'user' || !activeSessionId) return false;
    if (session.backendTurnInFlight !== true || session.turnFullyFinalized === true || session.canceledActiveTurn === true) return false;
    if (session.finalAssistantLock?.assistantMsgId) return false;
    return Boolean(session.appendRootUserKey && message.id === session.appendRootUserKey);
  }

  function hasBlockingSubmission(message: any): boolean {
    return getItems(message).some((item) => item && item.status === 'sending');
  }

  function resolveRootMessage(session: any, message: any): any | null {
    if (!session?.messagesById) return null;
    const clientMessageId = typeof message?.clientMessageId === 'string' ? message.clientMessageId : '';
    if (clientMessageId) {
      for (const candidate of session.messagesById.values()) {
        if (candidate?.role === 'user' && getItems(candidate).some((item) => item?.clientMessageId === clientMessageId)) return candidate;
      }
    }
    const keys: string[] = [];
    const addKey = (key: unknown) => {
      if (typeof key !== 'string' || !key || keys.includes(key)) return;
      keys.push(key);
      for (const mapped of [
        session.serverIdToClientKey?.get?.(key),
        session.clientKeyToServerId?.get?.(key),
        session.serverIdToKey?.get?.(key),
      ]) {
        if (typeof mapped === 'string' && mapped && !keys.includes(mapped)) keys.push(mapped);
      }
    };
    addKey(message?.rootUserMsgId);
    addKey(session.appendRootUserKey);
    addKey(session.lastTurnUserId);
    for (const key of keys) {
      const candidate = session.messagesById.get(key);
      if (candidate?.role === 'user') return candidate;
    }
    return null;
  }

  function upsertItem(message: any, item: any): any | null {
    if (!message) return null;
    if (!message.meta) message.meta = {};
    const items = Array.isArray(message.meta.appendedPrompts) ? [...message.meta.appendedPrompts] : [];
    const index = items.findIndex((entry) =>
      (item.clientMessageId && entry.clientMessageId === item.clientMessageId)
      || (item.appendUserMsgId && entry.appendUserMsgId === item.appendUserMsgId));
    const existing = index >= 0 ? items[index] : {};
    const statusRank: Record<string, number> = { sending: 1, queued: 2, seen: 3, applied: 4, failed: 10, rejected: 10 };
    let status = item.status || existing.status;
    if (existing.status && item.status) {
      status = (statusRank[item.status] || 0) >= (statusRank[existing.status] || 0) ? item.status : existing.status;
    }
    const next = { ...existing, ...item, status };
    if (index >= 0) items[index] = next;
    else items.push(next);
    const seenClientMessageIds = new Set<string>();
    message.meta.appendedPrompts = items.filter((entry, entryIndex) => {
      if (!entry?.clientMessageId) return true;
      if (entryIndex === index) {
        seenClientMessageIds.add(entry.clientMessageId);
        return true;
      }
      if (seenClientMessageIds.has(entry.clientMessageId)) return false;
      seenClientMessageIds.add(entry.clientMessageId);
      return true;
    });
    return next;
  }

  function markSeenByAssistantParent(session: any, parentId: string): boolean {
    if (!session || !parentId || !(session.messagesById instanceof Map)) return false;
    for (const message of session.messagesById.values()) {
      const items = getItems(message);
      const parentIndex = items.findIndex((entry) => entry?.appendUserMsgId === parentId);
      if (parentIndex < 0) continue;
      let changed = false;
      for (let index = 0; index <= parentIndex; index++) {
        const item = items[index];
        if (!item?.appendUserMsgId || ['seen', 'applied', 'failed', 'rejected'].includes(item.status)) continue;
        upsertItem(message, {
          clientMessageId: item.clientMessageId,
          appendUserMsgId: item.appendUserMsgId,
          status: 'seen',
        });
        changed = true;
      }
      return changed;
    }
    return false;
  }

  return Object.freeze({
    sanitizeItem,
    sanitizeItems,
    normalizeItemsForFinalize,
    normalizeSessionForFinalize,
    collect,
    hasProtectedInflightRoot,
    sync,
    restore,
    getItems,
    canAppend,
    hasBlockingSubmission,
    resolveRootMessage,
    upsertItem,
    markSeenByAssistantParent,
  });
}
