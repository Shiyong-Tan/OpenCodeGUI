import type { ChatEvent } from '../../OpenCodeClient';
import { reduceTurnRuntime } from './turn-reducer';
import type { TurnRuntimeEvent, TurnRuntimeState } from './types';

export type ChatEventTurnReduction = Readonly<{
    state: TurnRuntimeState;
    appliedTypes: readonly TurnRuntimeEvent['type'][];
    warnings: readonly string[];
}>;

export type ChatEventTurnContext = Readonly<{
    sessionEpoch: number;
    sequence: number;
}>;

function isTerminal(state: TurnRuntimeState): boolean {
    return state.phase === 'finalized'
        || state.phase === 'failed'
        || state.phase === 'cancelled';
}

function isCanonicalMessageId(value: unknown): value is string {
    return typeof value === 'string' && value.startsWith('msg_');
}

export function reduceChatEventTurnRuntime(
    initialState: TurnRuntimeState,
    event: ChatEvent,
    context: ChatEventTurnContext,
): ChatEventTurnReduction {
    if (
        event.sessionId !== initialState.sessionId
        || event.displayTarget === 'parent'
        || event.displayTarget === 'agent-lane'
    ) {
        return { state: initialState, appliedTypes: [], warnings: [] };
    }

    let state = initialState;
    const appliedTypes: TurnRuntimeEvent['type'][] = [];
    const warnings: string[] = [];

    const apply = <T extends TurnRuntimeEvent['type']>(
        type: T,
        payload: Extract<TurnRuntimeEvent, { type: T }>['payload'],
    ): void => {
        const owned = {
            type,
            sessionId: state.sessionId,
            sessionEpoch: context.sessionEpoch,
            sequence: context.sequence,
            turnGeneration: state.generation,
            payload,
        } as Extract<TurnRuntimeEvent, { type: T }>;
        const reduction = reduceTurnRuntime(state, owned);
        state = reduction.state;
        if (reduction.changed) appliedTypes.push(type);
    };

    const ensureStarted = (restartTerminal = false): void => {
        if (state.phase !== 'idle' && (!isTerminal(state) || !restartTerminal)) return;
        const generation = state.generation + 1;
        const started = {
            type: 'turn-started',
            sessionId: state.sessionId,
            sessionEpoch: context.sessionEpoch,
            sequence: context.sequence,
            turnGeneration: generation,
            payload: {
                userEntityId: `turn:${state.sessionId}:${generation}:user`,
                assistantEntityId: `turn:${state.sessionId}:${generation}:assistant`,
                ...(event.tmpKey ? { temporaryAssistantId: event.tmpKey } : {}),
            },
        } as const;
        const reduction = reduceTurnRuntime(state, started);
        state = reduction.state;
        if (reduction.changed) appliedTypes.push('turn-started');
    };

    const bindCanonical = (
        messageId: string | undefined,
        messageIndex: number | undefined,
    ): void => {
        if (!isCanonicalMessageId(messageId)) return;
        apply('assistant-canonicalized', {
            canonicalId: messageId,
            ...(messageIndex === undefined ? {} : { canonicalIndex: messageIndex }),
        });
    };

    switch (event.type) {
        case 'turnInFlight':
            if (event.inFlight === true) {
                ensureStarted(true);
                apply('turn-streaming', {});
                bindCanonical(event.assistantMsgId || event.ownerMsgId, event.messageIndex);
            } else if (state.phase !== 'idle' && !isTerminal(state)) {
                apply('turn-finalizing', {});
            }
            break;
        case 'assistantMessageMeta':
            ensureStarted();
            if (event.tmpKey) {
                apply('assistant-temporary-bound', { temporaryId: event.tmpKey });
            }
            bindCanonical(event.assistantMsgId || event.messageId, event.messageIndex);
            if (event.lastText) {
                if (event.isStatusUpdate) {
                    apply('assistant-status', { text: event.lastText });
                } else {
                    apply('assistant-chunk', { text: event.lastText });
                }
            }
            break;
        case 'text':
            if (event.text) {
                ensureStarted();
                apply('assistant-chunk', { text: event.text });
            }
            break;
        case 'turnResolved': {
            ensureStarted();
            const canonicalId = isCanonicalMessageId(event.assistantMsgId)
                ? event.assistantMsgId
                : state.assistant?.canonicalId;
            if (!canonicalId) {
                warnings.push('turn-resolved-without-canonical-assistant');
                apply('turn-finalizing', {});
            } else {
                apply('turn-finalized', {
                    canonicalId,
                    ...(event.messageIndex === undefined ? {} : { canonicalIndex: event.messageIndex }),
                    finalText: event.lastText ?? state.assistantText,
                });
            }
            break;
        }
        case 'error':
            if (state.phase !== 'idle' && !isTerminal(state)) {
                apply('turn-failed', { reason: event.text || 'error' });
            }
            break;
        case 'autoResumeHardStop':
            if (state.phase !== 'idle' && !isTerminal(state)) {
                apply('turn-failed', { reason: event.text || 'auto-resume-hard-stop' });
            }
            break;
        default:
            break;
    }

    return { state, appliedTypes, warnings };
}
