import { parseNotificationIdentity, type NotificationIdentity } from './notification-identity-protocol';

export interface SupervisorRound {
    roundId: string;
    sessionId: string;
    executionId: string;
    kind: 'independent' | 'existing-turn';
    startedAt: number;
    timingBasis: 'first-observed-activity';
    sources: NotificationIdentity[];
    assistantMessageIds: string[];
    final?: { assistantMessageId: string; observedAt: number };
}
interface Ledger { schemaVersion: 1; isolationId: string; sessionId: string; rounds: SupervisorRound[] }
export interface SupervisorRoundStorage {
    read(sessionId: string): Promise<unknown>;
    write(sessionId: string, value: unknown): Promise<void>;
}
export type ParentExecution = { kind: 'terminal' } | { kind: 'active'; executionId: string };
export type RoundObservation = { disposition: 'start' | 'join' | 'duplicate' | 'retired' | 'unresolved'; round: SupervisorRound };
const canonical = (value: unknown): value is string => typeof value === 'string' && /^msg_[A-Za-z0-9_-]{1,176}$/.test(value);
const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const fail = (): never => { throw new Error('Invalid supervisor round ledger'); };
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail();

/** Owns durable provenance, not the chat lifecycle or snapshots. Call mutations from
 * the existing session actor queue; pass its current execution after prior effects.
 * Only an already-classified real assistant activity may call observeActivity.
 */
export class SupervisorRoundStore {
    private readonly cache = new Map<string, Ledger>();
    constructor(private readonly isolationId: string, private readonly storage: SupervisorRoundStorage) {}

    private parse(value: unknown, sessionId: string): Ledger {
        if (value === undefined) return { schemaVersion: 1, isolationId: this.isolationId, sessionId, rounds: [] };
        const raw = record(value);
        if (raw.schemaVersion !== 1 || raw.isolationId !== this.isolationId || raw.sessionId !== sessionId || !Array.isArray(raw.rounds) || raw.rounds.length > 1024) fail();
        const notices = new Set<string>(), messages = new Set<string>(), executions = new Set<string>();
        const rounds = (raw.rounds as unknown[]).map(value => {
            const r = record(value);
            if (!canonical(r.roundId) || r.sessionId !== sessionId || typeof r.executionId !== 'string' || !/^[A-Za-z0-9_-]{1,180}$/.test(r.executionId)
                || (r.kind !== 'independent' && r.kind !== 'existing-turn') || !time(r.startedAt) || r.timingBasis !== 'first-observed-activity'
                || !Array.isArray(r.sources) || !r.sources.length || r.sources.length > 256 || !Array.isArray(r.assistantMessageIds)
                || !r.assistantMessageIds.length || r.assistantMessageIds.length > 1024 || executions.has(r.executionId)) fail();
            executions.add(r.executionId as string);
            const sources = (r.sources as unknown[]).map(source => {
                const identity = parseNotificationIdentity(source);
                if (identity.isolationId !== this.isolationId || identity.parentSessionId !== sessionId || notices.has(identity.notificationId)) fail();
                notices.add(identity.notificationId);
                return identity;
            });
            const assistantMessageIds = (r.assistantMessageIds as unknown[]).map(id => {
                if (!canonical(id) || messages.has(id)) fail();
                messages.add(id as string); return id as string;
            });
            if (assistantMessageIds[0] !== r.roundId) fail();
            let final: SupervisorRound['final'];
            if (r.final !== undefined) {
                const f = record(r.final);
                if (!canonical(f.assistantMessageId) || !assistantMessageIds.includes(f.assistantMessageId as string) || !time(f.observedAt) || (f.observedAt as number) < (r.startedAt as number)) fail();
                final = { assistantMessageId: f.assistantMessageId as string, observedAt: f.observedAt as number };
            }
            return { roundId: r.roundId as string, sessionId, executionId: r.executionId as string,
                kind: r.kind as SupervisorRound['kind'], startedAt: r.startedAt as number, timingBasis: 'first-observed-activity' as const,
                sources, assistantMessageIds, ...(final ? { final } : {}) };
        });
        return { schemaVersion: 1, isolationId: this.isolationId, sessionId, rounds };
    }
    private async load(sessionId: string): Promise<Ledger> {
        if (!/^ses_[A-Za-z0-9_-]{1,160}$/.test(sessionId)) fail();
        const cached = this.cache.get(sessionId);
        if (cached) return cached;
        const loaded = this.parse(await this.storage.read(sessionId), sessionId);
        this.cache.set(sessionId, loaded); return loaded;
    }
    private async persist(ledger: Ledger): Promise<void> {
        const validated = this.parse(ledger, ledger.sessionId);
        // Never publish an in-memory claim before durable storage accepts it.
        await this.storage.write(ledger.sessionId, structuredClone(validated));
        this.cache.set(ledger.sessionId, validated);
    }
    async list(sessionId: string): Promise<SupervisorRound[]> { return structuredClone((await this.load(sessionId)).rounds); }

