import { createQuestionReview } from '../questions/question-review';
const card = (id = 'que_one') => ({ sessionId: 'ses_child', scopeSessionId: 'ses_parent', requestId: id, reviewToken: id,
    state: 'pending', title: 'Child', questions: [{ title: 'Choice', prompt: 'Choose', options: [{ label: 'A' }], custom: true }] });
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(1000); });
afterEach(() => jest.useRealTimers());
test('queue preserves drafts on polls, advances only on acknowledgment and routes exact owner', () => {
    const post = jest.fn(), change = jest.fn(), review = createQuestionReview(post, change);
    const snapshot = (requests: unknown[]) => review.receive({ ...post.mock.calls.at(-1)![0], type: 'questionSnapshot', requests });
    review.select('ses_parent'); snapshot([card(), card('que_two')]);
    review.update(r => ({ ...r, draft: 'typed answer' })); change.mockClear();
    jest.advanceTimersByTime(3000); snapshot([card(), card('que_two')]);
    expect(review.current()?.draft).toBe('typed answer'); expect(change).not.toHaveBeenCalled();
    review.submit('answer', [['typed answer']]); review.submit('answer', [['duplicate']]);
    expect(post.mock.calls.filter(([m]) => m.type === 'questionDecision')).toHaveLength(1);
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'ses_child', requestId: 'que_one', answers: [['typed answer']] }));
    expect(review.current()?.requestId).toBe('que_one');
    review.receive({ type: 'questionDecisionAck', sessionId: 'ses_child', requestId: 'que_one' }); snapshot([card('que_two')]);
    expect(review.current()?.requestId).toBe('que_two'); review.dispose();
});
test('late scopes, disconnects and expired requests cannot produce an answer', () => {
    const post = jest.fn(), review = createQuestionReview(post, () => {}); review.select('ses_parent'); const first = post.mock.calls[0][0];
    review.select('ses_other'); review.receive({ ...first, type: 'questionSnapshot', requests: [card()] }); expect(review.current()).toBeUndefined();
    review.select('ses_parent'); review.receive({ ...post.mock.calls.at(-1)![0], type: 'questionSnapshot', requests: [card()] });
    review.receive({ type: 'serverStatus', status: 'disconnected' }); review.submit('reject');
    expect(post.mock.calls.filter(([m]) => m.type === 'questionDecision')).toHaveLength(0);
    review.refresh(); review.receive({ ...post.mock.calls.at(-1)![0], type: 'questionSnapshot', requests: [{ ...card(), state: 'expired' }] });
    expect(review.current()).toBeUndefined(); review.dispose();
});

test('fresh views recover child questions by identity without retaining answered requests or concatenating changes', () => {
    const post = jest.fn(); let review = createQuestionReview(post, () => {});
    const snapshot = (requests: unknown[]) => review.receive({ ...post.mock.calls.at(-1)![0], type: 'questionSnapshot', requests });
    review.select('ses_parent'); snapshot([card(), { ...card('que_two'), sessionId: 'ses_sibling' }]);
    review.update(row => ({ ...row, draft: 'old draft' }));
    review.refresh();
    snapshot([{ ...card(), reviewToken: 'changed-schema', questions: [{ title: 'New', prompt: 'New question', options: [{ label: 'B' }] }] }]);
    expect(review.current()?.questions?.[0].prompt).toBe('New question');
    expect(review.current()?.draft).toBe('');
    review.dispose(); review = createQuestionReview(post, () => {});
    review.select('ses_parent');
    expect(review.current()).toBeUndefined(); expect(review.blocked()).toBe(true);
    snapshot([{ ...card('que_two'), sessionId: 'ses_sibling' }]);
    review.submit('reject');
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'ses_sibling', requestId: 'que_two', response: 'reject' }));
    review.receive({ type: 'questionDecisionAck', sessionId: 'ses_sibling', requestId: 'que_two' });
    snapshot([]); expect(review.current()).toBeUndefined(); review.dispose();
});

test.each([null, { ...card(), scopeSessionId: 'ses_foreign' }])('invalid latest question observations block stale answers: %s', invalid => {
    const post = jest.fn(), review = createQuestionReview(post, () => {});
    const snapshot = (requests: unknown[]) => review.receive({ ...post.mock.calls.at(-1)![0], type: 'questionSnapshot', requests });
    review.select('ses_parent'); snapshot([card()]);
    jest.advanceTimersByTime(3000); snapshot([invalid]);
    expect(review.blocked()).toBe(true); review.submit('answer', [['A']]);
    expect(post.mock.calls.some(([message]) => message.type === 'questionDecision')).toBe(false);
    jest.advanceTimersByTime(3000); snapshot([card()]);
    expect(review.blocked()).toBe(false); expect(review.current()?.error).toBe(''); review.dispose();
});
