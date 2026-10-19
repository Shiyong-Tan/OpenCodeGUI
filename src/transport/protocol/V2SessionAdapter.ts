import { BackendOperationError, type BackendPrompt, type BackendSessionPort, type Delivery } from './BackendContract';
import * as codec from './V2Codec';
import { V2Transport } from './V2Transport';

/** Native V2 operations; no emulated V1 requests or inferred session completion. */
export class V2SessionAdapter implements BackendSessionPort {
    constructor(private readonly transport: V2Transport) {}
    private sessionPath(sessionId: string) { return `/api/session/${encodeURIComponent(codec.identity(sessionId, 'ses_'))}`; }
    private inboxPath(sessionId: string, inboxId: string) { return `${this.sessionPath(sessionId)}/inbox/${encodeURIComponent(codec.identity(inboxId, 'msg_'))}`; }
    async listSessions(input: { cursor?: string; limit?: number } = {}) {
        const query = new URLSearchParams({ directory: this.transport.connection.directory });
        if (input.cursor) query.set('cursor', input.cursor);
        else query.set('order', 'desc');
        if (input.limit !== undefined) query.set('limit', String(this.limit(input.limit)));
        return codec.page(await this.transport.request('GET', `/api/session?${query}`), item => codec.session(item));
    }
    async getSession(sessionId: string) {
        return codec.session(codec.data(await this.transport.request('GET', this.sessionPath(sessionId))), sessionId);
    }
    async createSession(input: { parentId?: string; title?: string } = {}) {
        const body = { location: { directory: this.transport.connection.directory },
            ...(input.parentId === undefined ? {} : { parentID: codec.identity(input.parentId, 'ses_') }),
            ...(input.title === undefined ? {} : { title: input.title }) };
        const response = await this.transport.request('POST', '/api/session', body);
        const result = this.mutationResult('V2 session creation', () => codec.session(codec.data(response)));
        if (result.parentId !== input.parentId) throw new BackendOperationError('ambiguous', 'V2 child creation identity');
        return result;
    }
    async messages(sessionId: string, input: { cursor?: string; limit?: number; order?: 'asc' | 'desc' } = {}) {
        const query = new URLSearchParams({ limit: String(this.limit(input.limit ?? 200)) });
        if (input.cursor) query.set('cursor', input.cursor); else query.set('order', input.order ?? 'asc');
        return codec.page(await this.transport.request('GET', `${this.sessionPath(sessionId)}/message?${query}`), item => codec.message(item, sessionId));
    }
    async message(sessionId: string, messageId: string) {
        const result = codec.message(codec.data(await this.transport.request('GET',
            `${this.sessionPath(sessionId)}/message/${encodeURIComponent(codec.identity(messageId, 'msg_'))}`)), sessionId);
        if (result.id !== messageId) throw new BackendOperationError('invalid_response', 'V2 message identity');
        return result;
    }
    async inbox(sessionId: string) {
        return codec.array(codec.data(await this.transport.request('GET', `${this.sessionPath(sessionId)}/inbox`)))
            .map(item => codec.inboxItem(item, sessionId));
    }
    async admit(sessionId: string, prompt: BackendPrompt) {
        codec.identity(prompt.id, 'msg_'); codec.delivery(prompt.delivery);
        codec.text(prompt.text);
        const response = await this.transport.request('POST', `${this.sessionPath(sessionId)}/prompt`, {
            id: prompt.id, text: prompt.text, delivery: prompt.delivery,
            ...(prompt.resume === undefined ? {} : { resume: prompt.resume }),
            ...(prompt.files === undefined ? {} : { files: prompt.files }),
            ...(prompt.metadata === undefined ? {} : { metadata: prompt.metadata }),
        });
        const result = this.mutationResult('V2 prompt admission', () => codec.inboxItem(codec.data(response), sessionId));
        if (result.id !== prompt.id || result.kind !== 'user' || result.delivery !== prompt.delivery) {
            throw new BackendOperationError('ambiguous', 'V2 prompt admission identity or delivery');
        }
        return result;
    }
    async changeDelivery(sessionId: string, inboxId: string, delivery: Delivery) {
        await this.transport.request('PATCH', this.inboxPath(sessionId, inboxId), { delivery: codec.delivery(delivery) });
    }
    async cancelQueued(sessionId: string, inboxId: string) { await this.transport.request('DELETE', this.inboxPath(sessionId, inboxId)); }
    async interrupt(sessionId: string) {
        const response = await this.transport.request('POST', `${this.sessionPath(sessionId)}/interrupt?resume=false`);
        const result = this.mutationResult('V2 interruption acknowledgement', () => codec.object(response));
        if (typeof result.interrupted !== 'boolean') throw new BackendOperationError('ambiguous', 'V2 interruption acknowledgement');
        return { interrupted: result.interrupted };
    }
    private limit(value: number) {
        if (!Number.isSafeInteger(value) || value < 1 || value > 200) throw new BackendOperationError('rejected', 'V2 page size');
        return value;
    }
    private mutationResult<T>(operation: string, parse: () => T): T {
        try { return parse(); }
        catch { throw new BackendOperationError('ambiguous', operation); }
    }
}
