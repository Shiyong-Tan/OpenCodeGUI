import {
  planHydrationIntegration,
  type HydrationIntegrationInput,
  type HydrationIntegrationPlan,
  type HydrationIntegrationPlannerOptions,
} from './hydration-integration-planner';

type HydrationStateControllerOptions = {
  toStableMessageKey(session: any, key: string): string | null;
  now?(): number;
};

export function createHydrationStateController(options: HydrationStateControllerOptions) {
  const cloneMap = (value: any) => value instanceof Map ? new Map(value) : new Map();
  const cloneSet = (value: any) => value instanceof Set ? new Set(value) : new Set();
  const clonePlainValue = (value: any) => {
    if (value && typeof value === 'object') return Array.isArray(value) ? value.slice() : { ...value };
    return value;
  };
  const cloneMessage = (message: any) => {
    if (!message || typeof message !== 'object') return message;
    return { ...message, meta: message.meta && typeof message.meta === 'object' ? { ...message.meta } : message.meta };
  };
  const cloneActiveSubagents = (value: any) => Array.isArray(value)
    ? value.filter((agent) => agent && typeof agent === 'object').map((agent) => ({ ...agent }))
    : [];
  const isPersistenceArtifact = (id: unknown, message: any) => {
    if (typeof id === 'string' && (id.startsWith('system:snapshot:') || id.startsWith('system:changeList:'))) return true;
    const kind = message?.meta?.kind;
    return kind === 'snapshotNotice' || kind === 'changeList';
  };
  const findMappedMessageId = (map: any, key: unknown, matchValue = false): string | null => {
    if (!(map instanceof Map) || typeof key !== 'string' || !key.length) return null;
    if (!matchValue) {
      const mapped = map.get(key);
      return typeof mapped === 'string' && mapped.startsWith('msg_') ? mapped : null;
    }
    for (const [mapped, value] of map.entries()) {
      if (value === key && typeof mapped === 'string' && mapped.startsWith('msg_')) return mapped;
    }
    return null;
  };

  function resolveCanonicalId(session: any, preserved: any, id: unknown, message: any): string | null {
    if (typeof id !== 'string' || !id.length) return null;
    if (id.startsWith('msg_')) return id;
    if (id.startsWith('local-')) {
      return findMappedMessageId(preserved?.clientKeyToServerId, id)
        || findMappedMessageId(session?.clientKeyToServerId, id)
        || findMappedMessageId(preserved?.serverIdToClientKey, id, true)
        || findMappedMessageId(session?.serverIdToClientKey, id, true)
        || findMappedMessageId(preserved?.serverIdToKey, id, true)
        || findMappedMessageId(session?.serverIdToKey, id, true)
        || options.toStableMessageKey(session, id)
        || null;
    }
    if (id.startsWith('tmp:')) {
      const preservedPending = preserved?.pendingAssistantUpgrade;
      const sessionPending = session?.pendingAssistantUpgrade;
      const pendingAssistantId =
        (preservedPending?.tmpKey === id && typeof preservedPending.assistantMsgId === 'string' && preservedPending.assistantMsgId.startsWith('msg_') && preservedPending.assistantMsgId)
        || (sessionPending?.tmpKey === id && typeof sessionPending.assistantMsgId === 'string' && sessionPending.assistantMsgId.startsWith('msg_') && sessionPending.assistantMsgId)
        || null;
      if (pendingAssistantId) return pendingAssistantId;
      const finalAssistantId =
        (typeof preserved?.finalAssistantLock?.assistantMsgId === 'string' && preserved.finalAssistantLock.assistantMsgId.startsWith('msg_') && preserved.finalAssistantLock.assistantMsgId)
        || (typeof session?.finalAssistantLock?.assistantMsgId === 'string' && session.finalAssistantLock.assistantMsgId.startsWith('msg_') && session.finalAssistantLock.assistantMsgId)
        || (typeof preserved?.earlyFinalAssistantId === 'string' && preserved.earlyFinalAssistantId.startsWith('msg_') && preserved.earlyFinalAssistantId)
        || (typeof session?.earlyFinalAssistantId === 'string' && session.earlyFinalAssistantId.startsWith('msg_') && session.earlyFinalAssistantId)
        || null;
      if (message?.role === 'assistant' && finalAssistantId) return finalAssistantId;
    }
    return null;
  }

  function capture(session: any): any | null {
    if (!session) return null;
    const hasLifecycle = Boolean(session.turnLifecycle?.phase);
    const activeTurn = (hasLifecycle
      ? session.turnLifecycle.phase === 'active'
      : session.backendTurnInFlight === true && session.turnFullyFinalized === false)
      && session.cancelledTurn !== true && session.canceledActiveTurn !== true;
    return {
      messagesById: cloneMap(session.messagesById),
      timeline: Array.isArray(session.timeline) ? session.timeline.slice() : [],
      messageIndexMap: cloneMap(session.messageIndexMap),
      serverIdToKey: cloneMap(session.serverIdToKey),
      clientKeyToServerId: cloneMap(session.clientKeyToServerId),
      serverIdToClientKey: cloneMap(session.serverIdToClientKey),
      hiddenControlUserIds: cloneSet(session.hiddenControlUserIds),
      assistantUpgradeSeen: cloneSet(session.assistantUpgradeSeen),
      pendingAssistantUpgrade: clonePlainValue(session.pendingAssistantUpgrade),
      finalAssistantLock: clonePlainValue(session.finalAssistantLock),
      thinkingId: session.thinkingId,
      currentTurnAssistantKey: session.currentTurnAssistantKey,
      currentTurnAssistantMsgId: session.currentTurnAssistantMsgId,
      lastTurnUserId: session.lastTurnUserId,
      lastTurnAssistantId: session.lastTurnAssistantId,
      cancelledTurn: session.cancelledTurn,
      canceledActiveTurn: session.canceledActiveTurn,
      activeTurnOpId: session.activeTurnOpId,
      backendTurnInFlight: session.backendTurnInFlight,
      awaitingFinalMapBind: session.awaitingFinalMapBind,
      streamMode: session.streamMode,
      earlyFinalAssistantId: session.earlyFinalAssistantId,
      turnFullyFinalized: session.turnFullyFinalized,
      turnLifecycle: clonePlainValue(
        session.turnLifecycle
        || (activeTurn
          ? {
            generation: 0,
            phase: 'active',
            backendInFlight: true,
            canonicalAssistantId: null,
          }
          : undefined),
      ),
      appendFollowupIdentity: clonePlainValue(session.appendFollowupIdentity),
      appendRootUserKey: session.appendRootUserKey,
      appendComposerFor: session.appendComposerFor,
      appendComposerDrafts: cloneMap(session.appendComposerDrafts),
      inputDraft: session.inputDraft,
      backgroundSubagentIndicatorVisible: session.backgroundSubagentIndicatorVisible,
      backgroundSubagentIndicatorUntil: session.backgroundSubagentIndicatorUntil,
      backgroundSubagentIndicatorAnchorId: session.backgroundSubagentIndicatorAnchorId,
      ...(activeTurn && Array.isArray(session.activeSubagents) && session.activeSubagents.length
        ? { activeSubagents: cloneActiveSubagents(session.activeSubagents) }
        : {}),
    };
  }

  function restore(session: any, preserved: any) {
    const empty = {
      missingIds: [],
      mergedIds: [],
      fieldNames: [],
      skippedArtifacts: { timeline: 0, backing: 0 },
      skippedCanonicalizedVolatile: { timeline: 0, backing: 0, fields: 0 },
      skippedDurable: { timeline: 0, backing: 0 },
    };
    if (!session || !preserved) return empty;
    const hydratedIds = new Set(Array.isArray(session.timeline) ? session.timeline : []);
    const hydratedBackingIds = new Set(session.messagesById instanceof Map ? session.messagesById.keys() : []);
    const missingIds: string[] = [];
    const mergedIds: string[] = [];
    const skippedArtifacts = { timeline: 0, backing: 0 };
    const skippedCanonicalizedVolatile = { timeline: 0, backing: 0, fields: 0 };
    const skippedDurable = { timeline: 0, backing: 0 };
    let hasCanonicalizedVolatileDuplicate = false;
    const preservedTurnIsActive = preserved.turnLifecycle?.phase
      ? preserved.turnLifecycle.phase === 'active'
      : preserved.backendTurnInFlight === true && preserved.turnFullyFinalized === false;
    const activeMessageIds = new Set([
      preserved.thinkingId,
      preserved.currentTurnAssistantKey,
      preserved.currentTurnAssistantMsgId,
      preserved.lastTurnUserId,
      preserved.lastTurnAssistantId,
      preserved.appendRootUserKey,
      preserved.pendingAssistantUpgrade?.tmpKey,
      preserved.pendingAssistantUpgrade?.assistantMsgId,
      preserved.appendFollowupIdentity?.predecessorAssistantMsgId,
      preserved.appendFollowupIdentity?.appendUserMsgId,
      preserved.appendFollowupIdentity?.assistantMsgId,
    ].filter((id) => typeof id === 'string' && id.length));
    const mergeCollidingActiveMessage = (id: string, preservedMessage: any) => {
      if (!preservedTurnIsActive || !activeMessageIds.has(id) || !preservedMessage) return;
      const hydratedMessage = session.messagesById.get(id);
      if (!hydratedMessage || hydratedMessage.role !== preservedMessage.role) return;
      const preservedMeta = preservedMessage.meta && typeof preservedMessage.meta === 'object' ? preservedMessage.meta : {};
      const hydratedMeta = hydratedMessage.meta && typeof hydratedMessage.meta === 'object' ? hydratedMessage.meta : {};
      const preservedText = typeof preservedMessage.text === 'string' ? preservedMessage.text : '';
      const hydratedText = typeof hydratedMessage.text === 'string' ? hydratedMessage.text : '';
      const shouldKeepLiveAssistantMeta = preservedMessage.role === 'assistant';
      const hasLivePresentationRevision = shouldKeepLiveAssistantMeta
        && Number.isFinite(preservedMeta.volatilePresentationRevision)
        && preservedMeta.volatilePresentationRevision > 0;
      const shouldKeepLiveText = shouldKeepLiveAssistantMeta
        && (hasLivePresentationRevision || preservedText.length >= hydratedText.length);
      const shouldKeepAppendMeta = preservedMessage.role === 'user' && Array.isArray(preservedMeta.appendedPrompts);
      if (!shouldKeepLiveAssistantMeta && !shouldKeepAppendMeta) return;
      session.messagesById.set(id, {
        ...hydratedMessage,
        ...(shouldKeepLiveText ? { text: preservedText } : {}),
        meta: {
          ...hydratedMeta,
          ...(shouldKeepLiveAssistantMeta ? preservedMeta : {}),
          ...(shouldKeepAppendMeta ? { appendedPrompts: preservedMeta.appendedPrompts } : {}),
        },
      });
      mergedIds.push(id);
    };
    const isHydrated = (id: unknown) => typeof id === 'string' && (hydratedIds.has(id) || hydratedBackingIds.has(id));
    const canonicalizedHydratedId = (id: unknown, message: any) => {
      if (typeof id !== 'string' || (!id.startsWith('local-') && !id.startsWith('tmp:'))) return null;
      const canonicalId = resolveCanonicalId(session, preserved, id, message);
      return canonicalId && canonicalId.startsWith('msg_') && isHydrated(canonicalId) ? canonicalId : null;
    };
    for (const id of preserved.timeline) {
      if (typeof id !== 'string' || !id.length || hydratedIds.has(id)) continue;
      const preservedMessage = preserved.messagesById.get(id);
      if (!preservedMessage) continue;
      if (isPersistenceArtifact(id, preservedMessage)) {
        skippedArtifacts.timeline++;
        continue;
      }
      if (!preservedTurnIsActive || !activeMessageIds.has(id)) {
        skippedDurable.timeline++;
        continue;
      }
      if (canonicalizedHydratedId(id, preservedMessage)) {
        skippedCanonicalizedVolatile.timeline++;
        hasCanonicalizedVolatileDuplicate = true;
        continue;
      }
      session.messagesById.set(id, cloneMessage(preservedMessage));
      session.timeline.push(id);
      hydratedIds.add(id);
      hydratedBackingIds.add(id);
      missingIds.push(id);
    }
    for (const [id, preservedMessage] of preserved.messagesById.entries()) {
      if (!id) continue;
      if (session.messagesById.has(id)) {
        mergeCollidingActiveMessage(id, preservedMessage);
        continue;
      }
      if (isPersistenceArtifact(id, preservedMessage)) {
        skippedArtifacts.backing++;
        continue;
      }
      if (!preservedTurnIsActive || !activeMessageIds.has(id)) {
        skippedDurable.backing++;
        continue;
      }
      if (canonicalizedHydratedId(id, preservedMessage)) {
        skippedCanonicalizedVolatile.backing++;
        hasCanonicalizedVolatileDuplicate = true;
        continue;
      }
      session.messagesById.set(id, cloneMessage(preservedMessage));
      hydratedBackingIds.add(id);
    }
    const fieldNames: string[] = [];
    const fieldReferencesCanonicalHydratedVolatile = (value: any) => {
      if (typeof value === 'string') return Boolean(canonicalizedHydratedId(value, preserved.messagesById.get(value)));
      if (value && typeof value === 'object') {
        for (const candidate of [value.tmpKey, value.localKey, value.messageId, value.msgId, value.assistantMsgId, value.userMsgId, value.rootUserMessageId]) {
          if (typeof candidate === 'string' && canonicalizedHydratedId(candidate, preserved.messagesById.get(candidate))) return true;
        }
      }
      return false;
    };
    const shouldSkipStaleInFlightField = (name: string) => {
      if (!hasCanonicalizedVolatileDuplicate) return false;
      const fields = new Set(['pendingAssistantUpgrade', 'thinkingId', 'currentTurnAssistantKey', 'currentTurnAssistantMsgId', 'lastTurnUserId', 'lastTurnAssistantId', 'activeTurnOpId', 'awaitingFinalMapBind', 'streamMode', 'appendRootUserKey', 'turnLifecycle']);
      if (!fields.has(name)) return false;
      if (fieldReferencesCanonicalHydratedVolatile(preserved[name])) return true;
      return ['activeTurnOpId', 'awaitingFinalMapBind', 'streamMode', 'turnLifecycle'].includes(name)
        && session.turnFullyFinalized !== false && session.backendTurnInFlight !== true;
    };
    const preserveField = (name: string, shouldPreserve: boolean) => {
      if (!shouldPreserve) return;
      if (shouldSkipStaleInFlightField(name)) {
        skippedCanonicalizedVolatile.fields++;
        return;
      }
      session[name] = clonePlainValue(preserved[name]);
      fieldNames.push(name);
    };
    preserveField('pendingAssistantUpgrade', Boolean(preserved.pendingAssistantUpgrade));
    preserveField('thinkingId', Boolean(preserved.thinkingId));
    preserveField('currentTurnAssistantKey', Boolean(preserved.currentTurnAssistantKey));
    preserveField('currentTurnAssistantMsgId', Boolean(preserved.currentTurnAssistantMsgId));
    preserveField('lastTurnUserId', Boolean(preserved.lastTurnUserId));
    preserveField('lastTurnAssistantId', Boolean(preserved.lastTurnAssistantId));
    preserveField('cancelledTurn', preserved.cancelledTurn === true);
    preserveField('canceledActiveTurn', preserved.canceledActiveTurn === true);
    preserveField('activeTurnOpId', Boolean(preserved.activeTurnOpId));
    preserveField('awaitingFinalMapBind', preserved.awaitingFinalMapBind === true);
    preserveField('streamMode', Boolean(preserved.streamMode));
    preserveField('earlyFinalAssistantId', Boolean(preserved.earlyFinalAssistantId));
    preserveField('turnLifecycle', preservedTurnIsActive && Boolean(preserved.turnLifecycle));
    preserveField(
      'appendFollowupIdentity',
      preservedTurnIsActive && Boolean(preserved.appendFollowupIdentity),
    );
    preserveField('appendRootUserKey', Boolean(preserved.appendRootUserKey));
    preserveField('appendComposerFor', Boolean(preserved.appendComposerFor));
    preserveField('inputDraft', typeof preserved.inputDraft === 'string' && preserved.inputDraft.length > 0);
    preserveField('backgroundSubagentIndicatorVisible', preserved.backgroundSubagentIndicatorVisible === true);
    preserveField('backgroundSubagentIndicatorUntil', typeof preserved.backgroundSubagentIndicatorUntil === 'number' && preserved.backgroundSubagentIndicatorUntil > (options.now?.() ?? Date.now()));
    preserveField('backgroundSubagentIndicatorAnchorId', Boolean(preserved.backgroundSubagentIndicatorAnchorId));
    if (preservedTurnIsActive && Array.isArray(preserved.activeSubagents) && preserved.activeSubagents.length
      && !Array.isArray(session.activeSubagents)) {
      session.activeSubagents = cloneActiveSubagents(preserved.activeSubagents);
      fieldNames.push('activeSubagents');
    }
    if (preserved.messageIndexMap.size) {
      if (!(session.messageIndexMap instanceof Map)) session.messageIndexMap = new Map();
      for (const [key, value] of preserved.messageIndexMap.entries()) if (!session.messageIndexMap.has(key)) session.messageIndexMap.set(key, value);
      fieldNames.push('messageIndexMap');
    }
    for (const [name, preservedMap] of [
      ['serverIdToKey', preserved.serverIdToKey], ['clientKeyToServerId', preserved.clientKeyToServerId],
      ['serverIdToClientKey', preserved.serverIdToClientKey], ['appendComposerDrafts', preserved.appendComposerDrafts],
    ] as Array<[string, Map<any, any>]>) {
      if (!preservedMap.size) continue;
      if (!(session[name] instanceof Map)) session[name] = new Map();
      for (const [key, value] of preservedMap.entries()) if (!session[name].has(key)) session[name].set(key, value);
      fieldNames.push(name);
    }
    for (const [name, preservedSet] of [
      ['hiddenControlUserIds', preserved.hiddenControlUserIds], ['assistantUpgradeSeen', preserved.assistantUpgradeSeen],
    ] as Array<[string, Set<any>]>) {
      if (!preservedSet.size) continue;
      if (!(session[name] instanceof Set)) session[name] = new Set();
      for (const value of preservedSet.values()) session[name].add(value);
      fieldNames.push(name);
    }
    return {
      missingIds,
      mergedIds: Array.from(new Set(mergedIds)),
      fieldNames: Array.from(new Set(fieldNames)),
      skippedArtifacts,
      skippedCanonicalizedVolatile,
      skippedDurable,
    };
  }

  const cloneShadowMessage = (message: any) => ({
    ...message,
    meta: message?.meta && typeof message.meta === 'object' ? { ...message.meta } : {},
  });

  function prepareIntegration(
    input: HydrationIntegrationInput,
    plannerOptions: HydrationIntegrationPlannerOptions,
    preserved: any,
  ): Readonly<{ plan: HydrationIntegrationPlan; state: any; preservedResult: any }> {
    const plan = planHydrationIntegration(input, plannerOptions);
    const state: any = {
      hydrationCoverage: plan.coverage,
      messagesById: new Map(),
      timeline: [...plan.timeline],
      nextOrder: plan.nextOrder,
      messageIndexMap: new Map(),
      segmentsByNoticeKey: new Map(),
      hiddenSet: new Set(),
      hiddenControlUserIds: new Set(plan.hiddenControlUserIds),
      assistantUpgradeSeen: new Set(),
      serverIdToKey: new Map(),
      clientKeyToServerId: new Map(),
      serverIdToClientKey: new Map(),
      appendComposerDrafts: new Map(),
      thinkingId: null,
      currentTurnAssistantKey: null,
      currentTurnAssistantMsgId: null,
      lastTurnUserId: null,
      lastTurnAssistantId: null,
      cancelledTurn: false,
      canceledActiveTurn: false,
      activeTurnOpId: null,
      backendTurnInFlight: false,
      pendingAssistantUpgrade: null,
      awaitingFinalMapBind: false,
      streamMode: null,
      earlyFinalAssistantId: null,
      turnFullyFinalized: true,
      appendRootUserKey: null,
      appendComposerFor: null,
      inputDraft: '',
      backgroundSubagentIndicatorVisible: false,
      backgroundSubagentIndicatorUntil: 0,
      backgroundSubagentIndicatorAnchorId: null,
      turnLifecycle: {
        generation: typeof preserved?.turnLifecycle?.generation === 'number'
          ? preserved.turnLifecycle.generation
          : 0,
        phase: 'effects-finalized',
        backendInFlight: false,
        canonicalAssistantId: null,
      },
      finalAssistantLock: null,
      appendFollowupIdentity: null,
    };
    if (!plan.accepted) return Object.freeze({ plan, state, preservedResult: restore(null, null) });
    for (const message of plan.messages) state.messagesById.set(message.id, cloneShadowMessage(message));
    for (const segment of plan.segments) {
      state.segmentsByNoticeKey.set(segment.noticeKey, {
        noticeKey: segment.noticeKey,
        anchorMsgId: segment.anchorMsgId,
        endMsgId: segment.endMsgId,
        memberMsgIds: [...segment.memberMsgIds],
        mergedInvalidSegments: Array.isArray(segment.mergedInvalidSegments)
          ? segment.mergedInvalidSegments.map((child: any) => ({
            ...child,
            memberMsgIds: Array.isArray(child?.memberMsgIds) ? [...child.memberMsgIds] : [],
          }))
          : [],
        restoreAllowed: segment.restoreAllowed === true,
        collapsed: true,
        createdAt: typeof segment.createdAt === 'number'
          ? segment.createdAt
          : (options.now?.() ?? Date.now()),
      });
      if (segment.collapsed === false) continue;
      for (const id of segment.memberMsgIds) {
        if (state.messagesById.has(id)) state.hiddenSet.add(id);
      }
    }
    for (const id of state.timeline) {
      const message = state.messagesById.get(id);
      if (message?.role === 'user' && message.meta?.syntheticUser === true) {
        state.hiddenSet.add(id);
      }
    }
    for (const root of plan.appendRoots) {
      const message = state.messagesById.get(root.rootMessageId);
      if (!message) continue;
      message.meta = { ...(message.meta || {}), appendedPrompts: [...root.items] };
    }
    const preservedResult = restore(state, preserved);
    if (state.turnLifecycle) {
      state.backendTurnInFlight = state.turnLifecycle.backendInFlight === true;
      state.turnFullyFinalized = ['effects-finalized', 'failed', 'cancelled']
        .includes(state.turnLifecycle.phase);
      const canonicalAssistantId = state.turnLifecycle.canonicalAssistantId;
      state.finalAssistantLock = typeof canonicalAssistantId === 'string' && canonicalAssistantId
        ? { assistantMsgId: canonicalAssistantId, ts: options.now?.() ?? Date.now() }
        : null;
    }
    const protectedAppendRoot = state.backendTurnInFlight === true
      && state.turnFullyFinalized !== true
      && state.canceledActiveTurn !== true
      && !state.finalAssistantLock?.assistantMsgId
      && typeof state.appendRootUserKey === 'string'
      && state.messagesById.get(state.appendRootUserKey)?.role === 'user';
    if (!protectedAppendRoot && plan.appendRoots.length > 0) {
      state.appendRootUserKey = plan.appendRoots[0].rootMessageId;
    }
    const followupAssistantId = state.appendFollowupIdentity?.assistantMsgId;
    if (
      typeof followupAssistantId === 'string'
      && followupAssistantId
      && state.currentTurnAssistantKey === followupAssistantId
      && state.pendingAssistantUpgrade?.assistantMsgId !== followupAssistantId
    ) {
      state.pendingAssistantUpgrade = null;
      state.awaitingFinalMapBind = false;
    }
    return Object.freeze({ plan, state, preservedResult });
  }

  function applyIntegration(
    session: any,
    integration: Readonly<{ plan: HydrationIntegrationPlan; state: any; preservedResult: any }>,
    applicationOptions: Readonly<{
      storeMessage(messagesById: Map<any, any>, message: any): void;
      rebuildHiddenSet(session: any): void;
      createSnapshotNotice?(): any;
    }>,
  ) {
    if (!session || !integration?.plan?.accepted || !integration.state) {
      throw new Error('hydration-integration-unavailable');
    }
    const { plan, state } = integration;
    const replaceMap = (name: string, source: any) => {
      if (!(session[name] instanceof Map)) session[name] = new Map();
      session[name].clear();
      if (!(source instanceof Map)) return;
      for (const [key, value] of source.entries()) session[name].set(key, clonePlainValue(value));
    };
    const replaceSet = (name: string, source: any) => {
      if (!(session[name] instanceof Set)) session[name] = new Set();
      session[name].clear();
      if (!(source instanceof Set)) return;
      for (const value of source.values()) session[name].add(value);
    };

    if (!(session.messagesById instanceof Map)) session.messagesById = new Map();
    session.messagesById.clear();
    for (const message of state.messagesById.values()) {
      applicationOptions.storeMessage(session.messagesById, cloneMessage(message));
    }
    session.timeline = [...state.timeline];
    session.nextOrder = state.nextOrder;
    session.hydrationCoverage = state.hydrationCoverage;

    if (plan.reset.segments) {
      if (!(session.segmentsByNoticeKey instanceof Map)) session.segmentsByNoticeKey = new Map();
      session.segmentsByNoticeKey.clear();
      for (const [noticeKey, segment] of state.segmentsByNoticeKey.entries()) {
        session.segmentsByNoticeKey.set(noticeKey, {
          ...segment,
          memberMsgIds: Array.isArray(segment?.memberMsgIds) ? [...segment.memberMsgIds] : [],
          mergedInvalidSegments: Array.isArray(segment?.mergedInvalidSegments)
            ? segment.mergedInvalidSegments.map((child: any) => ({
              ...child,
              memberMsgIds: Array.isArray(child?.memberMsgIds) ? [...child.memberMsgIds] : [],
            }))
            : [],
        });
      }
      replaceSet('hiddenSet', state.hiddenSet);
    } else {
      applicationOptions.rebuildHiddenSet(session);
    }

    for (const name of [
      'messageIndexMap',
      'serverIdToKey',
      'clientKeyToServerId',
      'serverIdToClientKey',
      'appendComposerDrafts',
    ]) replaceMap(name, state[name]);
    for (const name of [
      'hiddenControlUserIds',
      'assistantUpgradeSeen',
    ]) replaceSet(name, state[name]);

    for (const name of [
      'pendingAssistantUpgrade',
      'thinkingId',
      'currentTurnAssistantKey',
      'currentTurnAssistantMsgId',
      'lastTurnUserId',
      'lastTurnAssistantId',
      'cancelledTurn',
      'canceledActiveTurn',
      'activeTurnOpId',
      'backendTurnInFlight',
      'awaitingFinalMapBind',
      'streamMode',
      'earlyFinalAssistantId',
      'turnFullyFinalized',
      'turnLifecycle',
      'finalAssistantLock',
      'appendFollowupIdentity',
      'appendRootUserKey',
      'appendComposerFor',
      'inputDraft',
      'backgroundSubagentIndicatorVisible',
      'backgroundSubagentIndicatorUntil',
      'backgroundSubagentIndicatorAnchorId',
    ]) session[name] = clonePlainValue(state[name]);
    if (Object.prototype.hasOwnProperty.call(state, 'activeSubagents')) {
      session.activeSubagents = cloneActiveSubagents(state.activeSubagents);
    } else {
      delete session.activeSubagents;
    }

    let snapshotNoticeId: string | null = null;
    if (plan.snapshotNoticeRequired) {
      const notice = applicationOptions.createSnapshotNotice?.();
      if (notice && typeof notice.id === 'string' && notice.id) {
        applicationOptions.storeMessage(session.messagesById, cloneMessage({
          ...notice,
          order: typeof notice.order === 'number' ? notice.order : session.nextOrder++,
        }));
        session.timeline.unshift(notice.id);
        snapshotNoticeId = notice.id;
      }
    }
    return Object.freeze({
      plan,
      preservedResult: integration.preservedResult,
      snapshotNoticeId,
    });
  }

  const stableValue = (value: any): any => {
    if (value instanceof Map) {
      return [...value.entries()]
        .map(([key, entry]) => [key, stableValue(entry)])
        .sort(([left], [right]) => String(left).localeCompare(String(right)));
    }
    if (value instanceof Set) return [...value].sort();
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    const output: Record<string, any> = {};
    for (const key of Object.keys(value).sort()) {
      if (key === 'identity') continue;
      if (key === 'createdAt' && value.kind === 'undoSegmentPlaceholder') continue;
      output[key] = stableValue(value[key]);
    }
    return output;
  };
  const stableJson = (value: any) => JSON.stringify(stableValue(value));
  const visibleTimeline = (session: any) => (Array.isArray(session?.timeline) ? session.timeline : [])
    .filter((id: unknown) => session?.messagesById?.get?.(id)?.meta?.kind !== 'snapshotNotice');
  const visibleMessages = (session: any) => {
    if (!(session?.messagesById instanceof Map)) return [];
    return [...session.messagesById.entries()]
      .filter(([, message]) => message?.meta?.kind !== 'snapshotNotice')
      .map(([id, message]) => [id, stableValue(message)])
      .sort(([left], [right]) => String(left).localeCompare(String(right)));
  };
  const normalizedSegments = (session: any) => {
    if (!(session?.segmentsByNoticeKey instanceof Map)) return [];
    const normalizeSegment = (segment: any): any => ({
      noticeKey: segment?.noticeKey,
      anchorMsgId: segment?.anchorMsgId,
      endMsgId: segment?.endMsgId,
      memberMsgIds: Array.isArray(segment?.memberMsgIds) ? segment.memberMsgIds : [],
      restoreAllowed: segment?.restoreAllowed === true,
      collapsed: segment?.collapsed !== false,
      mergedInvalidSegments: Array.isArray(segment?.mergedInvalidSegments)
        ? segment.mergedInvalidSegments.map(normalizeSegment)
        : [],
    });
    return [...session.segmentsByNoticeKey.entries()]
      .map(([noticeKey, segment]) => [noticeKey, stableValue(normalizeSegment(segment))])
      .sort(([left], [right]) => String(left).localeCompare(String(right)));
  };

  function compareIntegrationShadow(
    actual: any,
    shadow: Readonly<{ plan: HydrationIntegrationPlan; state: any }> | null | undefined,
  ): Readonly<{
    matched: boolean;
    mismatches: readonly string[];
  }> {
    if (!actual || !shadow?.plan?.accepted) {
      return Object.freeze({
        matched: false,
        mismatches: Object.freeze(['unavailable-shadow']),
      });
    }
    const expected = shadow.state;
    const mismatches: string[] = [];
    const compare = (name: string, left: any, right: any) => {
      if (stableJson(left) !== stableJson(right)) mismatches.push(name);
    };
    compare('timeline', visibleTimeline(actual), visibleTimeline(expected));
    compare('messages', visibleMessages(actual), visibleMessages(expected));
    if (shadow.plan.reset.segments) {
      compare('segments', normalizedSegments(actual), normalizedSegments(expected));
      compare('hiddenSet', actual.hiddenSet, expected.hiddenSet);
    }
    compare('hiddenControlUserIds', actual.hiddenControlUserIds, expected.hiddenControlUserIds);
    compare('hydrationCoverage', actual.hydrationCoverage, expected.hydrationCoverage);
    for (const field of [
      'pendingAssistantUpgrade',
      'thinkingId',
      'currentTurnAssistantKey',
      'currentTurnAssistantMsgId',
      'lastTurnUserId',
      'lastTurnAssistantId',
      'cancelledTurn',
      'canceledActiveTurn',
      'activeTurnOpId',
      'backendTurnInFlight',
      'awaitingFinalMapBind',
      'streamMode',
      'earlyFinalAssistantId',
      'turnFullyFinalized',
      'turnLifecycle',
      'appendRootUserKey',
      'appendComposerFor',
      'inputDraft',
      'backgroundSubagentIndicatorVisible',
      'backgroundSubagentIndicatorUntil',
      'backgroundSubagentIndicatorAnchorId',
      'activeSubagents',
    ]) compare(`field:${field}`, actual[field], expected[field]);
    for (const field of [
      'messageIndexMap',
      'serverIdToKey',
      'clientKeyToServerId',
      'serverIdToClientKey',
      'appendComposerDrafts',
      'assistantUpgradeSeen',
    ]) compare(`collection:${field}`, actual[field], expected[field]);
    return Object.freeze({
      matched: mismatches.length === 0,
      mismatches: Object.freeze(mismatches),
    });
  }

  return Object.freeze({
    cloneMap,
    cloneSet,
    clonePlainValue,
    cloneMessage,
    cloneActiveSubagents,
    isPersistenceArtifact,
    findMappedMessageId,
    resolveCanonicalId,
    capture,
    restore,
    prepareIntegration,
    applyIntegration,
  });
}
