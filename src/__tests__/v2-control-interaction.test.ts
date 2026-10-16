import { V2ControlAdapter } from '../transport/protocol/V2ControlAdapter';
import { V2InteractionAdapter, validateFormAnswer, type NativeForm, type FormValue } from '../transport/protocol/V2InteractionAdapter';
import { V2Transport } from '../transport/protocol/V2Transport';

const json = (value: unknown) => Response.json({ data: value });
const empty = () => new Response(null, { status: 204 });
function harness() {
    let current = true;
    const fetcher = jest.fn();
    const transport = new V2Transport({ baseUrl: 'http://127.0.0.1:42000', authorization: 'Basic fixture', directory: '/fixture', isCurrent: () => current }, fetcher);
    return { fetcher, controls: new V2ControlAdapter(transport), interactions: new V2InteractionAdapter(transport), replace: () => { current = false; } };
}
const permission = (sessionID = 'ses_A') => ({ id: 'per_request', sessionID, action: 'shell', resources: ['python --version'], future: true });
const form = (sessionID = 'ses_A') => ({ id: 'frm_question', sessionID, title: 'Choose', fields: [
    { key: 'choice', type: 'string', required: true, options: [{ value: 'internal', label: 'Visible label' }] },
] });
function call(f: ReturnType<typeof harness>, index = 0) {
    const [url, init] = f.fetcher.mock.calls[index] as [URL, RequestInit];
    return { path: url.pathname, query: url.searchParams, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined };
}
const nativeModel = { id: 'model', providerID: 'provider', name: 'Fixture', enabled: true, variants: [{ id: 'medium' }], limit: { context: 1000 } };

test('V2 permissions preserve action/resources and exact child owner', async () => {
    const f = harness(); f.fetcher.mockResolvedValueOnce(json([permission()]));
    expect(await f.interactions.permissions()).toEqual([expect.objectContaining({ sessionId: 'ses_A', action: 'shell', resources: ['python --version'] })]);
    expect(call(f).path).toBe('/api/permission/request'); expect(call(f).query.get('directory')).toBe('/fixture');
    f.fetcher.mockResolvedValueOnce(json([permission('ses_B')]));
    await expect(f.interactions.permissions('ses_A')).rejects.toMatchObject({ reason: 'invalid_response' });
});

test('permission reply uses original owner and request, never parent/current session', async () => {
    const f = harness(); f.fetcher.mockResolvedValueOnce(empty());
    await f.interactions.replyPermission('ses_child', 'per_request', 'once');
    expect(call(f)).toMatchObject({ method: 'POST', path: '/api/session/ses_child/permission/per_request/reply', body: { decision: 'once' } });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
});

test('forms retain global ownership without assigning it to current chat', async () => {
    const f = harness(); f.fetcher.mockResolvedValueOnce(json([form('global')]));
    expect((await f.interactions.forms())[0].sessionId).toBe('global');
    f.fetcher.mockResolvedValueOnce(json([form('ses_B')]));
    await expect(f.interactions.forms('ses_A')).rejects.toMatchObject({ reason: 'invalid_response' });
});

test('form reply rechecks the original schema and sends option value, not label', async () => {
    const f = harness(); f.fetcher.mockResolvedValueOnce(json({ ...form(), state: { status: 'pending' } })).mockResolvedValueOnce(empty());
    await f.interactions.replyForm('ses_A', 'frm_question', { choice: 'internal' });
    expect(call(f).path).toBe('/api/session/ses_A/form/frm_question');
    expect(call(f, 1)).toMatchObject({ path: '/api/session/ses_A/form/frm_question/reply', body: { answer: { choice: 'internal' } } });
});

