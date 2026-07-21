import { SmartSearchSessionRegistry } from '../search/SmartSearchSessionRegistry';

function createHarness(stored: unknown = undefined) {
    let value = stored;
    const aborted: string[] = [];
    const deleted: string[] = [];
    const updates: unknown[] = [];
    const logs: string[] = [];
    const registry = new SmartSearchSessionRegistry({
        storage: {
            get: () => value as any,
            update: async (_key, next) => { value = next; updates.push(next); },
        },
        client: {
            abortSession: async (id) => { aborted.push(id); },
            deleteSession: async (id) => { deleted.push(id); },
        },
        getCorpusDir: () => 'unused',
        log: (message) => logs.push(message),
    });
    return { registry, aborted, deleted, updates, logs, getStored: () => value };
}

describe('Smart Search temporary session registry', () => {
    it('persists ownership before work and removes it after successful cleanup', async () => {
        const harness = createHarness();
        await harness.registry.track('temp-1');
        expect(harness.registry.owns('temp-1')).toBe(true);
        expect(harness.getStored()).toEqual(['temp-1']);
        await harness.registry.release('temp-1');
        expect(harness.registry.owns('temp-1')).toBe(false);
        expect(harness.getStored()).toEqual([]);
    });

    it('deletes orphan sessions recorded before Extension reload', async () => {
        const harness = createHarness(['old-1', 'old-2']);
        await harness.registry.cleanupOrphans();
        expect(harness.aborted).toEqual(['old-1', 'old-2']);
        expect(harness.deleted).toEqual(['old-1', 'old-2']);
        expect(harness.getStored()).toEqual([]);
    });

    it('aborts and deletes every owned temporary session on dispose', async () => {
        const harness = createHarness();
        await harness.registry.track('temp-a');
        await harness.registry.track('temp-b');
        await harness.registry.dispose();
        expect(harness.aborted).toEqual(['temp-a', 'temp-b']);
        expect(harness.deleted).toEqual(['temp-a', 'temp-b']);
        expect(harness.getStored()).toEqual([]);
    });
});
