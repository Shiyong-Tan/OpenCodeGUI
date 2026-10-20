import { reviewChildCards } from '../../src/events/ChildCardReview';
import type { V2Backend } from '../../src/transport/protocol/V2Backend';
import { applyChildCardTerminals, childCardIds } from '../continuation/child-card-state';
import { visibleSubagentCards } from '../rendering/subagent-tools';
import * as fs from 'fs';
import * as vm from 'vm';

function fixture() {
    const outcome = new Map([['ses_done', 'succeeded'], ['ses_live', ''], ['ses_foreign', 'succeeded']]);
    let current = true;
    const backend = { sessions: { getSession: jest.fn(async (id: string) => ({ id,
        parentId: id === 'ses_parent' ? undefined : id === 'ses_foreign' ? 'ses_other' : 'ses_parent',
        location: { directory: 'G:/fixture' }, native: { outcome: outcome.get(id) } })) },
        projection: jest.fn(async (id: string) => ({ active: outcome.get(id) === '', outcome: outcome.get(id),
            messages: [{ info: { time: { completed: 1000 } } }] })) };
    const read = (ids: string[]) => reviewChildCards(backend as unknown as V2Backend, 'ses_parent', ids, () => current);
    return { backend, read, outcome, supersede: () => { current = false; } };
}

test('restored historical cards absent from runtime registration are reviewed, with active siblings preserved', async () => {
    const x = fixture();
    const old = { sessionId: 'ses_done', state: 'running', startedAt: 100 };
    const live = { sessionId: 'ses_live', state: 'running', startedAt: 100 };
    const session = { messagesById: new Map([['msg_old', { meta: { subagents: [old] } }], ['msg_current', { meta: { subagents: [live] } }]]) };
    expect(childCardIds(session)).toEqual(['ses_done', 'ses_live']);
    const facts = await x.read(childCardIds(session));
    expect(facts).toEqual([{ sessionId: 'ses_done', state: 'done', finishedAt: 1000 }]);
    expect(applyChildCardTerminals(session, facts)).toBe(true);
    expect(visibleSubagentCards([old, live])).toEqual([live]);
    expect(childCardIds(session)).toEqual(['ses_live']);
    expect(x.backend.projection).not.toHaveBeenCalledWith('ses_live');
});

test('terminal evidence survives another hydration and late stale progress without hiding a newer continuation', async () => {
    const session = { activeSubagents: [{ sessionId: 'ses_done', state: 'running', startedAt: 100 }], messagesById: new Map() };
    applyChildCardTerminals(session, [{ sessionId: 'ses_done', state: 'done', finishedAt: 1000 }]);
    session.messagesById.set('msg_restored', { meta: { subagents: [{ sessionId: 'ses_done', state: 'running', startedAt: 100 }] } });
    session.activeSubagents = [{ sessionId: 'ses_done', state: 'running', startedAt: 2000 }];
    applyChildCardTerminals(session);
    expect(visibleSubagentCards(session.messagesById.get('msg_restored').meta.subagents)).toEqual([]);
    expect(visibleSubagentCards(session.activeSubagents)).toHaveLength(1);
});

test('foreign, active, unknown and superseded observations never mark cards completed', async () => {
    const x = fixture();
    expect(await x.read(['ses_foreign', 'ses_live'])).toEqual([]);
    x.backend.projection.mockImplementation(async () => { x.supersede(); return { active: false, outcome: 'succeeded', messages: [{ info: { time: { completed: 1000 } } }] }; });
    expect(await x.read(['ses_done'])).toEqual([]);
});

test.each([['failed', 'failed'], ['interrupted', 'cancelled']])('confirmed %s cards are hidden', async (outcome, state) => {
    const x = fixture(); x.outcome.set('ses_done', outcome);
    expect(await x.read(['ses_done'])).toEqual([{ sessionId: 'ses_done', state, finishedAt: 1000 }]);
});

test('card review bounds and malformed identities fail closed', async () => {
    const x = fixture();
    await expect(x.read(['../foreign'])).rejects.toThrow(/scope/);
    await expect(x.read(Array(129).fill('ses_done'))).rejects.toThrow(/scope/);
});

test('production response handler updates the owning old bubble while another session is visible', () => {
    const source = fs.readFileSync('media/main.js', 'utf8');
    const handler = source.slice(source.indexOf("case 'subagentCardTerminals':"), source.indexOf("case 'subagentStatus':"));
    const agent = { sessionId: 'ses_done', state: 'running', startedAt: 100 };
    const owner = { messagesById: new Map([['msg_old', { meta: { subagents: [agent] } }]]) };
    const other = { messagesById: new Map() };
    const schedule = jest.fn();
    const run = vm.runInNewContext(`(message) => { switch(message.type) { ${handler} } }`, {
        hydrationStateController: { applyChildCardTerminals }, activeSessionId: 'ses_other',
        getSessionState: (id: string) => id === 'ses_parent' ? owner : other,
        scheduleCoalescedSessionMetadataRender: schedule,
    });
    run({ type: 'subagentCardTerminals', sessionId: 'ses_parent', terminals: [{ sessionId: 'ses_done', state: 'done', finishedAt: 1000 }] });
    expect(visibleSubagentCards([agent])).toEqual([]);
    expect(other.messagesById.size).toBe(0);
    expect(schedule).toHaveBeenCalledWith('ses_parent', 'subagent-card-terminal-review', { immediate: true });
});
