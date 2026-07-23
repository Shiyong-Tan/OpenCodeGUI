import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const main = fs.readFileSync(path.resolve(__dirname, '../../media/main.js'), 'utf8');

function extractApplyPromptToSession(): string {
  const start = main.indexOf('function applyPromptToSession(');
  const end = main.indexOf('function canAppendToMessage(', start);
  if (start < 0 || end < 0) throw new Error('applyPromptToSession boundary not found');
  return main.slice(start, end);
}

describe('new turn assistant identity', () => {
  test('replaces a stale finalized thinking alias with a fresh temporary assistant', () => {
    const staleAssistant = {
      id: 'msg_previous_final',
      role: 'assistant',
      text: 'previous answer',
      meta: { isThinking: true, statusText: 'Running task' },
    };
    const session: any = {
      messagesById: new Map([[staleAssistant.id, staleAssistant]]),
      thinkingId: staleAssistant.id,
      currentTurnAssistantKey: null,
      currentTurnAssistantMsgId: null,
      seenDiffKeys: new Set(),
      assistantUpgradeSeen: new Set(),
    };
    const posted: any[] = [];
    const context = vm.createContext({
      getSessionState: () => session,
      stripSystemInjections: (text: string) => text,
      upsertMessage: (target: any, message: any) => {
        const existing = target.messagesById.get(message.id);
        const value = existing ? Object.assign(existing, message) : message;
        target.messagesById.set(message.id, value);
        return value;
      },
      tryAppendUserMessageFastPath: () => ({ applied: false, reason: 'not-applicable' }),
      vscode: { postMessage: (message: any) => posted.push(message) },
      isSessionBusy: () => false,
      turnLifecycleController: { start: () => undefined },
      createTempAssistantId: () => 'tmp:new-turn',
      assertInvariants: () => undefined,
      updateSendGate: () => undefined,
    });
    vm.runInContext(`${extractApplyPromptToSession()}; globalThis.apply = applyPromptToSession;`, context);

    (context as any).apply('session-a', {
      text: 'hi',
      clientMessageId: 'local-new-user',
      opId: 'op-new-turn',
      mode: 'researcher',
      images: [],
    });

    expect(session.thinkingId).toBe('tmp:new-turn');
    expect(session.currentTurnAssistantKey).toBe('tmp:new-turn');
    expect(session.messagesById.get('tmp:new-turn')).toEqual(expect.objectContaining({
      role: 'assistant',
      meta: expect.objectContaining({ parentClientMessageId: 'local-new-user' }),
    }));
    expect(session.messagesById.get('msg_previous_final')).toBe(staleAssistant);
    expect(staleAssistant.meta).toEqual({ isThinking: false, statusText: null });
    expect(posted).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'registerPendingUserLocal', localKey: 'local-new-user' }),
    ]));
  });
});
