import type { SessionMap } from './types';

export type ResolvedSessionOwnership = {
    currentOwnerMsgId: string | null;
    predecessorOwnerMsgId: string | null;
};

type OwnershipSource = {
    continuation?: SessionMap['continuation'];
    entries?: SessionMap['entries'];
    msgToCommit?: SessionMap['msgToCommit'];
} | null | undefined;

export function resolveSessionOwnership(
    source: OwnershipSource,
    fallbackOwnerMsgId: string | null
): ResolvedSessionOwnership {
    const continuation = source?.continuation;
    return {
        currentOwnerMsgId: continuation?.currentOwnerMsgId ?? fallbackOwnerMsgId ?? null,
        predecessorOwnerMsgId: continuation?.predecessorOwnerMsgId ?? null,
    };
}

export function resolveCurrentOwnerMsgId(
    source: OwnershipSource,
    fallbackOwnerMsgId: string | null
): string | null {
    return resolveSessionOwnership(source, fallbackOwnerMsgId).currentOwnerMsgId;
}

function collectSupersededOwnerMsgIds(source: OwnershipSource): Set<string> {
    const continuation = source?.continuation;
    const superseded = new Set<string>();
    if (!continuation) return superseded;

    if (continuation.predecessorOwnerMsgId) {
        superseded.add(continuation.predecessorOwnerMsgId);
    }
    const expectedCount = Math.max(0, Math.floor(continuation.continuationSequence) - 1);
    if (superseded.size >= expectedCount || !Array.isArray(source?.entries)) {
        return superseded;
    }

    for (let index = source.entries.length - 1; index >= 0 && superseded.size < expectedCount; index -= 1) {
        const entry = source.entries[index];
        const ownerMsgId = entry.finalAssistantMsgId || entry.assistantMsgId;
        if (!ownerMsgId || ownerMsgId === continuation.currentOwnerMsgId) continue;
        superseded.add(ownerMsgId);
    }
    return superseded;
}

export function resolveCurrentVisibleOwnerMsgId(
    source: OwnershipSource,
    fallbackMessageId: string | null
): string | null {
    if (!fallbackMessageId) return null;
    if (fallbackMessageId.startsWith('msg_user_') || fallbackMessageId.startsWith('msg_system_')) {
        return fallbackMessageId;
    }

    const { currentOwnerMsgId } = resolveSessionOwnership(source, fallbackMessageId);
    if (!currentOwnerMsgId || fallbackMessageId === currentOwnerMsgId) {
        return fallbackMessageId;
    }
    return collectSupersededOwnerMsgIds(source).has(fallbackMessageId)
        ? currentOwnerMsgId
        : fallbackMessageId;
}

export function resolvePredecessorOwnerMsgId(source: OwnershipSource): string | null {
    return resolveSessionOwnership(source, null).predecessorOwnerMsgId;
}
