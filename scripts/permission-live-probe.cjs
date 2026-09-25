// Real isolated OpenCode + deterministic loopback model fixture. No paid model,
// credentials, external network provider, daily service or project under review.
const { createServer } = require('http');
const { spawn } = require('child_process');
const { mkdir, mkdtemp, writeFile, cp } = require('fs/promises');
const { resolve, join } = require('path');
const { randomBytes } = require('crypto');
const assert = require('assert/strict');
const { PermissionReviewService } = require('../out/permissions/PermissionReviewService');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    const supervisor = resolve(__dirname, '../../OpenCodeTaskSupervisor');
    const root = await mkdtemp(join(supervisor, '.lab/permission-'));
    for (const name of ['home', 'config', 'data', 'cache', 'state', 'tmp', 'work']) await mkdir(join(root, name));
    const config = join(root, 'config/opencode'); await mkdir(config);
    for (const name of ['package.json', 'package-lock.json', 'node_modules']) await cp(join(supervisor, name), join(config, name), { recursive: true });
    const directory = join(root, 'work'), fixture = join(directory, 'fixture.txt');
    await writeFile(fixture, 'Read-only permission fixture.\n');
    let fixtureRequests = 0;
    const model = createServer(async (req, res) => {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw || '{}'); fixtureRequests++;
        const hasResult = (body.messages || []).some(m => m.role === 'tool');
        const readTool = (body.tools || []).find(t => t.function?.name === 'read');
        const invoke = readTool && !hasResult;
        const message = invoke ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_fixture', type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ filePath: fixture }) } }] } : { role: 'assistant', content: 'Fixture finished.' };
        const finish_reason = invoke ? 'tool_calls' : 'stop';
        if (body.stream) {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            const delta = invoke ? { ...message, tool_calls: message.tool_calls.map((t, index) => ({ ...t, index })) } : message;
            for (const payload of [
                { id: 'chatcmpl_fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] },
                { id: 'chatcmpl_fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
            ]) res.write(`data: ${JSON.stringify(payload)}\n\n`);
            res.end('data: [DONE]\n\n');
        } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'chatcmpl_fixture', object: 'chat.completion',
            created: 1, model: 'fixture', choices: [{ index: 0, message, finish_reason }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })); }
    });
    await new Promise(r => model.listen(0, '127.0.0.1', r));
    const reservation = createServer(); await new Promise(r => reservation.listen(0, '127.0.0.1', r));
    const port = reservation.address().port; await new Promise(r => reservation.close(r));
    const origin = `http://127.0.0.1:${port}`, password = randomBytes(24).toString('hex');
    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    const env = {};
    for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS']) if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, { HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), OPENCODE_TEST_HOME: join(root, 'home'),
        APPDATA: join(root, 'config'), LOCALAPPDATA: join(root, 'data'), XDG_CONFIG_HOME: join(root, 'config'),
        XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
        TEMP: join(root, 'tmp'), TMP: join(root, 'tmp'), OPENCODE_DB: join(root, 'data/opencode.db'),
        OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
        OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1',
        npm_config_offline: 'true', npm_config_registry: 'http://127.0.0.1:9', OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ enabled_providers: ['permission-fixture'], model: 'permission-fixture/fixture',
            share: 'disabled', permission: 'deny',
            provider: { 'permission-fixture': { npm: '@ai-sdk/openai-compatible', name: 'Local fixed fixture',
                options: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fixture-only' },
                models: { fixture: { name: 'fixture', limit: { context: 32768, output: 1024 } } } } },
            agent: { permission_reviewer: { mode: 'subagent', model: 'permission-fixture/fixture', prompt: 'Read the fixture once.', permission: { '*': 'deny', read: 'ask' } } } }),
    });
    const child = spawn(join(supervisor, '.lab/opencode-v1.18.31/package/bin/opencode.exe'), ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
        { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', c => { output = (output + c).slice(-16000); });
    const call = async (path, method = 'GET', body) => {
        const response = await fetch(origin + path, { method, headers: { authorization, 'content-type': 'application/json', 'x-opencode-directory': directory },
            body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw Error(`Fixture HTTP ${response.status}: ${path}`);
        return response.status === 204 ? null : response.json();
    };
    const until = async predicate => { const end = Date.now() + 30000; while (Date.now() < end) { const result = await predicate(); if (result) return result; await sleep(100); } throw Error('Fixture timed out'); };
    const evidence = { kind: 'real-opencode-permission-local-fixture', paidModelCalls: 0, passed: false, checks: [], serviceExited: false };
    try {
        await until(async () => output.includes(`opencode server listening on ${origin}`));
        const parent = await call('/session', 'POST', { title: 'Permission fixture parent' });
        const start = async title => {
            const session = await call('/session', 'POST', { parentID: parent.id, title, agent: 'permission_reviewer' });
            await call(`/session/${session.id}/prompt_async`, 'POST', { agent: 'permission_reviewer', model: { providerID: 'permission-fixture', modelID: 'fixture' },
                parts: [{ type: 'text', text: 'Read the fixture once and report completion.' }] });
            return session;
        };
        const approved = await start('Approve child'), rejected = await start('Reject child');
        const service = new PermissionReviewService(async () => ({ identity: origin, directory, read: p => call(p), reply: (p, b) => call(p, 'POST', b) }));
        const view = await until(async () => { const v = await service.snapshot(parent.id); return v.requests.filter(r => r.state === 'pending').length === 2 && v; });
        assert.equal(view.requests.length, 2); evidence.checks.push('Parent scope discovers two genuine child ask requests');
        for (const [session, response] of [[approved, 'once'], [rejected, 'reject']]) {
            const card = view.requests.find(r => r.sessionId === session.id); assert.ok(card);
            await service.respond({ scopeSessionId: parent.id, sessionId: card.sessionId, requestId: card.requestId, reviewToken: card.reviewToken, response });
            await until(async () => {
                const messages = await call(`/session/${session.id}/message`);
                const tools = messages.flatMap(m => m.parts).filter(p => p.type === 'tool');
                return tools.length === 1 && tools[0].state.status === (response === 'once' ? 'completed' : 'error');
            });
        }
        evidence.checks.push('Approve continues the same tool; reject produces a tool error; no duplicate dispatch');
        assert.equal((await service.snapshot(parent.id)).requests.length, 0);
        const cancelled = await start('Cancel child');
        await until(async () => (await service.snapshot(parent.id)).requests.some(r => r.sessionId === cancelled.id && r.state === 'pending'));
        await call(`/session/${cancelled.id}/abort`, 'POST');
        const final = await until(async () => {
            const messages = await call(`/session/${cancelled.id}/message`);
            const tools = messages.flatMap(m => m.parts).filter(p => p.type === 'tool');
            if (tools.some(p => ['pending', 'running'].includes(p.state.status))) return false;
            const snapshot = await service.snapshot(parent.id);
            return snapshot.requests.every(r => r.state !== 'pending') && snapshot;
        });
        evidence.checks.push('Cancelled tool has no actionable permission; residual requests are expired');
        evidence.residualRequests = final.requests.length; evidence.localFixtureRequests = fixtureRequests; evidence.passed = true;
    } catch (error) { evidence.error = String(error); process.exitCode = 1; }
    finally {
        child.kill(); await Promise.race([new Promise(r => child.once('exit', r)), sleep(5000)]);
        evidence.serviceExited = child.exitCode !== null || child.signalCode !== null; model.closeAllConnections(); await new Promise(r => model.close(r));
        await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
        if (!evidence.passed) await writeFile(join(root, 'service-output.txt'), output);
        console.log(JSON.stringify({ root, ...evidence }));
    }
})().catch(error => { console.error(String(error)); process.exitCode = 1; });
