import { createTurnLifecycleController } from '../session-runtime/turn-lifecycle';

describe('webview single-session turn lifecycle', () => {
  const controller = createTurnLifecycleController({ now: () => 100 });

  test('starts a new independent generation and projects compatibility fields', () => {
    const session: any = {
      backendTurnInFlight: false,
      turnFullyFinalized: true,
      finalAssistantLock: { assistantMsgId: 'msg_old', ts: 1 },
    };
    expect(controller.start(session)).toEqual({
      generation: 1,
      phase: 'active',
      backendInFlight: false,
      canonicalAssistantId: null,
    });
    expect(session).toMatchObject({
      backendTurnInFlight: false,
      turnFullyFinalized: false,
      finalAssistantLock: null,
    });
  });

  test('makes main final monotonic before cleanup effects finish', () => {
    const session: any = {};
    controller.start(session);
    controller.setBackendInFlight(session, true);
    const accepted = controller.acceptMainFinal(session, 'msg_final');

    expect(accepted).toMatchObject({
      accepted: true,
      idempotent: false,
      state: {
        phase: 'main-final',
        backendInFlight: true,
        canonicalAssistantId: 'msg_final',
      },
    });
    expect(controller.canAcceptAssistantActivity(session, 'msg_final')).toBe(false);
    expect(controller.setBackendInFlight(session, true)).toBe(accepted.state);
  });

  test('accepts duplicate final idempotently and rejects another final identity', () => {
    const session: any = {};
    controller.start(session);
    const first = controller.acceptMainFinal(session, 'msg_final');
    expect(controller.acceptMainFinal(session, 'msg_final')).toEqual({
      accepted: true,
      idempotent: true,
      state: first.state,
    });
    expect(controller.acceptMainFinal(session, 'msg_other')).toEqual({
      accepted: false,
      reason: 'different-terminal-assistant',
      state: first.state,
    });
  });

  test('separates main final from effect finalization', () => {
    const session: any = {};
    controller.start(session);
    controller.setBackendInFlight(session, true);
    controller.acceptMainFinal(session, 'msg_final');
    expect(session.turnFullyFinalized).toBe(false);

    expect(controller.completeEffects(session)).toMatchObject({
      phase: 'effects-finalized',
      backendInFlight: false,
      canonicalAssistantId: 'msg_final',
    });
    expect(session.turnFullyFinalized).toBe(true);
    expect(session.backendTurnInFlight).toBe(false);
  });

  test('seals cancelled and failed turns', () => {
    const cancelled: any = {};
    controller.start(cancelled);
    expect(controller.cancel(cancelled).phase).toBe('cancelled');
    expect(controller.canAcceptAssistantActivity(cancelled)).toBe(false);

    const failed: any = {};
    controller.start(failed);
    expect(controller.fail(failed).phase).toBe('failed');
    expect(controller.canAcceptAssistantActivity(failed)).toBe(false);
  });

  test('hydrates an authoritative durable baseline through the single writer', () => {
    const session: any = {};
    controller.start(session);
    controller.setBackendInFlight(session, true);
    expect(controller.hydrateAuthoritative(session)).toEqual({
      generation: 1,
      phase: 'effects-finalized',
      backendInFlight: false,
      canonicalAssistantId: null,
    });
    expect(session).toMatchObject({
      backendTurnInFlight: false,
      turnFullyFinalized: true,
      finalAssistantLock: null,
    });
  });

  test('reconciles a restored active lifecycle into compatibility projections', () => {
    const session: any = {
      turnLifecycle: {
        generation: 4,
        phase: 'active',
        backendInFlight: true,
        canonicalAssistantId: null,
      },
      backendTurnInFlight: false,
      turnFullyFinalized: true,
    };
    controller.reconcileProjection(session);
    expect(session.backendTurnInFlight).toBe(true);
    expect(session.turnFullyFinalized).toBe(false);
  });
});
