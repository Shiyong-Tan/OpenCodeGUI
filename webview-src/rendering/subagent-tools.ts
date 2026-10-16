export interface ToolDisplayRow { key: string; name: string; input: string; status: string; color: string }
/** Completed cards are hidden, while the canonical agent/result records stay intact. */
export function visibleSubagentCards<T extends { state?: string; isDone?: boolean }>(agents: readonly T[]): T[] {
    return agents.filter(agent => agent.state !== 'done' && agent.isDone !== true);
}
/** A read-only projection; no DOM-based identity or tool lifecycle decisions. */
export function subagentToolRows(agent: Record<string, unknown>): ToolDisplayRow[] | undefined {
    if (!Array.isArray(agent.tools)) return undefined;
    const rows: ToolDisplayRow[] = [], seen = new Set<string>();
    for (const item of agent.tools) {
        if (!item || typeof item !== 'object') continue;
        const raw = item as Record<string, unknown>;
        if (raw.sessionId !== (agent.agentSessionId || agent.sessionId) || typeof raw.assistantMessageId !== 'string' ||
            typeof raw.callId !== 'string' || !raw.callId || typeof raw.name !== 'string' || typeof raw.status !== 'string') continue;
        const key = JSON.stringify([raw.sessionId, raw.assistantMessageId, raw.callId]);
        if (seen.has(key) || !['pending', 'streaming', 'running', 'completed', 'error'].includes(raw.status)) continue;
        if (raw.status === 'completed' || raw.status === 'error') continue;
        seen.add(key);
        rows.push({ key, name: raw.name, input: typeof raw.input === 'string' ? raw.input : '',
            status: raw.status === 'completed' ? 'Completed' : raw.status === 'error' ? 'Failed' : raw.status === 'running' ? 'Running' : 'Preparing',
            color: raw.status === 'completed' ? 'var(--vscode-testing-iconPassed, #22c55e)' : raw.status === 'error' ?
                'var(--vscode-errorForeground, #f14c4c)' : 'var(--vscode-textLink-foreground, #3794ff)' });
    }
    return rows;
}
