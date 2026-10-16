/** Wire adapters return facts. Session/turn owners alone decide UI lifecycle. */
export type BackendRecord = Readonly<Record<string, unknown>>;
export type Delivery = 'queue' | 'steer';
export type ExecutionOutcome = 'succeeded' | 'failed' | 'interrupted';
export interface BackendPage<T> { readonly items: readonly T[]; readonly next?: string; readonly previous?: string }
export interface BackendSession {
    readonly id: string; readonly parentId?: string; readonly title?: string;
    readonly createdAt: number; readonly updatedAt: number;
    readonly location: BackendRecord; readonly native: BackendRecord;
}
export interface BackendTool {
    readonly sessionId: string; readonly assistantMessageId: string; readonly callId: string;
    readonly name: string; readonly status: 'streaming' | 'running' | 'completed' | 'error';
    readonly native: BackendRecord;
}
export interface BackendMessage {
    readonly sessionId: string; readonly id: string; readonly kind: string; readonly createdAt: number;
    readonly tools: readonly BackendTool[];
    readonly outcome?: ExecutionOutcome;
    /** Preserve control records; a provider completion is not a session final. */
    readonly native: BackendRecord;
}
export interface BackendInboxItem {
    readonly sessionId: string; readonly id: string; readonly kind: string;
    readonly delivery: Delivery; readonly native: BackendRecord;
}
export interface BackendPrompt {
    readonly id: string; readonly text: string; readonly delivery: Delivery;
    readonly resume?: boolean;
    readonly files?: readonly { readonly uri: string; readonly name?: string; readonly description?: string }[];
    readonly metadata?: BackendRecord;
}
export interface BackendSessionPort {
    listSessions(input?: { readonly cursor?: string; readonly limit?: number }): Promise<BackendPage<BackendSession>>;
    getSession(sessionId: string): Promise<BackendSession>;
    createSession(input?: { readonly parentId?: string; readonly title?: string }): Promise<BackendSession>;
    messages(sessionId: string, input?: { readonly cursor?: string; readonly limit?: number }): Promise<BackendPage<BackendMessage>>;
    inbox(sessionId: string): Promise<readonly BackendInboxItem[]>;
    admit(sessionId: string, prompt: BackendPrompt): Promise<BackendInboxItem>;
    changeDelivery(sessionId: string, inboxId: string, delivery: Delivery): Promise<void>;
    cancelQueued(sessionId: string, inboxId: string): Promise<void>;
    /** Acknowledgement never claims external processes or queued inputs stopped. */
    interrupt(sessionId: string): Promise<{ readonly interrupted: boolean }>;
}
export type BackendFailure = 'authentication' | 'unsupported' | 'conflict' | 'rejected' |
    'invalid_response' | 'superseded' | 'ambiguous' | 'unavailable';
export class BackendOperationError extends Error {
    constructor(readonly reason: BackendFailure, readonly operation: string, readonly status?: number) {
        super(`OpenCode ${operation}: ${reason}${status === undefined ? '' : ` (HTTP ${status})`}`);
        this.name = 'BackendOperationError';
    }
}
