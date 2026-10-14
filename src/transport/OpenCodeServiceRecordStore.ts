import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { mkdir, open, readdir, realpath } from 'fs/promises';
import { join, resolve } from 'path';
import { canonicalWorkspace } from '../supervisor/normal-connection-protocol';
import type { ServerConnection, ServerLock } from './OpenCodeHttpClient';
import { ServiceOperationError, validateProcessIdentity, type ServiceProcessIdentity } from './WindowsServiceJob';

interface Secrets { get(key: string): Thenable<string | undefined>; store(key: string, value: string): Thenable<void> }
export interface OwnedServiceRecord {
    schemaVersion: 1; generation: number; serviceId: string; workspace: string; port: number; authenticationHash: string;
    process?: ServiceProcessIdentity; intentionallyStopped: boolean;
}
type StartRecord = Omit<OwnedServiceRecord, 'process' | 'intentionallyStopped'>;
const id = /^[a-f0-9]{64}$/;
const authHash = (authorization: string) => createHash('sha256').update(authorization).digest('hex');

/** Append-only representation of the existing transport owner's facts.
 * Callers hold the workspace OS mutex while changing records. Immutable generation
 * files prevent a late write from an old operation overwriting a newer instance. */
export class OpenCodeServiceRecordStore {
    constructor(private readonly directory: string, private readonly secrets: Secrets) {}
    operationDirectory(): string { return join(this.directory, 'operations'); }

    async workspaceKey(workspace: string): Promise<string> {
        return createHash('sha256').update(canonicalWorkspace(await realpath(workspace))).digest('hex');
    }

    private async location(workspace: string) {
        const canonical = canonicalWorkspace(await realpath(workspace));
        const hash = await this.workspaceKey(workspace);
        await mkdir(this.directory, { recursive: true });
        const base = await realpath(this.directory);
        if (canonicalWorkspace(base) !== canonicalWorkspace(resolve(this.directory))) throw new ServiceOperationError('storage_redirected');
        const directory = join(base, hash); await mkdir(directory, { recursive: true });
        if (await realpath(directory) !== directory) throw new ServiceOperationError('storage_redirected');
        return { directory, canonical, key: `opencode.service.owner.v1.${hash}` };
    }

    private async key(name: string, create = false): Promise<string> {
        const existing = await this.secrets.get(name);
        if (existing) { if (!id.test(existing)) throw new ServiceOperationError('owner_key_invalid'); return existing; }
        if (!create) throw new ServiceOperationError('owner_key_missing');
        const value = randomBytes(32).toString('hex'); await this.secrets.store(name, value); return value;
    }

    private signature(payload: unknown, key: string): string {
        return createHmac('sha256', Buffer.from(key, 'hex')).update('opencode/gui-service/v1\0').update(JSON.stringify(payload)).digest('hex');
    }

    private async read(path: string, key: string): Promise<Record<string, unknown>> {
        if (await realpath(path) !== path) throw new ServiceOperationError('record_redirected');
        const file = await open(path, 'r');
        try {
            const stat = await file.stat(); if (!stat.isFile() || stat.size > 8192) throw new ServiceOperationError('record_invalid');
            const bytes = Buffer.alloc(8193); const result = await file.read(bytes, 0, bytes.length, 0);
            if (result.bytesRead > 8192) throw new ServiceOperationError('record_invalid');
            const raw: unknown = JSON.parse(bytes.subarray(0, result.bytesRead).toString('utf8'));
            const signed = raw as { payload?: unknown; signature?: unknown };
            if (!signed || typeof signed.signature !== 'string' || !id.test(signed.signature) || !signed.payload ||
                typeof signed.payload !== 'object' || Array.isArray(signed.payload) ||
                !timingSafeEqual(Buffer.from(signed.signature, 'hex'), Buffer.from(this.signature(signed.payload, key), 'hex'))) {
                throw new ServiceOperationError('record_authentication_failed');
            }
            return signed.payload as Record<string, unknown>;
        } finally { await file.close(); }
    }

