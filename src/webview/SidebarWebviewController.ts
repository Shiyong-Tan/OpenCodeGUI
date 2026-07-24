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
        const panelId = host.beginWebviewLifecycleResolution(webviewView);

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [host._extensionUri],
        };

        webviewView.webview.html = host._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            const activeWebview = host.getLifecycleActiveWebview(webviewView.webview);
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
                    const readiness = host.prepareWebviewReady(data, webviewView, panelId);
                    if (!readiness.accepted) {
                        break;
                    }
                    const { pending, newWebviewInstanceId, hardRescueGuard } = readiness;
                    const liveWebview = host.getLifecycleActiveWebview();
                    if (liveWebview) {
                        host.uiDebugChannel.appendLine(`[EXT][HANDSHAKE_2_START] calling sendInit() | initPosted=${host.getLifecycleInitPosted()}`);
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
                                    webviewInstanceId: newWebviewInstanceId,
                                    error: true,
                                    message: sendInitError.message,
                                    hardRescueGenerationToken: pending.generationToken
                                })
                                : await liveWebview.postMessage({ type: 'webviewReadyAck', timestamp: Date.now(), webviewInstanceId: newWebviewInstanceId, hardRescueGenerationToken: pending.generationToken });
                            host.uiDebugChannel.appendLine(`[EXT][HANDSHAKE_4_ACK] ack sent`);
                            if (sendInitError || !readyAckPosted || !hardRescueGuard || !hardRescueGuard()) {
                                host.finishWebviewHardRescueFailure(pending, 'failed', sendInitError ? `sendInit:${sendInitError.message}` : 'webviewReadyAck-post-failed');
                                break;
                            }
                            host.completeWebviewHardRescueSuccess(pending);
                        } else if (sendInitError) {
                            liveWebview.postMessage({
                                type: 'webviewReadyAck',
                                timestamp: Date.now(),
                                webviewInstanceId: newWebviewInstanceId,
                                error: true,
                                message: sendInitError.message
                            });
                            host.uiDebugChannel.appendLine(`[EXT][HANDSHAKE_4_ACK] ack sent`);
                        } else {
                            liveWebview.postMessage({ type: 'webviewReadyAck', timestamp: Date.now(), webviewInstanceId: newWebviewInstanceId });
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
            host.handleWebviewLifecycleVisibility(webviewView);
        });
        webviewView.onDidDispose(() => {
            host.handleWebviewLifecycleDispose(panelId);
        });
    
}
