import { createHydrationStateController } from '../continuation/hydration-state-controller';
import { createSessionState } from '../continuation/session-store';
import { createSegmentTopology } from '../features/segments/segment-topology';

const controller = createHydrationStateController({
  toStableMessageKey: (session, key) => session.clientKeyToServerId?.get(key) || null,
  now: () => 1_000,
});
const segmentTopology = createSegmentTopology({ debug: () => undefined, now: () => 1_000 });
const integrationOptions = {
  isHiddenControlUserText: (text: string) => text.startsWith('[hidden]'),
  isHiddenControlAssistantText: () => false,
  cleanUserText: (text: string) => text,
  toStableMessageKey: (id: string) => id,
  normalizeSegment: (timeline: readonly string[], segment: any) => segmentTopology.normalizeMembers(
    { timeline: [...timeline] },
    segment.anchorMsgId,
    segment.endMsgId,
    segment.memberMsgIds,
    segment.noticeKey,
  ),
};

describe('hydration volatile state controller', () => {
  test('builds a side-effect-free integration shadow and reports normalized equivalence', () => {
    const preservedSession: any = createSessionState();
    preservedSession.backendTurnInFlight = true;
    preservedSession.turnFullyFinalized = false;
    preservedSession.lastTurnUserId = 'msg_user';
    preservedSession.currentTurnAssistantKey = 'msg_assistant';
    preservedSession.messagesById.set('msg_user', {
      id: 'msg_user',
      role: 'user',
      text: 'prompt',
    });
    preservedSession.messagesById.set('msg_assistant', {
      id: 'msg_assistant',
      role: 'assistant',
      text: 'live answer',
    });
    preservedSession.timeline = ['msg_user', 'msg_assistant'];
    const preserved = controller.capture(preservedSession);
    const shadow = controller.createIntegrationShadow({
      sessionId: 'session-a',
      activeSessionId: 'session-a',
      hasSegments: false,
      turnFullyFinalized: false,
      messages: [
        { id: 'msg_user', role: 'user', text: 'prompt' },
        { id: 'msg_assistant', role: 'assistant', text: '' },
      ],
      meta: {
        timelineMessageIds: ['msg_user', 'msg_assistant'],
        hydrationCoverage: 'authoritativeHistoryComplete',
      },
    }, integrationOptions, preserved);

    const equivalent: any = {
      ...shadow.state,
      messagesById: new Map(shadow.state.messagesById),
      timeline: [...shadow.state.timeline],
    };
    equivalent.messagesById.set('system:snapshot:dynamic', {
      id: 'system:snapshot:dynamic',
      role: 'system',
      meta: { kind: 'snapshotNotice' },
    });
    equivalent.timeline.unshift('system:snapshot:dynamic');
    expect(controller.compareIntegrationShadow(equivalent, shadow)).toMatchObject({
      matched: true,
      mismatches: [],
      summary: { timeline: 2, messages: 2 },
    });

    equivalent.timeline.reverse();
    expect(controller.compareIntegrationShadow(equivalent, shadow)).toMatchObject({
      matched: false,
      mismatches: ['timeline'],
    });

    equivalent.timeline.reverse();
    equivalent.messagesById.set('msg_assistant', {
      ...equivalent.messagesById.get('msg_assistant'),
      text: 'different answer',
    });
    expect(controller.compareIntegrationShadow(equivalent, shadow)).toMatchObject({
      matched: false,
      mismatches: ['messages'],
      details: ['messages:msg_assistant:text'],
    });
  });

  test('restores missing live messages while excluding persistence artifacts', () => {
    const before: any = createSessionState();
    before.timeline = ['local-user', 'system:changeList:one'];
    before.messagesById.set('local-user', { id: 'local-user', role: 'user', text: 'live' });
    before.messagesById.set('system:changeList:one', { id: 'system:changeList:one', role: 'system', meta: { kind: 'changeList' } });
    before.lastTurnUserId = 'local-user';
    before.backendTurnInFlight = true;
    before.turnFullyFinalized = false;
    const preserved = controller.capture(before);
    const hydrated: any = createSessionState();
    const result = controller.restore(hydrated, preserved);
    expect(hydrated.timeline).toEqual(['local-user']);
    expect(hydrated.messagesById.has('system:changeList:one')).toBe(false);
    expect(hydrated.turnLifecycle).toMatchObject({
      phase: 'active',
      backendInFlight: true,
    });
    expect(result).toMatchObject({
      missingIds: ['local-user'],
      skippedArtifacts: { timeline: 1, backing: 1 },
    });
  });

  test('does not resurrect local active-turn aliases already hydrated canonically', () => {
    const before: any = createSessionState();
    before.timeline = ['local-user', 'tmp:assistant'];
    before.messagesById.set('local-user', { id: 'local-user', role: 'user', text: 'prompt' });
    before.messagesById.set('tmp:assistant', { id: 'tmp:assistant', role: 'assistant', text: 'stream' });
    before.clientKeyToServerId.set('local-user', 'msg_user');
    before.pendingAssistantUpgrade = { tmpKey: 'tmp:assistant', assistantMsgId: 'msg_assistant' };
    before.lastTurnUserId = 'local-user';
    before.currentTurnAssistantKey = 'tmp:assistant';
    before.backendTurnInFlight = true;
    before.turnFullyFinalized = false;
    const preserved = controller.capture(before);

    const hydrated: any = createSessionState();
    hydrated.timeline = ['msg_user', 'msg_assistant'];
    hydrated.messagesById.set('msg_user', { id: 'msg_user', role: 'user' });
    hydrated.messagesById.set('msg_assistant', { id: 'msg_assistant', role: 'assistant' });
    hydrated.clientKeyToServerId.set('local-user', 'msg_user');
    const result = controller.restore(hydrated, preserved);

    expect(hydrated.timeline).toEqual(['msg_user', 'msg_assistant']);
    expect(hydrated.messagesById.has('local-user')).toBe(false);
    expect(hydrated.messagesById.has('tmp:assistant')).toBe(false);
    expect(hydrated.backendTurnInFlight).toBe(false);
    expect(result.skippedCanonicalizedVolatile).toEqual({ timeline: 2, backing: 2, fields: 4 });
  });

  test('keeps richer colliding assistant content and append metadata during an active turn', () => {
    const before: any = createSessionState();
    before.timeline = ['msg_root', 'msg_assistant'];
    before.messagesById.set('msg_root', {
      id: 'msg_root', role: 'user', text: 'root',
      meta: { appendedPrompts: [{ appendUserMsgId: 'msg_append', text: 'more' }] },
    });
    before.messagesById.set('msg_assistant', {
      id: 'msg_assistant', role: 'assistant', text: 'streamed answer',
      meta: { isThinking: true, subagents: [{ sessionId: 'agent-a', state: 'running' }] },
    });
    before.lastTurnUserId = 'msg_root';
    before.currentTurnAssistantKey = 'msg_assistant';
    before.currentTurnAssistantMsgId = 'msg_assistant';
    before.appendRootUserKey = 'msg_root';
    before.backendTurnInFlight = true;
    before.turnFullyFinalized = false;
    const preserved = controller.capture(before);

    const hydrated: any = createSessionState();
    hydrated.timeline = ['msg_root', 'msg_assistant', 'msg_append'];
    hydrated.messagesById.set('msg_root', { id: 'msg_root', role: 'user', text: 'root', meta: {} });
    hydrated.messagesById.set('msg_assistant', { id: 'msg_assistant', role: 'assistant', text: '', meta: {} });
    hydrated.messagesById.set('msg_append', { id: 'msg_append', role: 'user', text: 'more', meta: {} });

    const result = controller.restore(hydrated, preserved);

    expect(hydrated.messagesById.get('msg_root').meta.appendedPrompts).toEqual([
      { appendUserMsgId: 'msg_append', text: 'more' },
    ]);
    expect(hydrated.messagesById.get('msg_assistant')).toMatchObject({
      text: 'streamed answer',
      meta: { isThinking: true, subagents: [{ sessionId: 'agent-a', state: 'running' }] },
    });
    expect(result.mergedIds).toEqual(['msg_root', 'msg_assistant']);
  });

  test('does not let active metadata shorten newer hydrated assistant text', () => {
    const before: any = createSessionState();
    before.timeline = ['msg_assistant'];
    before.messagesById.set('msg_assistant', {
      id: 'msg_assistant', role: 'assistant', text: 'short', meta: { subagents: [{ sessionId: 'agent-a' }] },
    });
    before.currentTurnAssistantMsgId = 'msg_assistant';
    before.backendTurnInFlight = true;
    before.turnFullyFinalized = false;
    const preserved = controller.capture(before);

    const hydrated: any = createSessionState();
    hydrated.timeline = ['msg_assistant'];
    hydrated.messagesById.set('msg_assistant', {
      id: 'msg_assistant', role: 'assistant', text: 'a newer and longer answer', meta: { parentId: 'msg_root' },
    });
    const result = controller.restore(hydrated, preserved);

    expect(hydrated.messagesById.get('msg_assistant')).toMatchObject({
      text: 'a newer and longer answer',
      meta: { parentId: 'msg_root', subagents: [{ sessionId: 'agent-a' }] },
    });
    expect(result.mergedIds).toEqual(['msg_assistant']);
  });

  test('does not merge colliding volatile records after the turn finalized', () => {
    const before: any = createSessionState();
    before.timeline = ['msg_assistant'];
    before.messagesById.set('msg_assistant', { id: 'msg_assistant', role: 'assistant', text: 'stale live text' });
    before.currentTurnAssistantMsgId = 'msg_assistant';
    before.backendTurnInFlight = false;
    before.turnFullyFinalized = true;
    const preserved = controller.capture(before);

    const hydrated: any = createSessionState();
    hydrated.timeline = ['msg_assistant'];
    hydrated.messagesById.set('msg_assistant', { id: 'msg_assistant', role: 'assistant', text: 'authoritative history' });
    const result = controller.restore(hydrated, preserved);

    expect(hydrated.messagesById.get('msg_assistant').text).toBe('authoritative history');
    expect(result.mergedIds).toEqual([]);
  });

  test('does not resurrect durable cached messages missing from authoritative hydration', () => {
    const before: any = createSessionState();
    before.timeline = ['msg_old_user', 'msg_old_assistant'];
    before.messagesById.set('msg_old_user', {
      id: 'msg_old_user', role: 'user', text: 'intentionally hidden durable prompt',
    });
    before.messagesById.set('msg_old_assistant', {
      id: 'msg_old_assistant', role: 'assistant', text: 'intentionally hidden durable answer',
    });
    before.backendTurnInFlight = false;
    before.turnFullyFinalized = true;
    const preserved = controller.capture(before);

    const hydrated: any = createSessionState();
    const result = controller.restore(hydrated, preserved);

    expect(hydrated.timeline).toEqual([]);
    expect(hydrated.messagesById.size).toBe(0);
    expect(result.skippedDurable).toEqual({ timeline: 2, backing: 2 });
  });

  test('restores only active identities, not unrelated cached history', () => {
    const before: any = createSessionState();
    before.timeline = ['msg_history', 'local-user', 'tmp:assistant'];
    before.messagesById.set('msg_history', {
      id: 'msg_history', role: 'assistant', text: 'old durable history',
    });
    before.messagesById.set('local-user', {
      id: 'local-user', role: 'user', text: 'active prompt',
    });
    before.messagesById.set('tmp:assistant', {
      id: 'tmp:assistant', role: 'assistant', text: 'active stream',
    });
    before.lastTurnUserId = 'local-user';
    before.currentTurnAssistantKey = 'tmp:assistant';
    before.backendTurnInFlight = true;
    before.turnFullyFinalized = false;
    const preserved = controller.capture(before);

    const hydrated: any = createSessionState();
    const result = controller.restore(hydrated, preserved);

    expect(hydrated.timeline).toEqual(['local-user', 'tmp:assistant']);
    expect(hydrated.messagesById.has('msg_history')).toBe(false);
    expect(result.skippedDurable).toEqual({ timeline: 1, backing: 1 });
  });

  test('retains active subagent progress across active-turn hydration only', () => {
    const before: any = createSessionState();
    before.backendTurnInFlight = true;
    before.turnFullyFinalized = false;
    before.activeSubagents = [{ sessionId: 'agent-a', state: 'running', latestText: 'working' }];
    const preserved = controller.capture(before);
    const hydrated: any = createSessionState();
    controller.restore(hydrated, preserved);
    expect(hydrated.activeSubagents).toEqual(before.activeSubagents);
    expect(hydrated.activeSubagents).not.toBe(before.activeSubagents);
  });
});
