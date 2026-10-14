import { execFile } from 'child_process';

export function releaseNetworkReason(error: unknown): string {
    const value = error as { code?: unknown; cause?: { code?: unknown; errors?: Array<{ code?: unknown }> } };
    const nested = Array.isArray(value?.cause?.errors) ? value.cause.errors.map(item => item?.code) : [];
    const codes = [value?.code, value?.cause?.code, ...nested]
        .filter((code): code is string => typeof code === 'string' && /^[A-Z0-9_]+$/.test(code));
    return `${error instanceof Error ? error.message : 'Network request failed'}${codes.length ? ` (${[...new Set(codes)].join(', ')})` : ''}`;
}

/** Alternate network transport only. Release metadata and source validation remain in the owner. */
export async function requestRelease(url: string, head = false): Promise<Pick<Response, 'ok' | 'status' | 'json'>> {
    try {
        return await fetch(url, { method: head ? 'HEAD' : 'GET', signal: AbortSignal.timeout(15000),
            headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
    } catch (error) {
        if (process.platform !== 'linux') throw new Error(releaseNetworkReason(error));
        try {
            const args = ['-q', '--proto', '=https', '--proto-redir', '=https', '--fail', '--location', '--silent', '--show-error',
                '--connect-timeout', '10', '--max-time', '20', '--header', 'Accept: application/vnd.github+json',
                '--header', 'X-GitHub-Api-Version: 2022-11-28',
                ...(head ? ['--head', '--output', '/dev/null', '--write-out', '%{http_code}'] : []), url];
            const result = await new Promise<string>((resolve, reject) => {
                execFile('curl', args, { timeout: 22000, maxBuffer: 131072, encoding: 'utf8' }, (cause, stdout) => {
                    if (cause) reject(new Error(`curl failed (${String(cause.code ?? 'unknown')}); check proxy, certificates and connectivity in WSL`));
                    else resolve(stdout);
                });
            });
            if (head && !/^2\d\d$/.test(result.trim())) throw new Error(`Package HTTP ${result.trim()}`);
            return { ok: true, status: 200, json: async () => JSON.parse(result) as unknown };
        } catch (fallback) {
            throw new Error(`Node request: ${releaseNetworkReason(error)}; ${releaseNetworkReason(fallback)}`);
        }
    }
}
