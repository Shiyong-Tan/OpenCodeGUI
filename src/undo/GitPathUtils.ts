import * as path from 'path';

export const isLikelyUncPath = (value: string): boolean => value.startsWith('\\');

const isWindowsReservedName = (value: string): boolean => {
    const base = value.toLowerCase();
    return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/.test(base);
};

export const normalizeRepoPath = (workspaceRoot: string, inputPath: string): string | null => {
    if (!inputPath || typeof inputPath !== 'string') return null;
    if (isLikelyUncPath(inputPath)) return null;
    const root = path.resolve(workspaceRoot);
    const abs = path.isAbsolute(inputPath)
        ? path.resolve(inputPath)
        : path.resolve(root, inputPath);
    let rel = path.relative(root, abs);
    if (!rel) return null;
    const relNormalizedForCheck = rel.replace(/[\\/]+/g, '/');
    if (relNormalizedForCheck === '..' || relNormalizedForCheck.startsWith('../') || path.isAbsolute(rel)) return null;
    rel = rel.split(path.sep).join('/');
    if (rel.includes('..')) return null;
    if (rel === '.git' || rel.startsWith('.git/')) return null;
    if (rel === '.opencode' || rel.startsWith('.opencode/')) return null;
    const baseName = path.basename(rel);
    if (isWindowsReservedName(baseName)) return null;
    return rel;
};

export const explainNormalizeRepoPath = (
    workspaceRoot: string,
    inputPath: string
): { normalized: string | null; reason: string; root?: string; abs?: string } => {
    if (!inputPath || typeof inputPath !== 'string') {
        return { normalized: null, reason: 'invalid-input' };
    }
    if (isLikelyUncPath(inputPath)) {
        return { normalized: null, reason: 'unc-path' };
    }
    const root = path.resolve(workspaceRoot);
    const abs = path.isAbsolute(inputPath)
        ? path.resolve(inputPath)
        : path.resolve(root, inputPath);
    let rel = path.relative(root, abs);
    if (!rel) {
        return { normalized: null, reason: 'invalid-relative', root, abs };
    }
    const relNormalizedForCheck = rel.replace(/[\\/]+/g, '/');
    if (relNormalizedForCheck === '..' || relNormalizedForCheck.startsWith('../') || path.isAbsolute(rel)) {
        return { normalized: null, reason: 'invalid-relative', root, abs };
    }
    rel = rel.split(path.sep).join('/');
    if (rel.includes('..')) {
        return { normalized: null, reason: 'relative-parent-segment', root, abs };
    }
    if (rel === '.git' || rel.startsWith('.git/')) {
        return { normalized: null, reason: 'git-internal', root, abs };
    }
    if (rel === '.opencode' || rel.startsWith('.opencode/')) {
        return { normalized: null, reason: 'opencode-internal', root, abs };
    }
    const baseName = path.basename(rel);
    if (isWindowsReservedName(baseName)) {
        return { normalized: null, reason: 'windows-reserved-name', root, abs };
    }
    return { normalized: rel, reason: 'ok', root, abs };
};

export const normalizeTouchedFiles = (workspaceRoot: string, paths: string[]): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const p of paths) {
        const normalized = normalizeRepoPath(workspaceRoot, p);
        if (!normalized) continue;
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
};
