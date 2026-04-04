import type { ContinuationHandoffMetadata, PostFinalWatchEntry, SessionEntry, SessionMap } from '../../undo/types';

export type ContinuationChainState = {
    chainId: string;
    currentOwnerMsgId: string;
    predecessorOwnerMsgId: string | null;
    continuationSequence: number;
    chainMsgIds: string[];
    continuationInFlight: boolean;
    postFinalWatchEntries: PostFinalWatchEntry[];
};

let nextMsgCounter = 1;
let nextChainCounter = 1;

export function resetFactoryCounters(): void {
    nextMsgCounter = 1;
    nextChainCounter = 1;
}

export function makeMsgId(label?: string): string {
    const id = `msg_test_${String(nextMsgCounter++).padStart(4, '0')}`;
    return label ? `${id}_${label}` : id;
}

export function makeChainId(): string {
    return `chain_test_${String(nextChainCounter++).padStart(4, '0')}`;
}

export function makeCommitHash(seed?: string): string {
    const base = seed ?? String(Math.random());
    let hash = '';
    for (let i = 0; i < 40; i++) {
        hash += ((base.charCodeAt(i % base.length) + i) % 16).toString(16);
    }
    return hash;
}

export function makeHandoffMetadata(
    overrides: Partial<ContinuationHandoffMetadata> = {}
): ContinuationHandoffMetadata {
    const chainId = overrides.chainId ?? makeChainId();
    return {
        chainId,
        currentOwnerMsgId: overrides.currentOwnerMsgId ?? makeMsgId('owner'),
        predecessorOwnerMsgId: overrides.predecessorOwnerMsgId ?? null,
        continuationSequence: overrides.continuationSequence ?? 1,
        lifecycleState: overrides.lifecycleState ?? 'idle',
        postFinalWatchEntries: overrides.postFinalWatchEntries ?? [],
    };
}

export function makePostFinalWatchEntry(
    overrides: Partial<PostFinalWatchEntry> = {}
): PostFinalWatchEntry {
    return {
        filePath: overrides.filePath ?? `src/file_${nextMsgCounter}.ts`,
        observedAt: overrides.observedAt ?? Date.now(),
        ownerMsgId: overrides.ownerMsgId ?? 'msg_test_0001_owner',
    };
}

export function makeSessionMap(
    overrides: Partial<SessionMap> = {}
): SessionMap {
    return {
        schemaVersion: 1,
        sessionId: overrides.sessionId ?? `ses_test_${Date.now()}`,
        repoId: overrides.repoId ?? 'repo_test',
        baselineCommit: overrides.baselineCommit ?? makeCommitHash('baseline'),
        headCommit: overrides.headCommit,
        currentBaseCommit: overrides.currentBaseCommit,
        entries: overrides.entries ?? [],
        tmpToCommit: overrides.tmpToCommit ?? {},
        tmpToBaseCommit: overrides.tmpToBaseCommit ?? {},
        msgToCommit: overrides.msgToCommit ?? {},
        msgToBaseCommit: overrides.msgToBaseCommit ?? {},
        continuation: overrides.continuation,
    };
}

export function makeSessionEntry(
    overrides: Partial<SessionEntry> = {}
): SessionEntry {
    return {
        turnKey: overrides.turnKey ?? `turn_${Date.now()}`,
        tmpKey: overrides.tmpKey,
        assistantMsgId: overrides.assistantMsgId,
        finalAssistantMsgId: overrides.finalAssistantMsgId,
        messageIndex: overrides.messageIndex,
        commitHash: overrides.commitHash ?? makeCommitHash(),
        touchedFiles: overrides.touchedFiles ?? ['src/example.ts'],
        opType: overrides.opType ?? 'update',
        timestamp: overrides.timestamp ?? Date.now(),
    };
}

export function makeContinuationChainState(
    overrides: Partial<ContinuationChainState> = {}
): ContinuationChainState {
    const currentOwnerMsgId = overrides.currentOwnerMsgId ?? makeMsgId('owner');
    return {
        chainId: overrides.chainId ?? makeChainId(),
        currentOwnerMsgId,
        predecessorOwnerMsgId: overrides.predecessorOwnerMsgId ?? null,
        continuationSequence: overrides.continuationSequence ?? 1,
        chainMsgIds: overrides.chainMsgIds ?? [currentOwnerMsgId],
        continuationInFlight: overrides.continuationInFlight ?? false,
        postFinalWatchEntries: overrides.postFinalWatchEntries ?? [],
    };
}

