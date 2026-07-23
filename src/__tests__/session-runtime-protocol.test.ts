import {
    decideEnvelopeAcceptance,
    validateSessionEnvelope,
} from '../session-runtime/protocol';

describe('session runtime owned protocol', () => {
    test('accepts an explicitly owned session event', () => {
        expect(validateSessionEnvelope({
            type: 'assistant-chunk',
            sessionId: 'session-a',
            sessionEpoch: 2,
            turnGeneration: 7,
            sequence: 13,
            commandId: 'command-a',
            payload: { text: 'hello' },
        }, { requireTurnGeneration: true })).toEqual({
            ok: true,
            envelope: {
                type: 'assistant-chunk',
                sessionId: 'session-a',
                sessionEpoch: 2,
                turnGeneration: 7,
                sequence: 13,
                commandId: 'command-a',
                payload: { text: 'hello' },
            },
        });
    });

    test.each([
        [null, 'not-an-object'],
        [{}, 'missing-type'],
        [{ type: 'x' }, 'missing-session-id'],
        [{ type: 'x', sessionId: 'a' }, 'invalid-session-epoch'],
        [{ type: 'x', sessionId: 'a', sessionEpoch: 1 }, 'invalid-sequence'],
        [{ type: 'x', sessionId: 'a', sessionEpoch: 1, sequence: 1 }, 'missing-payload'],
        [{ type: 'x', sessionId: 'a', sessionEpoch: 1, sequence: 1, turnGeneration: 0, payload: {} }, 'invalid-turn-generation'],
        [{ type: 'x', sessionId: 'a', sessionEpoch: 1, sequence: 1, commandId: '', payload: {} }, 'invalid-command-id'],
    ])('rejects invalid ownership envelope %#', (value, reason) => {
        expect(validateSessionEnvelope(value)).toEqual({ ok: false, reason });
    });

    test('requires turn generation for turn-owned event families', () => {
        expect(validateSessionEnvelope({
            type: 'assistant-chunk',
            sessionId: 'session-a',
            sessionEpoch: 1,
            sequence: 1,
            payload: {},
        }, { requireTurnGeneration: true })).toEqual({
            ok: false,
            reason: 'missing-turn-generation',
        });
    });

    test('accepts only monotonic sequence within an epoch', () => {
        const first = decideEnvelopeAcceptance(null, { sessionEpoch: 1, sequence: 4 });
        expect(first).toMatchObject({ accepted: true, reason: 'first' });
        if (!first.accepted) throw new Error('expected first envelope to be accepted');

        expect(decideEnvelopeAcceptance(first.clock, { sessionEpoch: 1, sequence: 4 }))
            .toMatchObject({ accepted: false, reason: 'duplicate-or-stale-sequence' });
        expect(decideEnvelopeAcceptance(first.clock, { sessionEpoch: 1, sequence: 3 }))
            .toMatchObject({ accepted: false, reason: 'duplicate-or-stale-sequence' });
        expect(decideEnvelopeAcceptance(first.clock, { sessionEpoch: 1, sequence: 5 }))
            .toEqual({
                accepted: true,
                reason: 'next-sequence',
                clock: { sessionEpoch: 1, sequence: 5 },
            });
    });

    test('rejects older epochs and resets sequence authority for a new epoch', () => {
        const current = { sessionEpoch: 3, sequence: 100 };
        expect(decideEnvelopeAcceptance(current, { sessionEpoch: 2, sequence: 1 }))
            .toMatchObject({ accepted: false, reason: 'older-epoch' });
        expect(decideEnvelopeAcceptance(current, { sessionEpoch: 4, sequence: 1 }))
            .toEqual({
                accepted: true,
                reason: 'new-epoch',
                clock: { sessionEpoch: 4, sequence: 1 },
            });
    });
});
