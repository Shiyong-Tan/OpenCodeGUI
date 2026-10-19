import { presentationFingerprint } from './presentation-fingerprint';
import { scheduleSubagentToolHide, subagentToolRows, type ToolDisplayRow } from './subagent-tools';

/** Reconcile only this entry's tool projection; call state remains extension-owned. */
export function renderSubagentTools(entry: HTMLElement, rows: ToolDisplayRow[], document: Document): void {
    const existing = new Map(Array.from(entry.querySelectorAll<HTMLElement>(':scope > .subagent-inline-tool-group'))
        .map(group => [group.dataset.toolKey, group]));
    const keep = new Set(rows.map(row => row.key));
    for (const [key, group] of existing) if (!key || !keep.has(key)) group.remove();
    for (const tool of rows) {
        let group = existing.get(tool.key);
        if (!group) {
            group = document.createElement('div'); group.className = 'subagent-inline-tool-group'; group.dataset.toolKey = tool.key;
            const row = document.createElement('div'); row.className = 'subagent-inline-tool'; row.dataset.toolKey = tool.key;
            group.appendChild(row); entry.appendChild(group);
        }
        const row = group.querySelector<HTMLElement>('.subagent-inline-tool')!;
        row.textContent = `\u25B8 ${tool.name} \u00B7 ${tool.status}`; row.style.color = tool.color;
        let input = group.querySelector<HTMLElement>('.subagent-inline-input');
        if (tool.input) {
            if (!input) { input = document.createElement('div'); input.className = 'subagent-inline-input'; group.appendChild(input); }
            input.textContent = tool.input;
        } else input?.remove();
        if (tool.hideAt !== undefined && group.dataset.hideAt !== String(tool.hideAt)) {
            group.dataset.hideAt = String(tool.hideAt); scheduleSubagentToolHide(group, tool.hideAt);
        }
    }
}

type Agent = Record<string, unknown>;
const stable = (agent: Agent) => {
    const { tools: _tools, latestTool: _tool, latestToolInput: _input, ...rest } = agent;
    return rest;
};
/** Refuse structural/text/lifecycle changes: the normal renderer owns those. */
export function patchSubagentTools(root: HTMLElement, previous: Agent[], next: Agent[], document: Document): boolean {
    if (!previous.length || previous.length !== next.length || [...previous, ...next].some(agent => !Array.isArray(agent.tools)) ||
        presentationFingerprint(previous.map(stable)) !== presentationFingerprint(next.map(stable))) return false;
    const entries = Array.from(root.querySelectorAll<HTMLElement>('.subagent-inline-entry'));
    const targets = next.map(agent => entries.filter(entry => entry.dataset.subagentSessionId === (agent.agentSessionId || agent.sessionId)));
    if (targets.some(matches => matches.length !== 1)) return false;
    next.forEach((agent, index) => renderSubagentTools(targets[index][0], subagentToolRows(agent)!, document));
    return true;
}
