import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { probeProtocol } = require('../out/transport/protocol/ProtocolNegotiator.js');
const { V2Transport } = require('../out/transport/protocol/V2Transport.js');
const { V2SessionAdapter } = require('../out/transport/protocol/V2SessionAdapter.js');
const { V2ControlAdapter } = require('../out/transport/protocol/V2ControlAdapter.js');
const { V2InteractionAdapter } = require('../out/transport/protocol/V2InteractionAdapter.js');
const { V2Backend } = require('../out/transport/protocol/V2Backend.js');
const { PermissionReviewService } = require('../out/permissions/PermissionReviewService.js');
const { decodeV2Event } = require('../out/transport/protocol/V2EventAdapter.js');
const { SseDataLineBuffer } = require('../out/transport/OpenCodeEventStream.js');
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
    let fixtureMutations = 0;
    if (process.argv.includes('--session-contract')) {
        if (identity.family !== 'v2') throw new Error('Session contract fixture requires the V2 adapter.');
        const announced = output.match(/server password ([^\s]+)/)?.[1];
        const transport = new V2Transport({ baseUrl: `http://127.0.0.1:${port}`, directory: join(root, 'workspace'),
            authorization: `Basic ${Buffer.from(`opencode:${announced ?? password}`).toString('base64')}`,
            isCurrent: () => child.exitCode === null && !spawnError });
        const api = new V2SessionAdapter(transport);
        const controls = new V2ControlAdapter(transport), interactions = new V2InteractionAdapter(transport);
        const events = [], stream = new AbortController();
        const response = await fetch(`http://127.0.0.1:${port}/api/event`, {
            headers: { Authorization: transport.connection.authorization, Accept: 'text/event-stream' }, signal: stream.signal });
        if (!response.ok || !response.body) throw new Error('Fixture event stream unavailable');
        const reader = response.body.getReader();
        const pump = (async () => {
            const lines = new SseDataLineBuffer(), decoder = new TextDecoder();
            try {
                while (true) {
                    const next = await reader.read(); if (next.done) break;
                    for (const payload of lines.push(decoder.decode(next.value, { stream: true }))) events.push(decodeV2Event(JSON.parse(payload)));
                }
            } catch (error) { if (!stream.signal.aborted) throw error; }
            finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
        })();
        // Attach immediately so a malformed frame cannot become an unhandled rejection.
        void pump.catch(() => undefined);
        let session;
        try {
            session = await api.createSession({ title: 'Isolated protocol fixture' }); fixtureMutations++;
            if ((await api.getSession(session.id)).id !== session.id) throw new Error('Fixture session identity mismatch');
            if (!(await api.listSessions({ limit: 100 })).items.some(item => item.id === session.id)) throw new Error('Fixture not in its workspace');
            if ((await api.messages(session.id)).items.length || (await api.inbox(session.id)).length) throw new Error('Unexpected fixture work');
            await controls.models(); await controls.agents(); await controls.active();
            if ((await interactions.permissions(session.id)).length || (await interactions.forms(session.id)).length) throw new Error('Unexpected fixture interaction');
            await controls.rename(session.id, 'Renamed isolated fixture'); fixtureMutations++;
            if ((await api.getSession(session.id)).title !== 'Renamed isolated fixture') throw new Error('Fixture rename failed');
            // Form creation is local durable interaction data; no prompt/model is sent.
            const created = await transport.request('POST', `/api/session/${session.id}/form`, {
                id: 'frm_isolatedFixture', title: 'Isolated form fixture', fields: [
                    { key: 'choice', type: 'string', required: true, options: [{ value: 'internal', label: 'Visible label' }] },
                ],
            }); fixtureMutations++;
            const formId = created?.data?.id;
            if (typeof formId !== 'string') throw new Error('Fixture form identity missing');
            try {
                if (!(await interactions.forms(session.id)).some(item => item.id === formId)) throw new Error('Fixture pending form missing');
                if (!(await interactions.forms()).some(item => item.id === formId)) throw new Error('Fixture location-wide form missing');
                const backend = new V2Backend(transport);
                const review = new PermissionReviewService(async () => ({ identity: 'isolated-fixture', directory: transport.connection.directory,
                    read: async () => { throw new Error('Unexpected V1 request'); }, reply: async () => { throw new Error('Unexpected V1 reply'); },
                    native: { session: id => backend.sessionInfo(id),
                        requests: async () => (await interactions.forms()).map(form => ({ id: form.id, sessionID: form.sessionId, nativeForm: form })),
                        message: async () => { throw new Error('Form does not require a legacy tool lookup'); }, respond: async () => {} } }), 'question');
                const reviewed = await review.snapshot(session.id);
                if (!reviewed.requests.some(card => card.requestId === formId && card.state === 'pending' && card.reviewToken && card.nativeForm))
                    throw new Error('Fixture form did not reach the production question review owner');
                await interactions.replyForm(session.id, formId, { choice: 'internal' }); fixtureMutations++;
                const answered = await interactions.getForm(session.id, formId);
                if (answered.state?.status !== 'answered' || answered.state?.answer?.choice !== 'internal') throw new Error('Fixture typed form response mismatch');
            } finally {
                const state = await interactions.getForm(session.id, formId);
                if (state.state?.status === 'pending') { await interactions.cancelForm(session.id, formId); fixtureMutations++; }
            }
            const eventDeadline = Date.now() + 2000;
            while (!events.some(event => event.type === 'session.created' && event.sessionId === session.id) && Date.now() < eventDeadline)
                await new Promise(resolve => setTimeout(resolve, 20));
            if (!events.some(event => event.type === 'session.created' && event.sessionId === session.id)) throw new Error('Fixture creation event was not observed');
        } finally {
            stream.abort();
            try { await pump; }
            finally { if (session) { await transport.request('DELETE', `/api/session/${session.id}`); fixtureMutations++; } }
        }
    }
    console.log(JSON.stringify({ verified: true, identity, isolatedProfile: root, modelCalls: 0, fixtureMutations }));
} finally {
    if (child.exitCode === null && !spawnError) child.kill();
    await exited;
}
