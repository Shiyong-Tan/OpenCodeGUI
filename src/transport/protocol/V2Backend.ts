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
    async transcript(sessionId: string): Promise<BackendMessage[]> {
        const messages: BackendMessage[] = [], cursors = new Set<string>(), ids = new Set<string>(); let cursor: string | undefined;
        let limit = 200;
        for (let page = 0; page < 25600; page++) {
            let result;
            try { result = await this.sessions.messages(sessionId, { limit, cursor }); }
            catch (error) {
                // Retry only this read at the same cursor, with fewer records. Never
                // raise the response bound or silently skip a large history page.
                if (!(error instanceof BackendOperationError) || error.operation !== 'V2 response bound' || limit === 1) throw error;
                limit = Math.max(1, Math.floor(limit / 2));
                continue;
            }
            for (const message of result.items) {
                if (ids.has(message.id)) throw new BackendOperationError('invalid_response', 'V2 duplicate transcript identity');
                ids.add(message.id); messages.push(message);
                if (messages.length > 25600) throw new BackendOperationError('invalid_response', 'V2 transcript message bound');
            }
            if (!result.next) return messages;
            if (cursors.has(result.next)) break;
            cursors.add(result.next); cursor = result.next;
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
        const projected = await this.projection(sessionId);
        return limit === undefined ? projected.messages : projected.messages.slice(-limit);
    }
    async sessionInfo(sessionId: string) { return projectSession(await this.sessions.getSession(sessionId)); }
}
