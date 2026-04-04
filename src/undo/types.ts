export const MIN_GIT_VERSION = '2.30.0';
export const WIN_PATHSPEC_CHUNK = 200;
export const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export type GitCapabilities = {
    gitAvailable: boolean;
    version?: string;
    reason?: string;
};

export type GitRepoRef = {
    repoId: string;
    gitDir: string;
    indexFile: string;
    workTree: string;
};

export type IndexMap = {
    schemaVersion: 1;
    sessionToRepo: Record<string, string>;
    turnToRepo: Record<string, string>;
};

export type SessionEntry = {
    turnKey?: string;
    tmpKey?: string;
    assistantMsgId?: string;
    finalAssistantMsgId?: string;
    messageIndex?: number;
    commitHash: string;
    touchedFiles: string[];
    opType: 'update' | 'create' | 'delete' | 'rename' | 'multi';
    timestamp: number;
};

export type ContinuationLifecycleState = 'idle' | 'watching' | 'retry-ready';

export type PostFinalWatchEntry = {
    filePath: string;
    observedAt: number;
    ownerMsgId: string;
};

export type ContinuationHandoffMetadata = {
    chainId?: string;
    currentOwnerMsgId: string;
    predecessorOwnerMsgId: string | null;
    continuationSequence: number;
    lifecycleState: ContinuationLifecycleState;
    postFinalWatchEntries: PostFinalWatchEntry[];
};

export type SessionMap = {
    schemaVersion: 1;
    sessionId: string;
    repoId: string;
    baselineCommit?: string;
    headCommit?: string;
    currentBaseCommit?: string;
    entries: SessionEntry[];
    tmpToCommit: Record<string, string>;
    tmpToBaseCommit: Record<string, string>;
    msgToCommit: Record<string, string>;
    msgToBaseCommit: Record<string, string>;
    continuation?: ContinuationHandoffMetadata;
};

export type FileChangeSpec =
    | { type: 'create'; path: string }
    | { type: 'update'; path: string }
    | { type: 'delete'; path: string }
    | { type: 'rename'; oldPath: string; newPath: string }
    | { type: 'multi'; items: FileChangeSpec[] };

export type ConflictInfo = {
    path: string;
    diffText?: string;
    expectedExists?: boolean;
    currentExists?: boolean;
};
export type UndoResult = {
    conflicts: ConflictInfo[];
    touchedFiles: string[];
    applied: boolean;
    reason?: string;
    startCommit?: string;
    startCommits?: string[];
    restoreCommit?: string;
    undoTargetCommit?: string;
    fileSet?: string[];
};
export type RestoreResult = { conflicts: ConflictInfo[]; touchedFiles: string[]; applied: boolean };
