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
});
