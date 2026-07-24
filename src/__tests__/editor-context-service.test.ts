const vscodeState: any = {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    tabGroups: { all: [] },
};

jest.mock('vscode', () => ({
    window: vscodeState,
    workspace: {
        getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
        getWorkspaceFolder: (uri: any) => uri.scheme === 'file' ? { uri: { fsPath: 'C:\\workspace' } } : undefined,
        asRelativePath: (uri: any) => uri.fsPath.replace(/^C:\\workspace\\?/i, '').replace(/\\/g, '/'),
    },
}), { virtual: true });

import {
    captureAutomaticEditorContext,
    collectOpenWorkspaceFileRanks,
} from '../context/EditorContextService';

function uri(fsPath: string) {
    return { scheme: 'file', fsPath, toString: () => `file:///${fsPath.replace(/\\/g, '/')}` };
}

function editor(text: string, startLine = 0, endLine = 0, selected = ''): any {
    const documentUri = uri('C:\\workspace\\src\\a.ts');
    return {
        document: {
            uri: documentUri,
            version: 7,
            getText: (selection?: any) => selection && selected ? selected : text,
        },
        selection: {
            isEmpty: !selected,
            start: { line: startLine, character: 0 },
            end: { line: endLine, character: 0 },
        },
    };
}

describe('automatic editor context service', () => {
    beforeEach(() => {
        vscodeState.activeTextEditor = undefined;
        vscodeState.visibleTextEditors = [];
        vscodeState.tabGroups = { all: [] };
    });

    it('prefers selected editor lines and records their buffer identity', () => {
        vscodeState.activeTextEditor = editor('whole file', 3, 5, 'selected lines');
        expect(captureAutomaticEditorContext()).toMatchObject({
            displayText: 'src/a.ts:4-6',
            text: 'selected lines',
            source: 'editor-auto',
            workspacePath: 'src/a.ts',
            range: { startLine: 4, endLine: 6 },
            contextKey: expect.stringContaining(':3:0-5:0:v7'),
            automatic: true,
        });
    });

    it('uses the unsaved full editor buffer when no selection exists', () => {
        vscodeState.activeTextEditor = editor('unsaved buffer contents');
        expect(captureAutomaticEditorContext()).toMatchObject({
            displayText: 'src/a.ts',
            text: 'unsaved buffer contents',
            range: undefined,
            contextKey: expect.stringContaining(':file:v7'),
        });
    });

    it('ranks active, visible, and other open tabs ahead of workspace files', () => {
        const active = editor('active');
        const visible = { document: { uri: uri('C:\\workspace\\src\\visible.ts') } };
        const tabUri = uri('C:\\workspace\\src\\tab.ts');
        vscodeState.activeTextEditor = active;
        vscodeState.visibleTextEditors = [active, visible];
        vscodeState.tabGroups = { all: [{ tabs: [{ input: { uri: tabUri } }] }] };
        const ranks = collectOpenWorkspaceFileRanks('C:\\workspace');
        expect(ranks.get('c:\\workspace\\src\\a.ts')).toBe(0);
        expect(ranks.get('c:\\workspace\\src\\visible.ts')).toBe(1);
        expect(ranks.get('c:\\workspace\\src\\tab.ts')).toBe(2);
    });
});
