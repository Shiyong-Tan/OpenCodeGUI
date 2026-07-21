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

    it('returns and caches null for providers without a quota adapter', async () => {
        const requestJson = jest.fn();
        const service = new ModelQuotaService({ requestJson, homeDir: '/home/test', env: {}, platform: 'linux' });
        await expect(service.fetch(model('local', 'local/model'))).resolves.toBeNull();
        await expect(service.fetch(model('local', 'local/model'))).resolves.toBeNull();
        expect(requestJson).not.toHaveBeenCalled();
    });
});
