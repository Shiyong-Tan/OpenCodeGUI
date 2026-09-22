import { createHash } from 'node:crypto';
import type { NotificationIdentity } from './notification-identity-protocol';
import type { NotificationLookup } from './SupervisorNotificationIngress';

export interface SupervisorAssistantActivity {
    source: Readonly<NotificationIdentity>;
    assistantMessageId: string;
    observedAt: number;
    assistantInfo: Readonly<Record<string, unknown>>;
}
const object = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const canonical = (value: unknown): value is string => typeof value === 'string' && /^msg_[A-Za-z0-9_-]+$/.test(value);

/** Correlates real SSE assistant activity to an exact trusted parent notice.
 * Metadata, polls and empty parts are not activity. No lifecycle or timer writes.
 * Calls run inside the existing classified ingress lane, preserving session order.
 */
export class SupervisorAssistantObserver {
    private readonly assistants = new Map<string, { sessionId: string; source: Readonly<NotificationIdentity>; info: Record<string, unknown> }>();
    private readonly parts = new Map<string, string>();
    private disposed = false;
    constructor(private readonly lookup: NotificationLookup) {}

    async observe(type: string, properties: unknown, observedAt: number): Promise<SupervisorAssistantActivity | undefined> {
        if (this.disposed) return;
        const props = object(properties); if (!props) return;
        if (type === 'message.updated') {
            const info = object(props.info);
            if (!info || info.role !== 'assistant' || info.summary === true || !canonical(info.id) || !canonical(info.parentID) || typeof info.sessionID !== 'string') return;
            const source = await this.lookup(info.sessionID, info.parentID);
            if (this.disposed || !source) return;
            if (source.parentSessionId !== info.sessionID || source.messageId !== info.parentID) throw new Error('Assistant notification ownership mismatch');
            const existing = this.assistants.get(info.id);
            if (existing && (existing.sessionId !== info.sessionID || existing.source.messageId !== source.messageId)) throw new Error('Assistant ownership changed');
            if (!existing && this.assistants.size >= 4096) throw new Error('Supervisor assistant observation capacity reached');
            this.assistants.set(info.id, { sessionId: info.sessionID, source, info: structuredClone(info) });
            return;
        }
        if (type !== 'message.part.updated' && type !== 'message.part.delta') return;
        const part = type === 'message.part.updated' ? object(props.part) : props;
        if (!part || !canonical(part.messageID) || typeof part.sessionID !== 'string') return;
        const assistant = this.assistants.get(part.messageID);
        if (!assistant || assistant.sessionId !== part.sessionID) return;
        let signature: string;
        if (type === 'message.part.delta') {
            if ((part.field !== 'text' && part.field !== 'reasoning') || typeof part.delta !== 'string' || !part.delta.length) return;
            // The service supplies no stable delta event ID. Do not claim per-delta
            // deduplication; the durable round owner deduplicates the round identity.
            signature = '';
        } else {
            const state = object(part.state);
            const textActivity = (part.type === 'text' || part.type === 'reasoning') && typeof part.text === 'string' && part.text.length > 0;
            const toolActivity = part.type === 'tool' && typeof part.callID === 'string' && state && ['pending', 'running', 'completed', 'error'].includes(String(state.status));
            if (!textActivity && !toolActivity) return;
            if (typeof part.id !== 'string' || !part.id) return;
            const key = `${part.sessionID}:${part.messageID}:${part.id}`;
            signature = createHash('sha256').update(JSON.stringify(textActivity ? [part.type, part.text] : [part.type, part.callID, state])).digest('hex');
            if (this.parts.get(key) === signature) return;
            if (!this.parts.has(key) && this.parts.size >= 16384) throw new Error('Supervisor part observation capacity reached');
            this.parts.set(key, signature);
        }
        if (!Number.isSafeInteger(observedAt) || observedAt <= 0) throw new Error('Invalid activity observation time');
        return { source: structuredClone(assistant.source), assistantMessageId: part.messageID, observedAt,
            assistantInfo: structuredClone(assistant.info) };
    }
    sourceFor(sessionId: string, assistantMessageId: string): Readonly<NotificationIdentity> | undefined {
        const assistant = this.assistants.get(assistantMessageId);
        return !this.disposed && assistant?.sessionId === sessionId ? structuredClone(assistant.source) : undefined;
    }
    dispose(): void { this.disposed = true; this.assistants.clear(); this.parts.clear(); }
}
