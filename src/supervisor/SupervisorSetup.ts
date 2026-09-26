import { promises as fs } from 'fs';
import { join } from 'path';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';

export const supervisorRelease = 'https://github.com/Shiyong-Tan/opencode-task-supervisor/releases/download/v0.1.1/opencode-task-supervisor-0.1.1.tgz';
const previousSupervisorRelease = 'https://github.com/Shiyong-Tan/opencode-task-supervisor/releases/download/v0.1.0/opencode-task-supervisor-0.1.0.tgz';
const isSupervisor = (value: unknown): boolean => typeof value === 'string' && /(?:opencode-task-supervisor|OpenCodeTaskSupervisor)(?:[\/\\@#.-]|$)/i.test(value);

/** Edit only the plugin declaration; permission rules and unrelated text stay intact. */
export function mergeSupervisorConfig(source: string): string {
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
    const entry = [sourceUrl === previousSupervisorRelease ? supervisorRelease : sourceUrl ?? supervisorRelease,
        { ...options, allowDispatch: options.allowDispatch ?? true, allowNotifications: options.allowNotifications ?? false, normalGui: { enabled: true } }];
    if (JSON.stringify(prior) === JSON.stringify(entry)) return source;
    const target = config.plugin === undefined ? ['plugin'] : ['plugin', index];
    return applyEdits(source, modify(source, target, config.plugin === undefined ? [entry] : entry,
        { formattingOptions: { insertSpaces: true, tabSize: 2, eol: source.includes('\r\n') ? '\r\n' : '\n' } }));
}

export async function configureSupervisor(workspace: string, checkRelease: () => Promise<void>): Promise<boolean> {
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
        const after = mergeSupervisorConfig(before);
        if (after === before) return false;
        if (after.includes(supervisorRelease)) await checkRelease();
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

export async function checkSupervisorRelease(): Promise<void> {
    const response = await fetch(supervisorRelease, { method: 'HEAD', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Supervisor release is unavailable. Configuration was not changed. Check the GitHub release and network connection.');
}
