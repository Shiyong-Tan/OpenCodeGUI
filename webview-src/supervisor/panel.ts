import { SUPPORTED_OPENCODE_VERSIONS } from '../../src/supervisor/opencode-version';
import { parseSupervisorView, type SupervisorView } from '../../src/supervisor/protocol';

const age = (value: number | null): string => value === null ? 'Unknown' : `${Math.floor(value / 1000)} s`;
const fact = (value: boolean | null): string => value === null ? 'Unknown' : value ? 'Yes' : 'No';
const states: Record<string, string> = { registered: 'Registered', dispatching: 'Dispatching', active: 'Active', terminal: 'Ended',
    running: 'Running', waiting_permission: 'Waiting for permission', suspected_stall: 'Suspected stall', suspect: 'Suspected stall',
    unreachable: 'Observation unreachable', ended: 'Ended', cancel_unknown: 'Cancellation outcome unknown', unknown: 'Unknown',
    starting: 'Starting', stopped: 'Confirmed stopped', start_failed: 'Start failed', permission_denied: 'Permission denied',
    queued: 'Waiting for parent', submitting: 'Submitting', submitted: 'Submitted, receipt not yet confirmed', received: 'Received by parent',
    not_observed: 'No parent activity observed', activity_observed: 'Parent activity observed', result_read: 'Result read' };
export function supervisorLines(view: SupervisorView, stale = false): string[] {
    const lines = [stale ? 'Observation unavailable or previous instance: historical evidence below; current state unknown' : 'Read-only live observations',
        `OpenCode ${view.openCodeVersion} / Plugin ${view.pluginVersion}`, `Instance ${view.instanceId}`];
    if (!view.tasks.length) lines.push('No registered tasks in this session');
    for (const task of view.tasks) {
        lines.push(`Task ${task.taskId}`, `Child session ${task.childSessionId ?? 'Not yet created'}`,
            `${stale ? 'Previous ' : ''}Status: ${states[task.phase] ?? 'Unknown'} / ${states[task.health] ?? 'Unknown'}`,
            `Last observation ${age(task.lastObservationAgeMs)}; Last activity ${age(task.lastProgressAgeMs)}`);
        for (const e of view.executions.filter(item => item.taskId === task.taskId && item.attemptId === task.attemptId)) {
            lines.push(`Execution ${e.executionId}: ${states[e.health] ?? 'Unknown'}`,
                `Process sample ${age(e.lastObservationAgeMs)}; Activity ${age(e.lastActivityAgeMs)}`,
                `CPU delta ${e.cpuDelta100ns ?? 'Unknown'} ×100ns; Read/write delta ${e.readDeltaBytes ?? 'Unknown'} / ${e.writeDeltaBytes ?? 'Unknown'} bytes`,
                `Root exited ${fact(e.rootExited)}; Managed processes stopped ${fact(e.ownedProcessesStopped)}`,
                `Cancellation request accepted ${fact(e.requestAccepted)}; Cancellation outcome: ${e.cancelOutcomeUnknown ? 'Unknown' : 'See stop evidence'}`,
                'CPU/I/O indicate activity only, not computational correctness; reassignment is unavailable here');
        }
        for (const n of view.notifications.filter(item => item.taskId === task.taskId && item.attemptId === task.attemptId)) {
            lines.push(`Notification ${n.notificationId}: ${states[n.delivery] ?? 'Unknown'} / ${states[n.progress] ?? 'Unknown'}`);
            lines.push('Notification queued for ' + age(n.queueAgeMs) + '; Waiting for first observed activity after submission ' + age(n.activityWaitAgeMs));
            if (n.escalated) lines.push('User review needed: the parent has not completed the required result handling');
        }
    }
    return lines;
}

