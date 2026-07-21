import type { OpenCodeClient, ModelInfo } from '../OpenCodeClient';
import { SmartSearchService } from '../search/SmartSearchService';
import type { SmartSearchSessionRegistry } from '../search/SmartSearchSessionRegistry';

describe('Smart Search service', () => {
    it('uses expansion and rerank temporary sessions and cleans both', async () => {
        const created: string[] = [];
        const deleted: string[] = [];
        const tracked: string[] = [];
        const released: string[] = [];
        const prompts: string[] = [];
        const model: ModelInfo = { fullId: 'opencode/free', id: 'free', name: 'Free', providerId: 'opencode', contextLimit: 100000, variants: [] };
        const client = {
            listModels: async () => [model],
            pickFreeModel: (_models: ModelInfo[], preferred?: string) => preferred === model.fullId || !preferred ? model : model,
            createSession: async () => { const id = `temp-${created.length + 1}`; created.push(id); return { id }; },
            startTurnWithOp: () => undefined,
            chat: async (prompt: string, options: { sessionId: string }, onEvent: (event: any) => void) => {
                prompts.push(prompt);
                const text = prompt.includes('high-recall lexical')
                    ? '{"phrases":["history reload"],"terms":["snapshot"]}'
                    : '{"messageIds":["m2"]}';
                onEvent({ type: 'text', sessionId: options.sessionId, text });
            },
            listSessionMessages: async () => [],
            abortSession: async () => undefined,
            finishTurn: () => undefined,
            deleteSession: async (id: string) => { deleted.push(id); },
        } as unknown as OpenCodeClient;
        const sessions = {
            track: async (id: string) => { tracked.push(id); },
            release: async (id: string) => { released.push(id); },
        } as unknown as SmartSearchSessionRegistry;
        const service = new SmartSearchService({
            client,
            sessions,
            getCachedModels: () => [model],
            setCachedModels: () => undefined,
            getSelectedModel: () => model.fullId,
            log: () => undefined,
        });

        await expect(service.run('source-session', 'reload history', [
            { id: 'm1', role: 'user', text: 'unrelated' },
            { id: 'm2', role: 'assistant', text: 'history reload snapshot' },
        ])).resolves.toEqual({ messageIds: ['m2'], modelId: model.fullId });
        expect(prompts).toHaveLength(2);
        expect(created).toEqual(['temp-1', 'temp-2']);
        expect(tracked).toEqual(created);
        expect(deleted).toEqual(created);
        expect(released).toEqual(created);
    });

    it('returns immediately when there is no query or searchable message', async () => {
        const service = new SmartSearchService({
            client: {} as OpenCodeClient,
            sessions: {} as SmartSearchSessionRegistry,
            getCachedModels: () => [],
            setCachedModels: () => undefined,
            getSelectedModel: () => undefined,
            log: () => undefined,
        });
        await expect(service.run('s', '', [{ id: 'm1', role: 'user', text: 'x' }])).resolves.toEqual({ messageIds: [], modelId: '' });
        await expect(service.run('s', 'query', [])).resolves.toEqual({ messageIds: [], modelId: '' });
    });
});
