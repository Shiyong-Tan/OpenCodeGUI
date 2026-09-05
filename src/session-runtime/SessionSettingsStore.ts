export type SessionSettings = {
    model?: string;
    variant?: string;
    mode?: string;
};

export interface SessionSettingsStorage {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
}

const STORAGE_KEY = 'opencode.sessionSettings.v1';

function toSettings(value: unknown): SessionSettings {
    if (!value || typeof value !== 'object') return {};
    const settings = value as Record<string, unknown>;
    return {
        ...(typeof settings.model === 'string' ? { model: settings.model } : {}),
        ...(typeof settings.variant === 'string' ? { variant: settings.variant } : {}),
        ...(typeof settings.mode === 'string' ? { mode: settings.mode } : {}),
    };
}

/**
 * Canonical owner of per-session model/variant/mode settings.
 *
 * Persistence invariant: writes are serialized on a single tail promise and
 * coalesced so only the latest in-memory snapshot is ever written per flush.
 * A storage failure is swallowed and never rejects `set`, `delete`, or a caller
 * awaiting them; the next scheduled write always re-syncs the full snapshot.
 */
export class SessionSettingsStore {
    private readonly settingsBySession = new Map<string, SessionSettings>();
    private loaded = false;
    private flushTail: Promise<void> = Promise.resolve();
    private pendingPersist: Record<string, SessionSettings> | null = null;

    constructor(private readonly storage: SessionSettingsStorage) {}

    public async load(): Promise<void> {
        if (this.loaded) return;
        this.loaded = true;
        const stored = this.storage.get<unknown>(STORAGE_KEY);
        if (!stored || typeof stored !== 'object') return;
        for (const [sessionId, value] of Object.entries(stored as Record<string, unknown>)) {
            if (!sessionId) continue;
            this.settingsBySession.set(sessionId, toSettings(value));
        }
    }

    public get(sessionId: string | undefined): SessionSettings {
        return { ...(sessionId ? this.settingsBySession.get(sessionId) : undefined) };
    }

    public snapshot(): Record<string, SessionSettings> {
        return Object.fromEntries(
            Array.from(this.settingsBySession.entries(), ([sessionId, settings]) => [sessionId, { ...settings }])
        );
    }

    public set(sessionId: string, settings: SessionSettings): Promise<void> {
        if (!sessionId) return Promise.resolve();
        this.settingsBySession.set(sessionId, toSettings(settings));
        return this.schedulePersist();
    }

    public delete(sessionId: string): Promise<void> {
        if (!this.settingsBySession.delete(sessionId)) return Promise.resolve();
        return this.schedulePersist();
    }

    private schedulePersist(): Promise<void> {
        this.pendingPersist = this.snapshot();
        this.flushTail = this.flushTail
            .catch(() => undefined)
            .then(() => this.flushOnce())
            .catch(() => undefined);
        return this.flushTail;
    }

    private async flushOnce(): Promise<void> {
        if (!this.pendingPersist) return;
        const toPersist = this.pendingPersist;
        this.pendingPersist = null;
        await this.storage.update(STORAGE_KEY, toPersist);
    }
}
