import { BackendOperationError, type BackendMessage } from './BackendContract';
import { V2ControlAdapter } from './V2ControlAdapter';
import { V2InteractionAdapter } from './V2InteractionAdapter';
import { V2SessionAdapter } from './V2SessionAdapter';
import { V2Transport } from './V2Transport';
import { projectHistory, projectSession } from './V2HistoryProjection';

/** Native transport composition. This class contains no session/turn state or UI writer. */
export class V2Backend {
    readonly sessions: V2SessionAdapter;
    readonly controls: V2ControlAdapter;
    readonly interactions: V2InteractionAdapter;
    constructor(readonly transport: V2Transport) {
        this.sessions = new V2SessionAdapter(transport);
        this.controls = new V2ControlAdapter(transport);
        this.interactions = new V2InteractionAdapter(transport);
    }
    async transcript(sessionId: string, recentLimit?: number): Promise<BackendMessage[]> {
        const messages: BackendMessage[] = [], cursors = new Set<string>(), ids = new Set<string>(); let cursor: string | undefined;
        let limit = Math.min(200, recentLimit ?? 200);
        let smallPages = 0;
        for (let page = 0; page < 25600; page++) {
            let result;
            try { result = await this.sessions.messages(sessionId, { limit, cursor, ...(recentLimit === undefined ? {} : { order: 'desc' as const }) }); }
            catch (error) {
                // Retry only this read at the same cursor, with fewer records. Never
                // raise the response bound or silently skip a large history page.
                if (!(error instanceof BackendOperationError) || error.operation !== 'V2 response bound' || limit === 1) throw error;
                limit = Math.max(1, Math.floor(limit / 2));
                smallPages = 0;
                continue;
            }
            for (const message of result.items) {
                if (ids.has(message.id)) throw new BackendOperationError('invalid_response', 'V2 duplicate transcript identity');
                ids.add(message.id); messages.push(message);
                if (messages.length > 25600) throw new BackendOperationError('invalid_response', 'V2 transcript message bound');
            }
            const ordered = recentLimit === undefined ? messages : [...messages].reverse();
            if (!result.next) return ordered;
            if (recentLimit !== undefined) {
                const visible = projectHistory(sessionId, ordered, false).messages.slice(-recentLimit);
                // A suffix must retain the real user/synthetic anchor for each
                // selected assistant. Native provider completion is not finality.
                if (visible.length >= recentLimit && visible.every(item => item.info.role !== 'assistant' || item.info.parentID)) return ordered;
            }
            if (cursors.has(result.next)) break;
            cursors.add(result.next); cursor = result.next;
            // Grow again after small pages, but do not repeatedly combine
            // adjacent oversized records. Estimate the next page under half
            // the normal response budget using the payload just received.
            const bytes = Buffer.byteLength(JSON.stringify(result.items.map(item => item.native)));
            if (bytes > 4 * 1024 * 1024) {
                limit = Math.max(1, Math.floor(result.items.length * 4 * 1024 * 1024 / bytes));
                smallPages = 0;
            } else if (++smallPages >= 16) {
                limit = Math.min(200, limit * 2);
                smallPages = 0;
            }
        }
        throw new BackendOperationError('invalid_response', 'V2 transcript pagination bound');
    }
    async projection(sessionId: string) {
        const transcript = await this.transcript(sessionId), active = await this.controls.active();
        const projected = projectHistory(sessionId, transcript, active[sessionId] === 'running');
        let outcome: BackendMessage['outcome'];
        for (const message of transcript) {
            if (['user', 'synthetic', 'assistant'].includes(message.kind)) outcome = undefined;
            if (message.kind === 'idle') outcome = message.outcome;
        }
        return { ...projected, active: active[sessionId] === 'running', outcome: active[sessionId] === 'running' ? undefined : outcome };
    }
    async history(sessionId: string, limit?: number) {
        if (limit === undefined) return (await this.projection(sessionId)).messages;
        const safeLimit = Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 200));
        const transcript = await this.transcript(sessionId, safeLimit), active = await this.controls.active();
        return projectHistory(sessionId, transcript, active[sessionId] === 'running').messages.slice(-safeLimit);
    }
    async message(sessionId: string, messageId: string) {
        const record = await this.sessions.message(sessionId, messageId);
        const projected = projectHistory(sessionId, [record], false).messages[0];
        if (!projected) throw new BackendOperationError('invalid_response', 'V2 visible message detail');
        // Explicit assistant errors still expire residual permission requests;
        // this does not manufacture a successful execution/idle boundary.
        if (record.native.error !== undefined) projected.info.error = record.native.error;
        return projected;
    }
    async sessionInfo(sessionId: string) { return projectSession(await this.sessions.getSession(sessionId)); }
}
