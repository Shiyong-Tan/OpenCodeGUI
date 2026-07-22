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

export type ChangeListMessageTarget = {
    postMessage(message: unknown): unknown;
};

export class ChangeListEmitter {
    constructor(private readonly emitLegacy: (
        identity: FinalizeTurnIdentity,
        target: ChangeListMessageTarget,
    ) => Promise<void>) {}

    async emit(identity: FinalizeTurnIdentity, target: ChangeListMessageTarget): Promise<void> {
        await this.emitLegacy(identity, target);
    }
}
