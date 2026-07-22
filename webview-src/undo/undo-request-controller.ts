type UndoSession = any;

export function createUndoRequestController(options: {
  getSession(sessionId: string): UndoSession | null | undefined;
  getActiveSessionId(): string;
  getSessionRegistryInfo(sessionId: string): { size: number; hasSession: boolean };
  isPersistenceArtifact(id: string, message: any): boolean;
  upsertMessage(session: UndoSession, message: any): void;
  assertInvariants(sessionId: string, reason: string): void;
  render(): void;
  postMessage(message: any): void;
  setTimeout(callback: () => void, delayMs: number): any;
  clearTimeout(handle: any): void;
  now(): number;
  random(): number;
  timeoutMs: number;
}) {
  const createOperationId = (): string => `op_${options.now()}_${options.random().toString(36).slice(2, 8)}`;

  const isRangeVisibleMessageId = (session: UndoSession, id: unknown): id is string => {
    if (typeof id !== 'string' || !id.startsWith('msg_')) return false;
    if (session?.hiddenSet instanceof Set && session.hiddenSet.has(id)) return false;
    const message = session?.messagesById instanceof Map ? session.messagesById.get(id) : null;
    if (options.isPersistenceArtifact(id, message)) return false;
    const kind = message?.meta?.kind;
    return kind !== 'undoNotice' && kind !== 'snapshotNotice' && kind !== 'changeList';
  };

  const buildVisibleRangeSnapshot = (session: UndoSession, anchorMsgId: string) => {
    const timeline = Array.isArray(session?.timeline) ? session.timeline : [];
    const visibleMessageIds: string[] = [];
    for (const id of timeline) if (isRangeVisibleMessageId(session, id)) visibleMessageIds.push(id);
    const anchorIndex = visibleMessageIds.indexOf(anchorMsgId);
    return {
      visibleMessageIds,
      anchorIndex,
      forwardMessageIdsFromAnchor: anchorIndex >= 0 ? visibleMessageIds.slice(anchorIndex) : [],
    };
  };

  const suspendTimeoutForConflictCard = (payload: any): boolean => {
    if (!payload || typeof payload.operationId !== 'string' || !payload.operationId) return false;
    const kind = typeof payload.kind === 'string' ? payload.kind : '';
    if (kind && kind !== 'undo') return false;
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : options.getActiveSessionId();
    const session = options.getSession(sessionId);
    const pending = session?.pendingUndo;
    if (!pending || pending.clientOpId !== payload.operationId) return false;
    if (pending.timeoutId) {
      options.clearTimeout(pending.timeoutId);
      pending.timeoutId = null;
    }
    pending.status = 'waiting-conflict-decision';
    pending.conflictId = typeof payload.conflictId === 'string' ? payload.conflictId : '';
    pending.conflictKind = kind || 'undo';
    options.postMessage({
      type: 'ui-debug',
      payload: ['undo', 'timeout-suspended-conflict', 'clientOpId', pending.clientOpId, 'sessionId', sessionId || 'null', 'conflictId', pending.conflictId || 'null'],
    });
    return true;
  };

  const handleTimeout = (sessionId: string, clientOpId: string): void => {
    const session = options.getSession(sessionId);
    if (!session || !session.pendingUndo) return;
    if (session.pendingUndo.clientOpId !== clientOpId) {
      options.postMessage({ type: 'ui-debug', payload: ['undo', 'timeout-skip', 'clientOpId', clientOpId || 'null', 'stillPending', false] });
      return;
    }
    if (session.pendingUndo.status === 'waiting-conflict-decision') {
      options.postMessage({ type: 'ui-debug', payload: ['undo', 'timeout-skip-conflict', 'clientOpId', clientOpId || 'null', 'sessionId', sessionId || 'null'] });
      return;
    }
    const { clientOpId: opId, anchorKey } = session.pendingUndo;
    const elapsed = options.now() - session.pendingUndo.ts;
    if (elapsed < options.timeoutMs) return;
    if (!session.pendingUndo || session.pendingUndo.clientOpId !== clientOpId) {
      options.postMessage({ type: 'ui-debug', payload: ['undo', 'timeout-skip', 'clientOpId', clientOpId || 'null', 'stillPending', false] });
      return;
    }
    const timeoutKey = `system:undo-timeout:${opId}`;
    options.upsertMessage(session, {
      id: timeoutKey,
      role: 'system',
      text: 'Undo request timed out (code state losts.).',
      meta: { kind: 'undoTimeout', opId, anchorKey },
    });
    if (!session.timeline.includes(timeoutKey)) session.timeline.push(timeoutKey);
    const stillPending = Boolean(session.pendingUndo && session.pendingUndo.clientOpId === opId);
    session.pendingUndo = null;
    if (session.pendingUndoByNoticeKey?.size) {
      for (const [key, pending] of session.pendingUndoByNoticeKey.entries()) {
        if (pending?.clientOpId === opId) session.pendingUndoByNoticeKey.delete(key);
      }
    }
    options.postMessage({ type: 'ui-debug', payload: ['undo', 'timeout', 'clientOpId', opId, 'elapsed', elapsed, 'sessionId', sessionId, 'stillPending', stillPending] });
    options.render();
  };

  const handleUndoToMessage = (sessionId: string, targetMessageId: string): void => {
    try {
      const activeSessionId = options.getActiveSessionId();
      options.postMessage({ type: 'ui-debug', payload: ['[WV][UNDO_FUNC_ENTER]', 'sessionId', sessionId || 'NULL', 'typeof', typeof sessionId, 'targetMessageId', targetMessageId || 'NULL', 'activeSessionId', activeSessionId || 'NULL'] });
      const session = options.getSession(sessionId);
      options.postMessage({ type: 'ui-debug', payload: ['[WV][UNDO_AFTER_GET_SESSION]', 'hasSession', !!session, 'sessionType', typeof session] });
      if (!session) {
        const registry = options.getSessionRegistryInfo(sessionId);
        options.postMessage({ type: 'ui-debug', payload: ['[WV][UNDO_FUNC_NO_SESSION]', 'sessionId', sessionId || 'NULL', 'activeSessionId', activeSessionId || 'NULL', 'mapSize', registry.size, 'hasSession', registry.hasSession] });
        return;
      }
      const target = session.messagesById.get(targetMessageId);
      if (!target) {
        options.postMessage({ type: 'ui-debug', payload: ['undo', 'target-not-found', targetMessageId, 'sessionId', sessionId] });
        return;
      }
      const opId = createOperationId();
      const serverId = targetMessageId;
      const noticeKey = `system:undo:${serverId}`;
      session.undoNoticeKeyByOpId.set(opId, noticeKey);
      session.lastUndoNoticeKey = noticeKey;
      session.pendingUndo = {
        clientOpId: opId,
        ackOpId: null,
        anchorKey: targetMessageId,
        anchorServerId: serverId,
        noticeKey,
        ts: options.now(),
        status: 'waiting-response',
        timeoutId: null,
      };
      session.pendingUndoByNoticeKey = session.pendingUndoByNoticeKey || new Map();
      session.pendingUndoByNoticeKey.set(noticeKey, {
        clientOpId: opId,
        anchorKey: targetMessageId,
        anchorServerId: serverId,
        noticeKey,
        createdAt: options.now(),
      });
      options.postMessage({ type: 'ui-debug', payload: ['WV', 'undo', 'send', 'clientOpId', opId, 'anchorKey', targetMessageId, 'serverId', serverId, 'noticeKey', noticeKey, 'sessionId', sessionId] });
      options.postMessage({ type: 'ui-debug', payload: ['undo.send', 'clientOpId', opId, 'noticeKey', noticeKey, 'anchorMsgId', targetMessageId, 'sessionId', sessionId] });
      options.postMessage({ type: 'ui-debug', payload: ['WV', 'undo', 'pending', 'noticeKey', noticeKey, 'clientOpId', opId, 'sessionId', sessionId] });
      options.postMessage({ type: 'ui-debug', payload: ['[WV][UNDO_PRE_SEND]', 'sessionId', sessionId || 'NULL', 'opId', opId || 'NULL', 'serverId', serverId || 'NULL', 'typeof_sessionId', typeof sessionId, 'typeof_opId', typeof opId, 'typeof_serverId', typeof serverId] });
      const range = buildVisibleRangeSnapshot(session, serverId);
      options.postMessage({ type: 'ui-debug', payload: ['[WV][UNDO_RANGE_TX]', `sessionId=${sessionId || 'null'}`, `opId=${opId || 'null'}`, `anchorIndex=${range.anchorIndex}`, `visibleCount=${range.visibleMessageIds.length}`, `forwardCount=${range.forwardMessageIdsFromAnchor.length}`] });
      const undoMessage = {
        type: 'undoToMessage', sessionId, operationId: opId, messageId: serverId,
        visibleMessageIds: range.visibleMessageIds, anchorIndex: range.anchorIndex,
        forwardMessageIdsFromAnchor: range.forwardMessageIdsFromAnchor,
      };
      options.postMessage({ type: 'ui-debug', payload: ['[WV][UNDO_MSG_OBJ]', JSON.stringify(undoMessage)] });
      options.postMessage({ type: 'ping' });
      options.postMessage(undoMessage);
      options.postMessage({ type: 'ui-debug', payload: ['[WV][UNDO_POST_SEND]', 'sent'] });
      session.pendingUndo.timeoutId = options.setTimeout(() => handleTimeout(sessionId, opId), options.timeoutMs);
    } catch (error) {
      const details = error as { message?: string; stack?: string } | null;
      options.postMessage({ type: 'ui-debug', payload: ['[WV][UNDO_ERROR]', 'error', String(error), 'message', details?.message || 'unknown', 'stack', details?.stack || 'no-stack'] });
      throw error;
    }
  };

  const handleRestoreSegment = (sessionId: string, segmentId: string): void => {
    const session = options.getSession(sessionId);
    if (!session) {
      options.postMessage({ type: 'ui-debug', payload: ['[WV][RESTORE_DROP]', 'session-not-found', `sessionId=${sessionId || 'null'}`] });
      return;
    }
    const noticeKey = segmentId.startsWith('seg:') ? segmentId.slice(4) : segmentId;
    const segment = session.segmentsByNoticeKey.get(noticeKey);
    if (!segment) {
      options.postMessage({ type: 'ui-debug', payload: ['[WV][RESTORE_DROP]', 'segment-not-found', `noticeKey=${noticeKey}`] });
      return;
    }
    const operationId = createOperationId();
    options.postMessage({
      type: 'restoreSegment', sessionId, operationId, noticeKey: segment.noticeKey,
      anchorMsgId: segment.anchorMsgId, endMsgId: segment.endMsgId,
    });
    options.postMessage({
      type: 'ui-debug',
      payload: ['[WV][SEG_RESTORE_SEND]', `sessionId=${sessionId || 'null'}`, `opId=${operationId || 'null'}`, `noticeKey=${noticeKey}`, `anchorMsgId=${segment.anchorMsgId || 'null'}`, `endMsgId=${segment.endMsgId || 'null'}`, 'type=restoreSegment'],
    });
  };

  const handleToggleSegment = (sessionId: string, segmentId: string): void => {
    const session = options.getSession(sessionId);
    if (!session) return;
    const segment = session.segmentsByNoticeKey.get(segmentId);
    if (!segment) return;
    segment.collapsed = !segment.collapsed;
    options.assertInvariants(sessionId, 'toggleSegment');
  };

  const togglePlaceholder = (sessionId: string, noticeKey: string): any => {
    const session = options.getSession(sessionId);
    if (!session || !noticeKey) return null;
    const segment = session.segmentsByNoticeKey.get(noticeKey);
    if (!segment) return null;
    segment.collapsed = !segment.collapsed;
    return segment;
  };

  return {
    createOperationId,
    isRangeVisibleMessageId,
    buildVisibleRangeSnapshot,
    suspendTimeoutForConflictCard,
    handleUndoToMessage,
    handleTimeout,
    handleRestoreSegment,
    handleToggleSegment,
    togglePlaceholder,
  };
}