export function buildSuccessfulTakeoverScenario() {
    resetFactoryCounters();

    const chainId = makeChainId();
    const msgA = makeMsgId('A');
    const msgB = makeMsgId('B');
    const commitA = makeCommitHash('commitA');
    const commitB = makeCommitHash('commitB');
    const baselineCommit = makeCommitHash('baseline');

    const handoffBeforeTakeover = makeHandoffMetadata({
        chainId,
        currentOwnerMsgId: msgA,
        predecessorOwnerMsgId: null,
        continuationSequence: 1,
        lifecycleState: 'watching',
    });

    const handoffAfterTakeover = makeHandoffMetadata({
        chainId,
        currentOwnerMsgId: msgB,
        predecessorOwnerMsgId: msgA,
        continuationSequence: 2,
        lifecycleState: 'idle',
    });

    const sessionMap = makeSessionMap({
        sessionId: 'ses_takeover_test',
        baselineCommit,
        headCommit: commitA,
        currentBaseCommit: commitA,
        entries: [
            makeSessionEntry({
                finalAssistantMsgId: msgA,
                commitHash: commitA,
                touchedFiles: ['src/a.ts'],
            }),
        ],
        msgToCommit: { [msgA]: commitA },
        msgToBaseCommit: { [msgA]: baselineCommit },
    });

    const postFinalWatched: PostFinalWatchEntry[] = [
        makePostFinalWatchEntry({ filePath: 'src/watched.ts', ownerMsgId: msgA }),
    ];

    return {
        chainId,
        msgA,
        msgB,
        commitA,
        commitB,
        baselineCommit,
        handoffBeforeTakeover,
        handoffAfterTakeover,
        sessionMap,
        postFinalWatched,
    };
}

export function buildFailedContinuationScenario() {
    resetFactoryCounters();

    const chainId = makeChainId();
    const msgA = makeMsgId('A');
    const baselineCommit = makeCommitHash('baseline');
    const commitA = makeCommitHash('commitA');

    const handoff = makeHandoffMetadata({
        chainId,
        currentOwnerMsgId: msgA,
        predecessorOwnerMsgId: null,
        continuationSequence: 1,
        lifecycleState: 'retry-ready',
    });

    const sessionMap = makeSessionMap({
        sessionId: 'ses_failed_cont_test',
        baselineCommit,
        headCommit: commitA,
        currentBaseCommit: commitA,
        entries: [
            makeSessionEntry({
                finalAssistantMsgId: msgA,
                commitHash: commitA,
                touchedFiles: ['src/original.ts'],
            }),
        ],
        msgToCommit: { [msgA]: commitA },
        msgToBaseCommit: { [msgA]: baselineCommit },
    });

    const newWatchedDuringFailedContinuation: PostFinalWatchEntry[] = [
        makePostFinalWatchEntry({ filePath: 'src/watched-during-attempt.ts', ownerMsgId: msgA }),
    ];

    return {
        chainId,
        msgA,
        baselineCommit,
        commitA,
        handoff,
        sessionMap,
        newWatchedDuringFailedContinuation,
    };
}

export function buildChainedTakeoverScenario() {
    resetFactoryCounters();

    const chainId = makeChainId();
    const msgA = makeMsgId('A');
    const msgB = makeMsgId('B');
    const msgC = makeMsgId('C');
    const baselineCommit = makeCommitHash('baseline');
    const commitA = makeCommitHash('commitA');
    const commitB = makeCommitHash('commitB');
    const commitC = makeCommitHash('commitC');

    const handoffAfterA = makeHandoffMetadata({
        chainId,
        currentOwnerMsgId: msgA,
        predecessorOwnerMsgId: null,
        continuationSequence: 1,
    });

    const handoffAfterB = makeHandoffMetadata({
        chainId,
        currentOwnerMsgId: msgB,
        predecessorOwnerMsgId: msgA,
        continuationSequence: 2,
    });

    const handoffAfterC = makeHandoffMetadata({
        chainId,
        currentOwnerMsgId: msgC,
        predecessorOwnerMsgId: msgB,
        continuationSequence: 3,
    });

    const sessionMap = makeSessionMap({
        sessionId: 'ses_chained_test',
        baselineCommit,
        headCommit: commitB,
        currentBaseCommit: commitB,
        entries: [
            makeSessionEntry({
                finalAssistantMsgId: msgA,
                commitHash: commitA,
                touchedFiles: ['src/a.ts'],
            }),
            makeSessionEntry({
                finalAssistantMsgId: msgB,
                commitHash: commitB,
                touchedFiles: ['src/b.ts'],
            }),
        ],
        msgToCommit: {
            [msgA]: commitA,
            [msgB]: commitB,
        },
        msgToBaseCommit: {
            [msgA]: baselineCommit,
            [msgB]: commitA,
        },
    });

    return {
        chainId,
        msgA,
        msgB,
        msgC,
        baselineCommit,
        commitA,
        commitB,
        commitC,
        handoffAfterA,
        handoffAfterB,
        handoffAfterC,
        sessionMap,
    };
}