export function mountSupervisorPanel(document: Document, receive: (handler: (value: unknown) => void) => void): void {
    const button = document.createElement('button'); button.id = 'supervisor-toggle';
    button.textContent = 'Supervisor · Experimental'; button.setAttribute('aria-expanded', 'false');
    button.style.cssText = 'position:fixed;right:12px;top:42px;z-index:9000;font-size:12px;padding:4px 8px;';
    const panel = document.createElement('section'); panel.id = 'supervisor-panel'; panel.hidden = true;
    panel.setAttribute('aria-label', 'Experimental supervisor, read-only');
    panel.style.cssText = 'position:fixed;right:8px;top:76px;bottom:90px;width:min(380px,calc(100vw - 16px));overflow:auto;z-index:9001;background:var(--vscode-editor-background);color:var(--vscode-foreground);border:1px solid var(--vscode-panel-border);padding:12px;box-sizing:border-box;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;';
    const title = document.createElement('h3'); title.textContent = 'Experimental mode: preset managed commands only';
    const body = document.createElement('div'); body.id = 'supervisor-content'; body.textContent = 'Waiting for session observations';
    panel.append(title, body); document.body.append(button, panel);
    button.addEventListener('click', () => { panel.hidden = !panel.hidden; button.setAttribute('aria-expanded', String(!panel.hidden)); });
    let sessionId: string | null = null;
    let current: SupervisorView | undefined;
    let previous: SupervisorView | undefined;
    let normal = false;
    let lastStatus = '';
    const historical = () => (previous ? supervisorLines(previous, true).join('\n') + '\n' : '') + (current ? supervisorLines(current, true).join('\n') : '');
    const connectionStates: Record<string, string> = { disabled: 'Disabled', unavailable: 'Not installed or unavailable',
        connecting: 'Connecting', connected: 'Connected', incompatible: 'Incompatible', disconnected: 'Disconnected' };
    const connectionStatus = (status: unknown) => {
        if (typeof status !== 'string' || !connectionStates[status]) return;
        normal = true;
        lastStatus = status;
        button.textContent = 'Supervisor · ' + connectionStates[status];
        panel.setAttribute('aria-label', 'Subtask supervisor, read-only');
        title.textContent = 'Subtask supervisor · ' + connectionStates[status];
        const hint = status === 'disabled' ? 'GUI display is disabled; the backend plugin and tasks may still be running.' :
            status === 'unavailable' ? 'Check the OpenCodeTaskSupervisor installation and service logs. If the logs report Unsupported OpenCode version, update both GUI and Supervisor; updating GUI alone cannot fix an old plugin. Initial loading requires the next normal service start; existing services will not restart automatically.' :
            status === 'incompatible' ? `Version or connection mismatch. Verified on Windows / OpenCode ${SUPPORTED_OPENCODE_VERSIONS.join(', ')}. Update both GUI and OpenCodeTaskSupervisor, and check the service version and plugin logs; services will not restart automatically.` : connectionStates[status];
        if (status !== 'connected') body.textContent = (current ? historical() + '\n' : '') + hint + '\nSetting: OpenCode › Supervisor: Enabled';
    };
    connectionStatus(document.querySelector('script[data-supervisor-status]')?.getAttribute('data-supervisor-status'));
    const select = (id: string | null) => {
        if (sessionId === id) return;
        sessionId = id; current = undefined; previous = undefined; body.replaceChildren(); body.textContent = 'Waiting for session observations';
        if (normal) connectionStatus(lastStatus);
    };
    receive(value => {
        if (!value || typeof value !== 'object') return;
        const message = value as Record<string, unknown>;
        if (message.type === 'supervisorConnectionStatus' && message.mode === 'normal') { connectionStatus(message.status); return; }
        if (message.type === 'supervisorSelection' || message.type === 'sessionData') {
            select(typeof message.sessionId === 'string' ? message.sessionId : null); return;
        }
        if (message.type !== 'supervisorState' || message.sessionId !== sessionId) return;
        if (message.status !== 'observed') {
            body.textContent = current ? historical() : 'Observation unavailable; current state unknown'; return;
        }
        try {
            const next = parseSupervisorView(message.view);
            if (next.parentSessionId !== sessionId) return;
            if (current && next.instanceId === current.instanceId && next.revision < current.revision) return;
            if (normal && current && next.instanceId !== current.instanceId) previous = current;
            if (!normal && current && next.instanceId !== current.instanceId) {
                body.textContent = supervisorLines(current, true).join('\n') + '\nInstance changed; reload the isolated window'; return;
            }
            current = next;
            // Only this overlay's text changes. Never rebuild, measure or scroll chat DOM.
            body.textContent = (previous ? supervisorLines(previous, true).join('\n') + '\n— Current service instance —\n' : '') + supervisorLines(next).join('\n');
        } catch { body.textContent = 'Supervisor protocol unavailable; current state unknown'; }
    });
}
