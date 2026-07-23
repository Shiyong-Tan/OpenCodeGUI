export type AssistantUpgradeCandidateInput = Readonly<{
  canonicalId: string | null | undefined;
  explicitTemporaryId?: string | null;
  currentTurnAssistantId?: string | null;
  pending?: Readonly<{
    temporaryId?: string | null;
    canonicalId?: string | null;
  }> | null;
  awaitingFinalBind?: boolean;
  lastAssistantId?: string | null;
  hasMessage(id: string): boolean;
  isAssistantMessage(id: string): boolean;
}>;

export type AssistantUpgradeCandidateDecision =
  | Readonly<{
    accepted: false;
    reason: 'invalid-canonical-id' | 'no-owned-source';
    canonicalId?: string;
  }>
  | Readonly<{
    accepted: true;
    canonicalId: string;
    sourceId: string | null;
    source:
      | 'explicit-temporary'
      | 'matching-pending'
      | 'current-temporary'
      | 'already-canonical'
      | 'awaiting-final-assistant'
      | 'canonical-only';
  }>;

function isCanonicalId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('msg_');
}

function isTemporaryId(value: unknown): boolean {
  return typeof value === 'string'
    && (value.startsWith('tmp:') || value.startsWith('local-'));
}

function isPresentAssistant(
  value: string | null | undefined,
  input: AssistantUpgradeCandidateInput,
): value is string {
  if (!value) return false;
  return input.hasMessage(value) && input.isAssistantMessage(value);
}

/**
 * Selects only the source identity for the current turn. It never mutates the
 * timeline or relies on the visible session.
 */
export function selectAssistantUpgradeCandidate(
  input: AssistantUpgradeCandidateInput,
): AssistantUpgradeCandidateDecision {
  if (!isCanonicalId(input.canonicalId)) {
    return { accepted: false, reason: 'invalid-canonical-id' };
  }
  const canonicalId = input.canonicalId;

  if (
    isPresentAssistant(input.explicitTemporaryId, input)
    && isTemporaryId(input.explicitTemporaryId)
  ) {
    return {
      accepted: true,
      canonicalId,
      sourceId: input.explicitTemporaryId,
      source: 'explicit-temporary',
    };
  }

  if (
    input.pending?.canonicalId === canonicalId
    && isPresentAssistant(input.pending.temporaryId, input)
    && isTemporaryId(input.pending.temporaryId)
  ) {
    return {
      accepted: true,
      canonicalId,
      sourceId: input.pending.temporaryId,
      source: 'matching-pending',
    };
  }

  if (
    isPresentAssistant(input.currentTurnAssistantId, input)
    && isTemporaryId(input.currentTurnAssistantId)
  ) {
    return {
      accepted: true,
      canonicalId,
      sourceId: input.currentTurnAssistantId,
      source: 'current-temporary',
    };
  }

  if (input.currentTurnAssistantId === canonicalId) {
    return {
      accepted: true,
      canonicalId,
      sourceId: canonicalId,
      source: 'already-canonical',
    };
  }

  if (
    input.awaitingFinalBind === true
    && isPresentAssistant(input.lastAssistantId, input)
    && (
      isTemporaryId(input.lastAssistantId)
      || input.lastAssistantId === canonicalId
    )
  ) {
    return {
      accepted: true,
      canonicalId,
      sourceId: input.lastAssistantId,
      source: 'awaiting-final-assistant',
    };
  }

  if (input.currentTurnAssistantId == null && !input.pending && !input.awaitingFinalBind) {
    return {
      accepted: true,
      canonicalId,
      sourceId: null,
      source: 'canonical-only',
    };
  }

  return {
    accepted: false,
    reason: 'no-owned-source',
    canonicalId,
  };
}
