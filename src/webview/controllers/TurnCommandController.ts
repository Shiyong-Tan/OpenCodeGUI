import * as vscode from 'vscode';
import * as pathModule from 'path';
import type {
    OpenCodeClient,
    ChatFilePart,
    CommitPendingTurnChangesResult,
} from '../../OpenCodeClient';
import type {
    AttachmentPayload,
    AttachmentStorageService,
    SavedAttachment,
} from '../../attachments/AttachmentStorageService';
import type { SessionMessage } from '../../changes/ChangeListInjection';
import type { FinalizeTurnIdentity } from '../../continuation/TurnIdentityResolver';
import type { CapturedCancelTurnOwner } from '../CancelTurnOwner';

type TurnCommandMessage = Record<string, any>;
type TurnCommandClient = Pick<
    OpenCodeClient,
    | 'abortSession'
    | 'appendPrompt'
    | 'beginAppendPrompt'
    | 'canAppendToCurrentTurn'
    | 'cancelTurn'
    | 'chat'
    | 'createInternalMessageId'
    | 'failAppendPrompt'
    | 'finishTurn'
    | 'getCurrentTurnCompletedAt'
    | 'getCurrentTurnStartedAt'
    | 'getPendingTurnMessageIds'
    | 'getTurnAssistantMsgId'
    | 'registerMessage'
    | 'revertPendingTurnChangesToCurrentBase'
    | 'waitForSessionIdleGate'
    | 'waitForTurnAssistantMsgId'
>;
type TurnAttachmentStorage = Pick<
    AttachmentStorageService,
    'buildAttachmentManifest' | 'isImageFileName' | 'sanitizeFilename' | 'saveAttachment'
>;
type TurnSelection = {
    model?: string;
    variant?: string;
    mode?: string;
};
type TurnDraft = {
    text: string;
    attachments: string[];
    model?: string;
    variant?: string;
    mode?: string;
};
type TurnContextItem = {
    displayText?: string;
    text?: string;
    source?: string;
    filePath?: string;
    range?: {
        startLine?: number;
        endLine?: number;
    };
};

