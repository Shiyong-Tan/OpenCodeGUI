import * as path from 'path';
import * as vscode from 'vscode';

const EXCLUDE_GLOB = '**/{.git,node_modules,.opencode,.sisyphus,dist,out,build,coverage}/**';
const MAX_FILES_PER_ROOT = 4_000;
const MAX_OPEN_DOCUMENTS = 24;
const MAX_DOCUMENT_CHARS = 160_000;
const MAX_TERMS = 8_000;
const CACHE_TTL_MS = 30_000;

export function extractWorkspaceTerms(text: string): string[] {
    const matches = String(text || '').match(/[A-Za-z][A-Za-z0-9_-]{2,63}/g) || [];
    const terms = new Set<string>();
    for (const raw of matches) {
        if (/\d{6,}/.test(raw) || /^[a-f0-9]{20,}$/i.test(raw)) continue;
        const split = raw
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
            .replace(/[_-]+/g, ' ')
            .split(/\s+/);
        for (const candidate of [raw, ...split]) {
            if (candidate.length >= 3 && candidate.length <= 48) terms.add(candidate);
        }
    }
    return [...terms];
}

export class WorkspaceLexiconService {
    private cached: { key: string; expiresAt: number; terms: string[] } | null = null;

    public async getTerms(): Promise<string[]> {
        const folders = vscode.workspace.workspaceFolders || [];
        const key = folders.map((folder) => folder.uri.fsPath).join('|');
        const now = Date.now();
        if (this.cached?.key === key && this.cached.expiresAt > now) {
            return [...this.cached.terms];
        }

        const counts = new Map<string, { display: string; count: number }>();
        const add = (value: string, weight = 1): void => {
            for (const term of extractWorkspaceTerms(value)) {
                const normalized = term.toLocaleLowerCase();
                const existing = counts.get(normalized);
                if (existing) {
                    existing.count += weight;
                    if (/[A-Z_]/.test(term) && !/[A-Z_]/.test(existing.display)) existing.display = term;
                } else {
                    counts.set(normalized, { display: term, count: weight });
                }
            }
        };

        await Promise.all(folders.map(async (folder) => {
            let files: vscode.Uri[] = [];
            try {
                files = await vscode.workspace.findFiles(
                    new vscode.RelativePattern(folder, '**/*'),
                    EXCLUDE_GLOB,
                    MAX_FILES_PER_ROOT,
                );
            } catch {
                return;
            }
            for (const uri of files) {
                const relative = path.relative(folder.uri.fsPath, uri.fsPath);
                if (relative && !relative.startsWith('..')) add(relative, 2);
            }
        }));

        const roots = folders.map((folder) => path.resolve(folder.uri.fsPath));
        const isInWorkspace = (fsPath: string): boolean => roots.some((root) => {
            const relative = path.relative(root, path.resolve(fsPath));
            return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
        });
        for (const document of vscode.workspace.textDocuments.slice(0, MAX_OPEN_DOCUMENTS)) {
            if (document.isClosed || document.uri.scheme !== 'file' || !isInWorkspace(document.uri.fsPath)) continue;
            add(path.basename(document.uri.fsPath), 4);
            add(document.getText().slice(0, MAX_DOCUMENT_CHARS), 3);
        }

        const terms = [...counts.values()]
            .sort((left, right) => right.count - left.count
                || left.display.length - right.display.length
                || left.display.localeCompare(right.display))
            .slice(0, MAX_TERMS)
            .map((item) => item.display);
        this.cached = { key, expiresAt: now + CACHE_TTL_MS, terms };
        return [...terms];
    }

    public invalidate(): void {
        this.cached = null;
    }
}
