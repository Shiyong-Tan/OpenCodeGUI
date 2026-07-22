import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type OpenCodeSpawnSpec = Readonly<{ command: string; args: string[] }>;

const MISSING_BINARY_ERROR = 'Could not find "opencode" on PATH. Please install it or add it to your PATH.';

export function mergePathEntries(...paths: string[]): string {
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const raw of paths) {
        if (!raw) continue;
        for (const piece of raw.split(';')) {
            const entry = piece.trim();
            if (!entry) continue;
            const key = entry.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(entry);
        }
    }
    return merged.join(';');
}

export function resolveWindowsCommandPath(
    resolvedPath: string,
    exists: (candidate: string) => boolean = fs.existsSync,
): string | undefined {
    const ext = path.extname(resolvedPath).toLowerCase();
    if (ext === '.cmd' || ext === '.exe' || ext === '.bat') return resolvedPath;
    for (const suffix of ['.cmd', '.exe', '.bat']) {
        const candidate = `${resolvedPath}${suffix}`;
        if (exists(candidate)) return candidate;
    }
    return undefined;
}

function quotePowerShell(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

function toPowerShellHereString(value: string): string {
    return `@'\n${value.replace(/'@/g, "'`@")}\n'@`;
}

export function buildOpenCodeSpawn(
    bin: string,
    args: string[],
    stdinText?: string,
    platform: NodeJS.Platform = process.platform,
): OpenCodeSpawnSpec {
    const useCmdWrapper = platform === 'win32' && ['.cmd', '.bat'].includes(path.extname(bin).toLowerCase());
    const multilineArg = args.find((arg) => arg.includes('\n'));
    if (useCmdWrapper && multilineArg && !stdinText) {
        const filtered = args.filter((arg) => arg !== multilineArg && arg !== '--');
        const psArgs = filtered.map(quotePowerShell).join(' ');
        const message = toPowerShellHereString(multilineArg);
        const invocation = psArgs
            ? `& ${quotePowerShell(bin)} ${psArgs} -- $msg`
            : `& ${quotePowerShell(bin)} -- $msg`;
        return {
            command: 'powershell.exe',
            args: ['-NoProfile', '-Command', `$msg = ${message}\n${invocation}`],
        };
    }
    if (useCmdWrapper) return { command: 'cmd.exe', args: ['/c', bin, ...args] };
    return { command: bin, args: [...args] };
}

export class OpenCodeCommandResolver {
    private resolvedBin?: string;

    constructor(private readonly log: (message: string) => void) {}

    public buildSpawn(bin: string, args: string[], stdinText?: string): OpenCodeSpawnSpec {
        return buildOpenCodeSpawn(bin, args, stdinText);
    }

    public resolve(): Promise<string> {
        if (this.resolvedBin) return Promise.resolve(this.resolvedBin);
        const isWin = process.platform === 'win32';
        const resolver = isWin ? 'where' : 'which';
        const target = isWin ? 'opencode.cmd' : 'opencode';
        const resolveEnv = this.buildResolverEnv();
        const rawPath = resolveEnv.Path || resolveEnv.PATH || '';
        const pathEntries = rawPath.split(';').map((entry) => entry.trim()).filter(Boolean);
        const npmPathPresent = pathEntries.some((entry) => /\\AppData\\Roaming\\npm$/i.test(entry));
        this.log(`[RESOLVE_BIN] platform=${process.platform} resolver=${resolver} target=${target} pathEntries=${pathEntries.length} npmPathPresent=${npmPathPresent}`);
        if (!npmPathPresent) this.log(`[RESOLVE_BIN] pathTail=${pathEntries.slice(-8).join(';')}`);

        return new Promise((resolve, reject) => {
            this.execResolver(resolver, target, resolveEnv, 'primary', (result) => {
                if (result) {
                    this.acceptResolvedPath(result, isWin, resolve, reject);
                    return;
                }
                if (!isWin || target !== 'opencode.cmd') {
                    reject(MISSING_BINARY_ERROR);
                    return;
                }
                this.execResolver(resolver, 'opencode', resolveEnv, 'fallback', (fallback) => {
                    if (!fallback) {
                        reject(MISSING_BINARY_ERROR);
                        return;
                    }
                    this.acceptResolvedPath(fallback, true, resolve, reject);
                });
            });
        });
    }

    private execResolver(
        resolver: string,
        target: string,
        env: NodeJS.ProcessEnv,
        label: string,
        done: (stdout?: string) => void,
    ): void {
        cp.exec(`${resolver} ${target}`, { encoding: 'utf-8', env }, (error, stdout, stderr) => {
            if (error) this.log(`[RESOLVE_BIN] ${label}.error code=${String((error as NodeJS.ErrnoException).code ?? '')} message=${error.message}`);
            if (stdout) this.log(`[RESOLVE_BIN] ${label}.stdout=${stdout.trim()}`);
            if (stderr) this.log(`[RESOLVE_BIN] ${label}.stderr=${stderr.trim()}`);
            done(error || !stdout ? undefined : stdout);
        });
    }

    private acceptResolvedPath(
        output: string,
        isWin: boolean,
        resolve: (value: string) => void,
        reject: (reason: string) => void,
    ): void {
        const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const resolved = lines.length ? (isWin ? resolveWindowsCommandPath(lines[0]) : lines[0]) : undefined;
        if (!resolved) {
            reject(MISSING_BINARY_ERROR);
            return;
        }
        this.resolvedBin = resolved;
        resolve(resolved);
    }

    private buildResolverEnv(): NodeJS.ProcessEnv {
        const env = { ...process.env };
        if (process.platform !== 'win32') return env;
        const processPath = process.env.Path || process.env.PATH || '';
        const userPath = this.readWindowsRegistryPath('HKCU\\Environment', 'Path');
        const machinePath = this.readWindowsRegistryPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'Path');
        const merged = mergePathEntries(processPath, userPath, machinePath);
        env.Path = merged;
        env.PATH = merged;
        return env;
    }

    private readWindowsRegistryPath(key: string, valueName: string): string {
        try {
            const out = cp.execSync(`reg query "${key}" /v ${valueName}`, { encoding: 'utf-8', windowsHide: true });
            const row = out.split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean)
                .find((line) => line.includes('REG_EXPAND_SZ') || line.includes('REG_SZ'));
            if (!row) return '';
            const parts = row.split(/\s{2,}/).map((part) => part.trim()).filter(Boolean);
            return (parts[parts.length - 1] || '').replace(
                /%([^%]+)%/g,
                (_match, name) => process.env[name] || process.env[name.toUpperCase()] || '',
            );
        } catch {
            return '';
        }
    }
}
