import type { CommitPendingTurnChangesResult } from '../OpenCodeClient';
import type { ChangeListRecord } from './ChangeListInjection';
import type { GitRepoRef, SessionMap } from '../undo/types';

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

type DiffStats = Record<string, { additions: number | null; deletions: number | null }>;

export class ChangeListEmitter {
    private readonly lastEmittedHeadBySession = new Map<string, string>();

    constructor(private readonly options: {
        isEnabled(): boolean;
        getClient(): any;
        resolveRepo(sessionId: string): Promise<GitRepoRef | null>;
        getHead(repo: GitRepoRef): Promise<string | null>;
        getParent(repo: GitRepoRef, commit: string): Promise<string | null>;
        getDiffFileSet(repo: GitRepoRef, baseCommit: string, headCommit: string): Promise<Set<string>>;
        getDiffStats(repo: GitRepoRef, baseCommit: string, headCommit: string): Promise<DiffStats>;
        isResolvableMessageId(messageId: string | undefined): messageId is string;
        readRecords(sessionId: string): Promise<ChangeListRecord[]>;
        readSessionMap(sessionId: string): Promise<SessionMap | null>;
        resolveVisibleOwner(sessionId: string, messageId?: string): Promise<string | undefined>;
        upsertRecord(sessionId: string, record: ChangeListRecord, options: { preserveAuthoritativeFiles: boolean }): Promise<void>;
        log(line: string): void;
        now(): number;
        wait(delayMs: number): Promise<void>;
    }) {}

