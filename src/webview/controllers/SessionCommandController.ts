import * as vscode from 'vscode';
import type { SessionMessage } from '../../changes/ChangeListInjection';
import type { SegmentState } from '../../undo/UndoSegmentPersistence';
import { isEmptyForkBoundarySnapshot } from '../../history/ForkSnapshotBoundary';

type SessionCommandMessage = Record<string, any>;
type HydrationCoverage =
    | 'authoritativeHistoryComplete'
    | 'deltaContinuityUnknown'
    | 'repairInProgress'
    | 'repairError';

type FormattedSession = { title: string; messages: SessionMessage[] };
type RecentAppendClassification = { proven: boolean; suffix: SessionMessage[] };
type FullSnapshotDelta = {
    messages: SessionMessage[];
    timelineMessageIds: string[];
    proven: boolean;
    repairedSnapshot?: boolean;
};

export interface SessionCommandHost {
    getLiveWebview(fallback: vscode.Webview): vscode.Webview;
    log(message: string): void;
    refreshSessions(webview: vscode.Webview, requestId: string): Promise<void>;
    forkSession(sessionId: string): Promise<{ id: string }>;
    renameSession(sessionId: string, title: string): Promise<{ id: string; title: string }>;
    persistSessionTitle(sessionId: string, title: string): Promise<void>;
    initializeForkSnapshot(sourceSessionId: string, childSessionId: string): Promise<void>;
    hasActiveTurn(sessionId: string): boolean;
    getSessionChildren(sessionId: string): Promise<unknown[]>;
    deleteSession(sessionId: string): Promise<boolean>;
    cleanupDeletedSessionArtifacts(sessionId: string): Promise<void>;
    clearRecentSessionIfMatches(sessionId: string): Promise<void>;
    clearSelectedSessionAfterDelete(sessionId: string): void;
    startSessionSelection(targetSessionId: string): number;
    adoptSessionSelection(targetSessionId: string): void;
    isSessionSelectionCurrent(targetSessionId: string, selectionEpoch: number): boolean;
    applyAppendSnapshotMeta(sessionId: string, messagesById: Map<string, SessionMessage>): void;
    persistRecentSessionSelection(sessionId: string | undefined): Promise<void>;
    hydrateSessionUndoPresentation(
        sessionId: string,
        webview: vscode.Webview
    ): Promise<SegmentState[]>;
    readSnapshot(sessionId: string): Promise<{ obj: any; bytes: number } | null>;
    injectChangeLists(sessionId: string, formatted: FormattedSession): Promise<FormattedSession>;
    getSnapshotTimelineIds(sessionData: any, messages: SessionMessage[]): string[];
    getSnapshotFile(sessionId: string): string;
    exportSessionRecent(sessionId: string, limit: number): Promise<unknown>;
    getRecentSessionLoadLimit(): number;
    formatSession(exportData: unknown): FormattedSession;
    getMaxMessageIndex(messages: SessionMessage[]): number | null;
    classifyRecentAppendCandidates(
        snapshotIds: Set<string>,
        snapshotMaxMessageIndex: number | null,
        recentMessages: SessionMessage[]
    ): RecentAppendClassification;
    isSnapshotDeltaContinuityRepairEnabled(): boolean;
    buildImmutableSnapshotWithProvenSuffix(
        baseMessages: SessionMessage[],
        suffix: SessionMessage[]
    ): SessionMessage[];
    extractLastLine(text: string): string;
    exportSession(sessionId: string): Promise<unknown>;
    collectSnapshotRepairRequiredMessageIds(sessionId: string): Promise<string[]>;
    buildFullExportSnapshotDelta(
        baseMessages: SessionMessage[],
        snapshotTimelineIds: string[],
        fullExportMessages: SessionMessage[],
        repairRequiredMessageIds: string[]
    ): FullSnapshotDelta;
    persistStructurallyRepairedSnapshot(
        sessionId: string,
        title: string,
        messages: SessionMessage[],
        timelineMessageIds: string[],
        segments: SegmentState[]
    ): Promise<void>;
    postAddResponse(webview: vscode.Webview, value: string, meta: { sessionId: string }): void;
    prepareNewSession(): Promise<undefined>;
    initializeNewSessionBaseline(webview: vscode.Webview): Promise<void>;
    handleSnapshotTimelineIds(payload: unknown): Promise<void>;
}

export type SessionCommandHandler = (
    data: SessionCommandMessage,
    activeWebview: vscode.Webview,
    resolvingWebview: vscode.Webview
) => false | Promise<boolean>;

