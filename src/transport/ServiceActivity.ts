import type { ServerConnection } from './OpenCodeHttpClient';
import { ServiceOperationError } from './WindowsServiceJob';
import type { V2Backend } from './protocol/V2Backend';

/** Only the selected service/workspace; no session database or workspace discovery. */
export async function queryServiceActivity(connection: ServerConnection, fetcher: typeof fetch = fetch, native?: V2Backend): Promise<'idle' | 'active'> {
    if (native) {
        try {
            if (native.transport.connection.baseUrl !== connection.baseUrl || native.transport.connection.authorization !== connection.authHeader)
                throw new Error('Service binding changed');
            const [active, permissions, forms] = await Promise.all([native.controls.active(), native.interactions.permissions(), native.interactions.forms()]);
            return Object.keys(active).length || permissions.length || forms.length ? 'active' : 'idle';
        } catch { throw new ServiceOperationError('activity_unknown'); }
    }
    const read = async (path: string): Promise<unknown> => {
        const signal = AbortSignal.timeout(2000);
        const response = await fetcher(connection.baseUrl + path, { signal, redirect: 'error', cache: 'no-store',
            headers: { Authorization: connection.authHeader, 'x-opencode-directory': connection.lock.workspaceRoot } });
        if (!response.ok || !response.body) throw new ServiceOperationError('activity_unknown');
        const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
        try {
            while (true) {
                const next = await reader.read(); if (next.done) break;
                size += next.value.byteLength;
                if (size > 131072 || signal.aborted) throw new ServiceOperationError('activity_unknown');
                chunks.push(next.value);
            }
            return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
    };
    try {
        const [statuses, permissions, questions] = await Promise.all([read('/session/status'), read('/permission'), read('/question')]);
        if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses) || !Array.isArray(permissions)) throw new Error();
        if (!Array.isArray(questions)) throw new Error();
        let active = permissions.length > 0 || questions.length > 0;
        for (const status of Object.values(statuses)) {
            const type = (status as { type?: unknown } | null)?.type;
            if (type !== 'idle' && type !== 'busy' && type !== 'retry') throw new Error();
            if (type !== 'idle') active = true;
        }
        return active ? 'active' : 'idle';
    } catch { throw new ServiceOperationError('activity_unknown'); }
}
