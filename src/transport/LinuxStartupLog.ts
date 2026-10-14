import { spawn, execFile } from 'child_process';
import { constants } from 'fs';
import { mkdir, open, unlink } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';

/** Kernel pipe goes straight from service to independent drainer, never through the GUI. */
export async function createLinuxStartupLog(directory: string, serviceId: string, env: NodeJS.ProcessEnv) {
    if (!/^[a-f0-9]{64}$/.test(serviceId)) throw new Error('Invalid startup log identity');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const fifo = join(directory, `${serviceId}.startup.pipe`), file = join(directory, `${serviceId}.startup.log`);
    await promisify(execFile)('mkfifo', ['-m', '600', fifo], { timeout: 2000 });
    const boot = await open(fifo, constants.O_RDWR | constants.O_NONBLOCK);
    const drainer = spawn(process.execPath, [join(__dirname, 'LinuxStartupHost.js'), fifo, file], {
        detached: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    });
    try {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Startup log drainer timed out')), 5000);
            const fail = () => { clearTimeout(timer); reject(new Error('Startup log drainer unavailable')); };
            drainer.once('error', fail); drainer.once('close', fail);
            drainer.stdout.once('data', data => {
                clearTimeout(timer); if (data.toString() !== 'ready\n') { fail(); return; }
                drainer.removeListener('error', fail); drainer.removeListener('close', fail); resolve();
            });
        });
        const writer = await open(fifo, constants.O_WRONLY);
        await boot.close(); drainer.stdout.destroy(); drainer.unref();
        return { fd: writer.fd, file, close: () => writer.close() };
    } catch (error) {
        await boot.close(); drainer.kill('SIGTERM'); await unlink(fifo).catch(() => undefined); throw error;
    }
}
