import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { createSessionComposerStore } from '../session-runtime/session-composer-store';
import { createTurnLifecycleController, TurnLifecycleSession } from '../session-runtime/turn-lifecycle';

const main = fs.readFileSync(path.join(process.cwd(), 'media/main.js'), 'utf8');
const handler = main.slice(main.indexOf("            case 'sendAccepted': {"), main.indexOf("            case 'turnInFlight': {"));

describe('production send rejection wiring', () => {
  test.each(['A', 'B'])('restores only A when visible session is %s', (visible) => {
    const store = createSessionComposerStore();
    store.setDraft('A', 'recover');
    store.rememberSubmission('A', 'local-A', 'op-A', 'tmp:A');
    store.setDraft('A', '');
    const lifecycle = createTurnLifecycleController();
    const session: TurnLifecycleSession & { inputDraft: string; activeTurnOpId: string | null } = { inputDraft: '', activeTurnOpId: 'op-A' };
    lifecycle.setBackendInFlight(session, true);
    const context = {
      message: { type: 'sendRejected', sessionId: 'A', clientMessageId: 'local-A', opId: 'op-A', tmpKey: 'tmp:A' },
      activeSessionId: visible,
      sessionComposerStore: store,
      turnLifecycleController: lifecycle,
      updateSendGate: jest.fn(),
      getEventSessionId: (message: { sessionId: string }) => message.sessionId,
      getSessionState: jest.fn(() => session),
      captureSessionComposerState: jest.fn(),
      removeMessageFromSession: jest.fn(),
      clearAppendInputForSessionChange: jest.fn(),
      renderIfActive: jest.fn(),
    };
    vm.runInNewContext(`switch (message.type) { ${handler} }`, context);
    expect(context.removeMessageFromSession.mock.calls).toEqual([[session, 'local-A'], [session, 'tmp:A']]);
    expect(session.inputDraft).toBe('recover');
    expect(session.turnFullyFinalized).toBe(true);
    expect(session.backendTurnInFlight).toBe(true);
    lifecycle.setBackendInFlight(session, false);
    expect(session.turnFullyFinalized && !session.backendTurnInFlight).toBe(true);
    expect(context.clearAppendInputForSessionChange).toHaveBeenCalledTimes(visible === 'A' ? 1 : 0);
    expect(context.renderIfActive).toHaveBeenCalledWith('A', 'sendRejected');
    vm.runInNewContext(`switch (message.type) { ${handler} }`, context);
    expect(context.removeMessageFromSession).toHaveBeenCalledTimes(2);
  });
});
