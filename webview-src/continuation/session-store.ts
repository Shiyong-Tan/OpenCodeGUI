export function createSessionState() {
  return {
    hydrationCoverage: 'deltaContinuityUnknown',
    messagesById: new Map(),
    timeline: [] as string[],
    messageIndexMap: new Map(),
    segmentsByNoticeKey: new Map(),
    hiddenSet: new Set(),
    thinkingId: null,
    currentTurnAssistantKey: null,
    currentTurnAssistantMsgId: null,
    lastTurnUserId: null,
    lastTurnAssistantId: null,
    cancelledTurn: false,
    canceledActiveTurn: false,
    activeTurnOpId: null,
    backendTurnInFlight: false,
    pendingAssistantUpgrade: null,
    awaitingFinalMapBind: false,
    streamMode: null,
    seenDiffKeys: new Set(),
    assistantUpgradeSeen: new Set(),
    nextOrder: 0,
    serverIdToKey: new Map(),
    clientKeyToServerId: new Map(),
    serverIdToClientKey: new Map(),
    undoNoticeKeyByOpId: new Map(),
    pendingUndoByNoticeKey: new Map(),
    seenUndoAckOpIds: new Set(),
    pendingUndo: null,
    lastUndoNoticeKey: null,
    undoAvailable: true,
    turnFullyFinalized: true,
    appendRootUserKey: null,
    appendComposerFor: null,
    appendComposerDrafts: new Map(),
    inputDraft: '',
    hiddenControlUserIds: new Set(),
    earlyFinalAssistantId: null,
    finalAssistantLock: null,
    backgroundSubagentIndicatorVisible: false,
    backgroundSubagentIndicatorTimer: null,
    backgroundSubagentIndicatorUntil: 0,
    backgroundSubagentIndicatorAnchorId: null,
    snapshotPendingEpoch: 0,
    snapshotEmittedEpoch: 0,
    snapshotFinalizeReady: false,
  };
}

export function createSessionStore() {
  const sessions = new Map<string, ReturnType<typeof createSessionState>>();
  return Object.freeze({
    createState: createSessionState,
    get(sessionId: string | null | undefined, create = false): any | null {
      if (!sessionId) return null;
      if (!sessions.has(sessionId) && create) sessions.set(sessionId, createSessionState());
      return sessions.get(sessionId) || null;
    },
    entries() {
      return sessions.entries();
    },
    getRegistryInfo(sessionId: string) {
      return { size: sessions.size, hasSession: sessions.has(sessionId) };
    },
  });
}
