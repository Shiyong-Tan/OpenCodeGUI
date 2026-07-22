type ChangeListMessage = { id?: unknown; role?: unknown; text?: unknown; meta?: any };

type ChangeListMaterializationInput = Readonly<{
  rawMessages: ReadonlyArray<ChangeListMessage>;
  messagesById: ReadonlyMap<string, any>;
  timeline: ReadonlyArray<string>;
  nextOrder: number;
  toStableMessageKey(messageId: string): string | null | undefined;
}>;

type ChangeListMaterializationStats = {
  seen: number;
  alreadyTimeline: number;
  materialized: number;
  insertedAfter: number;
  appended: number;
  skippedNoFiles: number;
};

export type ChangeListMaterializationPlan = Readonly<{
  messages: ReadonlyArray<any>;
  timeline: ReadonlyArray<string>;
  nextOrder: number;
  stats: Readonly<ChangeListMaterializationStats>;
}>;

function isChangeListMessage(item: ChangeListMessage): item is ChangeListMessage & { id: string } {
  return typeof item?.id === 'string' && item.id.length > 0
    && (item.meta?.kind === 'changeList' || item.id.startsWith('system:changeList:'));
}

/** Returns changelist message and timeline decisions without mutating session state. */
export function planChangeListMaterialization(input: ChangeListMaterializationInput): ChangeListMaterializationPlan {
  const messagesById = new Map(input.messagesById);
  const timeline = [...input.timeline];
  const messages: any[] = [];
  let nextOrder = input.nextOrder;
  const stats: ChangeListMaterializationStats = { seen: 0, alreadyTimeline: 0, materialized: 0, insertedAfter: 0, appended: 0, skippedNoFiles: 0 };
  const stableKey = (id: string) => input.toStableMessageKey(id) || id;
  const findNearestPriorTimelineId = (index: number) => {
    for (let cursor = index - 1; cursor >= 0; cursor--) {
      const priorId = input.rawMessages[cursor]?.id;
      if (typeof priorId === 'string' && priorId.length && timeline.includes(stableKey(priorId))) return stableKey(priorId);
    }
    return '';
  };

  input.rawMessages.forEach((item, index) => {
    if (!isChangeListMessage(item)) return;
    stats.seen++;
    const files = Array.isArray(item.meta?.files)
      ? item.meta.files.filter((file: unknown): file is string => typeof file === 'string' && file.length > 0)
      : [];
    if (!files.length) { stats.skippedNoFiles++; return; }
    const existing = messagesById.get(item.id);
    const message = {
      ...(existing || {}), id: item.id, role: item.role || existing?.role || 'system',
      text: typeof item.text === 'string' ? item.text : (existing?.text || ''),
      meta: { ...(existing?.meta || {}), ...(item.meta || {}), kind: 'changeList', files },
      order: existing?.order ?? nextOrder++,
    };
    messagesById.set(item.id, message);
    messages.push(message);
    if (timeline.includes(item.id)) { stats.alreadyTimeline++; return; }
    const anchorId = typeof message.meta?.stableAnchorMessageId === 'string' && timeline.includes(message.meta.stableAnchorMessageId)
      ? message.meta.stableAnchorMessageId
      : (typeof message.meta?.anchorMessageId === 'string' ? stableKey(message.meta.anchorMessageId) : findNearestPriorTimelineId(index));
    if (anchorId && timeline.includes(anchorId)) {
      timeline.splice(timeline.indexOf(anchorId) + 1, 0, item.id);
      stats.insertedAfter++;
    } else {
      timeline.push(item.id);
      stats.appended++;
    }
    stats.materialized++;
  });
  return Object.freeze({ messages: Object.freeze(messages), timeline: Object.freeze(timeline), nextOrder, stats: Object.freeze(stats) });
}
