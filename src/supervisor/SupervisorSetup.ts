import { promises as fs } from 'fs';
import { join } from 'path';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { officialReleaseVersion, newerRelease, resolveLatestSupervisorRelease } from './SupervisorRelease';
import type { ProtocolFamily } from '../transport/protocol/ProtocolNegotiator';
const isSupervisor = (value: unknown): boolean => typeof value === 'string' && /(?:opencode-task-supervisor|OpenCodeTaskSupervisor)(?:[\/\\@#.-]|$)/i.test(value);
const sourceOf = (entry: unknown): unknown => Array.isArray(entry) ? entry[0] : entry && typeof entry === 'object' ? (entry as Record<string, unknown>).package : entry;

function readConfig(source: string) {
    const errors: ParseError[] = [];
    const config = parse(source, errors, { allowTrailingComma: true }) as Record<string, unknown>;
    if (errors.length || !config || typeof config !== 'object' || Array.isArray(config)) throw new Error('OpenCode configuration is not a valid JSONC object.');
    if (config.plugin !== undefined && !Array.isArray(config.plugin)) throw new Error('OpenCode plugin configuration must be an array.');
    if (config.plugins !== undefined && !Array.isArray(config.plugins)) throw new Error('OpenCode plugins configuration must be an array.');
    const matches = (['plugin', 'plugins'] as const).flatMap(key => (config[key] as unknown[] ?? [])
        .flatMap((entry, index) => isSupervisor(sourceOf(entry)) ? [{ key, index, entry }] : []));
    if (matches.length > 1) throw new Error('Multiple Supervisor declarations found. Keep one before enabling.');
    const found = matches[0], key = found?.key ?? 'plugin', index = found?.index ?? (config.plugin as unknown[] ?? []).length;
    const prior = found?.entry;
    const options = Array.isArray(prior) ? prior[1] : prior && typeof prior === 'object' ? (prior as Record<string, unknown>).options ?? {} : {};
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid Supervisor plugin options.');
    if (options.readonlyLab || options.managedLab) throw new Error('Laboratory Supervisor configuration cannot be enabled as normal GUI mode.');
    const sourceUrl = sourceOf(prior);
    return { config, key, index, prior, options, sourceUrl };
}

/** Edit only the plugin declaration; permission rules and unrelated text stay intact. */
export function mergeSupervisorConfig(source: string, release?: string, family: ProtocolFamily = 'v1'): string {
    const { config, key, index, prior, options, sourceUrl } = readConfig(source);
    const selected = sourceUrl === undefined ? release : typeof sourceUrl === 'string' && officialReleaseVersion(sourceUrl) && release ? newerRelease(sourceUrl, release) : sourceUrl;
    if (typeof selected !== 'string' || !selected) throw new Error('A verified Supervisor release is required.');
    const normalized = { ...options, allowDispatch: options.allowDispatch ?? true, allowNotifications: options.allowNotifications ?? false, normalGui: { enabled: true } };
    const targetKey = family === 'v2' ? 'plugins' : 'plugin';
    const entry = family === 'v2' ? { package: selected, options: normalized } : [selected, normalized];
    if (key === targetKey && JSON.stringify(prior) === JSON.stringify(entry)) return source;
    const formatting = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: source.includes('\r\n') ? '\r\n' : '\n' } };
    let edited = source;
    if (prior !== undefined && key !== targetKey) {
        if (targetKey === 'plugin' && (config.plugins as unknown[]).length > 1) throw new Error('Native plugins require a separate compatible workspace configuration before using OpenCode 1.');
        const removal = (config[key] as unknown[]).length === 1 ? [key] : [key, index];
        edited = applyEdits(edited, modify(edited, removal, undefined, formatting));
    }
    const existing = config[targetKey] as unknown[] | undefined;
    const target = existing === undefined ? [targetKey] : [targetKey, key === targetKey ? index : existing.length];
    return applyEdits(edited, modify(edited, target, existing === undefined ? [entry] : entry, formatting));
}

export async function configureSupervisor(workspace: string, checkRelease?: () => Promise<string>, family: ProtocolFamily = 'v1'): Promise<boolean> {
    const root = await fs.realpath(workspace);
    const candidates = ['opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc'];
    const existing: string[] = [];
    for (const name of candidates) {
        const file = join(root, name);
        try {
            const stat = await fs.lstat(file);
            if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(file) !== file) throw new Error('OpenCode configuration redirects outside its expected path.');
            existing.push(file);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (existing.length > 1) throw new Error('Multiple workspace OpenCode configurations found. Consolidate them before automatic setup.');
    const file = existing[0] ?? join(root, 'opencode.json');
    const lock = await fs.open(join(root, '.opencode-supervisor-setup.lock'), 'wx').catch(() => { throw new Error('Supervisor setup is already running, or its setup lock needs review.'); });
    try {
        const before = existing.length ? await fs.readFile(file, 'utf8') : '{}\n';
        if (Buffer.byteLength(before) > 1048576) throw new Error('OpenCode configuration is too large for automatic setup.');
        // Validate configuration before making a network request; custom sources remain local.
        const { sourceUrl } = readConfig(before);
        const official = sourceUrl === undefined || officialReleaseVersion(sourceUrl) !== undefined;
        const release = official ? await (checkRelease ? checkRelease() : resolveLatestSupervisorRelease(family)) : undefined;
        if (official && !officialReleaseVersion(release)) throw new Error('Invalid Supervisor release address. Configuration was not changed.');
        const after = mergeSupervisorConfig(before, release, family);
        if (after === before) return false;
        if (existing.length && await fs.readFile(file, 'utf8') !== before) throw new Error('OpenCode configuration changed during setup. Retry.');
        if (existing.length) {
            await fs.copyFile(file, `${file}.supervisor-backup-${Date.now()}`);
            const temporary = `${file}.supervisor-new`;
            await fs.writeFile(temporary, after, { flag: 'wx' });
            await fs.rename(temporary, file);
        } else await fs.writeFile(file, after, { flag: 'wx' });
        return true;
    } finally { await lock.close(); await fs.unlink(join(root, '.opencode-supervisor-setup.lock')); }
}
