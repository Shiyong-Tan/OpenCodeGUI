type SegmentSession = {
  timeline: string[];
  clientKeyToServerId?: Map<string, string>;
  serverIdToClientKey?: Map<string, string>;
};

export function createSegmentTopology(options: {
  debug(payload: string[]): void;
  now(): number;
}) {
  const resolveMessageId = (session: SegmentSession, messageId: unknown): string | null => {
    if (!messageId || typeof messageId !== 'string') return null;
    const mappedServer = session.clientKeyToServerId?.get(messageId);
    if (mappedServer && session.timeline.includes(mappedServer)) return mappedServer;
    if (session.timeline.includes(messageId)) return messageId;
    const mappedLocal = session.serverIdToClientKey?.get(messageId);
    if (mappedLocal && session.timeline.includes(mappedLocal)) return mappedLocal;
    return null;
  };

  const computeMembers = (session: SegmentSession, anchorMsgId: string, endMsgId: string): string[] => {
    const inTimelineAnchor = session.timeline.includes(anchorMsgId);
    const inTimelineEnd = endMsgId ? session.timeline.includes(endMsgId) : false;
    options.debug([
      'MEMBERS_PRECHECK', `anchor=${anchorMsgId || 'null'}`, `end=${endMsgId || 'null'}`,
      `inTimelineAnchor=${inTimelineAnchor}`, `inTimelineEnd=${inTimelineEnd}`, `timelineLen=${session.timeline.length}`,
    ]);
    const anchorIdx = session.timeline.indexOf(anchorMsgId);
    const endIdx = session.timeline.indexOf(endMsgId);
    if (anchorIdx === -1) {
      options.debug(['[WV][COMPUTE_MEMBERS]', 'anchor-not-found', `anchorMsgId=${anchorMsgId}`]);
      return [];
    }
    if (endIdx < anchorIdx) {
      options.debug([
        '[WV][COMPUTE_MEMBERS]', 'inverted-range-drop',
        `anchorMsgId=${anchorMsgId}`, `endMsgId=${endMsgId || 'null'}`,
        `anchorIdx=${anchorIdx}`, `endIdx=${endIdx}`,
      ]);
      return [];
    }
    if (endIdx === -1) {
      options.debug([
        '[WV][COMPUTE_MEMBERS]', 'end-missing',
        `anchorMsgId=${anchorMsgId}`, `endMsgId=${endMsgId || 'null'}`, 'degrade-to-anchor-only',
      ]);
      return typeof anchorMsgId === 'string' && anchorMsgId.startsWith('msg_') ? [anchorMsgId] : [];
    }
    const result: string[] = [];
    for (let index = anchorIdx; index <= endIdx; index++) {
      const id = session.timeline[index];
      if (typeof id === 'string' && id.startsWith('msg_')) result.push(id);
    }
    options.debug([
      '[WV][COMPUTE_MEMBERS]', `anchorMsgId=${anchorMsgId}`, `endMsgId=${endMsgId}`, `count=${result.length}`,
    ]);
    return result;
  };

  const normalizeMembers = (
    session: SegmentSession,
    anchorMsgId: unknown,
    endMsgId: unknown,
    candidateMsgIds: unknown,
    noticeKey: unknown,
  ) => {
    const explicitMemberMsgIds = Array.isArray(candidateMsgIds)
      ? candidateMsgIds
          .map((id) => resolveMessageId(session, id) || id)
          .filter((id): id is string => typeof id === 'string' && id.startsWith('msg_'))
      : [];
    if (explicitMemberMsgIds.length) {
      const deduped: string[] = [];
      const seen = new Set<string>();
      for (const id of explicitMemberMsgIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        deduped.push(id);
      }
      const resolvedAnchor = resolveMessageId(session, anchorMsgId) || deduped[0];
      const resolvedEnd = resolveMessageId(session, endMsgId) || deduped[deduped.length - 1] || resolvedAnchor;
      options.debug([
        '[WV][SEG_MEMBERS]', 'source=explicit', `noticeKey=${noticeKey || 'null'}`,
        `anchor=${resolvedAnchor || 'null'}`, `end=${resolvedEnd || 'null'}`, `count=${deduped.length}`,
      ]);
      return {
        anchorMsgId: deduped[0] || resolvedAnchor,
        endMsgId: deduped[deduped.length - 1] || resolvedEnd,
        memberMsgIds: deduped,
      };
    }
    const resolvedAnchor = resolveMessageId(session, anchorMsgId);
    if (!resolvedAnchor) return { anchorMsgId: null, endMsgId: null, memberMsgIds: [] as string[] };
    const resolvedEnd = resolveMessageId(session, endMsgId) || resolvedAnchor;
    const resolvedAnchorIdx = session.timeline.indexOf(resolvedAnchor);
    const resolvedEndIdx = session.timeline.indexOf(resolvedEnd);
    if (resolvedEndIdx >= 0 && resolvedEndIdx < resolvedAnchorIdx) {
      options.debug([
        '[WV][SEG_MEMBERS]', 'source=timeline', 'inverted-range-drop', `noticeKey=${noticeKey || 'null'}`,
        `anchor=${resolvedAnchor}`, `end=${resolvedEnd}`, `anchorIdx=${resolvedAnchorIdx}`, `endIdx=${resolvedEndIdx}`,
      ]);
      return { anchorMsgId: resolvedAnchor, endMsgId: resolvedEnd, memberMsgIds: [] as string[] };
    }
    let memberMsgIds = computeMembers(session, resolvedAnchor, resolvedEnd);
    if (memberMsgIds.length === 0 && resolvedAnchor.startsWith('msg_')) memberMsgIds = [resolvedAnchor];
    if (Array.isArray(candidateMsgIds) && candidateMsgIds.length) {
      const candidateSet = new Set(candidateMsgIds.filter((id): id is string => typeof id === 'string' && id.startsWith('msg_')));
      const normalizedSet = new Set(memberMsgIds);
      let dropped = 0;
      for (const id of candidateSet) if (!normalizedSet.has(id)) dropped++;
      if (dropped > 0) {
        options.debug([
          '[WV][SEG_NORMALIZE_DROP]', `noticeKey=${noticeKey || 'null'}`, `dropped=${dropped}`,
          `anchor=${resolvedAnchor}`, `end=${resolvedEnd}`,
        ]);
      }
    }
    options.debug([
      '[WV][SEG_MEMBERS]', 'source=timeline', `noticeKey=${noticeKey || 'null'}`,
      `anchor=${resolvedAnchor || 'null'}`, `end=${resolvedEnd || 'null'}`, `count=${memberMsgIds.length}`,
    ]);
    return { anchorMsgId: resolvedAnchor, endMsgId: resolvedEnd, memberMsgIds };
  };

  const sanitizeMergedSnapshot = (segment: any) => {
    if (!segment || typeof segment.noticeKey !== 'string') return null;
    const memberMsgIds = Array.isArray(segment.memberMsgIds)
      ? segment.memberMsgIds.filter((id: unknown): id is string => typeof id === 'string' && id.startsWith('msg_'))
      : [];
    const anchorMsgId = typeof segment.anchorMsgId === 'string' && segment.anchorMsgId.startsWith('msg_')
      ? segment.anchorMsgId
      : (memberMsgIds[0] || '');
    const endMsgId = typeof segment.endMsgId === 'string' && segment.endMsgId.startsWith('msg_')
      ? segment.endMsgId
      : (memberMsgIds[memberMsgIds.length - 1] || anchorMsgId);
    if (!anchorMsgId || memberMsgIds.length === 0) return null;
    return {
      noticeKey: segment.noticeKey,
      anchorMsgId,
      endMsgId,
      memberMsgIds,
      applied: segment.applied ?? true,
      restoreAllowed: segment.restoreAllowed === false ? false : true,
      collapsed: segment.collapsed !== false,
      mergedInvalidSegments: [],
      createdAt: typeof segment.createdAt === 'number' ? segment.createdAt : options.now(),
      updatedAt: typeof segment.updatedAt === 'number' ? segment.updatedAt : options.now(),
    };
  };

  const orderMembersByTimeline = (memberMsgIds: unknown, timeline: unknown): string[] => {
    const ordered: string[] = [];
    const input = Array.isArray(memberMsgIds) ? memberMsgIds : [];
    const remaining = new Set(input.filter((id): id is string => typeof id === 'string' && id.startsWith('msg_')));
    for (const id of Array.isArray(timeline) ? timeline : []) {
      if (typeof id !== 'string' || !remaining.delete(id)) continue;
      ordered.push(id);
    }
    for (const id of input) {
      if (typeof id !== 'string' || !remaining.delete(id)) continue;
      ordered.push(id);
    }
    return ordered;
  };

  return { resolveMessageId, computeMembers, normalizeMembers, sanitizeMergedSnapshot, orderMembersByTimeline };
}
