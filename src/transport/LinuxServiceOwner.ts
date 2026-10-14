import { spawn } from 'child_process';
import { mkdir, open, readFile, readdir, readlink } from 'fs/promises';
import { join } from 'path';
import { ServiceOperationError, validateProcessIdentity, type ServiceProcessIdentity, type ServiceProcessObservation } from './WindowsServiceJob';

/** Linux process owner: exact birth identity plus GUI marker, never arbitrary PID takeover. */
export class LinuxServiceOwner {
    constructor(private readonly directory: string) {}
    private async stat(pid: number) {
        try {
            const text = await readFile(`/proc/${pid}/stat`, 'utf8');
            const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
            if (fields.length < 20) throw new Error();
            return { start: fields[19], group: Number(fields[2]), alive: fields[0] !== 'Z' && fields[0] !== 'X' };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw new ServiceOperationError('linux_process_identity_unknown');
        }
    }
    async acquire(key: string): Promise<() => Promise<void>> {
        if (!/^[a-f0-9]{64}$/.test(key)) throw new ServiceOperationError('invalid_workspace_key');
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const file = join(this.directory, `operation-${key}.lock`);
        const handle = await open(file, 'a', 0o600); await handle.close();
        // Kernel lock releases on EOF/process exit, including an extension-host crash.
        const lock = spawn('flock', ['-n', file, 'sh', '-c', 'printf "locked\\n"; cat >/dev/null'], { stdio: ['pipe', 'pipe', 'ignore'] });
        const exited = new Promise<void>(resolve => { lock.once('close', () => resolve()); lock.once('error', () => resolve()); });
        lock.stdin.on('error', () => {});
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { lock.stdin.end(); reject(new ServiceOperationError('operation_lock_timeout')); }, 3000);
            const failed = () => { clearTimeout(timer); reject(new ServiceOperationError('operation_busy_or_flock_unavailable')); };
            lock.once('error', failed); lock.once('close', failed);
            lock.stdout.once('data', chunk => {
                clearTimeout(timer);
                if (chunk.toString() !== 'locked\n') { lock.stdin.end(); failed(); return; }
                lock.removeListener('error', failed); lock.removeListener('close', failed); resolve();
            });
        });
        let released = false;
        return async () => { if (released) return; released = true; lock.stdin.end(); await exited; };
    }
    async start(request: { serviceId: string; executable: string; args: string[]; cwd: string }, env: NodeJS.ProcessEnv,
        register: (identity: ServiceProcessIdentity) => Promise<void>): Promise<ServiceProcessIdentity> {
        const child = spawn(request.executable, request.args, { cwd: request.cwd, shell: false, detached: true,
            env: { ...env, OPENCODE_GUI_SERVICE_ID: request.serviceId }, stdio: 'ignore' });
        await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        const born = await this.stat(child.pid!);
        if (!born?.alive || born.group !== child.pid) throw new ServiceOperationError('linux_start_identity_unknown');
        const identity = validateProcessIdentity({ serviceId: request.serviceId, pid: child.pid, creationFileTime: born.start });
        try { await register(identity); }
        catch (error) { child.kill('SIGTERM'); throw error; }
        child.unref();
        return identity;
    }
    async inspect(raw: ServiceProcessIdentity, stop = false, port?: number): Promise<ServiceProcessObservation> {
        const identity = validateProcessIdentity(raw);
        const root = await this.stat(identity.pid);
        if (root && root.start !== identity.creationFileTime) throw new ServiceOperationError('linux_process_identity_mismatch');
        if (root?.alive) {
            const environment = await readFile(`/proc/${identity.pid}/environ`, 'utf8');
            if (!environment.split('\0').includes(`OPENCODE_GUI_SERVICE_ID=${identity.serviceId}`)) throw new ServiceOperationError('linux_process_not_owned');
        }
        let listenerOwned = false;
        if (root?.alive && port !== undefined) {
            const sockets = new Set<string>();
            for (const fd of await readdir(`/proc/${identity.pid}/fd`)) {
                try { const link = await readlink(`/proc/${identity.pid}/fd/${fd}`); const match = /^socket:\[(\d+)\]$/.exec(link); if (match) sockets.add(match[1]!); } catch { /* FDs can close during enumeration. */ }
            }
            for (const name of ['tcp', 'tcp6']) {
                for (const line of (await readFile(`/proc/${identity.pid}/net/${name}`, 'utf8')).trim().split('\n').slice(1)) {
                    const fields = line.trim().split(/\s+/);
                    if (fields[3] === '0A' && parseInt(fields[1]?.split(':')[1] ?? '', 16) === port && sockets.has(fields[9]!)) listenerOwned = true;
                }
            }
        }
        if (stop && root?.alive) {
            if (port !== undefined && !listenerOwned) throw new ServiceOperationError('linux_listener_not_owned');
            const current = await this.stat(identity.pid);
            if (current?.start !== identity.creationFileTime) throw new ServiceOperationError('linux_process_identity_mismatch');
            // Signal only the registered service root; never kill its calculation descendants.
            process.kill(identity.pid, 'SIGTERM');
            for (let i = 0; i < 60; i++) {
                const current = await this.stat(identity.pid);
                if (!current?.alive) break;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        const after = await this.stat(identity.pid);
        let activeProcesses = 0;
        for (const name of await readdir('/proc')) {
            if (!/^\d+$/.test(name)) continue;
            const member = await this.stat(Number(name));
            if (member?.group === identity.pid && member.alive) activeProcesses++;
        }
        const rootExited = !after?.alive;
        const state = activeProcesses === 0 && rootExited ? 'stopped' : rootExited ? 'root_exited_members_active' : 'running';
        return { state, rootExited, activeProcesses, listenerOwned };
    }
}
