import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import type { ModelInfo, ModelQuota, ModelQuotaRow } from './types';

type RequestOptions = { method?: string; headers?: Record<string, string>; body?: string };
type OAuthConstants = { clientId: string; clientSecret: string };

export interface ModelQuotaServiceOptions {
    log?(message: string): void;
    now?(): number;
    requestJson?(url: string, options?: RequestOptions): Promise<any>;
    readFile?(filePath: string): Promise<string>;
    homeDir?: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    quotaCacheTtlMs?: number;
    loadAntigravityOAuthConstants?(): OAuthConstants | null;
}

function defaultRequestJson(url: string, options: RequestOptions = {}): Promise<any> {
    return new Promise((resolve, reject) => {
        const request = https.request(url, { method: options.method || 'GET', headers: options.headers }, (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            response.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
                    reject(new Error(`HTTP ${response.statusCode} ${response.statusMessage || ''}`.trim()));
                    return;
                }
                try {
                    resolve(JSON.parse(raw));
                } catch (error) {
                    reject(new Error(`Failed to parse JSON: ${String(error)}`));
                }
            });
        });
        request.on('error', reject);
        if (options.body) request.write(options.body);
        request.end();
    });
}

export class ModelQuotaService {
    private readonly cache = new Map<string, { ts: number; quota: ModelQuota | null }>();
    private readonly inFlight = new Map<string, Promise<ModelQuota | null>>();
    private oauthConstantsPromise?: Promise<OAuthConstants | null>;
    private readonly log: (message: string) => void;
    private readonly now: () => number;
    private readonly requestJson: (url: string, options?: RequestOptions) => Promise<any>;
    private readonly readFile: (filePath: string) => Promise<string>;
    private readonly homeDir: string;
    private readonly env: NodeJS.ProcessEnv;
    private readonly platform: NodeJS.Platform;
    private readonly quotaCacheTtlMs: number;
    private readonly loadOAuthConstants: () => OAuthConstants | null;

    constructor(options: ModelQuotaServiceOptions = {}) {
        this.log = options.log || (() => undefined);
        this.now = options.now || Date.now;
        this.requestJson = options.requestJson || defaultRequestJson;
        this.readFile = options.readFile || ((filePath) => fs.promises.readFile(filePath, 'utf8'));
        this.homeDir = options.homeDir || os.homedir();
        this.env = options.env || process.env;
        this.platform = options.platform || process.platform;
        this.quotaCacheTtlMs = options.quotaCacheTtlMs ?? 15000;
        this.loadOAuthConstants = options.loadAntigravityOAuthConstants || (() => {
            try {
                const loaded = require('opencode-antigravity-auth/dist/src/constants.js') as Record<string, unknown>;
                const clientId = typeof loaded.ANTIGRAVITY_CLIENT_ID === 'string' ? loaded.ANTIGRAVITY_CLIENT_ID.trim() : '';
                const clientSecret = typeof loaded.ANTIGRAVITY_CLIENT_SECRET === 'string' ? loaded.ANTIGRAVITY_CLIENT_SECRET.trim() : '';
                return clientId && clientSecret ? { clientId, clientSecret } : null;
            } catch {
                return null;
            }
        });
    }

    async fetch(model: ModelInfo): Promise<ModelQuota | null> {
        const key = model.fullId;
        const cached = this.cache.get(key);
        if (cached && this.now() - cached.ts < this.quotaCacheTtlMs) return cached.quota;
        const active = this.inFlight.get(key);
        if (active) return active;
        const task = this.fetchUncached(model).then((quota) => {
            const normalized = quota ? { ...quota, providerId: model.providerId, modelId: model.fullId } : null;
            this.cache.set(key, { ts: this.now(), quota: normalized });
            return normalized;
        });
        this.inFlight.set(key, task);
        try {
            return await task;
        } finally {
            this.inFlight.delete(key);
        }
    }

    private async fetchUncached(model: ModelInfo): Promise<ModelQuota | null> {
        const provider = (model.providerId || '').toLowerCase();
        const fullId = (model.fullId || '').toLowerCase();
        if (provider.includes('github') || provider.includes('copilot') || fullId.includes('copilot')) {
            return this.fetchCopilotQuota();
        }
        if (provider.includes('openai') || provider.includes('chatgpt') || fullId.includes('openai') || fullId.includes('chatgpt')) {
            return this.fetchOpenAIQuota();
        }
        if (provider.includes('antigravity') || provider.includes('google') || fullId.includes('antigravity') || fullId.includes('gemini')) {
            return this.fetchAntigravityQuota(model.fullId);
        }
        return null;
    }

