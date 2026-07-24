import * as fs from 'fs';
import * as path from 'path';

const controllerSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'webview', 'SidebarWebviewController.ts'),
    'utf8',
);
const providerSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'SidebarProvider.ts'),
    'utf8',
);

function extractRange(startMarker: string, endMarker: string): string {
    const start = controllerSource.indexOf(startMarker);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = controllerSource.indexOf(endMarker, start + startMarker.length);
    expect(end).toBeGreaterThan(start);
    return controllerSource.slice(start, end);
}

function expectOrder(source: string, markers: string[]): void {
    let previous = -1;
    for (const marker of markers) {
        const index = source.indexOf(marker);
        expect(index).toBeGreaterThan(previous);
        previous = index;
    }
}

describe('Webview lifecycle command family characterization', () => {
    test('registers message, visibility, and disposal listeners exactly once', () => {
        expect(controllerSource.match(/onDidReceiveMessage\(/g)).toHaveLength(1);
        expect(controllerSource.match(/onDidChangeVisibility\(/g)).toHaveLength(1);
        expect(controllerSource.match(/onDidDispose\(/g)).toHaveLength(1);
        expect(providerSource.match(/resolveSidebarWebviewView\(/g)).toHaveLength(1);
        expect(providerSource).not.toContain('.onDidReceiveMessage(');
        expect(providerSource).not.toContain('.onDidChangeVisibility(');
        expect(providerSource).not.toContain('.onDidDispose(');
    });

    test('establishes panel ownership before installing the message listener', () => {
        expectOrder(controllerSource, [
            'host._view = webviewView',
            'const panelId = `panel-${++host.webviewLivenessPanelSeq}`',
            "host.resetWebviewLiveness('webview-recreate')",
            'webviewView.webview.options =',
            'webviewView.webview.html = host._getHtmlForWebview(webviewView.webview)',
            'webviewView.webview.onDidReceiveMessage(async (data) =>',
        ]);
    });

    test('keeps every lifecycle command on the single compatibility dispatcher', () => {
        for (const command of [
            'webviewReady',
            'webviewLivenessAck',
            'webviewAutoRescueAck',
            'ui-debug',
        ]) {
            expect(controllerSource.match(new RegExp(`case "${command}"`, 'g'))).toHaveLength(1);
        }
        expectOrder(controllerSource, [
            'const utilityHandling = utilityCommandHandler(',
            'const sessionHandling = sessionCommandHandler(',
            'const turnHandling = turnCommandHandler(',
            'const undoHandling = undoCommandHandler(',
            'switch (data.type)',
            'case "webviewReady"',
        ]);
    });

    test('lets command-reload readiness consume the ready message before hard-rescue adoption', () => {
        const ready = extractRange('case "webviewReady"', 'case "webviewLivenessAck"');
        expectOrder(ready, [
            'await host.handleWebviewCommandReloadReady(data, webviewView, panelId)',
            'const pending = host.webviewHardRescuePending',
            'const newWebviewInstanceId =',
            'if (pending)',
        ]);
    });

    test('validates every hard-rescue identity without awaiting before adoption', () => {
        const ready = extractRange('case "webviewReady"', 'case "webviewLivenessAck"');
        const validationStart = ready.indexOf(
            'const currentActiveTurn = host.getWebviewLivenessActiveTurnFlags(pending.sessionId)'
        );
        const adoptionStart = ready.indexOf(
            'host._webviewInstanceId = newWebviewInstanceId',
            validationStart
        );
        expect(validationStart).toBeGreaterThanOrEqual(0);
        expect(adoptionStart).toBeGreaterThan(validationStart);
        const validation = ready.slice(validationStart, adoptionStart);
        expectOrder(validation, [
            'data.hardRescueGenerationToken !== pending.generationToken',
            '!newWebviewInstanceId',
            'newWebviewInstanceId === pending.oldWebviewInstanceId',
            'Date.now() > pending.timeoutAt',
            'host._view?.webview !== pending.webview',
            'panelId !== pending.panelId',
            'host.currentSessionId !== pending.sessionId',
            'host.sessionSelectionEpoch !== pending.selectionEpoch',
            "currentActiveTurn.turnId || ''",
            'host.webviewHandshakeLifecycle !== pending.handshakeLifecycle',
            'if (rejectionReason)',
        ]);
        const executableValidation = validation.replace(/\/\/[^\n]*/g, '');
        expect(executableValidation).not.toContain('await ');
    });

    test('adopts hard-rescue identity atomically before constructing the continuation guard', () => {
        const ready = extractRange('case "webviewReady"', 'case "webviewLivenessAck"');
        expectOrder(ready, [
            'host._webviewInstanceId = newWebviewInstanceId',
            'pending.newWebviewInstanceId = newWebviewInstanceId',
            'pending.handshakeAccepted = true',
            'host._view = webviewView',
            'hardRescueGuard = () => host.isWebviewHardRescueCurrent(pending)',
            'EXT: webviewHardRescue.handshake.accepted',
        ]);
    });

    test('normal readiness rejects rescue tokens and missing identity before adoption', () => {
        const ready = extractRange('case "webviewReady"', 'case "webviewLivenessAck"');
        const normalStart = ready.indexOf('} else {', ready.indexOf('if (pending)'));
        const normalEnd = ready.indexOf('host.webviewLivenessCurrent = undefined', normalStart);
        const normal = ready.slice(normalStart, normalEnd);
        expectOrder(normal, [
            'if (data?.hardRescueGenerationToken)',
            'reason=unexpected-generation-token',
            'if (!newWebviewInstanceId)',
            'reason=missing-webview-instance-id',
            'host._view = webviewView',
            'host._webviewInstanceId = newWebviewInstanceId',
            '++host.webviewHandshakeLifecycle',
        ]);
    });

    test('hydrates, acknowledges, and starts probes in the established order', () => {
        const ready = extractRange('case "webviewReady"', 'case "webviewLivenessAck"');
        expectOrder(ready, [
            'host.webviewLivenessCurrent = undefined',
            'const liveWebview = host._view?.webview',
            'await host.sendInit(liveWebview',
            '[EXT][HANDSHAKE_3_DONE]',
            'const readyAckPosted = sendInitError',
            'host.finishWebviewHardRescueFailure(',
            'pending.timeout = undefined',
            'host.webviewHardRescuePending = undefined',
            'EXT: webviewHardRescue.complete',
            'host.startWebviewLivenessProbes()',
            "host.triggerWebviewLivenessProbe('webviewReadyAck')",
        ]);
    });

    test('delegates liveness acknowledgements exactly once', () => {
        const liveness = extractRange('case "webviewLivenessAck"', 'case "webviewAutoRescueAck"');
        expect(liveness.match(/host\.handleWebviewLivenessAck\(data\)/g)).toHaveLength(1);
        const rescue = extractRange('case "webviewAutoRescueAck"', 'case "ui-debug"');
        expect(rescue.match(/host\.handleWebviewAutoRescueAck\(data\)/g)).toHaveLength(1);
    });

    test('restarts visible lifecycle only after clearing the init gate', () => {
        const visibility = extractRange(
            'webviewView.onDidChangeVisibility(() =>',
            'webviewView.onDidDispose(() =>'
        );
        expectOrder(visibility, [
            'if (webviewView.visible && host.initPosted)',
            'host.initPosted = false',
            'host.startWebviewLivenessProbes()',
            "host.triggerWebviewLivenessProbe('visibility-visible')",
            'else if (!webviewView.visible)',
            "host.stopWebviewLivenessProbes('visibility-hidden')",
        ]);
    });

    test('disposal logs around exactly one liveness cleanup', () => {
        const disposal = controllerSource.slice(
            controllerSource.indexOf('webviewView.onDidDispose(() =>')
        );
        expectOrder(disposal, [
            'EXT: webviewReload.dispose.begin',
            "host.stopWebviewLivenessProbes('webview-dispose')",
            'EXT: webviewReload.dispose.done',
        ]);
        expect(disposal.match(/stopWebviewLivenessProbes\('webview-dispose'\)/g)).toHaveLength(1);
    });
});
