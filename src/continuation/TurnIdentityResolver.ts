import type { CommitPendingTurnChangesResult } from '../OpenCodeClient';

export type FinalizeTurnIdentity = {
    sessionId: string;
    reqId?: string;
    clientMessageId?: string;
    userMessageId?: string;
    assistantMessageId?: string;
    rootUserMessageId?: string;
    latestAppendUserMessageId?: string;
    commitResult?: CommitPendingTurnChangesResult;
};

export type TurnIdentitySource = {
    getAppendRootUserMsgId(sessionId: string): string | undefined;
    getCurrentTurnUserMsgId(sessionId: string): string | undefined;
    getLatestAppendUserMsgId(sessionId: string): string | undefined;
    getTurnAssistantMsgId(sessionId: string): string | undefined;
};

export function buildFinalizeTurnIdentity(
    source: TurnIdentitySource,
    sessionId: string,
    partial: Partial<FinalizeTurnIdentity> = {},
): FinalizeTurnIdentity {
    const rootUserMessageId = partial.rootUserMessageId
        || source.getAppendRootUserMsgId(sessionId)
        || source.getCurrentTurnUserMsgId(sessionId);
    const latestAppendUserMessageId = partial.latestAppendUserMessageId
        || source.getLatestAppendUserMsgId(sessionId);
    const userMessageId = partial.userMessageId
        || latestAppendUserMessageId
        || rootUserMessageId
        || source.getCurrentTurnUserMsgId(sessionId);
    const assistantMessageId = partial.assistantMessageId
        || source.getTurnAssistantMsgId(sessionId);
    return {
        ...partial,
        sessionId,
        userMessageId,
        assistantMessageId,
        rootUserMessageId: rootUserMessageId || userMessageId,
        latestAppendUserMessageId,
    };
}
