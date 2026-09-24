import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { isAbsolute, join } from 'path';

export interface ServiceProcessIdentity { serviceId: string; pid: number; creationFileTime: string }
export type ServiceProcessObservation = { state: 'running' | 'root_exited_members_active' | 'stopped' | 'stop_unknown'; rootExited: boolean; activeProcesses: number; listenerOwned?: boolean };
export class ServiceOperationError extends Error {
    constructor(readonly reason: string) { super(`OpenCode service operation: ${reason}`); }
}
type Frame = Record<string, unknown>;
async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ServiceOperationError('native_timeout')), milliseconds);
    })]); } finally { if (timer) clearTimeout(timer); }
}

/** Short-lived OS primitive adapter, composed exclusively by the existing process owner. */
export class WindowsServiceJob {
    constructor(private readonly executable: string) {}

    private open(request: object, env?: NodeJS.ProcessEnv) {
        const child: ChildProcessWithoutNullStreams = spawn(this.executable, [], {
            windowsHide: true, stdio: 'pipe', env: env ?? process.env,
        });
        let buffer = '';
        let terminal = false;
        const frames: Frame[] = [];
        const waiting: Array<{ resolve(frame: Frame): void; reject(error: Error): void }> = [];
        const fail = () => {
            terminal = true;
            for (const item of waiting.splice(0)) item.reject(new ServiceOperationError('native_protocol_unavailable'));
        };
        child.stdout.on('data', (chunk: Buffer) => {
            buffer += chunk.toString('utf8');
            if (buffer.length > 8192) { fail(); child.stdin.end(); return; }
            while (buffer.includes('\n')) {
                const index = buffer.indexOf('\n');
                const text = buffer.slice(0, index); buffer = buffer.slice(index + 1);
                try {
                    const frame: unknown = JSON.parse(text);
                    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error();
                    const next = waiting.shift();
                    if (next) next.resolve(frame as Frame);
                    else if (frames.length < 4) frames.push(frame as Frame);
                    else throw new Error();
                } catch { fail(); child.stdin.end(); }
            }
        });
        // Native diagnostics are fixed classifications; never relay raw stderr or request fields.
        child.stderr.resume();
        child.on('error', fail);
        child.stdin.on('error', fail);
        const exited = new Promise<void>(resolve => child.once('close', () => { fail(); resolve(); }));
        const next = (timeoutMs: number): Promise<Frame> => {
            const frame = frames.shift();
            if (frame) return Promise.resolve(frame);
            if (terminal) return Promise.reject(new ServiceOperationError('native_protocol_unavailable'));
            return new Promise((resolve, reject) => {
                const item = { resolve: (value: Frame) => { clearTimeout(timer); resolve(value); },
                    reject: (error: Error) => { clearTimeout(timer); reject(error); } };
                const timer = setTimeout(() => {
                    const i = waiting.indexOf(item); if (i >= 0) waiting.splice(i, 1);
                    reject(new ServiceOperationError('native_timeout'));
                }, timeoutMs);
                waiting.push(item);
            });
        };
        child.stdin.write(JSON.stringify(request) + '\n');
        return { next, exited, end: () => child.stdin.end(),
            send: (value: object) => child.stdin.write(JSON.stringify(value) + '\n') };
    }

    private accept(frame: Frame): Frame {
        if (frame.ok !== true) throw new ServiceOperationError(frame.error === 'operation_busy' ? 'operation_busy' : 'ownership_or_os_failure');
        return frame;
    }

    async acquire(workspaceKey: string): Promise<() => Promise<void>> {
        if (!/^[a-f0-9]{64}$/.test(workspaceKey)) throw new ServiceOperationError('invalid_workspace_key');
        const helper = this.open({ op: 'lock', workspaceKey });
        try {
            if (this.accept(await helper.next(4000)).stage !== 'locked') throw new ServiceOperationError('invalid_lock_reply');
            let released = false;
            return async () => { if (released) return; released = true; helper.send({ op: 'release' }); helper.end(); await bounded(helper.exited, 2000); };
        } catch (error) { helper.end(); throw error; }
    }

    async start(request: { serviceId: string; executable: string; args: string[]; cwd: string },
        env: NodeJS.ProcessEnv, register: (identity: ServiceProcessIdentity) => Promise<void>): Promise<ServiceProcessIdentity> {
        if (!/^[a-f0-9]{64}$/.test(request.serviceId)) throw new ServiceOperationError('invalid_service_id');
        const executable = request.executable.toLowerCase() === 'cmd.exe'
            ? join(env.SystemRoot || process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe') : request.executable;
        if (!isAbsolute(executable)) throw new ServiceOperationError('absolute_executable_required');
        const helper = this.open({ ...request, executable, op: 'start' }, env);
        try {
            const prepared = this.accept(await helper.next(5000));
            const identity = validateProcessIdentity(prepared);
            if (prepared.stage !== 'prepared' || identity.serviceId !== request.serviceId) throw new ServiceOperationError('invalid_start_reply');
            // Persistence precedes commit. Closing stdin instead of killing the helper
            // lets its finally/watchdog stop a suspended, uncommitted Job.
            await bounded(register(identity), 2000);
            helper.send({ op: 'commit', serviceId: identity.serviceId });
            const running = this.accept(await helper.next(5000));
            if (running.stage !== 'running' || JSON.stringify(validateProcessIdentity(running)) !== JSON.stringify(identity)) {
                throw new ServiceOperationError('invalid_commit_reply');
            }
            return identity;
        } finally { helper.end(); }
    }

    async inspect(identity: ServiceProcessIdentity, stop = false, port?: number): Promise<ServiceProcessObservation> {
        if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new ServiceOperationError('invalid_port');
        const helper = this.open({ ...validateProcessIdentity(identity), op: stop ? 'stop' : 'inspect', ...(port === undefined ? {} : { port }) });
        try {
            const frame = this.accept(await helper.next(stop ? 7000 : 3000));
            if (!['running', 'root_exited_members_active', 'stopped', 'stop_unknown'].includes(String(frame.state)) ||
                typeof frame.rootExited !== 'boolean' || !Number.isInteger(frame.activeProcesses) || Number(frame.activeProcesses) < 0 ||
                (frame.state === 'stopped' && (!frame.rootExited || frame.activeProcesses !== 0))) {
                throw new ServiceOperationError('invalid_observation');
            }
            return { state: frame.state as ServiceProcessObservation['state'], rootExited: frame.rootExited, activeProcesses: Number(frame.activeProcesses), ...(typeof frame.listenerOwned === 'boolean' ? { listenerOwned: frame.listenerOwned } : {}) };
        } finally { helper.end(); }
    }
}

export function validateProcessIdentity(value: unknown): ServiceProcessIdentity {
    const v = value as Partial<ServiceProcessIdentity> | undefined;
    if (!v || typeof v.serviceId !== 'string' || !/^[a-f0-9]{64}$/.test(v.serviceId) ||
        !Number.isInteger(v.pid) || Number(v.pid) < 1 || Number(v.pid) > 0xffffffff ||
        typeof v.creationFileTime !== 'string' || !/^[1-9][0-9]{1,19}$/.test(v.creationFileTime)) {
        throw new ServiceOperationError('invalid_process_identity');
    }
    return { serviceId: v.serviceId, pid: v.pid!, creationFileTime: v.creationFileTime };
}
