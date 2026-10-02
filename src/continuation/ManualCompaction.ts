type Data = Record<string, unknown>;
const record = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
export type CompactionRequest = (method: string, path: string, body?: unknown) => Promise<unknown>;

/** A failed manual control at the tail can be replayed against the next ordinary prompt. */
export function failedManualCompaction(messages: unknown, sessionId: string): { messageId: string; partId: string } | undefined {
    if (!Array.isArray(messages)) throw new Error('Compaction history could not be verified.');
    let index = messages.length - 1;
    while (index >= 0 && record(record(messages[index]).info).role !== 'user') index--;
    if (index < 0) return;
    const message = record(messages[index]), info = record(message.info);
    const parts = message.parts;
    if (info.sessionID !== sessionId || typeof info.id !== 'string' || !Array.isArray(parts) || parts.length !== 1) return;
    const part = record(parts[0]);
    if (part.type !== 'compaction' || part.auto !== false || typeof part.id !== 'string'
        || part.sessionID !== sessionId || part.messageID !== info.id) return;
    const suffix = messages.slice(index + 1).map(item => record(record(item).info));
    if (!suffix.length || suffix.some(item => item.role !== 'assistant' || item.sessionID !== sessionId
        || item.parentID !== info.id || item.summary !== true || !item.error
        || typeof record(item.time).completed !== 'number')) return;
    return { messageId: info.id, partId: part.id };
}

/** Delete only a proven failed control, keeping all user text and failure evidence. Never invokes a model. */
export async function repairFailedManualCompaction(sessionId: string, request: CompactionRequest): Promise<boolean> {
    const history = `/session/${encodeURIComponent(sessionId)}/message?limit=20`;
    const candidate = failedManualCompaction(await request('GET', history), sessionId);
    if (!candidate) return false;
    const statuses = await request('GET', '/session/status');
    if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)
        || (record(statuses)[sessionId] && record(record(statuses)[sessionId]).type !== 'idle')) {
        throw new Error('Failed compaction cleanup is waiting for the session to become idle. Retry after it stops.');
    }
    const confirmed = failedManualCompaction(await request('GET', history), sessionId);
    if (!confirmed || confirmed.messageId !== candidate.messageId || confirmed.partId !== candidate.partId) {
        throw new Error('Session changed during compaction cleanup. Retry.');
    }
    await request('DELETE', `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(candidate.messageId)}/part/${encodeURIComponent(candidate.partId)}`);
    const after = await request('GET', history);
    if (!Array.isArray(after) || after.some(item => {
        const parts = record(item).parts;
        return Array.isArray(parts) && parts.some(part => record(part).id === candidate.partId);
    })) throw new Error('Failed compaction cleanup could not be confirmed. Retry before sending another message.');
    return true;
}
