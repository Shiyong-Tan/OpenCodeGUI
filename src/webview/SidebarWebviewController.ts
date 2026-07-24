import * as vscode from 'vscode';
import type { UtilityCommandHandler } from './controllers/UtilityCommandController';
import type { SessionCommandHandler } from './controllers/SessionCommandController';
import type { TurnCommandHandler } from './controllers/TurnCommandController';
import type { UndoCommandHandler } from './controllers/UndoCommandController';

/** Owns Webview command registration and protocol dispatch for SidebarProvider. */
export function resolveSidebarWebviewView(
    host: any,
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
    utilityCommandHandler: UtilityCommandHandler,
    sessionCommandHandler: SessionCommandHandler,
    turnCommandHandler: TurnCommandHandler,
    undoCommandHandler: UndoCommandHandler
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

            const utilityHandling = utilityCommandHandler(data, activeWebview, webviewView.webview);
            if (utilityHandling !== false && await utilityHandling) {
                return;
            }
            const sessionHandling = sessionCommandHandler(data, activeWebview, webviewView.webview);
            if (sessionHandling !== false && await sessionHandling) {
                return;
            }
            const turnHandling = turnCommandHandler(data, activeWebview, webviewView.webview);
            if (turnHandling !== false && await turnHandling) {
                return;
            }
            const undoHandling = undoCommandHandler(data, activeWebview, webviewView.webview);
            if (undoHandling !== false && await undoHandling) {
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
