export type ProtocolFamily = 'v1' | 'v2';
export interface ProtocolIdentity {
    readonly family: ProtocolFamily;
    readonly version: string;
    readonly pid?: number;
}
export interface ProtocolProbe {
    readonly baseUrl: string;
    readonly authorization: string;
    readonly signal?: AbortSignal;
    /** The connection owner invalidates results when its service generation changes. */
    readonly isCurrent: () => boolean;
}
export class ProtocolProbeError extends Error {
    constructor(readonly reason: 'authentication' | 'unrecognized' | 'superseded' | 'response_bound', message: string) {
        super(message); this.name = 'ProtocolProbeError';
    }
}
const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
const version = (value: unknown): value is string => typeof value === 'string' && value.length <= 128 &&
    /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z._+-]+)?$/.test(value);

/** Recognize wire shape, not a release allowlist. Extra fields are forward compatible. */
export function identifyProtocol(path: '/global/health' | '/api/info', value: unknown): ProtocolIdentity | undefined {
    if (!record(value) || !version(value.version)) return undefined;
    if (path === '/global/health' && value.healthy === true) return { family: 'v1', version: value.version };
    if (path === '/api/info' && typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid >= 0 &&
        Array.isArray(value.urls) && value.urls.every(item => typeof item === 'string') &&
        record(value.paths) && typeof value.paths.tmp === 'string') {
        return { family: 'v2', version: value.version, pid: value.pid };
    }
    return undefined;
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
    if (!response.body) return undefined;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const abort = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener('abort', abort, { once: true });
    try {
        while (true) {
            signal.throwIfAborted();
            const next = await reader.read();
            signal.throwIfAborted();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > 16384) throw new ProtocolProbeError('response_bound', 'OpenCode identity response exceeded 16 KiB');
            chunks.push(next.value);
        }
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
        catch { return undefined; }
    } finally {
        signal.removeEventListener('abort', abort);
        await reader.cancel().catch(() => undefined); reader.releaseLock();
    }
}

/** Read-only discovery. No mutations, restarts, credential changes or global cache. */
export async function probeProtocol(input: ProtocolProbe, fetcher: typeof fetch = fetch): Promise<ProtocolIdentity> {
    const base = new URL(input.baseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) ||
        base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
        throw new ProtocolProbeError('unrecognized', 'Expected the selected loopback OpenCode service origin');
    }
    const current = () => {
        input.signal?.throwIfAborted();
        if (!input.isCurrent()) throw new ProtocolProbeError('superseded', 'OpenCode service changed during protocol discovery');
    };
    for (const path of ['/global/health', '/api/info'] as const) {
        current();
        const controller = new AbortController();
        const abort = () => controller.abort(input.signal?.reason);
        input.signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => controller.abort(new Error('OpenCode identity probe timed out')), 2000);
        try {
            const response = await fetcher(new URL(path, base), { method: 'GET', signal: controller.signal,
                redirect: 'error', cache: 'no-store', headers: { Authorization: input.authorization, Accept: 'application/json' } });
            controller.signal.throwIfAborted();
            current();
            if (response.status === 401 || response.status === 403) {
                void response.body?.cancel().catch(() => undefined);
                throw new ProtocolProbeError('authentication', 'Selected OpenCode service rejected authentication');
            }
            const contentType = response.headers.get('content-type') ?? '';
            if (!response.ok || !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(contentType)) {
                void response.body?.cancel().catch(() => undefined); continue;
            }
            const identity = identifyProtocol(path, await boundedJson(response, controller.signal));
            current();
            if (identity) return identity;
        } finally {
            clearTimeout(timer); controller.abort(); input.signal?.removeEventListener('abort', abort);
        }
    }
    throw new ProtocolProbeError('unrecognized', 'Service does not expose a recognized OpenCode identity protocol');
}

/** Health is recognized identity, never HTTP 200 from a fallback HTML page. */
export async function probeServerHealth(connection: { baseUrl: string; authHeader: string }, timeoutMs: number, fetcher: typeof fetch = fetch):
    Promise<'ok' | 'unauthorized' | 'timeout' | 'connrefused' | 'unreachable'> {
    try {
        await probeProtocol({ baseUrl: connection.baseUrl, authorization: connection.authHeader, signal: AbortSignal.timeout(timeoutMs), isCurrent: () => true }, fetcher);
        return 'ok';
    } catch (error) {
        if (error instanceof ProtocolProbeError && error.reason === 'authentication') return 'unauthorized';
        const detail = error as { name?: string; code?: string; cause?: { code?: string } };
        if (detail.name === 'AbortError' || detail.name === 'TimeoutError') return 'timeout';
        if (detail.code === 'ECONNREFUSED' || detail.cause?.code === 'ECONNREFUSED') return 'connrefused';
        return 'unreachable';
    }
}
