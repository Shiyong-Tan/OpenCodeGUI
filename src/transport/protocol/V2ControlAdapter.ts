import { BackendOperationError, type BackendInboxItem, type BackendRecord } from './BackendContract';
import { array, data, delivery, identity, inboxItem, invalid, object, session, text } from './V2Codec';
import { V2Transport } from './V2Transport';

export interface NativeModelRef { readonly providerID: string; readonly id: string; readonly variant?: string }
export interface NativeModel {
    readonly ref: NativeModelRef; readonly name: string; readonly enabled: boolean;
    readonly variants: readonly string[]; readonly contextLimit: number; readonly native: BackendRecord;
}
export interface NativeAgent {
    readonly id: string; readonly name: string; readonly mode: 'primary' | 'subagent' | 'all';
    readonly hidden: boolean; readonly model?: NativeModelRef; readonly native: BackendRecord;
}
function modelRef(value: unknown): NativeModelRef {
    const raw = object(value), providerID = text(raw.providerID), id = text(raw.id);
    if (!providerID || !id || raw.variant !== undefined && !text(raw.variant)) return invalid();
    return { providerID, id, ...(raw.variant === undefined ? {} : { variant: text(raw.variant) }) };
}
function model(value: unknown): NativeModel {
    const raw = object(value), limit = object(raw.limit);
    if (typeof raw.enabled !== 'boolean' || typeof limit.context !== 'number' || !Number.isSafeInteger(limit.context) || limit.context <= 0) return invalid();
    return { ref: modelRef(raw), name: text(raw.name), enabled: raw.enabled,
        variants: array(raw.variants).map(item => text(object(item).id)), contextLimit: limit.context, native: raw };
}
function agent(value: unknown): NativeAgent {
    const raw = object(value), mode = text(raw.mode);
    if (!['primary', 'subagent', 'all'].includes(mode) || typeof raw.hidden !== 'boolean') return invalid();
    return { id: text(raw.id), name: text(raw.name), mode: mode as NativeAgent['mode'], hidden: raw.hidden,
        model: raw.model === undefined ? undefined : modelRef(raw.model), native: raw };
}

/** Control operations are explicit; none are emulated as a prompt or a V1 summarize/revert. */
export class V2ControlAdapter {
    constructor(private readonly transport: V2Transport) {}
    private path(sessionId: string) { return `/api/session/${encodeURIComponent(identity(sessionId, 'ses_'))}`; }
    private location(path: string) { return `${path}?directory=${encodeURIComponent(this.transport.connection.directory)}`; }
    async models(): Promise<readonly NativeModel[]> {
        return array(data(await this.transport.request('GET', this.location('/api/model')))).map(model);
    }
    async agents(): Promise<readonly NativeAgent[]> {
        return array(data(await this.transport.request('GET', this.location('/api/agent')))).map(agent);
    }
    async active(): Promise<Readonly<Record<string, 'running'>>> {
        const raw = object(data(await this.transport.request('GET', '/api/session/active')));
        const result: Record<string, 'running'> = Object.create(null);
        for (const [id, state] of Object.entries(raw)) {
            identity(id, 'ses_');
            if (object(state).type !== 'running') return invalid();
            result[id] = 'running';
        }
        return result;
    }
    async selectModel(sessionId: string, ref: NativeModelRef) {
        const selected = modelRef(ref), catalog = await this.models();
        const available = catalog.find(item => item.ref.id === selected.id && item.ref.providerID === selected.providerID && item.enabled);
        if (!available || selected.variant !== undefined && !available.variants.includes(selected.variant))
            throw new BackendOperationError('rejected', 'V2 unavailable model selection');
        await this.transport.request('POST', `${this.path(sessionId)}/model`, { model: selected });
    }
    async selectAgent(sessionId: string, agentId: string) {
        if (!(await this.agents()).some(item => item.id === agentId)) throw new BackendOperationError('rejected', 'V2 unavailable agent selection');
        await this.transport.request('POST', `${this.path(sessionId)}/agent`, { agent: agentId });
    }
    async rename(sessionId: string, title: string) {
        if (!title.trim()) throw new BackendOperationError('rejected', 'V2 empty session title');
        await this.transport.request('PATCH', this.path(sessionId), { title: title.trim() });
    }
    async remove(sessionId: string) { await this.transport.request('DELETE', this.path(sessionId)); }
    async fork(sessionId: string, before?: string) {
        const response = await this.transport.request('POST', `${this.path(sessionId)}/fork`, {
            ...(before === undefined ? {} : { before: identity(before, 'msg_') }),
        });
        try { return session(data(response)); }
        catch { throw new BackendOperationError('ambiguous', 'V2 fork acknowledgement'); }
    }
    async compact(sessionId: string, id: string, mode: 'queue' | 'steer'): Promise<BackendInboxItem> {
        identity(id, 'msg_'); delivery(mode);
        const response = await this.transport.request('POST', `${this.path(sessionId)}/compact`, { id, delivery: mode });
        try {
            const item = inboxItem(data(response), sessionId);
            if (item.id !== id || item.kind !== 'compaction' || item.delivery !== mode) return invalid();
            return item;
        } catch { throw new BackendOperationError('ambiguous', 'V2 compaction admission'); }
    }
    /** Query the explicit prompt range; never default to whichever turn is newest. */
    async changedFiles(sessionId: string, from: string, to?: string): Promise<string[]> {
        const query = new URLSearchParams({ from: identity(from, 'msg_'), context: '0' });
        if (to !== undefined && to !== from) query.set('to', identity(to, 'msg_'));
        const response = await this.transport.request('GET', `${this.path(sessionId)}/diff?${query}`);
        return array(data(response)).map(value => {
            const file = text(object(value).file);
            if (!file.trim()) return invalid();
            return file;
        });
    }
    async stageRevert(sessionId: string, messageId: string, files: boolean): Promise<BackendRecord> {
        const messageID = identity(messageId, 'msg_');
        const response = await this.transport.request('POST', `${this.path(sessionId)}/revert/stage`, { messageID, files });
        try {
            const result = object(data(response));
            if (result.messageID !== messageID) return invalid();
            return result;
        } catch { throw new BackendOperationError('ambiguous', 'V2 revert acknowledgement'); }
    }
    async clearRevert(sessionId: string) { await this.transport.request('DELETE', `${this.path(sessionId)}/revert`); }
    async commitRevert(sessionId: string) { await this.transport.request('POST', `${this.path(sessionId)}/revert/commit`); }
}
