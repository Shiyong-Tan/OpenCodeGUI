import * as path from 'path';
import type { FileChangeSpec } from '../undo/types';

export type FileSnapshot = {
    filePath: string;
    relativePath?: string;
    type?: 'update' | 'create' | 'delete';
    diff?: string;
    patch?: string;
    before?: string;
    after?: string;
    existsBefore?: boolean;
    existsAfter?: boolean;
    additions?: number;
    deletions?: number;
};

export function extractPatchText(raw: any): string | undefined {
    const metadata = raw?.metadata ?? raw?.state?.metadata;
    const filediff = metadata?.filediff;
    const candidates = [raw?.patch, raw?.diff, raw?.changes, metadata?.patch, metadata?.diff, filediff?.patch, filediff?.diff];
    for (const value of candidates) {
        if (typeof value === 'string' && value.trim().length > 0) return value;
    }
    return undefined;
}

export function extractFilesFromToolPart(part: any, log: (message: string) => void = () => undefined): FileSnapshot[] {
    const tool = part?.tool;
    if (!tool || part?.state?.status !== 'completed') return [];
    if (tool === 'apply_patch') {
        const stateFiles = Array.isArray(part?.state?.metadata?.files) ? part.state.metadata.files : [];
        const files: FileSnapshot[] = [];
        for (const file of stateFiles) {
            if (!file?.filePath) continue;
            const type = file?.type as FileSnapshot['type'];
            const existsBefore = typeof file?.existsBefore === 'boolean'
                ? file.existsBefore
                : (type === 'create' ? false : type === 'delete' ? true : true);
            const existsAfter = typeof file?.existsAfter === 'boolean'
                ? file.existsAfter
                : (type === 'create' ? true : type === 'delete' ? false : true);
            const patchText = extractPatchText(file);
            files.push({
                filePath: file.filePath,
                relativePath: file.relativePath,
                type,
                diff: patchText,
                patch: patchText,
                before: typeof file.before === 'string' ? file.before : (typeof file.from === 'string' ? file.from : undefined),
                after: typeof file.after === 'string' ? file.after : (typeof file.to === 'string' ? file.to : undefined),
                existsBefore,
                existsAfter,
                additions: typeof file.additions === 'number' ? file.additions : undefined,
                deletions: typeof file.deletions === 'number' ? file.deletions : undefined,
            });
        }
        return files;
    }
    if (tool === 'edit') {
        const metadata = part?.state?.metadata;
        const filediff = metadata?.filediff;
        if (!filediff?.file) return [];
        const patchText = extractPatchText({ metadata });
        return [{
            filePath: filediff.file,
            type: 'update',
            diff: patchText,
            patch: patchText,
            before: typeof filediff.before === 'string' ? filediff.before : (typeof filediff.from === 'string' ? filediff.from : undefined),
            after: typeof filediff.after === 'string' ? filediff.after : (typeof filediff.to === 'string' ? filediff.to : undefined),
            existsBefore: true,
            existsAfter: true,
            additions: typeof filediff.additions === 'number' ? filediff.additions : undefined,
            deletions: typeof filediff.deletions === 'number' ? filediff.deletions : undefined,
        }];
    }
    if (tool === 'write') {
        const input = part?.state?.input;
        const metadata = part?.state?.metadata;
        if (!input?.filePath) {
            log('write.skip | reason=missing-filePath');
            return [];
        }
        const existsBefore = typeof metadata?.exists === 'boolean' ? metadata.exists : false;
        const filediff = metadata?.filediff;
        const beforeText = typeof metadata?.before === 'string'
            ? metadata.before
            : (typeof filediff?.before === 'string' ? filediff.before : (typeof filediff?.from === 'string' ? filediff.from : undefined));
        const diffText = typeof metadata?.diff === 'string'
            ? metadata.diff
            : (typeof filediff?.diff === 'string' ? filediff.diff : (typeof metadata?.patch === 'string' ? metadata.patch : undefined));
        return [{
            filePath: input.filePath,
            type: existsBefore ? 'update' : 'create',
            before: existsBefore ? beforeText : '',
            after: typeof input.content === 'string' ? input.content : '',
            existsBefore,
            existsAfter: true,
            diff: diffText,
            patch: diffText,
            additions: typeof filediff?.additions === 'number' ? filediff.additions : undefined,
            deletions: typeof filediff?.deletions === 'number' ? filediff.deletions : undefined,
        }];
    }
    return [];
}

