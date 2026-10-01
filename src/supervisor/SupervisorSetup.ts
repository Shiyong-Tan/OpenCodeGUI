import { promises as fs } from 'fs';
import { join } from 'path';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import { officialReleaseVersion, newerRelease, resolveLatestSupervisorRelease } from './SupervisorRelease';
const isSupervisor = (value: unknown): boolean => typeof value === 'string' && /(?:opencode-task-supervisor|OpenCodeTaskSupervisor)(?:[\/\\@#.-]|$)/i.test(value);

function readConfig(source: string) {
    const errors: ParseError[] = [];
    const config = parse(source, errors, { allowTrailingComma: true }) as Record<string, unknown>;
    if (errors.length || !config || typeof config !== 'object' || Array.isArray(config)) throw new Error('OpenCode configuration is not a valid JSONC object.');
    if (config.plugin !== undefined && !Array.isArray(config.plugin)) throw new Error('OpenCode plugin configuration must be an array.');
    const plugins = [...(config.plugin as unknown[] ?? [])];
    const matches = plugins.map((p, i) => isSupervisor(Array.isArray(p) ? p[0] : p) ? i : -1).filter(i => i >= 0);
    if (matches.length > 1) throw new Error('Multiple Supervisor declarations found. Keep one before enabling.');
    const index = matches[0] ?? plugins.length;
    const prior = plugins[index];
    const options = Array.isArray(prior) ? prior[1] : {};
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid Supervisor plugin options.');
    if (options.readonlyLab || options.managedLab) throw new Error('Laboratory Supervisor configuration cannot be enabled as normal GUI mode.');
    const sourceUrl = Array.isArray(prior) ? prior[0] : prior;
    return { config, index, prior, options, sourceUrl };
}

/** Edit only the plugin declaration; permission rules and unrelated text stay intact. */
export function mergeSupervisorConfig(source: string, release?: string): string {
    const { config, index, prior, options, sourceUrl } = readConfig(source);
    const selected = sourceUrl === undefined ? release : officialReleaseVersion(sourceUrl) && release ? newerRelease(sourceUrl, release) : sourceUrl;
    if (!selected) throw new Error('A verified Supervisor release is required.');
    const entry = [selected,
        { ...options, allowDispatch: options.allowDispatch ?? true, allowNotifications: options.allowNotifications ?? false, normalGui: { enabled: true } }];
    if (JSON.stringify(prior) === JSON.stringify(entry)) return source;
    const target = config.plugin === undefined ? ['plugin'] : ['plugin', index];
    return applyEdits(source, modify(source, target, config.plugin === undefined ? [entry] : entry,
        { formattingOptions: { insertSpaces: true, tabSize: 2, eol: source.includes('\r\n') ? '\r\n' : '\n' } }));
}

export async function configureSupervisor(workspace: string, checkRelease: () => Promise<string> = resolveLatestSupervisorRelease): Promise<boolean> {
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
        const release = official ? await checkRelease() : undefined;
        if (official && !officialReleaseVersion(release)) throw new Error('Invalid Supervisor release address. Configuration was not changed.');
        const after = mergeSupervisorConfig(before, release);
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