test.each(['Visible label', 'missing'])('unrecognized option %s cannot be submitted', async value => {
    const f = harness(); f.fetcher.mockResolvedValueOnce(json({ ...form(), state: { status: 'pending' } }));
    await expect(f.interactions.replyForm('ses_A', 'frm_question', { choice: value })).rejects.toMatchObject({ reason: 'rejected' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
});

test.each(['answered', 'cancelled'])('settled form %s does not send another response', async status => {
    const f = harness(); f.fetcher.mockResolvedValueOnce(json({ ...form(), state: { status } }));
    await expect(f.interactions.replyForm('ses_A', 'frm_question', { choice: 'internal' })).rejects.toMatchObject({ reason: 'conflict' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
});

test('form cancellation is separate from answering and escapes the optional message', async () => {
    const f = harness(); f.fetcher.mockResolvedValueOnce(empty());
    await f.interactions.cancelForm('ses_A', 'frm_question', 'Cancelled & reviewed');
    expect(call(f)).toMatchObject({ method: 'DELETE', path: '/api/session/ses_A/form/frm_question' });
    expect(call(f).query.get('message')).toBe('Cancelled & reviewed');
});

const typed = (fields: NativeForm['fields']): NativeForm => ({ id: 'frm_typed', sessionId: 'ses_A', title: 'Typed', native: {}, fields });
test('typed forms preserve boolean, numeric and multiselect values with conditional fields', () => {
    const schema = typed([{ key: 'enable', type: 'boolean', required: true }, { key: 'count', type: 'integer', when: [{ key: 'enable', op: 'eq', value: true }], required: true },
        { key: 'many', type: 'multiselect', options: [{ value: 'a' }, { value: 'b' }] }, { key: 'external', type: 'external' }]);
    expect(() => validateFormAnswer(schema, { enable: true, count: 2, many: ['a', 'b'] })).not.toThrow();
    expect(() => validateFormAnswer(schema, { enable: false })).not.toThrow();
    const invalidInputs: Record<string, FormValue>[] = [{ enable: false, count: 2 }, { enable: true, count: 1.5 }, { enable: 'true' },
        { enable: false, many: ['a', 'a'] }, { enable: false, external: 'answer' }, { enable: false, unknown: true }];
    for (const input of invalidInputs)
        expect(() => validateFormAnswer(schema, input)).toThrow();
});

test('unknown form types and duplicate keys fail without manufacturing an empty question', async () => {
    const f = harness();
    f.fetcher.mockResolvedValueOnce(json([{ ...form(), fields: [{ key: 'x', type: 'future' }] }]));
    await expect(f.interactions.forms()).rejects.toMatchObject({ reason: 'unsupported' });
    f.fetcher.mockResolvedValueOnce(json([{ ...form(), fields: [{ key: 'x', type: 'string' }, { key: 'x', type: 'string' }] }]));
    await expect(f.interactions.forms()).rejects.toMatchObject({ reason: 'invalid_response' });
});

test('model selection uses native id and variant, validated against available enabled catalog', async () => {
    const f = harness(); f.fetcher.mockResolvedValueOnce(json([nativeModel])).mockResolvedValueOnce(empty());
    await f.controls.selectModel('ses_A', { providerID: 'provider', id: 'model', variant: 'medium' });
    expect(call(f).path).toBe('/api/model');
    expect(call(f, 1)).toMatchObject({ path: '/api/session/ses_A/model', body: { model: { providerID: 'provider', id: 'model', variant: 'medium' } } });
});

test.each([{ ...nativeModel, enabled: false }, { ...nativeModel, variants: [] }])('disabled model or unknown variant never reaches selection mutation', async model => {
    const f = harness(); f.fetcher.mockResolvedValueOnce(json([model]));
    await expect(f.controls.selectModel('ses_A', { providerID: 'provider', id: 'model', variant: 'medium' })).rejects.toMatchObject({ reason: 'rejected' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
});

test('agent catalog carries role model independently from parent selection', async () => {
    const f = harness(); f.fetcher.mockResolvedValueOnce(json([{ id: 'reviewer', name: 'Reviewer', mode: 'subagent', hidden: false,
        model: { providerID: 'provider', id: 'review-model', variant: 'high' } }]));
    expect((await f.controls.agents())[0]).toMatchObject({ id: 'reviewer', model: { id: 'review-model', variant: 'high' } });
});

test('active execution is explicit; unrecognized state is never converted to idle', async () => {
    const f = harness(); f.fetcher.mockResolvedValueOnce(json({ ses_A: { type: 'running' } }));
    expect(await f.controls.active()).toEqual({ ses_A: 'running' });
    f.fetcher.mockResolvedValueOnce(json({ ses_A: { type: 'future' } }));
    await expect(f.controls.active()).rejects.toMatchObject({ reason: 'invalid_response' });
});

test('manual compaction is a durable inbox control, not an answer or selected-model rewrite', async () => {
    const f = harness(); f.fetcher.mockResolvedValueOnce(json({ id: 'msg_compact', sessionID: 'ses_A', type: 'compaction', delivery: 'steer' }));
    expect(await f.controls.compact('ses_A', 'msg_compact', 'steer')).toMatchObject({ kind: 'compaction', id: 'msg_compact' });
    expect(call(f)).toMatchObject({ path: '/api/session/ses_A/compact', body: { id: 'msg_compact', delivery: 'steer' } });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
});

test('mismatched compaction acknowledgement remains ambiguous and is never retried', async () => {
    const f = harness(); f.fetcher.mockResolvedValueOnce(json({ id: 'msg_foreign', sessionID: 'ses_A', type: 'compaction', delivery: 'queue' }));
    await expect(f.controls.compact('ses_A', 'msg_compact', 'queue')).rejects.toMatchObject({ reason: 'ambiguous' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
});

test('revert stage, restore and commit remain distinct operations with explicit file effects', async () => {
    const f = harness(); f.fetcher.mockResolvedValueOnce(json({ messageID: 'msg_boundary', files: [] })).mockResolvedValueOnce(empty()).mockResolvedValueOnce(empty());
    await f.controls.stageRevert('ses_A', 'msg_boundary', false); await f.controls.clearRevert('ses_A'); await f.controls.commitRevert('ses_A');
    expect(call(f)).toMatchObject({ method: 'POST', path: '/api/session/ses_A/revert/stage', body: { messageID: 'msg_boundary', files: false } });
    expect(call(f, 1)).toMatchObject({ method: 'DELETE', path: '/api/session/ses_A/revert' });
    expect(call(f, 2)).toMatchObject({ method: 'POST', path: '/api/session/ses_A/revert/commit' });
});

test('service replacement between schema read and form response blocks the mutation', async () => {
    const f = harness(); f.fetcher.mockImplementationOnce(async () => { f.replace(); return json({ ...form(), state: { status: 'pending' } }); });
    await expect(f.interactions.replyForm('ses_A', 'frm_question', { choice: 'internal' })).rejects.toMatchObject({ reason: 'superseded' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
});
