import type { SupervisorView } from '../../src/supervisor/protocol';
import { supervisorLines } from './diagnostics';
import { SupervisorProcesses } from './processes';
type Task = SupervisorView['tasks'][number];
export function taskStatus(task: Task, stale: boolean): { label: string; tone: string } {
    if (stale) return { label: 'Unknown · historical', tone: 'muted' };
    if (task.health === 'cancel_unknown') return { label: 'Cancellation uncertain', tone: 'warning' };
    if (task.phase === 'terminal') return task.outcome === 'failed' ? { label: 'Failed', tone: 'danger' } :
        task.outcome === 'completed' ? { label: 'Completed', tone: 'success' } : { label: 'Ended', tone: 'muted' };
    const values: Record<string, [string, string]> = {
        waiting_permission: ['Waiting for permission', 'warning'], suspected_stall: ['Suspected stall', 'warning'],
        unreachable: ['Observation unavailable', 'danger'], unknown: ['Unknown', 'muted'],
    };
    const value = values[task.health];
    if (value) return { label: value[0], tone: value[1] };
    if (task.phase === 'registered') return { label: 'Registered', tone: 'muted' };
    if (task.phase === 'dispatching') return { label: 'Starting', tone: 'info' };
    return task.phase === 'active' && task.health === 'running' ? { label: 'Running', tone: 'info' } : { label: 'Unknown', tone: 'muted' };
}
const elapsed = (ms: number | null) => ms === null ? 'unknown' : ms < 60000 ? `${Math.floor(ms / 1000)}s ago` :
    ms < 3600000 ? `${Math.floor(ms / 60000)}m ago` : `${Math.floor(ms / 3600000)}h ago`;
export const taskName = (task: Task) => task.title?.replace(/ \(@[^\n]+ subagent\)$/, '').trim() || 'Untitled task';

/** Keyed DOM projection only. Updating ages never remounts cards or closed details. */
export class SupervisorCards {
    private readonly cards = new Map<string, { root: HTMLElement; name: HTMLElement; badge: HTMLElement; activity: HTMLElement; evidence: HTMLElement; processes: SupervisorProcesses }>();
    private readonly current: HTMLElement;
    private readonly history: HTMLDetailsElement;
    private readonly notice: HTMLElement;
    private readonly empty: HTMLElement;
    private historyKey = '';
    constructor(private readonly document: Document, body: HTMLElement) {
        this.notice = this.node('p', 'sv-notice'); this.current = this.node('div', 'sv-tasks');
        this.empty = this.node('p', 'sv-empty', 'No registered tasks in this session');
        this.history = this.node('details', 'sv-history');
        this.history.append(this.node('summary', '', 'Previous service · historical evidence'), this.node('pre'));
        this.history.hidden = true; body.append(this.notice, this.current, this.empty, this.history);
    }
    private node<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
        const node = this.document.createElement(tag); node.className = cls; node.textContent = text; return node;
    }
    reset(): void {
        this.cards.clear(); this.current.replaceChildren(); this.history.hidden = true; this.history.open = false;
        this.history.lastElementChild!.textContent = ''; this.historyKey = '';
        this.notice.textContent = 'Waiting for session observations'; this.empty.hidden = true;
    }
    render(view: SupervisorView | undefined, previous: SupervisorView | undefined, stale: boolean, hint = ''): void {
        this.notice.textContent = hint || (stale ? 'Observation unavailable; current state unknown' : 'Live observations · Read-only');
        this.empty.hidden = !view || view.tasks.length > 0;
        const retained = new Set<string>();
        for (const task of view?.tasks ?? []) {
            const key = `${view!.instanceId}:${task.taskId}:${task.attemptId}`; retained.add(key);
            let card = this.cards.get(key);
            if (!card) {
                const root = this.node('article', 'sv-card'), name = this.node('h4', 'sv-name');
                const badge = this.node('span', 'sv-badge'), activity = this.node('p', 'sv-activity');
                const details = this.node('details', 'sv-details'), evidence = this.node('pre');
                const processContainer = this.node('div', 'sv-processes');
                details.append(this.node('summary', '', 'Diagnostics'), evidence);
                root.append(name, badge, activity, processContainer, details); this.current.append(root);
                card = { root, name, badge, activity, evidence, processes: new SupervisorProcesses(this.document, processContainer) }; this.cards.set(key, card);
            }
            const status = taskStatus(task, stale);
            card.name.textContent = taskName(task); card.badge.textContent = status.label;
            card.badge.setAttribute('data-tone', status.tone);
            card.activity.textContent = `${stale ? 'Last known activity' : 'Activity'} ${elapsed(task.lastProgressAgeMs)} · Observed ${elapsed(task.lastObservationAgeMs)}`;
            card.evidence.textContent = supervisorLines({ ...view!, tasks: [task] }, stale).join('\n');
            card.processes.render(view!.executions.filter(e => e.taskId === task.taskId && e.attemptId === task.attemptId && e.childSessionId === task.childSessionId), stale);
        }
        for (const [key, card] of this.cards) if (!retained.has(key)) { card.root.remove(); this.cards.delete(key); }
        this.history.hidden = !previous;
        if (previous) {
            if (this.historyKey !== previous.instanceId) this.history.open = false;
            this.historyKey = previous.instanceId;
            this.history.lastElementChild!.textContent = supervisorLines(previous, true).join('\n');
        }
    }
}
