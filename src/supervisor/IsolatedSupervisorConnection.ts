import { isSupportedOpenCodeVersion, type SupportedOpenCodeVersion } from './opencode-version';
import { open, realpath } from 'fs/promises';
import { dirname, isAbsolute, join } from 'path';

/** Extension-private capability. Never include this object in Webview messages. */
export interface IsolatedSupervisorConnection {
    isolationId: string;
    instanceId: string;
    workspace: string;
    serviceEndpoint: string;
    serviceAuthorization: string;
    bridgeEndpoint: string;
    bridgeToken: string;
    openCodeVersion: SupportedOpenCodeVersion;
    pluginVersion: '0.1.0';
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid isolated supervisor descriptor');
    return value as Record<string, unknown>;
}
function identity(value: unknown): string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,180}$/.test(value)) throw new Error('Invalid supervisor identity');
    return value;
}
function endpoint(value: unknown): string {
    if (typeof value !== 'string') throw new Error('Invalid supervisor endpoint');
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password ||
        url.search || url.hash || url.pathname !== '/' || url.origin !== value) throw new Error('Expected isolated IPv4 loopback origin');
    return value;
}

export function parseIsolatedSupervisorConnection(value: unknown): IsolatedSupervisorConnection {
    const data = record(value), service = record(data.service), bridge = record(data.bridge);
    if (data.schemaVersion !== 1 || !isSupportedOpenCodeVersion(data.openCodeVersion) || data.pluginVersion !== '0.1.0') throw new Error('Unsupported supervisor descriptor version');
    if (typeof data.workspace !== 'string' || !isAbsolute(data.workspace)) throw new Error('Expected absolute isolated workspace');
    if (typeof service.authorization !== 'string' || !/^Basic [A-Za-z0-9+/]{1,512}={0,2}$/.test(service.authorization)) throw new Error('Invalid isolated service authentication');
    if (typeof bridge.token !== 'string' || !/^[a-f0-9]{64}$/.test(bridge.token)) throw new Error('Invalid bridge authentication');
    const serviceEndpoint = endpoint(service.endpoint), bridgeEndpoint = endpoint(bridge.endpoint);
    if (serviceEndpoint === bridgeEndpoint) throw new Error('Service and bridge must be separate');
    return {
        isolationId: identity(data.isolationId), instanceId: identity(data.instanceId), workspace: data.workspace,
        serviceEndpoint, serviceAuthorization: service.authorization, bridgeEndpoint, bridgeToken: bridge.token,
        openCodeVersion: data.openCodeVersion, pluginVersion: '0.1.0',
    };
}

/** Called only by the explicit development connection, before normal server lock access. */
export async function loadIsolatedSupervisorConnection(descriptorPath: string, workspace: string): Promise<IsolatedSupervisorConnection> {
    if (!isAbsolute(descriptorPath)) throw new Error('Explicit absolute supervisor descriptor path required');
    const canonicalPath = await realpath(descriptorPath);
    const root = dirname(dirname(dirname(canonicalPath)));
    if (canonicalPath !== join(root, 'state', 'supervisor', 'connection.json')) throw new Error('Unexpected descriptor location');
    const handle = await open(canonicalPath, 'r');
    let data: unknown;
    try {
        if ((await handle.stat()).size > 16384) throw new Error('Supervisor descriptor too large');
        data = JSON.parse(await handle.readFile('utf8')) as unknown;
    } finally { await handle.close(); }
    const result = parseIsolatedSupervisorConnection(data);
    if (await realpath(workspace) !== join(root, 'work') || await realpath(result.workspace) !== join(root, 'work')) throw new Error('Supervisor workspace mismatch');
    const markerHandle = await open(join(root, 'isolation.json'), 'r');
    try {
        if ((await markerHandle.stat()).size > 4096) throw new Error('Isolation marker too large');
        const marker = record(JSON.parse(await markerHandle.readFile('utf8')) as unknown);
        if (marker.schemaVersion !== 1 || marker.isolationId !== result.isolationId) throw new Error('Supervisor isolation mismatch');
    } finally { await markerHandle.close(); }
    return result;
}