    private async write(path: string, payload: unknown, key: string): Promise<void> {
        const file = await open(path, 'wx');
        try { await file.writeFile(JSON.stringify({ payload, signature: this.signature(payload, key) })); await file.sync(); }
        finally { await file.close(); }
    }

    async current(workspace: string): Promise<OwnedServiceRecord | undefined> {
        const where = await this.location(workspace);
        const files = (await readdir(where.directory)).filter(name => /^[0-9]{6}\.start\.json$/.test(name)).sort();
        if (!files.length) return undefined;
        if (files.length > 128) throw new ServiceOperationError('owner_record_capacity');
        const key = await this.key(where.key);
        const latest = files[files.length - 1];
        const raw = await this.read(join(where.directory, latest), key);
        if (raw.schemaVersion !== 1 || raw.workspace !== where.canonical || !Number.isInteger(raw.generation) ||
            Number(raw.generation) < 1 || String(raw.generation).padStart(6, '0') + '.start.json' !== latest ||
            typeof raw.serviceId !== 'string' || !id.test(raw.serviceId) || !Number.isInteger(raw.port) ||
            Number(raw.port) < 1 || Number(raw.port) > 65535 || typeof raw.authenticationHash !== 'string' || !id.test(raw.authenticationHash)) {
            throw new ServiceOperationError('record_invalid');
        }
        const base = raw as unknown as StartRecord;
        let processIdentity: ServiceProcessIdentity | undefined;
        try {
            const processRaw = await this.read(join(where.directory, `${base.serviceId}.process.json`), key);
            processIdentity = validateProcessIdentity(processRaw);
            if (processIdentity.serviceId !== base.serviceId) throw new ServiceOperationError('record_identity_mismatch');
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        let intentionallyStopped = false;
        try {
            const stopped = await this.read(join(where.directory, `${base.serviceId}.stopped.json`), key);
            if (stopped.serviceId !== base.serviceId || stopped.stopped !== true) throw new ServiceOperationError('stop_record_invalid');
            intentionallyStopped = true;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        return { ...base, process: processIdentity, intentionallyStopped };
    }

    matches(record: OwnedServiceRecord, connection: ServerConnection): boolean {
        return record.workspace === canonicalWorkspace(connection.lock.workspaceRoot) && record.port === connection.lock.port &&
            record.authenticationHash === authHash(connection.authHeader) && connection.baseUrl === `http://127.0.0.1:${record.port}`;
    }

    async begin(lock: ServerLock, expectedServiceId?: string | null): Promise<OwnedServiceRecord> {
        const where = await this.location(lock.workspaceRoot);
        const previous = await this.current(lock.workspaceRoot);
        if (expectedServiceId !== undefined && (previous?.serviceId ?? null) !== expectedServiceId) throw new ServiceOperationError('operation_superseded');
        const generation = (previous?.generation ?? 0) + 1;
        if (generation > 128) throw new ServiceOperationError('owner_record_capacity');
        const key = await this.key(where.key, !previous);
        const record: StartRecord = { schemaVersion: 1, generation, serviceId: randomBytes(32).toString('hex'),
            workspace: where.canonical, port: lock.port,
            authenticationHash: authHash(`Basic ${Buffer.from(`opencode:${lock.password}`).toString('base64')}`) };
        await this.write(join(where.directory, `${String(generation).padStart(6, '0')}.start.json`), record, key);
        return { ...record, intentionallyStopped: false };
    }

    async register(workspace: string, identity: ServiceProcessIdentity): Promise<void> {
        validateProcessIdentity(identity);
        const where = await this.location(workspace);
        const current = await this.current(workspace);
        if (current?.serviceId !== identity.serviceId) throw new ServiceOperationError('operation_superseded');
        await this.write(join(where.directory, `${identity.serviceId}.process.json`), identity, await this.key(where.key));
    }

    async markStopped(workspace: string, serviceId: string): Promise<void> {
        const where = await this.location(workspace);
        const current = await this.current(workspace);
        if (current?.serviceId !== serviceId) throw new ServiceOperationError('operation_superseded');
        if (current.intentionallyStopped) return;
        await this.write(join(where.directory, `${serviceId}.stopped.json`), { serviceId, stopped: true }, await this.key(where.key));
    }
}
