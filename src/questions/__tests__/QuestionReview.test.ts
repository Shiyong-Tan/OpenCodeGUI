import { PermissionReviewService } from '../../permissions/PermissionReviewService';
function fixture() {
    let status = 'running';
    let requests = ['que_one','que_two'].map(id => ({ id, sessionID: 'ses_child', tool: { messageID: 'msg_one', callID: id },
        questions: [{ header: 'Choice', question: 'Which option?', options: [{ label: 'A', description: 'First' }], custom: false }] }));
    const reply = jest.fn(async (path: string, body: unknown) => { requests = requests.filter(r => !path.includes(r.id)); return true; });
    const read = async (path: string) => {
        if (path === '/question') return requests;
        if (path.includes('/message/')) return { info: { id: 'msg_one', sessionID: 'ses_child' }, parts: requests.map(r =>
            ({ type: 'tool', tool: 'question', callID: r.id, state: { status, input: { questions: r.questions } } })) };
        const id = path.split('/')[2]; return { id, parentID: id === 'ses_child' ? 'ses_parent' : undefined, directory: 'D:/test', title: 'Review' };
    };
    const service = new PermissionReviewService(async () => ({ identity: 'connection', directory: 'D:/test', read, reply }), 'question');
    return { service, reply, expire: () => { status = 'error'; }, change: () => { requests[0].questions[0].question = 'Changed'; } };
}
test('parent answers one exact child request and rejects another without auto answering', async () => {
    const f = fixture(), cards = (await f.service.snapshot('ses_parent')).requests;
    expect(cards).toHaveLength(2); expect(cards[0].questions![0].title).toBe('Choice'); expect(f.reply).not.toHaveBeenCalled();
    await expect(f.service.respond({ ...cards[0], sessionId: 'ses_wrong', response: 'answer', answers: [['A']] })).rejects.toThrow();
    await expect(f.service.respond({ ...cards[0], response: 'answer', answers: [['unlisted']] })).rejects.toThrow('Invalid question answer');
    await f.service.respond({ ...cards[0], response: 'answer', answers: [['A']] });
    expect(f.reply).toHaveBeenLastCalledWith('/question/que_one/reply', { answers: [['A']] });
    await expect(f.service.respond({ ...cards[0], response: 'answer', answers: [['A']] })).rejects.toThrow();
    const remaining = (await f.service.snapshot('ses_parent')).requests[0];
    await f.service.respond({ ...remaining, response: 'reject' });
    expect(f.reply).toHaveBeenLastCalledWith('/question/que_two/reject', {});
});
test('changed and aborted requests cannot accept an old answer', async () => {
    const f = fixture(), card = (await f.service.snapshot('ses_parent')).requests[0]; f.change();
    await expect(f.service.respond({ ...card, response: 'answer', answers: [['A']] })).rejects.toThrow();
    f.expire(); expect((await f.service.snapshot('ses_parent')).requests.every(r => r.state === 'expired')).toBe(true);
    await expect(f.service.respond({ ...card, response: 'reject' })).rejects.toThrow(); expect(f.reply).not.toHaveBeenCalled();
});
