import type * as vscode from 'vscode';
import * as pathModule from 'path';
import type { ChatEvent, CommitPendingTurnChangesResult } from '../OpenCodeClient';

/**
 * Adapts client chat events to Webview protocol messages. SidebarProvider remains
 * the lifecycle/state owner and is passed explicitly as the host.
 */
export async function handleSidebarChatEvent(
    host: any,
    event: ChatEvent,
    webview: vscode.Webview
): Promise<void> {
        if (host.smartSearchSessions.owns(event.sessionId)) {
            return;
        }
        // Handle todoUpdate event for main session or parent-mapped subagent todos.
        if (event.type === 'todoUpdate' && (host.isUserOwnedSession(event.sessionId || '') || event.displayTarget === 'parent')) {
            webview.postMessage({
                type: 'todoUpdate',
                todos: event.todos,
                anchorMessageId: event.assistantMsgId,
                sessionId: event.sessionId,
                parentSessionId: event.parentSessionId,
                agentSessionId: event.agentSessionId,
                displayTarget: event.displayTarget,
            });
            return;
        }
        if (event.type === 'assistantPhase' && event.sessionId) {
            webview.postMessage({
                type: 'assistantPhase',
                sessionId: event.sessionId,
                messageId: event.messageId || event.assistantMsgId || '',
                parentId: event.parentId,
                parentSessionId: event.parentSessionId,
                agentSessionId: event.agentSessionId,
                displayTarget: event.displayTarget,
                phase: event.phase || '',
                lane: event.lane || 'unknown',
                ts: Date.now()
            });
            return;
        }
        if (event.type === 'appendUserMessage' && event.sessionId) {
            const liveWebview = host._view?.webview || webview;
            liveWebview.postMessage({
                type: 'appendUserMessage',
                sessionId: event.sessionId,
                rootUserMsgId: event.rootUserMsgId,
                appendUserMsgId: event.appendUserMsgId || event.messageId,
                clientMessageId: event.clientMessageId,
                text: event.text || ''
            });
            return;
        }
        if (event.type === 'sessionUsage' && event.sessionId && event.usage) {
            const liveWebview = host._view?.webview || webview;
            liveWebview.postMessage({
                type: 'sessionUsage',
                sessionId: event.sessionId,
                used: event.usage.used,
                size: event.usage.size,
                amount: event.usage.amount
            });
            return;
        }
        if (event.type === 'turnResolved' && event.sessionId) {
            const liveWebview = host._view?.webview || webview;
            await host.finalizeResolvedTurn(event.sessionId, liveWebview, event.assistantMsgId);
            return;
        }
        if (event.type === 'session' && event.sessionId) {
            if (!host.isUserOwnedSession(event.sessionId) && !host.currentSessionId) {
                host.currentSessionId = event.sessionId;
                host.trackUserOwnedSession(host.currentSessionId);
                host.client.setSessionId(host.currentSessionId);
                const liveWebview = host._view?.webview || webview;
                liveWebview.postMessage({ type: 'sessionId', value: event.sessionId, sessionId: event.sessionId });
                host.uiDebugChannel.appendLine(`[SidebarProvider] Promoted first session to currentSessionId: ${event.sessionId}`);
                return;
            }
            const explicitParentSessionId = event.parentSessionId;
            if (!host.isUserOwnedSession(event.sessionId) && explicitParentSessionId) {
                host.activeSubagentSessionIds.add(event.sessionId);
                host.client.registerSubagentSession(event.sessionId, explicitParentSessionId);
                const existing = host.subagentProgressBySession.get(event.sessionId);
                const initialMode = event.mode || event.agent || '';
                const initialModel = event.modelID || '';
                const initialProvider = event.providerID || '';
                if (existing) {
                    if (initialMode) {
                        existing.mode = initialMode;
                        existing.description = existing.description || initialMode;
                    }
                    if (initialModel) {
                        existing.model = initialModel;
                    }
                    if (initialProvider) {
                        existing.providerId = initialProvider;
                    }
                    host.logSubagentRoute('register', existing.parentSessionId || explicitParentSessionId, event.sessionId, 'parent', 'existing-entry');
                    host.uiDebugChannel.appendLine(`[SidebarProvider] Subagent session event: ${event.sessionId} | mode=${event.mode || 'null'} | agent=${event.agent || 'null'} | modelID=${event.modelID || 'null'} | providerID=${event.providerID || 'null'}`);
                    host.emitSubagentStatus();
                    return;
                }
                host.subagentProgressBySession.set(event.sessionId, {
                    taskId: event.sessionId,
                    parentSessionId: explicitParentSessionId,
                    description: initialMode,
                    mode: initialMode,
                    model: initialModel,
                    providerId: initialProvider,
                    isDone: false,
                    state: 'queued',
                    lastEventAt: Date.now(),
                    startedAt: Date.now()
                });
                host.logSubagentRoute('register', explicitParentSessionId, event.sessionId, 'parent', 'explicit-parent');
                host.uiDebugChannel.appendLine(`[SidebarProvider] Registered subagent session mapping: ${event.sessionId} -> ${explicitParentSessionId}`);
                host.uiDebugChannel.appendLine(`[SidebarProvider] Subagent session event: ${event.sessionId} | mode=${event.mode || 'null'} | agent=${event.agent || 'null'} | modelID=${event.modelID || 'null'} | providerID=${event.providerID || 'null'}`);
                const sessionId = event.sessionId;
                host.client.getSessionInfo(sessionId).then((info: any) => {
                    const entry = host.subagentProgressBySession.get(sessionId);
                    if (entry) {
                        entry.title = host.cleanSubagentTitle(info?.title) || '';
                        entry.mode = entry.mode || info?.mode || info?.agent || '';
                        entry.description = entry.description || entry.mode || '';
                        entry.model = entry.model || info?.modelID || info?.model || info?.config?.model || '';
                        entry.providerId = entry.providerId || info?.providerID || info?.providerId || info?.config?.providerID || info?.config?.providerId || '';
                        host.emitSubagentStatus();
                    }
                }).catch(() => {});
                host.emitSubagentStatus(true);
                return;
            }

            // Guard: Prevent subagent session IDs from hijacking currentSessionId
            if (!host.isUserOwnedSession(event.sessionId)) {
                const mappedParentSessionId = host.subagentProgressBySession.get(event.sessionId)?.parentSessionId
                    || host.client.getParentSessionForSubagent(event.sessionId);
                if (!mappedParentSessionId) {
                    host.logSubagentRoute('register', undefined, event.sessionId, 'parent', 'missing-parent', true);
                    return;
                }
                host.activeSubagentSessionIds.add(event.sessionId);
                host.client.registerSubagentSession(event.sessionId, mappedParentSessionId);
                const existing = host.subagentProgressBySession.get(event.sessionId);
                const initialMode = event.mode || event.agent || '';
                const initialModel = event.modelID || '';
                const initialProvider = event.providerID || '';
                if (existing) {
                    if (initialMode) {
                        existing.mode = initialMode;
                        existing.description = existing.description || initialMode;
                    }
                    if (initialModel) {
                        existing.model = initialModel;
                    }
                    if (initialProvider) {
                        existing.providerId = initialProvider;
                    }
                    host.logSubagentRoute('register', existing.parentSessionId || mappedParentSessionId, event.sessionId, 'parent', 'existing-entry');
                    host.uiDebugChannel.appendLine(`[SidebarProvider] Subagent session event: ${event.sessionId} | mode=${event.mode || 'null'} | agent=${event.agent || 'null'} | modelID=${event.modelID || 'null'} | providerID=${event.providerID || 'null'}`);
                    host.emitSubagentStatus();
                    return;
                }
                host.subagentProgressBySession.set(event.sessionId, {
                    taskId: event.sessionId,
                    parentSessionId: mappedParentSessionId,
                    description: initialMode,
                    mode: initialMode,
                    model: initialModel,
                    providerId: initialProvider,
                    isDone: false,
                    state: 'queued',
                    lastEventAt: Date.now(),
                    startedAt: Date.now()
                });
                host.logSubagentRoute('register', mappedParentSessionId, event.sessionId, 'parent', 'mapped-parent');
                host.uiDebugChannel.appendLine(`[SidebarProvider] Subagent session event: ${event.sessionId} | mode=${event.mode || 'null'} | agent=${event.agent || 'null'} | modelID=${event.modelID || 'null'} | providerID=${event.providerID || 'null'}`);
                const sessionId = event.sessionId;
                host.client.getSessionInfo(sessionId).then((info: any) => {
                    const entry = host.subagentProgressBySession.get(sessionId);
                    if (entry) {
                        entry.title = host.cleanSubagentTitle(info?.title) || '';
                        entry.mode = entry.mode || info?.mode || info?.agent || '';
                        entry.description = entry.description || entry.mode || '';
                        entry.model = entry.model || info?.modelID || info?.model || info?.config?.model || '';
                        entry.providerId = entry.providerId || info?.providerID || info?.providerId || info?.config?.providerID || info?.config?.providerId || '';
                        host.emitSubagentStatus();
                    }
                }).catch(() => {});
                host.emitSubagentStatus(true);
                return;
            }

            const prevSessionId = host.currentSessionId;
            const nextSessionId = event.sessionId;
            host.currentSessionId = nextSessionId;
            host.client.setSessionId(host.currentSessionId);
            const liveWebview = host._view?.webview || webview;
            if (prevSessionId && prevSessionId !== event.sessionId) {
                liveWebview.postMessage({ type: 'questionOverlayClose', reason: 'session-switch', sessionId: event.sessionId });
                liveWebview.postMessage({ type: 'permissionOverlayClose', reason: 'session-switch', sessionId: event.sessionId });
            }
            liveWebview.postMessage({ type: 'sessionId', value: event.sessionId, sessionId: event.sessionId });
            if (host.pendingBaselineTurnKey) {
                const turnKey = host.pendingBaselineTurnKey;
                host.pendingBaselineTurnKey = undefined;
                if (host.pendingBaselineFailed) {
                    host.pendingBaselineFailed = false;
                    host.baselineReady = false;
                    liveWebview.postMessage({ type: 'baselineStatus', ready: false, message: 'Git baseline failed. Undo unavailable.' });
                    host.setSessionUndoEnabled(event.sessionId, false, liveWebview);
                } else {
                    host.client.ensureBaselineReady(event.sessionId, turnKey).then((result: { ok: boolean; reason?: string }) => {
                        host.baselineReady = result.ok;
                        if (!result.ok) {
                            liveWebview.postMessage({ type: 'baselineStatus', ready: false, message: 'Git baseline failed. Undo unavailable.' });
                            host.setSessionUndoEnabled(event.sessionId, false, liveWebview);
                        } else {
                            liveWebview.postMessage({ type: 'baselineStatus', ready: true });
                            host.setSessionUndoEnabled(event.sessionId, true, liveWebview);
                        }
                    });
                }
            }
            return;
        }

        if (event.sessionId && host.activeSubagentSessionIds.has(event.sessionId)) {
            // Intercept subagent events to update progress
            const subagentEntry = host.subagentProgressBySession.get(event.sessionId);
            const parentSessionId = subagentEntry?.parentSessionId;
            if (!subagentEntry || !parentSessionId) {
                host.logSubagentRoute(String(event.type || 'event'), parentSessionId, event.sessionId, 'parent', subagentEntry ? 'missing-parent' : 'missing-entry', true);
                return;
            }
            if (event.type === 'text' && typeof event.text === 'string') {
                const entry = subagentEntry;
                if (entry) {
                    if (entry.isDone) {
                        return;
                    }
                    entry.latestFullText = event.text;
                    entry.latestText = event.text.length > 200
                        ? event.text.slice(0, 200) + '...'
                        : event.text;
                    host.transitionSubagentState(event.sessionId, entry, 'running', 'progress');
                    host.emitSubagentStatus();
                }
            }
            // Handle generic tool events (e.g., grep, read, etc.)
            if (event.type === 'tool' && event.tool) {
                const entry = subagentEntry;
                if (entry) {
                    if (entry.isDone) {
                        return;
                    }
                    const toolName = event.tool;
                    const status = event.toolState?.status || 'running';
                    if (status === 'running' || status === 'pending') {
                        entry.latestTool = toolName;
                        const input = event.toolState?.input;
                        if (input && typeof input === 'object') {
                            // Extract meaningful input display
                            const inputDisplay = input.filePath || input.path || input.pattern || input.query || '';
                            entry.latestToolInput = inputDisplay;
                        } else {
                            entry.latestToolInput = '';
                        }
                        host.transitionSubagentState(event.sessionId, entry, 'running', 'tool-progress');
                        host.emitSubagentStatus();
                    }
                }
            }
            if (event.type === 'toolPatch' && typeof event.text === 'string') {
                const entry = subagentEntry;
                if (entry) {
                    if (entry.isDone) {
                        return;
                    }
                    const match = event.text.match(/(?:---\s+a\/|\+\+\+\s+b\/|diff\s+--git\s+[^\s]+\s+b\/)([^\s\n]+)/);
                    const filepath = match ? match[1] : '';
                    const filename = filepath ? pathModule.basename(filepath) : '';
                    entry.latestTool = 'Applying patch' + (filename ? ': ' + filename : '');
                    entry.latestToolInput = filepath || '';
                    host.transitionSubagentState(event.sessionId, entry, 'running', 'tool-patch');
                    host.emitSubagentStatus();
                }
            }
            if (event.type === 'diff' && typeof event.text === 'string') {
                const entry = subagentEntry;
                if (entry) {
                    if (entry.isDone) {
                        return;
                    }
                    const match = event.text.match(/(?:---\s+a\/|\+\+\+\s+b\/|diff\s+--git\s+[^\s]+\s+b\/)([^\s\n]+)/);
                    const filepath = match ? match[1] : '';
                    const filename = filepath ? pathModule.basename(filepath) : '';
                    entry.latestTool = 'Editing ' + (filename || 'file');
                    entry.latestToolInput = filepath || '';
                    host.transitionSubagentState(event.sessionId, entry, 'running', 'diff-progress');
                    host.emitSubagentStatus();
                }
            }
            if (event.type === 'files' && event.files && event.files.length) {
                const entry = subagentEntry;
                const isReplay = event.source === 'resync';
                if (!isReplay) {
                    host.client.queueSubagentChanges(parentSessionId, event.files);
                    host.logSubagentRoute('files', parentSessionId, event.sessionId, 'parent', 'queue-subagent-changes');
                }
                if (entry && event.files && event.files.length && !entry.isDone) {
                    const firstFile = typeof event.files[0] === 'string' ? event.files[0] : (event.files[0] as any).path || '';
                    const filename = firstFile ? pathModule.basename(firstFile) : 'file';
                    entry.latestTool = 'Writing ' + filename;
                    entry.latestToolInput = firstFile || '';
                    host.transitionSubagentState(event.sessionId, entry, 'running', 'files-progress');
                    host.emitSubagentStatus();
                }
                const liveWebview = host._view?.webview || webview;
                if (!isReplay) {
                    liveWebview.postMessage({
                        type: 'segmentRestoreLock',
                        sessionId: parentSessionId,
                        parentSessionId,
                        agentSessionId: event.sessionId,
                        displayTarget: 'parent',
                        reason: 'file-change-detected'
                    });
                    event.files.forEach((file, index) => {
                        host.tryOpenDiffForEventFile(file, liveWebview, index, parentSessionId, 'subagent');
                    });
                    
                    // Detect .md files and send plan file card
                    const mdFiles = event.files
                        .map(f => (typeof f === 'string' ? f : (f as any).path))
                        .filter((path): path is string => typeof path === 'string' && path.endsWith('.md'));
                    if (mdFiles.length) {
                        const anchorMessageId = host.client.getTurnAssistantMsgId(parentSessionId);
                        if (anchorMessageId) {
                            liveWebview.postMessage({
                                type: 'planFileCard',
                                files: mdFiles,
                                anchorMessageId,
                                sessionId: parentSessionId,
                                parentSessionId,
                                agentSessionId: event.sessionId,
                                displayTarget: 'parent'
                            });
                        }
                    }
                }
                // REMOVED: Mid-stream emitDiffFileList call
                // Change-list should only emit after finalization sequence (chatDone → commit → upgrade → diffList)
                // This prevents premature change-list emission before final assistant message
            }
            if (event.type === 'assistantMessageMeta' && event.sessionId && !event.isStatusUpdate) {
                const entry = subagentEntry;
                if (entry) {
                    entry.finalMessageId = event.assistantMsgId || event.messageId;
                    host.transitionSubagentState(event.sessionId, entry, 'done', 'assistant-final-accepted');
                    entry.finishedAt = Date.now();
                    entry.dismissAt = entry.finishedAt + host.subagentDoneRetentionMs;
                    host.scheduleSubagentRetentionSweep();
                    host.emitSubagentStatus();
                }
            }
            return;
        }

        if (event.type === 'questionOverlay' && event.sessionId && event.callId) {
            const liveWebview = host._view?.webview || webview;
            liveWebview.postMessage({
                type: 'questionOverlay',
                sessionId: event.sessionId,
                callId: event.callId,
                requestId: event.requestId,
                title: event.title,
                prompt: event.prompt,
                options: event.options,
                questions: event.questions
            });
            return;
        }

        if (event.type === 'permissionRequest' && event.sessionId && event.permissionId) {
            const liveWebview = host._view?.webview || webview;
            liveWebview.postMessage({
                type: 'permissionOverlay',
                sessionId: event.sessionId,
                permissionId: event.permissionId,
                requestId: event.requestId,
                permission: event.permission || '',
                patterns: Array.isArray(event.patterns) ? event.patterns : [],
                metadata: event.metadata || null,
                callId: event.callId || null
            });
            return;
        }

        if (event.type === 'permissionReplied' && event.sessionId && event.permissionId) {
            const liveWebview = host._view?.webview || webview;
            liveWebview.postMessage({
                type: 'permissionOverlayClose',
                reason: 'permission-replied',
                sessionId: event.sessionId,
                permissionId: event.permissionId,
                response: event.response || 'once'
            });
            return;
        }

        if (event.type === 'autoResumeStallWarn' && event.sessionId) {
            if (host.shouldSuppressWebviewStuckCardForAutoRescue(event.sessionId, 'autoResumeStallWarn')) {
                return;
            }
            const liveWebview = host._view?.webview || webview;
            liveWebview.postMessage({
                type: 'systemNotice',
                sessionId: event.sessionId,
                level: 'warn',
                message: event.text || 'This session may be stuck. Please reload the extension and continue.'
            });
            return;
        }

        if (event.type === 'autoResumeStallClear' && event.sessionId) {
            const liveWebview = host._view?.webview || webview;
            liveWebview.postMessage({
                type: 'systemNoticeClear',
                sessionId: event.sessionId
            });
            return;
        }

        if (event.type === 'autoResumeHardStop' && event.sessionId) {
            if (host.shouldSuppressWebviewStuckCardForAutoRescue(event.sessionId, 'autoResumeHardStop')) {
                return;
            }
            const liveWebview = host._view?.webview || webview;
            host.uiDebugChannel.appendLine(`EXT: autoresume.hardstop | sessionId=${event.sessionId} | action=show-stall-card`);
            host.sendInFlightBySession.delete(event.sessionId);
            liveWebview.postMessage({ type: 'turnInFlight', sessionId: event.sessionId, inFlight: false });
            host.syncTurnInFlightAfterFinalize(event.sessionId, liveWebview, 'autoResumeHardStop');
            await host.runPendingSendInitGuardCompensation(event.sessionId, liveWebview, 'autoResumeHardStop');
            liveWebview.postMessage({
                type: 'stallCard',
                sessionId: event.sessionId,
                title: event.title || 'Session may be stuck',
                message: event.text || 'This session appears to be unresponsive. Please reload the extension and continue.',
                actionLabel: event.actionLabel || 'Reload Window',
                secondaryActionLabel: event.secondaryActionLabel || 'Keep waiting'
            });
            return;
        }

        if (event.type === 'turnInFlight' && event.sessionId) {
            const liveWebview = host._view?.webview || webview;
            if (event.inFlight === true) {
                host.sendInFlightBySession.add(event.sessionId);
                host.markWebviewActiveTurnUpdated(event.sessionId, 'event:turnInFlight:true');
            } else {
                host.sendInFlightBySession.delete(event.sessionId);
                host.markWebviewActiveTurnUpdated(event.sessionId, 'event:turnInFlight:false');
            }
            liveWebview.postMessage({
                type: 'turnInFlight',
                sessionId: event.sessionId,
                inFlight: event.inFlight === true,
                ownerMsgId: event.ownerMsgId,
                assistantMsgId: event.assistantMsgId,
                appendFollowup: event.appendFollowup,
            });
            if (event.inFlight !== true) {
                host.syncTurnInFlightAfterFinalize(event.sessionId, liveWebview, 'event:turnInFlight:false');
                await host.runPendingSendInitGuardCompensation(event.sessionId, liveWebview, 'event:turnInFlight:false');
            }
            return;
        }

        if (event.type === 'backgroundActivityPulse' && event.sessionId) {
            const liveWebview = host._view?.webview || webview;
            liveWebview.postMessage({
                type: 'backgroundActivityPulse',
                sessionId: event.sessionId,
                parentSessionId: event.parentSessionId,
                agentSessionId: event.agentSessionId,
                displayTarget: event.displayTarget,
                assistantMsgId: event.assistantMsgId,
                ts: Date.now()
            });
            return;
        }

        if (event.type === 'assistantMessageMeta' && (event.messageId || event.assistantMsgId)) {
            const liveWebview = host._view?.webview || webview;
            const sessionId = event.sessionId;
            if (!sessionId) {
                host.uiDebugChannel.appendLine('[EXT][SESSION_ROUTE_DROP] event=assistantMessageMeta reason=missing-event-session');
                return;
            }
            const eventTmpKey = typeof (event as any).tmpKey === 'string' ? (event as any).tmpKey : undefined;
            const sessionTmpKey = sessionId ? host.pendingAssistantTmpKeyBySession.get(sessionId) : undefined;
            const isAppendFollowup = Boolean(event.appendFollowup);
            const tmpKey = isAppendFollowup ? undefined : (eventTmpKey || sessionTmpKey);
            if (isAppendFollowup && sessionId) host.consumeAppendSuccessorTmpKey?.(sessionId, event.appendFollowup);
            if (sessionId && tmpKey && tmpKey.startsWith('tmp:')) {
                host.pendingAssistantTmpKeyBySession.set(sessionId, tmpKey);
                const pendingLocalKey = host.pendingLocalKeyBySession.get(sessionId);
                if (pendingLocalKey && pendingLocalKey.startsWith('local-')) {
                    host.pendingAssistantTmpKeyByLocalKey.set(pendingLocalKey, tmpKey);
                }
            }
            if (event.assistantMsgId && sessionId) {
                host.uiDebugChannel.appendLine(`[DBG_ASSIST_ID] session=${sessionId} assistantMsgId=${event.assistantMsgId} tmpKey=${tmpKey || 'null'}`);
            }
            if (sessionId) {
                host.markWebviewActiveTurnUpdated(sessionId, 'event:assistantMessageMeta');
            }
            const isSyntheticTurn = host.isCurrentTurnSynthetic(sessionId);
            liveWebview.postMessage({
                type: 'assistantMessageMeta',
                messageId: event.messageId,
                messageIndex: event.messageIndex,
                lastText: event.lastText,
                sessionId,
                parentSessionId: event.parentSessionId,
                agentSessionId: event.agentSessionId,
                displayTarget: event.displayTarget,
                assistantMsgId: event.assistantMsgId,
                ...(isAppendFollowup ? {} : { tmpKey }),
                appendFollowup: event.appendFollowup,
                isStatusUpdate: event.isStatusUpdate,
                allowedSessionIds: event.displayTarget === 'agent-lane' && event.agentSessionId
                    ? [event.agentSessionId, ...(event.parentSessionId ? [event.parentSessionId] : [])]
                    : host.getAssistantMetaAllowedSessionIds(sessionId),
                ...(isSyntheticTurn ? { isSyntheticTurn: true } : {})
            });
            if (sessionId && typeof event.assistantMsgId === 'string' && typeof event.messageIndex === 'number') {
                liveWebview.postMessage({
                    type: 'messageIndexMapDelta',
                    sessionId,
                    messageId: event.assistantMsgId,
                    messageIndex: event.messageIndex,
                    phase: 'final-early',
                    appendFollowup: event.appendFollowup,
                });
            }
            return;
        }

        if (event.type === 'text' && event.text) {
            const sessionId = event.sessionId;
            if (!sessionId) {
                host.uiDebugChannel.appendLine('[EXT][SESSION_ROUTE_DROP] event=text reason=missing-event-session');
                return;
            }
            if (sessionId) {
                host.markWebviewActiveTurnUpdated(sessionId, 'event:text');
                host.appendAssistantBuffer(sessionId, event.text);
                // Push latest chunk to webview (no cumulative text)
                const liveWebview = host._view?.webview || webview;
                const isSyntheticTurn = host.isCurrentTurnSynthetic(sessionId);
                liveWebview?.postMessage({
                    type: 'assistantMessageMeta',
                    sessionId,
                    parentSessionId: event.parentSessionId,
                    agentSessionId: event.agentSessionId,
                    displayTarget: event.displayTarget,
                    assistantMsgId: event.assistantMsgId,
                    ...(event.appendFollowup ? {} : { tmpKey: host.pendingAssistantTmpKeyBySession?.get(sessionId) }),
                    appendFollowup: event.appendFollowup,
                    lastText: event.text,
                    isStatusUpdate: false,
                    allowedSessionIds: event.displayTarget === 'agent-lane' && event.agentSessionId
                        ? [event.agentSessionId, ...(event.parentSessionId ? [event.parentSessionId] : [])]
                        : host.getAssistantMetaAllowedSessionIds(sessionId),
                    ...(isSyntheticTurn ? { isSyntheticTurn: true } : {})
                });
            }
            return;
        }

        if (event.type === 'error' && event.text) {
            const liveWebview = host._view?.webview || webview;
            const sessionId = event.sessionId;
            if (!sessionId) {
                host.uiDebugChannel.appendLine('[EXT][SESSION_ROUTE_DROP] event=error reason=missing-event-session');
                return;
            }
            liveWebview.postMessage({ type: 'addResponse', value: `Error: ${event.text}`, sessionId, skipSnapshot: true });
            // Cleanup before chatDone
            if (sessionId) {
                await host.commitPendingTurnChangesFromAuthoritativeFiles(host.buildFinalizeTurnIdentity(sessionId, {
                    reqId: 'event-error-finalize',
                    assistantMessageId: host.client.getTurnAssistantMsgId(sessionId)
                }));
            }
            await host.resolvePendingUserUpgrade(sessionId, liveWebview);
            // Mark all active subagents as done before clearing (error event path)
            host.markSubagentsTerminalForParent(sessionId, 'failed', 'event-error-finalize');
            host.emitSubagentStatus();
            host.clearSubagentSessionsForParent(sessionId, 'event-error-finalize');

            const doneAssistantMsgId = sessionId
                ? host.client.getTurnAssistantMsgId(sessionId)
                : undefined;
            liveWebview.postMessage({
                type: 'chatDone',
                sessionId,
                assistantMsgId: doneAssistantMsgId,
                lastAssistantMsgId: doneAssistantMsgId
            });
            host.emitTurnFinalizePhase(liveWebview, sessionId, 'stream_done');
            host.emitTurnFinalizePhase(liveWebview, sessionId, 'commit_done');
            host.emitTurnFinalizePhase(liveWebview, sessionId, 'upgrade_done');
            const pendingLocalKey = sessionId ? host.pendingLocalKeyBySession.get(sessionId) : undefined;
            if (sessionId && sessionId === host.currentSessionId && pendingLocalKey && host.pendingClientMessageId === pendingLocalKey) {
                host.clearDraft(host.pendingClientMessageId);
                await host.handleAbortedMessage(host.pendingClientMessageId, liveWebview);
                host.pendingClientMessageId = undefined;
            }
            if (sessionId) {
                if (pendingLocalKey) {
                    host.pendingAssistantTmpKeyByLocalKey.delete(pendingLocalKey);
                    host.rawUserTextByLocalKey.delete(pendingLocalKey);
                }
                host.assistantTextBufferBySession.delete(sessionId);
                host.pendingAssistantTmpKeyBySession.delete(sessionId);
                host.pendingLocalKeyBySession.delete(sessionId);
                host.sendInFlightBySession.delete(sessionId);
                liveWebview.postMessage({ type: 'turnInFlight', sessionId, inFlight: false });
                host.client.finishTurn(sessionId);
                host.syncTurnInFlightAfterFinalize(sessionId, liveWebview, 'event-error-finalize');
            }
            host.emitTurnFinalizePhase(liveWebview, sessionId, 'finalize_done');
            await host.runPendingSendInitGuardCompensation(sessionId, liveWebview, 'event-error-finalize');
            return;
        }

        if (event.type === 'permission' && event.text) {
            const liveWebview = host._view?.webview || webview;
            if (!event.sessionId) {
                host.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE_DROP] event=permissionPrompt reason=missing-event-session`);
                return;
            }
            host.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE] event=permissionPrompt targetSessionId=${event.sessionId}`);
            liveWebview.postMessage({ type: 'permissionPrompt', value: event.text, sessionId: event.sessionId });
            return;
        }

        if (event.type === 'message' && event.text) {
            const sessionId = event.sessionId;
            if (!sessionId) {
                host.uiDebugChannel.appendLine('[EXT][SESSION_ROUTE_DROP] event=userAckBind reason=missing-event-session');
                return;
            }
            const localKey = host.pendingClientMessageId
                || (sessionId ? host.pendingLocalKeyBySession.get(sessionId) : undefined)
                || null;
            if (localKey && sessionId) {
                const mappedMessageIndex = host.client.getMessageIndex(localKey, sessionId)
                    ?? host.client.registerMessage(localKey, sessionId);
                host.client.aliasMessageId(localKey, event.text);
                const internalId = host.clientMessageIdMap.get(localKey);
                if (internalId && internalId !== event.text) {
                    host.client.aliasMessageId(internalId, event.text);
                }
                const internalForPending = host.clientMessageIdMap.get(localKey);
                if (internalForPending) {
                    host.client.aliasMessageId(event.text, internalForPending);
                }
                host.clientMessageIdMap.delete(localKey);
                host.clientMessageIdMap.set(event.text, event.text);
                const rawUserText = host.rawUserTextByLocalKey.get(localKey);
                if (typeof rawUserText === 'string') {
                    host.rawUserTextByMsgId.set(event.text, rawUserText);
                    host.rawUserTextByLocalKey.delete(localKey);
                }
                if (host.pendingClientMessageId === localKey) {
                    host.pendingClientMessageId = undefined;
                }
                host.uiDebugChannel.appendLine(`EXT: user.ack.bind | sessionId=${sessionId} | localKey=${localKey} | msgId=${event.text}`);
                const liveWebview = host._view?.webview || webview;
                liveWebview.postMessage({
                    type: 'userAckBind',
                    sessionId,
                    localKey,
                    msgId: event.text
                });
            }
            return;
        }

        if (event.type === 'diff' && event.text) {
            const liveWebview = host._view?.webview || webview;
            if (!event.sessionId) {
                host.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE_DROP] event=diffChunk reason=missing-event-session`);
                return;
            }
            host.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE] event=diffChunk targetSessionId=${event.sessionId}`);
            liveWebview.postMessage({ type: 'diffChunk', value: event.text, sessionId: event.sessionId });
            return;
        }

        if (event.type === 'files' && event.files && event.files.length) {
            const sessionId = event.sessionId;
            if (!sessionId) {
                host.uiDebugChannel.appendLine('[EXT][SESSION_ROUTE_DROP] event=files reason=missing-event-session');
                return;
            }
            const picked = host.pickActiveFile(event.files);
            if (!picked) return;
            const { file: active, index } = picked;
            const liveWebview = host._view?.webview || webview;
            liveWebview.postMessage({
                type: 'segmentRestoreLock',
                sessionId,
                reason: 'file-change-detected'
            });
            host.tryOpenDiffForEventFile(active, liveWebview, index, sessionId, 'main');
            const inGrace = Boolean(sessionId && host.client.isInLateDiffGrace(sessionId));
            const inRecentFinishWindow = Boolean(sessionId && host.client.wasTurnFinishedRecently(sessionId, 5000));
            if (sessionId && (inGrace || inRecentFinishWindow)) {
                host.uiDebugChannel.appendLine(
                    `[LATE_DIFF] event in recovery window | sessionId=${sessionId} eventType=files inGrace=${inGrace} recentFinish=${inRecentFinishWindow}`
                );
                if (!host.client.wasChangeListEmitted(sessionId)) {
                    let commitResult: CommitPendingTurnChangesResult | undefined;
                    try {
                        commitResult = await host.commitPendingTurnChangesFromAuthoritativeFiles(host.buildFinalizeTurnIdentity(sessionId, {
                            reqId: 'late-event-recovery',
                            assistantMessageId: host.client.getTurnAssistantMsgId(sessionId)
                        }));
                        host.uiDebugChannel.appendLine(`[LATE_DIFF] committed pending turn changes | sessionId=${sessionId} reason=late-event-recovery status=${commitResult?.status || 'missing'}`);
                    } catch (error) {
                        host.uiDebugChannel.appendLine(`[LATE_DIFF] commit pending failed | sessionId=${sessionId} err=${String(error)}`);
                    }
                    if (!host.hasRenderableDiffPayload(active)) {
                        try {
                            await host.openGitDiffForFile(sessionId, active.filePath, liveWebview);
                            host.uiDebugChannel.appendLine(`[LATE_DIFF] opened git diff | sessionId=${sessionId} file=${active.filePath}`);
                        } catch (error) {
                            host.uiDebugChannel.appendLine(`[LATE_DIFF] open git diff failed | sessionId=${sessionId} file=${active.filePath} err=${String(error)}`);
                        }
                    }
                    host.uiDebugChannel.appendLine(`[LATE_DIFF] emitting change-list | sessionId=${sessionId} reason=late-event-recovery`);
                    void host.emitDiffFileListWithRetry(host.buildFinalizeTurnIdentity(sessionId, {
                        reqId: 'late-event-recovery',
                        commitResult
                    }), liveWebview);
                } else {
                    host.uiDebugChannel.appendLine(`[LATE_DIFF] change-list already emitted | sessionId=${sessionId} skipping=true`);
                }
            }
            
            // Detect .md files and send plan file card
            const mdFiles = event.files
                .map(f => (typeof f === 'string' ? f : (f as any).path))
                .filter((path): path is string => typeof path === 'string' && path.endsWith('.md'));
            if (mdFiles.length) {
                const anchorMessageId = host.client.getTurnAssistantMsgId(sessionId);
                if (anchorMessageId) {
                    liveWebview.postMessage({
                        type: 'planFileCard',
                        files: mdFiles,
                        anchorMessageId,
                        sessionId
                    });
                }
            }
            // REMOVED: Mid-stream emitDiffFileList call
            // Change-list should only emit after finalization sequence (chatDone → commit → upgrade → diffList)
            // This prevents premature change-list emission before final assistant message
            return;
        }

        if (event.type === 'raw' && event.text) {
            // Ignore raw streaming chunks for non-streaming UI.
        }
    
}
