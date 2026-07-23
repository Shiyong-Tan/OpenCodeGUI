import { SessionActor, type SessionActorOptions, type SessionActorDispatchResult } from './SessionActor';
import type { SessionEnvelope } from './protocol';

export type SessionRegistryOptions<
    TState,
    TEvent extends SessionEnvelope,
    TEffect,
> = Omit<SessionActorOptions<TState, TEvent, TEffect>, 'sessionId'>;

export class SessionRegistry<
    TState,
    TEvent extends SessionEnvelope,
    TEffect = never,
> {
    private readonly actors = new Map<string, SessionActor<TState, TEvent, TEffect>>();
    private disposed = false;

    constructor(private readonly options: SessionRegistryOptions<TState, TEvent, TEffect>) {}

    public getOrCreate(sessionId: string): SessionActor<TState, TEvent, TEffect> {
        if (this.disposed) throw new Error('SessionRegistry is disposed');
        if (!sessionId) throw new Error('SessionRegistry requires a sessionId');
        const existing = this.actors.get(sessionId);
        if (existing) return existing;
        const actor = new SessionActor<TState, TEvent, TEffect>({
            ...this.options,
            sessionId,
        });
        this.actors.set(sessionId, actor);
        return actor;
    }

    public get(sessionId: string): SessionActor<TState, TEvent, TEffect> | undefined {
        return this.actors.get(sessionId);
    }

    public route(event: TEvent): Promise<SessionActorDispatchResult> {
        return this.getOrCreate(event.sessionId).dispatch(event);
    }

    public entries(): IterableIterator<[string, SessionActor<TState, TEvent, TEffect>]> {
        return this.actors.entries();
    }

    public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const actor of this.actors.values()) actor.dispose();
        this.actors.clear();
    }
}
