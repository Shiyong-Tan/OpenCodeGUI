export type SessionSettingsScope =
    | { kind: 'global' }
    | { kind: 'session'; sessionId: string; isCurrent: boolean };

/**
 * Decides where a model/variant/mode selection change is owned.
 *
 * A real target session id writes that session's persisted settings. An empty
 * session id means the uncommitted new-session draft: it only updates the
 * shared default slot and must never fall back to the currently visible
 * session, otherwise a draft selection would be persisted onto an unrelated
 * session or silently dropped.
 */
export function resolveSessionSettingsScope(
    sessionId: string | undefined,
    currentSessionId: string | undefined,
): SessionSettingsScope {
    if (sessionId) return { kind: 'session', sessionId, isCurrent: sessionId === currentSessionId };
    return { kind: 'global' };
}