    private dataDirCandidates(): string[] {
        const dataBase = (this.env.XDG_DATA_HOME && this.env.XDG_DATA_HOME.trim()) || path.join(this.homeDir, '.local', 'share');
        const directories = [path.join(dataBase, 'opencode')];
        if (this.platform === 'win32') {
            const appData = (this.env.APPDATA && this.env.APPDATA.trim()) || path.join(this.homeDir, 'AppData', 'Roaming');
            const localAppData = (this.env.LOCALAPPDATA && this.env.LOCALAPPDATA.trim()) || path.join(this.homeDir, 'AppData', 'Local');
            directories.push(path.join(appData, 'opencode'), path.join(localAppData, 'opencode'));
        }
        return Array.from(new Set(directories));
    }

    private async readAuthJson(): Promise<any | null> {
        for (const directory of this.dataDirCandidates()) {
            try {
                return JSON.parse(await this.readFile(path.join(directory, 'auth.json')));
            } catch {
                continue;
            }
        }
        return null;
    }

    private formatReset(resetAt?: number, resetAfterSeconds?: number): string | undefined {
        if (typeof resetAt === 'number' && Number.isFinite(resetAt) && resetAt > 0) {
            const date = new Date(resetAt * 1000);
            if (date.getTime() - this.now() < 24 * 60 * 60 * 1000) return `resets at ${date.toLocaleTimeString()}`;
            return `resets on ${date.toLocaleDateString()}`;
        }
        if (typeof resetAfterSeconds === 'number' && Number.isFinite(resetAfterSeconds) && resetAfterSeconds > 0) {
            const minutes = Math.round(resetAfterSeconds / 60);
            if (minutes >= 60) {
                const hours = Math.floor(minutes / 60);
                const remainder = minutes % 60;
                return remainder ? `resets in ${hours}h ${remainder}m` : `resets in ${hours}h`;
            }
            return `resets in ${minutes}m`;
        }
        return undefined;
    }

    private formatWindow(seconds?: number): string | undefined {
        if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return undefined;
        const hours = seconds / 3600;
        if (hours <= 6) return '5h';
        if (hours < 24) return `${Math.round(hours)}h`;
        const days = hours / 24;
        return days <= 7 ? 'Weekly' : `${Math.round(days)}d`;
    }

    private async fetchOpenAIQuota(): Promise<ModelQuota | null> {
        const auth = await this.readAuthJson();
        const account = auth?.openai || auth?.codex || auth?.chatgpt || auth?.opencode;
        if (!account?.access) return null;
        const headers: Record<string, string> = { Authorization: `Bearer ${account.access}`, 'User-Agent': 'OpenCode-Quota/1.0' };
        if (account.accountId) headers['ChatGPT-Account-Id'] = account.accountId;
        let data: any;
        try {
            data = await this.requestJson('https://chatgpt.com/backend-api/wham/usage', { headers });
        } catch {
            return null;
        }
        const primary = data?.rate_limit?.primary_window || {};
        const secondary = data?.rate_limit?.secondary_window || {};
        const rows: ModelQuotaRow[] = [];
        for (const window of [primary, secondary]) {
            if (typeof window.used_percent !== 'number') continue;
            rows.push({
                label: this.formatWindow(window.limit_window_seconds) || 'Usage',
                remainingPercent: Math.round(Math.max(0, 100 - window.used_percent)),
                resetText: this.formatReset(window.reset_at, window.reset_after_seconds),
            });
        }
        return this.quotaFromRows('openai', rows);
    }

    private async fetchCopilotQuota(): Promise<ModelQuota | null> {
        const auth = await this.readAuthJson();
        const account = auth?.['github-copilot'] || auth?.github;
        const token = account?.access || account?.refresh;
        if (!token) return null;
        let data: any;
        try {
            data = await this.requestJson('https://api.github.com/copilot_internal/user', { headers: {
                Authorization: `Bearer ${token}`,
                Accept: 'application/json',
                'User-Agent': 'GitHubCopilotChat/0.35.0',
                'Editor-Version': 'vscode/1.107.0',
                'Editor-Plugin-Version': 'copilot-chat/0.35.0',
                'Copilot-Integration-Id': 'vscode-chat',
            } });
        } catch {
            return null;
        }
        const premium = data?.quota_snapshots?.premium_interactions;
        if (typeof premium?.percent_remaining !== 'number') return null;
        const remaining = Math.max(0, Math.min(100, Math.round(premium.percent_remaining)));
        return {
            providerId: 'github-copilot', modelId: 'copilot', summaryRemainingPercent: remaining,
            rows: [{ label: 'Monthly', remainingPercent: remaining, resetText: data?.quota_reset_date ? `resets on ${new Date(data.quota_reset_date).toLocaleDateString()}` : undefined }],
            fetchedAt: this.now(),
        };
    }

