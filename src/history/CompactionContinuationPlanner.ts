export const OPEN_CODE_COMPACTION_CONTINUATION_PROMPT =
    'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.';

type RawHistoryMessage = {
    info?: unknown;
    parts?: unknown;
};

type CompactionContinuationPlannerOptions = {
    isCompactionSummaryInfo: (info: unknown) => boolean;
    isHiddenControlUserText: (text: string) => boolean;
};

export type CompactionContinuationPlan = {
    syntheticUserIds: Set<string>;
    displayParentBySyntheticUserId: Map<string, string>;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object'
        ? value as Record<string, unknown>
        : undefined;
}

function getMessageInfo(message: RawHistoryMessage): Record<string, unknown> | undefined {
    return asRecord(message.info);
}

function getText(message: RawHistoryMessage): string {
    if (!Array.isArray(message.parts)) return '';
    return message.parts
        .map(asRecord)
        .filter((part): part is Record<string, unknown> => Boolean(part))
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text as string)
        .join('');
}

export function isOpenCodeCompactionContinuationText(text: string): boolean {
    return text.trim().replace(/\s+/g, ' ') === OPEN_CODE_COMPACTION_CONTINUATION_PROMPT;
}

/**
 * OpenCode emits an unmarked user record after compaction to resume the same
 * turn. Hide only the structurally proven control record and reparent its
 * assistant generations to the preceding visible user turn.
 */
export function planCompactionContinuations(
    rawMessages: RawHistoryMessage[],
    options: CompactionContinuationPlannerOptions,
): CompactionContinuationPlan {
    const syntheticUserIds = new Set<string>();
    const displayParentBySyntheticUserId = new Map<string, string>();
    let lastVisibleUserId: string | undefined;
    let previousWasCompactionSummary = false;

    for (const message of rawMessages) {
        const info = getMessageInfo(message);
        const role = info?.role;
        const id = typeof info?.id === 'string' ? info.id : undefined;
        const text = getText(message);

        if (role === 'user' && id) {
            const isKnownHiddenControl = options.isHiddenControlUserText(text);
            const isPostCompactionContinuation = previousWasCompactionSummary
                && isOpenCodeCompactionContinuationText(text);

            if (isKnownHiddenControl || options.isCompactionSummaryInfo(info) || isPostCompactionContinuation) {
                syntheticUserIds.add(id);
            }
            if (isPostCompactionContinuation && lastVisibleUserId) {
                displayParentBySyntheticUserId.set(id, lastVisibleUserId);
            }
            if (
                text.trim()
                && !isKnownHiddenControl
                && !options.isCompactionSummaryInfo(info)
                && !isPostCompactionContinuation
            ) {
                lastVisibleUserId = id;
            }
        }

        previousWasCompactionSummary = role === 'assistant'
            && options.isCompactionSummaryInfo(info);
    }

    return { syntheticUserIds, displayParentBySyntheticUserId };
}