const SESSION_COMMANDS = new Set([
    'refreshSessions',
    'deleteSession',
    'selectSession',
    'forkSession',
    'renameSession',
    'newSession',
    'snapshotTimelineIds',
]);

export class SessionCommandController {
    constructor(private readonly host: SessionCommandHost) {}

    public async handle(
        data: SessionCommandMessage,
        activeWebview: vscode.Webview,
        resolvingWebview: vscode.Webview
    ): Promise<boolean> {
        switch (data.type) {
            case 'refreshSessions':
                await this.host.refreshSessions(resolvingWebview, data.requestId || '');
                return true;
            case 'deleteSession':
                await this.deleteSession(data, activeWebview);
                return true;
            case 'selectSession':
                await this.selectSession(data, activeWebview);
                return true;
            case 'forkSession':
                await this.forkSession(data, activeWebview);
                return true;
            case 'renameSession':
                await this.renameSession(data, activeWebview);
                return true;
            case 'newSession':
                await this.newSession(activeWebview);
                return true;
            case 'snapshotTimelineIds':
                await this.host.handleSnapshotTimelineIds(data.payload);
                return true;
            default:
                return false;
        }
    }

    private async deleteSession(data: SessionCommandMessage, activeWebview: vscode.Webview): Promise<void> {
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        const opId = typeof data.opId === 'string' ? data.opId : '';
        if (!sessionId) return;
        const liveWebview = this.host.getLiveWebview(activeWebview);
        liveWebview.postMessage({ type: 'sessionDeleteStarted', sessionId, opId });

        try {
            const children = await this.host.getSessionChildren(sessionId);
            if (children.length > 0) {
                this.host.log(
                    `[EXT][SESSION_DELETE_CHILDREN] sessionId=${sessionId} count=${children.length}`
                );
            }

            let deletedOnServer = false;
            try {
                deletedOnServer = await this.host.deleteSession(sessionId);
            } catch (error) {
                const text = String(error || '');
                if (/\b404\b/.test(text) || text.includes('NotFoundError')) {
                    deletedOnServer = true;
                } else {
                    throw error;
                }
            }
            if (!deletedOnServer) throw new Error('Delete session returned false');

            await this.host.cleanupDeletedSessionArtifacts(sessionId);
            await this.host.clearRecentSessionIfMatches(sessionId);
            this.host.clearSelectedSessionAfterDelete(sessionId);
            await this.host.refreshSessions(liveWebview, `delete-${Date.now()}`);
            liveWebview.postMessage({ type: 'sessionDeleted', sessionId, opId });
        } catch (error) {
            this.host.log(
                `[EXT][SESSION_DELETE_FAIL] sessionId=${sessionId} opId=${opId || 'null'} err=${String(error)}`
            );
            vscode.window.showErrorMessage(`Failed to delete session: ${error}`);
            liveWebview.postMessage({
                type: 'sessionDeleteFailed',
                sessionId,
                opId,
                reason: String(error),
            });
        }
    }

    private async forkSession(data: SessionCommandMessage, activeWebview: vscode.Webview): Promise<void> {
        const sourceSessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        const opId = typeof data.opId === 'string' ? data.opId : '';
        if (!sourceSessionId) return;
        const liveWebview = this.host.getLiveWebview(activeWebview);

        if (this.host.hasActiveTurn(sourceSessionId)) {
            liveWebview.postMessage({
                type: 'sessionForkFailed',
                sourceSessionId,
                opId,
                reason: 'active_turn',
            });
            return;
        }

        try {
            const forked = await this.host.forkSession(sourceSessionId);
            await this.host.initializeForkSnapshot(sourceSessionId, forked.id);
            liveWebview.postMessage({
                type: 'sessionForked',
                sourceSessionId,
                sessionId: forked.id,
                opId,
            });
            await this.host.refreshSessions(liveWebview, `fork-${Date.now()}`);
        } catch (error) {
            this.host.log(
                `[EXT][SESSION_FORK_FAIL] sourceSessionId=${sourceSessionId} opId=${opId || 'null'} err=${String(error)}`
            );
            vscode.window.showErrorMessage(`Failed to create session branch: ${error}`);
            liveWebview.postMessage({
                type: 'sessionForkFailed',
                sourceSessionId,
                opId,
                reason: String(error),
            });
        }
    }

