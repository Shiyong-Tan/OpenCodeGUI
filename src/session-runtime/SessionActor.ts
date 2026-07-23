import {
    decideEnvelopeAcceptance,
    type EnvelopeAcceptance,
    type SessionClock,
    type SessionEnvelope,
} from './protocol';

export type SessionTransition<TState, TEffect> = Readonly<{
    state: TState;
    effects?: readonly TEffect[];
}>;

export type SessionActorEffectContext = Readonly<{
    sessionId: string;
    sessionEpoch: number;
    sequence: number;
}>;

export type SessionActorDispatchResult =
    | Readonly<{
        accepted: true;
        reason: Extract<EnvelopeAcceptance, { accepted: true }>['reason'];
        clock: SessionClock;
    }>
    | Readonly<{
        accepted: false;
        reason: Extract<EnvelopeAcceptance, { accepted: false }>['reason'] | 'session-mismatch' | 'disposed';
        clock: SessionClock | null;
    }>;

export type SessionActorOptions<
    TState,
    TEvent extends SessionEnvelope,
    TEffect,
> = Readonly<{
    sessionId: string;
    createInitialState(sessionId: string, sessionEpoch: number): TState;
    reduce(state: TState, event: TEvent): SessionTransition<TState, TEffect>;
    runEffect?(effect: TEffect, context: SessionActorEffectContext): Promise<void> | void;
    onListenerError?(error: unknown): void;
}>;

export class SessionActor<
    TState,
    TEvent extends SessionEnvelope,
    TEffect = never,
> {
    public readonly sessionId: string;
    private state: TState;
    private clock: SessionClock | null = null;
    private queue: Promise<void> = Promise.resolve();
    private readonly listeners = new Set<(state: TState) => void>();
    private disposed = false;

    constructor(private readonly options: SessionActorOptions<TState, TEvent, TEffect>) {
        if (!options.sessionId) throw new Error('SessionActor requires a sessionId');
        this.sessionId = options.sessionId;
        this.state = options.createInitialState(options.sessionId, 1);
    }

    public getSnapshot(): TState {
        return this.state;
    }

    public getClock(): SessionClock | null {
        return this.clock;
    }

    public subscribe(listener: (state: TState) => void): () => void {
        if (this.disposed) throw new Error(`SessionActor ${this.sessionId} is disposed`);
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    public dispatch(event: TEvent): Promise<SessionActorDispatchResult> {
        const operation = this.queue.then(() => this.apply(event));
        this.queue = operation.then(
            () => undefined,
            () => undefined,
        );
        return operation;
    }

    public dispose(): void {
        this.disposed = true;
        this.listeners.clear();
    }

    private async apply(event: TEvent): Promise<SessionActorDispatchResult> {
        if (this.disposed) {
            return { accepted: false, reason: 'disposed', clock: this.clock };
        }
        if (event.sessionId !== this.sessionId) {
            return { accepted: false, reason: 'session-mismatch', clock: this.clock };
        }
        const acceptance = decideEnvelopeAcceptance(this.clock, event);
        if (!acceptance.accepted) return acceptance;

        const baseState = acceptance.reason === 'new-epoch'
            ? this.options.createInitialState(this.sessionId, event.sessionEpoch)
            : this.state;
        const transition = this.options.reduce(baseState, event);
        this.state = transition.state;
        this.clock = acceptance.clock;
        this.notify();

        if (this.options.runEffect) {
            const context: SessionActorEffectContext = {
                sessionId: this.sessionId,
                sessionEpoch: event.sessionEpoch,
                sequence: event.sequence,
            };
            for (const effect of transition.effects || []) {
                await this.options.runEffect(effect, context);
            }
        }

        return acceptance;
    }

    private notify(): void {
        for (const listener of this.listeners) {
            try {
                listener(this.state);
            } catch (error) {
                this.options.onListenerError?.(error);
            }
        }
    }
}
