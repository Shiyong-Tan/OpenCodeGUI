export type SessionEnvelope<
    TType extends string = string,
    TPayload = unknown,
> = Readonly<{
    type: TType;
    sessionId: string;
    sessionEpoch: number;
    sequence: number;
    turnGeneration?: number;
    commandId?: string;
    payload: TPayload;
}>;

export type SessionClock = Readonly<{
    sessionEpoch: number;
    sequence: number;
}>;

export type EnvelopeValidationOptions = Readonly<{
    requireTurnGeneration?: boolean;
}>;

export type EnvelopeValidationResult =
    | Readonly<{ ok: true; envelope: SessionEnvelope }>
    | Readonly<{ ok: false; reason: string }>;

export type EnvelopeAcceptance =
    | Readonly<{ accepted: true; reason: 'first' | 'new-epoch' | 'next-sequence'; clock: SessionClock }>
    | Readonly<{ accepted: false; reason: 'older-epoch' | 'duplicate-or-stale-sequence'; clock: SessionClock | null }>;

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

export function validateSessionEnvelope(
    value: unknown,
    options: EnvelopeValidationOptions = {},
): EnvelopeValidationResult {
    if (!value || typeof value !== 'object') {
        return { ok: false, reason: 'not-an-object' };
    }
    const candidate = value as Record<string, unknown>;
    if (!isNonEmptyString(candidate.type)) {
        return { ok: false, reason: 'missing-type' };
    }
    if (!isNonEmptyString(candidate.sessionId)) {
        return { ok: false, reason: 'missing-session-id' };
    }
    if (!isPositiveSafeInteger(candidate.sessionEpoch)) {
        return { ok: false, reason: 'invalid-session-epoch' };
    }
    if (!isPositiveSafeInteger(candidate.sequence)) {
        return { ok: false, reason: 'invalid-sequence' };
    }
    if (candidate.turnGeneration !== undefined && !isPositiveSafeInteger(candidate.turnGeneration)) {
        return { ok: false, reason: 'invalid-turn-generation' };
    }
    if (options.requireTurnGeneration === true && !isPositiveSafeInteger(candidate.turnGeneration)) {
        return { ok: false, reason: 'missing-turn-generation' };
    }
    if (candidate.commandId !== undefined && !isNonEmptyString(candidate.commandId)) {
        return { ok: false, reason: 'invalid-command-id' };
    }
    if (!Object.prototype.hasOwnProperty.call(candidate, 'payload')) {
        return { ok: false, reason: 'missing-payload' };
    }
    return {
        ok: true,
        envelope: {
            type: candidate.type,
            sessionId: candidate.sessionId,
            sessionEpoch: candidate.sessionEpoch,
            sequence: candidate.sequence,
            ...(candidate.turnGeneration === undefined ? {} : { turnGeneration: candidate.turnGeneration }),
            ...(candidate.commandId === undefined ? {} : { commandId: candidate.commandId }),
            payload: candidate.payload,
        },
    };
}

export function decideEnvelopeAcceptance(
    current: SessionClock | null | undefined,
    envelope: Pick<SessionEnvelope, 'sessionEpoch' | 'sequence'>,
): EnvelopeAcceptance {
    if (!current) {
        return {
            accepted: true,
            reason: 'first',
            clock: { sessionEpoch: envelope.sessionEpoch, sequence: envelope.sequence },
        };
    }
    if (envelope.sessionEpoch < current.sessionEpoch) {
        return { accepted: false, reason: 'older-epoch', clock: current };
    }
    if (envelope.sessionEpoch > current.sessionEpoch) {
        return {
            accepted: true,
            reason: 'new-epoch',
            clock: { sessionEpoch: envelope.sessionEpoch, sequence: envelope.sequence },
        };
    }
    if (envelope.sequence <= current.sequence) {
        return { accepted: false, reason: 'duplicate-or-stale-sequence', clock: current };
    }
    return {
        accepted: true,
        reason: 'next-sequence',
        clock: { sessionEpoch: envelope.sessionEpoch, sequence: envelope.sequence },
    };
}
