import { ChatEventActorRouter } from '../session-runtime/ChatEventActorRouter';

describe('production chat event actor router', () => {
    test('serializes one session while allowing another session to progress', async () => {
        const order: string[] = [];
        let releaseA!: () => void;
        const blockedA = new Promise<void>((resolve) => { releaseA = resolve; });
        const router = new ChatEventActorRouter({
            handle: async (event) => {
                order.push(`start:${event.sessionId}:${event.text}`);
                if (event.sessionId === 'A' && event.text === 'A1') await blockedA;
                order.push(`end:${event.sessionId}:${event.text}`);
            },
        });

        const a1 = router.route({ type: 'text', sessionId: 'A', text: 'A1' });
        const a2 = router.route({ type: 'text', sessionId: 'A', text: 'A2' });
        const b1 = router.route({ type: 'text', sessionId: 'B', text: 'B1' });
        await b1;

        expect(order).toEqual([
            'start:A:A1',
            'start:B:B1',
            'end:B:B1',
        ]);
        releaseA();
        await Promise.all([a1, a2]);
        expect(order.slice(3)).toEqual(['end:A:A1', 'start:A:A2', 'end:A:A2']);
    });

    test('routes parent-visible subagent effects through the parent actor', async () => {
        const router = new ChatEventActorRouter({ handle: () => undefined });
        await router.route({
            type: 'text',
            sessionId: 'agent-A',
            parentSessionId: 'A',
            displayTarget: 'parent',
            text: 'progress',
        });
        expect(router.getHandledCount('A')).toBe(1);
        expect(router.getHandledCount('agent-A')).toBe(0);
    });

    test('contains handler failures and continues the owning queue', async () => {
        const handled: string[] = [];
        const errors: string[] = [];
        const router = new ChatEventActorRouter({
            handle: (event) => {
                if (event.text === 'bad') throw new Error('bad-event');
                handled.push(event.text || '');
            },
            onError: (_event, error) => errors.push(String(error)),
        });
        await router.route({ type: 'text', sessionId: 'A', text: 'bad' });
        await router.route({ type: 'text', sessionId: 'A', text: 'good' });
        expect(errors).toEqual(['Error: bad-event']);
        expect(handled).toEqual(['good']);
    });

    test('drops ownerless asynchronous events before the compatibility handler', async () => {
        const handled = jest.fn();
        const onDrop = jest.fn();
        const router = new ChatEventActorRouter({ handle: handled, onDrop });

        await router.route({ type: 'text', text: 'ownerless' });

        expect(handled).not.toHaveBeenCalled();
        expect(onDrop).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'text', text: 'ownerless' }),
            'missing-session-owner',
        );
    });

    test('production actor snapshots satisfy interleaving equivalence', async () => {
        const interleaved = new ChatEventActorRouter({ handle: () => undefined });
        const singleA = new ChatEventActorRouter({ handle: () => undefined });
        const singleB = new ChatEventActorRouter({ handle: () => undefined });
        const events = [
            { type: 'turnInFlight', sessionId: 'A', inFlight: true, tmpKey: 'tmp:A' },
            { type: 'text', sessionId: 'A', text: 'A partial. ' },
            { type: 'turnInFlight', sessionId: 'B', inFlight: true, tmpKey: 'tmp:B' },
            { type: 'assistantMessageMeta', sessionId: 'B', assistantMsgId: 'msg_B', tmpKey: 'tmp:B' },
            { type: 'text', sessionId: 'B', text: 'B final.' },
            { type: 'assistantMessageMeta', sessionId: 'A', assistantMsgId: 'msg_A', tmpKey: 'tmp:A' },
            { type: 'turnResolved', sessionId: 'A', assistantMsgId: 'msg_A', lastText: 'A final.' },
            { type: 'turnResolved', sessionId: 'B', assistantMsgId: 'msg_B', lastText: 'B final.' },
        ] as const;

        for (const owned of events) {
            await interleaved.route(owned);
            if (owned.sessionId === 'A') await singleA.route(owned);
            if (owned.sessionId === 'B') await singleB.route(owned);
        }

        expect(interleaved.getSnapshot('A')?.turn).toEqual(singleA.getSnapshot('A')?.turn);
        expect(interleaved.getSnapshot('B')?.turn).toEqual(singleB.getSnapshot('B')?.turn);
        expect(interleaved.getSnapshot('A')?.turn).toMatchObject({
            phase: 'finalized',
            assistantText: 'A final.',
            assistant: { canonicalId: 'msg_A' },
        });
        expect(interleaved.getSnapshot('B')?.turn).toMatchObject({
            phase: 'finalized',
            assistantText: 'B final.',
            assistant: { canonicalId: 'msg_B' },
        });
    });

    test('production actor snapshots satisfy non-interference and terminal monotonicity', async () => {
        const router = new ChatEventActorRouter({ handle: () => undefined });
        await router.route({ type: 'turnInFlight', sessionId: 'B', inFlight: true, tmpKey: 'tmp:B' });
        await router.route({ type: 'text', sessionId: 'B', text: 'stable B' });
        const beforeB = router.getSnapshot('B');

        await router.route({ type: 'turnInFlight', sessionId: 'A', inFlight: true, tmpKey: 'tmp:A' });
        await router.route({ type: 'assistantMessageMeta', sessionId: 'A', assistantMsgId: 'msg_A', tmpKey: 'tmp:A' });
        await router.route({ type: 'turnResolved', sessionId: 'A', assistantMsgId: 'msg_A', lastText: 'final A' });
        const terminalA = router.getSnapshot('A')?.turn;

        expect(router.getSnapshot('B')).toBe(beforeB);
        await router.route({ type: 'text', sessionId: 'A', text: 'late text' });
        await router.route({ type: 'assistantMessageMeta', sessionId: 'A', assistantMsgId: 'msg_wrong' });
        expect(router.getSnapshot('A')?.turn).toBe(terminalA);
    });

    test('parent-visible subagent traffic does not mutate the parent main turn', async () => {
        const router = new ChatEventActorRouter({ handle: () => undefined });
        await router.route({ type: 'turnInFlight', sessionId: 'A', inFlight: true, tmpKey: 'tmp:A' });
        const before = router.getSnapshot('A')?.turn;
        await router.route({
            type: 'text',
            sessionId: 'agent-A',
            parentSessionId: 'A',
            displayTarget: 'parent',
            text: 'subagent output',
        });
        expect(router.getSnapshot('A')?.turn).toBe(before);
    });
});
