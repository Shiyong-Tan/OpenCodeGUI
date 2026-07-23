import {
  normalizeHydrationCoverage,
  planHydrationIntegration,
  type HydrationIntegrationInput,
} from '../continuation/hydration-integration-planner';
import { createSegmentTopology } from '../features/segments/segment-topology';

const topology = createSegmentTopology({ debug: () => undefined, now: () => 100 });
const options = {
  isHiddenControlUserText: (text: string) => text.startsWith('[hidden-user]'),
  isHiddenControlAssistantText: (text: string) => text.startsWith('[hidden-assistant]'),
  cleanUserText: (text: string) => text.replace(/^system:\s*/, ''),
  toStableMessageKey: (id: string) => id === 'local-user' ? 'msg_user' : id,
  normalizeSegment: (timeline: readonly string[], segment: any) => topology.normalizeMembers(
    {
      timeline: [...timeline],
      clientKeyToServerId: new Map([['local-user', 'msg_user']]),
      serverIdToClientKey: new Map([['msg_user', 'local-user']]),
    },
    segment.anchorMsgId,
    segment.endMsgId,
    segment.memberMsgIds,
    segment.noticeKey,
  ),
};

const message = (id: string, role: string, text = id, meta: any = {}) => ({
  id, role, text, meta,
});

function plan(overrides: Partial<HydrationIntegrationInput> = {}) {
  return planHydrationIntegration({
    sessionId: 'session-a',
    activeSessionId: 'session-a',
    hasSegments: true,
    messages: [],
    segments: [],
    ...overrides,
  }, options);
}

