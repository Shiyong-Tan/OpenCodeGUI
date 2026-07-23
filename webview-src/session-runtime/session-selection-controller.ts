export type SessionSelectionToken = Readonly<{
  sessionId: string;
  selectionRevision: number;
  requestRevision: number;
}>;

export type SessionSelectionControllerOptions = Readonly<{
  renderSession(sessionId: string, reason: string): void;
  scrollSessionToBottom(sessionId: string, force: boolean): void;
}>;

export function createSessionSelectionController(options: SessionSelectionControllerOptions) {
  let visibleSessionId: string | null = null;
  let selectionRevision = 0;
  const requestRevisionBySession = new Map<string, number>();

  function select(sessionId: string): SessionSelectionToken {
    if (!sessionId) throw new Error('Session selection requires a sessionId');
    visibleSessionId = sessionId;
    selectionRevision += 1;
    const requestRevision = (requestRevisionBySession.get(sessionId) || 0) + 1;
    requestRevisionBySession.set(sessionId, requestRevision);
    options.renderSession(sessionId, 'session-selected');
    options.scrollSessionToBottom(sessionId, true);
    return { sessionId, selectionRevision, requestRevision };
  }

  function beginHydration(sessionId: string): SessionSelectionToken {
    if (!sessionId) throw new Error('Session hydration requires a sessionId');
    const requestRevision = (requestRevisionBySession.get(sessionId) || 0) + 1;
    requestRevisionBySession.set(sessionId, requestRevision);
    return { sessionId, selectionRevision, requestRevision };
  }

  function isCurrent(token: SessionSelectionToken): boolean {
    return token.sessionId === visibleSessionId
      && token.selectionRevision === selectionRevision
      && token.requestRevision === requestRevisionBySession.get(token.sessionId);
  }

  function commitHydration(token: SessionSelectionToken, apply: () => void): boolean {
    if (!isCurrent(token)) return false;
    apply();
    options.renderSession(token.sessionId, 'session-hydrated');
    options.scrollSessionToBottom(token.sessionId, true);
    return true;
  }

  function handleSessionUpdated(sessionId: string, reason: string): boolean {
    if (!sessionId || sessionId !== visibleSessionId) return false;
    options.renderSession(sessionId, reason);
    return true;
  }

  return Object.freeze({
    select,
    beginHydration,
    isCurrent,
    commitHydration,
    handleSessionUpdated,
    getVisibleSessionId: () => visibleSessionId,
    getSelectionRevision: () => selectionRevision,
  });
}
