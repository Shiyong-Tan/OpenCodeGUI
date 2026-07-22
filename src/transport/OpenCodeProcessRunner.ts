import * as cp from 'child_process';
import type { OpenCodeCommandResolver } from './OpenCodeCommandResolver';

const MISSING_BINARY_ERROR = 'Could not find "opencode" on PATH. Please install it or add it to your PATH.';

export function stripAnsi(value: string): string {
    return value.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
}

export class OpenCodeLineBuffer {
    private buffer = '';

    public push(chunk: string): string[] {
        this.buffer += chunk;
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop() || '';
        return lines.map((line) => line.trim()).filter(Boolean);
    }

    public flush(): string[] {
        const line = this.buffer.trim();
        this.buffer = '';
        return line ? [line] : [];
    }
}

export class OpenCodeProcessRunner {
    private currentChild?: cp.ChildProcess;

    constructor(private readonly options: {
        resolver: OpenCodeCommandResolver;
        getCwd(): string;
        log(message: string): void;
        spawn?: typeof cp.spawn;
    }) {}

    public execute(args: string[]): Promise<string> {
        return new Promise((resolve, reject) => {
            this.options.resolver.resolve().then((bin) => {
                const cwd = this.options.getCwd();
                const startTime = Date.now();
                const spawnSpec = this.options.resolver.buildSpawn(bin, args);
                const child = this.spawn(spawnSpec.command, spawnSpec.args, cwd);
                child.stdin?.end();
                let stdout = '';
                let stderr = '';
                child.stdout?.on('data', (data) => {
                    const rawChunk = data.toString('utf8');
                    stdout += rawChunk;
                    this.options.log(`[STDOUT_CHUNK] (dt: ${Date.now() - startTime}ms) ${stripAnsi(rawChunk)}`);
                });
                child.stderr?.on('data', (data) => {
                    const rawChunk = data.toString('utf8');
                    stderr += rawChunk;
                    this.options.log(`[STDERR_CHUNK] ${stripAnsi(rawChunk)}`);
                });
                child.on('close', (code) => {
                    this.options.log(`[CLOSE] Exit code: ${code}, Duration: ${Date.now() - startTime}ms`);
                    if (stdout) resolve(stripAnsi(stdout.trim()));
                    else reject(stripAnsi(stderr.trim()) || `Process finished with no output (Code: ${code})`);
                });
                child.on('error', (error: NodeJS.ErrnoException) => reject(this.processError(error)));
            }).catch(reject);
        });
    }

    public executeStreaming(args: string[], onLine: (line: string) => void, stdinText?: string): Promise<void> {
        return new Promise((resolve, reject) => {
            this.options.resolver.resolve().then((bin) => {
                const cwd = this.options.getCwd();
                this.options.log(`[SPAWN] ${bin} ${args.join(' ')} (cwd: ${cwd})`);
                const spawnSpec = this.options.resolver.buildSpawn(bin, args);
                const child = this.spawn(spawnSpec.command, spawnSpec.args, cwd);
                this.currentChild = child;
                if (typeof stdinText === 'string') child.stdin?.write(stdinText);
                child.stdin?.end();
                let stdout = '';
                let stderr = '';
                const lines = new OpenCodeLineBuffer();
                child.stdout?.on('data', (data) => {
                    const rawChunk = data.toString('utf8');
                    stdout += rawChunk;
                    for (const line of lines.push(stripAnsi(rawChunk))) onLine(line);
                });
                child.stderr?.on('data', (data) => {
                    stderr += data.toString('utf8');
                });
                child.on('close', (code) => {
                    this.currentChild = undefined;
                    for (const line of lines.flush()) onLine(line);
                    if (code === 0 || stdout) resolve();
                    else reject(stripAnsi(stderr.trim()) || `Process finished with no output (Code: ${code})`);
                });
                child.on('error', (error: NodeJS.ErrnoException) => {
                    this.currentChild = undefined;
                    reject(this.processError(error));
                });
            }).catch(reject);
        });
    }

    public cancelCurrent(): void {
        this.currentChild?.kill();
        this.currentChild = undefined;
    }

    private spawn(command: string, args: string[], cwd: string): cp.ChildProcess {
        const spawn = this.options.spawn || cp.spawn;
        return spawn(command, args, {
            cwd,
            shell: false,
            timeout: 60000,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        });
    }

    private processError(error: NodeJS.ErrnoException): string {
        this.options.log(`[SPAWN_ERR] ${error.message}`);
        return error.code === 'ENOENT' ? MISSING_BINARY_ERROR : error.message;
    }
}
