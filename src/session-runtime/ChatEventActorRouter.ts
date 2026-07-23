import type { ChatEvent } from '../OpenCodeClient';
import { SessionRegistry } from './SessionRegistry';
import type { SessionEnvelope } from './protocol';
import { createTurnRuntimeState } from './turn/turn-reducer';
import { reduceChatEventTurnRuntime } from './turn/chat-event-turn-reducer';
import type { TurnRuntimeState } from './turn/types';

type ChatEventEnvelope = SessionEnvelope<
    'chat-event',
    Readonly<{ event: ChatEvent }>
>;

export type ChatEventActorState = Readonly<{
    sessionId: string;
    handledCount: number;
    turn: TurnRuntimeState;
}>;

export type ChatEventActorRouterOptions = Readonly<{
    handle(event: ChatEvent): Promise<void> | void;
    onError?(event: ChatEvent, error: unknown): void;
    onDrop?(event: ChatEvent, reason: 'missing-session-owner'): void;
}>;

function resolveActorOwner(event: ChatEvent): string | undefined {
    if (event.displayTarget === 'parent' && event.parentSessionId) {
        return event.parentSessionId;
    }
    return event.sessionId;
}

/**
 * Production execution boundary: one serialized queue per owning session,
 * while different sessions remain independently concurrent.
 */
export class ChatEventActorRouter {
    private readonly sequenceByOwner = new Map<string, number>();
    private readonly registry: SessionRegistry<
        ChatEventActorState,
        ChatEventEnvelope,
        ChatEvent
    >;
    private disposed = false;

    constructor(private readonly options: ChatEventActorRouterOptions) {
        this.registry = new SessionRegistry({
            createInitialState: (sessionId, sessionEpoch) => ({
                sessionId,
                handledCount: 0,
                turn: createTurnRuntimeState(sessionId, sessionEpoch),
            }),
            reduce: (state, envelope) => {
                const turn = reduceChatEventTurnRuntime(
                    state.turn,
                    envelope.payload.event,
                    {
                        sessionEpoch: envelope.sessionEpoch,
                        sequence: envelope.sequence,
                    },
                ).state;
                return {
                    state: {
                        sessionId: state.sessionId,
                        handledCount: state.handledCount + 1,
                        turn,
                    },
                    effects: [envelope.payload.event],
                };
            },
            runEffect: async (event) => {
                try {
                    await this.options.handle(event);
                } catch (error) {
                    this.options.onError?.(event, error);
                }
            },
        });
    }

    public async route(event: ChatEvent): Promise<void> {
        if (this.disposed) return;
        const ownerSessionId = resolveActorOwner(event);
        if (!ownerSessionId) {
            this.options.onDrop?.(event, 'missing-session-owner');
            return;
        }
        const sequence = (this.sequenceByOwner.get(ownerSessionId) || 0) + 1;
        this.sequenceByOwner.set(ownerSessionId, sequence);
        await this.registry.route({
            type: 'chat-event',
            sessionId: ownerSessionId,
            sessionEpoch: 1,
            sequence,
            payload: { event },
        });
    }

    public getHandledCount(sessionId: string): number {
        return this.registry.get(sessionId)?.getSnapshot().handledCount || 0;
    }

    public getSnapshot(sessionId: string): ChatEventActorState | undefined {
        return this.registry.get(sessionId)?.getSnapshot();
    }

    public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.registry.dispose();
        this.sequenceByOwner.clear();
    }
}