    async observeActivity(input: { source: NotificationIdentity; assistantMessageId: string; observedAt: number; parent: ParentExecution }): Promise<RoundObservation> {
        const source = parseNotificationIdentity(input.source);
        if (source.isolationId !== this.isolationId || !canonical(input.assistantMessageId) || !time(input.observedAt)) fail();
        const ledger = structuredClone(await this.load(source.parentSessionId));
        const existingSource = ledger.rounds.find(r => r.sources.some(s => s.notificationId === source.notificationId));
        const existingMessage = ledger.rounds.find(r => r.assistantMessageIds.includes(input.assistantMessageId));
        if (existingSource) {
            const trusted = existingSource.sources.find(s => s.notificationId === source.notificationId)!;
            if (JSON.stringify(trusted) !== JSON.stringify(source)) fail();
        }
        if (existingMessage && existingSource && existingMessage.roundId !== existingSource.roundId) fail();
        let round = existingMessage || existingSource;
        // An unfinished durable record plus a terminal/unknown host after reload
        // is not proof that a new execution started. Require history reconciliation.
        if (round && !round.final && input.parent.kind === 'terminal') {
            return { disposition: 'unresolved', round: structuredClone(round) };
        }
        if (round && (round.final || input.parent.kind === 'terminal' || input.parent.executionId !== round.executionId)) {
            return { disposition: 'retired', round: structuredClone(round) };
        }
        if (existingMessage && existingSource) return { disposition: 'duplicate', round: structuredClone(existingMessage) };
        const parent = input.parent;
        if (!round && parent.kind === 'active') round = ledger.rounds.find(r => r.executionId === parent.executionId);
        if (round?.final) return { disposition: 'retired', round: structuredClone(round) };
        const disposition = round || input.parent.kind === 'active' ? 'join' : 'start';
        if (!round) {
            if (ledger.rounds.length >= 1024) throw new Error('Supervisor round capacity reached; reload cannot erase provenance');
            round = { roundId: input.assistantMessageId, sessionId: source.parentSessionId,
                executionId: input.parent.kind === 'active' ? input.parent.executionId : input.assistantMessageId,
                kind: input.parent.kind === 'active' ? 'existing-turn' : 'independent',
                startedAt: input.observedAt, timingBasis: 'first-observed-activity', sources: [], assistantMessageIds: [] };
            ledger.rounds.push(round);
        }
        if (!round.sources.some(s => s.notificationId === source.notificationId)) round.sources.push(source);
        if (!round.assistantMessageIds.includes(input.assistantMessageId)) round.assistantMessageIds.push(input.assistantMessageId);
        await this.persist(ledger);
        return { disposition, round: structuredClone(round) };
    }
    async finish(sessionId: string, executionId: string, assistantMessageId: string, observedAt: number): Promise<void> {
        const ledger = structuredClone(await this.load(sessionId));
        const round = ledger.rounds.find(r => r.executionId === executionId);
        if (!round) return;
        if (round.final) {
            if (round.final.assistantMessageId !== assistantMessageId) fail();
            return;
        }
        if (!round.assistantMessageIds.includes(assistantMessageId) || !time(observedAt) || observedAt < round.startedAt) fail();
        round.final = { assistantMessageId, observedAt };
        await this.persist(ledger);
    }
}