    private async renameSession(data: SessionCommandMessage, activeWebview: vscode.Webview): Promise<void> {
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
        const title = typeof data.title === 'string' ? data.title.trim() : '';
        const opId = typeof data.opId === 'string' ? data.opId : '';
        const liveWebview = this.host.getLiveWebview(activeWebview);
        if (!sessionId || !title) {
            liveWebview.postMessage({
                type: 'sessionRenameFailed',
                sessionId,
                opId,
                reason: 'invalid_title',
            });
            return;
        }
        try {
            const renamed = await this.host.renameSession(sessionId, title);
            try {
                await this.host.persistSessionTitle(sessionId, renamed.title);
            } catch (snapshotError) {
                this.host.log(
                    `[EXT][SESSION_RENAME_SNAPSHOT_FAIL] sessionId=${sessionId} err=${String(snapshotError)}`
                );
            }
            liveWebview.postMessage({
                type: 'sessionRenamed',
                sessionId,
                title: renamed.title,
                opId,
            });
        } catch (error) {
            this.host.log(
                `[EXT][SESSION_RENAME_FAIL] sessionId=${sessionId} opId=${opId || 'null'} err=${String(error)}`
            );
            vscode.window.showErrorMessage(`Failed to rename session: ${error}`);
            liveWebview.postMessage({
                type: 'sessionRenameFailed',
                sessionId,
                opId,
                reason: String(error),
            });
        }
    }