describe('hydration integration planner', () => {
  test('fails closed for an unknown session owner', () => {
    expect(planHydrationIntegration({
      sessionId: '',
      hasSegments: false,
      messages: [message('msg_a', 'user')],
    }, options)).toMatchObject({
      accepted: false,
      reason: 'missing-session',
      timeline: [],
      render: { sessionId: '', onlyWhenActive: true },
    });
  });

  test('preserves explicit snapshot order and keeps segment backing records off timeline', () => {
    const result = plan({
      meta: {
        source: 'snapshot',
        timelineMessageIds: ['msg_user', 'msg_assistant'],
        segmentBackingMessageIds: ['msg_nested'],
        hydrationCoverage: 'deltaContinuityUnknown',
      },
      messages: [
        { ...message('msg_nested', 'assistant', 'nested'), messageIndex: 3 } as any,
        { ...message('msg_assistant', 'assistant', 'answer'), messageIndex: 2 } as any,
        {
          ...message('msg_user', 'user', 'system: prompt'),
          messageIndex: 1,
          order: 99,
        } as any,
      ],
    });
    expect(result.timeline).toEqual(['msg_user', 'msg_assistant']);
    expect(result.backingMessageIds).toEqual(['msg_nested']);
    expect(result.messages.slice(0, 2).map((item) => item.id))
      .toEqual(['msg_assistant', 'msg_user']);
    expect(result.messages.find((item) => item.id === 'msg_user')?.text).toBe('prompt');
    expect(result.messages.find((item) => item.id === 'msg_user')?.order).toBe(1);
    expect(result.messages.some((item) => 'messageIndex' in item)).toBe(false);
    expect(result.snapshotNoticeRequired).toBe(true);
    expect(result.coverage).toBe('deltaContinuityUnknown');
  });

  test('trusts only the extension-proved explicit suffix and does not append extra remote records', () => {
    const result = plan({
      meta: {
        timelineMessageIds: ['msg_snapshot', 'msg_proven_suffix'],
        hydrationCoverage: 'authoritativeHistoryComplete',
      },
      messages: [
        message('msg_remote_hidden', 'assistant'),
        message('msg_proven_suffix', 'assistant'),
        message('msg_snapshot', 'user'),
      ],
    });
    expect(result.timeline).toEqual(['msg_snapshot', 'msg_proven_suffix']);
    expect(result.messages.map((item) => item.id)).not.toContain('msg_remote_hidden');
    expect(result.coverage).toBe('authoritativeHistoryComplete');
  });

  test('materializes changelists through the stable planner at their canonical anchor', () => {
    const result = plan({
      meta: { timelineMessageIds: ['msg_user', 'msg_assistant'] },
      messages: [
        message('msg_user', 'user'),
        message('msg_assistant', 'assistant'),
        message('system:changeList:one', 'system', '', {
          kind: 'changeList',
          files: ['a.ts'],
          stableAnchorMessageId: 'msg_user',
        }),
      ],
    });
    expect(result.timeline).toEqual([
      'msg_user',
      'system:changeList:one',
      'msg_assistant',
    ]);
    expect(result.diagnostics.changeListCount).toBe(1);
  });

  test('uses stable segment normalization and replaces the canonical anchor with one placeholder', () => {
    const result = plan({
      meta: {
        timelineMessageIds: ['msg_a', 'msg_b', 'msg_c'],
        segmentBackingMessageIds: ['msg_a', 'msg_b'],
      },
      messages: [
        message('msg_a', 'user'),
        message('msg_b', 'assistant'),
        message('msg_c', 'user'),
      ],
      segments: [{
        noticeKey: 'undo:one',
        anchorMsgId: 'msg_a',
        endMsgId: 'msg_b',
        memberMsgIds: ['msg_a', 'msg_b'],
        applied: true,
      }],
    });
    expect(result.timeline).toEqual(['system:undo-seg:undo:one', 'msg_b', 'msg_c']);
    expect(result.segments).toEqual([
      expect.objectContaining({
        anchorMsgId: 'msg_a',
        endMsgId: 'msg_b',
        memberMsgIds: ['msg_a', 'msg_b'],
      }),
    ]);
    const placeholders = result.messages.filter(
      (item) => item.meta?.kind === 'undoSegmentPlaceholder',
    );
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0].meta.applied).toBeNull();
  });

  test('plans finalized append statuses through the stable append planner', () => {
    const result = plan({
      turnFullyFinalized: true,
      meta: { timelineMessageIds: ['msg_root'] },
      messages: [message('msg_root', 'user', 'root', {
        appendedPrompts: [
          { clientMessageId: 'c1', appendUserMsgId: 'msg_append', status: 'seen' },
          { clientMessageId: 'c2', status: 'queued' },
        ],
      })],
    });
    expect(result.appendRoots).toEqual([{
      rootMessageId: 'msg_root',
      finalized: true,
      items: [
        expect.objectContaining({ clientMessageId: 'c1', status: 'applied' }),
        expect.objectContaining({ clientMessageId: 'c2', status: 'failed' }),
      ],
    }]);
  });

  test('keeps background hydration selection-neutral while retaining render ownership', () => {
    expect(plan({
      activeSessionId: 'session-b',
      pendingExplicitSessionSelectionId: '',
    })).toMatchObject({
      selection: {
        shouldActivate: false,
        wasActive: false,
        explicitTarget: false,
        firstBootstrap: false,
      },
      render: { sessionId: 'session-a', onlyWhenActive: true },
    });
  });

  test('selects explicit targets and bootstraps only when there is no active session', () => {
    expect(plan({
      activeSessionId: 'session-b',
      pendingExplicitSessionSelectionId: 'session-a',
    }).selection).toMatchObject({ shouldActivate: true, explicitTarget: true });
    expect(plan({ activeSessionId: '' }).selection)
      .toMatchObject({ shouldActivate: true, firstBootstrap: true });
  });

  test('uses caller-provided collapsed fallback without importing omitted durable messages', () => {
    const visible = message('msg_visible', 'assistant');
    const omitted = message('msg_omitted', 'assistant');
    const result = plan({
      hasSegments: false,
      messages: [visible, omitted],
      fallbackDisplayMessages: [visible],
      meta: { hydrationCoverage: 'repairInProgress' },
    });
    expect(result.timeline).toEqual(['msg_visible']);
    expect(result.messages.map((item) => item.id)).toEqual(['msg_visible']);
    expect(result.coverage).toBe('repairInProgress');
    expect(result.reset.segments).toBe(false);
  });

  test('declares volatile collision ownership without resurrecting durable cache', () => {
    const result = plan({
      preservedVolatileMessageIds: ['local-user', 'tmp:assistant'],
      meta: { timelineMessageIds: ['msg_user', 'msg_assistant'] },
      messages: [
        message('msg_user', 'user'),
        message('msg_assistant', 'assistant'),
      ],
    });
    expect(result.preserve).toEqual({
      volatileState: true,
      durableCache: false,
      canonicalHydratedIdentityWins: true,
      candidateMessageIds: ['local-user', 'tmp:assistant'],
    });
  });

  test('is side-effect free and returns frozen decision collections', () => {
    const input: HydrationIntegrationInput = {
      sessionId: 'session-a',
      activeSessionId: 'session-a',
      hasSegments: false,
      messages: [message('msg_user', 'user')],
      meta: { timelineMessageIds: ['msg_user'] },
    };
    const before = JSON.stringify(input);
    const result = planHydrationIntegration(input, options);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.timeline)).toBe(true);
    expect(Object.isFrozen(result.messages)).toBe(true);
    expect(Object.isFrozen(result.preserve)).toBe(true);
  });

  test.each([
    ['authoritativeHistoryComplete', 'authoritativeHistoryComplete'],
    ['deltaContinuityUnknown', 'deltaContinuityUnknown'],
    ['repairInProgress', 'repairInProgress'],
    ['repairError', 'repairError'],
    ['invalid', 'deltaContinuityUnknown'],
    [undefined, 'deltaContinuityUnknown'],
  ])('normalizes coverage %s', (input, expected) => {
    expect(normalizeHydrationCoverage(input)).toBe(expected);
  });
});
