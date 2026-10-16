import { decodeV2Event } from '../transport/protocol/V2EventAdapter';

test.each(['session.deleted', 'session.forked'])('native session event %s retains its explicit owner', type => {
    expect(decodeV2Event({ id: 'evt_fixture', type, data: { sessionID: 'ses_A' } })).toMatchObject({ category: 'session', sessionId: 'ses_A' });
});

const frame = (type: string, data: Record<string, unknown> = {}) => ({ id: 'evt_fixture', created: 1,
    type, location: { directory: '/fixture' }, data: { sessionID: 'ses_A',
        ...(type.startsWith('session.text.') || type.startsWith('session.reasoning.') ? { ordinal: 0 } : {}), ...data } });

test('provider streaming, step end and execution outcome remain different facts', () => {
    expect(decodeV2Event(frame('session.step.streamed', { assistantMessageID: 'msg_a' })).category).toBe('step');
    expect(decodeV2Event(frame('session.step.ended', { assistantMessageID: 'msg_a' })).category).toBe('step');
    expect(decodeV2Event(frame('session.execution.succeeded')).category).toBe('execution');
    expect(decodeV2Event(frame('session.compaction.ended')).category).toBe('compaction');
    expect(decodeV2Event(frame('session.step.ended', { assistantMessageID: 'msg_a' }))).not.toHaveProperty('final');
});

test('parallel tools preserve their owning session, assistant and call without a current-tool field', () => {
    const records = [
        frame('session.tool.called', { assistantMessageID: 'msg_a', id: 'call_1', input: {} }),
        frame('session.tool.called', { assistantMessageID: 'msg_a', id: 'call_2', input: {} }),
        frame('session.tool.success', { sessionID: 'ses_B', assistantMessageID: 'msg_b', id: 'call_1', content: [] }),
        frame('session.tool.failed', { assistantMessageID: 'msg_a', id: 'call_1', error: { name: 'FixtureError' } }),
    ].map(decodeV2Event);
    expect(records.map(item => [item.sessionId, item.assistantMessageId, item.callId])).toEqual([
        ['ses_A', 'msg_a', 'call_1'], ['ses_A', 'msg_a', 'call_2'], ['ses_B', 'msg_b', 'call_1'], ['ses_A', 'msg_a', 'call_1'],
    ]);
    expect(records.every(item => item.category === 'tool')).toBe(true);
    expect(records.every(item => !('final' in item))).toBe(true);
});

test('unknown future events are not guessed to be progress or terminal', () => {
    const value = decodeV2Event(frame('session.future-event', { future: true }));
    expect(value.category).toBe('unknown'); expect(value.payload.future).toBe(true);
});

test('global interaction records never borrow an active chat owner', () => {
    const value = decodeV2Event(frame('form.cancelled', { sessionID: 'global', id: 'frm_a' }));
    expect(value.category).toBe('interaction'); expect(value.sessionId).toBeUndefined();
    expect(() => decodeV2Event(frame('session.execution.succeeded', { sessionID: 'global' }))).toThrow();
    expect(decodeV2Event(frame('form.created', { sessionID: undefined, form: { sessionID: 'ses_B' } })).sessionId).toBe('ses_B');
});

test('parallel text blocks retain ordinal identity and inbox events require a canonical item ID', () => {
    expect(decodeV2Event(frame('session.text.delta', { assistantMessageID: 'msg_a', ordinal: 1 })).ordinal).toBe(1);
    expect(() => decodeV2Event(frame('session.text.delta', { assistantMessageID: 'msg_a', ordinal: -1 }))).toThrow();
    expect(() => decodeV2Event(frame('session.inbox.delivered'))).toThrow();
    expect(decodeV2Event(frame('session.inbox.delivered', { inboxID: 'msg_input' })).category).toBe('inbox');
});

test('known session/tool events require explicit canonical ownership fields', () => {
    for (const patch of [{ sessionID: undefined, assistantMessageID: 'msg_a', id: 'call' },
        { sessionID: 'ses_A', id: 'call' }, { sessionID: 'ses_A', assistantMessageID: 'msg_a', id: '' }]) {
        expect(() => decodeV2Event(frame('session.tool.called', patch))).toThrow();
    }
});

test('decoder neither consumes the source nor owns any cross-frame state', () => {
    const source = frame('session.text.delta', { assistantMessageID: 'msg_a', delta: 'hello' });
    const before = JSON.stringify(source);
    expect(decodeV2Event(source)).toEqual(decodeV2Event(source));
    expect(JSON.stringify(source)).toBe(before);
});
