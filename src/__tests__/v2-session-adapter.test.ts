import { V2SessionAdapter } from '../transport/protocol/V2SessionAdapter';
import { V2Transport } from '../transport/protocol/V2Transport';
import { toolIdentity } from '../transport/protocol/V2Codec';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const nativeSession = (id = 'ses_A') => ({ id, title: 'Fixture', time: { created: 1, updated: 2 }, location: { directory: '/fixture' } });
const pending = (id = 'msg_input', sessionID = 'ses_A') => ({ id, sessionID, type: 'user', delivery: 'queue', payload: { text: 'fixture' }, time: { created: 1 } });
function harness() {
    let current = true;
    const fetcher = jest.fn();
    const transport = new V2Transport({ baseUrl: 'http://127.0.0.1:42000', directory: '/fixture',
        authorization: 'Basic fixture', isCurrent: () => current }, fetcher);
    return { api: new V2SessionAdapter(transport), transport, fetcher, replace: () => { current = false; } };
}
const call = (f: ReturnType<typeof harness>, index = 0) => {
    const [raw, init] = f.fetcher.mock.calls[index] as [URL, RequestInit];
    return { url: raw, method: init.method, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined };
};

test('session reads unwrap data, preserve identity and accept new optional fields', async () => {
    const f = harness(); f.fetcher.mockResolvedValueOnce(json({ data: { ...nativeSession(), future: true } }));
    expect(await f.api.getSession('ses_A')).toMatchObject({ id: 'ses_A', createdAt: 1, native: { future: true } });
    expect(call(f).url.pathname).toBe('/api/session/ses_A');
    f.fetcher.mockResolvedValueOnce(json({ data: nativeSession('ses_B') }));
    await expect(f.api.getSession('ses_A')).rejects.toMatchObject({ reason: 'invalid_response' });
});

test('session list honors explicit directory and cursor without inferring a whole history', async () => {
    const f = harness(); f.fetcher.mockResolvedValueOnce(json({ data: [nativeSession()], cursor: { next: 'opaque', previous: null } }));
    const page = await f.api.listSessions({ limit: 100 });
    expect(page.items).toHaveLength(1); expect(page.next).toBe('opaque');
    expect(call(f).url.searchParams.get('directory')).toBe('/fixture');
    expect(call(f).url.searchParams.get('order')).toBe('desc');
    f.fetcher.mockResolvedValueOnce(json({ data: [], cursor: {} }));
    await f.api.listSessions({ cursor: page.next });
    expect(call(f, 1).url.searchParams.has('order')).toBe(false);
    expect(call(f, 1).url.searchParams.get('cursor')).toBe('opaque');
});

test.each(['g:\\MRI_Project', 'g:/MRI_Project', 'G:\\MRI_Project', '/mnt/g/MRI_Project', '//server/Share/MRI_Project'])(
    'session list normalizes only a Windows drive letter across pages: %s', async directory => {
        const fetcher = jest.fn(async () => json({ data: [nativeSession()], cursor: { next: 'next', previous: null } }));
        const transport = new V2Transport({ baseUrl: 'http://127.0.0.1:42000', directory,
            authorization: 'Basic fixture', isCurrent: () => true }, fetcher);
        const api = new V2SessionAdapter(transport);
        const page = await api.listSessions({ limit: 100 });
        await api.listSessions({ limit: 100, cursor: page.next });
        for (const args of fetcher.mock.calls as unknown as [URL, RequestInit][]) {
            expect(args[0].searchParams.get('directory')).toBe(directory.replace(/^g:/, 'G:'));
            expect(args[0].searchParams.get('limit')).toBe('100');
        }
        expect(transport.connection.directory).toBe(directory);
        expect((fetcher.mock.calls as unknown as [URL, RequestInit][])[1][0].searchParams.get('cursor')).toBe('next');
    });

test('new child creation includes the captured location and verifies returned parent', async () => {
    const f = harness(); f.fetcher.mockResolvedValueOnce(json({ data: { ...nativeSession('ses_child'), parentID: 'ses_A' } }));
    expect((await f.api.createSession({ parentId: 'ses_A', title: 'Review' })).parentId).toBe('ses_A');
    expect(call(f).body).toEqual({ location: { directory: '/fixture' }, parentID: 'ses_A', title: 'Review' });
    f.fetcher.mockResolvedValueOnce(json({ data: { ...nativeSession('ses_child'), parentID: 'ses_foreign' } }));
    await expect(f.api.createSession({ parentId: 'ses_A' })).rejects.toMatchObject({ reason: 'ambiguous' });
});

