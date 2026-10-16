import { BackendOperationError, type BackendRecord } from './BackendContract';
import { array, data, identity, invalid, object, text } from './V2Codec';
import { V2Transport } from './V2Transport';

export type FormValue = string | number | boolean | readonly string[];
export interface NativePermission {
    readonly id: string; readonly sessionId: string; readonly action: string;
    readonly resources: readonly string[]; readonly native: BackendRecord;
}
export interface NativeForm {
    readonly id: string; readonly sessionId: string; readonly title: string;
    readonly fields: readonly BackendRecord[]; readonly state?: BackendRecord; readonly native: BackendRecord;
}
const strings = (value: unknown) => array(value).map(text);
function requestId(value: unknown, prefix: string) {
    const id = text(value);
    if (!id.startsWith(prefix) || id.length <= prefix.length || !/^[A-Za-z0-9_-]{1,256}$/.test(id)) return invalid();
    return id;
}
function permission(value: unknown, owner?: string): NativePermission {
    const raw = object(value), sessionId = identity(raw.sessionID, 'ses_');
    if (owner !== undefined && owner !== sessionId) return invalid();
    return { id: requestId(raw.id, 'per'), sessionId, action: text(raw.action), resources: strings(raw.resources), native: raw };
}
function form(value: unknown, owner?: string): NativeForm {
    const raw = object(value), sessionId = raw.sessionID === 'global' ? 'global' : identity(raw.sessionID, 'ses_');
    if (owner !== undefined && owner !== sessionId) return invalid();
    const fields = array(raw.fields).map(object), seen = new Set<string>();
    if (!fields.length) return invalid();
    for (const field of fields) {
        const key = text(field.key);
        if (!key || seen.has(key)) return invalid();
        for (const condition of field.when === undefined ? [] : array(field.when).map(object)) {
            if (!seen.has(text(condition.key)) || !['eq', 'neq'].includes(text(condition.op))) return invalid();
        }
        seen.add(key);
        if (!['string', 'number', 'integer', 'boolean', 'multiselect', 'external'].includes(text(field.type)))
            throw new BackendOperationError('unsupported', 'V2 form field type');
        if (field.options !== undefined) {
            const values = array(field.options).map(option => { const item = object(option); text(item.label); return text(item.value); });
            if (new Set(values).size !== values.length) return invalid();
        }
    }
    return { id: requestId(raw.id, 'frm_'), sessionId, title: text(raw.title), fields,
        state: raw.state === undefined ? undefined : object(raw.state), native: raw };
}

/** Native interaction routing. Scope/review-token policy stays in the permission owner. */
export class V2InteractionAdapter {
    constructor(private readonly transport: V2Transport) {}
    private path(sessionId: string) { return `/api/session/${encodeURIComponent(identity(sessionId, 'ses_'))}`; }
    private formPath(sessionId: string, formId?: string) {
        const owner = sessionId === 'global' ? 'global' : identity(sessionId, 'ses_');
        return `/api/session/${encodeURIComponent(owner)}/form${formId === undefined ? '' : '/' + encodeURIComponent(requestId(formId, 'frm_'))}`;
    }
    async permissions(sessionId?: string): Promise<readonly NativePermission[]> {
        const path = sessionId === undefined ? `/api/permission/request?directory=${encodeURIComponent(this.transport.connection.directory)}`
            : `${this.path(sessionId)}/permission`;
        return array(data(await this.transport.request('GET', path))).map(value => permission(value, sessionId));
    }
    async forms(sessionId?: string): Promise<readonly NativeForm[]> {
        const path = sessionId === undefined ? `/api/form?directory=${encodeURIComponent(this.transport.connection.directory)}` : this.formPath(sessionId);
        return array(data(await this.transport.request('GET', path))).map(value => form(value, sessionId));
    }
    async getForm(sessionId: string, formId: string): Promise<NativeForm> {
        const result = form(data(await this.transport.request('GET', this.formPath(sessionId, formId))), sessionId);
        if (result.id !== formId || !result.state || !['pending', 'answered', 'cancelled'].includes(text(result.state.status))) return invalid();
        return result;
    }
    async replyPermission(sessionId: string, permissionId: string, decision: 'once' | 'always' | 'reject') {
        if (!['once', 'always', 'reject'].includes(decision)) throw new BackendOperationError('rejected', 'V2 permission decision');
        await this.transport.request('POST', `${this.path(sessionId)}/permission/${encodeURIComponent(requestId(permissionId, 'per'))}/reply`, { decision });
    }
    async replyForm(sessionId: string, formId: string, answer: Readonly<Record<string, FormValue>>) {
        // Fetch the exact original form. Never manufacture a schema from a visible card.
        const current = await this.getForm(sessionId, formId);
        if (current.state?.status !== 'pending') throw new BackendOperationError('conflict', 'V2 settled form');
        validateFormAnswer(current, answer);
        await this.transport.request('POST', `${this.formPath(sessionId, formId)}/reply`, { answer });
    }
    async cancelForm(sessionId: string, formId: string, message?: string) {
        await this.transport.request('DELETE', this.formPath(sessionId, formId) +
            (message === undefined ? '' : `?${new URLSearchParams({ message })}`));
    }
}

/** Keep typed values and conditional visibility; the server validates further constraints. */
export function validateFormAnswer(form: NativeForm, answer: Readonly<Record<string, FormValue>>): void {
    const input = object(answer), known = new Set<string>();
    const reject = (): never => { throw new BackendOperationError('rejected', 'V2 form answer'); };
    for (const field of form.fields) {
        const key = text(field.key); known.add(key);
        const active = (field.when === undefined ? [] : array(field.when).map(object)).every(condition => {
            const previous = Object.prototype.hasOwnProperty.call(input, text(condition.key)) ? input[text(condition.key)] : undefined;
            if (previous === undefined) return false;
            const equal = Array.isArray(previous) ? previous.includes(condition.value) : previous === condition.value;
            return condition.op === 'eq' ? equal : !equal;
        });
        const value = Object.prototype.hasOwnProperty.call(input, key) ? input[key] : undefined;
        if (!active || field.type === 'external') { if (value !== undefined) reject(); continue; }
        if (value === undefined) { if (field.required === true && field.default === undefined) reject(); continue; }
        if (field.type === 'string' && typeof value !== 'string' || field.type === 'boolean' && typeof value !== 'boolean') reject();
        if ((field.type === 'number' || field.type === 'integer') &&
            (typeof value !== 'number' || !Number.isFinite(value) || field.type === 'integer' && !Number.isSafeInteger(value))) reject();
        if (field.type === 'multiselect' && (!Array.isArray(value) || value.some(item => typeof item !== 'string') || new Set(value).size !== value.length)) reject();
        if (field.options !== undefined && field.custom !== true) {
            const options = array(field.options).map(option => text(object(option).value));
            const selected = Array.isArray(value) ? value : [value];
            if (selected.some(item => !options.includes(item as string))) reject();
        }
    }
    if (Object.keys(input).some(key => !known.has(key))) reject();
}
