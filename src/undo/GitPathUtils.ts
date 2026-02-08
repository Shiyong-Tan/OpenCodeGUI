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
    if (abs !== root && !abs.startsWith(root + path.sep)) return null;
    let rel = path.relative(root, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    rel = rel.split(path.sep).join('/');
    if (rel.includes('..')) return null;
    if (rel === '.git' || rel.startsWith('.git/')) return null;
    if (rel === '.opencode' || rel.startsWith('.opencode/')) return null;
    const baseName = path.basename(rel);
    if (isWindowsReservedName(baseName)) return null;
    return rel;
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
