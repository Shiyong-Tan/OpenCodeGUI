import { V2Backend } from '../transport/protocol/V2Backend';
import { V2Transport } from '../transport/protocol/V2Transport';
import { message } from '../transport/protocol/V2Codec';
import { BackendOperationError } from '../transport/protocol/BackendContract';

const raw = (id: string, type: string, extra = {}) => ({ id, type, time: { created: 1 },
    ...(type === 'user' ? { text: id } : type === 'assistant' ? { content: [{ type: 'text', text: id }] } : {}), ...extra });
const record = (id: string, type: string, extra = {}) => message(raw(id, type, extra), 'ses_A');
function fixture() {
    const backend = new V2Backend({} as V2Transport);
    const pages = jest.spyOn(backend.sessions, 'messages');
    jest.spyOn(backend.controls, 'active').mockResolvedValue({});
    return { backend, pages };
}

test('recent history starts newest-first and stops without scanning older pages after preserving its user anchor', async () => {
    const { backend, pages } = fixture();
    pages.mockResolvedValueOnce({ items: [record('msg_final', 'assistant'), record('msg_user', 'user')], next: 'older-history' });
    const result = await backend.history('ses_A', 2);
    expect(pages).toHaveBeenCalledTimes(1);
    expect(pages).toHaveBeenCalledWith('ses_A', { limit: 2, order: 'desc' });
    expect(result.map(item => item.info.id)).toEqual(['msg_user', 'msg_final']);
    expect(result[1].info.parentID).toBe('msg_user'); expect(result[1].info.finish).toBeUndefined();
});

test('a suffix crossing an assistant/tool stage reads backwards to its parent and retains the exact final', async () => {
    const { backend, pages } = fixture();
    pages.mockResolvedValueOnce({ items: [record('msg_idle', 'idle', { outcome: 'succeeded' }), record('msg_final', 'assistant')], next: 'older' });
    pages.mockResolvedValueOnce({ items: [record('msg_stage', 'assistant'), record('msg_user', 'user')], next: 'unneeded' });
    const result = await backend.history('ses_A', 2);
    expect(pages).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(2);
    expect(result[1].info).toMatchObject({ id: 'msg_final', parentID: 'msg_user', finish: 'stop' });
    expect(result[1].parts[0].text).toBe('msg_final');
});

test('synthetic boundaries and a running execution do not acquire a false final in recent history', async () => {
    const { backend, pages } = fixture();
    jest.spyOn(backend.controls, 'active').mockResolvedValue({ ses_A: 'running' });
    pages.mockResolvedValueOnce({ items: [record('msg_idle', 'idle', { outcome: 'succeeded' })], next: 'older' });
    pages.mockResolvedValueOnce({ items: [record('msg_final', 'assistant')], next: 'anchor' });
    pages.mockResolvedValueOnce({ items: [record('msg_steer', 'synthetic')], next: 'unneeded' });
    const [result] = await backend.history('ses_A', 1);
    expect(result.info.parentID).toBe('msg_steer'); expect(result.info.finish).toBeUndefined();
    expect(pages).toHaveBeenCalledTimes(3);
});

test('recent paging rejects duplicate identities and cyclic cursors rather than truncating silently', async () => {
    const first = fixture(); first.pages.mockResolvedValue({ items: [record('msg_final', 'assistant')], next: 'loop' });
    await expect(first.backend.history('ses_A', 2)).rejects.toThrow('duplicate');
    const second = fixture(); second.pages.mockResolvedValue({ items: [], next: 'loop' });
    await expect(second.backend.history('ses_A', 2)).rejects.toThrow('pagination');
});

test('page size grows again after passing an oversized record without losing the following final', async () => {
    const { backend, pages } = fixture();
    pages.mockImplementation(async (_session, options) => {
        if (!options?.cursor) {
            if (options?.limit !== 1) throw new BackendOperationError('invalid_response', 'V2 response bound');
            return { items: [record('msg_user', 'user')], next: 'after-large' };
        }
        const index = Number(options.cursor.split('-').at(-1)) || 0;
        if (index < 16) return { items: [record(`msg_stage_${index}`, 'assistant')], next: `after-${index + 1}` };
        return { items: [record('msg_final', 'assistant'), record('msg_idle', 'idle', { outcome: 'succeeded' })] };
    });
    expect((await backend.history('ses_A')).at(-1)?.info.finish).toBe('stop');
    expect(pages.mock.calls.at(-1)?.[1]).toEqual({ limit: 2, cursor: 'after-16' });
});

test('single message detail uses its exact route, validates identity and never lists history', async () => {
    const fetcher = jest.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ data: raw('msg_tool', 'assistant', { content: [
        { type: 'tool', id: 'call_A', name: 'read', state: { status: 'running', input: { path: 'fixture' } } },
    ] }) }), { headers: { 'content-type': 'application/json' } }));
    const backend = new V2Backend(new V2Transport({ baseUrl: 'http://127.0.0.1:42000', directory: '/fixture', authorization: 'fixture', isCurrent: () => true }, fetcher));
    expect((await backend.message('ses_A', 'msg_tool')).parts[0]).toMatchObject({ callID: 'call_A', state: { status: 'running' } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain('/api/session/ses_A/message/msg_tool');
    await expect(backend.message('ses_A', 'msg_wrong')).rejects.toThrow('message identity');
});

test('adjacent large records do not repeatedly trigger larger oversized page retries', async () => {
    const { backend, pages } = fixture();
    pages.mockResolvedValueOnce({ items: [record('msg_large', 'user', { text: 'x'.repeat(5 * 1024 * 1024) })], next: 'large-next' });
    pages.mockResolvedValueOnce({ items: [record('msg_small', 'assistant')], next: 'small-next' });
    pages.mockResolvedValueOnce({ items: [record('msg_idle', 'idle', { outcome: 'succeeded' })] });
    await backend.transcript('ses_A');
    expect(pages.mock.calls.map(call => call[1]?.limit)).toEqual([200, 1, 1]);
});

test('exact assistant errors are retained so stale permission requests cannot be approved', async () => {
    const { backend } = fixture();
    jest.spyOn(backend.sessions, 'message').mockResolvedValue(record('msg_error', 'assistant', {
        error: { name: 'MessageAbortedError' },
    }));
    const result = await backend.message('ses_A', 'msg_error');
    expect(result.info.error).toEqual({ name: 'MessageAbortedError' });
    expect(result.info.finish).toBeUndefined();
});
