export interface ToolDisplayRow { key: string; name: string; input: string; status: string; color: string; hideAt?: number }
/** Completed cards are hidden, while the canonical agent/result records stay intact. */
export function visibleSubagentCards<T extends { state?: string; isDone?: boolean }>(agents: readonly T[]): T[] {
    return agents.filter(agent => agent.state !== 'done' && agent.isDone !== true);
}
/** A read-only projection; no DOM-based identity or tool lifecycle decisions. */
export function subagentToolRows(agent: Record<string, unknown>, now = Date.now()): ToolDisplayRow[] | undefined {
    if (!Array.isArray(agent.tools)) return undefined;
    const rows: ToolDisplayRow[] = [], seen = new Set<string>();
    for (const item of agent.tools) {
        if (!item || typeof item !== 'object') continue;
        const raw = item as Record<string, unknown>;
        if (raw.sessionId !== (agent.agentSessionId || agent.sessionId) || typeof raw.assistantMessageId !== 'string' ||
            typeof raw.callId !== 'string' || !raw.callId || typeof raw.name !== 'string' || typeof raw.status !== 'string') continue;
        const key = JSON.stringify([raw.sessionId, raw.assistantMessageId, raw.callId]);
        if (seen.has(key) || !['pending', 'streaming', 'running', 'completed', 'error'].includes(raw.status)) continue;
        const settled = raw.status === 'completed' || raw.status === 'error';
        const hideAt = typeof raw.settledAt === 'number' && Number.isFinite(raw.settledAt) ? raw.settledAt + 1000 : 0;
        if (settled && hideAt <= now) continue;
        seen.add(key);
        rows.push({ key, name: raw.name, input: typeof raw.input === 'string' ? raw.input : '', ...(settled ? { hideAt } : {}),
            status: raw.status === 'completed' ? 'Completed' : raw.status === 'error' ? 'Failed' : raw.status === 'running' ? 'Running' : 'Preparing',
            color: raw.status === 'completed' ? 'var(--vscode-testing-iconPassed, #22c55e)' : raw.status === 'error' ?
                'var(--vscode-errorForeground, #f14c4c)' : 'var(--vscode-textLink-foreground, #3794ff)' });
    }
    return rows;
}

/** Presentation-only dwell: never delay canonical tool/child termination. */
export function scheduleSubagentToolHide(node: HTMLElement, hideAt: number): void {
    setTimeout(() => { if (node.isConnected) node.remove(); }, Math.max(0, hideAt - Date.now()));
}

/** A fixed collapsed viewport avoids a second-frame measure/clamp on each delta. */
export function clampSubagentText(node: HTMLElement, expanded: boolean): void {
    const styles = { display: 'block', 'white-space': 'normal', 'line-height': '1.5',
        'max-height': expanded ? 'none' : '7.5em', height: expanded ? 'auto' : '7.5em',
        overflow: expanded ? 'visible' : 'hidden' };
    for (const [name, value] of Object.entries(styles)) node.style.setProperty(name, value, 'important');
}
