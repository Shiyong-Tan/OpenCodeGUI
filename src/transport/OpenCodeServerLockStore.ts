import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ServerConnection, ServerLock } from './OpenCodeHttpClient';

const LOCK_DIR = '.opencode';
const LOCK_FILE = 'server.lock.json';
const PORT_BASE = 42000;
const PORT_RANGE = 256;

export function normalizeWorkspaceForServerHash(workspaceRoot: string, platform: NodeJS.Platform = process.platform): string {
    let normalized = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    if (platform === 'win32') normalized = normalized.toLowerCase();
    return normalized;
}

export function hashWorkspaceForServer(workspaceRoot: string, platform: NodeJS.Platform = process.platform): number {
    const normalized = normalizeWorkspaceForServerHash(workspaceRoot, platform);
    let hash = 0;
    for (let index = 0; index < normalized.length; index += 1) {
        hash = ((hash * 31) + normalized.charCodeAt(index)) >>> 0;
    }
    return hash;
}

export class OpenCodeServerLockStore {
    private cache?: { lock: ServerLock; baseUrl: string; authHeader: string; mtimeMs: number };

    public readonly portBase = PORT_BASE;
    public readonly portRange = PORT_RANGE;

    constructor(private readonly options: {
        getWorkspaceRoot(): string;
        log(message: string): void;
    }) {}

    public buildAuthHeader(password: string): string {
        return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
    }

    public getMigrationPorts(workspaceRoot: string): number[] {
        const baseHash = hashWorkspaceForServer(workspaceRoot);
        return Array.from({ length: PORT_RANGE }, (_, index) => PORT_BASE + ((baseHash + index) % PORT_RANGE));
    }

    public async getConnection(forceRefresh = false): Promise<ServerConnection> {
        const workspaceRoot = this.options.getWorkspaceRoot();
        const lockPath = this.getLockPath(workspaceRoot);
        if (!forceRefresh && this.cache) {
            try {
                const stat = await fs.promises.stat(lockPath);
                if (stat.mtimeMs === this.cache.mtimeMs) return this.toConnection(this.cache.lock);
            } catch {
                // Refresh from disk below.
            }
        }
        const { lock, mtimeMs } = await this.readOrCreate(workspaceRoot);
        this.updateCache(lock, mtimeMs);
        return this.toConnection(lock);
    }

    public async readOrCreate(workspaceRoot: string): Promise<{ lock: ServerLock; mtimeMs: number }> {
        await fs.promises.mkdir(path.join(workspaceRoot, LOCK_DIR), { recursive: true });
        const lockPath = this.getLockPath(workspaceRoot);
        const defaultPort = PORT_BASE + (hashWorkspaceForServer(workspaceRoot) % PORT_RANGE);
        if (!fs.existsSync(lockPath)) {
            this.options.log(`EXT: server.lock.read | path=${lockPath} | exists=false | port=${defaultPort} | hasPassword=false`);
            const lock = this.createLock(workspaceRoot, defaultPort);
            await this.write(lock, workspaceRoot, false);
            this.options.log(`EXT: server.lock.create | path=${lockPath} | port=${lock.port} | passwordHashPrefix=${lock.password.slice(0, 6)}`);
            const reread = await this.readFromDisk(workspaceRoot);
            if (reread) {
                this.options.log(`EXT: server.lock.read | path=${lockPath} | exists=true | port=${reread.lock.port} | hasPassword=${String(Boolean(reread.lock.password))}`);
                return reread;
            }
            const stat = await fs.promises.stat(lockPath);
            return { lock, mtimeMs: stat.mtimeMs };
        }

        const loaded = await this.readFromDisk(workspaceRoot);
        if (!loaded) {
            this.options.log(`EXT: server.lock.read | path=${lockPath} | exists=true | port=${defaultPort} | hasPassword=false`);
            const lock = this.createLock(workspaceRoot, defaultPort);
            const mtimeMs = await this.write(lock, workspaceRoot, false);
            this.options.log(`EXT: server.lock.create | path=${lockPath} | port=${lock.port} | passwordHashPrefix=${lock.password.slice(0, 6)}`);
            return { lock, mtimeMs };
        }

        const lock = loaded.lock;
        this.options.log(`EXT: server.lock.read | path=${lockPath} | exists=true | port=${lock.port} | hasPassword=${String(Boolean(lock.password))}`);
        let updated = false;
        const previousPort = lock.port;
        if (lock.workspaceRoot !== workspaceRoot) {
            lock.workspaceRoot = workspaceRoot;
            updated = true;
        }
        if (!lock.password) {
            lock.password = this.generatePassword();
            updated = true;
        }
        if (!Number.isFinite(lock.port)) {
            lock.port = defaultPort;
            updated = true;
        }
        if (!updated) return loaded;
        return { lock, mtimeMs: await this.write(lock, workspaceRoot, lock.port !== previousPort) };
    }

    public async write(lock: ServerLock, workspaceRoot: string, logUpdate: boolean): Promise<number> {
        const fullPath = this.getLockPath(workspaceRoot);
        const temporaryPath = `${fullPath}.tmp`;
        const payload: ServerLock = { ...lock, updatedAt: new Date().toISOString() };
        await fs.promises.writeFile(temporaryPath, JSON.stringify(payload, null, 2), 'utf-8');
        await fs.promises.rename(temporaryPath, fullPath);
        const stat = await fs.promises.stat(fullPath);
        if (logUpdate) this.options.log(`EXT: server.lock.update | port=${payload.port} | updatedAt=${payload.updatedAt}`);
        return stat.mtimeMs;
    }

    public updateCache(lock: ServerLock, mtimeMs: number): void {
        this.cache = {
            lock,
            baseUrl: `http://127.0.0.1:${lock.port}`,
            authHeader: this.buildAuthHeader(lock.password),
            mtimeMs,
        };
    }

    private createLock(workspaceRoot: string, port: number): ServerLock {
        return { workspaceRoot, port, password: this.generatePassword(), updatedAt: new Date().toISOString() };
    }

    private generatePassword(): string {
        return crypto.randomBytes(32).toString('base64');
    }

    private getLockPath(workspaceRoot: string): string {
        return path.join(workspaceRoot, LOCK_DIR, LOCK_FILE);
    }

    private async readFromDisk(workspaceRoot: string): Promise<{ lock: ServerLock; mtimeMs: number } | null> {
        const lockPath = this.getLockPath(workspaceRoot);
        try {
            const parsed = JSON.parse(await fs.promises.readFile(lockPath, 'utf-8'));
            if (!parsed || typeof parsed !== 'object') return null;
            const port = Number(parsed.port);
            const password = typeof parsed.password === 'string' ? parsed.password : '';
            const lock: ServerLock = {
                workspaceRoot: typeof parsed.workspaceRoot === 'string' ? parsed.workspaceRoot : workspaceRoot,
                port: Number.isFinite(port) ? port : PORT_BASE + (hashWorkspaceForServer(workspaceRoot) % PORT_RANGE),
                password: password || this.generatePassword(),
                updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
            };
            const stat = await fs.promises.stat(lockPath);
            return { lock, mtimeMs: stat.mtimeMs };
        } catch {
            return null;
        }
    }

    private toConnection(lock: ServerLock): ServerConnection {
        return {
            host: '127.0.0.1',
            port: lock.port,
            baseUrl: `http://127.0.0.1:${lock.port}`,
            authHeader: this.buildAuthHeader(lock.password),
            lock,
        };
    }
}
