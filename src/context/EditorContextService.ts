import * as path from 'path';
import * as vscode from 'vscode';

export const AUTO_EDITOR_CONTEXT_SOURCE = 'editor-auto';
export const AUTO_EDITOR_CONTEXT_MAX_CHARACTERS = 120_000;

export function workspaceFileKey(filePath: string): string {
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export type AutomaticEditorContext = {
    displayText: string;
    text: string;
    source: typeof AUTO_EDITOR_CONTEXT_SOURCE;
    filePath: string;
    workspacePath: string;
    range?: { startLine: number; endLine: number };
    contextKey: string;
    automatic: true;
    truncated?: boolean;
};

function clipContextText(text: string): { text: string; truncated: boolean } {
    if (text.length <= AUTO_EDITOR_CONTEXT_MAX_CHARACTERS) {
        return { text, truncated: false };
    }
    const omitted = text.length - AUTO_EDITOR_CONTEXT_MAX_CHARACTERS;
    return {
        text: `${text.slice(0, AUTO_EDITOR_CONTEXT_MAX_CHARACTERS)}\n\n[OpenCode: ${omitted} characters omitted]`,
        truncated: true,
    };
}

export function captureAutomaticEditorContext(
    editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): AutomaticEditorContext | null {
    if (!vscode.workspace.getConfiguration('opencode.autoEditorContext').get<boolean>('enabled', true)) {
        return null;
    }
    if (!editor || editor.document.uri.scheme !== 'file') return null;
    if (!vscode.workspace.getWorkspaceFolder(editor.document.uri)) return null;

    const selection = editor.selection;
    const hasSelection = Boolean(selection && !selection.isEmpty);
    const rawText = hasSelection
        ? editor.document.getText(selection)
        : editor.document.getText();
    if (!rawText.trim()) return null;

    const filePath = editor.document.uri.fsPath;
    const displayPath = vscode.workspace.asRelativePath(editor.document.uri, false).replace(/\\/g, '/');
    const startLine = hasSelection ? Math.min(selection.start.line, selection.end.line) + 1 : undefined;
    const endLine = hasSelection ? Math.max(selection.start.line, selection.end.line) + 1 : undefined;
    const clipped = clipContextText(rawText);
    const range = startLine !== undefined && endLine !== undefined ? { startLine, endLine } : undefined;
    const identity = range
        ? `${selection.start.line}:${selection.start.character}-${selection.end.line}:${selection.end.character}`
        : 'file';

    return {
        displayText: range ? `${displayPath}:${range.startLine}-${range.endLine}` : displayPath,
        text: clipped.text,
        source: AUTO_EDITOR_CONTEXT_SOURCE,
        filePath,
        workspacePath: displayPath,
        range,
        contextKey: `${editor.document.uri.toString()}:${identity}:v${editor.document.version}`,
        automatic: true,
        truncated: clipped.truncated || undefined,
    };
}

export function collectOpenWorkspaceFileRanks(workspaceRoot: string): Map<string, number> {
    const root = path.resolve(workspaceRoot);
    const ranks = new Map<string, number>();
    const add = (uri: vscode.Uri | undefined, rank: number): void => {
        if (!uri || uri.scheme !== 'file') return;
        const relative = path.relative(root, uri.fsPath);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
        const key = workspaceFileKey(uri.fsPath);
        const current = ranks.get(key);
        if (current === undefined || rank < current) ranks.set(key, rank);
    };

    add(vscode.window.activeTextEditor?.document.uri, 0);
    for (const editor of vscode.window.visibleTextEditors) add(editor.document.uri, 1);
    for (const group of vscode.window.tabGroups?.all || []) {
        for (const tab of group.tabs) {
            add((tab.input as { uri?: vscode.Uri })?.uri, 2);
        }
    }
    return ranks;
}

export function getOpenWorkspaceFileUris(): vscode.Uri[] {
    const uris = new Map<string, vscode.Uri>();
    const add = (uri: vscode.Uri | undefined): void => {
        if (uri?.scheme === 'file') uris.set(workspaceFileKey(uri.fsPath), uri);
    };
    add(vscode.window.activeTextEditor?.document.uri);
    for (const editor of vscode.window.visibleTextEditors) add(editor.document.uri);
    for (const group of vscode.window.tabGroups?.all || []) {
        for (const tab of group.tabs) add((tab.input as { uri?: vscode.Uri })?.uri);
    }
    return Array.from(uris.values());
}
