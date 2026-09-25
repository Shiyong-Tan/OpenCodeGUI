import { parseSupervisorView, type SupervisorView } from '../../src/supervisor/protocol';
import { SupervisorCards } from './cards';
import { supervisorStyles } from './styles';
export { supervisorLines } from './diagnostics';

export function mountSupervisorPanel(document: Document, receive: (handler: (value: unknown) => void) => void): void {
    const style = document.createElement('style'); style.textContent = supervisorStyles;
    const button = document.createElement('button'); button.id = 'supervisor-toggle';
    button.textContent = 'Supervisor · Experimental'; button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', 'supervisor-panel');
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
        button.textContent = 'Supervisor · ' + connectionStates[status];
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
        sessionId = id; current = undefined; previous = undefined; cards.reset(); panel.scrollTop = 0;
        if (normal) connectionStatus(lastStatus, true);
    };
    receive(value => {
        if (!value || typeof value !== 'object') return;
        const message = value as Record<string, unknown>;
        if (message.type === 'supervisorConnectionStatus' && message.mode === 'normal') { connectionStatus(message.status); return; }
        if (message.type === 'supervisorSelection' || message.type === 'sessionData') {
            select(typeof message.sessionId === 'string' ? message.sessionId : null); return;
        }
        if (message.type !== 'supervisorState' || message.sessionId !== sessionId) return;
        if (message.status !== 'observed') { cards.render(current, previous, true); return; }
        try {
            const next = parseSupervisorView(message.view);
            if (next.parentSessionId !== sessionId) return;
            if (current && next.instanceId === current.instanceId && next.revision < current.revision) return;
            if (normal && current && next.instanceId !== current.instanceId) previous = current;
            if (!normal && current && next.instanceId !== current.instanceId) {
                cards.render(current, previous, true, 'Instance changed; reload the isolated window'); return;
            }
            current = next;
            cards.render(next, previous, normal && lastStatus !== 'connected');
        } catch { cards.render(current, previous, true, 'Supervisor protocol unavailable; current state unknown'); }
    });
}
