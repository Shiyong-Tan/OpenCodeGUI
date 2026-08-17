import { planFinalizedItems } from './append-alias-planner';
import { planChangeListMaterialization } from '../features/change-list/change-list-planner';

export type HydrationCoverage =
  | 'authoritativeHistoryComplete'
  | 'deltaContinuityUnknown'
  | 'repairInProgress'
  | 'repairError';

export type ForkOrigin = Readonly<{
  version: 1;
  parentSessionId: string;
  parentTitle: string;
  createdAt: number;
}>;

type HydrationMessage = Readonly<{
  id?: unknown;
  role?: unknown;
  text?: unknown;
  meta?: any;
  order?: unknown;
}>;

type HydrationSegment = Readonly<{
  noticeKey?: unknown;
  anchorMsgId?: unknown;
  endMsgId?: unknown;
  memberMsgIds?: unknown;
  applied?: unknown;
  restoreAllowed?: unknown;
  collapsed?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}>;

export type HydrationIntegrationInput = Readonly<{
  sessionId: string;
  activeSessionId?: string | null;
  pendingExplicitSessionSelectionId?: string | null;
  messages?: readonly HydrationMessage[];
  fallbackDisplayMessages?: readonly HydrationMessage[];
  segments?: readonly HydrationSegment[];
  hasSegments: boolean;
  meta?: Readonly<{
    source?: unknown;
    timelineMessageIds?: readonly unknown[];
    segmentBackingMessageIds?: readonly unknown[];
    hydrationCoverage?: unknown;
    forkOrigin?: unknown;
  }>;
  turnFullyFinalized?: boolean;
  preservedVolatileMessageIds?: readonly string[];
  clientKeyToServerId?: ReadonlyMap<string, string>;
  serverIdToClientKey?: ReadonlyMap<string, string>;
}>;

export type HydrationIntegrationPlannerOptions = Readonly<{
  isHiddenControlUserText(text: string): boolean;
  isHiddenControlAssistantText(text: string): boolean;
  cleanUserText(text: string): string;
  toStableMessageKey(messageId: string): string | null | undefined;
  normalizeSegment(
    timeline: readonly string[],
    segment: HydrationSegment,
  ): Readonly<{ anchorMsgId: string | null; endMsgId: string | null; memberMsgIds: readonly string[] }>;
  normalizeAppendItems?(rootMessageId: string, items: readonly any[]): readonly any[];
}>;

export type HydrationIntegrationPlan = Readonly<{
  accepted: boolean;
  reason: 'planned' | 'missing-session';
  selection: Readonly<{
    shouldActivate: boolean;
    wasActive: boolean;
    explicitTarget: boolean;
    firstBootstrap: boolean;
  }>;
  coverage: HydrationCoverage;
  forkOrigin: ForkOrigin | null;
  reset: Readonly<{
    messages: true;
    timeline: true;
    segments: boolean;
    volatileTurnFields: true;
  }>;
  messages: readonly any[];
  timeline: readonly string[];
  nextOrder: number;
  backingMessageIds: readonly string[];
  hiddenControlUserIds: readonly string[];
  segments: readonly any[];
  appendRoots: readonly Readonly<{ rootMessageId: string; items: readonly any[]; finalized: boolean }>[];
  snapshotNoticeRequired: boolean;
  preserve: Readonly<{
    volatileState: true;
    durableCache: false;
    canonicalHydratedIdentityWins: true;
    candidateMessageIds: readonly string[];
  }>;
  render: Readonly<{
    sessionId: string;
    onlyWhenActive: true;
    reason: 'sessionData';
    scrollToBottomAfterRender: true;
  }>;
  diagnostics: Readonly<{
    explicitTimeline: boolean;
    timelineMessageCount: number;
    backingMessageCount: number;
    changeListCount: number;
    segmentCount: number;
    appendRootCount: number;
    skippedMessageIds: readonly string[];
  }>;
}>;

const freezeArray = <T>(values: readonly T[]): readonly T[] => Object.freeze([...values]);
const validCoverage = new Set<HydrationCoverage>([
  'authoritativeHistoryComplete',
  'deltaContinuityUnknown',
  'repairInProgress',
  'repairError',
]);

export function normalizeHydrationCoverage(value: unknown): HydrationCoverage {
  return typeof value === 'string' && validCoverage.has(value as HydrationCoverage)
    ? value as HydrationCoverage
    : 'deltaContinuityUnknown';
}

