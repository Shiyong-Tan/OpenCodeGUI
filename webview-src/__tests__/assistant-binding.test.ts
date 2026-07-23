import { selectAssistantUpgradeCandidate } from '../session-runtime/assistant-binding';

function input(overrides: Record<string, unknown> = {}) {
  const roles = new Map<string, string>([
    ['tmp:new', 'assistant'],
    ['tmp:pending', 'assistant'],
    ['tmp:current', 'assistant'],
    ['msg_previous', 'assistant'],
    ['msg_last', 'assistant'],
    ['local-user', 'user'],
  ]);
  return {
    canonicalId: 'msg_new',
    explicitTemporaryId: null,
    currentTurnAssistantId: null,
    pending: null,
    awaitingFinalBind: false,
    lastAssistantId: null,
    hasMessage: (id: string) => roles.has(id),
    isAssistantMessage: (id: string) => roles.get(id) === 'assistant',
    ...overrides,
  };
}

describe('assistant binding candidate selection', () => {
  test('prefers the explicit event-owned temporary assistant over stale current state', () => {
    expect(selectAssistantUpgradeCandidate(input({
      explicitTemporaryId: 'tmp:new',
      currentTurnAssistantId: 'msg_previous',
    }))).toEqual({
      accepted: true,
      canonicalId: 'msg_new',
      sourceId: 'tmp:new',
      source: 'explicit-temporary',
    });
  });

  test('accepts only pending metadata for the same canonical assistant', () => {
    expect(selectAssistantUpgradeCandidate(input({
      pending: { temporaryId: 'tmp:pending', canonicalId: 'msg_new' },
    }))).toMatchObject({ accepted: true, source: 'matching-pending', sourceId: 'tmp:pending' });

    expect(selectAssistantUpgradeCandidate(input({
      pending: { temporaryId: 'tmp:pending', canonicalId: 'msg_other' },
      currentTurnAssistantId: 'msg_previous',
    }))).toEqual({
      accepted: false,
      reason: 'no-owned-source',
      canonicalId: 'msg_new',
    });
  });

  test('never treats a different canonical assistant as the upgrade source', () => {
    expect(selectAssistantUpgradeCandidate(input({
      currentTurnAssistantId: 'msg_previous',
    }))).toEqual({
      accepted: false,
      reason: 'no-owned-source',
      canonicalId: 'msg_new',
    });
  });

  test('allows a different current canonical assistant only for final presentation handoff', () => {
    expect(selectAssistantUpgradeCandidate(input({
      currentTurnAssistantId: 'msg_previous',
      allowCanonicalHandoff: true,
    }))).toEqual({
      accepted: true,
      canonicalId: 'msg_new',
      sourceId: 'msg_previous',
      source: 'final-canonical-handoff',
    });
  });

  test('requires candidate presence and assistant role', () => {
    expect(selectAssistantUpgradeCandidate(input({
      explicitTemporaryId: 'tmp:missing',
      currentTurnAssistantId: 'local-user',
    }))).toEqual({
      accepted: false,
      reason: 'no-owned-source',
      canonicalId: 'msg_new',
    });
  });

  test('supports idempotence, awaiting-final fallback, and canonical-only start', () => {
    expect(selectAssistantUpgradeCandidate(input({
      currentTurnAssistantId: 'msg_new',
    }))).toMatchObject({ accepted: true, source: 'already-canonical' });
    expect(selectAssistantUpgradeCandidate(input({
      awaitingFinalBind: true,
      lastAssistantId: 'tmp:new',
    }))).toMatchObject({ accepted: true, source: 'awaiting-final-assistant', sourceId: 'tmp:new' });
    expect(selectAssistantUpgradeCandidate(input({
      awaitingFinalBind: true,
      lastAssistantId: 'msg_last',
    }))).toMatchObject({ accepted: false, reason: 'no-owned-source' });
    expect(selectAssistantUpgradeCandidate(input())).toMatchObject({
      accepted: true,
      source: 'canonical-only',
      sourceId: null,
    });
  });
});
