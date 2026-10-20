import type { ChildCardTerminal } from '../../src/events/ChildCardReview';
type Agent = { sessionId?: string; agentSessionId?: string; startedAt?: number; state?: string; isDone?: boolean };
type View = { activeSubagents?: Agent[]; messagesById?: Map<string, { meta?: { subagents?: Agent[] } }>; childCardTerminals?: Map<string, ChildCardTerminal> };
export function childCardIds(view: View): string[] {
    const ids = new Set<string>();
    const collect = (agents?: Agent[]) => { for (const agent of agents ?? []) {
        const id = agent.agentSessionId || agent.sessionId;
        if (id && /^ses_[\w-]+$/.test(id) && !['done', 'failed', 'cancelled', 'dismissed'].includes(agent.state || '') && !agent.isDone) ids.add(id);
    } };
    collect(view.activeSubagents);
    for (const message of view.messagesById?.values() ?? []) collect(message.meta?.subagents);
    return [...ids].slice(-128);
}
/** Ephemeral projection of backend terminal evidence; never edit stored history. */
export function applyChildCardTerminals(view: View, facts: readonly ChildCardTerminal[] = []): boolean {
    const known = view.childCardTerminals ??= new Map();
    for (const fact of facts) if (/^ses_[\w-]+$/.test(fact.sessionId) && ['done', 'failed', 'cancelled'].includes(fact.state) && Number.isFinite(fact.finishedAt) && fact.finishedAt > 0) {
        if ((known.get(fact.sessionId)?.finishedAt ?? 0) <= fact.finishedAt) known.set(fact.sessionId, fact);
    }
    while (known.size > 256) known.delete(known.keys().next().value!);
    let changed = false;
    const apply = (agents?: Agent[]) => { for (const agent of agents ?? []) {
        const fact = known.get(agent.agentSessionId || agent.sessionId || '');
        if (!fact || (typeof agent.startedAt === 'number' && agent.startedAt > fact.finishedAt) || (agent.isDone && agent.state === fact.state)) continue;
        agent.state = fact.state; agent.isDone = true; changed = true;
    } };
    apply(view.activeSubagents);
    for (const message of view.messagesById?.values() ?? []) apply(message.meta?.subagents);
    return changed;
}
