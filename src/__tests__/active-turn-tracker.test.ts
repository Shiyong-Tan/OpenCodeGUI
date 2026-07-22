import { ActiveTurnTracker } from '../continuation/ActiveTurnTracker';

describe('ActiveTurnTracker', () => {
    test('isolates freshness and identity across sessions', () => {
        let now = 1_000;
        const streaming = new Set(['session-a']);
        const assistants = new Map([['session-b', 'msg_assistant_b']]);
        const locals = new Map([['session-a', 'local-a']]);
        const tracker = new ActiveTurnTracker({
            isStreaming: (sessionId) => streaming.has(sessionId),
            getPendingAssistantId: (sessionId) => assistants.get(sessionId),
            getPendingLocalKey: (sessionId) => locals.get(sessionId),
            freshnessWindowMs: 30_000,
            now: () => now,
        });
        tracker.mark('session-a');
        expect(tracker.snapshot('session-a')).toMatchObject({
            streaming: true,
            finalizing: false,
            active: true,
            fresh: true,
            turnId: 'local-a',
            source: 'sendInFlightBySession',
        });
        expect(tracker.snapshot('session-b')).toMatchObject({
            streaming: false,
            finalizing: true,
            active: true,
            fresh: false,
            turnId: 'msg_assistant_b',
        });
        now += 30_001;
        expect(tracker.snapshot('session-a').fresh).toBe(false);
    });

    test('reports the combined streaming and finalizing source', () => {
        const tracker = new ActiveTurnTracker({
            isStreaming: () => true,
            getPendingAssistantId: () => 'msg_assistant',
            getPendingLocalKey: () => 'local-user',
            freshnessWindowMs: 30_000,
            now: () => 100,
        });
        tracker.mark('session-a');
        expect(tracker.snapshot('session-a')).toMatchObject({
            source: 'sendInFlightBySession+pendingAssistantMessageIdBySession',
            turnId: 'msg_assistant',
            fresh: true,
        });
    });
});