    private async selectSession(data: SessionCommandMessage, activeWebview: vscode.Webview): Promise<void> {
        if (!data.sessionId) return;
        const targetSessionId = data.sessionId;
        const selectionEpoch = this.host.startSessionSelection(targetSessionId);
        try {
            this.host.adoptSessionSelection(targetSessionId);
            let sessionDataSent = false;
            let snapshotPublished = false;
            const isCurrentSelection = () =>
                this.host.isSessionSelectionCurrent(targetSessionId, selectionEpoch);
            const postSessionData = (
                payload: Record<string, unknown>,
                phase: 'snapshot' | 'recent' | 'full'
            ): boolean => {
                if (!isCurrentSelection()) {
                    this.host.log(
                        `[EXT][SESSION_LOAD_STALE] sessionId=${targetSessionId} phase=${phase}`
                    );
                    return false;
                }
                this.host.getLiveWebview(activeWebview).postMessage({ ...payload, phase });
                return true;
            };
            const restoreCachedAppendMetadata = (messages: SessionMessage[]): SessionMessage[] => {
                const messagesById = new Map<string, SessionMessage>();
                const cloned = messages.map((message) => {
                    const copy = {
                        ...message,
                        meta: message?.meta && typeof message.meta === 'object'
                            ? { ...message.meta }
                            : message?.meta,
                    };
                    if (typeof copy.id === 'string' && copy.id) messagesById.set(copy.id, copy);
                    return copy;
                });
                this.host.applyAppendSnapshotMeta(targetSessionId, messagesById);
                return cloned.map((message) => (
                    typeof message.id === 'string'
                        ? (messagesById.get(message.id) || message)
                        : message
                ));
            };

            await this.host.persistRecentSessionSelection(targetSessionId);
            const segments = await this.host.hydrateSessionUndoPresentation(
                targetSessionId,
                activeWebview
            );

            let baseTitle = 'Session';
            let baseMessages: SessionMessage[] = [];
            let snapPayload: any = null;
            let snapshotTimelineIds: string[] = [];
            let emptyForkBoundary = false;
            let forkOrigin: unknown = null;

            const snapshotStart = Date.now();
            try {
                const snap = await this.host.readSnapshot(targetSessionId);
                if (snap?.obj?.sessionData) {
                    snapPayload = snap.obj.sessionData;
                    const snapshotFormatted = await this.host.injectChangeLists(targetSessionId, {
                        title: snapPayload.title || baseTitle,
                        messages: Array.isArray(snapPayload.messages) ? snapPayload.messages : [],
                    });
                    const snapshotMessages = restoreCachedAppendMetadata(snapshotFormatted.messages);
                    baseTitle = snapshotFormatted.title || baseTitle;
                    baseMessages = snapshotMessages;
                    snapshotTimelineIds = this.host.getSnapshotTimelineIds(
                        snapPayload,
                        snapshotMessages
                    );
                    emptyForkBoundary = isEmptyForkBoundarySnapshot(snapPayload);
                    forkOrigin = snapPayload.meta?.forkOrigin || null;
                    const payload = {
                        type: 'sessionData',
                        sessionId: targetSessionId,
                        title: baseTitle,
                        messages: snapshotMessages,
                        segments,
                        meta: {
                            ...(snapPayload.meta || {}),
                            source: 'snapshot',
                            timelineMessageIds: snapshotTimelineIds,
                            hydrationCoverage: (emptyForkBoundary
                                ? 'authoritativeHistoryComplete'
                                : 'deltaContinuityUnknown') as HydrationCoverage,
                        },
                    };
                    const sent = postSessionData(payload, 'snapshot');
                    if (sent) snapshotPublished = true;
                    if (sent && snapshotMessages.length > 0) sessionDataSent = true;
                    this.host.log(
                        `[EXT][SNAP_LOAD_HIT] sessionId=${targetSessionId} file=${this.host.getSnapshotFile(targetSessionId)} bytes=${snap.bytes} costMs=${Date.now() - snapshotStart}`
                    );
                } else {
                    this.host.log(
                        `[EXT][SNAP_LOAD_MISS] sessionId=${targetSessionId} file=${this.host.getSnapshotFile(targetSessionId)} costMs=${Date.now() - snapshotStart}`
                    );
                }
            } catch (error) {
                this.host.log(
                    `[EXT][SNAP_LOAD_FAIL] sessionId=${targetSessionId} err=${String(error)} costMs=${Date.now() - snapshotStart}`
                );
            }

            if (emptyForkBoundary) {
                this.host.log(
                    `[EXT][SESSION_FORK_BOUNDARY_LOAD] sessionId=${targetSessionId} action=retain-empty-child-history`
                );
                return;
            }

            let recentFailedReason = '';
            const recentStart = Date.now();
            const recentLimit = this.host.getRecentSessionLoadLimit();
            try {
                const recentExport = await this.host.exportSessionRecent(
                    targetSessionId,
                    recentLimit
                );
                if (!isCurrentSelection()) return;

                const formattedRaw = this.host.formatSession(recentExport);
                const formatted = await this.host.injectChangeLists(targetSessionId, formattedRaw);
                if (!isCurrentSelection()) return;
                if (formatted.title) baseTitle = formatted.title;

                const snapshotIds = snapshotTimelineIds;
                const snapshotIdSet = new Set<string>(snapshotIds);
                const snapshotMaxMessageIndex = this.host.getMaxMessageIndex(baseMessages);
                const continuity = this.host.classifyRecentAppendCandidates(
                    snapshotIdSet,
                    snapshotMaxMessageIndex,
                    formatted.messages
                );
                if (snapshotIds.length > 0 && !continuity.proven) {
                    if (!this.host.isSnapshotDeltaContinuityRepairEnabled()) {
                        this.host.log(
                            `[EXT][SESSION_RECENT_SKIP] sessionId=${targetSessionId} reason=repair-disabled-safe-snapshot`
                        );
                        return;
                    }
                    postSessionData({
                        type: 'hydrationCoverage',
                        sessionId: targetSessionId,
                        hydrationCoverage: 'repairInProgress' as HydrationCoverage,
                    }, 'recent');
                    sessionDataSent = false;
                    throw new Error('snapshot-boundary-unproven');
                }
                const appendMessages = continuity.suffix;
                const mergedMessagesRaw = snapshotIds.length > 0
                    ? this.host.buildImmutableSnapshotWithProvenSuffix(baseMessages, appendMessages)
                    : formatted.messages;
                const mergedMessages = restoreCachedAppendMetadata(mergedMessagesRaw);
                const newIds = appendMessages
                    .map((message) => typeof message?.id === 'string' ? message.id : '')
                    .filter((id): id is string => Boolean(id));
                const sessionPayload = {
                    type: 'sessionData',
                    sessionId: targetSessionId,
                    title: baseTitle,
                    messages: mergedMessages,
                    segments,
                    meta: {
                        timelineMessageIds: [...snapshotIds, ...newIds],
                        ...(forkOrigin ? { forkOrigin } : {}),
                        hydrationCoverage: (snapshotIds.length > 0
                            ? 'authoritativeHistoryComplete'
                            : 'deltaContinuityUnknown') as HydrationCoverage,
                    },
                };
                const sent = postSessionData(sessionPayload, 'recent');
                if (sent && mergedMessages.length > 0) {
                    sessionDataSent = true;
                    baseMessages = mergedMessages;
                }
                this.host.log(
                    `[EXT][SESSION_RECENT_OK] sessionId=${targetSessionId} limit=${recentLimit} merged=${mergedMessages.length} costMs=${Date.now() - recentStart}`
                );
                if (sent) {
                    this.host.log(
                        `[EXT][SNAP_SAVE_SKIP] sessionId=${targetSessionId} reason=selectSession:recent disabled=incremental-only`
                    );
                }
            } catch (error) {
                recentFailedReason = this.host.extractLastLine(String(error));
                this.host.log(
                    `[EXT][SESSION_RECENT_FAIL] sessionId=${targetSessionId} limit=${recentLimit} err=${recentFailedReason || 'null'} costMs=${Date.now() - recentStart}`
                );
            }

            if (sessionDataSent || !isCurrentSelection()) return;
            let normalized = { ok: false, data: null as any, stderrLastLine: '' };
            try {
                const exportResult: any = await this.host.exportSession(targetSessionId);
                if (exportResult && typeof exportResult.code === 'number') {
                    normalized.ok = exportResult.code === 0;
                    normalized.stderrLastLine = this.host.extractLastLine(exportResult.stderr);
                    normalized.data = exportResult.data ?? exportResult;
                } else {
                    normalized.ok = true;
                    normalized.data = exportResult;
                }
            } catch (error) {
                normalized.ok = false;
                normalized.stderrLastLine = this.host.extractLastLine(String(error));
            }

            if (!normalized.ok) {
                this.host.log(
                    `[EXT][EXPORT_FAIL] sessionId=${targetSessionId} stderrLastLine=${normalized.stderrLastLine || recentFailedReason || 'null'}`
                );
                if (snapshotPublished) {
                    this.host.log(
                        `[EXT][SESSION_LOAD_RETAIN_SNAPSHOT] sessionId=${targetSessionId} reason=full-export-failed-after-snapshot stderrLastLine=${normalized.stderrLastLine || recentFailedReason || 'null'}`
                    );
                    postSessionData({
                        type: 'hydrationCoverage',
                        sessionId: targetSessionId,
                        hydrationCoverage: 'repairError' as HydrationCoverage,
                    }, 'full');
                    return;
                }
                this.host.getLiveWebview(activeWebview).postMessage({
                    type: 'sessionLoadFailed',
                    payload: {
                        sessionId: targetSessionId,
                        reason: 'export_failed_no_snapshot',
                        stderrLastLine: normalized.stderrLastLine || recentFailedReason || '',
                    },
                });
                return;
            }

            const formattedRaw = this.host.formatSession(normalized.data);
            const snapshotIds = snapshotTimelineIds;
            const repairRequiredMessageIds =
                await this.host.collectSnapshotRepairRequiredMessageIds(targetSessionId);
            const fullDelta = this.host.buildFullExportSnapshotDelta(
                baseMessages,
                snapshotIds,
                formattedRaw.messages,
                repairRequiredMessageIds
            );
            if (fullDelta.repairedSnapshot) {
                await this.host.persistStructurallyRepairedSnapshot(
                    targetSessionId,
                    formattedRaw.title,
                    fullDelta.messages,
                    fullDelta.timelineMessageIds,
                    segments
                );
            }
            const formatted = await this.host.injectChangeLists(targetSessionId, {
                title: formattedRaw.title,
                messages: fullDelta.messages,
            });
            const fullMessages = restoreCachedAppendMetadata(formatted.messages);
            const sessionPayload = {
                type: 'sessionData',
                sessionId: targetSessionId,
                title: formatted.title,
                messages: fullMessages,
                segments,
                meta: {
                    timelineMessageIds: fullDelta.timelineMessageIds,
                    ...(forkOrigin ? { forkOrigin } : {}),
                    hydrationCoverage: (fullDelta.proven
                        ? 'authoritativeHistoryComplete'
                        : 'deltaContinuityUnknown') as HydrationCoverage,
                },
            };
            const sent = postSessionData(sessionPayload, 'full');
            if (sent && fullMessages.length > 0) sessionDataSent = true;
            if (sent) {
                this.host.log(
                    `[EXT][SNAP_SAVE_SKIP] sessionId=${targetSessionId} reason=selectSession:full disabled=incremental-only`
                );
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to load session: ${error}`);
            this.host.postAddResponse(activeWebview, `Error: ${error}`, {
                sessionId: targetSessionId,
            });
        }
    }

    private async newSession(activeWebview: vscode.Webview): Promise<void> {
        const sessionId = await this.host.prepareNewSession();
        activeWebview.postMessage({ type: 'newSession', sessionId });
        await this.host.initializeNewSessionBaseline(activeWebview);
    }
}

export function createSessionCommandHandler(host: SessionCommandHost): SessionCommandHandler {
    const controller = new SessionCommandController(host);
    return (data, activeWebview, resolvingWebview) => {
        if (!SESSION_COMMANDS.has(data?.type)) return false;
        return controller.handle(data, activeWebview, resolvingWebview);
    };
}
