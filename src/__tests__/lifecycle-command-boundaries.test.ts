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

function extractProviderRange(startMarker: string, endMarker: string): string {
    const start = providerSource.indexOf(startMarker);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = providerSource.indexOf(endMarker, start + startMarker.length);
    expect(end).toBeGreaterThan(start);
    return providerSource.slice(start, end);
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
            'const panelId = host.beginWebviewLifecycleResolution(webviewView)',
            'webviewView.webview.options =',
            'webviewView.webview.html = host._getHtmlForWebview(webviewView.webview)',
            'webviewView.webview.onDidReceiveMessage(async (data) =>',
        ]);
        const begin = extractProviderRange(
            'private beginWebviewLifecycleResolution(',
            'private getLifecycleActiveWebview('
        );
        expectOrder(begin, [
            'this._view = webviewView',
            'const panelId = `panel-${++this.webviewLivenessPanelSeq}`',
            "this.resetWebviewLiveness('webview-recreate')",
            'EXT: webviewLiveness.panel',
            'return panelId',
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
            'const readiness = host.prepareWebviewReady(data, webviewView, panelId)',
            'if (!readiness.accepted)',
            'const { pending, newWebviewInstanceId, hardRescueGuard } = readiness',
        ]);
    });

    test('validates every hard-rescue identity without awaiting before adoption', () => {
        const readiness = extractProviderRange(
            'private prepareWebviewReady(',
            'private getLifecycleInitPosted('
        );
        const validationStart = readiness.indexOf(
            'const currentActiveTurn = this.getWebviewLivenessActiveTurnFlags(pending.sessionId)'
        );
        const adoptionStart = readiness.indexOf(
            'this._webviewInstanceId = newWebviewInstanceId',
            validationStart
        );
        expect(validationStart).toBeGreaterThanOrEqual(0);
        expect(adoptionStart).toBeGreaterThan(validationStart);
        const validation = readiness.slice(validationStart, adoptionStart);
        expectOrder(validation, [
            'data.hardRescueGenerationToken !== pending.generationToken',
            '!newWebviewInstanceId',
            'newWebviewInstanceId === pending.oldWebviewInstanceId',
            'Date.now() > pending.timeoutAt',
            'this._view?.webview !== pending.webview',
            'panelId !== pending.panelId',
            'this.currentSessionId !== pending.sessionId',
            'this.sessionSelectionEpoch !== pending.selectionEpoch',
            "currentActiveTurn.turnId || ''",
            'this.webviewHandshakeLifecycle !== pending.handshakeLifecycle',
            'if (rejectionReason)',
        ]);
        const executableValidation = validation.replace(/\/\/[^\n]*/g, '');
        expect(executableValidation).not.toContain('await ');
    });

    test('adopts hard-rescue identity atomically before constructing the continuation guard', () => {
        const readiness = extractProviderRange(
            'private prepareWebviewReady(',
            'private getLifecycleInitPosted('
        );
        expectOrder(readiness, [
            'this._webviewInstanceId = newWebviewInstanceId',
            'pending.newWebviewInstanceId = newWebviewInstanceId',
            'pending.handshakeAccepted = true',
            'this._view = webviewView',
            'hardRescueGuard = () => this.isWebviewHardRescueCurrent(pending)',
            'EXT: webviewHardRescue.handshake.accepted',
        ]);
    });

    test('normal readiness rejects rescue tokens and missing identity before adoption', () => {
        const readiness = extractProviderRange(
            'private prepareWebviewReady(',
            'private getLifecycleInitPosted('
        );
        const normalStart = readiness.indexOf('} else {', readiness.indexOf('if (pending)'));
        const normalEnd = readiness.indexOf('this.webviewLivenessCurrent = undefined', normalStart);
        const normal = readiness.slice(normalStart, normalEnd);
        expectOrder(normal, [
            'if (data?.hardRescueGenerationToken)',
            'reason=unexpected-generation-token',
            'if (!newWebviewInstanceId)',
            'reason=missing-webview-instance-id',
            'this._view = webviewView',
            'this._webviewInstanceId = newWebviewInstanceId',
            '++this.webviewHandshakeLifecycle',
        ]);
    });

    test('hydrates, acknowledges, and starts probes in the established order', () => {
        const ready = extractRange('case "webviewReady"', 'case "webviewLivenessAck"');
        expectOrder(ready, [
            'const readiness = host.prepareWebviewReady(',
            'const liveWebview = host.getLifecycleActiveWebview()',
            'await host.sendInit(liveWebview',
            '[EXT][HANDSHAKE_3_DONE]',
            'const readyAckPosted = sendInitError',
            'host.finishWebviewHardRescueFailure(',
            'host.completeWebviewHardRescueSuccess(pending)',
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
        expect(visibility).toContain('host.handleWebviewLifecycleVisibility(webviewView)');
        const visibilityDomain = extractProviderRange(
            'private handleWebviewLifecycleVisibility(',
            'private handleWebviewLifecycleDispose('
        );
        expectOrder(visibilityDomain, [
            'if (webviewView.visible && this.initPosted)',
            'this.initPosted = false',
            'this.startWebviewLivenessProbes()',
            "this.triggerWebviewLivenessProbe('visibility-visible')",
            'else if (!webviewView.visible)',
            "this.stopWebviewLivenessProbes('visibility-hidden')",
        ]);
    });

    test('disposal logs around exactly one liveness cleanup', () => {
        const disposal = controllerSource.slice(
            controllerSource.indexOf('webviewView.onDidDispose(() =>')
        );
        expect(disposal).toContain('host.handleWebviewLifecycleDispose(panelId)');
        const disposalDomain = extractProviderRange(
            'private handleWebviewLifecycleDispose(',
            'private finishWebviewHardRescueFailure('
        );
        expectOrder(disposalDomain, [
            'EXT: webviewReload.dispose.begin',
            "this.stopWebviewLivenessProbes('webview-dispose')",
            'EXT: webviewReload.dispose.done',
        ]);
        expect(disposalDomain.match(/stopWebviewLivenessProbes\('webview-dispose'\)/g)).toHaveLength(1);
    });

    test('routes lifecycle-owned state mutation through provider domain methods', () => {
        for (const field of [
            '_view',
            '_webviewInstanceId',
            'webviewLivenessPanelSeq',
            'webviewLivenessCurrent',
            'webviewHardRescuePending',
            'webviewHandshakeLifecycle',
            'sessionSelectionEpoch',
            'currentSessionId',
            'initPosted',
        ]) {
            expect(controllerSource).not.toContain(`host.${field}`);
        }
        expect(controllerSource).toContain('host.beginWebviewLifecycleResolution(webviewView)');
        expect(controllerSource).toContain('host.prepareWebviewReady(data, webviewView, panelId)');
        expect(controllerSource).toContain('host.completeWebviewHardRescueSuccess(pending)');
    });
});
