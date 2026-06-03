import * as fs from 'fs';
import * as path from 'path';
import { ContinuationHandoffMetadata, ContinuationLifecycleState, PostFinalWatchEntry, SessionEntry, SessionMap } from './types';

type Logger = (message: string) => void;

const writeJsonAtomic = async (filePath: string, data: unknown): Promise<void> => {
    const tmpPath = `${filePath}.tmp`;
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    try {
        await fs.promises.unlink(filePath);
    } catch {
        // ignore
    }
    await fs.promises.rename(tmpPath, filePath);
};

const createEmptySessionMap = (sessionId: string, repoId: string): SessionMap => ({
    schemaVersion: 1,
    sessionId,
    repoId,
    baselineCommit: undefined,
    currentBaseCommit: undefined,
    entries: [],
    tmpToCommit: {},
    tmpToBaseCommit: {},
    msgToCommit: {},
    msgToBaseCommit: {}
});

const normalizePostFinalWatchEntries = (entries: unknown): PostFinalWatchEntry[] => {
    if (!Array.isArray(entries)) return [];
    return entries
        .filter((entry): entry is PostFinalWatchEntry => Boolean(
            entry
            && typeof entry === 'object'
            && typeof (entry as PostFinalWatchEntry).filePath === 'string'
            && typeof (entry as PostFinalWatchEntry).observedAt === 'number'
            && Number.isFinite((entry as PostFinalWatchEntry).observedAt)
            && typeof (entry as PostFinalWatchEntry).ownerMsgId === 'string'
        ))
        .map((entry) => ({
            filePath: entry.filePath,
            observedAt: entry.observedAt,
            ownerMsgId: entry.ownerMsgId
        }));
};

const normalizeContinuation = (continuation: unknown): ContinuationHandoffMetadata | undefined => {
    if (!continuation || typeof continuation !== 'object') return undefined;
    const candidate = continuation as Partial<ContinuationHandoffMetadata> & { priorOwnerMsgId?: string | null };
    if (typeof candidate.currentOwnerMsgId !== 'string') return undefined;

    const predecessorOwnerMsgId = typeof candidate.predecessorOwnerMsgId === 'string'
        ? candidate.predecessorOwnerMsgId
        : typeof candidate.priorOwnerMsgId === 'string'
            ? candidate.priorOwnerMsgId
            : null;

    return {
        chainId: typeof candidate.chainId === 'string' ? candidate.chainId : undefined,
        currentOwnerMsgId: candidate.currentOwnerMsgId,
        predecessorOwnerMsgId,
        continuationSequence: typeof candidate.continuationSequence === 'number' && Number.isFinite(candidate.continuationSequence)
            ? candidate.continuationSequence
            : 1,
        lifecycleState: candidate.lifecycleState === 'watching' || candidate.lifecycleState === 'retry-ready'
            ? candidate.lifecycleState
            : 'idle',
        postFinalWatchEntries: normalizePostFinalWatchEntries(candidate.postFinalWatchEntries)
    };
};

const normalizeSessionMap = (sessionId: string, repoId: string, parsed: Partial<SessionMap>): SessionMap => {
    const fallback = createEmptySessionMap(sessionId, repoId);
    return {
        ...fallback,
        ...parsed,
        sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : sessionId,
        repoId: typeof parsed.repoId === 'string' ? parsed.repoId : repoId,
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
        tmpToCommit: parsed.tmpToCommit || {},
        tmpToBaseCommit: parsed.tmpToBaseCommit || {},
        msgToCommit: parsed.msgToCommit || {},
        msgToBaseCommit: parsed.msgToBaseCommit || {},
        continuation: normalizeContinuation(parsed.continuation)
    };
};

const mergeWatchEntriesForFinalOwner = (
    existingEntries: PostFinalWatchEntry[] | undefined,
    touchedFiles: string[],
    finalOwnerMsgId: string
): PostFinalWatchEntry[] => {
    const merged = new Map<string, PostFinalWatchEntry>();
    for (const entry of Array.isArray(existingEntries) ? existingEntries : []) {
        if (!entry?.filePath) continue;
        merged.set(entry.filePath, {
            filePath: entry.filePath,
            observedAt: entry.observedAt,
            ownerMsgId: finalOwnerMsgId
        });
    }
    for (const filePath of Array.isArray(touchedFiles) ? touchedFiles : []) {
        if (typeof filePath !== 'string' || !filePath) continue;
        const existing = merged.get(filePath);
        merged.set(filePath, {
            filePath,
            observedAt: existing?.observedAt ?? Date.now(),
            ownerMsgId: finalOwnerMsgId
        });
    }
    return Array.from(merged.values()).sort((a, b) => a.filePath.localeCompare(b.filePath));
};

type UpsertContinuationStateInput = {
    ownerMsgId: string;
    lifecycleState: ContinuationLifecycleState;
    watchedFiles?: string[];
    chainId?: string;
    predecessorOwnerMsgId?: string | null;
    continuationSequence?: number;
};

export class GitSessionMapStore {
    private readonly baseDir: string;
    private readonly logger: Logger;

    constructor(workspaceRoot: string, logger: Logger) {
        this.baseDir = path.join(workspaceRoot, '.opencode', 'git', 'sessions');
        this.logger = logger;
    }

    private getSessionDir(sessionId: string): string {
        return path.join(this.baseDir, sessionId);
    }

    private getMapPath(sessionId: string): string {
        return path.join(this.getSessionDir(sessionId), 'map.json');
    }