export function normalizeForkOrigin(value: unknown): ForkOrigin | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const parentSessionId = typeof candidate.parentSessionId === 'string'
    ? candidate.parentSessionId.trim()
    : '';
  if (!parentSessionId) return null;
  const parentTitle = typeof candidate.parentTitle === 'string' && candidate.parentTitle.trim()
    ? candidate.parentTitle.trim()
    : 'Parent session';
  const createdAt = typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)
    ? candidate.createdAt
    : 0;
  return Object.freeze({ version: 1, parentSessionId, parentTitle, createdAt });
}

export function planHydrationIntegration(
  input: HydrationIntegrationInput,
  options: HydrationIntegrationPlannerOptions,
): HydrationIntegrationPlan {
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
  const wasActive = Boolean(sessionId && input.activeSessionId === sessionId);
  const explicitTarget = Boolean(
    sessionId && input.pendingExplicitSessionSelectionId === sessionId,
  );
  const firstBootstrap = Boolean(sessionId && !input.activeSessionId);
  const selection = Object.freeze({
    shouldActivate: wasActive || explicitTarget || firstBootstrap,
    wasActive,
    explicitTarget,
    firstBootstrap,
  });
  const coverage = normalizeHydrationCoverage(input.meta?.hydrationCoverage);
  const forkOrigin = normalizeForkOrigin(input.meta?.forkOrigin);
  const emptyPlan = {
    accepted: false,
    reason: 'missing-session' as const,
    selection,
    coverage,
    forkOrigin,
    reset: Object.freeze({
      messages: true as const,
      timeline: true as const,
      segments: input.hasSegments === true,
      volatileTurnFields: true as const,
    }),
    messages: Object.freeze([]),
    timeline: Object.freeze([]),
    nextOrder: 0,
    backingMessageIds: Object.freeze([]),
    hiddenControlUserIds: Object.freeze([]),
    segments: Object.freeze([]),
    appendRoots: Object.freeze([]),
    snapshotNoticeRequired: input.meta?.source === 'snapshot' && !forkOrigin,
    preserve: Object.freeze({
      volatileState: true as const,
      durableCache: false as const,
      canonicalHydratedIdentityWins: true as const,
      candidateMessageIds: freezeArray(input.preservedVolatileMessageIds || []),
    }),
    render: Object.freeze({
      sessionId,
      onlyWhenActive: true as const,
      reason: 'sessionData' as const,
      scrollToBottomAfterRender: true as const,
    }),
    diagnostics: Object.freeze({
      explicitTimeline: false,
      timelineMessageCount: 0,
      backingMessageCount: 0,
      changeListCount: 0,
      segmentCount: 0,
      appendRootCount: 0,
      skippedMessageIds: Object.freeze([]),
    }),
  };
  if (!sessionId) return Object.freeze(emptyPlan);

  const rawMessages = Array.isArray(input.messages) ? input.messages : [];
  const rawById = new Map<string, HydrationMessage>();
  for (const message of rawMessages) {
    if (typeof message?.id === 'string' && message.id && !rawById.has(message.id)) {
      rawById.set(message.id, message);
    }
  }
  const hiddenControlUserIds = rawMessages
    .filter((message) => (
      typeof message?.id === 'string'
      && message.role === 'user'
      && options.isHiddenControlUserText(typeof message.text === 'string' ? message.text : '')
    ))
    .map((message) => message.id as string);
  const skippedMessageIds: string[] = [];
  let nextOrder = 0;
  const normalizeMessage = (
    message: HydrationMessage | undefined,
    behavior: Readonly<{ filterControl: boolean; assignOrder: boolean }> = {
      filterControl: true,
      assignOrder: true,
    },
  ): any | null => {
    if (!message || typeof message.id !== 'string' || !message.id) return null;
    let role = typeof message.role === 'string' && message.role ? message.role : '';
    if (!role) {
      if (message.id.startsWith('msg_')) role = 'assistant';
      else if (message.id.startsWith('system:')) role = 'system';
      else {
        skippedMessageIds.push(message.id);
        return null;
      }
    }
    const rawText = typeof message.text === 'string' ? message.text : '';
    if (behavior.filterControl && (
      (role === 'user' && options.isHiddenControlUserText(rawText))
      || (role === 'assistant' && options.isHiddenControlAssistantText(rawText))
    )) {
      skippedMessageIds.push(message.id);
      return null;
    }
    const normalized = {
      id: message.id,
      role,
      text: role === 'user' ? options.cleanUserText(rawText) : rawText,
      meta: message.meta && typeof message.meta === 'object'
        ? Object.freeze({ ...message.meta })
        : Object.freeze({}),
    };
    return Object.freeze(behavior.assignOrder
      ? {
        ...normalized,
        order: nextOrder++,
      }
      : normalized);
  };

  const explicitTimelineIds = Array.isArray(input.meta?.timelineMessageIds)
    ? input.meta!.timelineMessageIds!
      .filter((id): id is string => typeof id === 'string' && Boolean(id))
    : [];
  const hasExplicitTimeline = explicitTimelineIds.length > 0;
  const displaySource = hasExplicitTimeline
    ? rawMessages.filter((message) => (
      typeof message?.id === 'string' && explicitTimelineIds.includes(message.id)
    ))
    : (
      input.meta?.source === 'snapshot'
        ? rawMessages
        : (Array.isArray(input.fallbackDisplayMessages) ? input.fallbackDisplayMessages : rawMessages)
    );
  const messagesById = new Map<string, any>();
  const timeline: string[] = [];
  for (const candidate of displaySource) {
    const message = normalizeMessage(candidate);
    if (!message || messagesById.has(message.id)) continue;
    messagesById.set(message.id, message);
    timeline.push(message.id);
  }
  if (hasExplicitTimeline) {
    const retained = new Set(timeline);
    timeline.splice(0, timeline.length, ...explicitTimelineIds.filter((id) => (
      retained.has(id) || id.startsWith('system:undo-seg:')
    )));
  }

  const backingIds = new Set(
    Array.isArray(input.meta?.segmentBackingMessageIds)
      ? input.meta!.segmentBackingMessageIds!
        .filter((id): id is string => typeof id === 'string' && Boolean(id))
      : [],
  );
  const backingMessageIds: string[] = [];
  if (hasExplicitTimeline) {
    for (const id of backingIds) {
      if (messagesById.has(id) || explicitTimelineIds.includes(id)) continue;
      const message = normalizeMessage(rawById.get(id), {
        filterControl: false,
        assignOrder: false,
      });
      if (!message) continue;
      messagesById.set(id, message);
      backingMessageIds.push(id);
    }
  }

  const changeListPlan = planChangeListMaterialization({
    rawMessages,
    messagesById,
    timeline,
    nextOrder,
    toStableMessageKey: options.toStableMessageKey,
  });
  for (const message of changeListPlan.messages) messagesById.set(message.id, message);
  const plannedTimeline = [...changeListPlan.timeline];

  const segmentPlans: any[] = [];
  if (input.hasSegments) {
    for (const segment of Array.isArray(input.segments) ? input.segments : []) {
      if (typeof segment?.noticeKey !== 'string' || !segment.noticeKey) continue;
      const normalized = options.normalizeSegment(plannedTimeline, segment);
      if (!normalized.anchorMsgId || normalized.memberMsgIds.length === 0) continue;
      const memberMsgIds = freezeArray(normalized.memberMsgIds);
      const plannedSegment = Object.freeze({
        ...segment,
        noticeKey: segment.noticeKey,
        anchorMsgId: memberMsgIds[0] || normalized.anchorMsgId,
        endMsgId: memberMsgIds[memberMsgIds.length - 1] || normalized.endMsgId,
        memberMsgIds,
        collapsed: true,
        restoreAllowed: segment.restoreAllowed === true,
      });
      segmentPlans.push(plannedSegment);
      const placeholderId = `system:undo-seg:${segment.noticeKey}`;
      const existingSlot = plannedTimeline.indexOf(placeholderId);
      const anchorIndex = existingSlot >= 0
        ? existingSlot
        : plannedTimeline.indexOf(plannedSegment.anchorMsgId);
      if (anchorIndex < 0) continue;
      plannedTimeline[anchorIndex] = placeholderId;
      if (!messagesById.has(placeholderId)) {
        messagesById.set(placeholderId, Object.freeze({
          id: placeholderId,
          role: 'system',
          text: '',
          meta: Object.freeze({
            kind: 'undoSegmentPlaceholder',
            noticeKey: segment.noticeKey,
            anchorMsgId: plannedSegment.anchorMsgId,
            endMsgId: plannedSegment.endMsgId,
            // Legacy hydration intentionally drops the persisted applied flag
            // before rebuilding placeholders, so the hydrated placeholder
            // always receives the neutral value.
            applied: null,
            createdAt: typeof segment.createdAt === 'number' ? segment.createdAt : null,
          }),
        }));
      }
    }
  }

  const appendRoots: Array<Readonly<{
    rootMessageId: string;
    items: readonly any[];
    finalized: boolean;
  }>> = [];
  const claimedAppendUserIds = new Set<string>();
  for (const message of messagesById.values()) {
    if (message?.role !== 'user' || !Array.isArray(message.meta?.appendedPrompts)) continue;
    for (const item of message.meta.appendedPrompts) {
      if (typeof item?.appendUserMsgId === 'string' && item.appendUserMsgId.startsWith('msg_')) {
        claimedAppendUserIds.add(item.appendUserMsgId);
      }
    }
  }
  for (const [id, message] of messagesById) {
    if (message?.role !== 'user' || !Array.isArray(message.meta?.appendedPrompts)) continue;
    let normalizedItems = options.normalizeAppendItems
      ? options.normalizeAppendItems(id, message.meta.appendedPrompts)
      : message.meta.appendedPrompts;
    if (input.turnFullyFinalized !== true) {
      normalizedItems = normalizedItems.map((item: any) => {
        if (typeof item?.appendUserMsgId === 'string' && item.appendUserMsgId.startsWith('msg_')) {
          return item;
        }
        const appendText = typeof item?.text === 'string' ? item.text.trim() : '';
        if (!appendText) return item;
        const candidates = plannedTimeline.filter((candidateId) => {
          if (candidateId === id || claimedAppendUserIds.has(candidateId)) return false;
          const candidate = messagesById.get(candidateId);
          return candidate?.role === 'user'
            && typeof candidate.text === 'string'
            && candidate.text.trim() === appendText;
        });
        // Repair only an exact, unique active-turn match. Ambiguous repeated
        // prompts remain unbound rather than risking a false append owner.
        if (candidates.length !== 1) return item;
        claimedAppendUserIds.add(candidates[0]);
        return Object.freeze({ ...item, appendUserMsgId: candidates[0] });
      });
    }
    const finalized = input.turnFullyFinalized === true;
    const appendPlan = finalized
      ? planFinalizedItems(normalizedItems)
      : { items: freezeArray(normalizedItems.map((item: any) => Object.freeze({ ...item }))) };
    if (!appendPlan.items.length) continue;
    appendRoots.push(Object.freeze({
      rootMessageId: id,
      items: freezeArray(appendPlan.items),
      finalized,
    }));
  }

  const plan: HydrationIntegrationPlan = {
    accepted: true,
    reason: 'planned',
    selection,
    coverage,
    forkOrigin,
    reset: Object.freeze({
      messages: true,
      timeline: true,
      segments: input.hasSegments === true,
      volatileTurnFields: true,
    }),
    messages: freezeArray([...messagesById.values()]),
    timeline: freezeArray(plannedTimeline),
    nextOrder: changeListPlan.nextOrder,
    backingMessageIds: freezeArray(backingMessageIds),
    hiddenControlUserIds: freezeArray(hiddenControlUserIds),
    segments: freezeArray(segmentPlans),
    appendRoots: freezeArray(appendRoots),
    snapshotNoticeRequired: input.meta?.source === 'snapshot' && !forkOrigin,
    preserve: Object.freeze({
      volatileState: true,
      durableCache: false,
      canonicalHydratedIdentityWins: true,
      candidateMessageIds: freezeArray(input.preservedVolatileMessageIds || []),
    }),
    render: Object.freeze({
      sessionId,
      onlyWhenActive: true,
      reason: 'sessionData',
      scrollToBottomAfterRender: true,
    }),
    diagnostics: Object.freeze({
      explicitTimeline: hasExplicitTimeline,
      timelineMessageCount: plannedTimeline.length,
      backingMessageCount: backingMessageIds.length,
      changeListCount: changeListPlan.stats.seen,
      segmentCount: segmentPlans.length,
      appendRootCount: appendRoots.length,
      skippedMessageIds: freezeArray(skippedMessageIds),
    }),
  };
  return Object.freeze(plan);
}
