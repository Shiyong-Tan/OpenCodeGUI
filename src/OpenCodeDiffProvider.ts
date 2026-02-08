import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { diff_match_patch } from 'diff-match-patch';

type FileState = {
    filePath: string;
    baseline: string;
    current: string;
    lastAfter: string;
    lastChangeRange?: vscode.Range;
    changeRanges?: vscode.Range[];
    autoWalkTimer?: NodeJS.Timeout;
    autoWalkIndex?: number;
    lastAutoWalkReveal?: number;
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
        if (!state) {
            console.log(`[OpenCodeDiff] provide empty side=${side} key=${key}`);
            return '';
        }
        const content = side === 'left' ? state.baseline : state.current;
        console.log(`[OpenCodeDiff] provide side=${side} key=${key} len=${content.length}`);
        return content;
    }

    public async applyUnifiedDiff(filePath: string, diffText: string): Promise<void> {
        if (!this.workspaceRoot) return;
        const key = this.makeKey(filePath);
        const state = await this.ensureState(filePath, key);
        const patchText = this.extractPatchForFile(diffText, filePath) || diffText;
        const next = await this.applyPatchOrSnapshot(filePath, state.current, patchText);

        state.current = next;
        state.lastAfter = next;
        state.lastChangeRange = this.computeLastChangeRange(state.current, next, patchText);
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
        state.lastAfter = next;
        state.lastChangeRange = this.computeLastChangeRange(state.current, next, patchForFile);
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

    public async updateFromSnapshot(filePath: string, beforeText: string, afterText: string, diffText?: string): Promise<void> {
        if (!this.workspaceRoot) return;
        const key = this.makeKey(filePath);
        let state = this.stateByKey.get(key);
        if (!state) {
            state = {
                filePath,
                baseline: beforeText,
                current: afterText,
                lastAfter: beforeText,
                autoFollowEnabled: true
            };
        }

        this.cancelAutoWalk(key);
        state.baseline = beforeText;
        state.current = afterText;
        state.lastChangeRange = this.computeLastChangeRange(beforeText, afterText, diffText);
        state.changeRanges = this.computeChangeRanges(beforeText, afterText, diffText);
        state.lastAfter = afterText;
        this.stateByKey.set(key, state);

        this.emitChange(key);
        const needsOpen = this.currentKey !== key || !this.findRightEditor(key);
        if (needsOpen) {
            await this.openOrFocusDiff(filePath, key);
        }
        this.emitChange(key);
        this.revealLastChange(key);
        this.startAutoWalk(key);
        this.logDiffUpdate(key, filePath, beforeText, afterText, diffText, state.lastChangeRange);
    }

    public handleVisibleRangeChange(editor: vscode.TextEditor): void {
        const key = this.getKeyFromEditor(editor, 'right');
        if (!key) return;
        const state = this.stateByKey.get(key);
        if (!state || !state.lastChangeRange) return;
        const visible = editor.visibleRanges[0];
        if (!visible) return;
        if (this.wasRecentAutoWalk(state)) return;
        if (!visible.contains(state.lastChangeRange)) {
            state.autoFollowEnabled = false;
            this.stateByKey.set(key, state);
        }
        this.cancelAutoWalk(key);
    }

    public handleSelectionChange(editor: vscode.TextEditor): void {
        const key = this.getKeyFromEditor(editor, 'right');
        if (!key) return;
        const state = this.stateByKey.get(key);
        if (!state) return;
        if (this.wasRecentAutoWalk(state)) return;
        this.cancelAutoWalk(key);
    }

    public handleDocumentChange(uri: vscode.Uri): void {
        if (uri.scheme !== 'opencode-diff') return;
        const key = uri.path.replace(/^\//, '');
        this.cancelAutoWalk(key);
    }

    public markNextChangeAutoFollow(): void {
        if (!this.currentKey) return;
        const state = this.stateByKey.get(this.currentKey);
        if (!state) return;
        state.autoFollowEnabled = true;
        this.stateByKey.set(this.currentKey, state);
    }

    public emitRefresh(key: string): void {
        this.emitChange(key);
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
        editor.selection = new vscode.Selection(state.lastChangeRange.start, state.lastChangeRange.start);
        editor.revealRange(state.lastChangeRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }

    private computeLastChangeRange(beforeText: string, afterText: string, diffText?: string): vscode.Range | undefined {
        const diffs = this.dmp.diff_main(beforeText, afterText);
        this.dmp.diff_cleanupSemantic(diffs);
        let currIndex = 0;
        let lastChangeOffset: number | null = null;
        for (const [op, text] of diffs) {
            if (!text) continue;
            if (op === 0) {
                currIndex += text.length;
                continue;
            }
            if (op === 1) {
                lastChangeOffset = currIndex;
                currIndex += text.length;
                continue;
            }
            if (op === -1) {
                lastChangeOffset = currIndex;
                continue;
            }
        }

        if (lastChangeOffset !== null) {
            const slice = afterText.slice(0, Math.max(0, lastChangeOffset));
            const line = slice.split('\n').length - 1;
            const lastLineIndex = Math.max(0, slice.lastIndexOf('\n'));
            const col = Math.max(0, lastChangeOffset - (lastLineIndex === -1 ? 0 : lastLineIndex + 1));
            return new vscode.Range(new vscode.Position(line, col), new vscode.Position(line, col));
        }

        if (diffText) {
            const rawLines = diffText.split('\n');
            let lastHunk: { start: number; len: number } | undefined;
            for (const rawLine of rawLines) {
                const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
                const match = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/);
                if (match) {
                    const start = parseInt(match[1], 10) - 1;
                    const len = match[2] ? Math.max(parseInt(match[2], 10), 1) : 1;
                    lastHunk = { start, len };
                }
            }
            if (lastHunk) {
                const contentLines = afterText.split('\n');
                const safeStart = Math.min(lastHunk.start, Math.max(0, contentLines.length - 1));
                const safeEnd = Math.min(safeStart + lastHunk.len - 1, Math.max(0, contentLines.length - 1));
                return new vscode.Range(new vscode.Position(safeStart, 0), new vscode.Position(safeEnd, 0));
            }
        }

        const fallbackLine = this.findFirstContentLine(afterText);
        return new vscode.Range(new vscode.Position(fallbackLine, 0), new vscode.Position(fallbackLine, 0));
    }

    private findFirstContentLine(text: string): number {
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim().length > 0) return i;
        }
        return 0;
    }

    private computeChangeRanges(beforeText: string, afterText: string, diffText?: string): vscode.Range[] {
        const ranges = diffText ? this.computeHunkRanges(afterText, diffText) : [];
        if (ranges.length) {
            return this.mergeRanges(ranges);
        }
        const diffRanges = this.computeDiffRanges(beforeText, afterText);
        return this.mergeRanges(diffRanges);
    }

    private computeHunkRanges(afterText: string, diffText: string): vscode.Range[] {
        const rawLines = diffText.split('\n');
        const ranges: vscode.Range[] = [];
        for (const rawLine of rawLines) {
            const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
            const match = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/);
            if (!match) continue;
            const start = parseInt(match[1], 10) - 1;
            const len = match[2] ? Math.max(parseInt(match[2], 10), 1) : 1;
            const contentLines = afterText.split('\n');
            const safeStart = Math.min(start, Math.max(0, contentLines.length - 1));
            const safeEnd = Math.min(safeStart + len - 1, Math.max(0, contentLines.length - 1));
            ranges.push(new vscode.Range(new vscode.Position(safeStart, 0), new vscode.Position(safeEnd, 0)));
        }
        return ranges;
    }

    private computeDiffRanges(beforeText: string, afterText: string): vscode.Range[] {
        const diffs = this.dmp.diff_main(beforeText, afterText);
        this.dmp.diff_cleanupSemantic(diffs);
        const ranges: vscode.Range[] = [];
        let currIndex = 0;
        for (const [op, text] of diffs) {
            if (!text) continue;
            if (op === 0) {
                currIndex += text.length;
                continue;
            }
            const startOffset = currIndex;
            if (op === 1) {
                currIndex += text.length;
            }
            const slice = afterText.slice(0, Math.max(0, startOffset));
            const line = slice.split('\n').length - 1;
            const lastLineIndex = Math.max(0, slice.lastIndexOf('\n'));
            const col = Math.max(0, startOffset - (lastLineIndex === -1 ? 0 : lastLineIndex + 1));
            const pos = new vscode.Position(line, col);
            ranges.push(new vscode.Range(pos, pos));
        }
        return ranges;
    }

    private mergeRanges(ranges: vscode.Range[]): vscode.Range[] {
        if (!ranges.length) return [];
        const sorted = ranges.slice().sort((a, b) => a.start.line - b.start.line);
        const merged: vscode.Range[] = [];
        let current = sorted[0];
        for (let i = 1; i < sorted.length; i++) {
            const next = sorted[i];
            if (next.start.line <= current.end.line + 1) {
                const endLine = Math.max(current.end.line, next.end.line);
                current = new vscode.Range(new vscode.Position(current.start.line, 0), new vscode.Position(endLine, 0));
            } else {
                merged.push(current);
                current = next;
            }
        }
        merged.push(current);
        return merged;
    }

    private startAutoWalk(key: string): void {
        const state = this.stateByKey.get(key);
        if (!state || !state.changeRanges || state.changeRanges.length < 2) return;
        this.cancelAutoWalk(key);
        state.autoWalkIndex = 0;
        const tick = () => {
            const currentState = this.stateByKey.get(key);
            if (!currentState || !currentState.changeRanges) {
                this.cancelAutoWalk(key);
                return;
            }
            const index = currentState.autoWalkIndex ?? 0;
            if (index >= currentState.changeRanges.length) {
                this.cancelAutoWalk(key);
                return;
            }
            const editor = this.findRightEditor(key);
            if (editor) {
                const range = currentState.changeRanges[index];
                this.recordAutoWalkReveal(currentState);
                editor.selection = new vscode.Selection(range.start, range.start);
                editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            }
            currentState.autoWalkIndex = index + 1;
            this.stateByKey.set(key, currentState);
        };
        state.autoWalkTimer = setInterval(tick, 2000);
        this.stateByKey.set(key, state);
        tick();
    }

    private cancelAutoWalk(key: string): void {
        const state = this.stateByKey.get(key);
        if (!state) return;
        if (state.autoWalkTimer) {
            clearInterval(state.autoWalkTimer);
            state.autoWalkTimer = undefined;
        }
        state.autoWalkIndex = undefined;
        this.stateByKey.set(key, state);
    }

    private recordAutoWalkReveal(state: FileState): void {
        state.lastAutoWalkReveal = Date.now();
    }

    private wasRecentAutoWalk(state: FileState): boolean {
        if (!state.lastAutoWalkReveal) return false;
        return Date.now() - state.lastAutoWalkReveal < 200;
    }

    private getKeyFromEditor(editor: vscode.TextEditor, side: 'left' | 'right'): string | undefined {
        const uri = editor.document.uri;
        if (uri.scheme !== 'opencode-diff') return;
        if (uri.authority !== side) return;
        return uri.path.replace(/^\//, '');
    }

    private logDiffUpdate(
        key: string,
        filePath: string,
        beforeText: string,
        afterText: string,
        diffText: string | undefined,
        range: vscode.Range | undefined
    ): void {
        const basename = path.basename(filePath);
        const diffLen = diffText ? diffText.length : 0;
        const rangeInfo = range ? `line=${range.start.line}` : 'line=none';
        console.log(`[OpenCodeDiff] update key=${key} file=${basename} before=${beforeText.length} after=${afterText.length} diff=${diffLen} ${rangeInfo}`);
    }

    private async ensureState(filePath: string, key: string): Promise<FileState> {
        let state = this.stateByKey.get(key);
        if (state) return state;
        state = {
            filePath,
            baseline: '',
            current: '',
            lastAfter: '',
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
            if (line.startsWith('@@') || line.startsWith('+++') || line.startsWith('---') || line.startsWith('===') || line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
                hunks.push(line);
                continue;
            }
            if (line.trim().length) {
                hunks.push(` ${line}`);
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
        let sawTarget = false;
        for (const rawLine of lines) {
            const line = rawLine.endsWith(cr) ? rawLine.slice(0, -1) : rawLine;
            if (line.startsWith('*** Update File:') || line.startsWith('*** Add File:') || line.startsWith('*** Delete File:')) {
                const rawPath = line.split(':', 2)[1]?.trim() || '';
                collecting = this.normalizePath(rawPath) === target;
                if (collecting) {
                    sawTarget = true;
                }
                continue;
            }
            if (line.startsWith('*** End Patch')) {
                break;
            }
            if (!collecting) continue;
            hunks.push(line);
        }
        if (!sawTarget) return undefined;
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
            case '.c':
            case '.h':
                return 'c';
            case '.cpp':
            case '.cxx':
            case '.cc':
            case '.hpp':
            case '.hh':
            case '.hxx':
                return 'cpp';
            case '.py':
                return 'python';
            case '.ipynb':
                return 'python';
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
