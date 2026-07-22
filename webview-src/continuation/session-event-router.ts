type SessionEventRouterOptions = {
  entries(): IterableIterator<[string, any]>;
  getActiveSessionId(): string;
  postDebug(payload: unknown[]): void;
  warn(message: string, payload: unknown): void;
  render(reason: string): void;
  scroll(force: boolean, fallback?: (force: boolean) => void): void;
  singleInFlightFallbackEvents?: Set<string>;
};

export function createSessionEventRouter(options: SessionEventRouterOptions) {
  const fallbackEvents = options.singleInFlightFallbackEvents || new Set<string>();

  function findSingleInFlightSessionId(): string {
    let found = '';
    for (const [sessionId, session] of options.entries()) {
      if (!session) continue;
      if (session.backendTurnInFlight === true || session.turnFullyFinalized === false) {
        if (found) return '';
        found = sessionId;
      }
    }
    return found;
  }

  function resolveEventRoute(message: any, eventName: string, routeOptions: any = {}) {
    const payloadSessionId = message?.sessionID || message?.sessionId || message?.part?.sessionID || message?.part?.sessionId || '';
    let sessionId = payloadSessionId;
    let source = sessionId ? 'payload' : '';
    if (!sessionId && routeOptions?.allowSingleInFlightFallback === true && fallbackEvents.has(eventName)) {
      sessionId = findSingleInFlightSessionId();
      source = sessionId ? 'single-in-flight' : '';
    }
    const activeSessionId = options.getActiveSessionId();
    if (!sessionId) {
      options.postDebug(['[WV][SESSION_ROUTE_DROP]', `event=${eventName || 'unknown'}`, 'reason=missing-session', `activeSessionId=${activeSessionId || 'null'}`]);
      options.warn(`[SessionGate] drop event=${eventName} missing sessionID`, message);
      return null;
    }
    const isActive = sessionId === activeSessionId;
    const shouldRender = routeOptions?.render === false ? false : isActive;
    options.postDebug(['[WV][SESSION_ROUTE]', `event=${eventName || 'unknown'}`, `sessionId=${sessionId}`, `source=${source || 'unknown'}`, `active=${isActive ? 'true' : 'false'}`, `shouldRender=${shouldRender ? 'true' : 'false'}`]);
    return { sessionId, source: source || 'unknown', isActive, shouldRender };
  }

  function resolveParentRoute(message: any, eventName: string) {
    const parentSessionId = typeof message?.parentSessionId === 'string' ? message.parentSessionId : '';
    const agentSessionId = typeof message?.agentSessionId === 'string' ? message.agentSessionId : '';
    const displayTarget = typeof message?.displayTarget === 'string' ? message.displayTarget : '';
    const activeSessionId = options.getActiveSessionId();
    const isActiveParent = parentSessionId === activeSessionId;
    const baseLog = ['[WV][SUBAGENT_ROUTE]', `event=${eventName || 'unknown'}`, `parentSessionId=${parentSessionId || 'null'}`, `agentSessionId=${agentSessionId || 'null'}`, `displayTarget=${displayTarget || 'null'}`, `activeSessionId=${activeSessionId || 'null'}`, `isActiveParent=${isActiveParent ? 'true' : 'false'}`];
    if (!parentSessionId) {
      options.postDebug([...baseLog, 'shouldRender=false', 'decision=drop', 'reason=missing-parentSessionId']);
      options.warn(`[WV][SUBAGENT_ROUTE] drop event=${eventName || 'unknown'} reason=missing-parentSessionId`, message);
      return null;
    }
    if (displayTarget !== 'parent') {
      options.postDebug([...baseLog, 'shouldRender=false', 'decision=drop', 'reason=displayTarget-not-parent']);
      options.warn(`[WV][SUBAGENT_ROUTE] drop event=${eventName || 'unknown'} reason=displayTarget-not-parent parentSessionId=${parentSessionId}`, message);
      return null;
    }
    options.postDebug([...baseLog, `shouldRender=${isActiveParent ? 'true' : 'false'}`, `decision=${isActiveParent ? 'render' : 'state-only'}`]);
    return { parentSessionId, agentSessionId, displayTarget, isActiveParent, shouldRender: isActiveParent };
  }

  function resolveAgentLaneRoute(message: any, eventName: string) {
    const parentSessionId = typeof message?.parentSessionId === 'string' ? message.parentSessionId : '';
    const agentSessionId = typeof message?.agentSessionId === 'string' ? message.agentSessionId : '';
    const payloadSessionId = (typeof message?.sessionID === 'string' && message.sessionID)
      || (typeof message?.sessionId === 'string' && message.sessionId)
      || (typeof message?.part?.sessionID === 'string' && message.part.sessionID)
      || (typeof message?.part?.sessionId === 'string' && message.part.sessionId) || '';
    const displayTarget = typeof message?.displayTarget === 'string' ? message.displayTarget : '';
    const activeSessionId = options.getActiveSessionId();
    const isActiveAgent = agentSessionId === activeSessionId;
    const baseLog = ['[WV][SUBAGENT_ROUTE]', `event=${eventName || 'unknown'}`, `parentSessionId=${parentSessionId || 'null'}`, `agentSessionId=${agentSessionId || 'null'}`, `sessionId=${payloadSessionId || 'null'}`, `displayTarget=${displayTarget || 'null'}`, `activeSessionId=${activeSessionId || 'null'}`, `isActiveParent=${parentSessionId && parentSessionId === activeSessionId ? 'true' : 'false'}`, `isActiveAgent=${isActiveAgent ? 'true' : 'false'}`];
    if (displayTarget !== 'agent-lane') {
      options.postDebug([...baseLog, 'shouldRender=false', 'decision=drop', 'reason=displayTarget-not-agent-lane']);
      options.warn(`[WV][SUBAGENT_ROUTE] drop event=${eventName || 'unknown'} reason=displayTarget-not-agent-lane displayTarget=${displayTarget || 'null'}`, message);
      return null;
    }
    if (!agentSessionId) {
      options.postDebug([...baseLog, 'shouldRender=false', 'decision=drop', 'reason=missing-agentSessionId']);
      options.warn(`[WV][SUBAGENT_ROUTE] drop event=${eventName || 'unknown'} reason=missing-agentSessionId`, message);
      return null;
    }
    options.postDebug([...baseLog, `targetSessionId=${agentSessionId}`, `shouldRender=${isActiveAgent ? 'true' : 'false'}`, `decision=${isActiveAgent ? 'render-agent-lane' : 'state-only-agent-lane'}`, payloadSessionId && payloadSessionId !== agentSessionId ? 'note=sessionId-ignored-agentSessionId-authoritative' : 'note=agentSessionId-authoritative']);
    return { sessionId: agentSessionId, parentSessionId, agentSessionId, displayTarget, source: 'agent-lane', isActive: isActiveAgent, isActiveAgent, shouldRender: isActiveAgent };
  }

  function resolveContentRoute(message: any, eventName: string) {
    return message?.displayTarget === 'agent-lane' ? resolveAgentLaneRoute(message, eventName) : resolveEventRoute(message, eventName);
  }

  function retainAgentLaneParentAssociation(session: any, route: any): void {
    if (!session || !route || route.displayTarget !== 'agent-lane') return;
    if (!session.meta) session.meta = {};
    session.meta.agentSessionId = route.agentSessionId;
    if (route.parentSessionId) session.meta.parentSessionId = route.parentSessionId;
  }

  function logBackgroundStateUpdate(sessionId: string, reason: string, renderOptions: any = {}): void {
    const activeSessionId = options.getActiveSessionId();
    if (!sessionId || sessionId === activeSessionId) return;
    options.postDebug(['[WV][BACKGROUND_STATE_UPDATE]', `event=${reason || 'unknown'}`, `sessionId=${sessionId}`, `activeSessionId=${activeSessionId || 'null'}`, ...(Array.isArray(renderOptions.extra) ? renderOptions.extra : [])]);
  }

  function renderIfActive(sessionId: string, reason: string, renderOptions: any = {}): boolean {
    if (!sessionId || sessionId !== options.getActiveSessionId()) {
      logBackgroundStateUpdate(sessionId, reason, renderOptions);
      return false;
    }
    options.render(reason);
    if (renderOptions.scroll === true) options.scroll(renderOptions.forceScroll === true, renderOptions.scrollFallback);
    return true;
  }

  return Object.freeze({
    findSingleInFlightSessionId,
    resolveEventRoute,
    resolveParentRoute,
    resolveAgentLaneRoute,
    resolveContentRoute,
    retainAgentLaneParentAssociation,
    logBackgroundStateUpdate,
    renderIfActive,
  });
}
