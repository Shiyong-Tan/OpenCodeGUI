export type SessionMessage = {
    role: 'user' | 'assistant' | 'system';
    text: string;
    id?: string;
    messageIndex?: number;
    meta?: Record<string, unknown>;
};

export type ChangeListRecord = {
    id: string;
    commitHead: string;
    commitBase: string;
    files: string[];
    anchorMessageId: string;
    createdAt: number;
    reverted?: boolean;
    statsByPath?: Record<string, { additions: number | null; deletions: number | null }>;
    userMessageId?: string;
    rootUserMessageId?: string;
    latestAppendUserMessageId?: string;
    assistantMessageId?: string;
};

export type ChangeListInjectionCounts = {
    read: number;
    injectedByResolvedAnchor: number;
    convertedByExistingId: number;
    skippedMissingAnchor: number;
    skippedDuplicate: number;
};

function collectStringCandidates(value: unknown, output: string[] = []): string[] {
    if (typeof value === 'string' && value.length > 0) output.push(value);
    else if (Array.isArray(value)) {
        for (const item of value) collectStringCandidates(item, output);
    } else if (value && typeof value === 'object') {
        for (const item of Object.values(value as Record<string, unknown>)) collectStringCandidates(item, output);
    }
    return output;
}

function toChangeListMessage(record: ChangeListRecord, base?: SessionMessage): SessionMessage {
    return {
        ...(base || {}),
        role: 'system',
        id: base?.id || record.id,
        text: '',
        meta: {
            ...(base?.meta || {}),
            kind: 'changeList',
            files: record.files,
            source: 'message-summary-diffs',
            scope: 'turn',
            commitHead: record.commitHead,
            commitBase: record.commitBase,
            reverted: record.reverted === true,
            statsByPath: record.statsByPath || {},
        },
    };
}

export function injectChangeListRecords(options: {
    messages: SessionMessage[];
    records: ChangeListRecord[];
    resolveOwner(candidate: string): string | null | undefined;
    onMissingAnchor?(record: ChangeListRecord, resolvedAnchor?: string): void;
}): { messages: SessionMessage[]; counts: ChangeListInjectionCounts } {
    const messages = options.messages || [];
    const records = options.records || [];
    const idSet = new Set(messages.map((message) => message.id).filter((id): id is string => typeof id === 'string'));
    const byAnchor = new Map<string, ChangeListRecord[]>();
    const byId = new Map<string, ChangeListRecord>();
    const counts: ChangeListInjectionCounts = {
        read: records.length,
        injectedByResolvedAnchor: 0,
        convertedByExistingId: 0,
        skippedMissingAnchor: 0,
        skippedDuplicate: 0,
    };
    const resolveRecordAnchor = (record: ChangeListRecord): string | undefined => {
        const raw = record as ChangeListRecord & Record<string, unknown>;
        const candidates = [
            record.anchorMessageId,
            raw.ownerMsgId,
            raw.ownerMessageId,
            raw.currentOwnerMsgId,
            raw.currentOwnerMessageId,
            raw.finalAssistantMsgId,
            raw.assistantMsgId,
            raw.assistantMessageId,
            raw.messageId,
            raw.msgId,
            ...collectStringCandidates(raw.metadata || raw.meta),
        ].filter((id): id is string => typeof id === 'string' && id.length > 0);
        const seen = new Set<string>();
        for (const candidate of candidates) {
            if (seen.has(candidate)) continue;
            seen.add(candidate);
            const resolved = options.resolveOwner(candidate) || candidate;
            if (idSet.has(resolved)) return resolved;
            if (idSet.has(candidate)) return candidate;
        }
        return undefined;
    };

    for (const record of records) {
        const resolvedAnchor = resolveRecordAnchor(record);
        const effectiveRecord = resolvedAnchor && resolvedAnchor !== record.anchorMessageId
            ? { ...record, anchorMessageId: resolvedAnchor }
            : record;
        if (effectiveRecord.id && idSet.has(effectiveRecord.id)) {
            if (byId.has(effectiveRecord.id)) {
                counts.skippedDuplicate += 1;
                continue;
            }
            byId.set(effectiveRecord.id, effectiveRecord);
            counts.convertedByExistingId += 1;
            continue;
        }
        if (!resolvedAnchor || !idSet.has(resolvedAnchor)) {
            if (!effectiveRecord.id || !idSet.has(effectiveRecord.id)) {
                counts.skippedMissingAnchor += 1;
                options.onMissingAnchor?.(record, resolvedAnchor);
            }
            continue;
        }
        const list = byAnchor.get(resolvedAnchor) || [];
        list.push(effectiveRecord);
        byAnchor.set(resolvedAnchor, list);
        counts.injectedByResolvedAnchor += 1;
    }

    for (const list of byAnchor.values()) list.sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
    if (!byAnchor.size && !byId.size) return { messages, counts };

    const merged: SessionMessage[] = [];
    const seenIds = new Set<string>();
    for (const message of messages) {
        const nextMessage = message.id && byId.has(message.id)
            ? toChangeListMessage(byId.get(message.id)!, message)
            : message;
        if (message.id && seenIds.has(message.id)) continue;
        if (message.id) seenIds.add(message.id);
        merged.push(nextMessage);
        if (!message.id) continue;
        for (const record of byAnchor.get(message.id) || []) {
            if (seenIds.has(record.id)) continue;
            merged.push(toChangeListMessage(record));
            seenIds.add(record.id);
        }
    }
    return { messages: merged, counts };
}
