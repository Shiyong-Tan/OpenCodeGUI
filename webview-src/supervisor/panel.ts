import { parseSupervisorView, type SupervisorView } from '../../src/supervisor/protocol';
import { SupervisorCards, visibleSupervisorTasks } from './cards';
import { supervisorStyles } from './styles';
import { mountSupervisorSwitch } from './switch';
export { supervisorLines } from './diagnostics';

export function supervisorTone(view?: SupervisorView): 'healthy' | 'attention' | 'error' | 'unknown' {
    if (!view) return 'unknown';
    const tasks = visibleSupervisorTasks(view);
    const ids = new Set(tasks.map(t => t.taskId));
    const executions = view.executions.filter(e => ids.has(e.taskId));
    if (tasks.some(t => t.outcome === 'failed') || executions.some(e => e.phase === 'start_failed')) return 'error';
    if (tasks.some(t => !['running', 'ended'].includes(t.health)) ||
        executions.some(e => !['running', 'stopped'].includes(e.health) || e.cancelOutcomeUnknown || e.coverageUnknown) ||
        view.notifications.some(n => ids.has(n.taskId) && n.escalated)) return 'attention';
    return 'healthy';
}

export function mountSupervisorPanel(document: Document, receive: (handler: (value: unknown) => void) => void,
    send: (message: unknown) => void = () => {}) {
    const style = document.createElement('style'); style.textContent = supervisorStyles;
    const button = document.createElement('button'); button.id = 'supervisor-toggle';
    button.textContent = 'Supervisor · Experimental'; button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', 'supervisor-panel');
    const setIndicator = (tone: string, detail: string) => {
        button.setAttribute('data-tone', tone);
        button.setAttribute('title', `Supervisor: ${detail}`);
        button.setAttribute('aria-label', `Supervisor: ${detail}`);
    };
    setIndicator('unknown', 'Waiting for observations');
    const panel = document.createElement('section'); panel.id = 'supervisor-panel'; panel.hidden = true;
    panel.setAttribute('aria-label', 'Experimental supervisor, read-only');
    const title = document.createElement('h3'); title.textContent = 'Subtask supervisor';
    const body = document.createElement('div'); body.id = 'supervisor-content';
    panel.append(title, body); document.body.append(style, button, panel);
    const composer = document.querySelector('.input-container');
    if (composer?.parentNode) {
        const dock = document.createElement('div'); dock.id = 'supervisor-dock';
        composer.parentNode.insertBefore(dock, composer);
        dock.append(button, panel);
    }
    const cards = new SupervisorCards(document, body); cards.reset();
    const updateSwitch = mountSupervisorSwitch(document, send);
    const busySessions = new Set<string>();
    let supervisedBusy = false;
    let hostBusy = false;
    const refreshSwitchLock = () => updateSwitch?.setBusy(hostBusy || supervisedBusy || busySessions.size > 0);
    const showEnabled = (enabled: boolean, error?: string, acknowledged = false) => {
        updateSwitch?.(enabled, error, acknowledged); button.hidden = !enabled;
        if (!enabled) { panel.hidden = true; button.setAttribute('aria-expanded', 'false'); }
    };
    button.addEventListener('click', () => { panel.hidden = !panel.hidden; button.setAttribute('aria-expanded', String(!panel.hidden)); });
    panel.addEventListener('keydown', event => {
        if (event.key === 'Escape') { panel.hidden = true; button.setAttribute('aria-expanded', 'false'); button.focus(); }
    });
    let sessionId: string | null = null;
    let current: SupervisorView | undefined;
    let previous: SupervisorView | undefined;
    let normal = false;
    let lastStatus = '';
    const connectionStates: Record<string, string> = { disabled: 'Disabled', unavailable: 'Unavailable',
        connecting: 'Connecting', connected: 'Connected', incompatible: 'Incompatible', disconnected: 'Disconnected' };
    const connectionStatus = (status: unknown, selectionChanged = false) => {
        if (typeof status !== 'string' || !connectionStates[status]) return;
        // The host republishes connection status before and after each poll.
        // A duplicate heartbeat is not a reconnect and must not invalidate task evidence.
        if (normal && status === lastStatus && !selectionChanged) return;
        normal = true; lastStatus = status;
        showEnabled(status !== 'disabled');
        button.textContent = 'Supervisor · ' + connectionStates[status];
        setIndicator('unknown', connectionStates[status] + (status === 'connected' ? ' - Waiting for observations' : ''));
        panel.setAttribute('aria-label', 'Subtask supervisor, read-only');
        title.textContent = 'Subtask supervisor';
        const hint = status === 'disabled' ? 'GUI display is disabled; the backend plugin and tasks may still be running.' :
            status === 'unavailable' ? 'Check plugin installation, required API responses and service logs. If an older plugin reports Unsupported OpenCode version, update the plugin; updating GUI alone cannot remove its version allowlist.' :
            status === 'incompatible' ? 'Supervisor protocol or service identity mismatch. Check API compatibility and service logs; services will not restart automatically.' : connectionStates[status];
        // A transport reconnect alone is not fresh evidence about task health.
        cards.render(current, previous, true, status === 'connected' ? 'Connected · Waiting for fresh observations' : hint);
    };
    connectionStatus(document.querySelector('script[data-supervisor-status]')?.getAttribute('data-supervisor-status'));
    const select = (id: string | null) => {
        if (sessionId === id) return;
        sessionId = id; current = undefined; previous = undefined; setIndicator('unknown', 'Waiting for observations'); cards.reset(); panel.scrollTop = 0;
        if (normal) connectionStatus(lastStatus, true);
    };
    receive(value => {
        if (!value || typeof value !== 'object') return;
        const message = value as Record<string, unknown>;
        if (message.type === 'supervisorSwitchState' && typeof message.busy === 'boolean') {
            hostBusy = message.busy; refreshSwitchLock(); return;
        }
        if (message.type === 'turnInFlight' && typeof message.sessionId === 'string') {
            if (message.inFlight === true) busySessions.add(message.sessionId); else busySessions.delete(message.sessionId);
            refreshSwitchLock();
        }
        if (message.type === 'supervisorToggleResult' && typeof message.enabled === 'boolean') {
            if (message.busy === true) updateSwitch?.setBusy(true);
            showEnabled(message.enabled, typeof message.error === 'string' ? message.error : undefined, true); return;
        }
        if (message.type === 'supervisorConnectionStatus' && message.mode === 'normal') { connectionStatus(message.status); return; }
        if (message.type === 'supervisorSelection' || message.type === 'sessionData') {
            select(typeof message.sessionId === 'string' ? message.sessionId : null); return;
        }
        if (message.type !== 'supervisorState' || message.sessionId !== sessionId) return;
        if (message.status !== 'observed') { setIndicator('unknown', 'Observation unavailable'); cards.render(current, previous, true); return; }
        try {
            const next = parseSupervisorView(message.view);
            if (next.parentSessionId !== sessionId) return;
            if (current && next.instanceId === current.instanceId && next.revision < current.revision) return;
            if (normal && current && next.instanceId !== current.instanceId) previous = current;
            if (!normal && current && next.instanceId !== current.instanceId) {
                cards.render(current, previous, true, 'Instance changed; reload the isolated window'); return;
            }
            current = next;
            supervisedBusy = next.tasks.some(task => task.phase !== 'terminal') || next.executions.some(execution => execution.phase !== 'stopped' && execution.phase !== 'permission_denied');
            refreshSwitchLock();
            const tone = normal && lastStatus !== 'connected' ? 'unknown' : supervisorTone(next);
            setIndicator(tone, { healthy: visibleSupervisorTasks(next).length ? 'Tasks healthy' : 'No active tasks', attention: 'Needs attention', error: 'Task failed', unknown: 'Observation unavailable' }[tone]);
            cards.render(next, previous, normal && lastStatus !== 'connected');
        } catch { setIndicator('unknown', 'Observation unavailable'); cards.render(current, previous, true, 'Supervisor protocol unavailable; current state unknown'); }
    });
}
