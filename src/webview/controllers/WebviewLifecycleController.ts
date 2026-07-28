import * as vscode from 'vscode';
import type { ActiveTurnSnapshot } from '../../continuation/ActiveTurnTracker';

export type LifecycleHardRescueContext = {
    handle: unknown;
    generationToken: string;
    sessionId: string;
    panelId: string;
    rescueAttemptId: string;
    oldWebviewInstanceId: string;
    newWebviewInstanceId?: string;
    startedAt: number;
    activeTurn: ActiveTurnSnapshot;
};

export type LifecycleReadyState = {
    accepted: boolean;
    pending?: LifecycleHardRescueContext;
    newWebviewInstanceId: string;
    hardRescueGuard?: () => boolean;
};

export interface WebviewLifecycleHost {
    beginResolution(webviewView: vscode.WebviewView): string;
    getActiveWebview(fallback?: vscode.Webview): vscode.Webview | undefined;
    handleCommandReloadReady(
        data: unknown,
        webviewView: vscode.WebviewView,
        panelId: string
    ): Promise<boolean>;
    prepareReady(
        data: unknown,
        webviewView: vscode.WebviewView,
        panelId: string
    ): LifecycleReadyState;
    getInitPosted(): boolean;
    sendInit(
        webview: vscode.Webview,
        options?: {
            isStillCurrent?: () => boolean;
            hardRescue?: {
                sessionId: string;
                activeTurn: ActiveTurnSnapshot;
            };
        }
    ): Promise<void>;
    finishHardRescueFailure(
        pending: LifecycleHardRescueContext,
        marker: 'timeout' | 'failed',
        reason: string
    ): void;
    completeHardRescueSuccess(pending: LifecycleHardRescueContext): void;
    startLivenessProbes(): void;
    triggerLivenessProbe(reason: string): Promise<void>;
    noteActivity(
        data: unknown,
        webviewView: vscode.WebviewView,
        panelId: string
    ): void;
    handleLivenessAck(data: unknown): void;
    handleAutoRescueAck(data: unknown): void;
    handleVisibility(webviewView: vscode.WebviewView): void;
    handleDispose(panelId: string): void;
    log(message: string): void;
}

export interface WebviewLifecycleController {
    begin(webviewView: vscode.WebviewView): string;
    getActiveWebview(fallback: vscode.Webview): vscode.Webview;
    noteActivity(
        data: unknown,
        webviewView: vscode.WebviewView,
        panelId: string
    ): void;
    handleCommand(
        data: any,
        activeWebview: vscode.Webview,
        registeredWebview: vscode.Webview,
        webviewView: vscode.WebviewView,
        panelId: string
    ): false | Promise<true>;
    handleVisibility(webviewView: vscode.WebviewView): void;
    handleDispose(panelId: string): void;
}

const LIFECYCLE_COMMANDS = new Set([
    'webviewReady',
    'webviewLivenessAck',
    'webviewAutoRescueAck',
    'ui-debug',
]);