export interface TurnCommandHost {
    readonly client: TurnCommandClient;
    readonly attachments: TurnAttachmentStorage;
    getLiveWebview(fallback: vscode.Webview): vscode.Webview;
    getCurrentSessionId(): string | undefined;
    getTurnSelection(): TurnSelection;
    log(message: string): void;
    logBridge(message: string): void;
    createTurnSession(): Promise<string>;
    trackUserOwnedSession(sessionId: string | undefined): void;
    postAddResponse(webview: vscode.Webview, value: string, meta: {
        sessionId: string;
        operationId?: string;
    }): void;
    isTurnCommandInFlight(sessionId: string): boolean;
    startTurnCommandState(
        sessionId: string,
        clientMessageId: string,
        userText: string,
        temporaryAssistantKey: string | undefined,
        operationId: string | undefined
    ): void;
    rememberDraft(clientMessageId: string, draft: TurnDraft): void;
    normalizeReferencedWorkspaceFiles(files: unknown): Promise<ChatFilePart[]>;
    bindMessageIdentity(sourceId: string, targetId: string): void;
    buildContextBlock(contextItems: TurnContextItem[]): string;
    setTurnPendingSnapshotUserText(sessionId: string, displayText: string): void;
    setTurnPendingSnapshotAttachments(sessionId: string, attachments: SavedAttachment[]): void;
    bindTurnAssistantMessage(sessionId: string, assistantMessageId: string): void;
    emitTurnFinalizePhase(
        webview: vscode.Webview,
        sessionId: string | undefined,
        phase: 'stream_done' | 'commit_done' | 'upgrade_done' | 'finalize_done'
    ): void;
    postMessageIndexMap(webview: vscode.Webview, sessionId: string): void;
    buildFinalizeTurnIdentity(
        sessionId: string,
        partial?: Partial<FinalizeTurnIdentity>
    ): FinalizeTurnIdentity;
    commitPendingTurnChangesFromAuthoritativeFiles(
        identity: FinalizeTurnIdentity
    ): Promise<CommitPendingTurnChangesResult>;
    resolvePendingUserUpgrade(sessionId: string | undefined, webview: vscode.Webview): Promise<void>;
    emitDiffFileListWithRetry(identity: FinalizeTurnIdentity, webview: vscode.Webview): Promise<void>;
    writeFinalizeSnapshotFromCurrentTurn(identity: FinalizeTurnIdentity): Promise<void>;
    clearPostFinalWatchDiffFocus(sessionId: string): void;
    markSubagentsTerminalForParent(
        sessionId: string | undefined,
        state: 'failed' | 'cancelled',
        reason: string
    ): void;
    emitSubagentStatus(): void;
    clearSubagentSessionsForParent(sessionId: string | undefined, reason: string): void;
    postModelQuota(webview: vscode.Webview, reason: string): Promise<void>;
    isTurnPendingLocalKey(sessionId: string, clientMessageId: string): boolean;
    clearDraft(clientMessageId: string): void;
    handleAbortedMessage(sessionId: string, messageId: string, webview: vscode.Webview): Promise<void>;
    clearCompletedTurnPendingUser(sessionId: string, clientMessageId: string): boolean;
    discardRevertedSegmentAfterBuild(sessionId: string): Promise<void>;
    getTurnPendingLocalKey(sessionId: string): string | undefined;
    clearFailedTurnCommandState(sessionId: string): string | undefined;
    finishTurnCommandState(sessionId: string): void;
    syncTurnInFlightAfterFinalize(
        sessionId: string,
        webview: vscode.Webview,
        reason: string
    ): void;
    runPendingSendInitGuardCompensation(
        sessionId: string,
        webview: vscode.Webview,
        reason: string
    ): Promise<void>;
    isAppendSubmissionInFlight(sessionId: string): boolean;
    markAppendSubmissionStarted(sessionId: string): void;
    markAppendSubmissionFinished(sessionId: string): void;
    cacheAppendSnapshotMeta(data: TurnCommandMessage): void;
    registerTurnTemporaryKey(sessionId: string, temporaryAssistantKey: string): void;
    captureTurnCancelOwner(payload: unknown): CapturedCancelTurnOwner;
    promptCancelRollbackDecision(webview: vscode.Webview, sessionId: string): Promise<boolean>;
    upsertCanceledTurn(sessionId: string, record: {
        opId?: string;
        localKey?: string;
        userMsgId?: string;
        assistantMsgId?: string;
        canceledAt: number;
    }): Promise<void>;
    clearTurnRawUserText(pendingLocalKey: string | undefined): void;
    clearCanceledTurnCommandState(sessionId: string): void;
    resolveMessageIdentity(messageId: string): string | undefined;
    clearCanceledTurnAssistantState(sessionId: string): void;
    consumeDraft(clientMessageId: string | undefined): TurnDraft | undefined;
}

export type TurnCommandHandler = (
    data: TurnCommandMessage,
    activeWebview: vscode.Webview,
    fallbackWebview: vscode.Webview
) => false | Promise<boolean>;

const TURN_COMMANDS = new Set([
    'sendMessage',
    'appendMessage',
    'appendSnapshotMeta',
    'registerTmpKey',
    'registerPendingUserLocal',
    'cancel',
]);

export class TurnCommandController {
    constructor(private readonly host: TurnCommandHost) {}

