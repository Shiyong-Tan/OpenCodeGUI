import type { BackendRecord } from './BackendContract';
import { identity, invalid, object, text } from './V2Codec';

export type BackendEventCategory = 'execution' | 'step' | 'tool' | 'text' | 'reasoning' |
    'inbox' | 'compaction' | 'revert' | 'session' | 'interaction' | 'server' | 'unknown';
export interface BackendEvent {
    readonly id: string; readonly type: string; readonly category: BackendEventCategory;
    readonly sessionId?: string; readonly assistantMessageId?: string; readonly callId?: string;
    readonly ordinal?: number;
    readonly createdAt?: number; readonly location?: BackendRecord; readonly payload: BackendRecord;
}
const execution = new Set(['session.execution.started', 'session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted']);
const step = new Set(['session.step.started', 'session.step.streamed', 'session.step.ended', 'session.step.failed', 'session.retry.scheduled']);
const tool = new Set(['session.tool.input.started', 'session.tool.input.delta', 'session.tool.input.ended',
    'session.tool.called', 'session.tool.progress', 'session.tool.success', 'session.tool.failed']);
const textEvents = new Set(['session.text.started', 'session.text.delta', 'session.text.ended']);
const reasoning = new Set(['session.reasoning.started', 'session.reasoning.delta', 'session.reasoning.ended']);
const inbox = new Set(['session.inbox.enqueued', 'session.inbox.delivered', 'session.inbox.cancelled', 'session.inbox.delivery.changed']);
const compaction = new Set(['session.compaction.started', 'session.compaction.delta', 'session.compaction.ended', 'session.compaction.failed']);
const revert = new Set(['session.revert.staged', 'session.revert.cleared', 'session.revert.committed']);
function category(type: string): BackendEventCategory {
    if (execution.has(type)) return 'execution';
    if (step.has(type)) return 'step';
    if (tool.has(type)) return 'tool';
    if (textEvents.has(type)) return 'text';
    if (reasoning.has(type)) return 'reasoning';
    if (inbox.has(type)) return 'inbox';
    if (compaction.has(type)) return 'compaction';
    if (revert.has(type)) return 'revert';
    if (['form.created', 'form.replied', 'form.cancelled', 'permission.asked', 'permission.replied'].includes(type)) return 'interaction';
    if (type === 'server.connected') return 'server';
    if (['session.created', 'session.deleted', 'session.forked', 'session.model.selected', 'session.agent.selected', 'session.moved',
        'session.renamed', 'session.metadata.updated', 'session.permissions', 'session.viewed'].includes(type)) return 'session';
    return 'unknown';
}

/** Pure wire projection. It does not finish turns, merge tools or mutate session stores. */
export function decodeV2Event(value: unknown): BackendEvent {
    const raw = object(value), type = text(raw.type), id = text(raw.id), payload = object(raw.data);
    if (!/^evt_[A-Za-z0-9_-]{1,240}$/.test(id)) return invalid();
    const kind = category(type);
    const owner = type === 'form.created' ? object(payload.form).sessionID : payload.sessionID;
    const sessionId = owner === undefined ? undefined :
        owner === 'global' && kind === 'interaction' ? undefined : identity(owner, 'ses_');
    if (['execution', 'step', 'tool', 'text', 'reasoning', 'inbox', 'compaction', 'revert', 'session'].includes(kind) && !sessionId) return invalid();
    if (kind === 'inbox') identity(payload.inboxID, 'msg_');
    const assistantMessageId = payload.assistantMessageID === undefined ? undefined : identity(payload.assistantMessageID, 'msg_');
    if ((['tool', 'text', 'reasoning'].includes(kind) || type.startsWith('session.step.')) && !assistantMessageId) return invalid();
    const ordinal = kind === 'text' || kind === 'reasoning' ? payload.ordinal : undefined;
    if ((kind === 'text' || kind === 'reasoning') && (typeof ordinal !== 'number' || !Number.isSafeInteger(ordinal) || ordinal < 0)) return invalid();
    const callId = kind === 'tool' ? text(payload.id) : undefined;
    if (kind === 'tool' && (!callId || callId.length > 1024)) return invalid();
    if (raw.created !== undefined && (typeof raw.created !== 'number' || !Number.isFinite(raw.created) || raw.created < 0)) return invalid();
    return { id, type, category: kind, sessionId, assistantMessageId, callId, ordinal: ordinal as number | undefined,
        createdAt: raw.created as number | undefined, location: raw.location === undefined ? undefined : object(raw.location), payload };
}
