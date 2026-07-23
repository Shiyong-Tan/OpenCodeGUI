import * as vscode from 'vscode';
import * as pathModule from 'path';
import { OpenCodeClient } from '../OpenCodeClient';
import type { AttachmentPayload, SavedAttachment } from '../attachments/AttachmentStorageService';
import type { SessionMessage } from '../changes/ChangeListInjection';
import { serializeUndoSegments, type SegmentState } from '../undo/UndoSegmentPersistence';
import { captureCancelTurnOwner } from './CancelTurnOwner';
import type { UtilityCommandHandler } from './controllers/UtilityCommandController';

type HydrationCoverage = 'authoritativeHistoryComplete' | 'deltaContinuityUnknown' | 'repairInProgress' | 'repairError';

/** Owns Webview command registration and protocol dispatch for SidebarProvider. */
export function resolveSidebarWebviewView(
    host: any,
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
    utilityCommandHandler: UtilityCommandHandler
): void {
        host._view = webviewView;
        const panelId = `panel-${++host.webviewLivenessPanelSeq}`;
        host.resetWebviewLiveness('webview-recreate');
        host.uiDebugChannel.appendLine(`EXT: webviewLiveness.panel | phase=resolve | panelId=${panelId}`);
        host.uiDebugChannel.appendLine(`EXT: webviewReload.external-unobservable | reason=vscode-developer-reload-webviews-command-not-interceptable | observablePoints=resolve,handshake,dispose | panelId=${panelId} | previousWebviewInstanceId=${host._webviewInstanceId || 'null'} | reload=false | recreate=false | sessionMutation=false`);
        host.uiDebugChannel.appendLine(`EXT: webviewReload.expected-new-webview | phase=resolve | panelId=${panelId} | previousWebviewInstanceId=${host._webviewInstanceId || 'null'} | reload=false | recreate=false | sessionMutation=false`);

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [host._extensionUri],
        };

        webviewView.webview.html = host._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            const activeWebview = host._view?.webview || webviewView.webview;
            try {
                const keys = data && typeof data === 'object' ? Object.keys(data).sort() : [];
                host.uiDebugChannel.appendLine(`EXT: wv.msg | type=${data?.type || 'unknown'} | keys=[${keys.join(',')}]`);
            } catch {
                host.uiDebugChannel.appendLine('EXT: wv.msg | type=unknown | keys=[]');
            }

            // Diagnostic logging for undoToMessage
            if (data.type === 'undoToMessage') {
                host.uiDebugChannel.appendLine(`[EXT][UNDO_ENTRY] type=${data.type} messageId=${data.messageId || 'NULL'} sessionId=${data.sessionId || 'NULL'} operationId=${data.operationId || 'NULL'} hasMessageId=${!!data.messageId}`);
            }

            const utilityHandling = utilityCommandHandler(data, activeWebview, webviewView.webview);
            if (utilityHandling !== false && await utilityHandling) {
                return;
            }

            switch (data.type) {
                case "webviewReady": {
                    if (await host.handleWebviewCommandReloadReady(data, webviewView, panelId)) {
                        break;
                    }
                    const pending = host.webviewHardRescuePending;
                    const newWebviewInstanceId = typeof data?.webviewInstanceId === 'string' ? data.webviewInstanceId.trim() : '';
                    let hardRescueGuard: (() => boolean) | undefined;
                    if (pending) {
                        const currentActiveTurn = host.getWebviewLivenessActiveTurnFlags(pending.sessionId);
                        let rejectionReason = '';
                        if (data.hardRescueGenerationToken !== pending.generationToken) rejectionReason = 'generation-token-mismatch';
                        else if (!newWebviewInstanceId) rejectionReason = 'missing-webview-instance-id';
                        else if (newWebviewInstanceId === pending.oldWebviewInstanceId) rejectionReason = 'same-webview-instance-id';
                        else if (Date.now() > pending.timeoutAt) rejectionReason = 'late-handshake';
                        else if (host._view?.webview !== pending.webview || webviewView.webview !== pending.webview) rejectionReason = 'webview-object-mismatch';
                        else if (panelId !== pending.panelId) rejectionReason = 'panel-mismatch';
                        else if (host.currentSessionId !== pending.sessionId) rejectionReason = 'session-mismatch';
                        else if (host.sessionSelectionEpoch !== pending.selectionEpoch) rejectionReason = 'selection-epoch-changed';
                        else if ((currentActiveTurn.turnId || '') !== (pending.activeTurn.turnId || '')) rejectionReason = 'active-turn-changed';
                        else if (host.webviewHandshakeLifecycle !== pending.handshakeLifecycle) rejectionReason = 'lifecycle-superseded';
                        if (rejectionReason) {
                            host.uiDebugChannel.appendLine(`EXT: webviewHardRescue.handshake.rejected | reason=${rejectionReason} | generationToken=${data?.hardRescueGenerationToken || 'null'} | expectedGenerationToken=${pending.generationToken} | sessionId=${pending.sessionId} | panelId=${pending.panelId} | oldWebviewInstanceId=${pending.oldWebviewInstanceId || 'null'} | newWebviewInstanceId=${newWebviewInstanceId || 'null'} | selectionEpoch=${host.sessionSelectionEpoch}`);
                            break;
                        }
                        // No await may occur between the final validation above and identity adoption.
                        host._webviewInstanceId = newWebviewInstanceId;
                        pending.newWebviewInstanceId = newWebviewInstanceId;
                        pending.handshakeAccepted = true;
                        host._view = webviewView;
                        hardRescueGuard = () => host.isWebviewHardRescueCurrent(pending);
                        host.uiDebugChannel.appendLine(`EXT: webviewHardRescue.handshake.accepted | generationToken=${pending.generationToken} | sessionId=${pending.sessionId} | panelId=${pending.panelId} | rescueAttemptId=${pending.rescueAttemptId} | oldWebviewInstanceId=${pending.oldWebviewInstanceId || 'null'} | newWebviewInstanceId=${newWebviewInstanceId} | selectionEpoch=${pending.selectionEpoch} | elapsedMs=${Date.now() - pending.startedAt} | ownershipChecks=passed`);
                    } else {
                        if (data?.hardRescueGenerationToken) {
                            host.uiDebugChannel.appendLine(`EXT: webviewHardRescue.handshake.rejected | reason=unexpected-generation-token | generationToken=${data.hardRescueGenerationToken} | panelId=${panelId} | newWebviewInstanceId=${newWebviewInstanceId || 'null'}`);
                            break;
                        }
                        if (!newWebviewInstanceId) {
                            host.uiDebugChannel.appendLine(`EXT: webviewReload.handshake.rejected | reason=missing-webview-instance-id | panelId=${panelId}`);
                            break;
                        }
                        host._view = webviewView;
                        host._webviewInstanceId = newWebviewInstanceId;
                        ++host.webviewHandshakeLifecycle;
                    }
                    host.webviewLivenessCurrent = undefined;
                    host.uiDebugChannel.appendLine(`[EXT][HANDSHAKE_1_RX] webviewReady | wvId=${host._webviewInstanceId}`);
                    host.uiDebugChannel.appendLine(`EXT: webviewReload.handshake.observed | phase=webviewReady | panelId=${panelId} | webviewInstanceId=${host._webviewInstanceId || 'null'} | previousWebviewInstanceId=${data?.previousWebviewInstanceId || 'unknown'} | reload=false | recreate=false | sessionMutation=false`);
                    
                const liveWebview = host._view?.webview;
                    if (liveWebview) {
                        host.uiDebugChannel.appendLine(`[EXT][HANDSHAKE_2_START] calling sendInit() | initPosted=${host.initPosted}`);
                        let sendInitError: Error | undefined;
                        try {
                            if (pending) {
                                const hydrationMode = pending.activeTurn.fresh ? 'fresh-active-turn-metadata-live-resume' : 'idle-normal-hydration';
                                host.uiDebugChannel.appendLine(`EXT: webviewHardRescue.hydration.mode | generationToken=${pending.generationToken} | sessionId=${pending.sessionId} | panelId=${pending.panelId} | activeTurnId=${pending.activeTurn.turnId || 'none'} | activeTurnFresh=${String(pending.activeTurn.fresh)} | mode=${hydrationMode} | postedSessionData=${String(!pending.activeTurn.fresh)}`);
                            }
                            if (pending && hardRescueGuard) {
                                await host.sendInit(liveWebview, {
                                    isStillCurrent: hardRescueGuard,
                                    hardRescue: { sessionId: pending.sessionId, activeTurn: pending.activeTurn }
                                });
                            } else {
                                await host.sendInit(liveWebview);
                            }
                            host.uiDebugChannel.appendLine(`[EXT][HANDSHAKE_3_DONE] sendInit() complete, sending ack`);
                        } catch (err) {
                            sendInitError = err instanceof Error ? err : new Error(String(err));
                            host.uiDebugChannel.appendLine(`[EXT][SENDINIT_ERROR] sendInit threw: ${sendInitError.message}`);
                        }
                        
                        if (pending && (!hardRescueGuard || !hardRescueGuard())) {
                            host.uiDebugChannel.appendLine(`EXT: webviewHardRescue.failed | reason=stale-sendInit-completion | panelId=${panelId} | newWebviewInstanceId=${newWebviewInstanceId || 'null'} | nextAction=Reload Window | automaticRetry=false`);
                            break;
                        }
                        if (pending) {
                            const readyAckPosted = sendInitError
                                ? await liveWebview.postMessage({
                                    type: 'webviewReadyAck',
                                    timestamp: Date.now(),
                                    webviewInstanceId: host._webviewInstanceId,
                                    error: true,
                                    message: sendInitError.message,
                                    hardRescueGenerationToken: pending.generationToken
                                })
                                : await liveWebview.postMessage({ type: 'webviewReadyAck', timestamp: Date.now(), webviewInstanceId: host._webviewInstanceId, hardRescueGenerationToken: pending.generationToken });
                            host.uiDebugChannel.appendLine(`[EXT][HANDSHAKE_4_ACK] ack sent`);
                            if (sendInitError || !readyAckPosted || !hardRescueGuard || !hardRescueGuard()) {
                                host.finishWebviewHardRescueFailure(pending, 'failed', sendInitError ? `sendInit:${sendInitError.message}` : 'webviewReadyAck-post-failed');
                                break;
                            }
                            if (pending.timeout) clearTimeout(pending.timeout);
                            pending.timeout = undefined;
                            host.webviewHardRescuePending = undefined;
                            host.uiDebugChannel.appendLine(`EXT: webviewHardRescue.complete | generationToken=${pending.generationToken} | sessionId=${pending.sessionId} | panelId=${pending.panelId} | rescueAttemptId=${pending.rescueAttemptId} | oldWebviewInstanceId=${pending.oldWebviewInstanceId || 'null'} | newWebviewInstanceId=${pending.newWebviewInstanceId || 'null'} | elapsedMs=${Date.now() - pending.startedAt} | initSucceeded=true | webviewReadyAckPosted=true`);
                        } else if (sendInitError) {
                            liveWebview.postMessage({
                                type: 'webviewReadyAck',
                                timestamp: Date.now(),
                                webviewInstanceId: host._webviewInstanceId,
                                error: true,
                                message: sendInitError.message
                            });
                            host.uiDebugChannel.appendLine(`[EXT][HANDSHAKE_4_ACK] ack sent`);
                        } else {
                            liveWebview.postMessage({ type: 'webviewReadyAck', timestamp: Date.now(), webviewInstanceId: host._webviewInstanceId });
                            host.uiDebugChannel.appendLine(`[EXT][HANDSHAKE_4_ACK] ack sent`);
                        }
                        host.startWebviewLivenessProbes();
                        void host.triggerWebviewLivenessProbe('webviewReadyAck');
                    }
                    break;
                }
                case "webviewLivenessAck": {
                    host.handleWebviewLivenessAck(data);
                    break;
                }
                case "webviewAutoRescueAck": {
                    host.handleWebviewAutoRescueAck(data);
                    break;
                }
                case "sendMessage": {
                    // host.uiDebugChannel.appendLine(
                    //     `[EXT][SEND_RX] sessionId=${host.currentSessionId || 'NULL'} ` +
                    //     `hasValue=${Boolean(data.value)} valueLen=${data.value?.length || 0}`
                    // );
                    
                    const contextItems = Array.isArray(data.contextItems) ? data.contextItems : [];
                    const hasContext = contextItems.some((item: any) => typeof item?.text === 'string' && item.text.length > 0);
                    if (!data.value && !hasContext && !(Array.isArray(data.attachments) && data.attachments.length)) {
                        // host.uiDebugChannel.appendLine(`[EXT][SEND_DROP] reason=empty-value`);
                        return;
                    }

                    const payloadSessionId = typeof data.sessionId === 'string' && data.sessionId.trim()
                        ? data.sessionId.trim()
                        : undefined;
                    const currentSessionIdAtSend = host.currentSessionId;
                    const routeSource = payloadSessionId ? 'payload' : 'current';

                    if (!payloadSessionId && !host.currentSessionId) {
                        // host.uiDebugChannel.appendLine(`[EXT][SEND_CREATE_SESSION] reason=no-current`);
                        try {
                            const sessionInfo = await host.client.createSession();
                            host.currentSessionId = sessionInfo.id;
                            host.trackUserOwnedSession(host.currentSessionId);
                            host.client.setSessionId(host.currentSessionId);
                            const workspaceFolder = host.client.getWorkspaceRoot() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                            if (workspaceFolder) {
                                const workspaceKey = host.getWorkspaceKeyForRoot(workspaceFolder);
                                await host._context.globalState.update(`recentSession.${workspaceKey}`, host.currentSessionId);
                                host.uiDebugChannel.appendLine(
                                    `[EXT][RECENT_SESSION_UPDATED] sessionId=${host.currentSessionId} reason=sendMessage-createSession workspace=${workspaceFolder}`
                                );
                            }
                            // host.uiDebugChannel.appendLine(`[EXT][SEND_SESSION_CREATED] id=${host.currentSessionId}`);
                            const liveWebview = host._view?.webview || activeWebview;
                            liveWebview.postMessage({
                                type: 'sessionId',
                                value: host.currentSessionId,
                                sessionId: host.currentSessionId
                            });
                        } catch (error) {
                            host.uiDebugChannel.appendLine(`[EXT][SEND_SESSION_CREATE_FAILED] err=${String(error)}`);
                        }
                    }

                    if (data.value.toLowerCase() === 'ping') {
                        // OpenCodeClient.outputChannel.appendLine(`[BRIDGE] Manual PONG sent`);
                        const pingSessionId = payloadSessionId || host.currentSessionId || '';
                        if (pingSessionId) {
                            host.postAddResponse(activeWebview, 'PONG - Bridge is working!', { sessionId: pingSessionId });
                        } else {
                            host.uiDebugChannel.appendLine('[EXT][ADD_RESPONSE_DROP] reason=missing-session-owner source=ping');
                        }
                        return;
                    }

                    const targetSessionId = payloadSessionId || host.currentSessionId;
                    if (!targetSessionId) {
                        host.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE_DROP] event=sendMessage reason=missing-target-session reqId=pending payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} routeSource=${routeSource}`);
                        vscode.window.showErrorMessage('OpenCode Error: No active session available for send.');
                        return;
                    }

                    if (payloadSessionId) {
                        host.trackUserOwnedSession(payloadSessionId);
                    }

                    if (host.sendInFlightBySession.has(targetSessionId)) {
                        host.uiDebugChannel.appendLine(`EXT: send.blocked | sessionId=${targetSessionId} | payloadSessionId=${payloadSessionId || 'none'} | currentSessionId=${currentSessionIdAtSend || 'none'} | routeSource=${routeSource} | reason=turn-in-flight`);
                        const liveWebview = host._view?.webview || activeWebview;
                        liveWebview.postMessage({ type: 'turnInFlight', sessionId: targetSessionId, inFlight: true });
                        return;
                    }

                    // host.uiDebugChannel.appendLine(`[EXT][SEND_START] sessionId=${host.currentSessionId} attachments=${data.attachments?.length || 0}`);

                    const reqId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                    const targetModel = host.selectedModel;
                    const targetVariant = host.selectedVariant;
                    const targetMode = host.selectedMode;
                    let activeSendSessionId: string | undefined = targetSessionId;
                    let turnClientMessageId: string | undefined;
                    let turnTmpAssistantKey: string | undefined;
                    try {
                        const attachments = Array.isArray(data.attachments) ? data.attachments as AttachmentPayload[] : [];
                        const attachKeys = attachments.length ? Object.keys(attachments[0] || {}).join(',') : '';
                        host.uiDebugChannel.appendLine(`EXT: send.enter | reqId=${reqId} | sessionId=${targetSessionId} | payloadSessionId=${payloadSessionId || 'none'} | currentSessionId=${currentSessionIdAtSend || 'none'} | routeSource=${routeSource} | hasAttachments=${String(Boolean(attachments.length))} | attachmentsCount=${attachments.length} | attachKeys=${attachKeys}`);
                        host.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE] event=sendMessage phase=start reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource}`);
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
                        host.uiDebugChannel.appendLine(`[EXT][TURN_BIND] phase=capture reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource} clientMessageId=${clientMessageId} tmpAssistantKey=${tmpAssistantKey || 'none'}`);
                        host.rememberDraft(clientMessageId, initialDraft);
                        host.rawUserTextByLocalKey.set(clientMessageId, userText);
                        const opId = typeof data.opId === 'string' ? data.opId : undefined;
                        if (targetSessionId) {
                            activeSendSessionId = targetSessionId;
                            host.sendInFlightBySession.add(targetSessionId);
                            host.markWebviewActiveTurnUpdated(targetSessionId, 'send:start');
                            host.pendingLocalKeyBySession.set(targetSessionId, clientMessageId);
                            host.pendingAssistantTmpKeyBySession.delete(targetSessionId);
                            const liveWebview = host._view?.webview || activeWebview;
                            liveWebview.postMessage({ type: 'turnInFlight', sessionId: targetSessionId, inFlight: true });
                            host.client.startTurnWithOp(targetSessionId, clientMessageId, opId);
                            host.assistantTextBufferBySession.set(targetSessionId, '');
                        }
                        if (tmpAssistantKey) {
                            host.pendingAssistantTmpKeyBySession.set(targetSessionId, tmpAssistantKey);
                            host.pendingAssistantTmpKeyByLocalKey.set(clientMessageId, tmpAssistantKey);
                            host.client.setPendingAssistantTmpKey(targetSessionId, tmpAssistantKey);
                        }

                        const messageIndex = host.client.registerMessage(clientMessageId, targetSessionId);
                        const liveWebview = host._view?.webview || activeWebview;
                        host.clientMessageIdMap.set(clientMessageId, clientMessageId);

                        const attachmentNames = attachments.map((item) => {
                            if (item?.filename) return host.attachmentStorage.sanitizeFilename(item.filename);
                            if (item?.tempPath) return pathModule.basename(item.tempPath);
                            return 'attachment';
                        });
                        const fileNames = attachmentNames.filter((name: string) => !host.attachmentStorage.isImageFileName(name));
                        const attachmentLines = fileNames.map((name: string) => `📄 ${name}`);
                        const displayText = attachmentLines.length
                            ? (userText
                                ? `${userText}

${attachmentLines.join('\n')}`
                                : attachmentLines.join('\n'))
                            : userText;
                        host.pendingSnapshotUserTextBySession.set(targetSessionId, displayText);
                        const pendingUserMessage: SessionMessage = {
                            role: 'user',
                            text: displayText,
                            id: clientMessageId,
                            messageIndex
                        };

                        const assistantMessageId = host.client.createInternalMessageId('assistant', targetSessionId);
                        const assistantMessageIndex = host.client.registerMessage(assistantMessageId, targetSessionId);
                        host.pendingAssistantMessageIdBySession.set(targetSessionId, assistantMessageId);
                        host.markWebviewActiveTurnUpdated(targetSessionId, 'send:assistant-message-bound');
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
                            host.uiDebugChannel.appendLine(`EXT: attach.precheck.skip | reqId=${reqId} | reason=no_attachments`);
                        } else if (targetSessionId) {
                            for (const attachment of attachments) {
                                try {
                                    const saved = await host.attachmentStorage.saveAttachment(targetSessionId, attachment, reqId);
                                    if (saved) {
                                        savedAttachments.push(saved);
                                    }
                                } catch (error) {
                                    host.uiDebugChannel.appendLine(`EXT: attach.save.fail | reqId=${reqId} | filename=${attachment?.filename || 'unknown'} | mime=${attachment?.mime || 'unknown'} | err=${String(error)}`);
                                }
                            }
                        if (savedAttachments.length) {
                            const manifest = host.attachmentStorage.buildAttachmentManifest(savedAttachments);
                            modelText = modelText ? `${modelText}\n\n${manifest}` : manifest;
                        }
                        const contextBlock = host.buildContextBlock(contextItems);
                        if (contextBlock) {
                            modelText = modelText ? `${modelText}\n\n${contextBlock}` : contextBlock;
                        }
                        }
                        host.uiDebugChannel.appendLine(`EXT: send.parts.built | reqId=${reqId} | textParts=1 | manifestCount=${savedAttachments.length} | savedCount=${savedAttachments.length}`);

                        await host.client.chat(
                            modelText,
                            {
                                model: targetModel,
                                variant: targetVariant,
                                sessionId: targetSessionId,
                                mode: targetMode,
                                files: referencedFiles
                            }
                        );

                        await host.client.waitForSessionIdleGate(targetSessionId, {
                            sseWaitMs: 2000,
                            pollEveryMs: 2000,
                            maxPolls: 3
                        });

                        OpenCodeClient.outputChannel.appendLine(`[BRIDGE] Chat done`);
                        host.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE] event=sendMessage phase=stream_done reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource}`);
                        let doneAssistantMsgId = host.client.getTurnAssistantMsgId(targetSessionId) || undefined;
                        if (!doneAssistantMsgId) {
                            host.uiDebugChannel.appendLine(`EXT: chatdone.guard.wait-final | sessionId=${targetSessionId} | reason=missing-assistant-msg-id`);
                            doneAssistantMsgId = await host.client.waitForTurnAssistantMsgId(targetSessionId, 500);
                            host.uiDebugChannel.appendLine(`EXT: chatdone.guard.resolved | sessionId=${targetSessionId} | assistantMsgId=${doneAssistantMsgId}`);
                        }
                        host.uiDebugChannel.appendLine(`[EXT][TURN_BIND] phase=stream_done reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource} clientMessageId=${clientMessageId} assistantMsgId=${doneAssistantMsgId || 'none'} tmpAssistantKey=${tmpAssistantKey || 'none'}`);
                        liveWebview.postMessage({
                            type: 'chatDone',
                            sessionId: targetSessionId,
                            assistantMsgId: doneAssistantMsgId,
                            lastAssistantMsgId: doneAssistantMsgId
                        });
                        host.emitTurnFinalizePhase(liveWebview, targetSessionId, 'stream_done');
                        host.postMessageIndexMap(liveWebview, targetSessionId);
                        host.uiDebugChannel.appendLine(`EXT: finalize.order | sessionId=${targetSessionId} | phase=commit-start`);
                        host.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE] event=sendMessage phase=commit_start reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource}`);
                        const preCommitIdentity = host.buildFinalizeTurnIdentity(targetSessionId, {
                            reqId,
                            clientMessageId,
                            assistantMessageId: doneAssistantMsgId
                        });
                        const commitResult = await host.commitPendingTurnChangesFromAuthoritativeFiles(preCommitIdentity);
                        host.uiDebugChannel.appendLine(`EXT: finalize.order | sessionId=${targetSessionId} | phase=commit-done`);
                        host.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE] event=sendMessage phase=commit_done reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource}`);
                        host.emitTurnFinalizePhase(liveWebview, targetSessionId, 'commit_done');
                        host.uiDebugChannel.appendLine(`EXT: finalize.order | sessionId=${targetSessionId} | phase=upgrade-start`);
                        host.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE] event=sendMessage phase=upgrade_start reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource}`);
                        await host.resolvePendingUserUpgrade(targetSessionId, liveWebview);
                        host.uiDebugChannel.appendLine(`EXT: finalize.order | sessionId=${targetSessionId} | phase=upgrade-done`);
                        host.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE] event=sendMessage phase=upgrade_done reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource}`);
                        host.emitTurnFinalizePhase(liveWebview, targetSessionId, 'upgrade_done');
                        host.postMessageIndexMap(liveWebview, targetSessionId);
                        host.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE] event=sendMessage phase=diff_list_start reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource}`);
                        const finalizeIdentity = host.buildFinalizeTurnIdentity(targetSessionId, {
                            reqId,
                            clientMessageId,
                            assistantMessageId: doneAssistantMsgId,
                            commitResult
                        });
                        await host.emitDiffFileListWithRetry(finalizeIdentity, liveWebview);
                        host.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE] event=sendMessage phase=diff_list_done reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource}`);
                        await host.writeFinalizeSnapshotFromCanonicalSession(finalizeIdentity);
                        host.client.finishTurn(targetSessionId);
                        host.postFinalWatchDiffFocusedBySession.delete(targetSessionId);
                        // Do not force "done" from main finalize; only subagent final-accepted can set done.
                        // Any still-active subagents at this point are treated as cancelled.
                        host.markSubagentsTerminalForParent(targetSessionId, 'cancelled', 'main-finalize-cancel-active');
                        host.emitSubagentStatus();
                        host.clearSubagentSessionsForParent(targetSessionId, 'main-finalize-cancel-active');
                        host.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE] event=sendMessage phase=finalize_done reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource}`);
                        host.uiDebugChannel.appendLine(`[EXT][TURN_BIND] phase=finalize_done reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${targetSessionId} routeSource=${routeSource} clientMessageId=${clientMessageId} assistantMsgId=${doneAssistantMsgId || 'none'} tmpAssistantKey=${tmpAssistantKey || 'none'}`);
                        host.emitTurnFinalizePhase(liveWebview, targetSessionId, 'finalize_done');
                        await host.postModelQuota(liveWebview, 'chat-done');
                        if (host.pendingLocalKeyBySession.get(targetSessionId) === clientMessageId) {
                            host.clearDraft(clientMessageId);
                            await host.handleAbortedMessage(targetSessionId, clientMessageId, liveWebview);
                            host.pendingLocalKeyBySession.delete(targetSessionId);
                        }
                        if (targetMode === 'build') {
                            const segment = host.client.getRevertedSegment(targetSessionId);
                            if (segment) {
                                segment.discarded = true;
                                segment.isActive = true;
                                segment.collapsed = true;
                                host.client.setRevertedSegment(targetSessionId, segment);
                                await host.persistRevertedSegment(targetSessionId, segment, segment.conflicts || [], true);
                            }
                        }
                    } catch (error) {
                        const sessionId = activeSendSessionId;
                        host.uiDebugChannel.appendLine(`[EXT][SESSION_ROUTE] event=sendMessage phase=error reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${sessionId || 'none'} routeSource=${routeSource}`);
                        host.uiDebugChannel.appendLine(`[EXT][TURN_BIND] phase=error reqId=${reqId} payloadSessionId=${payloadSessionId || 'none'} currentSessionId=${currentSessionIdAtSend || 'none'} targetSessionId=${sessionId || 'none'} routeSource=${routeSource} clientMessageId=${turnClientMessageId || 'none'} tmpAssistantKey=${turnTmpAssistantKey || 'none'}`);
                        host.uiDebugChannel.appendLine(`EXT: send.abort | reqId=${reqId} | reason=${String(error)}`);
                        OpenCodeClient.outputChannel.appendLine(`[BRIDGE] Error: ${error}`);
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
                        const pendingLocalKey = sessionId ? host.pendingLocalKeyBySession.get(sessionId) : undefined;
                        if (sessionId && pendingLocalKey) {
                            host.clearDraft(pendingLocalKey);
                            await host.handleAbortedMessage(sessionId, pendingLocalKey, activeWebview);
                            host.pendingLocalKeyBySession.delete(sessionId);
                        }
                        if (sessionId) {
                            if (pendingLocalKey) {
                                host.pendingAssistantTmpKeyByLocalKey.delete(pendingLocalKey);
                                host.rawUserTextByLocalKey.delete(pendingLocalKey);
                            }
                            host.assistantTextBufferBySession.delete(sessionId);
                            host.pendingAssistantTmpKeyBySession.delete(sessionId);
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
                    } finally {
                        if (activeSendSessionId) {
                            const pendingLocalKey = host.pendingLocalKeyBySession.get(activeSendSessionId);
                            if (pendingLocalKey) {
                                host.rawUserTextByLocalKey.delete(pendingLocalKey);
                            }
                            host.sendInFlightBySession.delete(activeSendSessionId);
                            host.pendingLocalKeyBySession.delete(activeSendSessionId);
                            host.pendingAssistantTmpKeyBySession.delete(activeSendSessionId);
                            const liveWebview = host._view?.webview || activeWebview;
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
                    const liveWebview = host._view?.webview || activeWebview;
                    const requestedRootUserMsgId = typeof data.rootUserKey === 'string' ? data.rootUserKey : undefined;
                    host.uiDebugChannel.appendLine(`[EXT][APPEND_ROUTE] rx sessionId=${sessionId || 'null'} rootUserMsgId=${requestedRootUserMsgId || 'null'} clientMessageId=${clientMessageId || 'null'} currentSessionId=${host.currentSessionId || 'null'}`);
                    if (!sessionId || !requestedRootUserMsgId || !clientMessageId || !value) {
                        const reason = !sessionId || !requestedRootUserMsgId || !clientMessageId ? 'missing-route' : 'empty';
                        host.uiDebugChannel.appendLine(`[EXT][APPEND_ROUTE] rejected sessionId=${sessionId || 'null'} rootUserMsgId=${requestedRootUserMsgId || 'null'} clientMessageId=${clientMessageId || 'null'} reason=${reason}`);
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
                    const hasTurnInFlight = host.sendInFlightBySession.has(sessionId);
                    const canAppend = host.client.canAppendToCurrentTurn(sessionId, requestedRootUserMsgId);
                    if (!hasTurnInFlight || !canAppend) {
                        const reason = !hasTurnInFlight ? 'turn-not-in-flight' : 'finalized';
                        host.uiDebugChannel.appendLine(`[EXT][APPEND_ROUTE] rejected sessionId=${sessionId} rootUserMsgId=${requestedRootUserMsgId} clientMessageId=${clientMessageId} reason=${reason}`);
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
                    if (host.appendSubmitInFlightBySession.has(sessionId)) {
                        host.uiDebugChannel.appendLine(`[EXT][APPEND_ROUTE] rejected sessionId=${sessionId} rootUserMsgId=${requestedRootUserMsgId} clientMessageId=${clientMessageId} reason=append-in-flight`);
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
                        host.uiDebugChannel.appendLine(`[EXT][APPEND_ROUTE] rejected sessionId=${sessionId} rootUserMsgId=${requestedRootUserMsgId} clientMessageId=${clientMessageId} reason=begin-rejected`);
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
                    host.appendSubmitInFlightBySession.add(sessionId);
                    host.uiDebugChannel.appendLine(`[EXT][APPEND_ROUTE] accepted sessionId=${sessionId} rootUserMsgId=${beginAppend.rootUserMsgId} clientMessageId=${clientMessageId}`);
                    try {
                        await host.client.appendPrompt(sessionId, value, {
                            model: host.selectedModel,
                            mode: host.selectedMode,
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
                    } catch (error) {
                        host.client.failAppendPrompt(sessionId, clientMessageId);
                        liveWebview.postMessage({
                            type: 'appendStatus',
                            sessionId,
                            clientMessageId,
                            status: 'failed',
                            rootUserMsgId: beginAppend.rootUserMsgId,
                            reason: String(error)
                        });
                    } finally {
                        host.appendSubmitInFlightBySession.delete(sessionId);
                    }
                    break;
                }
                case "appendSnapshotMeta": {
                    host.cacheAppendSnapshotMeta(data);
                    break;
                }
                case "refreshSessions": {
                    // 使用 webviewView.webview（最新实例），而不是 activeWebview
                    await host.refreshSessions(webviewView.webview, data.requestId || '');
                    break;
                }
                case "registerTmpKey": {
                    if (typeof data.sessionId !== 'string' || typeof data.tmpKey !== 'string') break;
                    if (!data.tmpKey.startsWith('tmp:')) break;
                    host.pendingAssistantTmpKeyBySession.set(data.sessionId, data.tmpKey);
                    const pendingLocalKey = host.pendingLocalKeyBySession.get(data.sessionId);
                    if (pendingLocalKey && pendingLocalKey.startsWith('local-')) {
                        host.pendingAssistantTmpKeyByLocalKey.set(pendingLocalKey, data.tmpKey);
                    }
                    host.client.setPendingAssistantTmpKey(data.sessionId, data.tmpKey);
                    break;
                }
                case "registerPendingUserLocal": {
                    if (typeof data.sessionId !== 'string' || typeof data.localKey !== 'string') break;
                    if (!data.localKey.startsWith('local-')) break;
                    const isInFlight = host.sendInFlightBySession.has(data.sessionId);
                    host.uiDebugChannel.appendLine(`EXT: registerPendingUserLocal | sessionId=${data.sessionId} | localKey=${data.localKey} | inFlight=${String(isInFlight)}`);
                    break;
                }
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
                    
                    // Get or create segment map for this session
                    let segMap = host.undoSegmentsBySession.get(sessionId);
                    if (!segMap) {
                        segMap = new Map<string, SegmentState>();
                        host.undoSegmentsBySession.set(sessionId, segMap);
                    }
                    
                    const beforeCount = segMap.size;
                    host.uiDebugChannel.appendLine(
                        `[EXT][SEG_UPSERT_RX] sessionId=${sessionId} noticeKey=${seg.noticeKey} ` +
                        `anchor=${anchorMsgId} end=${seg.endMsgId || anchorMsgId} members=${memberMsgIds.length}`
                    );

                    // Create/update segment
                    const previousSegment = segMap.get(seg.noticeKey);
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
                    
                    segMap.set(seg.noticeKey, segmentState);
                    
                    // Save to globalState
                    await host._context.globalState.update(
                        host.UNDO_SEGMENTS_KEY,
                        serializeUndoSegments(host.undoSegmentsBySession)
                    );
                    
                    host.uiDebugChannel.appendLine(
                        `[EXT][SEG_UPSERT_SAVE] sessionId=${sessionId} before=${beforeCount} after=${segMap.size}`
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
                    
                    const segMap = host.undoSegmentsBySession.get(sessionId);
                    const before = segMap?.size ?? 0;
                    const deleted = segMap?.delete(noticeKey) ?? false;
                    const after = segMap?.size ?? 0;
                    
                    if (deleted) {
                        // Save to globalState
                        await host._context.globalState.update(
                            host.UNDO_SEGMENTS_KEY,
                            serializeUndoSegments(host.undoSegmentsBySession)
                        );
                    }
                    
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

                    const segMap = host.undoSegmentsBySession.get(sessionId);
                    const before = segMap?.size ?? 0;
                    const deleted = segMap?.delete(noticeKey) ?? false;
                    const after = segMap?.size ?? 0;

                    if (deleted) {
                        await host._context.globalState.update(
                            host.UNDO_SEGMENTS_KEY,
                            serializeUndoSegments(host.undoSegmentsBySession)
                        );
                    }

                    host.uiDebugChannel.appendLine(
                        `[EXT][SEG_DELETE_SAVE] sessionId=${sessionId} before=${before} after=${after}`
                    );
                    break;
                }
                case "deleteSession": {
                    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
                    const opId = typeof data.opId === 'string' ? data.opId : '';
                    if (!sessionId) {
                        break;
                    }
                    const liveWebview = host._view?.webview || activeWebview;
                    liveWebview.postMessage({ type: 'sessionDeleteStarted', sessionId, opId });

                    try {
                        const children = await host.client.getSessionChildren(sessionId);
                        if (children.length > 0) {
                            host.uiDebugChannel.appendLine(
                                `[EXT][SESSION_DELETE_CHILDREN] sessionId=${sessionId} count=${children.length}`
                            );
                        }

                        let deletedOnServer = false;
                        try {
                            deletedOnServer = await host.client.deleteSession(sessionId);
                        } catch (error) {
                            const text = String(error || '');
                            if (/\b404\b/.test(text) || text.includes('NotFoundError')) {
                                deletedOnServer = true;
                            } else {
                                throw error;
                            }
                        }

                        if (!deletedOnServer) {
                            throw new Error('Delete session returned false');
                        }

                        await host.cleanupDeletedSessionArtifacts(sessionId);
                        await host.clearRecentSessionIfMatches(sessionId);

                        if (host.currentSessionId === sessionId) {
                            host.resetUiState();
                            host.currentSessionId = undefined;
                            host.client.setSessionId(undefined);
                        }

                        await host.refreshSessions(liveWebview, `delete-${Date.now()}`);
                        liveWebview.postMessage({ type: 'sessionDeleted', sessionId, opId });
                    } catch (error) {
                        host.uiDebugChannel.appendLine(
                            `[EXT][SESSION_DELETE_FAIL] sessionId=${sessionId} opId=${opId || 'null'} err=${String(error)}`
                        );
                        vscode.window.showErrorMessage(`Failed to delete session: ${error}`);
                        liveWebview.postMessage({
                            type: 'sessionDeleteFailed',
                            sessionId,
                            opId,
                            reason: String(error)
                        });
                    }
                    break;
                }
                case "selectSession": {
                    if (!data.sessionId) return;
                    const targetSessionId = data.sessionId;
                    host.resetWebviewLiveness('session-switch');
                    const selectionEpoch = ++host.sessionSelectionEpoch;
                    try {
                        host.resetUiState(targetSessionId);
                        let sessionDataSent = false;
                        host.currentSessionId = targetSessionId;
                        host.trackUserOwnedSession(host.currentSessionId);
                        host.client.setSessionId(host.currentSessionId);
                        const isCurrentSelection = () => (
                            host.currentSessionId === targetSessionId &&
                            host.sessionSelectionEpoch === selectionEpoch
                        );
                        const postSessionData = (payload: any, phase: 'snapshot' | 'recent' | 'full') => {
                            if (!isCurrentSelection()) {
                                host.uiDebugChannel.appendLine(
                                    `[EXT][SESSION_LOAD_STALE] sessionId=${targetSessionId} phase=${phase}`
                                );
                                return false;
                            }
                            const liveWebview = host._view?.webview || activeWebview;
                            liveWebview.postMessage({ ...payload, phase });
                            return true;
                        };
                        const restoreCachedAppendMetadata = (messages: SessionMessage[]): SessionMessage[] => {
                            const messagesById = new Map<string, SessionMessage>();
                            const cloned = messages.map((message) => {
                                const copy = {
                                    ...message,
                                    meta: message?.meta && typeof message.meta === 'object'
                                        ? { ...message.meta }
                                        : message?.meta
                                };
                                if (typeof copy.id === 'string' && copy.id) messagesById.set(copy.id, copy);
                                return copy;
                            });
                            host.applyAppendSnapshotMeta(targetSessionId, messagesById);
                            return cloned.map((message) => (
                                typeof message.id === 'string' ? (messagesById.get(message.id) || message) : message
                            ));
                        };
                            const workspaceFolder = host.client.getWorkspaceRoot() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                            if (workspaceFolder) {
                                const workspaceKey = host.getWorkspaceKeyForRoot(workspaceFolder);
                                await host._context.globalState.update(`recentSession.${workspaceKey}`, targetSessionId);
                            }
                        await host.ensureSessionUndoReady(targetSessionId, activeWebview);

                        const persisted = await host.loadPersistedSegment(targetSessionId);
                        if (persisted?.segment?.historySegments) {
                            host.revertedSegmentHistoryStore.set(targetSessionId, persisted.segment.historySegments);
                        } else {
                            host.revertedSegmentHistoryStore.clearSession(targetSessionId);
                        }
                        if (persisted?.segment && persisted.segment.isActive === true && persisted.discarded !== true) {
                            host.client.setRevertedSegment(targetSessionId, {
                                isActive: true,
                                discarded: false,
                                startMessageId: persisted.segment.startMessageId || targetSessionId,
                                startMessageIndex: persisted.segment.startMessageIndex ?? 0,
                                endMessageId: persisted.segment.endMessageId || targetSessionId,
                                endMessageIndex: persisted.segment.endMessageIndex ?? (persisted.segment.startMessageIndex ?? 0),
                                opIds: persisted.segment.opIds || [],
                                collapsed: true,
                                conflicts: persisted.conflicts || [],
                                messageIds: persisted.segment.messageIds,
                                operationId: persisted.segment.operationId
                            });
                        } else {
                            host.client.setRevertedSegment(targetSessionId, undefined);
                        }

                        const segMap = host.undoSegmentsBySession.get(targetSessionId);
                        host.syncClientRevertedSegmentFromUndoSegments(targetSessionId);
                        const segments = segMap ? Array.from(segMap.values()) : [];

                        let baseTitle = 'Session';
                        let baseMessages: SessionMessage[] = [];
                        let snapPayload: any = null;
                        let snapshotTimelineIds: string[] = [];

                        const snapshotStart = Date.now();
                        try {
                            const snap = await host.readSnapshot(targetSessionId);
                            if (snap?.obj?.sessionData) {
                                snapPayload = snap.obj.sessionData;
                                const snapshotFormatted = await host.injectChangeLists(targetSessionId, {
                                    title: snapPayload.title || baseTitle,
                                    messages: Array.isArray(snapPayload.messages) ? snapPayload.messages : []
                                });
                                const snapshotMessages = restoreCachedAppendMetadata(snapshotFormatted.messages);
                                baseTitle = snapshotFormatted.title || baseTitle;
                                baseMessages = snapshotMessages;
                                snapshotTimelineIds = host.getSnapshotTimelineIds(snapPayload, snapshotMessages);
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
                                        hydrationCoverage: 'deltaContinuityUnknown' as HydrationCoverage
                                    }
                                };
                                const sent = postSessionData(payload, 'snapshot');
                                if (sent && snapshotMessages.length > 0) {
                                    sessionDataSent = true;
                                }
                                host.uiDebugChannel.appendLine(
                                    `[EXT][SNAP_LOAD_HIT] sessionId=${targetSessionId} file=${host.getSnapshotFile(targetSessionId)} bytes=${snap.bytes} costMs=${Date.now() - snapshotStart}`
                                );
                            } else {
                                host.uiDebugChannel.appendLine(
                                    `[EXT][SNAP_LOAD_MISS] sessionId=${targetSessionId} file=${host.getSnapshotFile(targetSessionId)} costMs=${Date.now() - snapshotStart}`
                                );
                            }
                        } catch (err) {
                            host.uiDebugChannel.appendLine(
                                `[EXT][SNAP_LOAD_FAIL] sessionId=${targetSessionId} err=${String(err)} costMs=${Date.now() - snapshotStart}`
                            );
                        }

                        let recentFailedReason = '';
                        const recentStart = Date.now();
                        try {
                            const recentExport = await host.client.exportSessionRecent(targetSessionId, host.recentSessionLoadLimit);
                            if (!isCurrentSelection()) {
                                break;
                            }

                            const formattedRaw = host.formatSession(recentExport);
                            const formatted = await host.injectChangeLists(targetSessionId, formattedRaw);
                            if (!isCurrentSelection()) {
                                break;
                            }

                            if (formatted.title) {
                                baseTitle = formatted.title;
                            }

                            const snapshotIds = snapshotTimelineIds;
                            const snapshotIdSet = new Set<string>(snapshotIds);
                            const snapshotMaxMessageIndex = host.getMaxMessageIndex(baseMessages);
                            const continuity = host.classifyRecentAppendCandidates(snapshotIdSet, snapshotMaxMessageIndex, formatted.messages);
                            if (snapshotIds.length > 0 && !continuity.proven) {
                                if (!host.snapshotDeltaContinuityRepairEnabled) {
                                    host.uiDebugChannel.appendLine(`[EXT][SESSION_RECENT_SKIP] sessionId=${targetSessionId} reason=repair-disabled-safe-snapshot`);
                                    break;
                                }
                                postSessionData({
                                    type: 'hydrationCoverage',
                                    sessionId: targetSessionId,
                                    hydrationCoverage: 'repairInProgress' as HydrationCoverage
                                }, 'recent');
                                sessionDataSent = false;
                                throw new Error('snapshot-boundary-unproven');
                            }
                            const appendMessages = continuity.suffix;
                            const mergedMessagesRaw = snapshotIds.length > 0
                                ? host.buildImmutableSnapshotWithProvenSuffix(baseMessages, appendMessages)
                                : formatted.messages;
                            const mergedMessages = restoreCachedAppendMetadata(mergedMessagesRaw);
                            const newIds = appendMessages
                                .map((message: SessionMessage) => (typeof message?.id === 'string' ? message.id : ''))
                                .filter((id: string): id is string => Boolean(id));
                            const sessionPayload = {
                                type: 'sessionData',
                                sessionId: targetSessionId,
                                title: baseTitle,
                                messages: mergedMessages,
                                segments,
                                meta: {
                                    timelineMessageIds: [...snapshotIds, ...newIds],
                                    hydrationCoverage: (snapshotIds.length > 0
                                        ? 'authoritativeHistoryComplete'
                                        : 'deltaContinuityUnknown') as HydrationCoverage
                                }
                            };
                            const sent = postSessionData(sessionPayload, 'recent');
                            if (sent && mergedMessages.length > 0) {
                                sessionDataSent = true;
                                baseMessages = mergedMessages;
                            }

                            host.uiDebugChannel.appendLine(
                                `[EXT][SESSION_RECENT_OK] sessionId=${targetSessionId} limit=${host.recentSessionLoadLimit} merged=${mergedMessages.length} costMs=${Date.now() - recentStart}`
                            );

                            if (sent) {
                                host.uiDebugChannel.appendLine(`[EXT][SNAP_SAVE_SKIP] sessionId=${targetSessionId} reason=selectSession:recent disabled=incremental-only`);
                            }
                        } catch (err) {
                            recentFailedReason = host.extractLastLine(String(err));
                            host.uiDebugChannel.appendLine(
                                `[EXT][SESSION_RECENT_FAIL] sessionId=${targetSessionId} limit=${host.recentSessionLoadLimit} err=${recentFailedReason || 'null'} costMs=${Date.now() - recentStart}`
                            );
                        }

                        if (sessionDataSent || !isCurrentSelection()) {
                            break;
                        }

                        let normalized = { ok: false, data: null as any, stderrLastLine: '' };

                        try {
                            const exportResult = await host.client.exportSession(targetSessionId);
                            if (exportResult && typeof exportResult.code === 'number') {
                                normalized.ok = exportResult.code === 0;
                                normalized.stderrLastLine = host.extractLastLine(exportResult.stderr);
                                normalized.data = exportResult.data ?? exportResult;
                            } else {
                                normalized.ok = true;
                                normalized.data = exportResult;
                            }
                        } catch (err) {
                            normalized.ok = false;
                            normalized.stderrLastLine = host.extractLastLine(String(err));
                        }

                        if (!normalized.ok) {
                            host.uiDebugChannel.appendLine(`[EXT][EXPORT_FAIL] sessionId=${targetSessionId} stderrLastLine=${normalized.stderrLastLine || recentFailedReason || 'null'}`);
                            const liveWebview = host._view?.webview || activeWebview;
                            liveWebview.postMessage({
                                type: 'sessionLoadFailed',
                                payload: {
                                    sessionId: targetSessionId,
                                    reason: 'export_failed_no_snapshot',
                                    stderrLastLine: normalized.stderrLastLine || recentFailedReason || ''
                                }
                            });
                            return;
                        }

                        const exportData = normalized.data;
                        const formattedRaw = host.formatSession(exportData);
                        const snapshotIds = snapshotTimelineIds;
                        const repairRequiredMessageIds = await host.collectSnapshotRepairRequiredMessageIds(targetSessionId);
                        const fullDelta = host.buildFullExportSnapshotDelta(
                            baseMessages, snapshotIds, formattedRaw.messages, repairRequiredMessageIds
                        );
                        if (fullDelta.repairedSnapshot) {
                            await host.persistStructurallyRepairedSnapshot(
                                targetSessionId, formattedRaw.title, fullDelta.messages, fullDelta.timelineMessageIds, segments
                            );
                        }
                        const formatted = await host.injectChangeLists(targetSessionId, { title: formattedRaw.title, messages: fullDelta.messages });
                        const fullMessages = restoreCachedAppendMetadata(formatted.messages);

                        // host.uiDebugChannel.appendLine(
                        //     `[EXT][SEG_HYDRATE_LOAD] sessionId=${data.sessionId} found=${segments.length} ` +
                        //     `keys=[${(segMap ? Array.from(segMap.keys()) : []).join(', ')}]`
                        // );
                        // 
                        // host.uiDebugChannel.appendLine(
                        //     `[EXT][SEG_HYDRATE_SEND] sessionId=${data.sessionId} count=${segments.length} reason=selectSession`
                        // );
                        // 
                        // const timelineMsgCount = formatted.messages.filter((m) => typeof m.id === 'string' && m.id.startsWith('msg_')).length;
                        // host.uiDebugChannel.appendLine(
                        //     `sessionData.send | sessionId | ${data.sessionId} | messagesCount | ${formatted.messages.length} | ` +
                        //     `timelineMsgCount | ${timelineMsgCount} | segmentsCount | ${segments.length}`
                        // );

                        const sessionPayload = {
                            type: 'sessionData',
                            sessionId: targetSessionId,
                            title: formatted.title,
                            messages: fullMessages,
                            segments,
                                meta: {
                                    timelineMessageIds: fullDelta.timelineMessageIds,
                                    hydrationCoverage: (fullDelta.proven
                                        ? 'authoritativeHistoryComplete'
                                        : 'deltaContinuityUnknown') as HydrationCoverage
                                }
                            };
                        const sent = postSessionData(sessionPayload, 'full');
                        if (sent && fullMessages.length > 0) {
                            sessionDataSent = true;
                        }
                        if (sent) {
                            host.uiDebugChannel.appendLine(`[EXT][SNAP_SAVE_SKIP] sessionId=${targetSessionId} reason=selectSession:full disabled=incremental-only`);
                        }
                        } catch (error) {
                            vscode.window.showErrorMessage(`Failed to load session: ${error}`);
                            host.postAddResponse(activeWebview, `Error: ${error}`, { sessionId: targetSessionId });
                        }
                        break;
                }

                case "newSession": {
                    if (host.currentSessionId) {
                        await host.clearPersistedSegment(host.currentSessionId);
                    }
                    host.resetSessionState();
                    host.currentSessionId = undefined;
                    host.client.setSessionId(host.currentSessionId);
                        const workspaceFolder = host.client.getWorkspaceRoot() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
                        if (workspaceFolder) {
                            const workspaceKey = host.getWorkspaceKeyForRoot(workspaceFolder);
                            await host._context.globalState.update(`recentSession.${workspaceKey}`, undefined);
                        }
                    activeWebview.postMessage({ type: 'newSession', sessionId: host.currentSessionId });
                    if (host.gitUndoEnabled) {
                        host.pendingBaselineTurnKey = `baseline-${Date.now()}`;
                        host.pendingBaselineFailed = false;
                        activeWebview.postMessage({ type: 'baselineStatus', ready: false, message: 'Initializing Git baseline...' });
                        const baselineResult = await host.client.ensureBaselineForTurn(host.pendingBaselineTurnKey);
                        host.baselineReady = baselineResult.ok;
                        if (!baselineResult.ok) {
                            host.pendingBaselineFailed = true;
                            activeWebview.postMessage({ type: 'baselineStatus', ready: false, message: 'Git baseline failed. Undo unavailable.' });
                        } else {
                            activeWebview.postMessage({ type: 'baselineStatus', ready: true });
                        }
                    }
                    break;
                }
                case "undoToMessage": {
                    const payloadSessionId = typeof data.sessionId === 'string' && data.sessionId.trim() ? data.sessionId.trim() : undefined;
                    const operationId = typeof data.operationId === 'string' && data.operationId.trim() ? data.operationId.trim() : undefined;
                    const payloadMessageId = typeof data.messageId === 'string' && data.messageId.trim() ? data.messageId.trim() : undefined;
                    host.uiDebugChannel.appendLine(`[EXT][UNDO_ROUTE] phase=rx payloadSessionId=${payloadSessionId || 'null'} currentSessionId=${host.currentSessionId || 'null'} opId=${operationId || 'null'} messageId=${payloadMessageId || 'null'}`);
                    host.uiDebugChannel.appendLine(`[EXT][UNDO_CASE] messageId=${payloadMessageId || 'NULL'} checkFailed=${!payloadMessageId}`);
                    if (!payloadSessionId || !operationId || !payloadMessageId) {
                        const missing = [
                            !payloadSessionId ? 'sessionId' : undefined,
                            !operationId ? 'operationId' : undefined,
                            !payloadMessageId ? 'messageId' : undefined
                        ].filter(Boolean).join(',');
                        host.uiDebugChannel.appendLine(`[EXT][UNDO_DROP] reason=missing-${missing} payloadSessionId=${payloadSessionId || 'null'} currentSessionId=${host.currentSessionId || 'null'} opId=${operationId || 'null'} messageId=${payloadMessageId || 'null'}`);
                        return;
                    }
                    const ownerSessionId = payloadSessionId;
                    const resolvedMessageId = host.clientMessageIdMap.get(payloadMessageId) || payloadMessageId;
                    host.uiDebugChannel.appendLine(`[EXT][UNDO_ROUTE] phase=owner-captured ownerSessionId=${ownerSessionId} opId=${operationId} anchorMsgId=${resolvedMessageId}`);
                    if (!host.gitUndoEnabled) {
                        host.uiDebugChannel.appendLine(`[EXT][UNDO_TX] type=addResponse sessionId=${ownerSessionId} opId=${operationId}`);
                        host.postAddResponse(activeWebview, 'Undo unavailable: Git not installed or version too old. Please install/upgrade Git and restart VS Code.', { operationId, sessionId: ownerSessionId });
                        return;
                    }
                    if (!host.baselineReady) {
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
                                host.pendingConflictStore.set({
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
                                const liveWebview = host._view?.webview || activeWebview;
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
                            const liveWebview = host._view?.webview || activeWebview;
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
                                host.revertedSegmentHistoryStore.update(ownerSessionId, (entries: any[]) => [...entries, historyEntry]);
                            }
                            host.revertedSegmentHistoryStore.update(ownerSessionId, (entries: any[]) => entries
                                .map((e: any) => ({
                                    ...e,
                                    messageIds: (e.messageIds ?? []).filter((id: string) => !currentSet.has(id))
                                }))
                                .filter((e: any) => (e.messageIds ?? []).length > 0));
                        }
                        const segment = host.client.getRevertedSegment(ownerSessionId);
                        const liveWebview = host._view?.webview || activeWebview;
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
                                    historySegments: host.revertedSegmentHistoryStore.get(ownerSessionId)
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
                        const liveWebview = host._view?.webview || activeWebview;
                        liveWebview.postMessage({ type: 'addResponse', value: `Undo failed: ${error}`, sessionId: ownerSessionId, operationId, meta: { operationId } });
                    }
                    break;
                }
                case "cancel": {
                    const cancelOwner = captureCancelTurnOwner(data, host);
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
                        if (pendingLocalKey) {
                            host.rawUserTextByLocalKey.delete(pendingLocalKey);
                        }
                        host.client.cancelTurn(cancelSessionId, cancelOpId);
                        host.sendInFlightBySession.delete(cancelSessionId);
                        host.pendingLocalKeyBySession.delete(cancelSessionId);
                        host.pendingAssistantTmpKeyBySession.delete(cancelSessionId);
                        activeWebview.postMessage({ type: 'turnInFlight', sessionId: cancelSessionId, inFlight: false });
                    }
                    if (cancelSessionId && pendingLocalKey) {
                        await host.handleAbortedMessage(cancelSessionId, pendingLocalKey, activeWebview);
                        const mappedUser = host.clientMessageIdMap.get(pendingLocalKey);
                        if (mappedUser && mappedUser !== pendingLocalKey) {
                            await host.handleAbortedMessage(cancelSessionId, mappedUser, activeWebview);
                        }
                    }
                    if (cancelSessionId) {
                        const mappedAssistant = pendingTmpKey ? host.clientMessageIdMap.get(pendingTmpKey) : undefined;
                        if (pendingTmpKey) {
                            await host.handleAbortedMessage(cancelSessionId, pendingTmpKey, activeWebview);
                        }
                        if (pendingAssistant) {
                            await host.handleAbortedMessage(cancelSessionId, pendingAssistant, activeWebview);
                        }
                        if (mappedAssistant && mappedAssistant !== pendingTmpKey) {
                            await host.handleAbortedMessage(cancelSessionId, mappedAssistant, activeWebview);
                        }
                        host.pendingAssistantTmpKeyBySession.delete(cancelSessionId);
                        host.pendingAssistantMessageIdBySession.delete(cancelSessionId);
                        host.assistantTextBufferBySession.delete(cancelSessionId);
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
                        host.postFinalWatchDiffFocusedBySession.delete(cancelSessionId);
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
                case "restoreAll": {
                    const payloadSessionId = typeof data.sessionId === 'string' && data.sessionId.trim() ? data.sessionId.trim() : undefined;
                    const operationId = typeof data.operationId === 'string' && data.operationId.trim() ? data.operationId.trim() : undefined;
                    const noticeKey = typeof data.noticeKey === 'string' ? data.noticeKey : '';
                    host.uiDebugChannel.appendLine(`[EXT][RESTORE_ROUTE] phase=rx type=restoreAll payloadSessionId=${payloadSessionId || 'null'} currentSessionId=${host.currentSessionId || 'null'} opId=${operationId || 'null'} noticeKey=${noticeKey || 'null'}`);
                    if (!payloadSessionId || !operationId) {
                        const missing = [!payloadSessionId ? 'sessionId' : undefined, !operationId ? 'operationId' : undefined].filter(Boolean).join(',');
                        host.uiDebugChannel.appendLine(`[EXT][RESTORE_DROP] type=restoreAll reason=missing-${missing} payloadSessionId=${payloadSessionId || 'null'} currentSessionId=${host.currentSessionId || 'null'} opId=${operationId || 'null'} noticeKey=${noticeKey || 'null'}`);
                        break;
                    }
                    const ownerSessionId = payloadSessionId;
                    host.uiDebugChannel.appendLine(`[EXT][RESTORE_ROUTE] phase=owner-captured type=restoreAll ownerSessionId=${ownerSessionId} opId=${operationId} noticeKey=${noticeKey || 'null'}`);
                    try {
                        if (!host.gitUndoEnabled) {
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
                            host.pendingConflictStore.set({ kind: 'restore', sessionId: ownerSessionId, operationId, conflictId, noticeKey });
                            const liveWebview = host._view?.webview || activeWebview;
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
                            segment: discardedSegment ? { ...discardedSegment, historySegments: host.revertedSegmentHistoryStore.get(ownerSessionId) } : discardedSegment,
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
                    host.uiDebugChannel.appendLine(`[EXT][RESTORE_ROUTE] phase=rx type=restoreSegment payloadSessionId=${payloadSessionId || 'null'} currentSessionId=${host.currentSessionId || 'null'} opId=${operationId || 'null'} noticeKey=${noticeKey || 'null'} anchorMsgId=${anchorMsgId || 'null'} endMsgId=${endMsgId || 'null'}`);
                    if (!payloadSessionId || !operationId || !anchorMsgId) {
                        const missing = [!payloadSessionId ? 'sessionId' : undefined, !operationId ? 'operationId' : undefined, !anchorMsgId ? 'anchorMsgId' : undefined].filter(Boolean).join(',');
                        host.uiDebugChannel.appendLine(`[EXT][RESTORE_DROP] type=restoreSegment reason=missing-${missing} payloadSessionId=${payloadSessionId || 'null'} currentSessionId=${host.currentSessionId || 'null'} opId=${operationId || 'null'} noticeKey=${noticeKey || 'null'} anchorMsgId=${anchorMsgId || 'null'} endMsgId=${endMsgId || 'null'}`);
                        break;
                    }
                    const ownerSessionId = payloadSessionId;
                    host.uiDebugChannel.appendLine(`[EXT][RESTORE_ROUTE] phase=owner-captured type=restoreSegment ownerSessionId=${ownerSessionId} opId=${operationId} noticeKey=${noticeKey || 'null'} anchorMsgId=${anchorMsgId} endMsgId=${endMsgId || 'null'}`);
                    try {
                        const currentSegment = host.client.getRevertedSegment(ownerSessionId);
                        const segMap = host.undoSegmentsBySession.get(ownerSessionId);
                        const persistedSegment = noticeKey ? segMap?.get(noticeKey) : undefined;
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
                        const liveWebview = host._view?.webview || activeWebview;
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
                            host.pendingConflictStore.set({ kind: 'restoreSegment', sessionId: ownerSessionId, operationId, conflictId, startMessageId: anchorMsgId, endMessageId: endMsgId, noticeKey });
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
                    host.uiDebugChannel.appendLine(`[EXT][CONFLICT_ROUTE] phase=rx decision=${decision || 'null'} payloadSessionId=${payloadSessionId || 'null'} currentSessionId=${host.currentSessionId || 'null'} opId=${operationId || 'null'} conflictId=${conflictId || 'null'} kind=${kind || 'null'}`);
                    if (!decision || !payloadSessionId || !operationId || !conflictId || !kind) {
                        const missing = [!decision ? 'decision' : undefined, !payloadSessionId ? 'sessionId' : undefined, !operationId ? 'operationId' : undefined, !conflictId ? 'conflictId' : undefined, !kind ? 'kind' : undefined].filter(Boolean).join(',');
                        host.uiDebugChannel.appendLine(`[EXT][CONFLICT_DROP] reason=missing-${missing} payloadSessionId=${payloadSessionId || 'null'} opId=${operationId || 'null'} conflictId=${conflictId || 'null'} kind=${kind || 'null'} pendingCount=${host.pendingConflictStore.size}`);
                        break;
                    }
                    const pendingConflict = host.pendingConflictStore.get(payloadSessionId);
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
                    const conflictContext = host.pendingConflictStore.take(payloadSessionId);
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
                                host.revertedSegmentHistoryStore.update(ownerSessionId, (entries: any[]) => [...entries, historyEntry]);
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
                                        historySegments: host.revertedSegmentHistoryStore.get(ownerSessionId)
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
                            host.revertedSegmentHistoryStore.clearSession(ownerSessionId);
                            host.uiDebugChannel.appendLine(`[EXT][CONFLICT_TX] type=revertedSegment sessionId=${ownerSessionId} opId=${conflictContext.operationId} conflictId=${conflictContext.conflictId} kind=restore`);
                            activeWebview.postMessage({
                                type: 'revertedSegment',
                                conflicts: result.conflicts || [],
                                segment: {
                                    historySegments: host.revertedSegmentHistoryStore.get(ownerSessionId),
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
                                segment: discardedSegment ? { ...discardedSegment, historySegments: host.revertedSegmentHistoryStore.get(ownerSessionId) } : discardedSegment,
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
                            const segMap = host.undoSegmentsBySession.get(ownerSessionId);
                            const persistedSegment = conflictContext.noticeKey ? segMap?.get(conflictContext.noticeKey) : undefined;
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
                        segment: discardedSegment ? { ...discardedSegment, historySegments: host.revertedSegmentHistoryStore.get(sessionId) } : discardedSegment,
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
                            ? { ...segment, historySegments: host.revertedSegmentHistoryStore.get(sessionId) }
                            : null,
                        sessionId
                    });
                    break;
                }
                case "snapshotTimelineIds": {
                    await host.handleSnapshotTimelineIds(data.payload);
                    break;
                }
                case "ui-debug": {
                    if (Array.isArray(data.payload)) {
                        const [tag, ...args] = data.payload;
                        const message = args.map((arg: unknown) => typeof arg === 'object' ? JSON.stringify(arg) : String(arg)).join(' | ');
                        host.uiDebugChannel.appendLine(`${tag}: ${message}`);
                    }
                    break;
                }
            }
        });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible && host.initPosted) {
                host.initPosted = false;
                host.uiDebugChannel.appendLine('[EXT][INIT_RESET] Webview visible after hidden, resetting initPosted');
                host.startWebviewLivenessProbes();
                void host.triggerWebviewLivenessProbe('visibility-visible');
            } else if (!webviewView.visible) {
                host.stopWebviewLivenessProbes('visibility-hidden');
            }
        });
        webviewView.onDidDispose(() => {
            host.uiDebugChannel.appendLine(`EXT: webviewReload.dispose.begin | panelId=${panelId} | webviewInstanceId=${host._webviewInstanceId || 'null'} | reload=false | recreate=false | sessionMutation=false`);
            host.stopWebviewLivenessProbes('webview-dispose');
            host.uiDebugChannel.appendLine(`EXT: webviewReload.dispose.done | panelId=${panelId} | webviewInstanceId=${host._webviewInstanceId || 'null'} | reload=false | recreate=false | sessionMutation=false`);
        });
    
}
