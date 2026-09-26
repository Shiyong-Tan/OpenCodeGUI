import { randomBytes } from 'crypto';
import { open, realpath } from 'fs/promises';
import { join } from 'path';
import { bridgeBearer, serviceAuthenticationProof, verifyConnectionLease, verifyConnectionProof } from './normal-connection-protocol';
import type { NormalLaunch } from './normal-launch-protocol';
import type { ServerConnection } from '../transport/OpenCodeHttpClient';
import type { IsolatedSupervisorConnection } from './IsolatedSupervisorConnection';

export type NormalConnectionFailure = 'unavailable' | 'incompatible' | 'disconnected';
export class NormalConnectionError extends Error {
    constructor(readonly reason: NormalConnectionFailure) { super(`Supervisor ${reason}`); }
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
    if (!response.ok || !response.body) throw new NormalConnectionError('disconnected');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (signal.aborted) throw new NormalConnectionError('disconnected');
            if (done) break;
            size += value.byteLength;
            if (size > 8192) throw new NormalConnectionError('disconnected');
            chunks.push(value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** Authenticates only the normal transport's exact selected service; never scans. */
export async function connectNormalSupervisor(launch: NormalLaunch, service: ServerConnection, signal: AbortSignal,
    fetcher: typeof fetch = fetch, now: () => number = Date.now): Promise<IsolatedSupervisorConnection> {
    if (service.baseUrl !== launch.binding.serviceOrigin) throw new NormalConnectionError('unavailable');
    if (serviceAuthenticationProof(launch.launchKey, launch.binding, service.authHeader) !== launch.authenticationProof) {
        throw new NormalConnectionError('unavailable');
    }
    const path = join(launch.privateDirectory, `${launch.binding.serviceId}.json`);
    if (await realpath(path) !== path) throw new NormalConnectionError('unavailable');
    const file = await open(path, 'r');
    let raw: unknown;
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 8192) throw new NormalConnectionError('unavailable');
        const buffer = Buffer.alloc(8193);
        let size = 0;
        while (size < buffer.length) {
            const result = await file.read(buffer, size, buffer.length - size, null);
            if (!result.bytesRead) break;
            size += result.bytesRead;
        }
        if (size > 8192 || signal.aborted) throw new NormalConnectionError('unavailable');
        raw = JSON.parse(buffer.subarray(0, size).toString('utf8')) as unknown;
    } finally { await file.close(); }
    const lease = verifyConnectionLease(raw, launch.binding, launch.launchKey, now());
    const health = await boundedJson(await fetcher(`${service.baseUrl}/global/health`, {
        headers: { Authorization: service.authHeader }, signal, redirect: 'error', cache: 'no-store',
    }), signal);
    if (!health || typeof health !== 'object' || (health as { version?: unknown }).version !== lease.opencodeVersion) {
        throw new NormalConnectionError('incompatible');
    }
    const token = bridgeBearer(launch.launchKey, launch.binding, lease.instanceId);
    const challenge = randomBytes(32).toString('hex');
    const response = await boundedJson(await fetcher(`${lease.bridgeOrigin}/v1/identity?challenge=${challenge}`, {
        headers: { Authorization: `Bearer ${token}` }, signal, redirect: 'error', cache: 'no-store',
    }), signal);
    if (!response || typeof response !== 'object') throw new NormalConnectionError('disconnected');
    const identity = response as { lease?: unknown; proof?: unknown };
    const live = verifyConnectionLease(identity.lease, launch.binding, launch.launchKey, now());
    if (signal.aborted || live.opencodeVersion !== lease.opencodeVersion || live.instanceId !== lease.instanceId || live.bridgeOrigin !== lease.bridgeOrigin
        || !verifyConnectionProof(identity.proof, launch.launchKey, live, challenge)) throw new NormalConnectionError('disconnected');
    // Compatibility projection, not an isolated descriptor or replacement HTTP connection.
    return { isolationId: launch.binding.integrationId, instanceId: live.instanceId,
        workspace: launch.binding.workspace, serviceEndpoint: service.baseUrl, serviceAuthorization: service.authHeader,
        bridgeEndpoint: live.bridgeOrigin, bridgeToken: token, openCodeVersion: live.opencodeVersion, pluginVersion: live.pluginVersion };
}
