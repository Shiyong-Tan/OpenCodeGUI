import * as vscode from 'vscode';
import type { ConflictDetail, OpenCodeClient } from '../../OpenCodeClient';
import type { PendingConflict } from '../../session-runtime/PendingConflictStore';
import type { RevertedSegmentHistoryEntry } from '../../session-runtime/RevertedSegmentHistoryStore';
import type { SegmentState } from '../../undo/UndoSegmentPersistence';

type UndoResult = {
    conflicts: ConflictDetail[];
    touchedFiles: string[];
    applied: boolean;
    reason?: string;
};

type RevertedSegment = {
    isActive: boolean;
    discarded: boolean;
    startMessageId: string;
    startMessageIndex: number;
    endMessageId: string;
    endMessageIndex: number;
    opIds: string[];
    collapsed: boolean;
    conflicts: ConflictDetail[];
    messageIds?: string[];
    operationId?: string;
    startCommit?: string;
    startCommits?: string[];
};

type RestoreScope = {
    restoreMessageIds: string[];
    invalidMessageIds: string[];
    activeRestoreMessageIds: string[];
};

type UndoClient = Pick<
    OpenCodeClient,
    | 'discardRevertedSegment'
    | 'getRevertedSegment'
    | 'getUndoRangeForAnchor'
    | 'restoreAll'
    | 'restoreFromMessage'
    | 'setRevertedSegment'
    | 'setRevertedSegmentCollapsed'
    | 'undoFromMessage'
>;

export interface UndoCommandHost {
    client: UndoClient;
    uiDebugChannel: Pick<vscode.OutputChannel, 'appendLine'>;
    getLiveWebview(fallback: vscode.Webview): vscode.Webview;
    getCurrentSessionId(): string | undefined;
    isGitUndoEnabled(): boolean;
    isUndoBaselineReady(): boolean;
    resolveUndoMessageId(messageId: string): string;
    getUndoSegmentState(sessionId: string, noticeKey: string): SegmentState | undefined;
    setUndoSegmentState(
        sessionId: string,
        noticeKey: string,
        segment: SegmentState
    ): Promise<{ before: number; after: number }>;
    deleteUndoSegmentState(
        sessionId: string,
        noticeKey: string
    ): Promise<{ deleted: boolean; before: number; after: number }>;
    sanitizeUndoRangeMessageIds(value: unknown): string[];
    resolveUndoUiVisibleRange(
        data: unknown,
        anchorMessageId: string,
        canonicalMessageIds: string[],
        extAnchorIndex: number
    ): {
        messageIds: string[];
        source: 'webview-visible' | 'extension-canonical' | 'fallback';
        uiAnchorIndex: number;
        extAnchorIndex: number;
    };
    clearClientRevertedSegmentIfNonRestorable(sessionId: string): void;
    getInvalidSegmentMessageIds(
        sessionId: string,
        options?: {
            currentNoticeKey?: string;
            rangeStartIndex?: number;
            rangeEndIndex?: number;
            candidateMessageIds?: string[];
        }
    ): Set<string>;
    createConflictId(kind: string, operationId: string): string;
    setPendingUndoConflict(conflict: PendingConflict): void;
    getPendingUndoConflict(sessionId: string): PendingConflict | undefined;
    takePendingUndoConflict(sessionId: string): PendingConflict | undefined;
    getPendingUndoConflictCount(): number;
    appendRevertedSegmentHistory(sessionId: string, entry: RevertedSegmentHistoryEntry): void;
    trimRevertedSegmentHistory(sessionId: string, excludedMessageIds: ReadonlySet<string>): void;
    clearRevertedSegmentHistory(sessionId: string): void;
    getRevertedSegmentHistory(sessionId: string): RevertedSegmentHistoryEntry[];
    postAddResponse(
        webview: vscode.Webview,
        value: string,
        meta: { sessionId: string; operationId?: string }
    ): void;
    postMessageIndexMap(webview: vscode.Webview, sessionId: string): void;
    resolveChangeListCommits(
        sessionId: string,
        messageIds: string[] | undefined,
        fallbackCommits: string[]
    ): Promise<string[]>;
    setChangeListReverted(
        sessionId: string,
        commitHead: string,
        reverted: boolean,
        webview: vscode.Webview
    ): Promise<void>;
    persistRevertedSegment(
        sessionId: string,
        segment: RevertedSegment,
        conflicts: ConflictDetail[],
        discarded?: boolean
    ): Promise<void>;
    clearPersistedSegment(sessionId: string): Promise<void>;
    refreshDiffIfTouched(touchedFiles: string[]): void;
    buildRestoreMessageScope(
        sessionId: string,
        noticeKey: string | undefined,
        baseMessageIds: string[],
        segment?: SegmentState
    ): RestoreScope;
    applyRestoreSegmentSuccess(
        sessionId: string,
        noticeKey: string,
        anchorMsgId: string,
        endMsgId: string | undefined,
        result: UndoResult,
        commitsToClear: string[],
        operationId: string | undefined,
        webview: vscode.Webview
    ): Promise<void>;
}

export type UndoCommandHandler = (
    data: any,
    activeWebview: vscode.Webview,
    registeredWebview: vscode.Webview
) => false | Promise<true>;

const UNDO_COMMANDS = new Set([
    'undoSegmentUpsert',
    'undoSegmentRemove',
    'undoSegmentDelete',
    'undoToMessage',
    'restoreAll',
    'restoreSegment',
    'conflictDecision',
    'discardSegment',
    'setRevertedSegmentCollapsed',
]);

