jest.mock('vscode', () => ({
    workspace: {
        workspaceFolders: [],
        getConfiguration: () => ({
            get: (_key: string, defaultValue: unknown) => defaultValue,
        }),
    },
    window: {
        createOutputChannel: () => ({
            appendLine: () => undefined,
            append: () => undefined,
            dispose: () => undefined,
        }),
        showInformationMessage: () => undefined,
        showErrorMessage: () => undefined,
    },
    Uri: {
        file: (fsPath: string) => ({ fsPath }),
        joinPath: (...parts: any[]) => ({
            fsPath: parts.map((part) => part?.fsPath || String(part)).join('/'),
        }),
    },
    commands: { executeCommand: async () => undefined },
    env: { clipboard: { readText: async () => '' } },
}), { virtual: true });

import { SidebarProvider } from '../SidebarProvider';

function createHarness(): any {
    const provider = Object.create(SidebarProvider.prototype) as any;
    const view = { visible: true, webview: {} };
    provider._view = view;
    provider.currentSessionId = 'session-A';
    provider._webviewInstanceId = 'wv-A';
    provider.sessionSelectionEpoch = 3;
    provider.uiDebugChannel = { appendLine: jest.fn() };
    provider.webviewLivenessMissedAckCountByToken = new Map();
    provider.webviewLivenessSimulatedMissedAckCountByToken = new Map();
    provider.webviewAutoRescuePendingAttemptById = new Map();
    provider.webviewAutoRescuePromptMetaByNotificationToken = new Map();
    provider.getWebviewLivenessActiveTurnFlags = () => ({ active: false });
    const token = provider.buildWebviewLivenessToken('panel-1', 'session-A');
    provider.webviewLivenessCurrent = {
        panelId: 'panel-1',
        sessionId: 'session-A',
        token,
        webviewInstanceId: 'wv-A',
        pingId: 'ping-new',
        pingSentAt: Date.now() - 50,
        pending: true,
    };
    return { provider, view, token };
}

describe('Webview liveness evidence', () => {
    test('settles the current probe when the owned Webview sends a trusted command', () => {
        const { provider, view, token } = createHarness();
        provider.webviewLivenessMissedAckCountByToken.set(token, 2);

        provider.noteWebviewLivenessActivity(
            { type: 'appendMessage' },
            view,
            'panel-1'
        );

        expect(provider.webviewLivenessCurrent).toBeUndefined();
        expect(provider.webviewLivenessMissedAckCountByToken.has(token)).toBe(false);
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(
            expect.stringContaining('EXT: webviewLiveness.activity')
        );
    });

    test('accepts a late acknowledgement from the same token and identity', () => {
        const { provider, token } = createHarness();

        provider.handleWebviewLivenessAck({
            type: 'webviewLivenessAck',
            pingId: 'ping-old',
            token,
            sessionId: 'session-A',
            panelId: 'panel-1',
            webviewInstanceId: 'wv-A',
        });

        expect(provider.webviewLivenessCurrent).toBeUndefined();
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(
            expect.stringContaining('classification=late-same-token')
        );
    });

    test('does not use debug traffic as liveness evidence', () => {
        const { provider, view } = createHarness();
        const record = provider.webviewLivenessCurrent;

        provider.noteWebviewLivenessActivity(
            { type: 'ui-debug' },
            view,
            'panel-1'
        );

        expect(provider.webviewLivenessCurrent).toBe(record);
        expect(record.ackAt).toBeUndefined();
    });
});
