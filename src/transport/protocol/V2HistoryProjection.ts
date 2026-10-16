import type { BackendMessage, BackendRecord, BackendSession } from './BackendContract';
import { array, object, text } from './V2Codec';

/** Existing UI history DTO, not a V1 wire response. Native control records stay separate. */
export interface UiHistoryMessage { info: Record<string, unknown>; parts: Record<string, unknown>[] }
export interface UiHistoryProjection { messages: UiHistoryMessage[]; controls: readonly BackendMessage[] }
export function projectSession(session: BackendSession): Record<string, unknown> {
    return { ...session.native, id: session.id, parentID: session.parentId, title: session.title,
        directory: session.location.directory, path: { cwd: session.location.directory },
        modelID: objectOrEmpty(session.native.model).id, providerID: objectOrEmpty(session.native.model).providerID };
}
function objectOrEmpty(value: unknown): BackendRecord { return value === undefined ? {} : object(value); }

/** Project a complete ordered transcript. Only a native execution outcome establishes finality. */
export function projectHistory(sessionId: string, transcript: readonly BackendMessage[], active: boolean): UiHistoryProjection {
    const messages: UiHistoryMessage[] = [], controls: BackendMessage[] = [];
    let parentId: string | undefined, lastAssistant: UiHistoryMessage | undefined;
    for (const message of transcript) {
        const raw = message.native;
        if (message.kind === 'user') {
            parentId = message.id; lastAssistant = undefined;
            messages.push({ info: { id: message.id, sessionID: sessionId, role: 'user', time: { created: message.createdAt } },
                parts: [{ id: `${message.id}_text`, type: 'text', messageID: message.id, sessionID: sessionId, text: text(raw.text) },
                    ...(raw.files === undefined ? [] : array(raw.files).map(item => { const file = object(item); return {
                        ...file, url: file.uri, filename: file.name, type: 'file', messageID: message.id, sessionID: sessionId }; })) ] });
        } else if (message.kind === 'assistant') {
            const ref = objectOrEmpty(raw.model), content = array(raw.content).map(object);
            // Native text/reasoning ordinals are per kind, not content-array positions.
            // Replay must address the same part as its live delta/full-value boundary.
            const ordinals = new Map<unknown, number>();
            const parts = content.map(part => {
                const ordinal = ordinals.get(part.type) ?? 0;
                ordinals.set(part.type, ordinal + 1);
                return part.type === 'tool' ? {
                    id: `${message.id}_${part.id}`, sessionID: sessionId, messageID: message.id, type: 'tool',
                    callID: part.id, tool: part.name, state: projectToolState(part.state),
                } : { ...part, id: part.type === 'text' ? `${message.id}_${ordinal}` : `${message.id}_${part.type}_${ordinal}`,
                    sessionID: sessionId, messageID: message.id };
            });
            lastAssistant = { info: { id: message.id, sessionID: sessionId, role: 'assistant', parentID: parentId,
                agent: raw.agent, modelID: ref.id, providerID: ref.providerID, variant: ref.variant,
                time: { created: message.createdAt }, tokens: raw.tokens, cost: raw.cost,
                summary: { diffs: Array.isArray(objectOrEmpty(raw.snapshot).files) ?
                    (objectOrEmpty(raw.snapshot).files as unknown[]).map(file => ({ path: text(file) })) : [] } }, parts };
            messages.push(lastAssistant);
        } else {
            controls.push(message);
            if (message.kind === 'synthetic') { parentId = message.id; lastAssistant = undefined; }
            if (message.kind === 'idle' && lastAssistant) {
                // Active snapshot suppresses only the latest execution's old terminal boundary below.
                lastAssistant.info.time = { created: object(lastAssistant.info.time).created, completed: message.createdAt };
                lastAssistant.info.finish = message.outcome === 'succeeded' ? 'stop' : undefined;
                if (message.outcome !== 'succeeded') lastAssistant.info.error = {
                    name: message.outcome === 'interrupted' ? 'MessageAbortedError' : 'ExecutionError',
                    data: { message: message.outcome === 'interrupted' ? 'Execution interrupted' : 'Execution failed' },
                };
            }
        }
    }
    if (active && lastAssistant) {
        lastAssistant.info.time = { created: object(lastAssistant.info.time).created };
        delete lastAssistant.info.finish; delete lastAssistant.info.error;
    }
    return { messages, controls };
}
export function projectToolState(value: unknown): Record<string, unknown> {
    const state = object(value);
    const output = state.content === undefined ? undefined : array(state.content).map(object)
        .filter(item => item.type === 'text').map(item => text(item.text)).join('\n');
    return { ...state, status: state.status === 'streaming' ? 'pending' : state.status, ...(output === undefined ? {} : { output }) };
}
