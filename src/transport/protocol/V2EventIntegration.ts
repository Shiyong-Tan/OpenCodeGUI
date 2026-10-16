import type { BackendEvent } from './V2EventAdapter';
import type { V2Backend } from './V2Backend';
import { object } from './V2Codec';

export interface NativeEventOwner {
    isCurrent(): boolean;
    session(info: Record<string, unknown>): void;
    accepts(sessionId: string): boolean;
    step(event: BackendEvent): void;
    text(event: BackendEvent): void;
    tool(event: BackendEvent): void;
    delivered(sessionId: string, inboxId: string): Promise<void>;
    reconcile(sessionId: string): Promise<void>;
    interaction(sessionId: string): void;
    compaction?(event: BackendEvent): void;
    activity?(event: BackendEvent): void;
    failure(sessionId: string | undefined, error: unknown): void;
}

/** Serialize native boundary work per session. Jobs are transport work, never UI state. */
export class V2EventIntegration {
    private readonly jobs = new Map<string, Promise<void>>();
    private readonly received = new Set<string>();
    constructor(private readonly backend: V2Backend, private readonly owner: NativeEventOwner) {}
    receive(event: BackendEvent): void {
        const sessionId = event.sessionId;
        if (!sessionId || !this.owner.isCurrent()) return;
        if (this.received.has(event.id)) return;
        this.received.add(event.id);
        if (this.received.size > 20000) this.received.delete(this.received.values().next().value!);
        const previous = this.jobs.get(sessionId) ?? Promise.resolve();
        const work = previous.catch(() => undefined).then(async () => {
            if (!this.owner.isCurrent()) return;
            if (event.category === 'compaction') { this.owner.compaction?.(event); return; }
            if (event.type === 'session.created' || event.type === 'session.forked') {
                const info = await this.backend.sessionInfo(sessionId);
                if (this.owner.isCurrent()) this.owner.session(info);
            }
            if (!this.owner.accepts(sessionId)) return;
            this.owner.activity?.(event);
            if (event.type === 'session.step.started') this.owner.step(event);
            else if (event.category === 'text') this.owner.text(event);
            else if (event.category === 'tool') this.owner.tool(event);
            else if (event.type === 'session.inbox.delivered') await this.owner.delivered(sessionId, String(event.payload.inboxID));
            else if (event.category === 'execution' && event.type !== 'session.execution.started') await this.owner.reconcile(sessionId);
            else if (event.category === 'interaction') this.owner.interaction(sessionId);
        });
        this.jobs.set(sessionId, work);
        void work.catch(error => { if (this.owner.isCurrent()) this.owner.failure(sessionId, error); })
            .finally(() => { if (this.jobs.get(sessionId) === work) this.jobs.delete(sessionId); });
    }
}

/** Runtime-validated event fragments; no terminal inference from tool or step completion. */
export function nativeToolFragment(event: BackendEvent, previous: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    const state = previous?.state ? object(previous.state) : { status: 'pending', input: {} };
    const fragment: Record<string, unknown> = { ...previous, id: `${event.assistantMessageId}_${event.callId}`,
        sessionID: event.sessionId, messageID: event.assistantMessageId, type: 'tool', callID: event.callId };
    const payload = event.payload;
    if (event.type === 'session.tool.input.started') fragment.tool = payload.name;
    if (typeof fragment.tool !== 'string') return undefined;
    // Terminal call facts cannot be reopened by delayed progress.
    if (['completed', 'error'].includes(String(state.status))) return undefined;
    if (event.type === 'session.tool.called') fragment.state = { status: 'running', input: object(payload.input) };
    else if (event.type === 'session.tool.progress') fragment.state = { ...state, metadata: object(payload.metadata) };
    else if (event.type === 'session.tool.success' || event.type === 'session.tool.failed') {
        const content = Array.isArray(payload.content) ? payload.content : [];
        const output = content.map(object).filter(item => item.type === 'text').map(item => String(item.text)).join('\n');
        fragment.state = { ...state, status: event.type === 'session.tool.success' ? 'completed' : 'error', output,
            ...(payload.error === undefined ? {} : { error: payload.error }), metadata: payload.metadata };
    } else fragment.state = state;
    return fragment;
}
