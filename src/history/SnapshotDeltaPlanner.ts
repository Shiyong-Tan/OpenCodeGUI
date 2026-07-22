import type { SessionMessage } from '../changes/ChangeListInjection';

export type SnapshotDeltaPlan = {
    proven: boolean;
    messages: SessionMessage[];
    timelineMessageIds: string[];
    repairedSnapshot?: boolean;
};

export function getSnapshotTimelineIds(options: {
    sessionData: any;
    formattedMessages: SessionMessage[];
    collectVisible(messages: SessionMessage[]): SessionMessage[];
}): string[] {
    const explicitIds = Array.isArray(options.sessionData?.meta?.timelineMessageIds)
        ? (options.sessionData.meta.timelineMessageIds as unknown[])
            .filter((id): id is string => typeof id === 'string' && Boolean(id))
        : [];
    if (explicitIds.length > 0) return Array.from(new Set(explicitIds));
    return Array.from(new Set(
        options.collectVisible(options.formattedMessages)
            .map((message) => typeof message?.id === 'string' ? message.id : '')
            .filter((id): id is string => Boolean(id)),
    ));
}

export function computeRecentVisibleAppend(options: {
    snapshotTimelineIdSet: Set<string>;
    recentFormattedMessages: SessionMessage[];
    isVisible(message: SessionMessage): boolean;
}): string[] {
    const newIds: string[] = [];
    const seenNewIds = new Set<string>();
    for (const message of Array.isArray(options.recentFormattedMessages) ? options.recentFormattedMessages : []) {
        if (!message || typeof message.id !== 'string' || !message.id) continue;
        if (options.snapshotTimelineIdSet.has(message.id) || seenNewIds.has(message.id)) continue;
        if (!options.isVisible(message)) continue;
        newIds.push(message.id);
        seenNewIds.add(message.id);
    }
    return newIds;
}

export function getMaxMessageIndex(messages: SessionMessage[]): number | null {
    let maxIndex: number | null = null;
    for (const message of Array.isArray(messages) ? messages : []) {
        if (typeof message?.messageIndex !== 'number' || !Number.isFinite(message.messageIndex)) continue;
        maxIndex = maxIndex === null ? message.messageIndex : Math.max(maxIndex, message.messageIndex);
    }
    return maxIndex;
}

export function classifyRecentAppendCandidates(options: {
    snapshotTimelineIdSet: Set<string>;
    snapshotMaxMessageIndex: number | null;
    recentFormattedMessages: SessionMessage[];
    isVisible(message: SessionMessage): boolean;
}): { proven: boolean; suffix: SessionMessage[] } {
    const recentList = Array.isArray(options.recentFormattedMessages) ? options.recentFormattedMessages : [];
    if (options.snapshotTimelineIdSet.size === 0) return { proven: false, suffix: [] };
    const snapshotIds = Array.from(options.snapshotTimelineIdSet);
    const boundaryId = snapshotIds[snapshotIds.length - 1];
    if (!boundaryId) return { proven: false, suffix: [] };
    let boundaryIndex = -1;
    for (let index = 0; index < recentList.length; index++) {
        const id = typeof recentList[index]?.id === 'string' ? recentList[index]!.id : '';
        if (id !== boundaryId) continue;
        if (boundaryIndex >= 0) return { proven: false, suffix: [] };
        boundaryIndex = index;
    }
    if (boundaryIndex < 0) return { proven: false, suffix: [] };
    const suffix: SessionMessage[] = [];
    const seen = new Set<string>();
    let previousIndex = options.snapshotMaxMessageIndex;
    for (let index = boundaryIndex + 1; index < recentList.length; index++) {
        const message = recentList[index];
        if (!message || typeof message.id !== 'string' || !message.id) return { proven: false, suffix: [] };
        if (typeof message.messageIndex !== 'number' || !Number.isFinite(message.messageIndex)) return { proven: false, suffix: [] };
        const id = message.id;
        if (id.startsWith('local-') || id.startsWith('tmp:')) continue;
        if (options.snapshotTimelineIdSet.has(id) || seen.has(id)) continue;
        if (previousIndex !== null && message.messageIndex <= previousIndex) return { proven: false, suffix: [] };
        previousIndex = message.messageIndex;
        if (!options.isVisible(message)) continue;
        suffix.push(message);
        seen.add(id);
    }
    return { proven: true, suffix };
}

