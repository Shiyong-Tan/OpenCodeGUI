export type UndoUiRangeResolution = {
    messageIds: string[];
    source: 'webview-visible' | 'extension-canonical' | 'fallback';
    uiAnchorIndex: number;
    extAnchorIndex: number;
};

export function sanitizeUndoRangeMessageIds(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const raw of value) {
        if (typeof raw !== 'string' || !raw.startsWith('msg_') || seen.has(raw)) continue;
        seen.add(raw);
        ids.push(raw);
    }
    return ids;
}

export function resolveUndoUiVisibleRange(options: {
    data: any;
    anchorMessageId: string;
    canonicalMessageIds: string[];
    extAnchorIndex: number;
}): UndoUiRangeResolution {
    const { data, anchorMessageId, canonicalMessageIds, extAnchorIndex } = options;
    const uiAnchorIndex = typeof data?.anchorIndex === 'number' && Number.isFinite(data.anchorIndex)
        ? data.anchorIndex
        : -1;
    const explicitForward = sanitizeUndoRangeMessageIds(data?.forwardMessageIdsFromAnchor);
    if (explicitForward.length && explicitForward[0] === anchorMessageId) {
        return { messageIds: explicitForward, source: 'webview-visible', uiAnchorIndex, extAnchorIndex };
    }
    const visibleMessageIds = sanitizeUndoRangeMessageIds(data?.visibleMessageIds);
    if (
        visibleMessageIds.length
        && uiAnchorIndex >= 0
        && uiAnchorIndex < visibleMessageIds.length
        && visibleMessageIds[uiAnchorIndex] === anchorMessageId
    ) {
        return {
            messageIds: visibleMessageIds.slice(uiAnchorIndex),
            source: 'webview-visible',
            uiAnchorIndex,
            extAnchorIndex,
        };
    }
    const fallbackIds = canonicalMessageIds.length ? canonicalMessageIds : [anchorMessageId];
    return {
        messageIds: fallbackIds,
        source: explicitForward.length || visibleMessageIds.length ? 'fallback' : 'extension-canonical',
        uiAnchorIndex,
        extAnchorIndex,
    };
}
