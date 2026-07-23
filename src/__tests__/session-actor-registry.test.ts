import { SessionActor } from '../session-runtime/SessionActor';
import { SessionRegistry } from '../session-runtime/SessionRegistry';
import type { SessionEnvelope } from '../session-runtime/protocol';

type TestEvent = SessionEnvelope<
    'add',
    Readonly<{ value: number; effectGate?: string }>
>;

type TestState = Readonly<{
    sessionId: string;
    sessionEpoch: number;
    values: readonly number[];
}>;

type TestEffect = Readonly<{
    gate: string;
    value: number;
}>;

function event(
    sessionId: string,
    sequence: number,
    value: number,
    options: { sessionEpoch?: number; effectGate?: string } = {},
): TestEvent {
    return {
        type: 'add',
        sessionId,
        sessionEpoch: options.sessionEpoch || 1,
        sequence,
        payload: {
            value,
            ...(options.effectGate ? { effectGate: options.effectGate } : {}),
        },
    };
}

function createOptions(runEffect?: (effect: TestEffect) => Promise<void> | void) {
    return {
        createInitialState: (sessionId: string, sessionEpoch: number): TestState => ({
            sessionId,
            sessionEpoch,
            values: [],
        }),
        reduce: (state: TestState, owned: TestEvent) => ({
            state: {
                ...state,
                values: [...state.values, owned.payload.value],
            },
            effects: owned.payload.effectGate
                ? [{ gate: owned.payload.effectGate, value: owned.payload.value }]
                : [],
        }),
        runEffect,
    };
}

describe('SessionActor and SessionRegistry', () => {
    test('creates isolated instances that reuse the same reducer', async () => {
        const registry = new SessionRegistry<TestState, TestEvent, TestEffect>(createOptions());

        await registry.route(event('A', 1, 10));
        await registry.route(event('B', 1, 20));
        await registry.route(event('A', 2, 30));

        expect(registry.get('A')?.getSnapshot()).toEqual({
            sessionId: 'A',
            sessionEpoch: 1,
            values: [10, 30],
        });
        expect(registry.get('B')?.getSnapshot()).toEqual({
            sessionId: 'B',
            sessionEpoch: 1,
            values: [20],
        });
    });

    test('serializes events and effects within one session', async () => {
        let releaseFirst: (() => void) | undefined;
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });
        const effects: number[] = [];
        const actor = new SessionActor<TestState, TestEvent, TestEffect>({
            ...createOptions(async (ownedEffect) => {
                if (ownedEffect.gate === 'first') await firstGate;
                effects.push(ownedEffect.value);
            }),
            sessionId: 'A',
        });

        const first = actor.dispatch(event('A', 1, 1, { effectGate: 'first' }));
        const second = actor.dispatch(event('A', 2, 2, { effectGate: 'second' }));
        await Promise.resolve();
        expect(actor.getSnapshot().values).toEqual([1]);

        releaseFirst?.();
        await Promise.all([first, second]);

        expect(actor.getSnapshot().values).toEqual([1, 2]);
        expect(effects).toEqual([1, 2]);
    });

    test('does not block another session actor behind a slow effect', async () => {
        let releaseA: (() => void) | undefined;
        const gateA = new Promise<void>((resolve) => {
            releaseA = resolve;
        });
        const completed: string[] = [];
        const registry = new SessionRegistry<TestState, TestEvent, TestEffect>(
            createOptions(async (ownedEffect) => {
                if (ownedEffect.gate === 'A') await gateA;
                completed.push(ownedEffect.gate);
            }),
        );

        const routeA = registry.route(event('A', 1, 1, { effectGate: 'A' }));
        const routeB = registry.route(event('B', 1, 2, { effectGate: 'B' }));
        await routeB;

        expect(completed).toEqual(['B']);
        expect(registry.get('A')?.getSnapshot().values).toEqual([1]);
        expect(registry.get('B')?.getSnapshot().values).toEqual([2]);

        releaseA?.();
        await routeA;
        expect(completed).toEqual(['B', 'A']);
    });

    test('drops duplicate, stale, and cross-session events before the reducer', async () => {
        const actor = new SessionActor<TestState, TestEvent, TestEffect>({
            ...createOptions(),
            sessionId: 'A',
        });

        expect(await actor.dispatch(event('A', 2, 2))).toMatchObject({ accepted: true });
        expect(await actor.dispatch(event('A', 2, 200))).toMatchObject({
            accepted: false,
            reason: 'duplicate-or-stale-sequence',
        });
        expect(await actor.dispatch(event('A', 1, 100))).toMatchObject({
            accepted: false,
            reason: 'duplicate-or-stale-sequence',
        });
        expect(await actor.dispatch(event('B', 3, 300))).toMatchObject({
            accepted: false,
            reason: 'session-mismatch',
        });
        expect(actor.getSnapshot().values).toEqual([2]);
    });

    test('resets only the owning actor when a newer session epoch arrives', async () => {
        const registry = new SessionRegistry<TestState, TestEvent, TestEffect>(createOptions());
        await registry.route(event('A', 1, 1));
        await registry.route(event('B', 1, 2));
        await registry.route(event('A', 1, 3, { sessionEpoch: 2 }));

        expect(registry.get('A')?.getSnapshot()).toEqual({
            sessionId: 'A',
            sessionEpoch: 2,
            values: [3],
        });
        expect(registry.get('B')?.getSnapshot().values).toEqual([2]);
        expect(await registry.route(event('A', 100, 4, { sessionEpoch: 1 }))).toMatchObject({
            accepted: false,
            reason: 'older-epoch',
        });
    });

    test('notifies subscribers after state commit and tolerates listener failures', async () => {
        const listenerErrors: unknown[] = [];
        const snapshots: readonly number[][] = [];
        const actor = new SessionActor<TestState, TestEvent, TestEffect>({
            ...createOptions(),
            sessionId: 'A',
            onListenerError: (error) => listenerErrors.push(error),
        });
        actor.subscribe(() => {
            throw new Error('listener failed');
        });
        actor.subscribe((state) => {
            (snapshots as number[][]).push([...state.values]);
        });

        await actor.dispatch(event('A', 1, 5));

        expect(snapshots).toEqual([[5]]);
        expect(listenerErrors).toHaveLength(1);
        expect(actor.getSnapshot().values).toEqual([5]);
    });
});
