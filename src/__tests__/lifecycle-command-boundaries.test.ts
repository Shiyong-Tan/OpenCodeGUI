jest.mock('vscode', () => ({}), { virtual: true });

import * as fs from 'fs';
import * as path from 'path';
import { createWebviewLifecycleController } from '../webview/controllers/WebviewLifecycleController';

const controllerSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'webview', 'SidebarWebviewController.ts'),
    'utf8',
);
const providerSource = fs.readFileSync(
    path.join(process.cwd(), 'src', 'SidebarProvider.ts'),
    'utf8',
);
const lifecycleControllerSource = fs.readFileSync(
    path.join(
        process.cwd(),
        'src',
        'webview',
        'controllers',
        'WebviewLifecycleController.ts'
    ),
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

function extractLifecycleRange(startMarker: string, endMarker: string): string {
    const start = lifecycleControllerSource.indexOf(startMarker);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = lifecycleControllerSource.indexOf(endMarker, start + startMarker.length);
    expect(end).toBeGreaterThan(start);
    return lifecycleControllerSource.slice(start, end);
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
            'const panelId = lifecycleController.begin(webviewView)',
            'webviewView.webview.options =',
            'webviewView.webview.html = html',
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
            expect(lifecycleControllerSource.match(new RegExp(`case '${command}'`, 'g'))).toHaveLength(1);
            expect(controllerSource).not.toContain(`case "${command}"`);
        }
        expectOrder(controllerSource, [
            'const utilityHandling = utilityCommandHandler(',
            'const sessionHandling = sessionCommandHandler(',
            'const turnHandling = turnCommandHandler(',
            'const undoHandling = undoCommandHandler(',
            'const lifecycleHandling = lifecycleController.handleCommand(',
        ]);
    });

    test('lets command-reload readiness consume the ready message before hard-rescue adoption', () => {
        const ready = extractLifecycleRange(
            "case 'webviewReady'",
            "case 'webviewLivenessAck'"
        );
        expectOrder(ready, [
            'await host.handleCommandReloadReady(data, webviewView, panelId)',
            'const readiness = host.prepareReady(data, webviewView, panelId)',
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
        const ready = extractLifecycleRange(
            "case 'webviewReady'",
            "case 'webviewLivenessAck'"
        );
        expectOrder(ready, [
            'const readiness = host.prepareReady(',
            'const liveWebview = host.getActiveWebview()',
            'await host.sendInit(liveWebview',
            '[EXT][HANDSHAKE_3_DONE]',
            'const readyAckPosted = sendInitError',
            'host.finishHardRescueFailure(',
            'host.completeHardRescueSuccess(pending)',
            'host.startLivenessProbes()',
            "host.triggerLivenessProbe('webviewReadyAck')",
        ]);
        expect(ready).toContain('[EXT][WEBVIEW_INIT] phase=ready-received');
        expect(ready).toContain('[EXT][WEBVIEW_INIT] phase=send-init-complete');
        expect(ready).toContain('[EXT][WEBVIEW_INIT] phase=ready-ack-dispatched');
    });

    test('delegates liveness acknowledgements exactly once', () => {
        const liveness = extractLifecycleRange(
            "case 'webviewLivenessAck'",
            "case 'webviewAutoRescueAck'"
        );
        expect(liveness.match(/host\.handleLivenessAck\(data\)/g)).toHaveLength(1);
        const rescue = extractLifecycleRange(
            "case 'webviewAutoRescueAck'",
            "case 'ui-debug'"
        );
        expect(rescue.match(/host\.handleAutoRescueAck\(data\)/g)).toHaveLength(1);
        expect(controllerSource).toContain(
            'lifecycleController.noteActivity(data, webviewView, panelId)'
        );
        expect(providerSource).toContain(
            "classification=${lateSameToken ? 'late-same-token' : 'exact'}"
        );
        expect(providerSource).toContain('private noteWebviewLivenessActivity(');
    });

    test('restarts visible lifecycle only after clearing the init gate', () => {
        const visibility = extractRange(
            'webviewView.onDidChangeVisibility(() =>',
            'webviewView.onDidDispose(() =>'
        );
        expect(visibility).toContain('lifecycleController.handleVisibility(webviewView)');
        expect(lifecycleControllerSource).toContain(
            'handleVisibility: (webviewView) => host.handleVisibility(webviewView)'
        );
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
        expect(disposal).toContain('lifecycleController.handleDispose(panelId)');
        expect(lifecycleControllerSource).toContain(
            'handleDispose: (panelId) => host.handleDispose(panelId)'
        );
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
        expect(controllerSource).not.toContain('host: any');
        expect(controllerSource).not.toContain('host.');
        expect(controllerSource).toContain('dependencies: SidebarWebviewDependencies');
        expect(controllerSource).toContain('lifecycleController.begin(webviewView)');
        expect(lifecycleControllerSource).toContain(
            'export interface WebviewLifecycleHost'
        );
        expect(lifecycleControllerSource).not.toContain('[key: string]');
        expect(providerSource).toContain(
            'this.webviewLifecycleController = createWebviewLifecycleController({'
        );
        expect(providerSource).toContain('this.sidebarWebviewDependencies = {');
        expect(providerSource).not.toContain('createWebviewLifecycleController(this)');
    });

    test('dispatches ready and acknowledgement commands once through the pre-bound host', async () => {
        const order: string[] = [];
        const webview = {
            postMessage: jest.fn((message: { type: string }) => {
                order.push(`post:${message.type}`);
                return Promise.resolve(true);
            }),
        } as any;
        const view = { webview, visible: true } as any;
        const host: any = {
            beginResolution: jest.fn(() => 'panel-1'),
            getActiveWebview: jest.fn(() => webview),
            handleCommandReloadReady: jest.fn(async () => {
                order.push('reload-ready');
                return false;
            }),
            prepareReady: jest.fn(() => {
                order.push('prepare-ready');
                return {
                    accepted: true,
                    newWebviewInstanceId: 'wv-1',
                };
            }),
            getInitPosted: jest.fn(() => false),
            sendInit: jest.fn(async () => {
                order.push('send-init');
            }),
            finishHardRescueFailure: jest.fn(),
            completeHardRescueSuccess: jest.fn(),
            startLivenessProbes: jest.fn(() => order.push('start-probes')),
            triggerLivenessProbe: jest.fn(async () => {
                order.push('trigger-probe');
            }),
            noteActivity: jest.fn(),
            handleLivenessAck: jest.fn(),
            handleAutoRescueAck: jest.fn(),
            handleVisibility: jest.fn(),
            handleDispose: jest.fn(),
            log: jest.fn(),
        };
        const lifecycle = createWebviewLifecycleController(host);

        expect(lifecycle.handleCommand({ type: 'unowned' }, webview, webview, view, 'panel-1'))
            .toBe(false);
        await lifecycle.handleCommand(
            { type: 'webviewReady', webviewInstanceId: 'wv-1' },
            webview,
            webview,
            view,
            'panel-1'
        );
        expect(order).toEqual([
            'reload-ready',
            'prepare-ready',
            'send-init',
            'post:webviewReadyAck',
            'start-probes',
            'trigger-probe',
        ]);

        await lifecycle.handleCommand(
            { type: 'webviewLivenessAck' },
            webview,
            webview,
            view,
            'panel-1'
        );
        await lifecycle.handleCommand(
            { type: 'webviewAutoRescueAck' },
            webview,
            webview,
            view,
            'panel-1'
        );
        expect(host.handleLivenessAck).toHaveBeenCalledTimes(1);
        expect(host.handleAutoRescueAck).toHaveBeenCalledTimes(1);
        lifecycle.noteActivity(
            { type: 'appendMessage' },
            view,
            'panel-1'
        );
        expect(host.noteActivity).toHaveBeenCalledWith(
            { type: 'appendMessage' },
            view,
            'panel-1'
        );

        lifecycle.handleVisibility(view);
        lifecycle.handleDispose('panel-1');
        expect(host.handleVisibility).toHaveBeenCalledWith(view);
        expect(host.handleDispose).toHaveBeenCalledWith('panel-1');
    });
});