export function createWebviewLifecycleController(
    host: WebviewLifecycleHost
): WebviewLifecycleController {
    return {
        begin: (webviewView) => host.beginResolution(webviewView),
        getActiveWebview: (fallback) => host.getActiveWebview(fallback) || fallback,
        noteActivity: (data, webviewView, panelId) =>
            host.noteActivity(data, webviewView, panelId),
        handleCommand: (data, activeWebview, _registeredWebview, webviewView, panelId) => {
            if (!LIFECYCLE_COMMANDS.has(data?.type)) {
                return false;
            }
            return (async () => {
                switch (data.type) {
                    case 'webviewReady': {
                        if (await host.handleCommandReloadReady(data, webviewView, panelId)) {
                            break;
                        }
                        const readiness = host.prepareReady(data, webviewView, panelId);
                        if (!readiness.accepted) {
                            break;
                        }
                        const { pending, newWebviewInstanceId, hardRescueGuard } = readiness;
                        const liveWebview = host.getActiveWebview();
                        if (liveWebview) {
                            host.log(`[EXT][HANDSHAKE_2_START] calling sendInit() | initPosted=${host.getInitPosted()}`);
                            let sendInitError: Error | undefined;
                            try {
                                if (pending) {
                                    const hydrationMode = pending.activeTurn.fresh
                                        ? 'fresh-active-turn-metadata-live-resume'
                                        : 'idle-normal-hydration';
                                    host.log(
                                        `EXT: webviewHardRescue.hydration.mode | generationToken=${pending.generationToken} | ` +
                                        `sessionId=${pending.sessionId} | panelId=${pending.panelId} | ` +
                                        `activeTurnId=${pending.activeTurn.turnId || 'none'} | ` +
                                        `activeTurnFresh=${String(pending.activeTurn.fresh)} | mode=${hydrationMode} | ` +
                                        `postedSessionData=${String(!pending.activeTurn.fresh)}`
                                    );
                                }
                                if (pending && hardRescueGuard) {
                                    await host.sendInit(liveWebview, {
                                        isStillCurrent: hardRescueGuard,
                                        hardRescue: {
                                            sessionId: pending.sessionId,
                                            activeTurn: pending.activeTurn,
                                        },
                                    });
                                } else {
                                    await host.sendInit(liveWebview);
                                }
                                host.log('[EXT][HANDSHAKE_3_DONE] sendInit() complete, sending ack');
                            } catch (error) {
                                sendInitError = error instanceof Error
                                    ? error
                                    : new Error(String(error));
                                host.log(`[EXT][SENDINIT_ERROR] sendInit threw: ${sendInitError.message}`);
                            }

                            if (pending && (!hardRescueGuard || !hardRescueGuard())) {
                                host.log(
                                    `EXT: webviewHardRescue.failed | reason=stale-sendInit-completion | ` +
                                    `panelId=${panelId} | newWebviewInstanceId=${newWebviewInstanceId || 'null'} | ` +
                                    'nextAction=Reload Window | automaticRetry=false'
                                );
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
                                        hardRescueGenerationToken: pending.generationToken,
                                    })
                                    : await liveWebview.postMessage({
                                        type: 'webviewReadyAck',
                                        timestamp: Date.now(),
                                        webviewInstanceId: newWebviewInstanceId,
                                        hardRescueGenerationToken: pending.generationToken,
                                    });
                                host.log('[EXT][HANDSHAKE_4_ACK] ack sent');
                                if (
                                    sendInitError
                                    || !readyAckPosted
                                    || !hardRescueGuard
                                    || !hardRescueGuard()
                                ) {
                                    host.finishHardRescueFailure(
                                        pending,
                                        'failed',
                                        sendInitError
                                            ? `sendInit:${sendInitError.message}`
                                            : 'webviewReadyAck-post-failed'
                                    );
                                    break;
                                }
                                host.completeHardRescueSuccess(pending);
                            } else if (sendInitError) {
                                void liveWebview.postMessage({
                                    type: 'webviewReadyAck',
                                    timestamp: Date.now(),
                                    webviewInstanceId: newWebviewInstanceId,
                                    error: true,
                                    message: sendInitError.message,
                                });
                                host.log('[EXT][HANDSHAKE_4_ACK] ack sent');
                            } else {
                                void liveWebview.postMessage({
                                    type: 'webviewReadyAck',
                                    timestamp: Date.now(),
                                    webviewInstanceId: newWebviewInstanceId,
                                });
                                host.log('[EXT][HANDSHAKE_4_ACK] ack sent');
                            }
                            host.startLivenessProbes();
                            void host.triggerLivenessProbe('webviewReadyAck');
                        }
                        break;
                    }
                    case 'webviewLivenessAck': {
                        host.handleLivenessAck(data);
                        break;
                    }
                    case 'webviewAutoRescueAck': {
                        host.handleAutoRescueAck(data);
                        break;
                    }
                    case 'ui-debug': {
                        if (Array.isArray(data.payload)) {
                            const [tag, ...args] = data.payload;
                            const message = args
                                .map((arg: unknown) =>
                                    typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
                                )
                                .join(' | ');
                            host.log(`${tag}: ${message}`);
                        }
                        break;
                    }
                }
            })().then(() => true as const);
        },
        handleVisibility: (webviewView) => host.handleVisibility(webviewView),
        handleDispose: (panelId) => host.handleDispose(panelId),
    };
}
