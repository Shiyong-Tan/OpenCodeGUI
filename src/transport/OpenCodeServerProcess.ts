import * as cp from 'child_process';

export type ServerSpawnSpec = Readonly<{ command: string; args: string[] }>;

export class OpenCodeServerProcess {
    private child?: cp.ChildProcess;
    private rememberedPid?: number;

    constructor(private readonly options: {
        spawn?: typeof cp.spawn;
        exec?: typeof cp.exec;
        processKill?: typeof process.kill;
        platform?: NodeJS.Platform;
    } = {}) {}

    public start(spec: ServerSpawnSpec, cwd: string, password: string): number | undefined {
        const spawn = this.options.spawn || cp.spawn;
        this.child = spawn(spec.command, spec.args, {
            cwd,
            shell: false,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8', OPENCODE_SERVER_PASSWORD: password },
        });
        this.rememberedPid = this.child.pid;
        return this.rememberedPid;
    }

    public getPid(): number | undefined {
        return this.child?.pid || this.rememberedPid;
    }

    public detach(): void {
        this.child = undefined;
        this.rememberedPid = undefined;
    }

    public clearRememberedPid(): void {
        this.rememberedPid = undefined;
    }

    public async shutdown(): Promise<void> {
        const pid = this.getPid();
        if (pid) await this.killProcessTree(pid);
        this.detach();
    }

    private async killProcessTree(pid: number): Promise<void> {
        const platform = this.options.platform || process.platform;
        if (platform === 'win32') {
            await new Promise<void>((resolve) => {
                const attemptKill = () => {
                    const exec = this.options.exec || cp.exec;
                    exec(`taskkill /PID ${pid} /T /F`, async (_error, stdout, stderr) => {
                        const output = `${String(stdout || '')}\n${String(stderr || '')}`;
                        if (/SUCCESS/i.test(output) || !(await this.isProcessRunningWindows(pid))) {
                            resolve();
                            return;
                        }
                        setTimeout(attemptKill, 500);
                    });
                };
                attemptKill();
            });
            return;
        }
        try {
            const processKill = this.options.processKill || process.kill;
            processKill(pid, 'SIGTERM');
        } catch {
            // The process has already exited.
        }
    }

    private async isProcessRunningWindows(pid: number): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            const exec = this.options.exec || cp.exec;
            exec(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, (error, stdout, stderr) => {
                const output = `${String(stdout || '')}\n${String(stderr || '')}`;
                if (error && /No tasks are running|没有运行的任务|找不到/i.test(output)) {
                    resolve(false);
                    return;
                }
                if (/No tasks are running|没有运行的任务|找不到/i.test(output)) {
                    resolve(false);
                    return;
                }
                resolve(new RegExp(`\\b${pid}\\b`).test(output));
            });
        });
    }
}
