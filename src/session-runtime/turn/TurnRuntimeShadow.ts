import type { ChatEvent } from '../../OpenCodeClient';
import { SessionRegistry } from '../SessionRegistry';
import { createTurnRuntimeState, reduceTurnRuntime } from './turn-reducer';
import type { TurnRuntimeEvent, TurnRuntimeState } from './types';

export type TurnShadowObservation =
    | Readonly<{ observed: false; reason: 'missing-session-id' | 'unsupported-event' }>
    | Readonly<{
        observed: true;
        sessionId: string;
        sourceType: ChatEvent['type'];
        appliedTypes: readonly TurnRuntimeEvent['type'][];
        state: TurnRuntimeState;
        warnings: readonly string[];
    }>;

type SessionShadowClock = {
    epoch: number;
    sequence: number;
    generation: number;
};

function isTerminal(state: TurnRuntimeState): boolean {
    return state.phase === 'finalized'
        || state.phase === 'failed'
        || state.phase === 'cancelled';
}

function isCanonicalMessageId(value: unknown): value is string {
    return typeof value === 'string' && value.startsWith('msg_');
}

/**
 * Diagnostic adapter for the incremental migration. It deliberately has no
 * rendering, persistence, sending, or legacy-state mutation capability.
 */
export class TurnRuntimeShadow {
    private readonly clocks = new Map<string, SessionShadowClock>();
    private readonly registry = new SessionRegistry<TurnRuntimeState, TurnRuntimeEvent>({
        createInitialState: createTurnRuntimeState,
        reduce: (state, event) => ({ state: reduceTurnRuntime(state, event).state }),
    });

    public async observe(event: ChatEvent): Promise<TurnShadowObservation> {
        const sessionId = event.sessionId;
        if (!sessionId) {
            return { observed: false, reason: 'missing-session-id' };
        }

        const actor = this.registry.getOrCreate(sessionId);
        const before = actor.getSnapshot();
        const events: TurnRuntimeEvent[] = [];
        const warnings: string[] = [];

        switch (event.type) {
            case 'turnInFlight':
                if (event.inFlight === true) {
                    this.ensureStarted(sessionId, before, event, events, true);
                    events.push(this.envelope(sessionId, 'turn-streaming', {}));
                    this.appendCanonicalBinding(sessionId, event.assistantMsgId || event.ownerMsgId, event.messageIndex, events);
                } else if (before.phase !== 'idle' && !isTerminal(before)) {
                    events.push(this.envelope(sessionId, 'turn-finalizing', {}));
                }
                break;
            case 'assistantMessageMeta':
                this.ensureStarted(sessionId, before, event, events);
                if (event.tmpKey) {
                    events.push(this.envelope(sessionId, 'assistant-temporary-bound', {
                        temporaryId: event.tmpKey,
                    }));
                }
                this.appendCanonicalBinding(
                    sessionId,
                    event.assistantMsgId || event.messageId,
                    event.messageIndex,
                    events,
                );
                if (event.lastText) {
                    events.push(event.isStatusUpdate
                        ? this.envelope(sessionId, 'assistant-status', { text: event.lastText })
                        : this.envelope(sessionId, 'assistant-chunk', { text: event.lastText }));
                }
                break;
            case 'text':
                if (!event.text) break;
                this.ensureStarted(sessionId, before, event, events);
                events.push(this.envelope(sessionId, 'assistant-chunk', { text: event.text }));
                break;
            case 'turnResolved': {
                this.ensureStarted(sessionId, before, event, events);
                const canonicalId = isCanonicalMessageId(event.assistantMsgId)
                    ? event.assistantMsgId
                    : before.assistant?.canonicalId;
                if (!canonicalId) {
                    warnings.push('turn-resolved-without-canonical-assistant');
                    events.push(this.envelope(sessionId, 'turn-finalizing', {}));
                } else {
                    events.push(this.envelope(sessionId, 'turn-finalized', {
                        canonicalId,
                        ...(event.messageIndex === undefined ? {} : { canonicalIndex: event.messageIndex }),
                        finalText: event.lastText ?? before.assistantText,
                    }));
                }
                break;
            }
            case 'error':
                if (before.phase !== 'idle' && !isTerminal(before)) {
                    events.push(this.envelope(sessionId, 'turn-failed', {
                        reason: event.text || 'error',
                    }));
                }
                break;
            case 'autoResumeHardStop':
                if (before.phase !== 'idle' && !isTerminal(before)) {
                    events.push(this.envelope(sessionId, 'turn-failed', {
                        reason: event.text || 'auto-resume-hard-stop',
                    }));
                }
                break;
            default:
                return { observed: false, reason: 'unsupported-event' };
        }

        const state = await this.dispatchAll(events, sessionId);
        return {
            observed: true,
            sessionId,
            sourceType: event.type,
            appliedTypes: events.map((item) => item.type),
            state,
            warnings,
        };
    }

