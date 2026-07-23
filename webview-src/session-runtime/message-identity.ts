export type MessageIdentity = Readonly<{
  entityId: string;
  temporaryId?: string;
  canonicalId?: string;
}>;

type IdentityMessage = {
  id?: string;
  role?: string;
  meta?: Record<string, unknown>;
};

export function createMessageIdentityStore(
  options: Readonly<{ nextEntityId?(): string }> = {},
) {
  let sequence = 0;
  const nextEntityId = options.nextEntityId || (() => {
    sequence += 1;
    return `entity:${sequence}`;
  });

  function read(message: IdentityMessage | null | undefined): MessageIdentity | null {
    const identity = message?.meta?.identity;
    if (!identity || typeof identity !== 'object') return null;
    const value = identity as Record<string, unknown>;
    if (typeof value.entityId !== 'string' || !value.entityId) return null;
    return {
      entityId: value.entityId,
      ...(typeof value.temporaryId === 'string' ? { temporaryId: value.temporaryId } : {}),
      ...(typeof value.canonicalId === 'string' ? { canonicalId: value.canonicalId } : {}),
    };
  }

  function ensure(message: IdentityMessage): MessageIdentity {
    const existing = read(message);
    if (existing) return existing;
    const id = typeof message.id === 'string' ? message.id : '';
    const identity: MessageIdentity = {
      entityId: nextEntityId(),
      ...(id.startsWith('tmp:') || id.startsWith('local-') ? { temporaryId: id } : {}),
      ...(id.startsWith('msg_') ? { canonicalId: id } : {}),
    };
    message.meta = { ...(message.meta || {}), identity };
    return identity;
  }

  function bindCanonical(message: IdentityMessage, canonicalId: string): MessageIdentity {
    if (!canonicalId.startsWith('msg_')) {
      throw new Error('Canonical message identity must start with msg_');
    }
    const current = ensure(message);
    if (current.canonicalId && current.canonicalId !== canonicalId) {
      throw new Error(`Message entity ${current.entityId} is already bound to ${current.canonicalId}`);
    }
    const identity: MessageIdentity = {
      entityId: current.entityId,
      canonicalId,
    };
    message.meta = { ...(message.meta || {}), identity };
    return identity;
  }

  function sameEntity(
    left: IdentityMessage | null | undefined,
    right: IdentityMessage | null | undefined,
  ): boolean {
    const leftIdentity = read(left);
    const rightIdentity = read(right);
    return Boolean(
      leftIdentity
      && rightIdentity
      && leftIdentity.entityId === rightIdentity.entityId,
    );
  }

  return Object.freeze({
    read,
    ensure,
    bindCanonical,
    sameEntity,
  });
}
