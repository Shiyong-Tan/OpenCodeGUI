import { isEmptyFailedPlaceholder } from '../continuation/failed-placeholder';
import fs from 'fs';
import vm from 'vm';

test('removes only the failed temporary empty placeholder', () => {
    const placeholder = { text: 'Thinking...', meta: { isThinking: true, currentSegment: '', textSegments: [], subagents: [], todos: [], processingStartedAt: 12 } };
    expect(isEmptyFailedPlaceholder(placeholder, 'tmp:A', 'tmp:A', undefined)).toBe(true);
    expect(isEmptyFailedPlaceholder(placeholder, 'tmp:B', 'tmp:A', undefined)).toBe(false);
    expect(isEmptyFailedPlaceholder(placeholder, 'tmp:A', 'tmp:A', 'msg_final')).toBe(false);
    for (const message of [
        { text: 'partial answer' }, { text: '', meta: { subagents: [{ id: 'child' }] } },
        { text: '', meta: { images: ['image'] } }, { text: '', meta: { toolResult: 'evidence' } },
    ]) expect(isEmptyFailedPlaceholder(message, 'tmp:A', 'tmp:A', undefined)).toBe(false);
});

test('production error cleanup addresses A while B is visible and ignores stale identities', () => {
    const main = fs.readFileSync('media/main.js', 'utf8');
    const start = main.indexOf('function handleChatDone(sessionId, message) {');
    const end = main.indexOf('        const finalizingAppendSuccessor', start);
    const session = { currentTurnAssistantKey: 'tmp:A', messagesById: new Map([['tmp:A', { text: 'Thinking...', meta: { isThinking: true } }]]) };
    const remove = jest.fn();
    const context = { activeSessionId: 'B', getSessionState: jest.fn(() => session),
        removeMessageFromSession: remove, window: { __ocContinuation: { isEmptyFailedPlaceholder } } };
    vm.runInNewContext(main.slice(start, end) + '\n}', context);
    const done = (context as unknown as { handleChatDone: (id: string, message: unknown) => void }).handleChatDone;
    done('A', { skipSnapshot: true, failedTmpKey: 'tmp:old' });
    expect(remove).not.toHaveBeenCalled();
    done('A', { skipSnapshot: true, failedTmpKey: 'tmp:A' });
    expect(remove).toHaveBeenCalledWith(session, 'tmp:A');
    expect(context.getSessionState).toHaveBeenCalledWith('A');
});
