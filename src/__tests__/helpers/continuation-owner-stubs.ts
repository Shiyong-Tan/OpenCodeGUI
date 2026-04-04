import type { ContinuationHandoffMetadata } from '../../undo/types';
import { resolveCurrentOwnerMsgId } from '../../undo/ownershipResolver';

export function resolveCurrentOwner(
    handoff: ContinuationHandoffMetadata | null
): string | null {
    return resolveCurrentOwnerMsgId({ continuation: handoff ?? undefined }, null);
}

export function resolveOwnerAfterReload(
    persistedHandoff: ContinuationHandoffMetadata | null
): string | null {
    return resolveCurrentOwnerMsgId({ continuation: persistedHandoff ?? undefined }, null);
}
