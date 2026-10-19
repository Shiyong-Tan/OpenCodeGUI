import type { ChatEvent } from '../OpenCodeClient';

export interface SubagentToolProgress {
    sessionId: string; assistantMessageId: string; callId: string;
    name: string; input: string; status: 'pending' | 'streaming' | 'running' | 'completed' | 'error';
    settledAt?: number;
    progressText?: string;
    executionId?: string;
}
const terminal = (status: string) => status === 'completed' || status === 'error';
/** Pure update of the existing subagent owner's tool collection, never a separate store. */
export function updateSubagentTools(current: readonly SubagentToolProgress[], event: ChatEvent, now = Date.now()): SubagentToolProgress[] | undefined {
    const sessionId = event.sessionId, assistantMessageId = event.assistantMsgId || event.messageId, callId = event.callId;
    const status = event.toolState?.status;
    if (!sessionId || !assistantMessageId || !callId || !event.tool || !status ||
        !['pending', 'streaming', 'running', 'completed', 'error'].includes(status)) return undefined;
    const index = current.findIndex(item => item.sessionId === sessionId && item.assistantMessageId === assistantMessageId && item.callId === callId);
    const previous = current[index];
    if (previous && (terminal(previous.status) || previous.status === 'running' && ['pending', 'streaming'].includes(status))) return [...current];
    const input = event.toolState?.input;
    const display = input && typeof input === 'object' ? input.filePath || input.path || input.pattern || input.query || input.command : undefined;
    const next: SubagentToolProgress = { sessionId, assistantMessageId, callId, name: event.tool,
        input: typeof display === 'string' ? display.slice(0, 2048) : previous?.input || '', status: status as SubagentToolProgress['status'],
        ...(typeof input?.executionId === 'string' ? { executionId: input.executionId } : previous?.executionId ? { executionId: previous.executionId } : {}),
        ...(typeof event.toolState?.progressText === 'string' && event.toolState.progressText.trim() ?
            { progressText: event.toolState.progressText.slice(0, 256) } : {}),
        // Dwell only for a locally observed active -> terminal transition. An
        // already-settled record first seen during replay is not a fresh tool.
        ...(terminal(status) && previous ? { settledAt: now } : {}) };
    const result = [...current];
    if (index < 0) result.push(next); else result[index] = next;
    // Bound settled history while retaining every pending parallel call.
    let settled = 0;
    const omitted = result.filter(item => terminal(item.status)).length - 32;
    return result.filter(item => !terminal(item.status) || ++settled > omitted);
}
