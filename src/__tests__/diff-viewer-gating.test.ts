const mockConfigValues: Record<string, unknown> = {
    'opencode.diffViewer.enabled': true,
};
const mockVisibleTextEditors: any[] = [];

jest.mock('vscode', () => ({
    workspace: {
        workspaceFolders: [{ uri: { fsPath: 'D:\\0.Code\\OpenCodeGUI' } }],
        getConfiguration: (section?: string) => ({
            get: (key: string, fallback: unknown) => {
                const value = mockConfigValues[`${section}.${key}`];
                return value === undefined ? fallback : value;
            },
        }),
        asRelativePath: (p: string) => p,
    },
    window: {
        createOutputChannel: () => ({
            appendLine: () => undefined,
            append: () => undefined,
            clear: () => undefined,
            show: () => undefined,
            hide: () => undefined,
            dispose: () => undefined,
        }),
        showInformationMessage: () => undefined,
        showErrorMessage: jest.fn(),
        visibleTextEditors: mockVisibleTextEditors,
    },
    Uri: {
        file: (fsPath: string) => ({ fsPath }),
        joinPath: (...parts: any[]) => ({ fsPath: parts.map((p) => p?.fsPath || String(p)).join('/') }),
    },
    commands: {
        executeCommand: async () => undefined,
    },
    env: {
        clipboard: {
            readText: async () => '',
        },
    },
}), { virtual: true });

import { SidebarProvider } from '../SidebarProvider';
import type { OpenCodeDiffProvider } from '../OpenCodeDiffProvider';

const createdProviders: Array<{ dispose: () => Promise<void> }> = [];

function createProvider(): any {
    const context: any = {
        globalState: {
            get: () => undefined,
            update: () => Promise.resolve(),
        },
        extensionUri: { fsPath: 'D:\\0.Code\\OpenCodeGUI' },
    };
    const diffProvider = {
        updateFromSnapshot: jest.fn(),
        updateFromPatchSnapshot: jest.fn(),
        forceOpenFromSnapshot: jest.fn(),
        markNextChangeAutoFollow: jest.fn(),
        emitRefresh: jest.fn(),
    } as unknown as OpenCodeDiffProvider;
    const provider = new SidebarProvider(context, context.extensionUri, diffProvider) as any;
    createdProviders.push(provider);
    provider.uiDebugChannel = { appendLine: jest.fn() };
    provider.client = {
        dispose: async () => undefined,
        isInPostFinalWatchWindow: jest.fn().mockReturnValue(true),
        isInLateDiffGrace: jest.fn().mockReturnValue(false),
        wasTurnFinishedRecently: jest.fn().mockReturnValue(false),
    };
    return provider;
}

const sourceFile = {
    filePath: 'src/a.ts',
    type: 'update',
    before: 'const a = 1;\n',
    after: 'const a = 2;\n',
};

const secondFile = {
    filePath: 'src/b.ts',
    type: 'update',
    before: 'const b = 1;\n',
    after: 'const b = 2;\n',
};

afterEach(async () => {
    mockConfigValues['opencode.diffViewer.enabled'] = true;
    mockVisibleTextEditors.length = 0;
    await Promise.all(createdProviders.splice(0).map((provider) => typeof provider.dispose === 'function' ? provider.dispose() : undefined));
});

describe('diff viewer gating', () => {
    test('is enabled by default and opens a change while consuming dedupe state', () => {
        const provider = createProvider();
        expect(provider.diffViewerEnabled).toBe(true);

        provider.tryOpenDiffForEventFile(sourceFile, {} as any, 0, 'session-a', 'main');

        expect(provider.diffProvider.updateFromSnapshot).toHaveBeenCalledTimes(1);
        expect(provider.shownDiffKeysBySession.get('session-a')?.size).toBe(1);
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('subagent.diff.shown'));
    });

    test('disabled events do not consume dedupe or post-final watch focus state', () => {
        mockConfigValues['opencode.diffViewer.enabled'] = false;
        const provider = createProvider();
        provider.refreshDiffViewerConfig();
        expect(provider.diffViewerEnabled).toBe(false);

        provider.tryOpenDiffForEventFile(sourceFile, {} as any, 0, 'session-a', 'subagent');

        expect(provider.diffProvider.updateFromSnapshot).not.toHaveBeenCalled();
        expect(provider.diffProvider.forceOpenFromSnapshot).not.toHaveBeenCalled();
        expect(provider.shownDiffKeysBySession.has('session-a')).toBe(false);
        expect(provider.postFinalWatchDiffFocusedBySession.has('session-a')).toBe(false);
        expect(provider.uiDebugChannel.appendLine).not.toHaveBeenCalledWith(expect.stringContaining('subagent.diff.shown'));
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('subagent.diff.skipped'));
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('reason=setting-disabled'));
    });

    test('a change received while disabled still opens after re-enabling', () => {
        const provider = createProvider();
        provider.tryOpenDiffForEventFile(sourceFile, {} as any, 0, 'session-a', 'main');
        expect(provider.shownDiffKeysBySession.get('session-a')?.size).toBe(1);

        mockConfigValues['opencode.diffViewer.enabled'] = false;
        provider.refreshDiffViewerConfig();
        provider.tryOpenDiffForEventFile(secondFile, {} as any, 0, 'session-a', 'main');
        expect(provider.shownDiffKeysBySession.get('session-a')?.size).toBe(1);
        expect(provider.diffProvider.updateFromSnapshot).toHaveBeenCalledTimes(1);

        mockConfigValues['opencode.diffViewer.enabled'] = true;
        provider.refreshDiffViewerConfig();
        provider.diffProvider.updateFromSnapshot.mockClear();
        provider.tryOpenDiffForEventFile(secondFile, {} as any, 0, 'session-a', 'main');
        expect(provider.shownDiffKeysBySession.get('session-a')?.size).toBe(2);
        expect(provider.diffProvider.updateFromSnapshot).toHaveBeenCalledTimes(1);

        provider.diffProvider.updateFromSnapshot.mockClear();
        provider.tryOpenDiffForEventFile(secondFile, {} as any, 0, 'session-a', 'main');
        expect(provider.diffProvider.updateFromSnapshot).not.toHaveBeenCalled();
    });

    test('undo/restore refresh still updates an open diff while automatic opening is disabled', () => {
        mockConfigValues['opencode.diffViewer.enabled'] = false;
        const provider = createProvider();
        provider.refreshDiffViewerConfig();
        expect(provider.diffViewerEnabled).toBe(false);

        provider.currentDiffFilePath = 'src/a.ts';
        mockVisibleTextEditors.push({
            document: { uri: { scheme: 'opencode-diff', authority: 'right', path: '/src/a.ts' } },
        });

        provider.refreshDiffIfTouched(['src/a.ts']);

        expect(provider.diffProvider.markNextChangeAutoFollow).toHaveBeenCalledTimes(1);
        expect(provider.diffProvider.emitRefresh).toHaveBeenCalledWith('src/a.ts');
    });
});