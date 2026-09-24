import * as cp from 'child_process';
import { WindowsServiceJob, ServiceOperationError, type ServiceProcessIdentity } from './WindowsServiceJob';

export type ServerSpawnSpec = Readonly<{ command: string; args: string[]; supervisorBinding?: string }>;

export class OpenCodeServerProcess {
    private child?: cp.ChildProcess;
    private rememberedPid?: number;
    private ownedIdentity?: ServiceProcessIdentity;

    constructor(private readonly options: {
        spawn?: typeof cp.spawn;
        exec?: typeof cp.exec;
        processKill?: typeof process.kill;
        platform?: NodeJS.Platform;
        windowsJob?: WindowsServiceJob;
    } = {}) {}

    public start(spec: ServerSpawnSpec, cwd: string, password: string): number | undefined {
        const spawn = this.options.spawn || cp.spawn;
        this.child = spawn(spec.command, spec.args, {
            cwd,
            shell: false,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8', OPENCODE_SERVER_PASSWORD: password,
                // Never inherit another GUI/service launch binding from the host environment.
                OPENCODE_GUI_SUPERVISOR_BINDING: spec.supervisorBinding },
        });
        this.rememberedPid = this.child.pid;
        return this.rememberedPid;
    }

    public async startOwned(spec: ServerSpawnSpec, cwd: string, password: string, serviceId: string,
        register: (identity: ServiceProcessIdentity) => Promise<void>): Promise<number> {
        if (!this.options.windowsJob) throw new ServiceOperationError('native_owner_unavailable');
        this.ownedIdentity = await this.options.windowsJob.start({ serviceId, executable: spec.command, args: spec.args, cwd },
            { ...process.env, PYTHONIOENCODING: 'utf-8', OPENCODE_SERVER_PASSWORD: password,
                OPENCODE_GUI_SUPERVISOR_BINDING: spec.supervisorBinding }, register);
        return this.ownedIdentity.pid;
    }

    public async inspectOwned(identity: ServiceProcessIdentity, stop = false) {
        if (!this.options.windowsJob) throw new ServiceOperationError('native_owner_unavailable');
        return this.options.windowsJob.inspect(identity, stop);
    }

    public async acquireOperation(workspaceKey: string): Promise<() => Promise<void>> {
        if (!this.options.windowsJob) throw new ServiceOperationError('native_owner_unavailable');
        return this.options.windowsJob.acquire(workspaceKey);
    }

    public getPid(): number | undefined {
        return this.ownedIdentity?.pid || this.child?.pid || this.rememberedPid;
    }

    public detach(): void {
        this.ownedIdentity = undefined;
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
        if (platform === 'win32') throw new ServiceOperationError('explicit_verified_operation_required');
        try {
            const processKill = this.options.processKill || process.kill;
            processKill(pid, 'SIGTERM');
        } catch {
            // The process has already exited.
        }
    }

}
