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

function isContinuationTurnOwner(
    source: OwnershipSource,
    ownerMsgId: string | null | undefined
): boolean {
    if (!ownerMsgId || !Array.isArray(source?.entries)) return false;
    return source.entries.some((entry) => {
        const entryOwner = entry.finalAssistantMsgId || entry.assistantMsgId;
        return entryOwner === ownerMsgId && typeof entry.turnKey === 'string' && entry.turnKey.startsWith('cont:');
    });
}

export function resolveSessionOwnership(
    source: OwnershipSource,
    fallbackOwnerMsgId: string | null
): ResolvedSessionOwnership {
    const continuation = source?.continuation;
    const currentOwnerMsgId = continuation?.currentOwnerMsgId ?? fallbackOwnerMsgId ?? null;
    if (!isContinuationTurnOwner(source, currentOwnerMsgId)) {
        return {
            currentOwnerMsgId: fallbackOwnerMsgId ?? currentOwnerMsgId ?? null,
            predecessorOwnerMsgId: null,
        };
    }
    return {
        currentOwnerMsgId,
        predecessorOwnerMsgId: continuation?.predecessorOwnerMsgId ?? null,
    };
}

export function resolveCurrentOwnerMsgId(
    source: OwnershipSource,
    fallbackOwnerMsgId: string | null
): string | null {
    return resolveSessionOwnership(source, fallbackOwnerMsgId).currentOwnerMsgId;
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
    const predecessorOwnerMsgId = source?.continuation?.predecessorOwnerMsgId;
    return fallbackMessageId === predecessorOwnerMsgId
        ? currentOwnerMsgId
        : fallbackMessageId;
}

export function resolvePredecessorOwnerMsgId(source: OwnershipSource): string | null {
    return resolveSessionOwnership(source, null).predecessorOwnerMsgId;
}
