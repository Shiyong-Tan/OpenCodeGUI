/** Error cleanup is addressed by the failed command's temporary identity, never the visible session. */
export function isEmptyFailedPlaceholder(message: unknown, key: unknown, failedKey: unknown, finalId: unknown): boolean {
    if (!key || key !== failedKey || finalId || !message || typeof message !== 'object') return false;
    const value = message as { text?: unknown; meta?: Record<string, unknown> };
    if (typeof value.text === 'string' && value.text.trim() && value.text !== 'Thinking...') return false;
    const meta = value.meta ?? {};
    const transient = new Set(['isThinking', 'parentClientMessageId', 'processingStartedAt', 'processingCompletedAt',
        'processingPausedMs', 'processingPausedAt', 'timeCreated', 'timeCompleted', 'statusText']);
    // Unknown metadata may contain tool results or attachments: retain it rather than discard evidence.
    return Object.entries(meta).every(([name, item]) => transient.has(name) || item == null || item === ''
        || (Array.isArray(item) && item.length === 0));
}
