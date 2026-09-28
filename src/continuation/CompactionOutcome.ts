type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const infoOf = (value: unknown): RecordValue => record(record(value).info);

export function isCompactionInfo(value: unknown): boolean {
    const info = record(value);
    return info.summary === true || info.agent === 'compaction' || info.mode === 'compaction';
}

export const COMPACTION_ONLY_STOP = 'OpenCode completed context compaction but stopped without answering this message. Send your question again to continue.';

/** A summary is not an answer. Only a completed summary tied to the current ordinary prompt qualifies. */
export function findCompactionOnlyStop(messages: unknown, userMessageId: string): string | undefined {
    if (!Array.isArray(messages) || !userMessageId) return;
    const anchor = messages.findIndex(item => infoOf(item).id === userMessageId && infoOf(item).role === 'user');
    if (anchor < 0) return;
    const parts = record(messages[anchor]).parts;
    if (!Array.isArray(parts) || parts.some(part => record(part).type === 'compaction')) return;
    const suffix = messages.slice(anchor + 1);
    // A later user/control prompt or a real assistant owns continuation; never terminate it from an old summary.
    if (suffix.some(item => infoOf(item).role === 'user'
        || (infoOf(item).role === 'assistant' && !isCompactionInfo(infoOf(item))))) return;
    const summary = suffix.find(item => {
        const info = infoOf(item);
        return info.role === 'assistant' && info.parentID === userMessageId && isCompactionInfo(info)
            && info.finish === 'stop' && !info.error && typeof record(info.time).completed === 'number';
    });
    return summary ? COMPACTION_ONLY_STOP : undefined;
}

/** The summarize endpoint can return success even when the provider stored an error message. */
export function verifyCompactionResult(before: unknown, after: unknown): void {
    if (!Array.isArray(before) || !Array.isArray(after)) throw new Error('Compaction result could not be verified.');
    const previous = new Set(before.map(item => infoOf(item).id));
    const summaries = after.map(infoOf).filter(info => info.role === 'assistant' && isCompactionInfo(info) && !previous.has(info.id));
    const last = summaries[summaries.length - 1];
    if (last?.error) throw new Error('The model provider failed to complete compaction. Try again when the provider is available.');
    if (!last || last.finish !== 'stop' || typeof record(last.time).completed !== 'number') {
        throw new Error('Compaction result could not be verified. No completed summary was observed.');
    }
}