    public getSnapshot(sessionId: string): TurnRuntimeState | undefined {
        return this.registry.get(sessionId)?.getSnapshot();
    }

    public resetSession(sessionId: string): void {
        const current = this.clocks.get(sessionId) || { epoch: 1, sequence: 0, generation: 0 };
        this.clocks.set(sessionId, {
            epoch: current.epoch + 1,
            sequence: 0,
            generation: 0,
        });
    }

    public dispose(): void {
        this.registry.dispose();
        this.clocks.clear();
    }

    private ensureStarted(
        sessionId: string,
        state: TurnRuntimeState,
        source: ChatEvent,
        target: TurnRuntimeEvent[],
        restartTerminal = false,
    ): void {
        const clock = this.getClock(sessionId);
        const epochChanged = state.sessionEpoch !== clock.epoch;
        if (!epochChanged && state.phase !== 'idle' && !isTerminal(state)) return;
        if (!epochChanged && isTerminal(state) && !restartTerminal) return;
        clock.generation += 1;
        target.push(this.envelope(sessionId, 'turn-started', {
            userEntityId: `turn:${sessionId}:${clock.generation}:user`,
            assistantEntityId: `turn:${sessionId}:${clock.generation}:assistant`,
            ...(source.tmpKey ? { temporaryAssistantId: source.tmpKey } : {}),
        }));
    }

    private appendCanonicalBinding(
        sessionId: string,
        messageId: string | undefined,
        messageIndex: number | undefined,
        target: TurnRuntimeEvent[],
    ): void {
        if (!isCanonicalMessageId(messageId)) return;
        target.push(this.envelope(sessionId, 'assistant-canonicalized', {
            canonicalId: messageId,
            ...(messageIndex === undefined ? {} : { canonicalIndex: messageIndex }),
        }));
    }

    private envelope<T extends TurnRuntimeEvent['type']>(
        sessionId: string,
        type: T,
        payload: Extract<TurnRuntimeEvent, { type: T }>['payload'],
    ): Extract<TurnRuntimeEvent, { type: T }> {
        const clock = this.getClock(sessionId);
        clock.sequence += 1;
        return {
            type,
            sessionId,
            sessionEpoch: clock.epoch,
            sequence: clock.sequence,
            turnGeneration: clock.generation,
            payload,
        } as Extract<TurnRuntimeEvent, { type: T }>;
    }

    private getClock(sessionId: string): SessionShadowClock {
        let clock = this.clocks.get(sessionId);
        if (!clock) {
            clock = { epoch: 1, sequence: 0, generation: 0 };
            this.clocks.set(sessionId, clock);
        }
        return clock;
    }

    private async dispatchAll(
        events: readonly TurnRuntimeEvent[],
        fallbackSessionId?: string,
    ): Promise<TurnRuntimeState> {
        for (const event of events) {
            await this.registry.route(event);
        }
        const sessionId = events[events.length - 1]?.sessionId || fallbackSessionId;
        if (!sessionId) {
            throw new Error('TurnRuntimeShadow requires a session to read state');
        }
        return this.registry.getOrCreate(sessionId).getSnapshot();
    }
}

export type TurnShadowLegacyProbe = Readonly<{
    inFlight: boolean;
    assistantId?: string;
    temporaryAssistantId?: string;
    bufferedText?: string;
}>;

export type TurnShadowDivergence = Readonly<{
    field: 'inFlight' | 'assistantId' | 'temporaryAssistantId' | 'bufferedText';
    shadow: string | boolean | undefined;
    legacy: string | boolean | undefined;
}>;

export function compareTurnShadowToLegacy(
    state: TurnRuntimeState,
    legacy: TurnShadowLegacyProbe,
): readonly TurnShadowDivergence[] {
    const shadowInFlight = state.phase !== 'idle' && !isTerminal(state);
    const checks: readonly [
        TurnShadowDivergence['field'],
        string | boolean | undefined,
        string | boolean | undefined,
    ][] = [
        ['inFlight', shadowInFlight, legacy.inFlight],
        ['assistantId', state.assistant?.canonicalId, legacy.assistantId],
        [
            'temporaryAssistantId',
            state.assistant?.canonicalId ? undefined : state.assistant?.temporaryId,
            state.assistant?.canonicalId ? undefined : legacy.temporaryAssistantId,
        ],
        ['bufferedText', state.assistantText || undefined, legacy.bufferedText || undefined],
    ];
    return checks
        .filter(([, shadow, current]) => shadow !== current)
        .map(([field, shadow, current]) => ({ field, shadow, legacy: current }));
}
