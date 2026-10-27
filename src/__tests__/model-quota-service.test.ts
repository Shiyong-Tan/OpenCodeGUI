import { ModelQuotaService } from '../models/ModelQuotaService';
import type { ModelInfo } from '../models/types';

const model = (providerId: string, fullId: string): ModelInfo => ({ id: fullId, providerId, fullId, name: fullId, variants: [] });

describe('ModelQuotaService', () => {
    it('routes OpenAI quota, preserves labels, and caches by full model id', async () => {
        let now = 1000;
        const requestJson = jest.fn(async () => ({ rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_after_seconds: 3600 } } }));
        const service = new ModelQuotaService({
            now: () => now,
            requestJson,
            readFile: async () => JSON.stringify({ openai: { access: 'token', accountId: 'account' } }),
            homeDir: '/home/test', env: {}, platform: 'linux',
        });
        const first = await service.fetch(model('openai', 'openai/test'));
        const second = await service.fetch(model('openai', 'openai/test'));
        expect(first).toMatchObject({ providerId: 'openai', modelId: 'openai/test', summaryRemainingPercent: 75, rows: [{ label: '5h', resetText: 'resets in 1h' }] });
        expect(second).toEqual(first);
        expect(requestJson).toHaveBeenCalledTimes(1);
        now += 16000;
        await service.fetch(model('openai', 'openai/test'));
        expect(requestJson).toHaveBeenCalledTimes(2);
    });

    it('coalesces concurrent Copilot requests and clamps remaining quota', async () => {
        let release!: (value: any) => void;
        const requestJson = jest.fn(() => new Promise((resolve) => { release = resolve; }));
        const service = new ModelQuotaService({
            requestJson,
            readFile: async () => JSON.stringify({ 'github-copilot': { access: 'token' } }),
            homeDir: '/home/test', env: {}, platform: 'linux',
        });
        const first = service.fetch(model('github-copilot', 'github-copilot/test'));
        const second = service.fetch(model('github-copilot', 'github-copilot/test'));
        await new Promise<void>((resolve) => setImmediate(resolve));
        release({ quota_snapshots: { premium_interactions: { percent_remaining: 130 } } });
        expect(await first).toMatchObject({ summaryRemainingPercent: 100 });
        expect(await second).toEqual(await first);
        expect(requestJson).toHaveBeenCalledTimes(1);
    });

    it('bypasses a fresh cached quota when an explicit refresh is requested', async () => {
        let remaining = 80;
        const requestJson = jest.fn(async () => ({
            quota_snapshots: {
                premium_interactions: { percent_remaining: remaining },
            },
        }));
        const service = new ModelQuotaService({
            requestJson,
            homeDir: '/home/test',
            env: {},
            platform: 'linux',
            readFile: async () => JSON.stringify({ 'github-copilot': { access: 'token' } }),
        });
        const target = model('github-copilot', 'github-copilot/gpt-test');

        expect((await service.fetch(target))?.summaryRemainingPercent).toBe(80);
        remaining = 65;
        expect((await service.fetch(target))?.summaryRemainingPercent).toBe(80);
        expect((await service.fetch(target, { force: true }))?.summaryRemainingPercent).toBe(65);
        expect(requestJson).toHaveBeenCalledTimes(2);
    });

    it('returns and caches null for providers without a quota adapter', async () => {
        const requestJson = jest.fn();
        const service = new ModelQuotaService({ requestJson, homeDir: '/home/test', env: {}, platform: 'linux' });
        await expect(service.fetch(model('local', 'local/model'))).resolves.toBeNull();
        await expect(service.fetch(model('local', 'local/model'))).resolves.toBeNull();
        expect(requestJson).not.toHaveBeenCalled();
    });
});


describe('native OpenAI quota credentials', () => {
    const usage = { rate_limit: { primary_window: { used_percent: 35, limit_window_seconds: 18000 } } };
    it('uses active native OAuth rather than the obsolete legacy auth file', async () => {
        const readFile = jest.fn(async () => JSON.stringify({ openai: { access: 'old' } }));
        const requestJson = jest.fn(async () => usage);
        const service = new ModelQuotaService({ readFile, requestJson,
            loadOpenAIAccount: async () => ({ access: 'active', accountId: 'active-account', expires: Date.now() + 60000 }) });
        expect(await service.fetch(model('openai', 'openai/test'))).toMatchObject({ summaryRemainingPercent: 65 });
        expect(readFile).not.toHaveBeenCalled();
        expect(requestJson).toHaveBeenCalledWith('https://chatgpt.com/backend-api/wham/usage', {
            headers: expect.objectContaining({ Authorization: 'Bearer active', 'ChatGPT-Account-Id': 'active-account' }) });
    });
    it.each(['none', 'expired', 'failed'] as const)('never falls back to another account when native credentials are %s', async mode => {
        const requestJson = jest.fn(), readFile = jest.fn(), logs: string[] = [];
        const service = new ModelQuotaService({ requestJson, readFile, log: line => logs.push(line), now: () => 1000,
            loadOpenAIAccount: async () => { if (mode === 'failed') throw Error('private credential details');
                return mode === 'none' ? null : { access: 'private-token', expires: 999 }; } });
        expect(await service.fetch(model('openai', 'openai/test'))).toBeNull();
        expect(readFile).not.toHaveBeenCalled(); expect(requestJson).not.toHaveBeenCalled();
        expect(logs.join(' ')).not.toMatch(/private/); expect(logs.join(' ')).toMatch(/reason=/);
    });
    it('reports only a bounded HTTP status and never raw authentication errors', async () => {
        const logs: string[] = [];
        const service = new ModelQuotaService({ log: line => logs.push(line),
            loadOpenAIAccount: async () => ({ access: 'secret' }),
            requestJson: async () => { throw Error('HTTP 401 secret token_expired'); } });
        expect(await service.fetch(model('openai', 'openai/test'))).toBeNull();
        expect(logs).toEqual(['EXT: quota.openai.unavailable | reason=http-401']);
    });
});
