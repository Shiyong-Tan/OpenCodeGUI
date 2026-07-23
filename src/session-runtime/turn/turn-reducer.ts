import type {
    AssistantBinding,
    TurnReduction,
    TurnRuntimeEvent,
    TurnRuntimeState,
} from './types';

export function createTurnRuntimeState(
    sessionId: string,
    sessionEpoch: number,
): TurnRuntimeState {
    return {
        sessionId,
        sessionEpoch,
        generation: 0,
        phase: 'idle',
        userEntityId: null,
        canonicalUserId: null,
        assistant: null,
        assistantText: '',
        statusText: '',
        terminalReason: null,
    };
}

function isTerminal(state: TurnRuntimeState): boolean {
    return state.phase === 'finalized'
        || state.phase === 'failed'
        || state.phase === 'cancelled';
}

function isCanonicalMessageId(value: string): boolean {
    return value.startsWith('msg_');
}

function unchanged(state: TurnRuntimeState, reason: TurnReduction['reason']): TurnReduction {
    return { state, changed: false, reason };
}

function applied(state: TurnRuntimeState): TurnReduction {
    return { state, changed: true, reason: 'applied' };
}

function bindCanonicalAssistant(
    binding: AssistantBinding,
    canonicalId: string,
    canonicalIndex?: number,
): AssistantBinding {
    return {
        entityId: binding.entityId,
        canonicalId,
        ...(canonicalIndex === undefined ? {} : { canonicalIndex }),
    };
}

export function reduceTurnRuntime(
    state: TurnRuntimeState,
    event: TurnRuntimeEvent,
): TurnReduction {
    if (event.turnGeneration < state.generation) {
        return unchanged(state, 'older-generation');
    }
    if (event.type === 'turn-started') {
        if (event.turnGeneration <= state.generation) {
            return unchanged(state, 'duplicate-start');
        }
        return applied({
            sessionId: state.sessionId,
            sessionEpoch: event.sessionEpoch,
            generation: event.turnGeneration,
            phase: 'submitted',
            userEntityId: event.payload.userEntityId,
            canonicalUserId: event.payload.canonicalUserId || null,
            assistant: {
                entityId: event.payload.assistantEntityId,
                ...(event.payload.temporaryAssistantId
                    ? { temporaryId: event.payload.temporaryAssistantId }
                    : {}),
            },
            assistantText: '',
            statusText: '',
            terminalReason: null,
        });
    }
    if (event.turnGeneration > state.generation) {
        return unchanged(state, 'future-generation-without-start');
    }
    if (isTerminal(state)) {
        return unchanged(state, 'terminal');
    }

    switch (event.type) {
        case 'assistant-chunk':
            return applied({
                ...state,
                phase: 'streaming',
                assistantText: `${state.assistantText}${event.payload.text}`,
                statusText: '',
            });
        case 'assistant-status':
            return applied({
                ...state,
                phase: state.phase === 'submitted' ? 'streaming' : state.phase,
                statusText: event.payload.text,
            });
        case 'assistant-temporary-bound':
            if (!state.assistant) {
                return unchanged(state, 'invalid-canonical-id');
            }
            if (state.assistant.canonicalId) {
                return unchanged(state, 'canonical-already-bound');
            }
            return applied({
                ...state,
                assistant: {
                    ...state.assistant,
                    temporaryId: event.payload.temporaryId,
                },
            });
        case 'assistant-canonicalized':
            if (!state.assistant || !isCanonicalMessageId(event.payload.canonicalId)) {
                return unchanged(state, 'invalid-canonical-id');
            }
            return applied({
                ...state,
                assistant: bindCanonicalAssistant(
                    state.assistant,
                    event.payload.canonicalId,
                    event.payload.canonicalIndex,
                ),
            });
        case 'turn-waiting':
            return applied({ ...state, phase: 'waiting' });
        case 'turn-streaming':
            return applied({ ...state, phase: 'streaming' });
        case 'turn-finalizing':
            return applied({ ...state, phase: 'finalizing' });
        case 'turn-finalized':
            if (!state.assistant || !isCanonicalMessageId(event.payload.canonicalId)) {
                return unchanged(state, 'invalid-canonical-id');
            }
            return applied({
                ...state,
                phase: 'finalized',
                assistant: bindCanonicalAssistant(
                    state.assistant,
                    event.payload.canonicalId,
                    event.payload.canonicalIndex,
                ),
                assistantText: event.payload.finalText,
                statusText: '',
                terminalReason: null,
            });
        case 'turn-failed':
            return applied({
                ...state,
                phase: 'failed',
                statusText: '',
                terminalReason: event.payload.reason,
            });
        case 'turn-cancelled':
            return applied({
                ...state,
                phase: 'cancelled',
                statusText: '',
                terminalReason: event.payload.reason,
            });
    }
}
