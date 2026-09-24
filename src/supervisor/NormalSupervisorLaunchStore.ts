import { createHash, randomBytes } from 'crypto';
import { mkdir, realpath } from 'fs/promises';
import { join, resolve } from 'path';
import { canonicalWindowsWorkspace, serviceAuthenticationProof } from './normal-connection-protocol';
import { parseNormalLaunch, type NormalLaunch } from './normal-launch-protocol';
import type { ServerConnection, ServerLock } from '../transport/OpenCodeHttpClient';

interface PrivateSecrets {
    get(key: string): Thenable<string | undefined>;
    store(key: string, value: string): Thenable<void>;
}

/** Metadata only: the normal transport remains the sole process/connection owner. */
export class NormalSupervisorLaunchStore {
    private readonly pending = new Map<string, Promise<string>>();

    constructor(private readonly directory: string, private readonly secrets: PrivateSecrets) {}

    private async address(workspace: string) {
        const canonical = canonicalWindowsWorkspace(await realpath(workspace));
        const hash = createHash('sha256').update(canonical).digest('hex');
        return { canonical, hash, key: `supervisor.normal.launch.v1.${hash}` };
    }

    public async prepare(lock: Readonly<ServerLock>): Promise<string> {
        const address = await this.address(lock.workspaceRoot);
        if (this.pending.has(address.key)) throw new Error('Supervisor launch already being prepared');
        if (this.pending.size >= 16) throw new Error('Supervisor launch capacity exceeded');
        const operation = this.create(lock, address);
        this.pending.set(address.key, operation);
        try { return await operation; }
        finally { if (this.pending.get(address.key) === operation) this.pending.delete(address.key); }
    }

    private async create(lock: Readonly<ServerLock>, address: Awaited<ReturnType<NormalSupervisorLaunchStore['address']>>) {
        const previousText = await this.secrets.get(address.key);
        let previous: NormalLaunch | undefined;
        if (previousText) {
            // Validate the old structure with its own recorded binding. New service auth
            // may differ; stable provenance keys survive normal server replacement.
            const raw = JSON.parse(previousText) as NormalLaunch;
            if (raw?.binding?.workspace !== address.canonical || !/^[a-f0-9]{64}$/.test(raw?.binding?.integrationId)
                || !/^[a-f0-9]{64}$/.test(raw?.identityKey) || raw.schemaVersion !== 1 || raw.kind !== 'normal-gui-launch') {
                throw new Error('Invalid retained supervisor identity');
            }
            previous = raw;
        }
        await mkdir(this.directory, { recursive: true });
        const actualDirectory = await realpath(this.directory);
        if (canonicalWindowsWorkspace(actualDirectory) !== canonicalWindowsWorkspace(resolve(this.directory))) throw new Error('Supervisor storage redirects');
        const privateDirectory = join(actualDirectory, address.hash);
        await mkdir(privateDirectory, { recursive: true });
        if (await realpath(privateDirectory) !== privateDirectory) throw new Error('Supervisor workspace storage redirects');
        const identities = join(privateDirectory, 'identities');
        await mkdir(identities, { recursive: true });
        if (await realpath(identities) !== identities) throw new Error('Supervisor identity storage redirects');
        const launchKey = randomBytes(32).toString('hex');
        const binding = {
            integrationId: previous?.binding.integrationId ?? randomBytes(32).toString('hex'),
            serviceId: randomBytes(32).toString('hex'), workspace: address.canonical,
            serviceOrigin: `http://127.0.0.1:${lock.port}`,
        };
        const authorization = `Basic ${Buffer.from(`opencode:${lock.password}`).toString('base64')}`;
        const launch: NormalLaunch = { schemaVersion: 1, kind: 'normal-gui-launch', binding, launchKey,
            identityKey: previous?.identityKey ?? randomBytes(32).toString('hex'), privateDirectory,
            authenticationProof: serviceAuthenticationProof(launchKey, binding, authorization) };
        const serialized = JSON.stringify(launch);
        parseNormalLaunch(serialized, address.canonical, binding.serviceOrigin, authorization);
        await this.secrets.store(address.key, serialized);
        return serialized;
    }

    /** Local historical identity is independent of today's service password/port. */
    public async forHistory(workspace: string): Promise<{ integrationId: string; identityKey: string; privateDirectory: string } | undefined> {
        const address = await this.address(workspace);
        const serialized = await this.secrets.get(address.key);
        if (!serialized) return undefined;
        const value = JSON.parse(serialized) as NormalLaunch;
        if (value?.schemaVersion !== 1 || value.kind !== 'normal-gui-launch' || value.binding?.workspace !== address.canonical
            || !/^[a-f0-9]{64}$/.test(value.binding.integrationId) || !/^[a-f0-9]{64}$/.test(value.identityKey)) {
            throw new Error('Historical supervisor identity unavailable');
        }
        const expected = join(await realpath(this.directory), address.hash);
        if (value.privateDirectory !== expected || await realpath(expected) !== expected) throw new Error('Historical supervisor identity redirects');
        return { integrationId: value.binding.integrationId, identityKey: value.identityKey, privateDirectory: expected };
    }

    public async forConnection(connection: ServerConnection): Promise<NormalLaunch | undefined> {
        const address = await this.address(connection.lock.workspaceRoot);
        const serialized = await this.secrets.get(address.key);
        if (!serialized) return undefined;
        try {
            const launch = parseNormalLaunch(serialized, address.canonical, connection.baseUrl, connection.authHeader);
            const expected = join(await realpath(this.directory), address.hash);
            if (launch.privateDirectory !== expected || await realpath(expected) !== expected) return undefined;
            return launch;
        } catch { return undefined; }
    }
}
