import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { probeProtocol } = require('../out/transport/protocol/ProtocolNegotiator.js');
const binary = process.argv[2];
if (!binary || !isAbsolute(binary) || !(await stat(binary)).isFile()) {
    throw new Error('Supply an absolute native OpenCode executable path after compiling the extension.');
}
const root = await mkdtemp(join(tmpdir(), 'opencode-protocol-probe-'));
for (const name of ['workspace', 'home', 'config', 'data', 'cache', 'state', 'tmp']) await mkdir(join(root, name));
const config = join(root, 'config', 'opencode'); await mkdir(config);
await writeFile(join(config, 'opencode.json'), '{}');
const env = { ...process.env };
for (const name of Object.keys(env)) {
    if (/^OPENCODE_|TOKEN|SECRET|API_KEY|PASSWORD|CREDENTIAL|^AWS_/i.test(name)) delete env[name];
}
const password = randomBytes(32).toString('hex');
Object.assign(env, { OPENCODE_TEST_HOME: join(root, 'home'), OPENCODE_CONFIG_DIR: config,
    XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'), TMPDIR: join(root, 'tmp'), TEMP: join(root, 'tmp'), TMP: join(root, 'tmp'),
    OPENCODE_SERVER_PASSWORD: password, OPENCODE_DISABLE_AUTOUPDATE: 'true' });
const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
const child = spawn(resolve(binary), ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
    cwd: join(root, 'workspace'), env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '', spawnError;
const capture = bytes => { output = (output + bytes.toString()).slice(-16384); };
child.stdout.on('data', capture); child.stderr.on('data', capture);
child.once('error', error => { spawnError = error; });
const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
try {
    const deadline = Date.now() + 20000;
    let identity;
    while (Date.now() < deadline && child.exitCode === null && !spawnError) {
        const announced = output.match(/server password ([^\s]+)/)?.[1];
        try {
            identity = await probeProtocol({ baseUrl: `http://127.0.0.1:${port}`,
                authorization: `Basic ${Buffer.from(`opencode:${announced ?? password}`).toString('base64')}`,
                isCurrent: () => child.exitCode === null && !spawnError });
            break;
        } catch { /* Only this new fixture is retried; no model or mutation is sent. */ }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!identity) throw new Error('Isolated fixture identity was not verified; startup output is intentionally withheld to protect credentials.');
    console.log(JSON.stringify({ verified: true, identity, isolatedProfile: root, modelCalls: 0, mutations: 0 }));
} finally {
    if (child.exitCode === null && !spawnError) child.kill();
    await exited;
}
