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

export class SessionSettingsStore {
    private readonly settingsBySession = new Map<string, SessionSettings>();
    private loaded = false;

    constructor(private readonly storage: SessionSettingsStorage) {}

    public async load(): Promise<void> {
        if (this.loaded) return;
        this.loaded = true;
        const stored = this.storage.get<unknown>(STORAGE_KEY);
        if (!stored || typeof stored !== 'object') return;
        for (const [sessionId, value] of Object.entries(stored as Record<string, unknown>)) {
            if (!value || typeof value !== 'object') continue;
            const settings = value as Record<string, unknown>;
            this.settingsBySession.set(sessionId, {
                ...(typeof settings.model === 'string' ? { model: settings.model } : {}),
                ...(typeof settings.variant === 'string' ? { variant: settings.variant } : {}),
                ...(typeof settings.mode === 'string' ? { mode: settings.mode } : {}),
            });
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

    public async set(sessionId: string, settings: SessionSettings): Promise<void> {
        if (!sessionId) return;
        this.settingsBySession.set(sessionId, { ...settings });
        await this.storage.update(STORAGE_KEY, this.snapshot());
    }

    public async delete(sessionId: string): Promise<void> {
        if (!this.settingsBySession.delete(sessionId)) return;
        await this.storage.update(STORAGE_KEY, this.snapshot());
    }
}