    public async handle(
        data: TurnCommandMessage,
        activeWebview: vscode.Webview,
        _fallbackWebview: vscode.Webview
    ): Promise<boolean> {
        const host = this.host;
        switch (data.type) {
            case "sendMessage": {
                const contextItems = Array.isArray(data.contextItems) ? data.contextItems : [];
                const hasContext = contextItems.some((item: any) => typeof item?.text === 'string' && item.text.length > 0);
                if (!data.value && !hasContext && !(Array.isArray(data.attachments) && data.attachments.length)) {
                    // host.log(`[EXT][SEND_DROP] reason=empty-value`);
                    return true;
                }
                const payloadSessionId = typeof data.sessionId === 'string' && data.sessionId.trim()
                    ? data.sessionId.trim()
                    : undefined;
                const currentSessionIdAtSend = host.getCurrentSessionId();
                const routeSource = payloadSessionId ? 'payload' : 'current';
                if (!payloadSessionId && !host.getCurrentSessionId()) {
                    // host.log(`[EXT][SEND_CREATE_SESSION] reason=no-current`);
                    try {
                        const createdSessionId = await host.createTurnSession();
                        // host.log(`[EXT][SEND_SESSION_CREATED] id=${createdSessionId}`);
                        const liveWebview = host.getLiveWebview(activeWebview);
                        liveWebview.postMessage({
                            type: 'sessionId',
                            value: createdSessionId,
                            sessionId: createdSessionId
                        });
                    }
                    catch (error) {
                        host.log(`[EXT][SEND_SESSION_CREATE_FAILED] err=${String(error)}`);
                    }
                }
                if (data.value.toLowerCase() === 'ping') {
                    const pingSessionId = payloadSessionId || host.getCurrentSessionId() || '';
                    if (pingSessionId) {
                        host.postAddResponse(activeWebview, 'PONG - Bridge is working!', { sessionId: pingSessionId });
                    }
                    else {
                        host.log('[EXT][ADD_RESPONSE_DROP] reason=missing-session-owner source=ping');
                    }
                    return true;
                }
                const targetSessionId = payloadSessionId || host.getCurrentSessionId();
                if (!targetSessionId) {
                    host.log(`[EXT][SESSION_ROUTE_DROP] event=sendMessage reason=missing-target-session reqId=pending payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} routeSource=${routeSource}`);
                    vscode.window.showErrorMessage('OpenCode Error: No active session available for send.');
                    return true;
                }
                if (payloadSessionId) {
                    host.trackUserOwnedSession(payloadSessionId);
                }
                if (host.isTurnCommandInFlight(targetSessionId)) {
                    host.log(`EXT: send.blocked | sessionId=${targetSessionId} | payloadSessionId=${payloadSessionId || 'none'} | currentSessionId=${currentSessionIdAtSend || 'none'} | routeSource=${routeSource} | reason=turn-in-flight`);
                    const liveWebview = host.getLiveWebview(activeWebview);
                    liveWebview.postMessage({ type: 'turnInFlight', sessionId: targetSessionId, inFlight: true });
                    return true;
                }
                const reqId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                const { model: targetModel, variant: targetVariant, mode: targetMode, } = host.getTurnSelection();
                let activeSendSessionId: string | undefined = targetSessionId;
                let turnClientMessageId: string | undefined;
                let turnTmpAssistantKey: string | undefined;
                try {
                    const attachments = Array.isArray(data.attachments) ? data.attachments as AttachmentPayload[] : [];
                    const attachKeys = attachments.length ? Object.keys(attachments[0] || {}).join(',') : '';
                    host.log(`EXT: send.enter | reqId=${reqId} | sessionId=${targetSessionId} | payloadSessionId=${payloadSessionId || 'none'} | currentSessionId=${currentSessionIdAtSend || 'none'} | routeSource=${routeSource} | hasAttachments=${String(Boolean(attachments.length))} | attachmentsCount=${attachments.length} | attachKeys=${attachKeys}`);
                    host.log(`[EXT][SESSION_ROUTE] event=sendMessage phase=start reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource}`);
                    const userText = (data.value as string) || '';
                    const referencedFiles = await host.normalizeReferencedWorkspaceFiles(data.files);
                    let modelText = userText;
                    const initialDraft = {
                        text: userText,
                        attachments: [],
                        model: targetModel,
                        variant: targetVariant,
                        mode: targetMode
                    };
                    const clientMessageId = data.clientMessageId || `local-${Date.now()}`;
                    const tmpAssistantKey = typeof data.tmpKey === 'string' && data.tmpKey.startsWith('tmp:') ? data.tmpKey : undefined;
                    turnClientMessageId = clientMessageId;
                    turnTmpAssistantKey = tmpAssistantKey;
                    host.log(`[EXT][TURN_BIND] phase=capture reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource} clientMessageId=${clientMessageId} tmpAssistantKey=${tmpAssistantKey || 'none'}`);
                    host.rememberDraft(clientMessageId, initialDraft);
                    const opId = typeof data.opId === 'string' ? data.opId : undefined;
                    if (targetSessionId) {
                        activeSendSessionId = targetSessionId;
                        host.startTurnCommandState(targetSessionId, clientMessageId, userText, tmpAssistantKey, opId);
                        const liveWebview = host.getLiveWebview(activeWebview);
                        liveWebview.postMessage({ type: 'turnInFlight', sessionId: targetSessionId, inFlight: true });
                    }
                    const messageIndex = host.client.registerMessage(clientMessageId, targetSessionId);
                    const liveWebview = host.getLiveWebview(activeWebview);
                    host.bindMessageIdentity(clientMessageId, clientMessageId);
                    const attachmentNames = attachments.map((item) => {
                        if (item?.filename)
                            return host.attachments.sanitizeFilename(item.filename);
                        if (item?.tempPath)
                            return pathModule.basename(item.tempPath);
                        return 'attachment';
                    });
                    const fileNames = attachmentNames.filter((name: string) => !host.attachments.isImageFileName(name));
                    const attachmentLines = fileNames.map((name: string) => `📄 ${name}`);
                    const displayText = attachmentLines.length
                        ? (userText
                            ? `${userText}

${attachmentLines.join('\n')}`
                            : attachmentLines.join('\n'))
                        : userText;
                    host.setTurnPendingSnapshotUserText(targetSessionId, displayText);
                    // Reset turn-scoped metadata before asynchronous saves so a
                    // prior failed turn can never donate attachments to this one.
                    host.setTurnPendingSnapshotAttachments(targetSessionId, []);
                    const pendingUserMessage: SessionMessage = {
                        role: 'user',
                        text: displayText,
                        id: clientMessageId,
                        messageIndex
                    };
                    const assistantMessageId = host.client.createInternalMessageId('assistant', targetSessionId);
                    const assistantMessageIndex = host.client.registerMessage(assistantMessageId, targetSessionId);
                    host.bindTurnAssistantMessage(targetSessionId, assistantMessageId);
                    liveWebview.postMessage({
                        type: 'messageAppend',
                        message: pendingUserMessage,
                        sessionId: targetSessionId
                    });
                    liveWebview.postMessage({
                        type: 'assistantMessageMeta',
                        messageId: assistantMessageId,
                        messageIndex: assistantMessageIndex,
                        sessionId: targetSessionId
                    });
                    const savedAttachments: SavedAttachment[] = [];
                    if (!attachments.length) {
                        host.log(`EXT: attach.precheck.skip | reqId=${reqId} | reason=no_attachments`);
                    }
                    else if (targetSessionId) {
                        for (const attachment of attachments) {
                            try {
                                const saved = await host.attachments.saveAttachment(targetSessionId, attachment, reqId);
                                if (saved) {
                                    savedAttachments.push(saved);
                                }
                            }
                            catch (error) {
                                host.log(`EXT: attach.save.fail | reqId=${reqId} | filename=${attachment?.filename || 'unknown'} | mime=${attachment?.mime || 'unknown'} | err=${String(error)}`);
                            }
                        }
                        host.setTurnPendingSnapshotAttachments(targetSessionId, savedAttachments);
                        if (savedAttachments.length) {
                            liveWebview.postMessage({
                                type: 'messageAttachmentsPersisted',
                                sessionId: targetSessionId,
                                messageId: clientMessageId,
                                attachments: savedAttachments.map((saved) => ({
                                    filename: saved.filename,
                                    mime: saved.mime,
                                    sizeBytes: saved.sizeBytes,
                                    path: saved.relPath,
                                })),
                                images: savedAttachments
                                    .filter((saved) => host.attachments.isImageFileName(saved.filename))
                                    .map((saved) => saved.relPath),
                            });
                        }
                        if (savedAttachments.length) {
                            const manifest = host.attachments.buildAttachmentManifest(savedAttachments);
                            modelText = modelText ? `${modelText}\n\n${manifest}` : manifest;
                        }
                        const contextBlock = host.buildContextBlock(contextItems);
                        if (contextBlock) {
                            modelText = modelText ? `${modelText}\n\n${contextBlock}` : contextBlock;
                        }
                    }
                    host.log(`EXT: send.parts.built | reqId=${reqId} | textParts=1 | manifestCount=${savedAttachments.length} | savedCount=${savedAttachments.length}`);
                    await host.client.chat(modelText, {
                        model: targetModel,
                        variant: targetVariant,
                        sessionId: targetSessionId,
                        mode: targetMode,
                        files: referencedFiles
                    });
                    await host.client.waitForSessionIdleGate(targetSessionId, {
                        sseWaitMs: 2000,
                        pollEveryMs: 2000,
                        maxPolls: 3
                    });
                    host.logBridge('[BRIDGE] Chat done');
                    host.log(`[EXT][SESSION_ROUTE] event=sendMessage phase=stream_done reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource}`);
                    let doneAssistantMsgId = host.client.getTurnAssistantMsgId(targetSessionId) || undefined;
                    if (!doneAssistantMsgId) {
                        host.log(`EXT: chatdone.guard.wait-final | sessionId=${targetSessionId} | reason=missing-assistant-msg-id`);
                        doneAssistantMsgId = await host.client.waitForTurnAssistantMsgId(targetSessionId, 500);
                        host.log(`EXT: chatdone.guard.resolved | sessionId=${targetSessionId} | assistantMsgId=${doneAssistantMsgId}`);
                    }
                    host.log(`[EXT][TURN_BIND] phase=stream_done reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource} clientMessageId=${clientMessageId} assistantMsgId=${doneAssistantMsgId || 'none'} tmpAssistantKey=${tmpAssistantKey || 'none'}`);
                    liveWebview.postMessage({
                        type: 'chatDone',
                        sessionId: targetSessionId,
                        assistantMsgId: doneAssistantMsgId,
                        lastAssistantMsgId: doneAssistantMsgId,
                        processingStartedAt: host.client.getCurrentTurnStartedAt(targetSessionId),
                        completedAt: host.client.getCurrentTurnCompletedAt(targetSessionId)
                    });
                    host.emitTurnFinalizePhase(liveWebview, targetSessionId, 'stream_done');
                    host.postMessageIndexMap(liveWebview, targetSessionId);
                    host.log(`EXT: finalize.order | sessionId=${targetSessionId} | phase=commit-start`);
                    host.log(`[EXT][SESSION_ROUTE] event=sendMessage phase=commit_start reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource}`);
                    const preCommitIdentity = host.buildFinalizeTurnIdentity(targetSessionId, {
                        reqId,
                        clientMessageId,
                        assistantMessageId: doneAssistantMsgId
                    });
                    const commitResult = await host.commitPendingTurnChangesFromAuthoritativeFiles(preCommitIdentity);
                    host.log(`EXT: finalize.order | sessionId=${targetSessionId} | phase=commit-done`);
                    host.log(`[EXT][SESSION_ROUTE] event=sendMessage phase=commit_done reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource}`);
                    host.emitTurnFinalizePhase(liveWebview, targetSessionId, 'commit_done');
                    host.log(`EXT: finalize.order | sessionId=${targetSessionId} | phase=upgrade-start`);
                    host.log(`[EXT][SESSION_ROUTE] event=sendMessage phase=upgrade_start reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource}`);
                    await host.resolvePendingUserUpgrade(targetSessionId, liveWebview);
                    host.log(`EXT: finalize.order | sessionId=${targetSessionId} | phase=upgrade-done`);
                    host.log(`[EXT][SESSION_ROUTE] event=sendMessage phase=upgrade_done reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource}`);
                    host.emitTurnFinalizePhase(liveWebview, targetSessionId, 'upgrade_done');
                    host.postMessageIndexMap(liveWebview, targetSessionId);
                    host.log(`[EXT][SESSION_ROUTE] event=sendMessage phase=diff_list_start reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource}`);
                    const finalizeIdentity = host.buildFinalizeTurnIdentity(targetSessionId, {
                        reqId,
                        clientMessageId,
                        assistantMessageId: doneAssistantMsgId,
                        commitResult
                    });
                    await host.emitDiffFileListWithRetry(finalizeIdentity, liveWebview);
                    host.log(`[EXT][SESSION_ROUTE] event=sendMessage phase=diff_list_done reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource}`);
                    await host.writeFinalizeSnapshotFromCurrentTurn(finalizeIdentity);
                    host.client.finishTurn(targetSessionId);
                    host.clearPostFinalWatchDiffFocus(targetSessionId);
                    // Do not force "done" from main finalize; only subagent final-accepted can set done.
                    // Any still-active subagents at this point are treated as cancelled.
                    host.markSubagentsTerminalForParent(targetSessionId, 'cancelled', 'main-finalize-cancel-active');
                    host.emitSubagentStatus();
                    host.clearSubagentSessionsForParent(targetSessionId, 'main-finalize-cancel-active');
                    host.log(`[EXT][SESSION_ROUTE] event=sendMessage phase=finalize_done reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource}`);
                    host.log(`[EXT][TURN_BIND] phase=finalize_done reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource} clientMessageId=${clientMessageId} assistantMsgId=${doneAssistantMsgId || 'none'} tmpAssistantKey=${tmpAssistantKey || 'none'}`);
                    host.emitTurnFinalizePhase(liveWebview, targetSessionId, 'finalize_done');
                    await host.postModelQuota(liveWebview, 'chat-done');
                    if (host.isTurnPendingLocalKey(targetSessionId, clientMessageId)) {
                        host.clearDraft(clientMessageId);
                        await host.handleAbortedMessage(targetSessionId, clientMessageId, liveWebview);
                        host.clearCompletedTurnPendingUser(targetSessionId, clientMessageId);
                    }
                    if (targetMode === 'build') {
                        await host.discardRevertedSegmentAfterBuild(targetSessionId);
                    }
                }
                catch (error) {
                    const sessionId = activeSendSessionId;
                    host.log(`[EXT][SESSION_ROUTE] event=sendMessage phase=error reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${sessionId || 'none'} routeSource=${routeSource}`);
                    host.log(`[EXT][TURN_BIND] phase=error reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${sessionId || 'none'} routeSource=${routeSource} clientMessageId=${turnClientMessageId || 'none'} tmpAssistantKey=${turnTmpAssistantKey || 'none'}`);
                    host.log(`EXT: send.abort | reqId=${reqId} | reason=${String(error)}`);
                    host.logBridge(`[BRIDGE] Error: ${error}`);
                    vscode.window.showErrorMessage(`OpenCode Error: ${error}`);
                    activeWebview.postMessage({ type: 'addResponse', value: `Error: ${error}`, sessionId, skipSnapshot: true });
                    const doneAssistantMsgId = sessionId
                        ? host.client.getTurnAssistantMsgId(sessionId)
                        : undefined;
                    activeWebview.postMessage({
                        type: 'chatDone',
                        sessionId,
                        assistantMsgId: doneAssistantMsgId,
                        lastAssistantMsgId: doneAssistantMsgId
                    });
                    host.emitTurnFinalizePhase(activeWebview, sessionId, 'stream_done');
                    if (sessionId) {
                        await host.commitPendingTurnChangesFromAuthoritativeFiles(host.buildFinalizeTurnIdentity(sessionId, {
                            reqId,
                            assistantMessageId: doneAssistantMsgId
                        }));
                        host.emitTurnFinalizePhase(activeWebview, sessionId, 'commit_done');
                    }
                    await host.resolvePendingUserUpgrade(sessionId, activeWebview);
                    host.emitTurnFinalizePhase(activeWebview, sessionId, 'upgrade_done');
                    const pendingLocalKey = sessionId ? host.getTurnPendingLocalKey(sessionId) : undefined;
                    if (sessionId && pendingLocalKey) {
                        host.clearDraft(pendingLocalKey);
                        await host.handleAbortedMessage(sessionId, pendingLocalKey, activeWebview);
                    }
                    if (sessionId) {
                        host.clearFailedTurnCommandState(sessionId);
                    }
                    if (sessionId) {
                        host.client.finishTurn(sessionId);
                    }
                    // Mark all active subagents as failed before clearing (error path)
                    host.markSubagentsTerminalForParent(sessionId, 'failed', 'main-error-finalize');
                    host.emitSubagentStatus();
                    host.clearSubagentSessionsForParent(sessionId, 'main-error-finalize');
                    host.emitTurnFinalizePhase(activeWebview, sessionId, 'finalize_done');
                    await host.postModelQuota(activeWebview, 'chat-error');
                }
                finally {
                    if (activeSendSessionId) {
                        host.finishTurnCommandState(activeSendSessionId);
                        const liveWebview = host.getLiveWebview(activeWebview);
                        liveWebview.postMessage({ type: 'turnInFlight', sessionId: activeSendSessionId, inFlight: false });
                        host.syncTurnInFlightAfterFinalize(activeSendSessionId, liveWebview, 'sendMessage.finally');
                        await host.runPendingSendInitGuardCompensation(activeSendSessionId, liveWebview, 'sendMessage.finally');
                    }
                }
                break;
            }
            case "appendMessage": {
                const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
                const value = typeof data.value === 'string' ? data.value.trim() : '';
                const clientMessageId = typeof data.clientMessageId === 'string' ? data.clientMessageId : undefined;
                const liveWebview = host.getLiveWebview(activeWebview);
                const requestedRootUserMsgId = typeof data.rootUserKey === 'string' ? data.rootUserKey : undefined;
                host.log(`[EXT][APPEND_ROUTE] rx sessionId=${sessionId || 'null'} rootUserMsgId=${requestedRootUserMsgId || 'null'} clientMessageId=${clientMessageId || 'null'} currentSessionId=${host.getCurrentSessionId() || 'null'}`);
                if (!sessionId || !requestedRootUserMsgId || !clientMessageId || !value) {
                    const reason = !sessionId || !requestedRootUserMsgId || !clientMessageId ? 'missing-route' : 'empty';
                    host.log(`[EXT][APPEND_ROUTE] rejected sessionId=${sessionId || 'null'} rootUserMsgId=${requestedRootUserMsgId || 'null'} clientMessageId=${clientMessageId || 'null'} reason=${reason}`);
                    liveWebview.postMessage({
                        type: 'appendStatus',
                        sessionId,
                        clientMessageId,
                        status: 'failed',
                        rootUserMsgId: requestedRootUserMsgId,
                        reason
                    });
                    break;
                }
                const hasTurnInFlight = host.isTurnCommandInFlight(sessionId);
                const canAppend = host.client.canAppendToCurrentTurn(sessionId, requestedRootUserMsgId);
                if (!hasTurnInFlight || !canAppend) {
                    const reason = !hasTurnInFlight ? 'turn-not-in-flight' : 'finalized';
                    host.log(`[EXT][APPEND_ROUTE] rejected sessionId=${sessionId} rootUserMsgId=${requestedRootUserMsgId} clientMessageId=${clientMessageId} reason=${reason}`);
                    liveWebview.postMessage({
                        type: 'appendStatus',
                        sessionId,
                        clientMessageId,
                        status: 'rejected',
                        rootUserMsgId: requestedRootUserMsgId,
                        reason
                    });
                    break;
                }
                if (host.isAppendSubmissionInFlight(sessionId)) {
                    host.log(`[EXT][APPEND_ROUTE] rejected sessionId=${sessionId} rootUserMsgId=${requestedRootUserMsgId} clientMessageId=${clientMessageId} reason=append-in-flight`);
                    liveWebview.postMessage({
                        type: 'appendStatus',
                        sessionId,
                        clientMessageId,
                        status: 'rejected',
                        rootUserMsgId: requestedRootUserMsgId,
                        reason: 'append-in-flight'
                    });
                    break;
                }
                const beginAppend = host.client.beginAppendPrompt(sessionId, clientMessageId, value, requestedRootUserMsgId);
                if (!beginAppend) {
                    host.log(`[EXT][APPEND_ROUTE] rejected sessionId=${sessionId} rootUserMsgId=${requestedRootUserMsgId} clientMessageId=${clientMessageId} reason=begin-rejected`);
                    liveWebview.postMessage({
                        type: 'appendStatus',
                        sessionId,
                        clientMessageId,
                        status: 'rejected',
                        rootUserMsgId: requestedRootUserMsgId,
                        reason: 'begin-rejected'
                    });
                    break;
                }
                host.markAppendSubmissionStarted(sessionId);
                host.log(`[EXT][APPEND_ROUTE] accepted sessionId=${sessionId} rootUserMsgId=${beginAppend.rootUserMsgId} clientMessageId=${clientMessageId}`);
                try {
                    const turnSelection = host.getTurnSelection();
                    await host.client.appendPrompt(sessionId, value, {
                        model: turnSelection.model,
                        mode: turnSelection.mode,
                        clientMessageId,
                        rootUserMsgId: beginAppend.rootUserMsgId
                    });
                    liveWebview.postMessage({
                        type: 'appendStatus',
                        sessionId,
                        clientMessageId,
                        rootUserMsgId: beginAppend.rootUserMsgId,
                        status: 'queued'
                    });
                }
                catch (error) {
                    host.client.failAppendPrompt(sessionId, clientMessageId);
                    liveWebview.postMessage({
                        type: 'appendStatus',
                        sessionId,
                        clientMessageId,
                        status: 'failed',
                        rootUserMsgId: beginAppend.rootUserMsgId,
                        reason: String(error)
                    });
                }
                finally {
                    host.markAppendSubmissionFinished(sessionId);
                }
                break;
            }
            case "appendSnapshotMeta": {
                host.cacheAppendSnapshotMeta(data);
                break;
            }
            case "registerTmpKey": {
                if (typeof data.sessionId !== 'string' || typeof data.tmpKey !== 'string')
                    break;
                if (!data.tmpKey.startsWith('tmp:'))
                    break;
                host.registerTurnTemporaryKey(data.sessionId, data.tmpKey);
                break;
            }
            case "registerPendingUserLocal": {
                if (typeof data.sessionId !== 'string' || typeof data.localKey !== 'string')
                    break;
                if (!data.localKey.startsWith('local-'))
                    break;
                const isInFlight = host.isTurnCommandInFlight(data.sessionId);
                host.log(`EXT: registerPendingUserLocal | sessionId=${data.sessionId} | localKey=${data.localKey} | inFlight=${String(isInFlight)}`);
                break;
            }
            case "cancel": {
                const cancelOwner = host.captureTurnCancelOwner(data);
                const cancelSessionId = cancelOwner.sessionId;
                const pendingLocalKey = cancelOwner.localKey;
                const pendingTmpKey = cancelOwner.temporaryAssistantKey;
                const pendingAssistant = cancelOwner.assistantMessageId;
                const shouldRollback = cancelSessionId
                    ? await host.promptCancelRollbackDecision(activeWebview, cancelSessionId)
                    : true;
                const restoreLocalKey = pendingLocalKey;
                if (cancelSessionId && shouldRollback) {
                    await host.client.revertPendingTurnChangesToCurrentBase(cancelSessionId);
                    const canceledAt = Date.now();
                    const { userMsgId, assistantMsgId } = host.client.getPendingTurnMessageIds(cancelSessionId);
                    await host.upsertCanceledTurn(cancelSessionId, {
                        opId: cancelOwner.operationId,
                        localKey: pendingLocalKey,
                        userMsgId,
                        assistantMsgId,
                        canceledAt
                    });
                }
                if (cancelSessionId) {
                    await host.client.abortSession(cancelSessionId);
                }
                const cancelOpId = cancelOwner.operationId;
                if (cancelSessionId) {
                    host.clearTurnRawUserText(pendingLocalKey);
                    host.client.cancelTurn(cancelSessionId, cancelOpId);
                    host.clearCanceledTurnCommandState(cancelSessionId);
                    activeWebview.postMessage({ type: 'turnInFlight', sessionId: cancelSessionId, inFlight: false });
                }
                if (cancelSessionId && pendingLocalKey) {
                    await host.handleAbortedMessage(cancelSessionId, pendingLocalKey, activeWebview);
                    const mappedUser = host.resolveMessageIdentity(pendingLocalKey);
                    if (mappedUser && mappedUser !== pendingLocalKey) {
                        await host.handleAbortedMessage(cancelSessionId, mappedUser, activeWebview);
                    }
                }
                if (cancelSessionId) {
                    const mappedAssistant = pendingTmpKey ? host.resolveMessageIdentity(pendingTmpKey) : undefined;
                    if (pendingTmpKey) {
                        await host.handleAbortedMessage(cancelSessionId, pendingTmpKey, activeWebview);
                    }
                    if (pendingAssistant) {
                        await host.handleAbortedMessage(cancelSessionId, pendingAssistant, activeWebview);
                    }
                    if (mappedAssistant && mappedAssistant !== pendingTmpKey) {
                        await host.handleAbortedMessage(cancelSessionId, mappedAssistant, activeWebview);
                    }
                    host.clearCanceledTurnAssistantState(cancelSessionId);
                }
                const draftToRestore = host.consumeDraft(restoreLocalKey);
                if (draftToRestore) {
                    activeWebview.postMessage({
                        type: 'restoreDraft',
                        sessionId: cancelSessionId,
                        payload: draftToRestore
                    });
                }
                // Cleanup before chatDone
                if (cancelSessionId) {
                    await host.commitPendingTurnChangesFromAuthoritativeFiles(host.buildFinalizeTurnIdentity(cancelSessionId, {
                        reqId: 'user-cancel',
                        assistantMessageId: host.client.getTurnAssistantMsgId(cancelSessionId)
                    }));
                }
                if (cancelSessionId) {
                    host.client.finishTurn(cancelSessionId);
                    host.clearPostFinalWatchDiffFocus(cancelSessionId);
                }
                host.markSubagentsTerminalForParent(cancelSessionId, 'cancelled', 'user-cancel');
                host.emitSubagentStatus();
                host.clearSubagentSessionsForParent(cancelSessionId, 'user-cancel');
                const doneAssistantMsgId = cancelSessionId
                    ? host.client.getTurnAssistantMsgId(cancelSessionId)
                    : undefined;
                activeWebview.postMessage({
                    type: 'chatDone',
                    sessionId: cancelSessionId,
                    assistantMsgId: doneAssistantMsgId,
                    lastAssistantMsgId: doneAssistantMsgId
                });
                if (cancelSessionId) {
                    host.syncTurnInFlightAfterFinalize(cancelSessionId, activeWebview, 'user-cancel');
                    await host.runPendingSendInitGuardCompensation(cancelSessionId, activeWebview, 'user-cancel');
                }
                break;
            }
            default:
                return false;
        }
        return true;
    }
}

export function createTurnCommandHandler(host: TurnCommandHost): TurnCommandHandler {
    const controller = new TurnCommandController(host);
    return (data, activeWebview, fallbackWebview) => {
        if (!TURN_COMMANDS.has(data?.type))
            return false;
        return controller.handle(data, activeWebview, fallbackWebview);
    };
}
