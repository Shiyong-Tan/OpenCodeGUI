import { SessionSettingsStore } from '../session-runtime/SessionSettingsStore';

describe('SessionSettingsStore', () => {
    test('persists independent settings by session', async () => {
        let value: unknown;
        const storage = {
            get: jest.fn(() => value),
            update: jest.fn(async (_key: string, next: unknown) => { value = next; }),
        };
        const store = new SessionSettingsStore(storage as any);
        await store.load();
        await store.set('session-a', { model: 'a/model', variant: 'high', mode: 'build' });
        await store.set('session-b', { model: 'b/model', variant: 'low', mode: 'plan' });

        expect(store.get('session-a')).toEqual({ model: 'a/model', variant: 'high', mode: 'build' });
        expect(store.get('session-b')).toEqual({ model: 'b/model', variant: 'low', mode: 'plan' });
    });

    test('loads only valid settings and ignores malformed entries', async () => {
        const storage = {
            get: jest.fn(() => ({
                good: { model: 'provider/model', mode: 'plan', ignored: true },
                bad: 'not-an-object',
            })),
            update: jest.fn(async () => undefined),
        };
        const store = new SessionSettingsStore(storage as any);
        await store.load();
        expect(store.get('good')).toEqual({ model: 'provider/model', mode: 'plan' });
        expect(store.get('bad')).toEqual({});
    });

    test('makes settings visible to reads before persistence completes', async () => {
        let resolveUpdate: (() => void) | undefined;
        const storage = {
            get: jest.fn(),
            update: jest.fn(() => new Promise<void>((resolve) => { resolveUpdate = resolve; })),
        };
        const store = new SessionSettingsStore(storage as any);
        await store.load();
        const pending = store.set('session-a', { model: 'a/model' });
        expect(store.get('session-a')).toEqual({ model: 'a/model' });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(resolveUpdate).toBeDefined();
        resolveUpdate?.();
        await pending;
    });

    test('coalesces rapid writes so only the latest snapshot is persisted', async () => {
        let value: unknown;
        const storage = {
            get: jest.fn(() => value),
            update: jest.fn(async (_key: string, next: unknown) => { value = next; }),
        };
        const store = new SessionSettingsStore(storage as any);
        await store.load();
        void store.set('session-a', { model: 'a/model' });
        void store.set('session-a', { model: 'a/model', variant: 'high' });
        void store.set('session-a', { model: 'a/model', variant: 'high', mode: 'build' });
        await store.set('session-b', { model: 'b/model', mode: 'plan' });

        expect(storage.update).toHaveBeenCalledTimes(1);
        expect(value).toEqual({
            'session-a': { model: 'a/model', variant: 'high', mode: 'build' },
            'session-b': { model: 'b/model', mode: 'plan' },
        });
    });

    test('serializes storage updates so they never overlap', async () => {
        let active = 0;
        let maxActive = 0;
        const storage = {
            get: jest.fn(),
            update: jest.fn(async (_key: string, next: unknown) => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await new Promise((resolve) => setImmediate(resolve));
                active -= 1;
            }),
        };
        const store = new SessionSettingsStore(storage as any);
        await store.load();
        await Promise.all(
            Array.from({ length: 10 }, (_, i) => store.set(`session-${i}`, { model: `m${i}` }))
        );
        expect(maxActive).toBe(1);
    });

    test('swallows persistence failures and keeps later writes working', async () => {
        let value: unknown;
        let calls = 0;
        const storage = {
            get: jest.fn(() => value),
            update: jest.fn(async (_key: string, next: unknown) => {
                calls += 1;
                if (calls === 1) throw new Error('storage unavailable');
                value = next;
            }),
        };
        const store = new SessionSettingsStore(storage as any);
        await store.load();
        await expect(store.set('session-a', { model: 'a/model' })).resolves.toBeUndefined();
        expect(store.get('session-a')).toEqual({ model: 'a/model' });
        await expect(store.set('session-b', { model: 'b/model' })).resolves.toBeUndefined();
        expect(value).toEqual({
            'session-a': { model: 'a/model' },
            'session-b': { model: 'b/model' },
        });
    });

    test('deletes settings from memory and the persisted snapshot', async () => {
        let value: unknown;
        const storage = {
            get: jest.fn(() => value),
            update: jest.fn(async (_key: string, next: unknown) => { value = next; }),
        };
        const store = new SessionSettingsStore(storage as any);
        await store.load();
        await store.set('session-a', { model: 'a/model' });
        await store.set('session-b', { model: 'b/model' });
        const pending = store.delete('session-a');
        expect(store.get('session-a')).toEqual({});
        await pending;
        expect(value).toEqual({ 'session-b': { model: 'b/model' } });
    });

    test('sanitizes settings on write so unknown fields never persist', async () => {
        let value: unknown;
        const storage = {
            get: jest.fn(() => value),
            update: jest.fn(async (_key: string, next: unknown) => { value = next; }),
        };
        const store = new SessionSettingsStore(storage as any);
        await store.load();
        await store.set('session-a', { model: 'a/model', poisoned: 'x' } as any);
        expect(store.get('session-a')).toEqual({ model: 'a/model' });
        expect(value).toEqual({ 'session-a': { model: 'a/model' } });
    });
});