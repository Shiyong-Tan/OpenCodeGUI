import { createReadStream, closeSync, openSync, writeSync, unlinkSync } from 'fs';
import { StartupRedactor } from './StartupRedactor';

// Independent drainer keeps the service's pipe usable across extension-host reloads.
const [fifo, file] = process.argv.slice(2);
if (!fifo || !file) process.exit(1);
const secrets = Object.entries(process.env).filter(([key, value]) => /PASSWORD|TOKEN|SECRET|KEY|PROXY|SUPERVISOR_BINDING/i.test(key) && value).map(([, value]) => value!);
try {
    const binding = JSON.parse(process.env.OPENCODE_GUI_SUPERVISOR_BINDING || '{}') as Record<string, unknown>;
    for (const key of ['launchKey', 'identityKey', 'authenticationProof']) if (typeof binding[key] === 'string') secrets.push(binding[key] as string);
} catch { /* Missing/malformed binding is itself diagnosed by plugin startup. */ }
const redact = new StartupRedactor(secrets);
const fd = openSync(file, 'wx', 0o600);
let retained = 0;
const deadline = Date.now() + 600000;
function append(text: string) {
    if (Date.now() > deadline || retained >= 65536) return;
    const data = Buffer.from(text).subarray(0, 65536 - retained);
    try { writeSync(fd, data); retained += data.length; }
    catch { retained = 65536; } // Continue draining even when logging fails; do not break the service pipe.
}
append('OpenCode startup output (stdout + stderr); bounded to 64 KiB / 10 minutes.\n');
const input = createReadStream(fifo, { encoding: 'utf8' });
process.stdout.on('error', () => {});
input.once('open', () => process.stdout.write('ready\n'));
input.on('data', chunk => append(redact.push(String(chunk))));
input.on('end', () => { append(redact.flush()); closeSync(fd); try { unlinkSync(fifo); } catch {} });
input.on('error', () => { closeSync(fd); process.exitCode = 1; });