    private quotaFromRows(modelId: string, rows: ModelQuotaRow[]): ModelQuota | null {
        if (!rows.length) return null;
        return { providerId: modelId, modelId, summaryRemainingPercent: Math.min(...rows.map((row) => row.remainingPercent)), rows, fetchedAt: this.now() };
    }

    private async fetchAntigravityQuota(modelFullId: string): Promise<ModelQuota | null> {
        const configBase = (this.env.XDG_CONFIG_HOME && this.env.XDG_CONFIG_HOME.trim()) || path.join(this.homeDir, '.config');
        const candidates = [path.join(configBase, 'opencode', 'antigravity-accounts.json')];
        if (this.platform === 'win32') {
            const appData = (this.env.APPDATA && this.env.APPDATA.trim()) || path.join(this.homeDir, 'AppData', 'Roaming');
            candidates.push(path.join(appData, 'opencode', 'antigravity-accounts.json'));
        }
        let accounts: any = null;
        for (const candidate of candidates) {
            try { accounts = JSON.parse(await this.readFile(candidate)); break; } catch { continue; }
        }
        const account = accounts?.accounts?.[accounts.activeIndex ?? 0];
        if (!account?.refreshToken) return null;
        const oauth = await this.getOAuthConstants();
        if (!oauth) {
            this.log('EXT: quota.antigravity.skip | reason=missing-oauth-constants');
            return null;
        }
        let tokenData: any;
        try {
            tokenData = await this.requestJson('https://oauth2.googleapis.com/token', {
                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ client_id: oauth.clientId, client_secret: oauth.clientSecret, refresh_token: account.refreshToken, grant_type: 'refresh_token' }).toString(),
            });
        } catch { return null; }
        if (!tokenData?.access_token) return null;
        const headers = {
            'Content-Type': 'application/json', 'User-Agent': 'antigravity/1.11.5 windows/amd64',
            'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
            'Client-Metadata': '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}',
            Authorization: `Bearer ${tokenData.access_token}`,
        };
        let available: any = null;
        for (const endpoint of ['https://daily-cloudcode-pa.sandbox.googleapis.com', 'https://autopush-cloudcode-pa.sandbox.googleapis.com', 'https://cloudcode-pa.googleapis.com']) {
            try {
                available = (await this.requestJson(`${endpoint}/v1internal:fetchAvailableModels`, { method: 'POST', headers, body: JSON.stringify(account.projectId ? { project: account.projectId } : {}) }))?.models || null;
                if (available) break;
            } catch { continue; }
        }
        if (!available) return null;
        const target = modelFullId.toLowerCase();
        let best: { label: string; remainingFraction: number; resetTime?: string } | null = null;
        for (const key of Object.keys(available)) {
            const info = available[key];
            if (typeof info?.quotaInfo?.remainingFraction !== 'number') continue;
            const label = String(info.displayName || info.model || key || '');
            const candidate = { label, remainingFraction: info.quotaInfo.remainingFraction, resetTime: info.quotaInfo.resetTime };
            if (target.includes(label.toLowerCase()) || target.includes(String(info.model || key || '').toLowerCase())) { best = candidate; break; }
            if (!best) best = candidate;
        }
        if (!best) return null;
        const remaining = Math.round(best.remainingFraction * 100);
        return { providerId: 'google-antigravity', modelId: modelFullId, summaryRemainingPercent: remaining, rows: [{ label: best.label, remainingPercent: remaining, resetText: best.resetTime ? `resets on ${new Date(best.resetTime).toLocaleDateString()}` : undefined }], fetchedAt: this.now() };
    }

    private async getOAuthConstants(): Promise<OAuthConstants | null> {
        if (!this.oauthConstantsPromise) this.oauthConstantsPromise = Promise.resolve(this.resolveOAuthConstants());
        return this.oauthConstantsPromise;
    }

    private resolveOAuthConstants(): OAuthConstants | null {
        const loaded = this.loadOAuthConstants();
        if (loaded) {
            this.log('EXT: quota.antigravity.auth-source | source=opencode-antigravity-auth');
            return loaded;
        }
        const clientId = String(this.env.ANTIGRAVITY_CLIENT_ID || this.env.OPENCODE_ANTIGRAVITY_CLIENT_ID || '').trim();
        const clientSecret = String(this.env.ANTIGRAVITY_CLIENT_SECRET || this.env.OPENCODE_ANTIGRAVITY_CLIENT_SECRET || '').trim();
        if (!clientId || !clientSecret) return null;
        this.log('EXT: quota.antigravity.auth-source | source=env');
        return { clientId, clientSecret };
    }
}