export function extractFilesFromEvent(parsed: any, log?: (message: string) => void): FileSnapshot[] {
    if (parsed?.type !== 'tool_use') return [];
    return extractFilesFromToolPart(parsed?.part, log);
}

export function normalizeIncomingFileSnapshots(files: any[]): FileSnapshot[] {
    const normalized: FileSnapshot[] = [];
    for (const raw of files || []) {
        if (!raw) continue;
        if (typeof raw === 'string') {
            const filePath = raw.trim();
            if (filePath) normalized.push({ filePath, type: 'update' });
            continue;
        }
        const filePath =
            (typeof raw.filePath === 'string' && raw.filePath) ||
            (typeof raw.file === 'string' && raw.file) ||
            (typeof raw.path === 'string' && raw.path) ||
            (typeof raw.relativePath === 'string' && raw.relativePath) || '';
        if (!filePath) continue;
        const diffText = extractPatchText(raw);
        normalized.push({
            filePath,
            relativePath: typeof raw.relativePath === 'string' ? raw.relativePath : undefined,
            type: raw.type as FileSnapshot['type'],
            diff: diffText,
            patch: diffText,
            before: typeof raw.before === 'string' ? raw.before : (typeof raw.from === 'string' ? raw.from : undefined),
            after: typeof raw.after === 'string' ? raw.after : (typeof raw.to === 'string' ? raw.to : undefined),
            existsBefore: typeof raw.existsBefore === 'boolean' ? raw.existsBefore : undefined,
            existsAfter: typeof raw.existsAfter === 'boolean' ? raw.existsAfter : undefined,
            additions: typeof raw.additions === 'number' ? raw.additions : undefined,
            deletions: typeof raw.deletions === 'number' ? raw.deletions : undefined,
        });
    }
    return normalized;
}

export function buildChangeSpecs(files: FileSnapshot[]): FileChangeSpec[] {
    const changes: FileChangeSpec[] = [];
    for (const file of files) {
        const filePath = typeof file?.filePath === 'string' ? file.filePath.trim() : '';
        if (!filePath) continue;
        const existsBefore = typeof file.existsBefore === 'boolean'
            ? file.existsBefore
            : (file.type === 'create' ? false : file.type === 'delete' ? true : true);
        const existsAfter = typeof file.existsAfter === 'boolean'
            ? file.existsAfter
            : (file.type === 'create' ? true : file.type === 'delete' ? false : true);
        if (!existsAfter) changes.push({ type: 'delete', path: filePath });
        else if (!existsBefore && existsAfter) changes.push({ type: 'create', path: filePath });
        else changes.push({ type: 'update', path: filePath });
    }
    return changes;
}

export function mergeChangeSpecs(changes: FileChangeSpec[]): FileChangeSpec[] {
    if (!changes.length) return [];
    const merged: FileChangeSpec[] = [];
    const indexByKey = new Map<string, number>();
    const pushOrReplace = (change: FileChangeSpec, key: string) => {
        const existingIndex = indexByKey.get(key);
        if (existingIndex !== undefined) merged[existingIndex] = change;
        else {
            indexByKey.set(key, merged.length);
            merged.push(change);
        }
    };
    const flatten = (items: FileChangeSpec[]) => {
        for (const item of items) {
            if (item.type === 'multi') {
                flatten(item.items);
            } else if (item.type === 'rename') {
                pushOrReplace(item, `rename:${item.oldPath}->${item.newPath}`);
            } else {
                pushOrReplace(item, `path:${item.path}`);
            }
        }
    };
    flatten(changes);
    return merged;
}

function tokenizeShellLikeArgs(rawArgs: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let quote: '"' | "'" | undefined;
    for (const character of rawArgs) {
        if (quote) {
            if (character === quote) quote = undefined;
            else current += character;
        } else if (character === '"' || character === "'") {
            quote = character;
        } else if (/\s/.test(character)) {
            if (current) {
                tokens.push(current);
                current = '';
            }
        } else {
            current += character;
        }
    }
    if (current) tokens.push(current);
    return tokens;
}

