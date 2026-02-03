import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { diff_match_patch } from 'diff-match-patch';

type FileState = {
    filePath: string;
    baseline: string;
    current: string;
    lastChangeRange?: vscode.Range;
    autoFollowEnabled: boolean;
};

export class OpenCodeDiffProvider implements vscode.TextDocumentContentProvider {
    private onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
    public onDidChange = this.onDidChangeEmitter.event;

    private dmp = new diff_match_patch();
    private stateByKey = new Map<string, FileState>();
    private currentKey?: string;
    private rightEditor?: vscode.TextEditor;

    constructor(private readonly workspaceRoot?: string) {}

    public provideTextDocumentContent(uri: vscode.Uri): string {
        const { side, key } = this.parseUri(uri);
        const state = this.stateByKey.get(key);
        if (!state) return '';
        return side === 'left' ? state.baseline : state.current;
    }

    public async applyUnifiedDiff(filePath: string, diffText: string): Promise<void> {
        if (!this.workspaceRoot) return;
        const key = this.makeKey(filePath);
        let state = this.stateByKey.get(key);
        if (!state) {
            const absPath = path.isAbsolute(filePath) ? filePath : path.join(this.workspaceRoot, filePath);
            const baseline = fs.existsSync(absPath) ? await fs.promises.readFile(absPath, 'utf-8') : '';
            state = {
                filePath,
                baseline,
                current: baseline,
                autoFollowEnabled: true
            };
            this.stateByKey.set(key, state);
        }

        let next = state.current;
        let applied = true;
        try {
            const patches = this.dmp.patch_fromText(diffText);
            const result = this.dmp.patch_apply(patches, state.current);
            next = result[0] as string;
            applied = result[1].every(Boolean);
        } catch {
            applied = false;
        }

        if (!applied) {
            next = diffText;
        }

        state.current = next;
        state.lastChangeRange = this.getLastChangeRange(diffText, next);
        this.stateByKey.set(key, state);

        await this.openOrFocusDiff(filePath, key);
        this.emitChange(key);
        this.revealLastChange(key);
    }

    public async applyWorkspaceSnapshot(filePath: string, patchText: string): Promise<void> {
        if (!this.workspaceRoot) return;
        const key = this.makeKey(filePath);
        let state = this.stateByKey.get(key);
        const absPath = path.isAbsolute(filePath) ? filePath : path.join(this.workspaceRoot, filePath);
        if (!state) {
            const baseline = fs.existsSync(absPath) ? await fs.promises.readFile(absPath, 'utf-8') : '';
            state = {
                filePath,
                baseline,
                current: baseline,
                autoFollowEnabled: true
            };
            this.stateByKey.set(key, state);
        }

        const current = fs.existsSync(absPath) ? await fs.promises.readFile(absPath, 'utf-8') : '';
        state.current = current;
        state.lastChangeRange = this.getLastChangeRange(patchText, current);
        this.stateByKey.set(key, state);

        await this.openOrFocusDiff(filePath, key);
        this.emitChange(key);
        this.revealLastChange(key);
    }

    public setAutoFollowEnabled(enabled: boolean): void {
        if (!this.currentKey) return;
        const state = this.stateByKey.get(this.currentKey);
        if (!state) return;
        state.autoFollowEnabled = enabled;
        this.stateByKey.set(this.currentKey, state);
    }

    public handleVisibleRangeChange(editor: vscode.TextEditor): void {
        if (!this.currentKey) return;
        const state = this.stateByKey.get(this.currentKey);
        if (!state || !state.lastChangeRange) return;
        if (editor.document.uri.scheme != 'opencode-diff') return;
        const visible = editor.visibleRanges[0];
        if (!visible) return;
        if (!visible.contains(state.lastChangeRange)) {
            state.autoFollowEnabled = false;
            this.stateByKey.set(this.currentKey, state);
        }
    }

