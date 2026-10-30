import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { WindowsServiceJob, validateProcessIdentity, type ServiceProcessIdentity } from '../transport/WindowsServiceJob';

test('process identity rejects missing, truncated and reused-address inputs', () => {
    const valid = { serviceId: 'a'.repeat(64), pid: 123, creationFileTime: '133700000000000000' };
    expect(validateProcessIdentity(valid)).toEqual(valid);
    for (const change of [{ serviceId: '../other' }, { pid: 0 }, { pid: 1.5 }, { pid: 0x100000000 },
        { creationFileTime: '0' }, { creationFileTime: 123 }, { creationFileTime: 'NaN' }]) {
        expect(() => validateProcessIdentity({ ...valid, ...change })).toThrow();
    }
});

const windows = process.platform === 'win32' ? test : test.skip;
windows('real Job start registers before execution and survives launcher exit; mismatched identity cannot stop', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-service-job-'));
    const marker = path.join(root, 'started');
    const api = new WindowsServiceJob(path.resolve('out/native/ServiceJob.exe'));
    let identity: ServiceProcessIdentity | undefined;
    try {
        identity = await api.start({ serviceId: randomBytes(32).toString('hex'), executable: process.execPath,
            args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'started');setTimeout(()=>{},15000)`], cwd: root },
        process.env, async record => {
            identity = record;
            await expect(fs.readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
            await fs.writeFile(path.join(root, 'record.json'), JSON.stringify(record));
        });
        expect((await api.inspect(identity)).state).toBe('running');
        await expect(api.inspect({ ...identity, creationFileTime: '1' }, true)).rejects.toThrow();
        await expect(api.inspect({ ...identity, serviceId: 'f'.repeat(64) }, true)).rejects.toThrow();
        expect((await api.inspect(identity)).state).toBe('running');
        expect(await api.inspect(identity, true)).toEqual({ state: 'stopped', rootExited: true, activeProcesses: 0 });
        expect((await api.inspect(identity)).state).toBe('stopped');
    } finally {
        if (identity) await api.inspect(identity, true).catch(() => undefined);
        await fs.rm(root, { recursive: true, force: true });
    }
}, 15000);

windows('real registration failure never resumes the owned process', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-service-register-'));
    const api = new WindowsServiceJob(path.resolve('out/native/ServiceJob.exe'));
    let identity: ServiceProcessIdentity | undefined;
    await expect(api.start({ serviceId: randomBytes(32).toString('hex'), executable: process.execPath,
        args: ['-e', 'setTimeout(()=>{},15000)'], cwd: root }, process.env, async record => {
        identity = record; throw new Error('Private store unavailable');
    })).rejects.toThrow('Private store unavailable');
    try {
        for (let i = 0; i < 20; i++) {
            if ((await api.inspect(identity!)).state === 'stopped') break;
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        expect((await api.inspect(identity!)).state).toBe('stopped');
    } finally {
        if (identity) await api.inspect(identity, true).catch(() => undefined);
        await fs.rm(root, { recursive: true, force: true });
    }
}, 10000);

windows('real operation mutex refuses a competing owner and is reusable after release', async () => {
    const api = new WindowsServiceJob(path.resolve('out/native/ServiceJob.exe'));
    const key = randomBytes(32).toString('hex');
    const release = await api.acquire(key);
    try { await expect(api.acquire(key)).rejects.toMatchObject({ reason: 'operation_busy' }); }
    finally { await release(); }
    const next = await api.acquire(key); await next(); await next();
}, 10000);

windows('missing Job distinguishes a reused system PID from a matching inaccessible identity', async () => {
    // WMI can read creation time even when OpenProcess is denied. Never stop or
    // adopt this unrelated process; both calls below are observation only.
    const script = "$p = Get-CimInstance Win32_Process -Filter \"Name='svchost.exe'\" | Select-Object -First 1; "
        + "if ($null -eq $p) { throw 'No system identity fixture' }; "
        + "@{pid=[int]$p.ProcessId; created=$p.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()} | ConvertTo-Json -Compress";
    const fixture = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', windowsHide: true, timeout: 10000 }));
    const api = new WindowsServiceJob(path.resolve('out/native/ServiceJob.exe'));
    const identity = { serviceId: randomBytes(32).toString('hex'), pid: fixture.pid, creationFileTime: fixture.created };
    await expect(api.inspect(identity)).rejects.toThrow();
    const reused = { ...identity, creationFileTime: (BigInt(fixture.created) - 50_000_000n).toString() };
    expect(await api.inspect(reused)).toEqual({ state: 'stopped', rootExited: true, activeProcesses: 0 });
    await expect(api.inspect(identity)).rejects.toThrow();
}, 20000);