function concreteDeletePathTokens(tokens: string[], isPowerShellRemoveItem: boolean): string[] {
    const paths: string[] = [];
    const pathOptions = new Set(['-path', '-literalpath', '-pspath']);
    const valueOptions = new Set(['-filter', '-include', '-exclude', '-credential', '-stream']);
    const rmValueOptions = new Set(['--one-file-system']);
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        const lower = token.toLowerCase();
        if (isPowerShellRemoveItem) {
            if (pathOptions.has(lower)) {
                const next = tokens[++index];
                if (next) paths.push(...next.split(',').map((item) => item.trim()).filter(Boolean));
                continue;
            }
            if (lower.startsWith('-path:') || lower.startsWith('-literalpath:') || lower.startsWith('-pspath:')) {
                const value = token.slice(token.indexOf(':') + 1).trim();
                if (value) paths.push(...value.split(',').map((item) => item.trim()).filter(Boolean));
                continue;
            }
            if (valueOptions.has(lower)) {
                index += 1;
                continue;
            }
            if (lower.startsWith('-')) continue;
            paths.push(...token.split(',').map((item) => item.trim()).filter(Boolean));
            continue;
        }
        if (lower === '--') {
            paths.push(...tokens.slice(index + 1));
            break;
        }
        if (lower.startsWith('--')) {
            if (rmValueOptions.has(lower)) index += 1;
            continue;
        }
        if (/^-[A-Za-z]+$/.test(token)) continue;
        paths.push(token);
    }
    return paths;
}

function isUnsafeDeletePathToken(rawPath: string): boolean {
    const value = rawPath.trim();
    return !value || value.startsWith('-') || /[\r\n]/.test(value) || /[*?]/.test(value) || /[|;&<>`]/.test(value);
}

export function extractDeletedPathsFromCommand(
    command: unknown,
    cwd: string | undefined,
    log: (message: string) => void = () => undefined,
): string[] {
    if (typeof command !== 'string' || !command.trim()) return [];
    const normalized = command.trim();
    const lower = normalized.toLowerCase();
    let rawArgs = '';
    if (lower.startsWith('rm ')) rawArgs = normalized.slice(3).trim();
    else if (lower.startsWith('del ')) rawArgs = normalized.slice(4).trim();
    else if (lower.startsWith('erase ')) rawArgs = normalized.slice(6).trim();
    else if (lower.startsWith('remove-item ')) rawArgs = normalized.slice(12).trim();
    if (!rawArgs) return [];
    const rawPaths = concreteDeletePathTokens(tokenizeShellLikeArgs(rawArgs), lower.startsWith('remove-item '));
    const paths: string[] = [];
    for (const rawPath of rawPaths) {
        if (isUnsafeDeletePathToken(rawPath)) {
            log(`[EXT][DELETE_PATH] reject | reason=unsafe-token | token=${JSON.stringify(rawPath)}`);
            continue;
        }
        paths.push(path.isAbsolute(rawPath) ? rawPath : (cwd ? path.join(cwd, rawPath) : rawPath));
    }
    return Array.from(new Set(paths));
}

export function extractWrittenPathsFromBashCommand(command: unknown, cwd: string | undefined): string[] {
    if (typeof command !== 'string' || !command.trim()) return [];
    const paths = new Set<string>();
    const pushPath = (rawPath: string | undefined) => {
        if (!rawPath) return;
        const trimmed = rawPath.replace(/^['"]|['"]$/g, '').trim();
        if (!trimmed) return;
        paths.add(path.isAbsolute(trimmed) ? trimmed : (cwd ? path.join(cwd, trimmed) : trimmed));
    };
    const normalized = command.trim();
    for (const match of normalized.matchAll(/Path\(\s*r?["']([^"'`]+)["']\s*\)/g)) pushPath(match[1]);
    for (const match of normalized.matchAll(/open\(\s*r?["']([^"'`]+)["']\s*,\s*["'](?:w|a|x|wb|ab|xb)["']/g)) pushPath(match[1]);
    for (const match of normalized.matchAll(/(?:^|[^\w])(?:>|>>)\s*["']?([^\s"'`|;]+)["']?/g)) pushPath(match[1]);
    return Array.from(paths);
}