    async emit(identity: FinalizeTurnIdentity, target: ChangeListMessageTarget): Promise<void> {
        const sessionId = identity.sessionId;
        if (!this.options.isEnabled() || !sessionId) return;
        const client = this.options.getClient();
        const repo = await this.options.resolveRepo(sessionId);
        if (!repo) return;
        let displayHeadCommit: string | null = null;
        let displayBaseCommit: string | null = null;
        const commitResult = identity.commitResult;
        const canBindCommit = commitResult?.status === 'committed'
            && !!commitResult.msgToBaseCommit
            && !!commitResult.msgToCommit;
        const bindBaseCommit = canBindCommit ? commitResult!.msgToBaseCommit! : null;
        const bindHeadCommit = canBindCommit ? commitResult!.msgToCommit! : null;
        const turnCommitBase = commitResult?.msgToBaseCommit || client.getLastTurnCommitBase(sessionId) || null;
        for (let attempt = 0; attempt < 5; attempt++) {
            displayHeadCommit = bindHeadCommit || await this.options.getHead(repo);
            if (displayHeadCommit && turnCommitBase) {
                displayBaseCommit = turnCommitBase;
            } else if (displayHeadCommit) {
                displayBaseCommit = await this.options.getParent(repo, displayHeadCommit);
            }
            if (displayHeadCommit && displayBaseCommit) break;
            await this.options.wait(100);
        }
        if (displayHeadCommit && !displayBaseCommit) {
            this.options.log('EXT: diff.skip | reason=baseline-only');
            return;
        }
        if (!displayHeadCommit || !displayBaseCommit) return;
        if (commitResult && !canBindCommit) {
            this.options.log(`[EXT][COMMIT_BIND] suppress | sessionId=${sessionId} | status=${commitResult.status} | reason=${commitResult.reason || 'no-committed-result'} | msgToBaseCommit=${commitResult.msgToBaseCommit || 'null'} | msgToCommit=${commitResult.msgToCommit || 'null'}`);
        } else if (!commitResult) {
            this.options.log(`[EXT][COMMIT_BIND] suppress | sessionId=${sessionId} | reason=missing-commit-result | displayHead=${displayHeadCommit} | displayBase=${displayBaseCommit}`);
        }
        const currentSet = await this.options.getDiffFileSet(repo, displayBaseCommit, displayHeadCommit);
        const gitDiffFiles = Array.from(currentSet).sort();
        const rootUserMessageId = identity.rootUserMessageId || identity.userMessageId;
        const latestAppendUserMessageId = identity.latestAppendUserMessageId;
        const assistantMessageId = identity.assistantMessageId;
        const hasAuthoritativeHelper = typeof client.getAuthoritativeDiffFileSet === 'function';
        if ((!this.options.isResolvableMessageId(rootUserMessageId) || !this.options.isResolvableMessageId(assistantMessageId)) && hasAuthoritativeHelper) {
            this.options.log(`[EXT][TURN_BIND] phase=defer_diff_list | sessionId=${sessionId} | reqId=${identity.reqId || 'null'} | reason=missing-final-bind | userMessageId=${identity.userMessageId || 'null'} | assistantMessageId=${assistantMessageId || 'null'} | rootUserMessageId=${rootUserMessageId || 'null'} | latestAppendUserMessageId=${latestAppendUserMessageId || 'null'}`);
            return;
        }
        const authResult = hasAuthoritativeHelper
            ? await client.getAuthoritativeDiffFileSet({
                sessionId,
                rootUserMessageId,
                latestAppendUserMessageId: this.options.isResolvableMessageId(latestAppendUserMessageId) ? latestAppendUserMessageId : undefined,
            })
            : {
                files: gitDiffFiles,
                queriedIds: [] as string[],
                missingIds: [] as string[],
                source: 'message-summary-diffs' as const,
            };
        if (!hasAuthoritativeHelper) {
            this.options.log(`[EXT][AUTH_DIFF] detail.drop | sessionId=${sessionId} | reason=helper-unavailable-test-double | fallback=git-diff`);
        }
        const files: string[] = authResult.files;
        this.options.log(`[EXT][AUTH_DIFF] compare | sessionId=${sessionId} | queriedIds=${authResult.queriedIds.join(',') || 'none'} | authCount=${files.length} | gitDiffCount=${gitDiffFiles.length} | source=${authResult.source}`);
        if (!files.length) return;
        const alreadyEmitted = client.wasChangeListEmitted(sessionId);
        const lastEmittedHead = this.lastEmittedHeadBySession.get(sessionId);
        if (alreadyEmitted && lastEmittedHead === displayHeadCommit) {
            this.options.log(`[LATE_DIFF] change-list already emitted for same head | sessionId=${sessionId} head=${displayHeadCommit} skipping=true`);
            return;
        }
        if (!alreadyEmitted) {
            if (!client.markChangeListEmitted(sessionId, 'emit-diff-list')) return;
        } else {
            this.options.log(`[LATE_DIFF] re-emitting change-list for advanced head | sessionId=${sessionId} prevHead=${lastEmittedHead || 'null'} nextHead=${displayHeadCommit}`);
        }
        const statsByPath = await this.options.getDiffStats(repo, displayBaseCommit, displayHeadCommit);
        const existingRecords = await this.options.readRecords(sessionId);
        const matchedExisting = existingRecords.find((item) => item.commitHead === displayHeadCommit);
        const ownershipMap = await this.options.readSessionMap(sessionId);
        const currentTurnAnchorCandidates = new Set<string>();
        for (const candidate of [assistantMessageId, latestAppendUserMessageId, rootUserMessageId, identity.userMessageId]) {
            if (this.options.isResolvableMessageId(candidate)) currentTurnAnchorCandidates.add(candidate);
        }
        const matchedExistingAnchorMessageId = matchedExisting?.anchorMessageId;
        const resolvedMatchedExistingAnchorMessageId = matchedExistingAnchorMessageId
            ? await this.options.resolveVisibleOwner(sessionId, matchedExistingAnchorMessageId)
            : undefined;
        const existingAnchorMatchesCurrentTurn = !!matchedExistingAnchorMessageId && (
            currentTurnAnchorCandidates.has(matchedExistingAnchorMessageId)
            || (!!resolvedMatchedExistingAnchorMessageId && currentTurnAnchorCandidates.has(resolvedMatchedExistingAnchorMessageId))
        );
        const anchorSeedMessageId = assistantMessageId
            || (existingAnchorMatchesCurrentTurn ? (resolvedMatchedExistingAnchorMessageId || matchedExistingAnchorMessageId) : undefined)
            || latestAppendUserMessageId
            || rootUserMessageId
            || identity.userMessageId
            || undefined;
        const anchorMessageId = await this.options.resolveVisibleOwner(sessionId, anchorSeedMessageId);
        let mergedFiles = [...files];
        let mergedStatsByPath = { ...statsByPath };
        let changeListId = displayHeadCommit ? `system:changeList:${displayHeadCommit}` : `changes:${this.options.now()}`;
        const postFinalOverlay = typeof client.getPostFinalWatchOverlay === 'function'
            ? client.getPostFinalWatchOverlay(sessionId)
            : { files: [], statsByPath: {} };
        const currentOwnerMsgId = ownershipMap?.continuation?.currentOwnerMsgId;
        const predecessorOwnerMsgId = ownershipMap?.continuation?.predecessorOwnerMsgId;
        const currentOwnerIsContinuation = Array.isArray(ownershipMap?.entries)
            && !!currentOwnerMsgId
            && ownershipMap.entries.some((entry) => {
                const entryOwner = entry.finalAssistantMsgId || entry.assistantMsgId;
                return entryOwner === currentOwnerMsgId
                    && typeof entry.turnKey === 'string'
                    && entry.turnKey.startsWith('cont:');
            });
        if (currentOwnerIsContinuation && anchorMessageId && currentOwnerMsgId === anchorMessageId && predecessorOwnerMsgId) {
            const recordsForOwner: ChangeListRecord[] = [];
            for (const record of existingRecords) {
                const resolvedRecordAnchor = await this.options.resolveVisibleOwner(sessionId, record.anchorMessageId);
                if (resolvedRecordAnchor === anchorMessageId) recordsForOwner.push(record);
            }
            if (recordsForOwner.length) {
                const primary = recordsForOwner.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))[0];
                changeListId = primary.id || changeListId;
                const orderedFiles = [...files].filter((item): item is string => typeof item === 'string' && item.length > 0);
                mergedFiles = Array.from(new Set(orderedFiles));
                mergedStatsByPath = recordsForOwner.reduce((acc, record) => ({
                    ...acc,
                    ...(record.statsByPath || {}),
                }), { ...mergedStatsByPath });
            }
        }
        const overlayApplies = Array.isArray(postFinalOverlay.files)
            && postFinalOverlay.files.length > 0
            && (
                !postFinalOverlay.ownerMsgId
                || postFinalOverlay.ownerMsgId === anchorMessageId
                || postFinalOverlay.ownerMsgId === predecessorOwnerMsgId
                || postFinalOverlay.ownerMsgId === currentOwnerMsgId
            );
        if (overlayApplies) {
            mergedStatsByPath = { ...postFinalOverlay.statsByPath, ...mergedStatsByPath };
        }
        this.options.log(`[EXT][COMMIT_BIND] created | sessionId=${sessionId} anchorMessageId=${anchorMessageId || 'null'} userMessageId=${identity.userMessageId || 'null'} assistantMessageId=${assistantMessageId || 'null'} rootUserMessageId=${rootUserMessageId || 'null'} latestAppendUserMessageId=${latestAppendUserMessageId || 'null'} displayHead=${displayHeadCommit} displayBase=${displayBaseCommit} msgToCommit=${bindHeadCommit || 'null'} msgToBaseCommit=${bindBaseCommit || 'null'} bind=${String(canBindCommit)} fileCount=${mergedFiles.length} source=${authResult.source}`);
        target.postMessage({
            type: 'diffFileList',
            sessionId,
            files: mergedFiles,
            source: authResult.source,
            scope: 'turn',
            commitHead: displayHeadCommit,
            commitBase: displayBaseCommit,
            statsByPath: mergedStatsByPath,
            anchorMessageId,
            changeListId,
        });
        if (anchorMessageId && canBindCommit && bindHeadCommit && bindBaseCommit) {
            await this.options.upsertRecord(sessionId, {
                id: changeListId,
                commitHead: bindHeadCommit,
                commitBase: bindBaseCommit,
                files: mergedFiles,
                statsByPath: mergedStatsByPath,
                anchorMessageId,
                userMessageId: identity.userMessageId,
                rootUserMessageId,
                latestAppendUserMessageId,
                assistantMessageId,
                createdAt: this.options.now(),
            }, { preserveAuthoritativeFiles: true });
            const topologyMessageIds = Array.from(new Set([
                rootUserMessageId,
                latestAppendUserMessageId,
                identity.userMessageId,
                assistantMessageId,
            ].filter((id): id is string => this.options.isResolvableMessageId(id))));
            const topologyResult = typeof client.bindCommitToMessageIds === 'function'
                ? await client.bindCommitToMessageIds(sessionId, {
                    messageIds: topologyMessageIds,
                    commitHash: bindHeadCommit,
                    baseCommit: bindBaseCommit,
                    reason: latestAppendUserMessageId ? 'append-commit-bind' : 'commit-bind',
                })
                : { ok: false, boundIds: [] };
            this.options.log(`[EXT][APPEND_BIND_TOPOLOGY] sessionId=${sessionId} | rootUserMessageId=${rootUserMessageId || 'null'} | latestAppendUserMessageId=${latestAppendUserMessageId || 'null'} | userMessageId=${identity.userMessageId || 'null'} | assistantMessageId=${assistantMessageId || 'null'} | msgToCommit=${bindHeadCommit} | msgToBaseCommit=${bindBaseCommit} | bound=${topologyResult.boundIds?.join(',') || 'none'} | ok=${String(topologyResult.ok)}`);
            this.options.log(`[EXT][COMMIT_BIND] bound | sessionId=${sessionId} | changeListId=${changeListId} | anchorMessageId=${anchorMessageId} | userMessageId=${identity.userMessageId || 'null'} | assistantMessageId=${assistantMessageId} | rootUserMessageId=${rootUserMessageId} | latestAppendUserMessageId=${latestAppendUserMessageId || 'null'} | msgToCommit=${bindHeadCommit} | msgToBaseCommit=${bindBaseCommit} | fileCount=${mergedFiles.length}`);
            await client.updateSessionBaseCommitAfterBind(sessionId, bindHeadCommit);
        } else {
            this.options.log(`[EXT][COMMIT_BIND] not-bound | sessionId=${sessionId} | anchorMessageId=${anchorMessageId || 'null'} | bind=${String(canBindCommit)} | status=${commitResult?.status || 'missing'} | reason=${commitResult?.reason || 'no-committed-result'}`);
        }
        this.lastEmittedHeadBySession.set(sessionId, displayHeadCommit);
        this.options.log(`[EXT][DIFF_LIST] sessionId=${sessionId} count=${files.length} anchor=${anchorMessageId || 'null'} source=${authResult.source}`);
    }
}
