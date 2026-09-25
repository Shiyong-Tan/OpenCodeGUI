import { createHmac, randomBytes } from 'crypto';

export interface PermissionCard {
    sessionId: string; requestId: string; scopeSessionId: string; title: string; agent: string;
    permission: string; patterns: string[]; tool: string; input: string;
    state: 'pending' | 'expired' | 'unknown'; reason: string; reviewToken: string;
}
export interface PermissionSnapshot { scopeSessionId: string; requests: PermissionCard[] }
export interface PermissionConnection {
    identity: string; directory: string;
    read(path: string): Promise<unknown>;
    reply(path: string, body: { reply: 'once' | 'always' | 'reject' }): Promise<unknown>;
}
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid permission response');
    return value as RecordValue;
}
const text = (value: unknown) => typeof value === 'string' ? value : '';
const directoryKey = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const sid = (value: string) => /^ses_[A-Za-z0-9_-]{1,160}$/.test(value);

/** The server owns pending requests. This owner verifies scope and issues review tokens;
 * it never creates permissions, retries a reply, or infers process termination. */
export class PermissionReviewService {
    private readonly secret = randomBytes(32);
    private readonly decisions = new Map<string, Promise<void>>();
    private readonly completed = new Set<string>();
    constructor(private readonly connect: (sessionId: string) => Promise<PermissionConnection>) {}

    private async inspect(scopeSessionId: string, conn: PermissionConnection): Promise<PermissionSnapshot> {
        if (!sid(scopeSessionId)) throw new Error('Invalid permission scope session');
        const sessionCache = new Map<string, Promise<RecordValue>>();
        const messages = new Map<string, Promise<unknown>>();
        const session = (id: string) => {
            if (!sid(id)) throw new Error('Invalid permission owner session');
            let pending = sessionCache.get(id);
            if (!pending) {
                pending = conn.read(`/session/${encodeURIComponent(id)}`).then(value => {
                    const info = record(value);
                    if (info.id !== id || directoryKey(text(info.directory)) !== directoryKey(conn.directory))
                        throw new Error('Permission session/workspace identity mismatch');
                    return info;
                });
                sessionCache.set(id, pending);
            }
            return pending;
        };
        await session(scopeSessionId);
        const raw = await conn.read('/permission');
        if (!Array.isArray(raw) || raw.length > 1024) throw new Error('Invalid permission list');
        const seen = new Set<string>(), requests: PermissionCard[] = [];
        for (const item of raw) {
            const req = record(item), requestId = text(req.id), sessionId = text(req.sessionID);
            if (!requestId || !sid(sessionId) || seen.has(requestId)) throw new Error('Invalid permission identity');
            seen.add(requestId);
            const owner = await session(sessionId);
            let ancestor = sessionId, belongs = false;
            const visited = new Set<string>();
            for (let depth = 0; depth < 32; depth++) {
                if (ancestor === scopeSessionId) { belongs = true; break; }
                if (visited.has(ancestor)) throw new Error('Cyclic permission session ancestry');
                visited.add(ancestor);
                const parent = text((await session(ancestor)).parentID);
                if (!parent) break;
                ancestor = parent;
            }
            if (!belongs) continue;
            if (!Array.isArray(req.patterns) || req.patterns.length > 256 || req.patterns.some(p => typeof p !== 'string'))
                throw new Error('Invalid permission patterns');
            const permission = text(req.permission);
            const patterns = req.patterns as string[];
            const card: PermissionCard = { sessionId, requestId, scopeSessionId, title: text(owner.title), agent: text(owner.agent),
                permission, patterns, tool: '', input: '', state: 'unknown', reason: 'Tool association unavailable; cannot safely reply', reviewToken: '' };
            if (req.tool) {
                const tool = record(req.tool), messageId = text(tool.messageID), callId = text(tool.callID);
                if (!messageId || !callId) throw new Error('Invalid permission tool identity');
                const messageKey = `${sessionId}:${messageId}`;
                let pending = messages.get(messageKey);
                if (!pending) { pending = conn.read(`/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`);
                    messages.set(messageKey, pending); }
                const message = record(await pending), info = record(message.info);
                if (info.id !== messageId || info.sessionID !== sessionId || !Array.isArray(message.parts))
                    throw new Error('Permission message ownership mismatch');
                const part = message.parts.map(record).find(p => p.type === 'tool' && p.callID === callId);
                if (part) {
                    const state = record(part.state);
                    card.tool = text(part.tool); card.input = JSON.stringify(state.input ?? {});
                    if (['completed', 'error'].includes(text(state.status)) || info.error) {
                        card.state = 'expired'; card.reason = 'Tool finished or aborted; residual request cannot be approved';
                    } else if (['pending', 'running'].includes(text(state.status))) {
                        card.state = 'pending'; card.reason = '';
                    }
                } else if (info.error) { card.state = 'expired'; card.reason = 'Assistant aborted; residual request cannot be approved'; }
            }
            if (JSON.stringify(card).length > 64000) throw new Error('Permission details exceed display bound');
            if (card.state === 'pending') card.reviewToken = createHmac('sha256', this.secret)
                .update(JSON.stringify([conn.identity, conn.directory, scopeSessionId, req, card.tool, card.input])).digest('hex');
            requests.push(card);
        }
        return { scopeSessionId, requests };
    }

    async snapshot(scopeSessionId: string): Promise<PermissionSnapshot> {
        return this.inspect(scopeSessionId, await this.connect(scopeSessionId));
    }

    async respond(input: { scopeSessionId: string; sessionId: string; requestId: string; reviewToken: string; response: 'once' | 'always' | 'reject' }): Promise<void> {
        if (!input.reviewToken || !['once', 'always', 'reject'].includes(input.response)) throw new Error('Explicit reviewed permission decision required');
        const key = `${input.sessionId}:${input.requestId}`;
        if (this.decisions.has(key) || this.completed.has(key)) throw new Error('This permission decision was already submitted; refresh its state');
        if (this.completed.size >= 4096) throw new Error('Permission decision capacity reached');
        const decision = (async () => {
            const conn = await this.connect(input.scopeSessionId);
            const fresh = await this.inspect(input.scopeSessionId, conn);
            const request = fresh.requests.find(r => r.sessionId === input.sessionId && r.requestId === input.requestId);
            if (!request || request.state !== 'pending' || request.reviewToken !== input.reviewToken)
                throw new Error('Permission expired, changed, or no longer belongs to this session; refresh before responding');
            const result = await conn.reply(`/permission/${encodeURIComponent(input.requestId)}/reply`, { reply: input.response });
            if (result !== true) throw new Error('Permission reply was not acknowledged; refresh before responding');
            this.completed.add(key);
        })();
        this.decisions.set(key, decision);
        // A failed reply requires a new explicit click plus fresh server validation; no transport retry.
        try { return await decision; } finally { this.decisions.delete(key); }
    }
}
