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
        const state = await this.ensureState(filePath, key);
        const patchText = this.extractPatchForFile(diffText, filePath) || diffText;
        const next = await this.applyPatchOrSnapshot(filePath, state.current, patchText);

        state.current = next;
        state.lastChangeRange = this.getLastChangeRange(patchText, next);
        this.stateByKey.set(key, state);

        await this.openOrFocusDiff(filePath, key);
        this.emitChange(key);
        this.revealLastChange(key);
    }

    public async applyWorkspaceSnapshot(filePath: string, patchText: string): Promise<void> {
        if (!this.workspaceRoot) return;
        const key = this.makeKey(filePath);
        const state = await this.ensureState(filePath, key);
        const patchForFile = this.extractPatchForFile(patchText, filePath) || patchText;
        const next = await this.applyPatchOrSnapshot(filePath, state.current, patchForFile);

        state.current = next;
        state.lastChangeRange = this.getLastChangeRange(patchForFile, next);
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
        const needsOpen = !this.findRightEditor(key) || this.currentKey !== key;
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

    private revealLastChange(key: string, attempt = 0): void {
        const state = this.stateByKey.get(key);
        if (!state || !state.lastChangeRange || !state.autoFollowEnabled) return;
        const editor = this.rightEditor || this.findRightEditor(key);
        if (!editor) {
            if (attempt < 2) {
                setTimeout(() => this.revealLastChange(key, attempt + 1), 60);
            }
            return;
        }
        editor.revealRange(state.lastChangeRange, vscode.TextEditorRevealType.InCenter);
    }

    private getLastChangeRange(diffText: string, content: string): vscode.Range | undefined {
        const rawLines = diffText.split('\n');
        let targetLine = -1;
        let currentLine = 0;
        let lastHunkStart = -1;
        let inHunk = false;

        for (const rawLine of rawLines) {
            const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
            if (line.startsWith('@@')) {
                const match = line.match(/\+(\d+)(?:,(\d+))?/);
                if (match) {
                    const start = parseInt(match[1], 10) - 1;
                    currentLine = start;
                    lastHunkStart = start;
                    targetLine = start;
                    inHunk = true;
                }
                continue;
            }

            if (!line) continue;
            if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('Index:') || line.startsWith('===')) {
                continue;
            }

            const prefix = line[0];
            if (prefix === '+') {
                if (!line.startsWith('+++')) {
                    targetLine = currentLine;
                    currentLine += 1;
                }
                continue;
            }
            if (prefix === '-') {
                if (!line.startsWith('---')) {
                    continue;
                }
            }
            if (prefix === ' ') {
                currentLine += 1;
                continue;
            }
            if (prefix === '\\') {
                continue;
            }

            if (inHunk) {
                currentLine += 1;
            }
        }

        if (targetLine < 0 && lastHunkStart >= 0) {
            targetLine = lastHunkStart;
        }
        if (targetLine < 0) return;
        const contentLines = content.split(/\n/).map((line) => line.endsWith('\r') ? line.slice(0, -1) : line);
        const safeLine = Math.min(targetLine, Math.max(0, contentLines.length - 1));
        return new vscode.Range(new vscode.Position(safeLine, 0), new vscode.Position(safeLine, 0));
    }

    private async ensureState(filePath: string, key: string): Promise<FileState> {
        let state = this.stateByKey.get(key);
        if (state) return state;
        if (!this.workspaceRoot) {
            state = {
                filePath,
                baseline: '',
                current: '',
                autoFollowEnabled: true
            };
            this.stateByKey.set(key, state);
            return state;
        }
        const absPath = path.isAbsolute(filePath) ? filePath : path.join(this.workspaceRoot, filePath);
        const baseline = fs.existsSync(absPath) ? await fs.promises.readFile(absPath, 'utf-8') : '';
        state = {
            filePath,
            baseline,
            current: baseline,
            autoFollowEnabled: true
        };
        this.stateByKey.set(key, state);
        return state;
    }

    private async applyPatchOrSnapshot(filePath: string, current: string, patchText: string): Promise<string> {
        const trimmed = patchText.trim();
        if (trimmed.startsWith('*** Begin Patch')) {
            const deleteFlag = this.isDeletePatchForFile(patchText, filePath);
            if (deleteFlag) {
                return '';
            }
        }

        const applied = this.tryApplyPatch(current, patchText);
        if (applied) return applied;
        return current;
    }

    private tryApplyPatch(current: string, patchText: string): string | undefined {
        try {
            const patches = this.dmp.patch_fromText(patchText);
            const result = this.dmp.patch_apply(patches, current);
            const next = result[0] as string;
            const applied = result[1].every(Boolean);
            if (applied) return next;
        } catch {
            return undefined;
        }
        return undefined;
    }

    private extractPatchForFile(diffText: string, filePath: string): string | undefined {
        const trimmed = diffText.trimStart();
        if (trimmed.startsWith('*** Begin Patch')) {
            return this.extractApplyPatchForFile(diffText, filePath);
        }
        if (trimmed.startsWith('Index:')) {
            return this.extractIndexPatchForFile(diffText, filePath);
        }
        return this.extractUnifiedPatchForFile(diffText, filePath);
    }

    private extractIndexPatchForFile(diffText: string, filePath: string): string | undefined {
        const lf = String.fromCharCode(10);
        const cr = String.fromCharCode(13);
        const lines = diffText.split(lf);
        const target = this.normalizePath(filePath);
        let collecting = false;
        const hunks: string[] = [];
        for (const rawLine of lines) {
            const line = rawLine.endsWith(cr) ? rawLine.slice(0, -1) : rawLine;
            if (line.startsWith('Index:')) {
                const rawPath = line.slice('Index:'.length).trim();
                collecting = this.normalizePath(rawPath) === target;
                continue;
            }
            if (line.startsWith('Index:')) {
                collecting = false;
                continue;
            }
            if (!collecting) continue;
            if (line.startsWith('@@') || line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line.startsWith('===')) {
                hunks.push(line);
            }
        }
        return hunks.length ? hunks.join('\n') : undefined;
    }

    private extractApplyPatchForFile(diffText: string, filePath: string): string | undefined {
        const lf = String.fromCharCode(10);
        const cr = String.fromCharCode(13);
        const lines = diffText.split(lf);
        const target = this.normalizePath(filePath);
        let collecting = false;
        const hunks: string[] = [];
        for (const rawLine of lines) {
            const line = rawLine.endsWith(cr) ? rawLine.slice(0, -1) : rawLine;
            if (line.startsWith('*** Update File:') || line.startsWith('*** Add File:') || line.startsWith('*** Delete File:')) {
                const rawPath = line.split(':', 2)[1]?.trim() || '';
                collecting = this.normalizePath(rawPath) === target;
                continue;
            }
            if (line.startsWith('*** End Patch')) {
                break;
            }
            if (!collecting) continue;
            if (line.startsWith('@@') || line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
                hunks.push(line);
            }
        }
        return hunks.length ? hunks.join('\n') : undefined;
    }

    private extractUnifiedPatchForFile(diffText: string, filePath: string): string | undefined {
        const lf = String.fromCharCode(10);
        const cr = String.fromCharCode(13);
        const lines = diffText.split(lf);
        const target = this.normalizePath(filePath);
        let collecting = false;
        const hunks: string[] = [];
        let currentFile: string | undefined;
        for (const rawLine of lines) {
            const line = rawLine.endsWith(cr) ? rawLine.slice(0, -1) : rawLine;
            if (line.startsWith('diff --git ')) {
                const parts = line.split(' ');
                const rawPath = parts.length >= 4 ? parts[3] : '';
                currentFile = this.normalizePath(rawPath.startsWith('b/') ? rawPath.slice(2) : rawPath);
                collecting = currentFile === target;
                continue;
            }
            if (line.startsWith('+++ ') || line.startsWith('--- ')) {
                const rawPath = line.slice(4).trim();
                if (rawPath === '/dev/null') continue;
                const cleaned = this.normalizePath(rawPath.startsWith('b/') || rawPath.startsWith('a/') ? rawPath.slice(2) : rawPath);
                if (line.startsWith('+++ ')) {
                    currentFile = cleaned;
                    collecting = currentFile === target;
                }
                continue;
            }
            if (line.startsWith('@@') || line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
                if (collecting) {
                    hunks.push(line);
                }
            }
        }
        return hunks.length ? hunks.join('\n') : undefined;
    }

    private isDeletePatchForFile(diffText: string, filePath: string): boolean {
        const lf = String.fromCharCode(10);
        const cr = String.fromCharCode(13);
        const lines = diffText.split(lf);
        const target = this.normalizePath(filePath);
        for (const rawLine of lines) {
            const line = rawLine.endsWith(cr) ? rawLine.slice(0, -1) : rawLine;
            if (line.startsWith('*** Delete File:')) {
                const rawPath = line.split(':', 2)[1]?.trim() || '';
                if (this.normalizePath(rawPath) === target) return true;
            }
        }
        return false;
    }

    private normalizePath(filePath: string): string {
        return filePath.replace(/\\/g, '/');
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
