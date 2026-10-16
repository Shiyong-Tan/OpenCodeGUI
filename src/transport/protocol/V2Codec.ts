import { BackendOperationError, type BackendInboxItem, type BackendMessage, type BackendPage,
    type BackendRecord, type BackendSession, type BackendTool, type Delivery } from './BackendContract';

export const invalid = (): never => { throw new BackendOperationError('invalid_response', 'decode V2 response'); };
export function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    return value as Record<string, unknown>;
}
export const array = (value: unknown): unknown[] => Array.isArray(value) ? value : invalid();
export const text = (value: unknown): string => typeof value === 'string' ? value : invalid();
export function identity(value: unknown, prefix: 'ses_' | 'msg_'): string {
    const id = text(value);
    if (!id.startsWith(prefix) || !/^[A-Za-z0-9_-]{1,256}$/.test(id) || id.length <= prefix.length) return invalid();
    return id;
}
const timestamp = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : invalid();
const optionalText = (value: unknown) => value === undefined || value === null ? undefined : text(value);
export const data = (value: unknown): unknown => object(value).data;
export function delivery(value: unknown): Delivery { return value === 'queue' || value === 'steer' ? value : invalid(); }

export function session(value: unknown, expectedId?: string): BackendSession {
    const raw = object(value), id = identity(raw.id, 'ses_'), time = object(raw.time);
    if (expectedId !== undefined && id !== expectedId) return invalid();
    return { id, parentId: raw.parentID == null ? undefined : identity(raw.parentID, 'ses_'),
        title: optionalText(raw.title), createdAt: timestamp(time.created), updatedAt: timestamp(time.updated),
        location: object(raw.location), native: raw };
}
export function page<T>(value: unknown, parse: (item: unknown) => T): BackendPage<T> {
    const raw = object(value), cursor = object(raw.cursor);
    return { items: array(raw.data).map(parse), next: optionalText(cursor.next), previous: optionalText(cursor.previous) };
}
export function tool(value: unknown, sessionId: string, assistantMessageId: string): BackendTool {
    const raw = object(value), state = object(raw.state);
    if (!['streaming', 'running', 'completed', 'error'].includes(text(state.status))) return invalid();
    const callId = text(raw.id);
    if (!callId || callId.length > 1024) return invalid();
    return { sessionId, assistantMessageId, callId, name: text(raw.name),
        status: state.status as BackendTool['status'], native: raw };
}
export function message(value: unknown, sessionId: string): BackendMessage {
    const raw = object(value), id = identity(raw.id, 'msg_'), kind = text(raw.type), time = object(raw.time);
    const tools = kind === 'assistant' ? array(raw.content).filter(item => object(item).type === 'tool')
        .map(item => tool(item, sessionId, id)) : [];
    if (new Set(tools.map(item => item.callId)).size !== tools.length) return invalid();
    let outcome: BackendMessage['outcome'];
    if (kind === 'idle') {
        if (!['succeeded', 'failed', 'interrupted'].includes(text(raw.outcome))) return invalid();
        outcome = raw.outcome as BackendMessage['outcome'];
    }
    // Unknown record kinds remain visible to the domain as unknown facts, never inferred finals.
    return { sessionId, id, kind, createdAt: timestamp(time.created), tools, outcome, native: raw };
}
export function inboxItem(value: unknown, sessionId: string): BackendInboxItem {
    const raw = object(value), owner = identity(raw.sessionID, 'ses_');
    if (owner !== sessionId) return invalid();
    return { sessionId, id: identity(raw.id, 'msg_'), kind: text(raw.type), delivery: delivery(raw.delivery), native: raw };
}
export function toolIdentity(tool: Pick<BackendTool, 'sessionId' | 'assistantMessageId' | 'callId'>): string {
    return JSON.stringify([tool.sessionId, tool.assistantMessageId, tool.callId]);
}
