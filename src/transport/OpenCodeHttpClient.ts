export type ServerLock = {
    workspaceRoot: string;
    port: number;
    password: string;
    updatedAt: string;
};

export type ServerConnection = {
    host: string;
    port: number;
    baseUrl: string;
    authHeader: string;
    lock: ServerLock;
};

export type ServerFetchOptions = {
    opName?: string;
    retry?: boolean;
    timeoutMs?: number;
    noTimeout?: boolean;
    retryOnAbort?: boolean;
    retryTimeoutMs?: number;
    conn?: ServerConnection;
    skipReady?: boolean;
};

export function getServerRequestPolicy(method: string, reqPath: string): {
    opName: string;
    timeoutMs: number;
    noTimeout?: boolean;
    retryOnAbort?: boolean;
    retryTimeoutMs?: number;
} {
    const messageMatch = /\/session\/[^/]+\/message(?:\/[^/?]+)?(?:\?.*)?$/.test(reqPath);
    const promptAsyncMatch = /\/session\/[^/]+\/prompt_async(?:\?.*)?$/.test(reqPath);
    const summarizeMatch = /\/session\/[^/]+\/summarize(?:\?.*)?$/.test(reqPath);
    const sessionInfoMatch = /\/session\/[^/?]+(?:\?.*)?$/.test(reqPath);
    if (reqPath === '/global/health') return { opName: 'health', timeoutMs: 1000 };
    if (reqPath === '/config/providers') return { opName: 'models.list', timeoutMs: 5000 };
    if (reqPath === '/session') return { opName: 'sessions.list', timeoutMs: 5000 };
    if (messageMatch) {
        return { opName: 'session.message', timeoutMs: 20000, retryOnAbort: true, retryTimeoutMs: 30000 };
    }
    if (promptAsyncMatch) {
        return { opName: 'session.post', timeoutMs: 60000, retryOnAbort: true, retryTimeoutMs: 90000 };
    }
    if (summarizeMatch) {
        return { opName: 'session.summarize', timeoutMs: 0, noTimeout: true, retryOnAbort: true };
    }
    if (sessionInfoMatch) {
        return { opName: 'session.info', timeoutMs: 10000, retryOnAbort: true, retryTimeoutMs: 15000 };
    }
    if (reqPath.startsWith('/session/')) {
        return { opName: `session.${method.toLowerCase()}`, timeoutMs: 5000 };
    }
    return { opName: `${method.toLowerCase()} ${reqPath}`, timeoutMs: 5000 };
}

export class OpenCodeHttpClient {
    constructor(private readonly options: {
        waitUntilReady(): Promise<void>;
        getConnection(forceRefresh?: boolean): Promise<ServerConnection>;
        migrateUnauthorized(lock: ServerLock): Promise<void>;
        recoverTransport(): Promise<void>;
        log(message: string): void;
        fetch?: typeof fetch;
    }) {}

    public async requestJson<T>(method: string, reqPath: string, body?: unknown): Promise<T> {
        const init: RequestInit = { method };
        if (body !== undefined && method !== 'GET') {
            init.body = JSON.stringify(body);
            init.headers = { 'Content-Type': 'application/json' };
        }
        const response = await this.fetch(reqPath, init, getServerRequestPolicy(method, reqPath));
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Server ${method} ${reqPath} failed: ${response.status} ${text}`);
        }
        if (response.status === 204) return {} as T;
        return (await response.json()) as T;
    }

    public async fetch(reqPath: string, init: RequestInit = {}, options?: ServerFetchOptions): Promise<Response> {
        const opName = options?.opName || 'fetch';
        const retry = options?.retry !== false;
        const retryOnAbort = options?.retryOnAbort === true;
        const timeoutMs = options?.noTimeout ? 0 : (options?.timeoutMs ?? 2000);
        const retryTimeoutMs = options?.retryTimeoutMs ?? timeoutMs;
        if (!options?.skipReady) await this.options.waitUntilReady();
        const conn = options?.conn || await this.options.getConnection();
        try {
            const response = await this.fetchOnce(conn, reqPath, init, opName, timeoutMs);
            if (response.status !== 401 || !retry) return response;
            await this.options.migrateUnauthorized(conn.lock);
            const nextConn = await this.options.getConnection(true);
            return this.fetch(reqPath, init, {
                opName,
                retry: false,
                timeoutMs,
                noTimeout: options?.noTimeout,
                retryOnAbort,
                retryTimeoutMs,
                conn: nextConn,
                skipReady: true,
            });
        } catch (error) {
            if (!retry) throw error;
            if (retryOnAbort && (error as Error)?.name === 'AbortError') {
                const nextConn = await this.options.getConnection(true);
                return this.fetch(reqPath, init, {
                    opName,
                    retry: false,
                    timeoutMs: retryTimeoutMs,
                    noTimeout: options?.noTimeout,
                    retryOnAbort: false,
                    retryTimeoutMs,
                    conn: nextConn,
                    skipReady: true,
                });
            }
            await this.options.recoverTransport();
            const nextConn = await this.options.getConnection(true);
            return this.fetch(reqPath, init, {
                opName,
                retry: false,
                timeoutMs,
                noTimeout: options?.noTimeout,
                retryOnAbort,
                retryTimeoutMs,
                conn: nextConn,
                skipReady: true,
            });
        }
    }

    private async fetchOnce(
        conn: Pick<ServerConnection, 'baseUrl' | 'authHeader'>,
        reqPath: string,
        init: RequestInit,
        opName: string,
        timeoutMs: number,
    ): Promise<Response> {
        const url = new URL(reqPath, conn.baseUrl).toString();
        const headers = new Headers(init.headers || undefined);
        headers.set('Authorization', conn.authHeader);
        if (!headers.has('Content-Type') && init.body && typeof init.body === 'string') {
            headers.set('Content-Type', 'application/json');
        }
        let controller: AbortController | undefined;
        let timeoutId: NodeJS.Timeout | undefined;
        if (timeoutMs > 0) {
            controller = new AbortController();
            timeoutId = setTimeout(() => controller?.abort(), timeoutMs);
            if (init.signal) init.signal.addEventListener('abort', () => controller?.abort(), { once: true });
        }
        try {
            const executeFetch = this.options.fetch || fetch;
            const response = await executeFetch(url, {
                ...init,
                headers,
                signal: controller ? controller.signal : init.signal,
            } as any);
            this.options.log(`EXT: server.fetch | url=${url} | op=${opName} | status=${response.status}`);
            return response;
        } catch (error) {
            this.options.log(`EXT: server.fetch | url=${url} | op=${opName} | err=${String(error)}`);
            throw error;
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
        }
    }
}
