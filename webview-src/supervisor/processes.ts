import type { SupervisorView } from '../../src/supervisor/protocol';

type Execution = SupervisorView['executions'][number];
export function processStatus(e: Execution, stale: boolean): { label: string; tone: string } {
    if (stale) return { label: 'Unknown · historical', tone: 'muted' };
    if (e.phase === 'permission_denied') return { label: 'Not started', tone: 'warning' };
    if (e.phase === 'start_failed') return { label: 'Start uncertain', tone: 'warning' };
    if (e.phase === 'waiting_permission') return { label: 'Waiting for permission', tone: 'warning' };
    if (e.phase === 'stopped') return e.exitCode === 0 ? { label: 'Exited · 0', tone: 'success' } :
        { label: e.exitCode === null ? 'Stopped' : `Exited · ${e.exitCode}`, tone: e.exitCode === null ? 'muted' : 'danger' };
    if (e.health === 'unknown' || e.coverageUnknown) return { label: 'Observation uncertain', tone: 'muted' };
    if (e.rootExited) return { label: 'Waiting for descendants / output', tone: 'warning' };
    return e.health === 'suspect' ? { label: 'Quiet · review needed', tone: 'warning' } : { label: 'Running', tone: 'info' };
}
export function processMetrics(e: Execution, stale: boolean): string {
    if (stale) return 'Historical evidence; current process state unknown';
    const parts: string[] = [];
    if (e.durationMs !== null) parts.push(`${Math.floor(e.durationMs / 1000)}s elapsed`);
    if (e.health !== 'unknown' && !e.coverageUnknown) {
        if (e.cpuPercent !== null) parts.push(`CPU ${e.cpuPercent.toFixed(1)}%`);
        if (e.workingSetBytes !== null) parts.push(`${(Number(e.workingSetBytes) / 1048576).toFixed(1)} MiB`);
        if (e.activeProcesses !== null) parts.push(`${e.activeProcesses} live processes`);
    }
    return parts.join(' · ') || 'Waiting for process evidence';
}

/** Keyed display projection. Never starts, attaches to or stops a process. */
export class SupervisorProcesses {
    private readonly rows = new Map<string, { root: HTMLElement; name: HTMLElement; status: HTMLElement; metrics: HTMLElement }>();
    constructor(private readonly document: Document, private readonly container: HTMLElement) {}
    render(executions: Execution[], stale: boolean): void {
        const retained = new Set<string>();
        for (const e of executions) {
            retained.add(e.executionId);
            let row = this.rows.get(e.executionId);
            if (!row) {
                const root = this.document.createElement('div'); root.className = 'sv-process';
                const name = this.document.createElement('strong'), status = this.document.createElement('span'), metrics = this.document.createElement('p');
                status.className = 'sv-badge'; metrics.className = 'sv-activity';
                root.append(name, status, metrics); this.container.append(root);
                row = { root, name, status, metrics }; this.rows.set(e.executionId, row);
            }
            const status = processStatus(e, stale);
            row.name.textContent = e.displayName || 'Tracked process'; row.status.textContent = status.label;
            row.status.setAttribute('data-tone', status.tone); row.metrics.textContent = processMetrics(e, stale);
            row.metrics.title = 'CPU: 100% = one logical core. Memory: observed working set. Quiet CPU/I/O may be valid for GPU work or waiting.';
        }
        for (const [id, row] of this.rows) if (!retained.has(id)) { row.root.remove(); this.rows.delete(id); }
        this.container.hidden = !executions.length;
    }
}
