export type CancelTurnOwnerSource = Readonly<{
    currentSessionId?: string;
    pendingLocalKeyBySession: ReadonlyMap<string, string>;
    pendingAssistantTmpKeyBySession: ReadonlyMap<string, string>;
    pendingAssistantMessageIdBySession: ReadonlyMap<string, string>;
}>;

export type CapturedCancelTurnOwner = Readonly<{
    sessionId?: string;
    operationId?: string;
    localKey?: string;
    temporaryAssistantKey?: string;
    assistantMessageId?: string;
}>;

export function captureCancelTurnOwner(
    payload: unknown,
    source: CancelTurnOwnerSource,
): CapturedCancelTurnOwner {
    const record = payload && typeof payload === 'object'
        ? payload as Record<string, unknown>
        : {};
    const explicitSessionId = typeof record.sessionId === 'string' && record.sessionId.trim()
        ? record.sessionId.trim()
        : undefined;
    const sessionId = explicitSessionId || source.currentSessionId;
    const operationId = typeof record.opId === 'string' && record.opId.trim()
        ? record.opId.trim()
        : undefined;
    if (!sessionId) return { operationId };
    return {
        sessionId,
        operationId,
        localKey: source.pendingLocalKeyBySession.get(sessionId),
        temporaryAssistantKey: source.pendingAssistantTmpKeyBySession.get(sessionId),
        assistantMessageId: source.pendingAssistantMessageIdBySession.get(sessionId),
    };
}