export function buildFullExportSnapshotDelta(options: {
    existingSnapshotRecords: SessionMessage[];
    snapshotTimelineIds: string[];
    fullExportRecords: SessionMessage[];
    repairRequiredMessageIds?: string[];
    appendImmutable(existing: SessionMessage[], suffix: SessionMessage[]): SessionMessage[];
}): SnapshotDeltaPlan {
    const {
        existingSnapshotRecords,
        snapshotTimelineIds,
        fullExportRecords,
        repairRequiredMessageIds = [],
    } = options;
    if (snapshotTimelineIds.length === 0) {
        const messages = options.appendImmutable([], fullExportRecords);
        return { proven: true, messages, timelineMessageIds: messages.map((message) => message.id || '').filter(Boolean) };
    }
    const boundaryId = snapshotTimelineIds[snapshotTimelineIds.length - 1];
    const boundaryIndexes = fullExportRecords
        .map((message, index) => message?.id === boundaryId ? index : -1)
        .filter((index) => index >= 0);
    if (boundaryIndexes.length !== 1) {
        return { proven: false, messages: [...existingSnapshotRecords], timelineMessageIds: [...snapshotTimelineIds] };
    }
    const storedMessageIds = new Set(
        existingSnapshotRecords
            .map((message) => typeof message?.id === 'string' ? message.id : '')
            .filter((id): id is string => id.startsWith('msg_')),
    );
    const visibleRepairIds = Array.from(new Set([
        ...snapshotTimelineIds,
        ...repairRequiredMessageIds,
    ].filter((id) => typeof id === 'string' && id.startsWith('msg_'))));
    const missingSnapshotMessageIds = visibleRepairIds.filter((id) => !storedMessageIds.has(id));
    if (missingSnapshotMessageIds.length > 0) {
        const fullById = new Map(
            fullExportRecords
                .filter((message) => typeof message?.id === 'string' && message.id.startsWith('msg_'))
                .map((message) => [message.id as string, message] as const),
        );
        if (missingSnapshotMessageIds.every((id) => fullById.has(id))) {
            const boundaryIndex = boundaryIndexes[0];
            const visibleRepairIdSet = new Set(visibleRepairIds);
            const suffixIds = fullExportRecords
                .slice(boundaryIndex + 1)
                .map((message) => typeof message?.id === 'string' ? message.id : '')
                .filter((id): id is string => id.startsWith('msg_'));
            const allowedVisibleIds = new Set([...visibleRepairIdSet, ...suffixIds]);
            const existingById = new Map(
                existingSnapshotRecords
                    .filter((message) => typeof message?.id === 'string' && message.id.startsWith('msg_'))
                    .map((message) => [message.id as string, message] as const),
            );
            const repairedMessages = fullExportRecords
                .filter((message) => typeof message?.id === 'string' && allowedVisibleIds.has(message.id))
                .map((message) => {
                    const existing = existingById.get(message.id as string);
                    if (!existing) return message;
                    return {
                        ...message,
                        ...existing,
                        text: typeof existing.text === 'string' && existing.text.length ? existing.text : message.text,
                        meta: { ...(message.meta || {}), ...(existing.meta || {}) },
                    };
                });
            return {
                proven: true,
                messages: repairedMessages,
                timelineMessageIds: repairedMessages
                    .map((message) => message.id || '')
                    .filter((id): id is string => id.startsWith('msg_')),
                repairedSnapshot: true,
            };
        }
    }
    const suffix = fullExportRecords.slice(boundaryIndexes[0] + 1);
    const messages = options.appendImmutable(existingSnapshotRecords, suffix);
    const existingIds = new Set(snapshotTimelineIds);
    const suffixIds = suffix
        .map((message) => message?.id || '')
        .filter((id) => id.startsWith('msg_') && !existingIds.has(id));
    return {
        proven: true,
        messages,
        timelineMessageIds: [...snapshotTimelineIds, ...Array.from(new Set(suffixIds))],
    };
}