    public markNextChangeAutoFollow(): void {
        if (!this.currentKey) return;
        const state = this.stateByKey.get(this.currentKey);
        if (!state) return;
        state.autoFollowEnabled = true;
        this.stateByKey.set(this.currentKey, state);
    }

    private emitChange(key: string): void {
        const leftUri = this.getUri('left', key);
        const rightUri = this.getUri('right', key);
        this.onDidChangeEmitter.fire(leftUri);
        this.onDidChangeEmitter.fire(rightUri);
    }

    private async openOrFocusDiff(filePath: string, key: string): Promise<void> {
        const needsOpen = !this.findRightEditor(key);
        if (this.currentKey !== key || needsOpen) {
            this.currentKey = key;
            const leftUri = this.getUri('left', key);
            const rightUri = this.getUri('right', key);
            const title = `OpenCode Diff: ${filePath}`;
            await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, { preview: true });
        }

        const languageId = this.getLanguageId(filePath);
        if (languageId) {
            await this.setLanguageWithRetry(this.getUri('left', key), languageId);
            await this.setLanguageWithRetry(this.getUri('right', key), languageId);
        }
        this.rightEditor = this.findRightEditor(key);
    }

    private revealLastChange(key: string): void {
        const state = this.stateByKey.get(key);
        if (!state || !state.lastChangeRange || !state.autoFollowEnabled) return;
        const editor = this.rightEditor || this.findRightEditor(key);
        if (!editor) return;
        editor.revealRange(state.lastChangeRange, vscode.TextEditorRevealType.InCenter);
    }

    private getLastChangeRange(diffText: string, content: string): vscode.Range | undefined {
        const rawLines = diffText.split('\n');
        let targetLine = -1;
        for (const rawLine of rawLines) {
            const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
            if (line.startsWith('@@')) {
                const match = line.match(/\+(\d+)/);
                if (match) {
                    targetLine = parseInt(match[1], 10) - 1;
                }
            }
        }
        if (targetLine < 0) return;
        const contentLines = content.split(/\n/).map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
        const safeLine = Math.min(targetLine, Math.max(0, contentLines.length - 1));
        return new vscode.Range(new vscode.Position(safeLine, 0), new vscode.Position(safeLine, 0));
    }

    private getUri(side: 'left' | 'right', key: string): vscode.Uri {
        return vscode.Uri.parse(`opencode-diff://${side}/${key}`);
    }

    private parseUri(uri: vscode.Uri): { side: 'left' | 'right'; key: string } {
        const side = uri.authority === 'left' ? 'left' : 'right';
        const key = uri.path.replace(/^\//, '');
        return { side, key };
    }

    private getLanguageId(filePath: string): string | undefined {
        const ext = path.extname(filePath).toLowerCase();
        switch (ext) {
            case '.ts':
            case '.tsx':
                return 'typescript';
            case '.js':
            case '.jsx':
                return 'javascript';
            case '.json':
                return 'json';
            case '.md':
            case '.markdown':
                return 'markdown';
            case '.css':
                return 'css';
            case '.html':
            case '.htm':
                return 'html';
            default:
                return undefined;
        }
    }

    private async setLanguageWithRetry(uri: vscode.Uri, languageId: string): Promise<void> {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.languages.setTextDocumentLanguage(doc, languageId);
        await new Promise((resolve) => setTimeout(resolve, 50));
        const reopened = await vscode.workspace.openTextDocument(uri);
        await vscode.languages.setTextDocumentLanguage(reopened, languageId);
    }

    private findRightEditor(key: string): vscode.TextEditor | undefined {
        return vscode.window.visibleTextEditors.find((editor) => {
            const uri = editor.document.uri;
            if (uri.scheme !== 'opencode-diff') return false;
            if (uri.authority !== 'right') return false;
            const editorKey = uri.path.replace(/^\//, '');
            return editorKey === key;
        });
    }

    private makeKey(filePath: string): string {
        const hash = crypto.createHash('sha1').update(filePath).digest('hex');
        return `${hash}`;
    }
}
