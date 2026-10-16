import { BackendOperationError } from './BackendContract';

export interface V2Connection {
    readonly baseUrl: string; readonly authorization: string; readonly directory: string;
    readonly isCurrent: () => boolean;
    readonly signal?: AbortSignal;
}
/** Captured service binding only. This transport has no retry, discovery or lifecycle writer. */
export class V2Transport {
    private readonly origin: string;
    constructor(readonly connection: V2Connection, private readonly fetcher: typeof fetch = fetch) {
        const url = new URL(connection.baseUrl);
        if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
            url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
            throw new BackendOperationError('rejected', 'bind selected V2 origin');
        }
        this.origin = url.origin;
    }
    async request(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
        const mutation = method !== 'GET';
        if (!path.startsWith('/api/') || path.startsWith('//') || path.includes('#')) throw new BackendOperationError('rejected', 'V2 request path');
        const url = new URL(path, this.origin);
        if (url.origin !== this.origin || !url.pathname.startsWith('/api/')) throw new BackendOperationError('rejected', 'V2 request scope');
        const serialized = body === undefined ? undefined : JSON.stringify(body);
        // Native messages embed tool output. A single real read result can exceed
        // the ordinary page budget; allow a bounded 32 MiB only after paging to one.
        const responseBound = method === 'GET' && /^\/api\/session\/[^/]+\/message$/.test(url.pathname)
            && url.searchParams.get('limit') === '1' ? 32 * 1024 * 1024 : 8 * 1024 * 1024;
        const current = () => {
            this.connection.signal?.throwIfAborted();
            if (!this.connection.isCurrent()) throw new BackendOperationError('superseded', method + ' ' + path);
        };
        current();
        const controller = new AbortController();
        const abort = () => controller.abort(this.connection.signal?.reason);
        this.connection.signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => controller.abort(new Error('V2 request deadline')), 15000);
        let submitted = false, response: Response | undefined;
        try {
            submitted = true;
            response = await this.fetcher(url, { method, redirect: 'error', cache: 'no-store',
                signal: controller.signal, headers: { Authorization: this.connection.authorization, Accept: 'application/json',
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
                ...(serialized === undefined ? {} : { body: serialized }) });
            controller.signal.throwIfAborted(); current();
            if (!response.ok) {
                const reason = response.status === 401 || response.status === 403 ? 'authentication' :
                    response.status === 409 ? 'conflict' : response.status === 404 || response.status === 405 ? 'unsupported' :
                    response.status >= 500 && mutation ? 'ambiguous' : 'rejected';
                throw new BackendOperationError(reason, method + ' ' + path, response.status);
            }
            if (response.status === 204) return undefined;
            if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) {
                throw new BackendOperationError('invalid_response', method + ' ' + path);
            }
            const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
            const cancel = () => { void reader.cancel().catch(() => undefined); };
            controller.signal.addEventListener('abort', cancel, { once: true });
            try {
                while (true) {
                    controller.signal.throwIfAborted();
                    const next = await reader.read(); controller.signal.throwIfAborted(); current();
                    if (next.done) break;
                    size += next.value.byteLength;
                    if (size > responseBound) throw new BackendOperationError('invalid_response', 'V2 response bound');
                    chunks.push(next.value);
                }
            } finally { controller.signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
            return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        } catch (error) {
            if (error instanceof BackendOperationError && (!mutation || !['invalid_response', 'superseded'].includes(error.reason))) throw error;
            throw new BackendOperationError(mutation && submitted ? 'ambiguous' : 'unavailable', method + ' ' + path);
        } finally {
            clearTimeout(timer); controller.abort(); this.connection.signal?.removeEventListener('abort', abort);
            void response?.body?.cancel().catch(() => undefined);
        }
    }
}
