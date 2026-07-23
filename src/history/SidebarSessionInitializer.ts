import * as vscode from 'vscode';
import type { AgentInfo, ModelInfo, SessionInfo } from '../OpenCodeClient';
import type { SessionMessage } from '../changes/ChangeListInjection';

type HydrationCoverage = 'authoritativeHistoryComplete' | 'deltaContinuityUnknown' | 'repairInProgress' | 'repairError';

export type SidebarSendInitOptions = {
    isStillCurrent?: () => boolean;
    hardRescue?: { sessionId: string; activeTurn: { fresh: boolean; [key: string]: any } };
    commandReload?: { sessionId: string; activeTurn: { fresh: boolean; [key: string]: any } };
};

/** Runs the snapshot-first Webview hydration handshake against the Sidebar host. */
export async function initializeSidebarSession(
    host: any,
    webview: vscode.Webview,
    options: SidebarSendInitOptions = {}
): Promise<void> {
        const isStillCurrent = options.isStillCurrent || (() => true);
        if (!isStillCurrent()) throw new Error('stale-handshake-before-sendInit');
    const isHardRescueSendInit = Boolean(options.hardRescue && options.isStillCurrent);
    const rescueHydration = options.hardRescue || options.commandReload;
    const initSessionId = rescueHydration?.sessionId || host.currentSessionId || '';
        const isCommandReloadSendInit = Boolean(options.commandReload && options.isStillCurrent);
        let isGuardedRescueSendInit = false;
        if (isHardRescueSendInit) {
            isGuardedRescueSendInit = true;
        }
        if (isCommandReloadSendInit) {
            isGuardedRescueSendInit = true;
        }
        if (isGuardedRescueSendInit) {
            const sourceWebview = webview;
            webview = new Proxy(sourceWebview, {
                get(target, property) {
                    if (property === 'postMessage') {
                        return (message: any) => {
                            if (!isStillCurrent()) return Promise.resolve(false);
                            return target.postMessage(message);
                        };
                    }
                    const value = Reflect.get(target, property, target);
                    return typeof value === 'function' ? value.bind(target) : value;
                }
            });
        }
        host.uiDebugChannel.appendLine(`[EXT][SENDINIT_START] initPosted=${host.initPosted}`);
        let models: ModelInfo[] = [];
        let agents: AgentInfo[] = [];
        let sessions: SessionInfo[] = [];
        try {
            models = await host.client.listModels();
            if (models.length) {
                host.lastKnownModels = models;
            }
        } catch (error) {
            if (isStillCurrent() && initSessionId) {
                host.postAddResponse(webview, `Failed to load models: ${error}`, { sessionId: initSessionId });
            } else {
                host.uiDebugChannel.appendLine(`[EXT][ADD_RESPONSE_DROP] reason=missing-session-owner source=initializeModels error=${String(error)}`);
            }
        }

        try {
            agents = await host.client.listAgents();
        } catch (error) {
            host.uiDebugChannel.appendLine(`EXT: agents.load.fail | err=${String(error)}`);
        }

        try {
            sessions = await host.client.listSessions();
        } catch (error) {
            if (isStillCurrent() && initSessionId) {
                host.postAddResponse(webview, `Failed to load sessions: ${error}`, { sessionId: initSessionId });
            } else {
                host.uiDebugChannel.appendLine(`[EXT][ADD_RESPONSE_DROP] reason=missing-session-owner source=initializeSessions error=${String(error)}`);
            }
        }
        const initWorkspaceRoot = host.client.getWorkspaceRoot() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        sessions = await host.filterSessionsForWorkspace(sessions, initWorkspaceRoot, 'init');
        const storedModel = host._context.globalState.get('opencode.model') as string | undefined;
        const storedVariant = host._context.globalState.get('opencode.variant') as string | undefined;
        const storedMode = host._context.globalState.get('opencode.mode') as string | undefined;

        const allModes = agents
            // Keep primary agents visible in the mode picker; only hidden agents stay excluded.
            .filter((agent) => !agent.hidden && (agent.mode === 'all' || agent.mode === 'primary'))
            .map((agent) => agent.id)
            .filter((value, index, arr) => arr.indexOf(value) === index);
        const mergedModes = ['plan', 'build', ...allModes]
            .filter((value, index, arr) => arr.indexOf(value) === index);
        host.availableModes = mergedModes.length ? mergedModes : ['plan', 'build'];
        const resolvedMode = (storedMode && host.availableModes.includes(storedMode))
            ? storedMode
            : (host.availableModes.includes('plan') ? 'plan' : host.availableModes[0]);

        host.selectedMode = resolvedMode;

        if (!models.length) {
            const refreshed = await host.refreshModels(webview);
            if (refreshed.length) {
                models = refreshed;
            } else if (host.lastKnownModels.length) {
                models = host.lastKnownModels;
            }
        }

        const modelMap = new Map(models.map((model) => [model.fullId, model]));
        let resolvedModel = storedModel;
        if (!resolvedModel || !modelMap.has(resolvedModel)) {
            resolvedModel = models[0]?.fullId;
        }

        let resolvedVariant = storedVariant || undefined;
        const resolvedModelInfo = resolvedModel ? modelMap.get(resolvedModel) : undefined;
        const variants = resolvedModelInfo?.variants || [];
        if (resolvedVariant && !variants.includes(resolvedVariant)) {
            resolvedVariant = undefined;
        }

        host.selectedModel = resolvedModel;
        host.selectedVariant = resolvedVariant;

        if (resolvedModel && resolvedModel !== storedModel) {
            await host._context.globalState.update('opencode.model', resolvedModel);
        }
        if ((resolvedVariant || '') !== (storedVariant || '')) {
            await host._context.globalState.update('opencode.variant', resolvedVariant);
        }
        if ((resolvedMode || '') !== (storedMode || '')) {
            await host._context.globalState.update('opencode.mode', resolvedMode);
        }
        host.uiDebugChannel.appendLine(
            `[EXT][INIT_MODEL_RESOLVE] models=${models.length} storedModel=${storedModel || 'null'} selectedModel=${resolvedModel || 'null'} storedVariant=${storedVariant || 'null'} selectedVariant=${resolvedVariant || 'null'}`
        );
        host.uiDebugChannel.appendLine(
            `EXT: mode.init | stored=${storedMode || 'null'} | selected=${resolvedMode || 'null'} | available=${host.availableModes.join(',') || 'none'}`
        );

        const workspaceRoot = initWorkspaceRoot;
        const workspaceCount = vscode.workspace.workspaceFolders?.length || 0;
        if (workspaceRoot) {
            host.currentWorkspaceKey = host.getWorkspaceKeyForRoot(workspaceRoot);
        }
        host.uiDebugChannel.appendLine(
            `EXT: workspace.root.select | mode=first-folder | root=${workspaceRoot || 'null'} | count=${workspaceCount}`
        );

        const workspaceFolder = workspaceRoot;
        let recentSessionId: string | undefined;
        if (workspaceFolder) {
            const workspaceKey = host.getWorkspaceKeyForRoot(workspaceFolder);
            recentSessionId = host._context.globalState.get(`recentSession.${workspaceKey}`) as string | undefined;
        }
        if (workspaceFolder && recentSessionId) {
            const recentMatch = await host.getSessionWorkspaceMatch(recentSessionId, workspaceFolder);
            if (recentMatch === 'mismatch') {
                host.uiDebugChannel.appendLine(
                    `[EXT][RECENT_SESSION_SKIP] sessionId=${recentSessionId} reason=workspace-mismatch workspace=${workspaceFolder}`
                );
                recentSessionId = undefined;
            } else if (recentMatch === 'unknown') {
                host.uiDebugChannel.appendLine(
                    `[EXT][RECENT_SESSION_ACCEPT] sessionId=${recentSessionId} reason=trusted-recent-missing-cwd workspace=${workspaceFolder}`
                );
            }
        }
        if (rescueHydration) {
            recentSessionId = rescueHydration.sessionId;
        }

        let initSessionCandidate = recentSessionId;
        if (!initSessionCandidate && workspaceFolder) {
            const workspaceRecent = await host.findMostRecentWorkspaceSession(sessions, workspaceFolder);
            initSessionCandidate = workspaceRecent?.id;
        }

        if (!host.initPosted && !rescueHydration?.activeTurn.fresh) {
            host.currentSessionId = host.currentSessionId || initSessionCandidate || undefined;
            if (host.currentSessionId) {
                host.client.setSessionId(host.currentSessionId);
            }
            const initSessionId = rescueHydration?.sessionId || initSessionCandidate || host.currentSessionId || '';
            const liveWebview = webview;
            host.uiDebugChannel.appendLine(
                `[EXT][INIT_SEND] models=${models.length} sessions=${sessions.length} ` +
                `currentSessionId=${initSessionId || 'null'} selectedModel=${host.selectedModel || 'NULL'} selectedMode=${resolvedMode || 'null'} modeCount=${host.availableModes.length}`
            );

            liveWebview.postMessage({
                type: 'init',
                models,
                sessions,
                modes: host.availableModes,
                selectedModel: host.selectedModel,
                selectedVariant: host.selectedVariant,
                selectedMode: resolvedMode,
                currentSessionId: initSessionId,
                sessionId: initSessionId,
                panelId: host.getWebviewLivenessPanelId(),
                webviewInstanceId: host._webviewInstanceId
            });
            if (initSessionId) {
                liveWebview.postMessage({
                    type: 'turnInFlight',
                    sessionId: initSessionId,
                    inFlight: host.sendInFlightBySession.has(initSessionId)
                });
            }

            await host.postModelQuota(liveWebview, 'init');

            liveWebview.postMessage({
                type: 'gitUndoAvailability',
                enabled: host.gitUndoEnabled,
                reason: host.gitUndoReason
            });

            liveWebview.postMessage({ type: 'serverStatus', status: host.serverStatus, reason: 'init' });

            host.initPosted = true;
        } else {
            const initSessionId = rescueHydration?.sessionId || host.currentSessionId || initSessionCandidate || '';
            const liveWebview = webview;
            host.uiDebugChannel.appendLine(
                `[EXT][INIT_METADATA_RESEND] models=${models.length} sessions=${sessions.length} ` +
                `currentSessionId=${initSessionId || 'null'} selectedModel=${host.selectedModel || 'NULL'} selectedMode=${resolvedMode || 'null'} ` +
                `modeCount=${host.availableModes.length} postedSessionData=false metadataOnly=true`
            );
            liveWebview.postMessage({
                type: 'init',
                models,
                sessions,
                modes: host.availableModes,
                selectedModel: host.selectedModel,
                selectedVariant: host.selectedVariant,
                selectedMode: resolvedMode,
                currentSessionId: initSessionId,
                sessionId: initSessionId,
                panelId: host.getWebviewLivenessPanelId(),
                webviewInstanceId: host._webviewInstanceId,
                metadataOnly: true,
                postedSessionData: false
            });
            if (initSessionId) {
                liveWebview.postMessage({
                    type: 'turnInFlight',
                    sessionId: initSessionId,
                    inFlight: host.sendInFlightBySession.has(initSessionId)
                });
            }
        }

        if (options.hardRescue?.activeTurn.fresh) {
            const hardRescueSessionId = options.hardRescue.sessionId;
            if (!isStillCurrent()) throw new Error('stale-hard-rescue-before-live-hydration');
            await host.postLiveTurnHistoryForSendInitGuardDefer(webview, hardRescueSessionId, options.hardRescue.activeTurn);
            if (!isStillCurrent()) throw new Error('stale-hard-rescue-after-live-history');
            host.postLiveTurnResumeForSendInitGuardDefer(webview, hardRescueSessionId, options.hardRescue.activeTurn);
            host.queueSendInitGuardCompensation(hardRescueSessionId, 'sendInitGuard.defer', options.hardRescue.activeTurn);
            host.uiDebugChannel.appendLine(`[EXT][SENDINIT_END] sendInit completed successfully | hardRescue=true | postedSessionData=false`);
            return;
        }
        if (options.commandReload?.activeTurn.fresh) {
            const commandReloadSessionId = options.commandReload.sessionId;
            if (!isStillCurrent()) throw new Error('stale-command-reload-before-live-hydration');
            await host.postLiveTurnHistoryForSendInitGuardDefer(webview, commandReloadSessionId, options.commandReload.activeTurn);
            if (!isStillCurrent()) throw new Error('stale-command-reload-after-live-history');
            host.postLiveTurnResumeForSendInitGuardDefer(webview, commandReloadSessionId, options.commandReload.activeTurn);
            host.queueSendInitGuardCompensation(commandReloadSessionId, 'sendInitGuard.defer', options.commandReload.activeTurn);
            host.uiDebugChannel.appendLine(`[EXT][SENDINIT_END] sendInit completed successfully | commandReload=true | postedSessionData=false`);
            return;
        }

        let snapshotLoaded = false;
        let sessionDataSent = false;
                if (recentSessionId) {
                    try {
                        host.currentSessionId = recentSessionId;
                        host.trackUserOwnedSession(host.currentSessionId);
                        host.client.setSessionId(host.currentSessionId);
                        const liveWebview = webview;
                        const activeTurn = host.getWebviewLivenessActiveTurnFlags(recentSessionId);
                        if (activeTurn.fresh) {
                            host.uiDebugChannel.appendLine(
                                `EXT: webviewAutoRescue.hardRescue.sendInitGuard.defer | ` +
                                `sessionId=${recentSessionId} | panelId=${host.getWebviewLivenessPanelId()} | ` +
                                `webviewInstanceId=${host._webviewInstanceId || 'null'} | active=${String(activeTurn.active)} | ` +
                                `fresh=${String(activeTurn.fresh)} | activeTurnId=${activeTurn.turnId || 'none'} | ` +
                                `activeTurnSource=${activeTurn.source} | activeTurnAgeMs=${activeTurn.ageMs} | ` +
                                `activeTurnFreshnessWindowMs=${activeTurn.freshnessWindowMs} | ` +
                                `streaming=${String(activeTurn.streaming)} | finalizing=${String(activeTurn.finalizing)} | ` +
                                `postedSessionData=false | reload=false | recreate=false | sessionMutation=false`
                            );
                            await host.postLiveTurnHistoryForSendInitGuardDefer(liveWebview, recentSessionId, activeTurn);
                            host.postLiveTurnResumeForSendInitGuardDefer(liveWebview, recentSessionId, activeTurn);
                            host.queueSendInitGuardCompensation(recentSessionId, 'sendInitGuard.defer', activeTurn);
                            return;
                        }
                        try {
                            await host.ensureSessionUndoReady(recentSessionId, liveWebview);
                        } catch (err) {
                            host.uiDebugChannel.appendLine(`[EXT][UNDO_WARN] ensureSessionUndoReady failed for ${recentSessionId}: ${err}`);
                        }

                        const persisted = await host.loadPersistedSegment(recentSessionId);
                        if (persisted?.segment?.historySegments) {
                            host.revertedSegmentHistoryStore.set(recentSessionId, persisted.segment.historySegments);
                        } else {
                            host.revertedSegmentHistoryStore.clearSession(recentSessionId);
                        }
                        if (persisted?.segment && persisted.segment.isActive === true && persisted.discarded !== true) {
                            host.client.setRevertedSegment(recentSessionId, {
                                isActive: true,
                                discarded: false,
                                startMessageId: persisted.segment.startMessageId || recentSessionId,
                                startMessageIndex: persisted.segment.startMessageIndex ?? 0,
                                endMessageId: persisted.segment.endMessageId || recentSessionId,
                                endMessageIndex: persisted.segment.endMessageIndex ?? (persisted.segment.startMessageIndex ?? 0),
                                opIds: persisted.segment.opIds || [],
                                collapsed: true,
                                conflicts: persisted.conflicts || [],
                                messageIds: persisted.segment.messageIds,
                                operationId: persisted.segment.operationId
                            });
                        } else {
                            host.client.setRevertedSegment(recentSessionId, undefined);
                        }

                        const segMap = host.undoSegmentsBySession.get(recentSessionId);
                        host.syncClientRevertedSegmentFromUndoSegments(recentSessionId);
                        const segments = segMap ? Array.from(segMap.values()) : [];

                        let baseTitle = 'Session';
                        let baseMessages: SessionMessage[] = [];
                        let snapshotTimelineIds: string[] = [];

                        try {
                            const snap = await host.readSnapshot(recentSessionId);
                            if (snap?.obj?.sessionData) {
                                const snapshotFormatted = await host.injectChangeLists(recentSessionId, {
                                    title: snap.obj.sessionData?.title || baseTitle,
                                    messages: Array.isArray(snap.obj.sessionData?.messages)
                                        ? snap.obj.sessionData.messages
                                        : []
                                });
                                baseTitle = snapshotFormatted.title || baseTitle;
                                baseMessages = snapshotFormatted.messages;
                                snapshotTimelineIds = host.getSnapshotTimelineIds(snap.obj.sessionData, baseMessages);

                                const snapshotPayload = {
                                    type: 'sessionData',
                                    sessionId: recentSessionId,
                                    title: baseTitle,
                                    messages: baseMessages,
                                    segments,
                                    meta: {
                                        ...(snap.obj.sessionData?.meta || {}),
                                        source: 'snapshot',
                                        timelineMessageIds: snapshotTimelineIds,
                                        hydrationCoverage: 'deltaContinuityUnknown' as HydrationCoverage
                                    }
                                };
                                liveWebview.postMessage(snapshotPayload);
                                if (baseMessages.length > 0) {
                                    sessionDataSent = true;
                                }
                                snapshotLoaded = true;
                                host.uiDebugChannel.appendLine(`[EXT][SNAP_LOAD_HIT] sessionId=${recentSessionId} file=${host.getSnapshotFile(recentSessionId)} bytes=${snap.bytes}`);
                            } else {
                                host.uiDebugChannel.appendLine(`[EXT][SNAP_LOAD_MISS] sessionId=${recentSessionId} file=${host.getSnapshotFile(recentSessionId)}`);
                            }
                        } catch (err) {
                            host.uiDebugChannel.appendLine(`[EXT][SNAP_LOAD_FAIL] sessionId=${recentSessionId} err=${String(err)}`);
                        }

                        try {
                            const recentSelectionEpoch = host.sessionSelectionEpoch;
                            const recentLivenessOwner = host.webviewLivenessCurrent;
                            const recentWebviewInstanceId = host._webviewInstanceId;
                            const recentHydrationWebview = liveWebview;
                            const isRecentHydrationCurrent = () => (
                                host.currentSessionId === recentSessionId
                                && host.sessionSelectionEpoch === recentSelectionEpoch
                                && host.webviewLivenessCurrent === recentLivenessOwner
                                && host._webviewInstanceId === recentWebviewInstanceId
                                && (host._view?.webview || webview) === recentHydrationWebview
                            );
                            if (!isRecentHydrationCurrent()) throw new Error('stale-before-recent-hydration');
                            const recentExport = await host.client.exportSessionRecent(recentSessionId, host.recentSessionLoadLimit);
                            if (!isRecentHydrationCurrent()) throw new Error('stale-after-recent-export');
                            const formattedRaw = host.formatSession(recentExport);
                            const formatted = await host.injectChangeLists(recentSessionId, formattedRaw);
                            if (!isRecentHydrationCurrent()) throw new Error('stale-after-recent-format');
                            if (formatted.title) {
                                baseTitle = formatted.title;
                            }

                            const snapshotIdSet = new Set<string>(snapshotTimelineIds);
                            const snapshotMaxMessageIndex = host.getMaxMessageIndex(baseMessages);
                            const continuity = host.classifyRecentAppendCandidates(snapshotIdSet, snapshotMaxMessageIndex, formatted.messages);
                            const appendMessages = continuity.suffix;
                            let mergedMessages = snapshotTimelineIds.length > 0
                                ? host.buildImmutableSnapshotWithProvenSuffix(baseMessages, appendMessages)
                                : formatted.messages;
                            const newIds = appendMessages
                                .map((message: SessionMessage) => (typeof message?.id === 'string' ? message.id : ''))
                                .filter((id: string): id is string => Boolean(id));
                            let timelineIds = [...snapshotTimelineIds, ...newIds];
                            let hydrationCoverage: HydrationCoverage = snapshotTimelineIds.length > 0 && continuity.proven
                                ? 'authoritativeHistoryComplete'
                                : 'deltaContinuityUnknown';

                            if (snapshotTimelineIds.length > 0 && !continuity.proven && host.snapshotDeltaContinuityRepairEnabled) {
                                if (!isRecentHydrationCurrent()) throw new Error('stale-before-full-repair');
                                liveWebview.postMessage({ type: 'hydrationCoverage', sessionId: recentSessionId, hydrationCoverage: 'repairInProgress' as HydrationCoverage });
                                const fullExport = await host.client.exportSession(recentSessionId);
                                if (!isRecentHydrationCurrent()) throw new Error('stale-after-full-repair');
                                const fullFormatted = host.formatSession(fullExport);
                                const repairRequiredMessageIds = await host.collectSnapshotRepairRequiredMessageIds(recentSessionId);
                                const fullDelta = host.buildFullExportSnapshotDelta(
                                    baseMessages, snapshotTimelineIds, fullFormatted.messages, repairRequiredMessageIds
                                );
                                if (fullDelta.repairedSnapshot) {
                                    await host.persistStructurallyRepairedSnapshot(
                                        recentSessionId, fullFormatted.title, fullDelta.messages, fullDelta.timelineMessageIds, segments
                                    );
                                }
                                const repaired = await host.injectChangeLists(recentSessionId, { title: fullFormatted.title, messages: fullDelta.messages });
                                if (!isRecentHydrationCurrent()) throw new Error('stale-after-full-repair-format');
                                mergedMessages = repaired.messages;
                                timelineIds = fullDelta.timelineMessageIds;
                                hydrationCoverage = fullDelta.proven ? 'authoritativeHistoryComplete' : 'deltaContinuityUnknown';
                            }

                            const timelineMsgCount = mergedMessages.filter((m: SessionMessage) => typeof m.id === 'string' && m.id.startsWith('msg_')).length;
                            host.uiDebugChannel.appendLine(
                                `sessionData.send | sessionId | ${recentSessionId} | messagesCount | ${mergedMessages.length} | ` +
                                `timelineMsgCount | ${timelineMsgCount} | segmentsCount | ${segments.length}`
                            );

                            const sessionPayload = {
                                type: 'sessionData',
                                sessionId: recentSessionId,
                                title: baseTitle,
                                messages: mergedMessages,
                                segments,
                                meta: {
                                    timelineMessageIds: timelineIds,
                                    hydrationCoverage
                                }
                            };
                            if (!isRecentHydrationCurrent()) throw new Error('stale-before-recent-publish');
                            liveWebview.postMessage(sessionPayload);
                            if (mergedMessages.length > 0) {
                                sessionDataSent = true;
                            }
                            host.uiDebugChannel.appendLine(`[EXT][SNAP_SAVE_SKIP] sessionId=${recentSessionId} reason=sendInit:recent disabled=incremental-only`);
                        } catch (err) {
                            const recentErr = host.extractLastLine(String(err));
                            host.uiDebugChannel.appendLine(`[EXT][SESSION_RECENT_FAIL] sessionId=${recentSessionId} limit=${host.recentSessionLoadLimit} err=${recentErr || 'null'}`);

                            if (!snapshotLoaded) {
                                const liveWebview = webview;
                                liveWebview.postMessage({
                                    type: 'sessionLoadFailed',
                                    payload: {
                                        sessionId: recentSessionId,
                                        reason: 'recent_failed_no_snapshot',
                                        stderrLastLine: recentErr || ''
                                    }
                                });
                                return;
                            }
                        }
                } catch (err) {
                    host.uiDebugChannel.appendLine(`[EXT][EXPORT_FAILED] sessionId=${recentSessionId} err=${String(err)}`);
                    host.currentSessionId = undefined;
                }
            }

        // CRITICAL: Ensure we ALWAYS have a session selected
        if (!host.currentSessionId) {
            host.uiDebugChannel.appendLine(`[EXT][NO_SESSION] checking sessions.length=${sessions.length}`);
            
            if (sessions.length > 0) {
                let mostRecent: SessionInfo | undefined;
                if (workspaceFolder) {
                    mostRecent = await host.findMostRecentWorkspaceSession(sessions, workspaceFolder);
                    host.uiDebugChannel.appendLine(
                        `[EXT][SESSION_FILTER_RESULT] workspace=${workspaceFolder} total=${sessions.length} matched=${mostRecent ? 1 : 0}`
                    );
                } else {
                    mostRecent = sessions[0];
                }

                if (!mostRecent) {
                    host.uiDebugChannel.appendLine('[EXT][AUTO_SELECT_SKIP] reason=no-workspace-session-match');
                } else {
                    host.currentSessionId = mostRecent.id;
                    host.trackUserOwnedSession(host.currentSessionId);
                    host.client.setSessionId(host.currentSessionId);
                    host.uiDebugChannel.appendLine(`[EXT][AUTO_SELECT] sessionId=${host.currentSessionId} reason=no-current-session`);
                
                    // Save as recent session for this workspace
                    if (workspaceFolder) {
                        const workspaceKey = host.getWorkspaceKeyForRoot(workspaceFolder);
                        await host._context.globalState.update(`recentSession.${workspaceKey}`, host.currentSessionId);
                    }
                
                    // Try to load this session's data
                    try {
                        const exportResult = await host.client.exportSession(host.currentSessionId);
                        const segMap = host.undoSegmentsBySession.get(host.currentSessionId);
                        const segments = segMap ? Array.from(segMap.values()) : [];
                        const formattedRaw = host.formatSession(exportResult);
                        const formatted = await host.injectChangeLists(host.currentSessionId, formattedRaw);

                        const liveWebview = webview;
                        liveWebview.postMessage({
                            type: 'sessionData',
                            sessionId: host.currentSessionId,
                            title: formatted.title,
                            messages: formatted.messages,
                            segments: segments,
                            meta: {
                                timelineMessageIds: host.collectVisibleSnapshotMessages(formatted.messages)
                                    .map((message: SessionMessage) => (typeof message?.id === 'string' ? message.id : ''))
                                    .filter((id: string): id is string => Boolean(id)),
                                hydrationCoverage: 'deltaContinuityUnknown' as HydrationCoverage
                            }
                        });
                        host.uiDebugChannel.appendLine(`[EXT][AUTO_SELECT_LOADED] sessionId=${host.currentSessionId} messages=${formatted.messages.length}`);
                    } catch (err) {
                        host.uiDebugChannel.appendLine(`[EXT][AUTO_SELECT_LOAD_FAILED] sessionId=${host.currentSessionId} err=${String(err)}`);
                        // Try snapshot as fallback
                        try {
                            const snap = await host.readSnapshot(host.currentSessionId);
                            if (snap?.obj?.sessionData) {
                                const segMap = host.undoSegmentsBySession.get(host.currentSessionId);
                                const segments = segMap ? Array.from(segMap.values()) : [];
                                const snapshotFormatted = await host.injectChangeLists(host.currentSessionId, {
                                    title: snap.obj.sessionData?.title || 'Session',
                                    messages: Array.isArray(snap.obj.sessionData?.messages)
                                        ? snap.obj.sessionData.messages
                                        : []
                                });
                                const liveWebview = webview;
                                liveWebview.postMessage({
                                    ...snap.obj.sessionData,
                                    title: snapshotFormatted.title,
                                    messages: snapshotFormatted.messages,
                                    segments,
                                    meta: {
                                        ...(snap.obj.sessionData?.meta || {}),
                                        hydrationCoverage: 'deltaContinuityUnknown' as HydrationCoverage
                                    }
                                });
                                host.uiDebugChannel.appendLine(`[EXT][AUTO_SELECT_SNAP_OK] sessionId=${host.currentSessionId}`);
                            }
                        } catch (snapErr) {
                            host.uiDebugChannel.appendLine(`[EXT][AUTO_SELECT_SNAP_FAILED] sessionId=${host.currentSessionId}`);
                        }
                    }
                }

            }

            if (!host.currentSessionId) {
                // No sessions exist - create new one
                host.uiDebugChannel.appendLine(`[EXT][CREATE_NEW_SESSION] reason=${sessions.length > 0 ? 'no-workspace-session-match' : 'no-sessions-exist'}`);
                try {
                    const newSession = await host.client.createSession();
                    host.currentSessionId = newSession.id;
                    host.trackUserOwnedSession(host.currentSessionId);
                    host.client.setSessionId(host.currentSessionId);
                    host.uiDebugChannel.appendLine(`[EXT][SESSION_CREATED] sessionId=${host.currentSessionId}`);
                    
                    // Save as recent session
                    if (workspaceFolder) {
                        const workspaceKey = host.getWorkspaceKeyForRoot(workspaceFolder);
                        await host._context.globalState.update(`recentSession.${workspaceKey}`, host.currentSessionId);
                    }
                    
                    const liveWebview = webview;
                    liveWebview.postMessage({
                        type: 'sessionData',
                        sessionId: host.currentSessionId,
                        title: 'New Chat',
                        messages: [],
                        segments: [],
                        meta: {
                            hydrationCoverage: 'deltaContinuityUnknown' as HydrationCoverage
                        }
                    });
                } catch (err) {
                    host.uiDebugChannel.appendLine(`[EXT][SESSION_CREATE_FAILED] err=${String(err)}`);
                    // Last resort: set a placeholder to avoid undefined
                    host.currentSessionId = `fallback-${Date.now()}`;
                }
            }
        }

        const liveWebview = webview;

        const shouldInitBaseline = Boolean(
            host.gitUndoEnabled &&
            !recentSessionId &&
            sessions.length === 0 &&
            host.currentSessionId
        );
        if (shouldInitBaseline) {
            host.pendingBaselineTurnKey = `baseline-${Date.now()}`;
            host.pendingBaselineFailed = false;
            liveWebview.postMessage({ type: 'baselineStatus', ready: false, message: 'Initializing Git baseline...' });
            let baselineResult: { ok: boolean } = { ok: false };
            try {
                baselineResult = await host.client.ensureBaselineForTurn(host.pendingBaselineTurnKey);
            } catch (err) {
                host.uiDebugChannel.appendLine(`[EXT][BASELINE_WARN] ensureBaselineForTurn failed: ${err}`);
            }
            host.baselineReady = baselineResult.ok;
            if (!baselineResult.ok) {
                host.pendingBaselineFailed = true;
                liveWebview.postMessage({ type: 'baselineStatus', ready: false, message: 'Git baseline failed. Undo unavailable.' });
            } else {
                liveWebview.postMessage({ type: 'baselineStatus', ready: true });
            }
            if (host.currentSessionId) {
                host.setSessionUndoEnabled(host.currentSessionId, baselineResult.ok, liveWebview);
            }
        }

        host.uiDebugChannel.appendLine(`[EXT][SENDINIT_END] sendInit completed successfully`);

}
