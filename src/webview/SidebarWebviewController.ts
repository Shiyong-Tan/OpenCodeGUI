import * as vscode from 'vscode';
import type { SessionCommandHandler } from './controllers/SessionCommandController';
import type { TurnCommandHandler } from './controllers/TurnCommandController';
import type { UndoCommandHandler } from './controllers/UndoCommandController';
import type { UtilityCommandHandler } from './controllers/UtilityCommandController';
import type { WebviewLifecycleController } from './controllers/WebviewLifecycleController';

export interface SidebarWebviewDependencies {
    localResourceRoots: readonly vscode.Uri[];
    getHtmlForWebview(webview: vscode.Webview): string;
    log(message: string): void;
    utilityCommandHandler: UtilityCommandHandler;
    sessionCommandHandler: SessionCommandHandler;
    turnCommandHandler: TurnCommandHandler;
    undoCommandHandler: UndoCommandHandler;
    lifecycleController: WebviewLifecycleController;
}

/** Owns one-time Webview registration and dispatches to pre-bound command families. */
export function resolveSidebarWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
    dependencies: SidebarWebviewDependencies
): void {
    const resolveStartedAt = Date.now();
    const {
        lifecycleController,
        utilityCommandHandler,
        sessionCommandHandler,
        turnCommandHandler,
        undoCommandHandler,
    } = dependencies;
    const panelId = lifecycleController.begin(webviewView);
    dependencies.log(
        `[EXT][WEBVIEW_INIT] phase=resolve-begin panelId=${panelId} ` +
        `visible=${String(webviewView.visible)} elapsedMs=${Date.now() - resolveStartedAt}`
    );

    webviewView.webview.options = {
        enableScripts: true,
        localResourceRoots: [...dependencies.localResourceRoots],
    };
    const htmlStartedAt = Date.now();
    try {
        const html = dependencies.getHtmlForWebview(webviewView.webview);
        webviewView.webview.html = html;
        dependencies.log(
            `[EXT][WEBVIEW_INIT] phase=html-assigned panelId=${panelId} ` +
            `htmlChars=${html.length} stageMs=${Date.now() - htmlStartedAt} ` +
            `totalMs=${Date.now() - resolveStartedAt}`
        );
    } catch (error) {
        dependencies.log(
            `[EXT][WEBVIEW_INIT] phase=html-error panelId=${panelId} ` +
            `stageMs=${Date.now() - htmlStartedAt} totalMs=${Date.now() - resolveStartedAt} ` +
            `error=${error instanceof Error ? error.name : typeof error}`
        );
        throw error;
    }

    webviewView.webview.onDidReceiveMessage(async (data) => {
        const activeWebview = lifecycleController.getActiveWebview(webviewView.webview);
        lifecycleController.noteActivity(data, webviewView, panelId);
        try {
            const keys = data && typeof data === 'object' ? Object.keys(data).sort() : [];
            dependencies.log(
                `EXT: wv.msg | type=${data?.type || 'unknown'} | keys=[${keys.join(',')}]`
            );
        } catch {
            dependencies.log('EXT: wv.msg | type=unknown | keys=[]');
        }

        const utilityHandling = utilityCommandHandler(data, activeWebview, webviewView.webview);
        if (utilityHandling !== false && await utilityHandling) return;

        const sessionHandling = sessionCommandHandler(data, activeWebview, webviewView.webview);
        if (sessionHandling !== false && await sessionHandling) return;

        const turnHandling = turnCommandHandler(data, activeWebview, webviewView.webview);
        if (turnHandling !== false && await turnHandling) return;

        const undoHandling = undoCommandHandler(data, activeWebview, webviewView.webview);
        if (undoHandling !== false && await undoHandling) return;

        const lifecycleHandling = lifecycleController.handleCommand(
            data,
            activeWebview,
            webviewView.webview,
            webviewView,
            panelId
        );
        if (lifecycleHandling !== false) {
            await lifecycleHandling;
        }
    });

    webviewView.onDidChangeVisibility(() => {
        lifecycleController.handleVisibility(webviewView);
    });
    webviewView.onDidDispose(() => {
        lifecycleController.handleDispose(panelId);
    });
    dependencies.log(
        `[EXT][WEBVIEW_INIT] phase=listeners-registered panelId=${panelId} ` +
        `totalMs=${Date.now() - resolveStartedAt}`
    );
}
