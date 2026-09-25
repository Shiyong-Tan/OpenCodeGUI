import { PermissionReviewService, type PermissionConnection } from '../PermissionReviewService';

function setup() {
    const directory = 'D:\\fixture';
    const sessions: Record<string, unknown> = {
        ses_parent: { id: 'ses_parent', directory, title: 'Parent' },
        ses_child: { id: 'ses_child', directory, parentID: 'ses_parent', title: 'Review', agent: 'reviewer' },
        ses_other: { id: 'ses_other', directory },
        ses_sibling: { id: 'ses_sibling', directory, parentID: 'ses_parent', title: 'Second', agent: 'coder' },
    };
    const request = (id: string, sessionID = 'ses_child', callID = id) => ({ id, sessionID, permission: 'read', patterns: ['fixture.txt'],
        metadata: {}, always: [], tool: { messageID: 'msg_a', callID } });
    let pending = [request('per_a'), request('per_b'), request('per_c', 'ses_sibling'), request('per_foreign', 'ses_other')];
    let terminal = false, failRead = false, identity = 'service_a';
    const read = jest.fn(async (path: string): Promise<unknown> => {
        if (failRead) throw new Error('offline');
        if (path === '/permission') return pending;
        if (path.includes('/message/')) {
            const sessionID = path.split('/')[2];
            return { info: { id: 'msg_a', sessionID, ...(terminal ? { error: { name: 'MessageAbortedError' } } : {}) },
                parts: pending.filter(r => r.sessionID === sessionID).map(r => ({ type: 'tool', tool: 'read', callID: r.tool.callID,
                    state: { status: terminal ? 'error' : 'running', input: { filePath: 'fixture.txt' } } })) };
        }
        const info = sessions[path.split('/')[2]]; if (!info) throw Error('not found'); return info;
    });
    const reply = jest.fn(async (path: string, _body: unknown) => { pending = pending.filter(r => path !== `/permission/${r.id}/reply`); return true; });
    const service = new PermissionReviewService(async () => ({ identity, directory, read, reply } satisfies PermissionConnection));
    const input = async () => {
        const card = (await service.snapshot('ses_parent')).requests[0];
        return { scopeSessionId: 'ses_parent', sessionId: card.sessionId, requestId: card.requestId, reviewToken: card.reviewToken, response: 'once' as const };
    };
    return { service, read, reply, input, request, sessions, setPending: (value: typeof pending) => { pending = value; },
        end: () => { terminal = true; }, offline: () => { failRead = true; }, changeServer: () => { identity = 'service_b'; } };
}

test('parent scope finds concurrent child requests, preserves owners, excludes another root, and survives a fresh view', async () => {
    const x = setup(), snapshot = await x.service.snapshot('ses_parent');
    expect(snapshot.requests.map(r => [r.sessionId, r.requestId])).toEqual([
        ['ses_child', 'per_a'], ['ses_child', 'per_b'], ['ses_sibling', 'per_c'],
    ]);
    expect(snapshot.requests[0]).toMatchObject({ agent: 'reviewer', tool: 'read', state: 'pending', input: '{"filePath":"fixture.txt"}' });
    expect((await x.service.snapshot('ses_parent')).requests).toEqual(snapshot.requests);
    expect((await x.service.snapshot('ses_child')).requests).toHaveLength(2);
});

test('exact reviewed request is replied once in its original session; no inferred first request or automatic allowance', async () => {
    const x = setup(), input = await x.input();
    await expect(x.service.respond({ ...input, sessionId: 'ses_sibling' })).rejects.toThrow(/expired|belongs/);
    await expect(x.service.respond({ ...input, requestId: 'per_b' })).rejects.toThrow(/expired|belongs/);
    expect(x.reply).not.toHaveBeenCalled();
    await x.service.respond(input);
    expect(x.reply).toHaveBeenCalledWith('/permission/per_a/reply', { reply: 'once' });
    await expect(x.service.respond(input)).rejects.toThrow(/already submitted/);
    expect(x.reply).toHaveBeenCalledTimes(1);
    expect((await x.service.snapshot('ses_parent')).requests.map(r => r.requestId)).toEqual(['per_b', 'per_c']);
});

test('aborted tool residuals are expired and cannot be approved even if the server still lists them', async () => {
    const x = setup(), input = await x.input(); x.end();
    expect((await x.service.snapshot('ses_parent')).requests.every(r => r.state === 'expired' && !r.reviewToken)).toBe(true);
    await expect(x.service.respond(input)).rejects.toThrow(/expired/); expect(x.reply).not.toHaveBeenCalled();
});

test('request removal, service replacement and parent ancestry changes fence late decisions', async () => {
    const removed = setup(), a = await removed.input(); removed.setPending([]);
    await expect(removed.service.respond(a)).rejects.toThrow(/expired/);
    const replaced = setup(), b = await replaced.input(); replaced.changeServer();
    await expect(replaced.service.respond(b)).rejects.toThrow(/changed/);
    const moved = setup(), c = await moved.input(); moved.sessions.ses_child = { id: 'ses_child', directory: 'D:\\fixture', parentID: 'ses_other' };
    await expect(moved.service.respond(c)).rejects.toThrow(/belongs/);
    for (const x of [removed, replaced, moved]) expect(x.reply).not.toHaveBeenCalled();
});

test('offline observation fails closed, while explicit rejection uses the same original request', async () => {
    const x = setup(), input = await x.input(); x.offline();
    await expect(x.service.snapshot('ses_parent')).rejects.toThrow('offline');
    await expect(x.service.respond(input)).rejects.toThrow('offline'); expect(x.reply).not.toHaveBeenCalled();
    const y = setup(); await y.service.respond({ ...await y.input(), response: 'reject' });
    expect(y.reply).toHaveBeenCalledWith('/permission/per_a/reply', { reply: 'reject' });
});

test('concurrent clicks produce only one reply; changed command details invalidate reviewed tokens', async () => {
    const x = setup(), input = await x.input();
    const first = x.service.respond(input);
    await expect(x.service.respond({ ...input, response: 'reject' })).rejects.toThrow(/submitted/);
    await first; expect(x.reply).toHaveBeenCalledTimes(1);
    const y = setup(), old = await y.input(); y.setPending([{ ...y.request('per_a'), patterns: ['different.txt'] }]);
    await expect(y.service.respond(old)).rejects.toThrow(/changed/); expect(y.reply).not.toHaveBeenCalled();
});
