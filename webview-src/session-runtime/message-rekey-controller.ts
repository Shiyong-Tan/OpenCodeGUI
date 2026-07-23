type MessageLike = {
  id: string;
  role?: string;
  text?: string;
  order?: number;
  meta?: Record<string, any>;
};

type RekeySession = {
  messagesById: Map<string, MessageLike>;
  timeline: string[];
  segmentsByNoticeKey: Map<string, any>;
  thinkingId?: string | null;
  lastTurnUserId?: string | null;
  lastTurnAssistantId?: string | null;
  currentTurnAssistantKey?: string | null;
  currentTurnAssistantMsgId?: string | null;
  pendingUndo?: { anchorKey?: string };
  appendRootUserKey?: string | null;
  appendComposerFor?: string | null;
  appendComposerDrafts?: Map<string, string>;
  clientKeyToServerId?: Map<string, string>;
  serverIdToClientKey?: Map<string, string>;
  recentAssistantDomTargetAliases?: any[];
};

export type MessageRekeyResult =
  | Readonly<{
    accepted: false;
    reason: 'invalid-key' | 'user-to-assistant-id';
  }>
  | Readonly<{
    accepted: true;
    timelineIndex: number;
    timelineReplaced: boolean;
    deduped: boolean;
    hadOldMessage: boolean;
    hadNewMessage: boolean;
  }>;

export type MessageRekeyControllerOptions = Readonly<{
  bindCanonical(message: MessageLike, canonicalId: string): unknown;
  rebindTurnCanonical?(session: RekeySession, oldId: string, newId: string): void;
  now?(): number;
}>;

function pickCompleteMessage(
  primary: MessageLike | null,
  secondary: MessageLike | null,
): MessageLike | null {
  if (!primary) return secondary;
  if (!secondary) return primary;
  const primaryText = typeof primary.text === 'string' ? primary.text : '';
  const secondaryText = typeof secondary.text === 'string' ? secondary.text : '';
  if (primaryText.length !== secondaryText.length) {
    return primaryText.length > secondaryText.length ? primary : secondary;
  }
  const primarySegments = Array.isArray(primary.meta?.textSegments)
    ? primary.meta!.textSegments.length
    : 0;
  const secondarySegments = Array.isArray(secondary.meta?.textSegments)
    ? secondary.meta!.textSegments.length
    : 0;
  if (primarySegments !== secondarySegments) {
    return primarySegments > secondarySegments ? primary : secondary;
  }
  const primaryThinking = primary.meta?.isThinking === true;
  const secondaryThinking = secondary.meta?.isThinking === true;
  if (primaryThinking !== secondaryThinking) {
    return primaryThinking ? secondary : primary;
  }
  return (primary.order ?? -1) >= (secondary.order ?? -1) ? primary : secondary;
}

export function createMessageRekeyController(options: MessageRekeyControllerOptions) {
  const now = options.now || (() => Date.now());

  function rekey(
    session: RekeySession,
    oldId: string,
    newId: string,
    sessionId: string,
  ): MessageRekeyResult {
    if (!oldId || !newId || oldId === newId) {
      return { accepted: false, reason: 'invalid-key' };
    }
    if (oldId.startsWith('local-') && newId === session.currentTurnAssistantMsgId) {
      return { accepted: false, reason: 'user-to-assistant-id' };
    }

    const preAssistantKey = session.currentTurnAssistantKey;
    const preThinkingId = session.thinkingId;
    const preAssistantMsgId = session.currentTurnAssistantMsgId;
    const message = session.messagesById.get(oldId) || null;
    const existing = session.messagesById.get(newId) || null;

    if (message) {
      session.messagesById.delete(oldId);
      const selected = pickCompleteMessage(message, existing);
      if (selected) {
        if (newId.startsWith('msg_')) options.bindCanonical(selected, newId);
        selected.id = newId;
        session.messagesById.set(newId, selected);
      }
    }

    let timelineIndex = -1;
    let timelineReplaced = false;
    let deduped = false;
    session.timeline = session.timeline.map((id, index) => {
      if (id !== oldId) return id;
      if (timelineIndex === -1) timelineIndex = index;
      timelineReplaced = true;
      return newId;
    });
    const seen = new Set<string>();
    session.timeline = session.timeline.filter((id) => {
      if (seen.has(id)) {
        deduped = true;
        return false;
      }
      seen.add(id);
      return true;
    });

    for (const segment of session.segmentsByNoticeKey.values()) {
      if (Array.isArray(segment.memberMsgIds) && segment.memberMsgIds.includes(oldId)) {
        segment.memberMsgIds = segment.memberMsgIds.map((id: string) => id === oldId ? newId : id);
      }
      if (segment.anchorMsgId === oldId) segment.anchorMsgId = newId;
      if (segment.endMsgId === oldId) segment.endMsgId = newId;
    }

    for (const field of [
      'thinkingId',
      'lastTurnUserId',
      'lastTurnAssistantId',
      'currentTurnAssistantMsgId',
      'appendRootUserKey',
      'appendComposerFor',
      'currentTurnAssistantKey',
    ] as const) {
      if (session[field] === oldId) session[field] = newId;
    }
    if (session.pendingUndo?.anchorKey === oldId) session.pendingUndo.anchorKey = newId;
    if (session.appendComposerDrafts?.has(oldId)) {
      const draft = session.appendComposerDrafts.get(oldId)!;
      session.appendComposerDrafts.delete(oldId);
      session.appendComposerDrafts.set(newId, draft);
    }
    if (newId.startsWith('msg_')) session.currentTurnAssistantMsgId = newId;
    if (session.clientKeyToServerId?.get(oldId) === newId) {
      session.clientKeyToServerId.delete(oldId);
    }
    if (session.serverIdToClientKey?.get(newId) === oldId) {
      session.serverIdToClientKey.set(newId, newId);
    }
    options.rebindTurnCanonical?.(session, oldId, newId);

    const replacedTemporaryAssistant = (oldId.startsWith('tmp:') || oldId.startsWith('local-'))
      && newId.startsWith('msg_')
      && (
        message?.role === 'assistant'
        || existing?.role === 'assistant'
        || preAssistantKey === oldId
        || preThinkingId === oldId
      );
    if (replacedTemporaryAssistant) {
      const aliases = Array.isArray(session.recentAssistantDomTargetAliases)
        ? session.recentAssistantDomTargetAliases
        : [];
      aliases.push({
        oldKey: oldId,
        newKey: newId,
        sessionId,
        source: 'messageRekeyController',
        ts: now(),
        turnAnchor: preAssistantKey || preThinkingId || oldId,
        assistantMsgId: preAssistantMsgId || newId,
      });
      session.recentAssistantDomTargetAliases = aliases.slice(-6);
    }

    return {
      accepted: true,
      timelineIndex,
      timelineReplaced,
      deduped,
      hadOldMessage: Boolean(message),
      hadNewMessage: Boolean(existing),
    };
  }

  return Object.freeze({ rekey });
}
