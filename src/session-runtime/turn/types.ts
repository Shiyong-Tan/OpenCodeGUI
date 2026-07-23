import type { SessionEnvelope } from '../protocol';

export type TurnPhase =
    | 'idle'
    | 'submitted'
    | 'streaming'
    | 'waiting'
    | 'finalizing'
    | 'finalized'
    | 'failed'
    | 'cancelled';

export type AssistantBinding = Readonly<{
    entityId: string;
    temporaryId?: string;
    canonicalId?: string;
    canonicalIndex?: number;
}>;

export type TurnRuntimeState = Readonly<{
    sessionId: string;
    sessionEpoch: number;
    generation: number;
    phase: TurnPhase;
    userEntityId: string | null;
    canonicalUserId: string | null;
    assistant: AssistantBinding | null;
    assistantText: string;
    statusText: string;
    terminalReason: string | null;
}>;

type TurnEnvelope<TType extends string, TPayload> =
    SessionEnvelope<TType, TPayload>
    & Readonly<{ turnGeneration: number }>;

export type TurnRuntimeEvent =
    | TurnEnvelope<'turn-started', Readonly<{
        userEntityId: string;
        canonicalUserId?: string;
        assistantEntityId: string;
        temporaryAssistantId?: string;
    }>>
    | TurnEnvelope<'assistant-chunk', Readonly<{ text: string }>>
    | TurnEnvelope<'assistant-status', Readonly<{ text: string }>>
    | TurnEnvelope<'assistant-temporary-bound', Readonly<{ temporaryId: string }>>
    | TurnEnvelope<'assistant-canonicalized', Readonly<{
        canonicalId: string;
        canonicalIndex?: number;
    }>>
    | TurnEnvelope<'turn-waiting', Readonly<Record<string, never>>>
    | TurnEnvelope<'turn-streaming', Readonly<Record<string, never>>>
    | TurnEnvelope<'turn-finalizing', Readonly<Record<string, never>>>
    | TurnEnvelope<'turn-finalized', Readonly<{
        canonicalId: string;
        canonicalIndex?: number;
        finalText: string;
    }>>
    | TurnEnvelope<'turn-failed', Readonly<{ reason: string }>>
    | TurnEnvelope<'turn-cancelled', Readonly<{ reason: string }>>;

export type TurnReduction = Readonly<{
    state: TurnRuntimeState;
    changed: boolean;
    reason:
        | 'applied'
        | 'older-generation'
        | 'future-generation-without-start'
        | 'duplicate-start'
        | 'terminal'
        | 'canonical-already-bound'
        | 'invalid-canonical-id';
}>;