    public async loadSessionMap(sessionId: string, repoId: string): Promise<SessionMap> {
        const mapPath = this.getMapPath(sessionId);
        if (!fs.existsSync(mapPath)) {
            return createEmptySessionMap(sessionId, repoId);
        }
        try {
            const raw = await fs.promises.readFile(mapPath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (parsed?.schemaVersion !== 1) {
                return createEmptySessionMap(sessionId, repoId);
            }
            return normalizeSessionMap(sessionId, repoId, parsed as Partial<SessionMap>);
        } catch {
            return createEmptySessionMap(sessionId, repoId);
        }
    }

    public async saveSessionMap(sessionId: string, map: SessionMap): Promise<void> {
        const mapPath = this.getMapPath(sessionId);
        await writeJsonAtomic(mapPath, map);
        this.logger(`mapWrite | sessionId=${sessionId} entries=${map.entries.length}`);
    }

    public appendEntry(map: SessionMap, entry: SessionEntry): SessionMap {
        return {
            ...map,
            entries: [...map.entries, entry]
        };
    }

    public upsertContinuationState(map: SessionMap, input: UpsertContinuationStateInput): SessionMap {
        const ownerMsgId = typeof input.ownerMsgId === 'string' ? input.ownerMsgId : '';
        if (!ownerMsgId) return map;
        const existing = map.continuation;
        const existingOwnerMsgId = existing?.currentOwnerMsgId ?? null;
        const ownerChanged = Boolean(existingOwnerMsgId && existingOwnerMsgId !== ownerMsgId);
        const predecessorOwnerMsgId = input.predecessorOwnerMsgId !== undefined
            ? input.predecessorOwnerMsgId
            : ownerChanged
                ? existingOwnerMsgId
                : existing?.predecessorOwnerMsgId ?? null;
        const continuationSequence = typeof input.continuationSequence === 'number' && Number.isFinite(input.continuationSequence)
            ? input.continuationSequence
            : ownerChanged
                ? (existing?.continuationSequence ?? 0) + 1
                : existing?.continuationSequence ?? 1;
        return {
            ...map,
            continuation: {
                chainId: input.chainId ?? existing?.chainId,
                currentOwnerMsgId: ownerMsgId,
                predecessorOwnerMsgId,
                continuationSequence,
                lifecycleState: input.lifecycleState,
                postFinalWatchEntries: mergeWatchEntriesForFinalOwner(
                    existing?.postFinalWatchEntries,
                    Array.isArray(input.watchedFiles) ? input.watchedFiles : [],
                    ownerMsgId
                )
            }
        };
    }

    public bindFinalMsg(map: SessionMap, tmpKey: string, finalMsgId: string): SessionMap {
        const commitHash = map.tmpToCommit[tmpKey];
        if (!commitHash) return map;
        const baseCommit = map.tmpToBaseCommit?.[tmpKey];
        const boundEntry = map.entries.find((entry) => entry.tmpKey === tmpKey && entry.commitHash === commitHash);
        const isContinuationTurn = typeof boundEntry?.turnKey === 'string' && boundEntry.turnKey.startsWith('cont:');
        const updatedEntries = map.entries.map((entry) => {
            if (entry.tmpKey === tmpKey && entry.commitHash === commitHash) {
                return { ...entry, finalAssistantMsgId: finalMsgId };
            }
            return entry;
        });
        const touchedFiles = updatedEntries
            .filter((entry) => entry.commitHash === commitHash)
            .flatMap((entry) => Array.isArray(entry.touchedFiles) ? entry.touchedFiles : []);
        const continuation = map.continuation;
        const mapWithContinuation = this.upsertContinuationState({
            ...map,
            entries: updatedEntries
        }, {
            ownerMsgId: finalMsgId,
            lifecycleState: 'idle',
            watchedFiles: touchedFiles,
            chainId: continuation?.chainId,
            predecessorOwnerMsgId: isContinuationTurn
                ? (continuation
                    ? (continuation.currentOwnerMsgId === finalMsgId
                        ? continuation.predecessorOwnerMsgId
                        : (continuation.currentOwnerMsgId ?? continuation.predecessorOwnerMsgId ?? null))
                    : null)
                : null,
            continuationSequence: isContinuationTurn
                ? (continuation
                    ? (continuation.currentOwnerMsgId === finalMsgId
                        ? continuation.continuationSequence
                        : continuation.continuationSequence + 1)
                    : 1)
                : (continuation?.continuationSequence ?? 1),
        });
        return {
            ...mapWithContinuation,
            msgToCommit: {
                ...map.msgToCommit,
                [finalMsgId]: commitHash
            },
            msgToBaseCommit: baseCommit
                ? {
                    ...(map.msgToBaseCommit || {}),
                    [finalMsgId]: baseCommit
                }
                : (map.msgToBaseCommit || {}),
            entries: updatedEntries
        };
    }

    public bindMessageIdsToCommit(map: SessionMap, messageIds: string[], commitHash: string, baseCommit?: string): SessionMap {
        if (!commitHash || !Array.isArray(messageIds) || messageIds.length === 0) return map;
        const ids = Array.from(new Set(messageIds.filter((id) => typeof id === 'string' && id.startsWith('msg_'))));
        if (!ids.length) return map;
        const msgToCommit = { ...(map.msgToCommit || {}) };
        const msgToBaseCommit = { ...(map.msgToBaseCommit || {}) };
        for (const id of ids) {
            msgToCommit[id] = commitHash;
            if (baseCommit) {
                msgToBaseCommit[id] = baseCommit;
            }
        }
        return {
            ...map,
            msgToCommit,
            msgToBaseCommit
        };
    }
}
