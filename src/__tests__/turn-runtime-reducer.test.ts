import {
    createTurnRuntimeState,
    reduceTurnRuntime,
} from '../session-runtime/turn/turn-reducer';
import type { TurnRuntimeEvent } from '../session-runtime/turn/types';

function owned<T extends TurnRuntimeEvent>(
    event: Omit<T, 'sessionId' | 'sessionEpoch' | 'sequence' | 'turnGeneration'>
        & Partial<Pick<T, 'sessionId' | 'sessionEpoch' | 'sequence' | 'turnGeneration'>>,
): T {
    return {
        sessionId: 'A',
        sessionEpoch: 1,
        sequence: 1,
        turnGeneration: 1,
        ...event,
    } as T;
}

function start() {
    const initial = createTurnRuntimeState('A', 1);
    return reduceTurnRuntime(initial, owned({
        type: 'turn-started',
        payload: {
            userEntityId: 'entity:user:A:1',
            assistantEntityId: 'entity:assistant:A:1',
            temporaryAssistantId: 'tmp:A:1',
        },
    })).state;
}

describe('single-session turn runtime reducer', () => {
    test('keeps stable entity identity while canonicalizing the assistant', () => {
        const started = start();
        const rebound = reduceTurnRuntime(started, owned({
            type: 'assistant-temporary-bound',
            sequence: 2,
            payload: { temporaryId: 'tmp:A:replacement' },
        })).state;
        const canonicalized = reduceTurnRuntime(rebound, owned({
            type: 'assistant-canonicalized',
            sequence: 3,
            payload: { canonicalId: 'msg_assistant_A', canonicalIndex: 42 },
        }));

        expect(canonicalized).toMatchObject({ changed: true, reason: 'applied' });
        expect(canonicalized.state.assistant).toEqual({
            entityId: 'entity:assistant:A:1',
            canonicalId: 'msg_assistant_A',
            canonicalIndex: 42,
        });
    });

    test('makes main-assistant finalization atomic and terminal', () => {
        const streamed = reduceTurnRuntime(start(), owned({
            type: 'assistant-chunk',
            sequence: 2,
            payload: { text: 'partial' },
        })).state;
        const finalized = reduceTurnRuntime(streamed, owned({
            type: 'turn-finalized',
            sequence: 3,
            payload: {
                canonicalId: 'msg_assistant_A',
                canonicalIndex: 42,
                finalText: 'final answer',
            },
        })).state;

        expect(finalized).toMatchObject({
            phase: 'finalized',
            assistantText: 'final answer',
            statusText: '',
            terminalReason: null,
            assistant: {
                entityId: 'entity:assistant:A:1',
                canonicalId: 'msg_assistant_A',
                canonicalIndex: 42,
            },
        });

        const delayed = [
            owned({ type: 'assistant-chunk', sequence: 4, payload: { text: ' stale' } }),
            owned({ type: 'assistant-status', sequence: 5, payload: { text: 'Thinking...' } }),
            owned({ type: 'turn-streaming', sequence: 6, payload: {} }),
            owned({ type: 'assistant-canonicalized', sequence: 7, payload: { canonicalId: 'msg_wrong' } }),
        ].reduce((state, event) => reduceTurnRuntime(state, event).state, finalized);

        expect(delayed).toBe(finalized);
    });

    test('uses the same terminal transition shape for failure and cancellation', () => {
        const failed = reduceTurnRuntime(start(), owned({
            type: 'turn-failed',
            sequence: 2,
            payload: { reason: 'network' },
        })).state;
        const cancelled = reduceTurnRuntime(start(), owned({
            type: 'turn-cancelled',
            sequence: 2,
            payload: { reason: 'user' },
        })).state;

        expect(failed).toMatchObject({ phase: 'failed', statusText: '', terminalReason: 'network' });
        expect(cancelled).toMatchObject({ phase: 'cancelled', statusText: '', terminalReason: 'user' });
        expect(reduceTurnRuntime(failed, owned({
            type: 'turn-streaming',
            sequence: 3,
            payload: {},
        })).state).toBe(failed);
        expect(reduceTurnRuntime(cancelled, owned({
            type: 'turn-streaming',
            sequence: 3,
            payload: {},
        })).state).toBe(cancelled);
    });

    test('rejects invalid canonical IDs without changing state', () => {
        const started = start();
        expect(reduceTurnRuntime(started, owned({
            type: 'assistant-canonicalized',
            sequence: 2,
            payload: { canonicalId: 'tmp:not-canonical' },
        }))).toEqual({
            state: started,
            changed: false,
            reason: 'invalid-canonical-id',
        });
        expect(reduceTurnRuntime(started, owned({
            type: 'turn-finalized',
            sequence: 3,
            payload: { canonicalId: 'internal:not-canonical', finalText: 'bad' },
        }))).toEqual({
            state: started,
            changed: false,
            reason: 'invalid-canonical-id',
        });
    });

    test('requires a new turn start before accepting a future generation', () => {
        const generationOne = start();
        const futureChunk = reduceTurnRuntime(generationOne, owned({
            type: 'assistant-chunk',
            turnGeneration: 2,
            sequence: 2,
            payload: { text: 'future' },
        }));
        expect(futureChunk).toEqual({
            state: generationOne,
            changed: false,
            reason: 'future-generation-without-start',
        });

        const generationTwo = reduceTurnRuntime(generationOne, owned({
            type: 'turn-started',
            turnGeneration: 2,
            sequence: 3,
            payload: {
                userEntityId: 'entity:user:A:2',
                assistantEntityId: 'entity:assistant:A:2',
                temporaryAssistantId: 'tmp:A:2',
            },
        })).state;
        expect(generationTwo).toMatchObject({
            generation: 2,
            phase: 'submitted',
            assistantText: '',
            assistant: {
                entityId: 'entity:assistant:A:2',
                temporaryId: 'tmp:A:2',
            },
        });
    });
});
