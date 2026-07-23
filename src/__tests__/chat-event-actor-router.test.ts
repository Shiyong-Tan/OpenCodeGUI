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
});
