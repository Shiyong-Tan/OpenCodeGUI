import type { SupervisorRound } from '../../src/supervisor/SupervisorRoundStore';
interface Message { id: string; role: string; text: string; meta?: Record<string, unknown> }
interface Session {
    messagesById: Map<string, Message>;
    thinkingId?: string | null; currentTurnAssistantKey?: string | null; currentTurnAssistantMsgId?: string | null;
    lastTurnAssistantId?: string | null; lastTurnUserId?: string | null; appendRootUserKey?: string | null;
    cancelledTurn?: boolean; canceledActiveTurn?: boolean; activeTurnOpId?: string | null;
}
export interface SupervisorRoundPresentationHost {
    session(sessionId: string): Session;
    reset(sessionId: string, session: Session): void;
    upsert(session: Session, message: Message): Message;
}
export function validSupervisorRound(value: unknown, sessionId: string): value is SupervisorRound {
    if (!value || typeof value !== 'object') return false;
    const r = value as Partial<SupervisorRound>;
    return r.kind === 'independent' && r.sessionId === sessionId && typeof r.roundId === 'string' && /^msg_[A-Za-z0-9_-]+$/.test(r.roundId)
        && Number.isSafeInteger(r.startedAt) && r.startedAt! > 0 && r.timingBasis === 'first-observed-activity'
        && Array.isArray(r.sources) && r.sources.length > 0 && r.sources.length <= 256
        && r.sources.every(s => s && s.parentSessionId === sessionId && typeof s.taskId === 'string' && typeof s.notificationId === 'string')
        && Array.isArray(r.assistantMessageIds) && r.assistantMessageIds.length <= 1024 && r.assistantMessageIds.includes(r.roundId);
}
/** Presentation only: canonical provenance stays in the Extension round store. */
export function startSupervisorRoundPresentation(host: SupervisorRoundPresentationHost, sessionId: string, value: unknown): boolean {
    if (!validSupervisorRound(value, sessionId) || value.final) return false;
    const session = host.session(sessionId);
    // Reloaded/final messages are immutable. A duplicate start never reopens them.
    if ([...session.messagesById.values()].some(m => (m.meta?.supervisorRound as Partial<SupervisorRound> | undefined)?.roundId === value.roundId)) return false;
    if (session.messagesById.has(value.roundId)) return false;
    host.reset(sessionId, session);
    session.cancelledTurn = false; session.canceledActiveTurn = false; session.activeTurnOpId = null;
    session.lastTurnUserId = null; session.appendRootUserKey = null;
    const message = host.upsert(session, { id: value.roundId, role: 'assistant', text: 'Thinking...', meta: {
        isThinking: true, processingStartedAt: value.startedAt, supervisorRound: structuredClone(value),
        textSegments: [], currentSegment: '', subagents: [], todos: [],
    } });
    session.thinkingId = message.id; session.currentTurnAssistantKey = message.id;
    session.currentTurnAssistantMsgId = message.id; session.lastTurnAssistantId = message.id;
    return true;
}
export function updateSupervisorRoundPresentation(host: SupervisorRoundPresentationHost, sessionId: string, value: unknown): boolean {
    if (!validSupervisorRound(value, sessionId)) return false;
    const session = host.session(sessionId); let changed = false;
    for (const message of session.messagesById.values()) {
        const existing = message.meta?.supervisorRound as Partial<SupervisorRound> | undefined;
        if (existing?.roundId !== value.roundId || message.meta?.isThinking !== true) continue;
        message.meta = { ...message.meta, supervisorRound: structuredClone(value) }; changed = true;
    }
    return changed;
}

export function resumeSupervisorRoundPresentation(host: SupervisorRoundPresentationHost, sessionId: string, value: unknown, assistantMessageId: string): boolean {
    if (!validSupervisorRound(value, sessionId) || value.final) return false;
    const session = host.session(sessionId);
    if (!/^msg_[A-Za-z0-9_-]+$/.test(assistantMessageId)) return false;
    if (!session.messagesById.has(assistantMessageId)) {
        // The host proved current busy status, trusted parent and actual tool activity.
        // This is transient active presentation, not a finalized snapshot record.
        if ([...session.messagesById.values()].some(m => (m.meta?.supervisorRound as Partial<SupervisorRound> | undefined)?.roundId === value.roundId)) return false;
        host.upsert(session, {id: assistantMessageId, role: 'assistant', text: 'Thinking...',
            meta: {supervisorRound: structuredClone(value), processingStartedAt: value.startedAt}});
    }
    const message = session.messagesById.get(assistantMessageId);
    const metadata = message?.meta;
    if (!message || message.role !== 'assistant' || !metadata
        || (metadata.supervisorRound as Partial<SupervisorRound> | undefined)?.roundId !== value.roundId
        || metadata.processingCompletedAt !== undefined
        || (metadata.timeCompleted !== undefined && metadata.supervisorFinish !== 'tool-calls')) return false;
    if (session.currentTurnAssistantMsgId === assistantMessageId && metadata.isThinking === true) return false;
    host.reset(sessionId, session);
    session.lastTurnUserId = null; session.appendRootUserKey = null;
    metadata.isThinking = true; metadata.processingStartedAt = value.startedAt;
    session.thinkingId = message.id; session.currentTurnAssistantKey = message.id;
    session.currentTurnAssistantMsgId = message.id; session.lastTurnAssistantId = message.id;
    return true;
}