export function createUndoCommandHandler(host: UndoCommandHost): UndoCommandHandler {
    return (data, activeWebview, _registeredWebview) => {
        if (!UNDO_COMMANDS.has(data?.type)) {
            return false;
        }
        if (data.type === 'undoToMessage') {
            host.uiDebugChannel.appendLine(
                `[EXT][UNDO_ENTRY] type=${data.type} messageId=${data.messageId || 'NULL'} ` +
                `sessionId=${data.sessionId || 'NULL'} operationId=${data.operationId || 'NULL'} ` +
                `hasMessageId=${!!data.messageId}`
            );
        }
        return (async () => {
            switch (data.type) {
                case "undoSegmentUpsert": {
                    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
                    if (!sessionId) {
                        host.uiDebugChannel.appendLine(`[EXT][SEG_UPSERT_SKIP] reason=missing-sessionId noticeKey=${typeof data.segment?.noticeKey === 'string' ? data.segment.noticeKey : 'null'}`);
                        break;
                    }

                    const seg = data.segment;
                    if (!seg || typeof seg.noticeKey !== 'string') {
                        host.uiDebugChannel.appendLine(`[EXT][SEG_UPSERT_SKIP] reason=invalid-segment noticeKey=${typeof seg?.noticeKey === 'string' ? seg.noticeKey : 'null'}`);
                        break;
                    }

                    // Filter memberMsgIds to only msg_*
                    const memberMsgIds = Array.isArray(seg.memberMsgIds)
                        ? seg.memberMsgIds.filter((id: string) => typeof id === 'string' && id.startsWith('msg_'))
                        : [];
                    const anchorMsgId = typeof seg.anchorMsgId === 'string' && seg.anchorMsgId.startsWith('msg_')
                        ? seg.anchorMsgId
                        : (memberMsgIds[0] || '');
                    if (!anchorMsgId) {
                        host.uiDebugChannel.appendLine(`[EXT][SEGMENT_INVARIANT_FAIL] reason=missing-anchor-and-members noticeKey=${seg.noticeKey}`);
                        break;
                    }
                    if (!seg.anchorMsgId || !seg.anchorMsgId.startsWith('msg_')) {
                        host.uiDebugChannel.appendLine(`[EXT][SEGMENT_INVARIANT_FAIL] reason=invalid-anchor-fallback-used noticeKey=${seg.noticeKey} fallbackAnchor=${anchorMsgId}`);
                    }

                    host.uiDebugChannel.appendLine(
                        `[EXT][SEG_UPSERT_RX] sessionId=${sessionId} noticeKey=${seg.noticeKey} ` +
                        `anchor=${anchorMsgId} end=${seg.endMsgId || anchorMsgId} members=${memberMsgIds.length}`
                    );

                    // Create/update segment
                    const previousSegment = host.getUndoSegmentState(sessionId, seg.noticeKey);
                    const incomingRestoreAllowed = typeof seg.restoreAllowed === 'boolean' ? seg.restoreAllowed : undefined;
                    const nextRestoreAllowed = previousSegment?.restoreAllowed === false
                        ? false
                        : incomingRestoreAllowed;
                    if (previousSegment?.restoreAllowed === false && incomingRestoreAllowed === true) {
                        host.uiDebugChannel.appendLine(`[EXT][RESTORE_LOCK_MONOTONIC_FAIL] noticeKey=${seg.noticeKey} from=false to=true action=blocked`);
                    }
                    const segmentState: SegmentState = {
                        noticeKey: seg.noticeKey,
                        anchorMsgId: anchorMsgId,
                        endMsgId: seg.endMsgId || anchorMsgId,
                        memberMsgIds: memberMsgIds,
                        mergedInvalidSegments: Array.isArray(seg.mergedInvalidSegments)
                            ? seg.mergedInvalidSegments
                                .filter((child: SegmentState) => child && typeof child.noticeKey === 'string')
                                .map((child: SegmentState) => ({
                                    noticeKey: child.noticeKey,
                                    anchorMsgId: child.anchorMsgId,
                                    endMsgId: child.endMsgId,
                                    memberMsgIds: Array.isArray(child.memberMsgIds)
                                        ? child.memberMsgIds.filter((id: string) => typeof id === 'string' && id.startsWith('msg_'))
                                        : [],
                                    restoreAllowed: child.restoreAllowed,
                                    collapsed: child.collapsed,
                                    applied: child.applied,
                                    mergedInvalidSegments: [],
                                    createdAt: typeof child.createdAt === 'number' ? child.createdAt : Date.now(),
                                    updatedAt: typeof child.updatedAt === 'number' ? child.updatedAt : Date.now()
                                }))
                            : [],
                        applied: typeof seg.applied === 'boolean' ? seg.applied : undefined,
                        restoreAllowed: nextRestoreAllowed,
                        collapsed: typeof seg.collapsed === 'boolean' ? seg.collapsed : undefined,
                        createdAt: previousSegment?.createdAt || Date.now(),
                        updatedAt: Date.now()
                    };

                    const saved = await host.setUndoSegmentState(sessionId, seg.noticeKey, segmentState);

                    host.uiDebugChannel.appendLine(
                        `[EXT][SEG_UPSERT_SAVE] sessionId=${sessionId} before=${saved.before} after=${saved.after}`
                    );
                    host.uiDebugChannel.appendLine(
                        `[EXT][SEG_SAVE] noticeKey=${seg.noticeKey} restoreAllowed=${segmentState.restoreAllowed === true}`
                    );
                    break;
                }
                case "undoSegmentRemove": {
                    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
                    const noticeKey = typeof data.noticeKey === 'string' ? data.noticeKey : '';

                    if (!sessionId || !noticeKey) {
                        host.uiDebugChannel.appendLine(
                            `[EXT][SEG_REMOVE_DROP] sessionId=${sessionId || 'null'} noticeKey=${noticeKey || 'null'}`
                        );
                        break;
                    }

                    const { deleted, before, after } = await host.deleteUndoSegmentState(sessionId, noticeKey);

                    host.uiDebugChannel.appendLine(
                        `[EXT][SEG_REMOVE_SAVE] sessionId=${sessionId} noticeKey=${noticeKey} ` +
                        `deleted=${deleted} before=${before} after=${after}`
                    );
                    break;
                }
                case "undoSegmentDelete": {
                    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
                    const noticeKey = typeof data.noticeKey === 'string' ? data.noticeKey : '';
                    if (!sessionId || !noticeKey) {
                        host.uiDebugChannel.appendLine(
                            `[EXT][SEG_DELETE_RX] sessionId=${sessionId || 'null'} noticeKey=${noticeKey || 'null'}`
                        );
                        break;
                    }

                    host.uiDebugChannel.appendLine(
                        `[EXT][SEG_DELETE_RX] sessionId=${sessionId} noticeKey=${noticeKey}`
                    );

                    const { before, after } = await host.deleteUndoSegmentState(sessionId, noticeKey);

                    host.uiDebugChannel.appendLine(
                        `[EXT][SEG_DELETE_SAVE] sessionId=${sessionId} before=${before} after=${after}`
                    );
                    break;
                }
                case "undoToMessage": {
                    const payloadSessionId = typeof data.sessionId === 'string' && data.sessionId.trim() ? data.sessionId.trim() : undefined;
                    const operationId = typeof data.operationId === 'string' && data.operationId.trim() ? data.operationId.trim() : undefined;
                    const payloadMessageId = typeof data.messageId === 'string' && data.messageId.trim() ? data.messageId.trim() : undefined;
                    host.uiDebugChannel.appendLine(`[EXT][UNDO_ROUTE] phase=rx payloadSessionId=${payloadSessionId || 'null'} currentSessionId=${host.getCurrentSessionId() || 'null'} opId=${operationId || 'null'} messageId=${payloadMessageId || 'null'}`);
                    host.uiDebugChannel.appendLine(`[EXT][UNDO_CASE] messageId=${payloadMessageId || 'NULL'} checkFailed=${!payloadMessageId}`);
                    if (!payloadSessionId || !operationId || !payloadMessageId) {
                        const missing = [
                            !payloadSessionId ? 'sessionId' : undefined,
                            !operationId ? 'operationId' : undefined,
                            !payloadMessageId ? 'messageId' : undefined
                        ].filter(Boolean).join(',');
                        host.uiDebugChannel.appendLine(`[EXT][UNDO_DROP] reason=missing-${missing} payloadSessionId=${payloadSessionId || 'null'} currentSessionId=${host.getCurrentSessionId() || 'null'} opId=${operationId || 'null'} messageId=${payloadMessageId || 'null'}`);
                        return;
                    }
                    const ownerSessionId = payloadSessionId;
                    const resolvedMessageId = host.resolveUndoMessageId(payloadMessageId);
                    host.uiDebugChannel.appendLine(`[EXT][UNDO_ROUTE] phase=owner-captured ownerSessionId=${ownerSessionId} opId=${operationId} anchorMsgId=${resolvedMessageId}`);
                    if (!host.isGitUndoEnabled()) {
                        host.uiDebugChannel.appendLine(`[EXT][UNDO_TX] type=addResponse sessionId=${ownerSessionId} opId=${operationId}`);
                        host.postAddResponse(activeWebview, 'Undo unavailable: Git not installed or version too old. Please install/upgrade Git and restart VS Code.', { operationId, sessionId: ownerSessionId });
                        return;
                    }
                    if (!host.isUndoBaselineReady()) {
                        host.uiDebugChannel.appendLine(`[EXT][UNDO_TX] type=addResponse sessionId=${ownerSessionId} opId=${operationId}`);
                        host.postAddResponse(activeWebview, 'Undo unavailable: Git baseline not ready.', { operationId, sessionId: ownerSessionId });
                        return;
                    }
                    try {
                        const noticeKey = `system:undo:${resolvedMessageId}`;
                        host.uiDebugChannel.appendLine(`[EXT][UNDO_CALL] sessionId=${ownerSessionId} opId=${operationId}`);
                        host.uiDebugChannel.appendLine(`[EXT][UNDO_RX] anchorMsgId=${payloadMessageId} resolvedMsgId=${resolvedMessageId} sessionId=${ownerSessionId} opId=${operationId}`);
                        host.clearClientRevertedSegmentIfNonRestorable(ownerSessionId);
                        const previousSegment = host.client.getRevertedSegment(ownerSessionId);
                        const currentActiveNoticeKey = previousSegment?.startMessageId
                            ? `system:undo:${previousSegment.startMessageId}`
                            : undefined;
                        const undoRange = host.client.getUndoRangeForAnchor(resolvedMessageId, ownerSessionId);
                        const extAnchorIndex = typeof undoRange?.startIndex === 'number' ? undoRange.startIndex : -1;
                        const visibleMessageIds = host.sanitizeUndoRangeMessageIds(data?.visibleMessageIds);
                        const forwardMessageIdsFromAnchor = host.sanitizeUndoRangeMessageIds(data?.forwardMessageIdsFromAnchor);
                        const anchorIndex = typeof data?.anchorIndex === 'number' && Number.isFinite(data.anchorIndex)
                            ? data.anchorIndex
                            : undefined;
                        const invalidMessageIds = undoRange && undoRange.endIndex >= undoRange.startIndex
                            ? Array.from(host.getInvalidSegmentMessageIds(ownerSessionId, {
                                currentNoticeKey: currentActiveNoticeKey,
                                rangeStartIndex: undoRange.startIndex,
                                rangeEndIndex: undoRange.endIndex
                            }))
                            : [];
                        const result = await host.client.undoFromMessage(resolvedMessageId, {
                            excludedMessageIds: invalidMessageIds,
                            sessionId: ownerSessionId,
                            visibleMessageIds,
                            forwardMessageIdsFromAnchor
                        });
                        const currentSegment = host.client.getRevertedSegment(ownerSessionId);
                        host.uiDebugChannel.appendLine(`[EXT][UNDO_RESULT] applied=${result.applied} conflicts=${result.conflicts.length} touched=${result.touchedFiles.length} reason=${result.reason || 'null'} segmentStart=${currentSegment?.startMessageId || 'null'} segmentEnd=${currentSegment?.endMessageId || 'null'}`);
                        host.uiDebugChannel.appendLine(`[EXT][UNDO_DONE] applied=${result.applied} conflicts=${result.conflicts.length} sessionId=${ownerSessionId}`);
                            if (!result.applied && result.conflicts.length) {
                                const conflictId = host.createConflictId('undo', operationId);
                                host.setPendingUndoConflict({
                                    kind: 'undo',
                                    sessionId: ownerSessionId,
                                    operationId,
                                    conflictId,
                                    startMessageId: resolvedMessageId,
                                    visibleMessageIds,
                                    forwardMessageIdsFromAnchor,
                                    anchorIndex,
                                    noticeKey
                                });
                                const liveWebview = host.getLiveWebview(activeWebview);
                                host.uiDebugChannel.appendLine(`[EXT][UNDO_TX] type=conflictCard sessionId=${ownerSessionId} opId=${operationId} conflictId=${conflictId} kind=undo`);
                                host.uiDebugChannel.appendLine(`EXT: undo.postToWebview | type=conflictCard | sessionId | ${ownerSessionId} | opId | ${operationId} | conflictId | ${conflictId}`);
                                liveWebview.postMessage({
                                    type: 'conflictCard',
                                    kind: 'undo',
                                    source: 'undoToMessage',
                                    conflictId,
                                    startMessageId: resolvedMessageId,
                                    conflicts: result.conflicts,
                                    sessionId: ownerSessionId,
                                    operationId,
                                    noticeKey
                                });
                                // conflictCard provides the user-facing prompt; no extra system message needed.
                                break;
                            }
                        if (!result.applied && !result.conflicts.length) {
                            host.uiDebugChannel.appendLine(`[EXT][UNDO_CLASSIFY] kind=noop-or-missing reason=${result.reason || 'unknown'} anchor=${resolvedMessageId}`);
                            const liveWebview = host.getLiveWebview(activeWebview);
                            const finalSessionId = ownerSessionId;
                            const canonicalMessageIds = [resolvedMessageId];
                            const uiRange = host.resolveUndoUiVisibleRange(data, resolvedMessageId, canonicalMessageIds, extAnchorIndex);
                            host.uiDebugChannel.appendLine(`[EXT][UNDO_RANGE] source=${uiRange.source} sessionId=${finalSessionId || 'null'} opId=${operationId || 'null'} uiAnchorIndex=${uiRange.uiAnchorIndex} extAnchorIndex=${uiRange.extAnchorIndex} messageIds=${uiRange.messageIds.length}`);
                            if (uiRange.uiAnchorIndex >= 0 && uiRange.extAnchorIndex >= 0 && uiRange.uiAnchorIndex !== uiRange.extAnchorIndex) {
                                host.uiDebugChannel.appendLine(`[EXT][UNDO_RANGE_MISMATCH] sessionId=${finalSessionId || 'null'} opId=${operationId || 'null'} uiAnchorIndex=${uiRange.uiAnchorIndex} extAnchorIndex=${uiRange.extAnchorIndex} messageIds=${uiRange.messageIds.length}`);
                            }
                            host.uiDebugChannel.appendLine(`[EXT][UNDO_TX] type=revertedSegment sessionId=${finalSessionId || 'null'} anchorMsgId=${resolvedMessageId} endMsgId=${resolvedMessageId} applied=false opId=${operationId || 'null'} messageIds=${uiRange.messageIds.length} reason=missing-startCommit-or-noop`);
                            liveWebview.postMessage({
                                type: 'revertedSegment',
                                conflicts: [],
                                messageIds: uiRange.messageIds,
                                segment: {
                                    isActive: false,
                                    startMessageId: resolvedMessageId,
                                    startMessageIndex: -1,
                                    endMessageId: uiRange.messageIds[uiRange.messageIds.length - 1] || resolvedMessageId,
                                    endMessageIndex: -1,
                                    collapsed: true,
                                    messageIds: uiRange.messageIds,
                                    operationId,
                                    applied: false
                                },
                                sessionId: finalSessionId,
                                operationId,
                                noticeKey
                            });
                            const reasonText = result.reason === 'missing-startCommit'
                                ? 'Undo failed: commit mapping for the selected message was not found.'
                                : result.reason === 'missing-headCommit'
                                    ? 'Undo failed: repository head commit is unavailable.'
                                    : 'Undo could not be applied for the selected range.';
                            host.uiDebugChannel.appendLine(`[EXT][UNDO_TX] type=addResponse sessionId=${ownerSessionId} opId=${operationId}`);
                            host.postAddResponse(activeWebview, reasonText, { operationId, sessionId: ownerSessionId });
                            break;
                        }
                        host.uiDebugChannel.appendLine(`[EXT][UNDO_TX] type=messageIndexMap sessionId=${ownerSessionId} opId=${operationId}`);
                        host.postMessageIndexMap(activeWebview, ownerSessionId);
                        if (result.applied && previousSegment) {
                            const current = host.client.getRevertedSegment(ownerSessionId);
                            const currentSet = new Set(current?.messageIds ?? []);
                            const prevIds = previousSegment.messageIds ?? [];
                            const trimmedPrevIds = prevIds.filter((id: string) => !currentSet.has(id));
                            let historyEntry = {
                                isActive: false,
                                discarded: true,
                                startMessageId: previousSegment.startMessageId,
                                startMessageIndex: previousSegment.startMessageIndex,
                                endMessageId: previousSegment.endMessageId,
                                endMessageIndex: previousSegment.endMessageIndex,
                                collapsed: true,
                                messageIds: trimmedPrevIds,
                                operationId: previousSegment.operationId
                            };
                            if (trimmedPrevIds.length) {
                                host.appendRevertedSegmentHistory(ownerSessionId, historyEntry);
                            }
                            host.trimRevertedSegmentHistory(ownerSessionId, currentSet);
                        }
                        const segment = host.client.getRevertedSegment(ownerSessionId);
                        const liveWebview = host.getLiveWebview(activeWebview);
                        if (segment) {
                            if (operationId) {
                                segment.operationId = operationId;
                                host.client.setRevertedSegment(ownerSessionId, segment);
                            }
                            const finalSessionId = ownerSessionId;
                            const canonicalMessageIds = Array.isArray(segment.messageIds)
                                ? segment.messageIds.filter((id: string) => typeof id === 'string' && id.startsWith('msg_'))
                                : [];
                            const observedUiRange = host.resolveUndoUiVisibleRange(data, resolvedMessageId, [], extAnchorIndex);
                            const appliedMessageIds = canonicalMessageIds.length
                                ? canonicalMessageIds
                                : observedUiRange.messageIds;
                            const appliedRangeSource = canonicalMessageIds.length
                                ? 'extension-canonical'
                                : observedUiRange.source;
                            const uiSegment = {
                                ...segment,
                                endMessageId: appliedMessageIds[appliedMessageIds.length - 1] || segment.endMessageId,
                                messageIds: appliedMessageIds
                            };
                            host.uiDebugChannel.appendLine(`[EXT][UNDO_RANGE] source=${appliedRangeSource} sessionId=${finalSessionId || 'null'} opId=${operationId || 'null'} uiAnchorIndex=${observedUiRange.uiAnchorIndex} extAnchorIndex=${observedUiRange.extAnchorIndex} messageIds=${appliedMessageIds.length} uiMessageIds=${observedUiRange.messageIds.length}`);
                            if (observedUiRange.uiAnchorIndex >= 0 && observedUiRange.extAnchorIndex >= 0 && observedUiRange.uiAnchorIndex !== observedUiRange.extAnchorIndex) {
                                host.uiDebugChannel.appendLine(`[EXT][UNDO_RANGE_MISMATCH] sessionId=${finalSessionId || 'null'} opId=${operationId || 'null'} uiAnchorIndex=${observedUiRange.uiAnchorIndex} extAnchorIndex=${observedUiRange.extAnchorIndex} messageIds=${appliedMessageIds.length} uiMessageIds=${observedUiRange.messageIds.length}`);
                            }
                            host.uiDebugChannel.appendLine(`[EXT][UNDO_TX] type=revertedSegment sessionId=${finalSessionId || 'null'} anchorMsgId=${segment.startMessageId} endMsgId=${uiSegment.endMessageId} applied=true opId=${operationId || 'null'} messageIds=${appliedMessageIds.length}`);
                            liveWebview.postMessage({
                                type: 'revertedSegment',
                                conflicts: result.conflicts || [],
                                messageIds: appliedMessageIds,
                                segment: {
                                    isActive: uiSegment.isActive,
                                    startMessageId: uiSegment.startMessageId,
                                    startMessageIndex: uiSegment.startMessageIndex,
                                    endMessageId: uiSegment.endMessageId,
                                    endMessageIndex: uiSegment.endMessageIndex,
                                    collapsed: uiSegment.collapsed,
                                    messageIds: uiSegment.messageIds,
                                    operationId,
                                    historySegments: host.getRevertedSegmentHistory(ownerSessionId)
                                },
                                sessionId: finalSessionId,
                                operationId,
                                noticeKey
                            });
                            const fallbackCommits = Array.isArray(segment.startCommits) && segment.startCommits.length
                                ? segment.startCommits
                                : (segment.startCommit ? [segment.startCommit] : []);
                            const commitsToMark = finalSessionId
                                ? await host.resolveChangeListCommits(finalSessionId, segment.messageIds, fallbackCommits)
                                : [];
                            if (finalSessionId && commitsToMark.length) {
                                for (const commitHash of commitsToMark) {
                                    await host.setChangeListReverted(finalSessionId, commitHash, true, liveWebview);
                                }
                            }
                            await host.persistRevertedSegment(ownerSessionId, uiSegment, result.conflicts, false);
                        } else {
                            const finalSessionId = ownerSessionId;
                            host.uiDebugChannel.appendLine(`[EXT][UNDO_TX] type=revertedSegment sessionId=${finalSessionId || 'null'} anchorMsgId=null endMsgId=null applied=true opId=${operationId || 'null'} messageIds=0`);
                            liveWebview.postMessage({
                                type: 'revertedSegment',
                                conflicts: result.conflicts || [],
                                segment: null,
                                messageIds: [],
                                sessionId: finalSessionId,
                                operationId,
                                noticeKey
                            });
                        }
                        if (!result.touchedFiles.length) {
                            host.uiDebugChannel.appendLine(`[EXT][UNDO_TX] type=addResponse sessionId=${ownerSessionId} opId=${operationId}`);
                            host.postAddResponse(activeWebview, 'Undo applied. No tracked file changes were available to revert. The current model may not support file change tracks. Please consider use OpenAI Codex.', { operationId, sessionId: ownerSessionId });
                        } else {
                            host.uiDebugChannel.appendLine(`[EXT][UNDO_TX] type=addResponse sessionId=${ownerSessionId} opId=${operationId}`);
                            host.postAddResponse(activeWebview, 'Undo applied.', { operationId, sessionId: ownerSessionId });
                        }
                        host.refreshDiffIfTouched(result.touchedFiles);
                    } catch (error) {
                        vscode.window.showErrorMessage(`Undo failed: ${error}`);
                        host.uiDebugChannel.appendLine(`[EXT][UNDO_TX] type=error sessionId=${ownerSessionId} opId=${operationId}`);
                        const liveWebview = host.getLiveWebview(activeWebview);
                        liveWebview.postMessage({ type: 'addResponse', value: `Undo failed: ${error}`, sessionId: ownerSessionId, operationId, meta: { operationId } });
                    }
                    break;
                }
                case "restoreAll": {
                    const payloadSessionId = typeof data.sessionId === 'string' && data.sessionId.trim() ? data.sessionId.trim() : undefined;
                    const operationId = typeof data.operationId === 'string' && data.operationId.trim() ? data.operationId.trim() : undefined;
                    const noticeKey = typeof data.noticeKey === 'string' ? data.noticeKey : '';
                    host.uiDebugChannel.appendLine(`[EXT][RESTORE_ROUTE] phase=rx type=restoreAll payloadSessionId=${payloadSessionId || 'null'} currentSessionId=${host.getCurrentSessionId() || 'null'} opId=${operationId || 'null'} noticeKey=${noticeKey || 'null'}`);
                    if (!payloadSessionId || !operationId) {
                        const missing = [!payloadSessionId ? 'sessionId' : undefined, !operationId ? 'operationId' : undefined].filter(Boolean).join(',');
                        host.uiDebugChannel.appendLine(`[EXT][RESTORE_DROP] type=restoreAll reason=missing-${missing} payloadSessionId=${payloadSessionId || 'null'} currentSessionId=${host.getCurrentSessionId() || 'null'} opId=${operationId || 'null'} noticeKey=${noticeKey || 'null'}`);
                        break;
                    }
                    const ownerSessionId = payloadSessionId;
                    host.uiDebugChannel.appendLine(`[EXT][RESTORE_ROUTE] phase=owner-captured type=restoreAll ownerSessionId=${ownerSessionId} opId=${operationId} noticeKey=${noticeKey || 'null'}`);
                    try {
                        if (!host.isGitUndoEnabled()) {
                            host.uiDebugChannel.appendLine(`[EXT][RESTORE_TX] type=addResponse sessionId=${ownerSessionId} opId=${operationId} reason=git-unavailable`);
                            host.postAddResponse(activeWebview, 'Restore unavailable: Git not installed or version too old. Please install/upgrade Git and restart VS Code.', { operationId, sessionId: ownerSessionId });
                            break;
                        }
                        const currentSegment = host.client.getRevertedSegment(ownerSessionId);
                        const fallbackCommits = Array.isArray(currentSegment?.startCommits) && currentSegment?.startCommits?.length
                            ? currentSegment.startCommits
                            : (currentSegment?.startCommit ? [currentSegment.startCommit] : []);
                        const commitsToClear = ownerSessionId
                            ? await host.resolveChangeListCommits(ownerSessionId, currentSegment?.messageIds, fallbackCommits)
                            : fallbackCommits;
                        const result = await host.client.restoreAll({ sessionId: ownerSessionId });
                        if (!result.applied && result.conflicts.length) {
                            const conflictId = host.createConflictId('restore', operationId);
                            host.setPendingUndoConflict({ kind: 'restore', sessionId: ownerSessionId, operationId, conflictId, noticeKey });
                            const liveWebview = host.getLiveWebview(activeWebview);
                            host.uiDebugChannel.appendLine(`[EXT][RESTORE_TX] type=conflictCard sessionId=${ownerSessionId} opId=${operationId} conflictId=${conflictId} kind=restore noticeKey=${noticeKey || 'null'}`);
                            liveWebview.postMessage({
                                type: 'conflictCard',
                                kind: 'restore',
                                source: 'restoreAll',
                                conflictId,
                                conflicts: result.conflicts,
                                sessionId: ownerSessionId,
                                operationId,
                                noticeKey
                            });
                            // conflictCard provides the user-facing prompt; no extra system message needed.
                            break;
                        }
                        activeWebview.postMessage({
                            type: 'restoredSegment',
                            noticeKey: typeof data.noticeKey === 'string' ? data.noticeKey : '',
                            applied: result.applied,
                            conflicts: result.conflicts,
                            sessionId: ownerSessionId,
                            operationId
                        });
                        host.uiDebugChannel.appendLine(`[EXT][RESTORE_TX] type=restoredSegment sessionId=${ownerSessionId} opId=${operationId} noticeKey=${noticeKey || 'null'} applied=${result.applied}`);
                        host.client.discardRevertedSegment(ownerSessionId);
                        const discardedSegment = host.client.getRevertedSegment(ownerSessionId);
                        host.uiDebugChannel.appendLine(`[EXT][RESTORE_TX] type=revertedSegmentDiscarded sessionId=${ownerSessionId} opId=${operationId}`);
                        activeWebview.postMessage({
                            type: 'revertedSegmentDiscarded',
                            segment: discardedSegment ? { ...discardedSegment, historySegments: host.getRevertedSegmentHistory(ownerSessionId) } : discardedSegment,
                            sessionId: ownerSessionId,
                            operationId
                        });
                        if (ownerSessionId) {
                            await host.clearPersistedSegment(ownerSessionId);
                        }
                        if (ownerSessionId && commitsToClear.length) {
                            for (const commitHash of commitsToClear) {
                                await host.setChangeListReverted(ownerSessionId, commitHash, false, activeWebview);
                            }
                        }
                        host.uiDebugChannel.appendLine(`[EXT][RESTORE_TX] type=addResponse sessionId=${ownerSessionId} opId=${operationId}`);
                        host.postAddResponse(activeWebview, 'Restore applied.', { operationId, sessionId: ownerSessionId });
                        host.refreshDiffIfTouched(result.touchedFiles);
                        if (ownerSessionId) {
                            await host.clearPersistedSegment(ownerSessionId);
                        }
                    } catch (error) {
                        vscode.window.showErrorMessage(`Restore failed: ${error}`);
                        host.uiDebugChannel.appendLine(`[EXT][RESTORE_TX] type=error sessionId=${ownerSessionId} opId=${operationId}`);
                        activeWebview.postMessage({ type: 'addResponse', value: `Restore failed: ${error}`, sessionId: ownerSessionId, operationId, meta: { operationId, sessionId: ownerSessionId } });
                    }
                    break;
                }
                case "restoreSegment": {
                    const payloadSessionId = typeof data.sessionId === 'string' && data.sessionId.trim() ? data.sessionId.trim() : undefined;
                    const operationId = typeof data.operationId === 'string' && data.operationId.trim() ? data.operationId.trim() : undefined;
                    const anchorMsgId = typeof data.anchorMsgId === 'string' && data.anchorMsgId.trim() ? data.anchorMsgId.trim() : '';
                    const noticeKey = typeof data.noticeKey === 'string' ? data.noticeKey : '';
                    const endMsgId = typeof data.endMsgId === 'string' ? data.endMsgId : undefined;
                    host.uiDebugChannel.appendLine(`[EXT][RESTORE_ROUTE] phase=rx type=restoreSegment payloadSessionId=${payloadSessionId || 'null'} currentSessionId=${host.getCurrentSessionId() || 'null'} opId=${operationId || 'null'} noticeKey=${noticeKey || 'null'} anchorMsgId=${anchorMsgId || 'null'} endMsgId=${endMsgId || 'null'}`);
                    if (!payloadSessionId || !operationId || !anchorMsgId) {
                        const missing = [!payloadSessionId ? 'sessionId' : undefined, !operationId ? 'operationId' : undefined, !anchorMsgId ? 'anchorMsgId' : undefined].filter(Boolean).join(',');
                        host.uiDebugChannel.appendLine(`[EXT][RESTORE_DROP] type=restoreSegment reason=missing-${missing} payloadSessionId=${payloadSessionId || 'null'} currentSessionId=${host.getCurrentSessionId() || 'null'} opId=${operationId || 'null'} noticeKey=${noticeKey || 'null'} anchorMsgId=${anchorMsgId || 'null'} endMsgId=${endMsgId || 'null'}`);
                        break;
                    }
                    const ownerSessionId = payloadSessionId;
                    host.uiDebugChannel.appendLine(`[EXT][RESTORE_ROUTE] phase=owner-captured type=restoreSegment ownerSessionId=${ownerSessionId} opId=${operationId} noticeKey=${noticeKey || 'null'} anchorMsgId=${anchorMsgId} endMsgId=${endMsgId || 'null'}`);
                    try {
                        const currentSegment = host.client.getRevertedSegment(ownerSessionId);
                        const persistedSegment = noticeKey
                            ? host.getUndoSegmentState(ownerSessionId, noticeKey)
                            : undefined;
                        const messageIds = Array.isArray(persistedSegment?.memberMsgIds) && persistedSegment?.memberMsgIds?.length
                            ? persistedSegment.memberMsgIds
                            : (Array.isArray(currentSegment?.messageIds) ? currentSegment?.messageIds : []);
                        const restoreScope = host.buildRestoreMessageScope(ownerSessionId, noticeKey, messageIds, persistedSegment);
                        const fallbackCommits = Array.isArray(currentSegment?.startCommits) && currentSegment?.startCommits?.length
                            ? currentSegment.startCommits
                            : (currentSegment?.startCommit ? [currentSegment.startCommit] : []);
                        const commitsToClear = ownerSessionId
                            ? await host.resolveChangeListCommits(ownerSessionId, restoreScope.activeRestoreMessageIds, fallbackCommits)
                            : fallbackCommits;
                            const result = await host.client.restoreFromMessage(anchorMsgId, endMsgId, {
                                sessionId: ownerSessionId,
                                messageIds: restoreScope.activeRestoreMessageIds,
                                excludedMessageIds: restoreScope.invalidMessageIds
                            });
                        const liveWebview = host.getLiveWebview(activeWebview);
                        host.uiDebugChannel.appendLine(`[EXT][RESTORE_TX] type=restoredSegment sessionId=${ownerSessionId} opId=${operationId} noticeKey=${noticeKey || 'null'} applied=${result.applied}`);
                        if (result.applied) {
                            await host.applyRestoreSegmentSuccess(
                                ownerSessionId,
                                noticeKey,
                                anchorMsgId,
                                endMsgId,
                                result,
                                commitsToClear,
                                operationId,
                                liveWebview
                            );
                        } else if (result.conflicts.length) {
                            const conflictId = host.createConflictId('restoreSegment', operationId);
                            host.setPendingUndoConflict({ kind: 'restoreSegment', sessionId: ownerSessionId, operationId, conflictId, startMessageId: anchorMsgId, endMessageId: endMsgId, noticeKey });
                            host.uiDebugChannel.appendLine(`[EXT][RESTORE_TX] type=conflictCard sessionId=${ownerSessionId} opId=${operationId} conflictId=${conflictId} kind=restoreSegment noticeKey=${noticeKey || 'null'} anchorMsgId=${anchorMsgId} endMsgId=${endMsgId || 'null'}`);
                            liveWebview.postMessage({
                                type: 'conflictCard',
                                kind: 'restoreSegment',
                                source: 'restoreSegment',
                                conflictId,
                                conflicts: result.conflicts,
                                sessionId: ownerSessionId,
                                operationId,
                                noticeKey,
                                startMessageId: anchorMsgId,
                                endMessageId: endMsgId
                            });
                            // conflictCard provides the user-facing prompt; no extra system message needed.
                        }
                    } catch (error) {
                        vscode.window.showErrorMessage(`Restore failed: ${error}`);
                        host.uiDebugChannel.appendLine(`[EXT][RESTORE_TX] type=error sessionId=${ownerSessionId} opId=${operationId} noticeKey=${noticeKey || 'null'} anchorMsgId=${anchorMsgId}`);
                        activeWebview.postMessage({ type: 'addResponse', value: `Restore failed: ${error}`, sessionId: ownerSessionId, operationId, meta: { operationId, sessionId: ownerSessionId } });
                    }
                    break;
                }
                case "conflictDecision": {
                    const decision = (data.decision === 'override' || data.decision === 'continue' || data.decision === 'skip' || data.decision === 'cancel')
                        ? data.decision as 'override' | 'skip' | 'continue' | 'cancel'
                        : undefined;
                    const payloadSessionId = typeof data.sessionId === 'string' && data.sessionId.trim() ? data.sessionId.trim() : undefined;
                    const operationId = typeof data.operationId === 'string' && data.operationId.trim() ? data.operationId.trim() : undefined;
                    const conflictId = typeof data.conflictId === 'string' && data.conflictId.trim() ? data.conflictId.trim() : undefined;
                    const kind = typeof data.kind === 'string' && data.kind.trim() ? data.kind.trim() : undefined;
                    host.uiDebugChannel.appendLine(`[EXT][CONFLICT_ROUTE] phase=rx decision=${decision || 'null'} payloadSessionId=${payloadSessionId || 'null'} currentSessionId=${host.getCurrentSessionId() || 'null'} opId=${operationId || 'null'} conflictId=${conflictId || 'null'} kind=${kind || 'null'}`);
                    if (!decision || !payloadSessionId || !operationId || !conflictId || !kind) {
                        const missing = [!decision ? 'decision' : undefined, !payloadSessionId ? 'sessionId' : undefined, !operationId ? 'operationId' : undefined, !conflictId ? 'conflictId' : undefined, !kind ? 'kind' : undefined].filter(Boolean).join(',');
                        host.uiDebugChannel.appendLine(`[EXT][CONFLICT_DROP] reason=missing-${missing} payloadSessionId=${payloadSessionId || 'null'} opId=${operationId || 'null'} conflictId=${conflictId || 'null'} kind=${kind || 'null'} pendingCount=${host.getPendingUndoConflictCount()}`);
                        break;
                    }
                    const pendingConflict = host.getPendingUndoConflict(payloadSessionId);
                    if (!pendingConflict) {
                        host.uiDebugChannel.appendLine(`[EXT][CONFLICT_DROP] reason=no-pending sessionId=${payloadSessionId} opId=${operationId} conflictId=${conflictId} kind=${kind} decision=${decision}`);
                        break;
                    }
                    if (
                        pendingConflict.operationId !== operationId ||
                        pendingConflict.conflictId !== conflictId ||
                        pendingConflict.kind !== kind
                    ) {
                        host.uiDebugChannel.appendLine(`[EXT][CONFLICT_DROP] reason=owner-mismatch payloadSessionId=${payloadSessionId} payloadOpId=${operationId} payloadConflictId=${conflictId} payloadKind=${kind} pendingSessionId=${pendingConflict.sessionId} pendingOpId=${pendingConflict.operationId} pendingConflictId=${pendingConflict.conflictId} pendingKind=${pendingConflict.kind} decision=${decision}`);
                        break;
                    }
                    const conflictContext = host.takePendingUndoConflict(payloadSessionId);
                    if (!conflictContext) break;
                    const ownerSessionId = conflictContext.sessionId;
                    host.uiDebugChannel.appendLine(`[EXT][CONFLICT_ROUTE] phase=owner-validated sessionId=${ownerSessionId} opId=${conflictContext.operationId} conflictId=${conflictContext.conflictId} kind=${conflictContext.kind} decision=${decision}`);
                    if (decision === 'cancel' || decision === 'skip') {
                        // skip means abandon the operation; do nothing.
                        host.uiDebugChannel.appendLine(`[EXT][CONFLICT_TX] type=skip sessionId=${ownerSessionId} opId=${conflictContext.operationId} conflictId=${conflictContext.conflictId} kind=${conflictContext.kind} decision=${decision}`);
                        break;
                    }
                    try {
                        if (conflictContext.kind === 'undo' && conflictContext.startMessageId) {
                            host.clearClientRevertedSegmentIfNonRestorable(ownerSessionId);
                            const previousSegment = host.client.getRevertedSegment(ownerSessionId);
                            const currentActiveNoticeKey = previousSegment?.startMessageId
                                ? `system:undo:${previousSegment.startMessageId}`
                                : undefined;
                            const undoRange = host.client.getUndoRangeForAnchor(conflictContext.startMessageId, ownerSessionId);
                            const invalidMessageIds = undoRange && undoRange.endIndex >= undoRange.startIndex
                                ? Array.from(host.getInvalidSegmentMessageIds(ownerSessionId, {
                                    currentNoticeKey: currentActiveNoticeKey,
                                    rangeStartIndex: undoRange.startIndex,
                                    rangeEndIndex: undoRange.endIndex
                                }))
                                : [];
                            const visibleMessageIds = Array.isArray(conflictContext.visibleMessageIds)
                                ? conflictContext.visibleMessageIds
                                : host.sanitizeUndoRangeMessageIds(data?.visibleMessageIds);
                            const forwardMessageIdsFromAnchor = Array.isArray(conflictContext.forwardMessageIdsFromAnchor)
                                ? conflictContext.forwardMessageIdsFromAnchor
                                : host.sanitizeUndoRangeMessageIds(data?.forwardMessageIdsFromAnchor);
                            host.uiDebugChannel.appendLine(`[EXT][CONFLICT_RETRY] kind=undo sessionId=${ownerSessionId} opId=${conflictContext.operationId} conflictId=${conflictContext.conflictId} uiRange=${visibleMessageIds.length} forward=${forwardMessageIdsFromAnchor.length}`);
                            const result = await host.client.undoFromMessage(conflictContext.startMessageId, {
                                force: true,
                                excludedMessageIds: invalidMessageIds,
                                sessionId: ownerSessionId,
                                visibleMessageIds,
                                forwardMessageIdsFromAnchor
                            });
                            if (result.applied && previousSegment) {
                                const historyEntry = {
                                    isActive: false,
                                    discarded: true,
                                    startMessageId: previousSegment.startMessageId,
                                    startMessageIndex: previousSegment.startMessageIndex,
                                    endMessageId: previousSegment.endMessageId,
                                    endMessageIndex: previousSegment.endMessageIndex,
                                    collapsed: true,
                                    messageIds: previousSegment.messageIds,
                                    operationId: previousSegment.operationId
                                };
                                host.appendRevertedSegmentHistory(ownerSessionId, historyEntry);
                            }
                            const segment = host.client.getRevertedSegment(ownerSessionId);
                            if (segment) {
                                if (conflictContext.operationId) {
                                    segment.operationId = conflictContext.operationId;
                                    host.client.setRevertedSegment(ownerSessionId, segment);
                                }
                                activeWebview.postMessage({
                                    type: 'revertedSegment',
                                    conflicts: result.conflicts || [],
                                    segment: {
                                        isActive: segment.isActive,
                                        startMessageId: segment.startMessageId,
                                        startMessageIndex: segment.startMessageIndex,
                                        endMessageId: segment.endMessageId,
                                        endMessageIndex: segment.endMessageIndex,
                                        collapsed: segment.collapsed,
                                        messageIds: segment.messageIds,
                                        operationId: conflictContext.operationId,
                                        historySegments: host.getRevertedSegmentHistory(ownerSessionId)
                                    },
                                    sessionId: ownerSessionId,
                                    operationId: conflictContext.operationId,
                                    conflictId: conflictContext.conflictId
                                });
                                await host.persistRevertedSegment(ownerSessionId, segment, result.conflicts, false);
                            }
                            host.uiDebugChannel.appendLine(`[EXT][CONFLICT_TX] type=addResponse sessionId=${ownerSessionId} opId=${conflictContext.operationId} conflictId=${conflictContext.conflictId} kind=undo`);
                            host.postAddResponse(activeWebview, 'Undo applied.', { operationId: conflictContext.operationId, sessionId: ownerSessionId });
                            host.refreshDiffIfTouched(result.touchedFiles);
                        }
                        if (conflictContext.kind === 'restore') {
                            const result = await host.client.restoreAll({ force: true, sessionId: ownerSessionId });
                            host.clearRevertedSegmentHistory(ownerSessionId);
                            host.uiDebugChannel.appendLine(`[EXT][CONFLICT_TX] type=revertedSegment sessionId=${ownerSessionId} opId=${conflictContext.operationId} conflictId=${conflictContext.conflictId} kind=restore`);
                            activeWebview.postMessage({
                                type: 'revertedSegment',
                                conflicts: result.conflicts || [],
                                segment: {
                                    historySegments: host.getRevertedSegmentHistory(ownerSessionId),
                                    messageIds: [],
                                    isActive: false,
                                    discarded: false,
                                    collapsed: true,
                                    startMessageId: '',
                                    startMessageIndex: 0,
                                    endMessageId: '',
                                    endMessageIndex: 0
                                },
                                sessionId: ownerSessionId,
                                operationId: conflictContext.operationId,
                                conflictId: conflictContext.conflictId
                            });
                            host.client.discardRevertedSegment(ownerSessionId);
                            const discardedSegment = host.client.getRevertedSegment(ownerSessionId);
                            host.uiDebugChannel.appendLine(`[EXT][CONFLICT_TX] type=revertedSegmentDiscarded sessionId=${ownerSessionId} opId=${conflictContext.operationId} conflictId=${conflictContext.conflictId} kind=restore`);
                            activeWebview.postMessage({
                                type: 'revertedSegmentDiscarded',
                                segment: discardedSegment ? { ...discardedSegment, historySegments: host.getRevertedSegmentHistory(ownerSessionId) } : discardedSegment,
                                sessionId: ownerSessionId,
                                operationId: conflictContext.operationId,
                                conflictId: conflictContext.conflictId
                            });
                            await host.clearPersistedSegment(ownerSessionId);
                            host.uiDebugChannel.appendLine(`[EXT][CONFLICT_TX] type=addResponse sessionId=${ownerSessionId} opId=${conflictContext.operationId} conflictId=${conflictContext.conflictId} kind=restore`);
                            host.postAddResponse(activeWebview, 'Restore applied.', { operationId: conflictContext.operationId, sessionId: ownerSessionId });
                            host.refreshDiffIfTouched(result.touchedFiles);
                        }
                        if (conflictContext.kind === 'restoreSegment' && conflictContext.startMessageId) {
                            const currentSegment = host.client.getRevertedSegment(ownerSessionId);
                            const persistedSegment = conflictContext.noticeKey
                                ? host.getUndoSegmentState(ownerSessionId, conflictContext.noticeKey)
                                : undefined;
                            const messageIds = Array.isArray(persistedSegment?.memberMsgIds) && persistedSegment?.memberMsgIds?.length
                                ? persistedSegment.memberMsgIds
                                : (Array.isArray(currentSegment?.messageIds) ? currentSegment?.messageIds : []);
                            const restoreScope = host.buildRestoreMessageScope(ownerSessionId, conflictContext.noticeKey, messageIds, persistedSegment);
                            const result = await host.client.restoreFromMessage(
                                conflictContext.startMessageId,
                                conflictContext.endMessageId,
                                {
                                    force: true,
                                    sessionId: ownerSessionId,
                                    messageIds: restoreScope.activeRestoreMessageIds,
                                    excludedMessageIds: restoreScope.invalidMessageIds
                                }
                            );
                            if (conflictContext.noticeKey) {
                                const currentSegment = host.client.getRevertedSegment(ownerSessionId);
                                const fallbackCommits = Array.isArray(currentSegment?.startCommits) && currentSegment?.startCommits?.length
                                    ? currentSegment.startCommits
                                    : (currentSegment?.startCommit ? [currentSegment.startCommit] : []);
                                const commitsToClear = await host.resolveChangeListCommits(ownerSessionId, restoreScope.activeRestoreMessageIds, fallbackCommits);
                                host.uiDebugChannel.appendLine(`[EXT][CONFLICT_TX] type=applyRestoreSegmentSuccess sessionId=${ownerSessionId} opId=${conflictContext.operationId} conflictId=${conflictContext.conflictId} kind=restoreSegment noticeKey=${conflictContext.noticeKey || 'null'}`);
                                await host.applyRestoreSegmentSuccess(
                                    ownerSessionId,
                                    conflictContext.noticeKey,
                                    conflictContext.startMessageId,
                                    conflictContext.endMessageId,
                                    result,
                                    commitsToClear,
                                    conflictContext.operationId,
                                    activeWebview
                                );
                            }
                        }
                    } catch (error) {
                        vscode.window.showErrorMessage(`Conflict resolution failed: ${error}`);
                        host.uiDebugChannel.appendLine(`[EXT][CONFLICT_TX] type=error sessionId=${ownerSessionId} opId=${conflictContext.operationId} conflictId=${conflictContext.conflictId} kind=${conflictContext.kind}`);
                        activeWebview.postMessage({ type: 'addResponse', value: `Conflict resolution failed: ${error}`, sessionId: ownerSessionId, operationId: conflictContext.operationId, meta: { operationId: conflictContext.operationId, sessionId: ownerSessionId } });
                    }
                    break;
                }
                case "discardSegment": {
                    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
                    if (!sessionId) {
                        host.uiDebugChannel.appendLine('[EXT][DISCARD_DROP] reason=missing-session-owner');
                        break;
                    }
                    host.uiDebugChannel.appendLine(`[EXT][DISCARD_SEND] reason=explicit_user_action sessionId=${sessionId}`);
                    host.client.discardRevertedSegment(sessionId);
                    const discardedSegment = host.client.getRevertedSegment(sessionId);
                    activeWebview.postMessage({
                        type: 'revertedSegmentDiscarded',
                        segment: discardedSegment ? { ...discardedSegment, historySegments: host.getRevertedSegmentHistory(sessionId) } : discardedSegment,
                        sessionId
                    });
                    host.postAddResponse(activeWebview, 'Reverted segment discarded.', { sessionId });
                    if (sessionId) {
                        const segment = host.client.getRevertedSegment(sessionId);
                        if (segment) {
                            await host.persistRevertedSegment(sessionId, segment, segment.conflicts || [], true);
                        }
                    }
                    break;
                }
                case "setRevertedSegmentCollapsed": {
                    if (typeof data.collapsed !== 'boolean') return;
                    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
                    if (!sessionId) {
                        host.uiDebugChannel.appendLine('[EXT][SEGMENT_COLLAPSE_DROP] reason=missing-session-owner');
                        break;
                    }
                    host.client.setRevertedSegmentCollapsed(sessionId, data.collapsed);
                    const segment = host.client.getRevertedSegment(sessionId);
                    activeWebview.postMessage({
                        type: 'revertedSegmentState',
                        segment: segment
                            ? { ...segment, historySegments: host.getRevertedSegmentHistory(sessionId) }
                            : null,
                        sessionId
                    });
                    break;
                }
            }
        })().then(() => true as const);
    };
}