test('admission preserves stable inbox identity, explicit queue mode and attachments without claiming finality', async () => {
    const f = harness(); f.fetcher.mockResolvedValueOnce(json({ data: pending() }));
    const item = await f.api.admit('ses_A', { id: 'msg_input', text: 'Do this later', delivery: 'queue',
        resume: false, files: [{ uri: 'file:///fixture/image.png', name: 'image.png' }] });
    expect(item).toMatchObject({ id: 'msg_input', sessionId: 'ses_A', delivery: 'queue' });
    expect(item).not.toHaveProperty('completed');
    expect(call(f).body).toEqual({ id: 'msg_input', text: 'Do this later', delivery: 'queue', resume: false,
        files: [{ uri: 'file:///fixture/image.png', name: 'image.png' }] });
    expect(call(f).url.pathname).toBe('/api/session/ses_A/prompt');
});

test('steering patches the same pending input once and never resends its prompt', async () => {
    const f = harness(); f.fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await f.api.changeDelivery('ses_A', 'msg_input', 'steer');
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(call(f).method).toBe('PATCH'); expect(call(f).url.pathname).toBe('/api/session/ses_A/inbox/msg_input');
    expect(call(f).body).toEqual({ delivery: 'steer' });
});

test('a server ignoring queue delivery cannot be shown as a queued success', async () => {
    const f = harness(); f.fetcher.mockResolvedValueOnce(json({ data: { ...pending(), delivery: 'steer' } }));
    await expect(f.api.admit('ses_A', { id: 'msg_input', text: 'x', delivery: 'queue' })).rejects.toMatchObject({ reason: 'ambiguous' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
});

test('a delivered-item conflict is surfaced rather than retried or turned into a new prompt', async () => {
    const f = harness(); f.fetcher.mockResolvedValueOnce(json({}, 409));
    await expect(f.api.changeDelivery('ses_A', 'msg_input', 'steer')).rejects.toMatchObject({ reason: 'conflict' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
});

test('interruption is separate from clearing queued input and does not resume execution', async () => {
    const f = harness(); f.fetcher.mockResolvedValueOnce(json({ interrupted: true }));
    expect(await f.api.interrupt('ses_A')).toEqual({ interrupted: true });
    expect(call(f).url.pathname).toBe('/api/session/ses_A/interrupt');
    expect(call(f).url.searchParams.get('resume')).toBe('false');
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    f.fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await f.api.cancelQueued('ses_A', 'msg_input'); expect(call(f, 1).method).toBe('DELETE');
    expect(call(f, 1).url.pathname).toBe('/api/session/ses_A/inbox/msg_input');
});

test('inbox reads reject foreign owner IDs instead of assigning them to the selected session', async () => {
    const f = harness(); f.fetcher.mockResolvedValueOnce(json({ data: [pending('msg_other', 'ses_B')] }));
    await expect(f.api.inbox('ses_A')).rejects.toMatchObject({ reason: 'invalid_response' });
});

test('parallel tools retain session/message/call identities and no tool result becomes an execution final', async () => {
    const f = harness();
    const assistant = { id: 'msg_assistant', type: 'assistant', time: { created: 1, completed: 5 },
        content: [{ type: 'tool', id: 'same', name: 'read', state: { status: 'completed' } },
            { type: 'tool', id: 'other', name: 'shell', state: { status: 'running' } }] };
    f.fetcher.mockResolvedValueOnce(json({ data: [assistant, { ...assistant, id: 'msg_next' },
        { id: 'msg_idle', type: 'idle', time: { created: 6 }, outcome: 'succeeded' },
        { id: 'msg_future', type: 'future-control', time: { created: 7 }, future: true }], cursor: {} }));
    const page = await f.api.messages('ses_A');
    expect(page.items[0].tools.map(tool => tool.status)).toEqual(['completed', 'running']);
    expect(page.items[0].outcome).toBeUndefined(); expect(page.items[2].outcome).toBe('succeeded');
    expect(page.items[3].kind).toBe('future-control'); expect(page.items[3].outcome).toBeUndefined();
    expect(toolIdentity(page.items[0].tools[0])).not.toBe(toolIdentity(page.items[1].tools[0]));
    expect(toolIdentity(page.items[0].tools[0])).not.toBe(toolIdentity({ ...page.items[0].tools[0], sessionId: 'ses_B' }));
});

test('message pagination never combines an opaque cursor with an order override', async () => {
    const f = harness(); f.fetcher.mockResolvedValueOnce(json({ data: [], cursor: {} }));
    await f.api.messages('ses_A', { cursor: 'keep/opaque?cursor' });
    expect(call(f).url.searchParams.get('cursor')).toBe('keep/opaque?cursor');
    expect(call(f).url.searchParams.has('order')).toBe(false);
    await expect(f.api.messages('ses_A', { limit: 201 })).rejects.toMatchObject({ reason: 'rejected' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
});

test.each([401, 403, 404, 405, 500])('HTTP %s never causes endpoint fallback or mutation replay', async status => {
    const f = harness(); f.fetcher.mockResolvedValueOnce(json({}, status));
    await expect(f.api.admit('ses_A', { id: 'msg_input', text: 'x', delivery: 'queue' })).rejects.toMatchObject({
        reason: status >= 500 ? 'ambiguous' : status === 401 || status === 403 ? 'authentication' : 'unsupported' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
});

test('network failure or malformed admission response is ambiguous and never replayed', async () => {
    for (const kind of ['network', 'invalid', 'foreign', 'no-content']) {
        const f = harness();
        if (kind === 'network') f.fetcher.mockRejectedValueOnce(new Error('disconnected after sending'));
        else f.fetcher.mockResolvedValueOnce(kind === 'no-content' ? new Response(null, { status: 204 }) :
            json(kind === 'foreign' ? { data: pending('msg_input', 'ses_B') } : { unexpected: true }));
        await expect(f.api.admit('ses_A', { id: 'msg_input', text: 'x', delivery: 'queue' })).rejects.toMatchObject({ reason: 'ambiguous' });
        expect(f.fetcher).toHaveBeenCalledTimes(1);
    }
});

test('a replaced service cannot publish a read result or silently retry a submitted mutation', async () => {
    for (const mutation of [false, true]) {
        const f = harness(); f.fetcher.mockImplementationOnce(async () => { f.replace(); return json({ data: pending() }); });
        const request = mutation ? f.api.admit('ses_A', { id: 'msg_input', text: 'x', delivery: 'queue' }) : f.api.getSession('ses_A');
        await expect(request).rejects.toMatchObject({ reason: mutation ? 'ambiguous' : 'superseded' });
        expect(f.fetcher).toHaveBeenCalledTimes(1);
    }
});

test('HTTP 200 HTML and unknown tool terminal states cannot become valid history', async () => {
    const f = harness(); f.fetcher.mockResolvedValueOnce(new Response('<html>app</html>'));
    await expect(f.api.getSession('ses_A')).rejects.toMatchObject({ reason: 'invalid_response' });
    f.fetcher.mockResolvedValueOnce(json({ data: [{ id: 'msg_a', type: 'assistant', time: { created: 1 },
        content: [{ type: 'tool', id: 'c', name: 'shell', state: { status: 'future-state' } }] }], cursor: {} }));
    await expect(f.api.messages('ses_A')).rejects.toMatchObject({ reason: 'invalid_response' });
});

test('duplicate tool identities in one assistant fail instead of overwriting a parallel call', async () => {
    const f = harness(), item = { type: 'tool', id: 'duplicate', name: 'read', state: { status: 'running' } };
    f.fetcher.mockResolvedValueOnce(json({ data: [{ id: 'msg_a', type: 'assistant', time: { created: 1 }, content: [item, item] }], cursor: {} }));
    await expect(f.api.messages('ses_A')).rejects.toMatchObject({ reason: 'invalid_response' });
});

test('path traversal and a superseded binding cannot issue a request', async () => {
    const f = harness();
    await expect(f.transport.request('POST', '/api/../global/config', {})).rejects.toMatchObject({ reason: 'rejected' });
    f.replace();
    await expect(f.api.admit('ses_A', { id: 'msg_a', text: 'x', delivery: 'queue' })).rejects.toMatchObject({ reason: 'superseded' });
    expect(f.fetcher).not.toHaveBeenCalled();
});

test('a mutation deadline has an unknown outcome, with no replay', async () => {
    jest.useFakeTimers();
    try {
        const f = harness();
        f.fetcher.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('deadline')));
        }));
        const failure = expect(f.api.changeDelivery('ses_A', 'msg_input', 'steer')).rejects.toMatchObject({ reason: 'ambiguous' });
        await jest.advanceTimersByTimeAsync(15000); await failure;
        expect(f.fetcher).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
});
