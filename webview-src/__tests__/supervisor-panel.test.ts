import { mountSupervisorPanel, supervisorLines } from '../supervisor/panel';
import { parseSupervisorView } from '../../src/supervisor/protocol';
import { taskStatus } from '../supervisor/cards';

const snapshot = () => parseSupervisorView({ schemaVersion: 1, isolationId: 'lab_A', instanceId: 'instance_A', revision: 1,
    pluginVersion: '0.1.0', openCodeVersion: '1.18.29', observedAt: '2026-09-20T00:00:00.000Z', parentSessionId: 'ses_A',
    scope: 'isolated_allowlisted_commands', tasks: [{ taskId: 'task_A', attemptId: 'attempt_A', parentSessionId: 'ses_A', childSessionId: 'ses_child',
        phase: 'active', health: 'waiting_permission', outcome: null, lastObservationAgeMs: null, lastProgressAgeMs: 1000 }],
    executions: [], notifications: [], notificationIdentities: [] });
class Element {
    id = ''; private text = ''; hidden = false; open = false; scrollTop = 0; className = ''; style = { cssText: '' };
    parent?: Element;
    get parentNode() { return this.parent; }
    get textContent(): string { return this.text + this.children.map(c => c.textContent).join(''); }
    set textContent(value: string) { this.text = value; this.children.length = 0; }
    get lastElementChild() { return this.children[this.children.length - 1]; }
    readonly children: Element[] = [];
    readonly attributes = new Map<string, string>();
    setAttribute(key: string, value: string) { this.attributes.set(key, value); }
    addEventListener() {}
    append(...values: Element[]) { values.forEach(v => { v.remove(); v.parent = this; this.children.push(v); }); }
    insertBefore(node: Element, before: Element) { node.remove(); node.parent = this; this.children.splice(this.children.indexOf(before), 0, node); }
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); }
    replaceChildren() { this.children.length = 0; }
}

test('supervisor docks directly above the composer without moving chat or input nodes', () => {
    const body = new Element(), chat = new Element(), composer = new Element();
    body.append(chat, composer);
    mountSupervisorPanel({ body, createElement: () => new Element(),
        querySelector: (selector: string) => selector === '.input-container' ? composer : null } as unknown as Document, () => {});
    const dock = body.children.find(e => e.id === 'supervisor-dock')!;
    expect(body.children.indexOf(dock)).toBe(body.children.indexOf(composer) - 1);
    expect(dock.children.map(e => e.id)).toEqual(['supervisor-toggle', 'supervisor-panel']);
    expect(body.children[0]).toBe(chat); expect(composer.parentNode).toBe(body);
});

test('panel routes by selected session, preserves unknown values and never touches chat nodes', () => {
    const body = new Element();
    const chat = new Element(); chat.id = 'chat'; chat.textContent = 'existing final'; body.append(chat);
    let receive!: (message: unknown) => void;
    const document = { body, createElement: () => new Element(), querySelector: () => null } as unknown as Document;
    mountSupervisorPanel(document, callback => { receive = callback; });
    const content = body.children.find(element => element.id === 'supervisor-panel')!.children[1];
    receive({ type: 'supervisorSelection', sessionId: 'ses_A' });
    receive({ type: 'supervisorState', sessionId: 'ses_A', status: 'observed', view: snapshot() });
    expect(content.textContent).toContain('Waiting for permission'); expect(content.textContent).toContain('Last observation Unknown');
    receive({ type: 'supervisorState', sessionId: 'ses_A', status: 'unavailable' });
    expect(content.textContent).toContain('current state unknown');
    receive({ type: 'sessionData', sessionId: 'ses_B' });
    receive({ type: 'supervisorState', sessionId: 'ses_A', status: 'observed', view: snapshot() });
    expect(content.textContent).not.toContain('task_A');
    expect(chat.textContent).toBe('existing final'); expect(body.children[0]).toBe(chat);
});

test('projection labels previous instance as historical and never treats absence as a completed task', () => {
    expect(supervisorLines(snapshot(), true).join('\n')).toContain('current state unknown');
    const empty = snapshot(); empty.tasks = [];
    expect(supervisorLines(empty).join('\n')).toContain('No registered tasks');
    expect(supervisorLines(empty).join('\n')).not.toContain('Confirmed stopped');
});

test('normal panel shows disabled state, retains old-instance evidence and fences other sessions', () => {
    const body = new Element();
    let receive!: (message: unknown) => void;
    const document = { body, createElement: () => new Element(),
        querySelector: () => ({ getAttribute: () => 'disabled' }) } as unknown as Document;
    mountSupervisorPanel(document, callback => { receive = callback; });
    const button = body.children.find(element => element.id === 'supervisor-toggle')!;
    const content = body.children.find(element => element.id === 'supervisor-panel')!.children[1];
    expect(button.textContent).toContain('Disabled');
    receive({ type: 'supervisorSelection', sessionId: 'ses_A' });
    expect(content.textContent).toContain('the backend plugin and tasks may still be running');
    for (const status of ['connecting', 'unavailable', 'incompatible', 'disconnected', 'connected']) {
        receive({ type: 'supervisorConnectionStatus', mode: 'normal', status });
        expect(button.textContent).not.toContain('Experimental');
        if (status === 'incompatible') {
            expect(content.textContent).toContain('1.18.29, 1.18.31');
            expect(content.textContent).toContain('Update both GUI and OpenCodeTaskSupervisor');
            expect(content.textContent).toContain('services will not restart automatically');
        }
        if (status === 'unavailable') {
            expect(content.textContent).toContain('Unsupported OpenCode version');
            expect(content.textContent).toContain('updating GUI alone cannot fix an old plugin');
        }
    }
    receive({ type: 'supervisorState', sessionId: 'ses_A', status: 'observed', view: snapshot() });
    const next = snapshot(); next.instanceId = 'instance_B'; next.tasks = [];
    receive({ type: 'supervisorState', sessionId: 'ses_A', status: 'observed', view: next });
    expect(content.textContent).toContain('instance_A');
    expect(content.textContent).toContain('No registered tasks');
    expect(content.children[3].hidden).toBe(false);
    expect(content.children[3].open).toBe(false);
    expect(content.textContent).toContain('current state unknown');
    receive({ type: 'supervisorConnectionStatus', mode: 'normal', status: 'disabled' });
    expect(content.textContent).toContain('instance_A');
    expect(content.textContent).toContain('the backend plugin and tasks may still be running');
    receive({ type: 'sessionData', sessionId: 'ses_B' });
    receive({ type: 'supervisorState', sessionId: 'ses_A', status: 'observed', view: snapshot() });
    expect(content.textContent).not.toContain('task_A');
});

test('task cards hide IDs, render names as text, preserve details and scroll on refresh, and discard stale status colors', () => {
    const body = new Element(); let receive!: (message: unknown) => void;
    mountSupervisorPanel({ body, createElement: () => new Element(), querySelector: () => null } as unknown as Document,
        callback => { receive = callback; });
    const panel = body.children.find(e => e.id === 'supervisor-panel')!, content = panel.children[1];
    receive({ type: 'supervisorSelection', sessionId: 'ses_A' });
    const view = snapshot(); view.tasks[0].title = '<img src=x onerror=alert(1)> Check R1 (@coder subagent)';
    receive({ type: 'supervisorState', sessionId: 'ses_A', status: 'observed', view });
    const card = content.children[1].children[0], [name, badge, , details] = card.children;
    expect(name.textContent).toBe('<img src=x onerror=alert(1)> Check R1'); expect(name.children).toHaveLength(0);
    expect(details.open).toBe(false);
    expect(card.children.slice(0, 3).map(e => e.textContent).join('')).not.toMatch(/task_A|ses_child|instance_A/);
    expect(details.textContent).toContain('task_A');
    details.open = true; panel.scrollTop = 87;
    view.tasks[0].health = 'running'; view.tasks[0].lastProgressAgeMs = 7000;
    receive({ type: 'supervisorState', sessionId: 'ses_A', status: 'observed', view });
    expect(content.children[1].children[0]).toBe(card); expect(details.open).toBe(true); expect(panel.scrollTop).toBe(87);
    expect(badge.textContent).toBe('Running'); expect(badge.attributes.get('data-tone')).toBe('info');
    receive({ type: 'supervisorState', sessionId: 'ses_A', status: 'unavailable' });
    expect(badge.textContent).toBe('Unknown · historical'); expect(badge.attributes.get('data-tone')).toBe('muted');
    receive({ type: 'supervisorSelection', sessionId: 'ses_B' });
    expect(content.textContent).not.toContain('Check R1'); expect(panel.scrollTop).toBe(0);
});

test('outcomes, permission waits, stalls and observation failures have distinct honest status labels', () => {
    const task = snapshot().tasks[0];
    expect(taskStatus(task, false)).toEqual({ label: 'Waiting for permission', tone: 'warning' });
    expect(taskStatus({ ...task, health: 'suspected_stall' }, false)).toEqual({ label: 'Suspected stall', tone: 'warning' });
    expect(taskStatus({ ...task, health: 'unreachable' }, false).tone).toBe('danger');
    expect(taskStatus({ ...task, phase: 'terminal', outcome: 'failed' }, false)).toEqual({ label: 'Failed', tone: 'danger' });
    expect(taskStatus({ ...task, phase: 'terminal', outcome: 'completed' }, false)).toEqual({ label: 'Completed', tone: 'success' });
    expect(taskStatus({ ...task, phase: 'terminal', outcome: null }, false).label).toBe('Ended');
    expect(taskStatus({ ...task, phase: 'terminal', outcome: 'completed' }, true).tone).toBe('muted');
});

test('display titles are optional, bounded and never admit unrelated prompt fields', () => {
    const view = snapshot(); expect(view.tasks[0].title).toBeNull();
    expect(parseSupervisorView({ ...view, tasks: [{ ...view.tasks[0], title: 'Check R1', prompt: 'private' }] }).tasks[0].title).toBe('Check R1');
    expect(JSON.stringify(parseSupervisorView({ ...view, tasks: [{ ...view.tasks[0], prompt: 'private' }] }))).not.toContain('private');
    for (const title of ['x'.repeat(501), 'bad\nname', 123])
        expect(() => parseSupervisorView({ ...view, tasks: [{ ...view.tasks[0], title }] })).toThrow();
});

test('repeated connection heartbeats do not invalidate observed cards, while real disconnects do', () => {
    const body = new Element(); let receive!: (message: unknown) => void;
    mountSupervisorPanel({ body, createElement: () => new Element(), querySelector: () => null } as unknown as Document,
        callback => { receive = callback; });
    const content = body.children.find(e => e.id === 'supervisor-panel')!.children[1];
    const connected = { type: 'supervisorConnectionStatus', mode: 'normal', status: 'connected' };
    receive(connected); receive({ type: 'supervisorSelection', sessionId: 'ses_A' });
    const view = snapshot(); view.tasks[0].health = 'running';
    const observed = { type: 'supervisorState', sessionId: 'ses_A', status: 'observed', view };
    receive(observed);
    const card = content.children[1].children[0], badge = card.children[1];
    for (let i = 0; i < 3; i++) {
        receive(connected); expect(badge.textContent).toBe('Running');
        expect(content.children[0].textContent).toBe('Live observations · Read-only');
        receive(observed); expect(content.children[1].children[0]).toBe(card);
    }
    receive({ ...connected, status: 'disconnected' });
    expect(badge.attributes.get('data-tone')).toBe('muted');
    receive(connected); expect(badge.attributes.get('data-tone')).toBe('muted');
    receive(observed); expect(badge.textContent).toBe('Running');
    receive({ type: 'supervisorState', sessionId: 'ses_A', status: 'unavailable' });
    receive(connected); expect(badge.attributes.get('data-tone')).toBe('muted');
    receive({ type: 'supervisorSelection', sessionId: 'ses_B' });
    expect(content.children[0].textContent).toBe('Connected · Waiting for fresh observations');
    expect(content.children[1].children).toHaveLength(0);
});

test('task cards hide IDs, render names as text, preserve details and scroll on refresh, and discard stale status colors', () => {
    const body = new Element(); let receive!: (message: unknown) => void;
    mountSupervisorPanel({ body, createElement: () => new Element(), querySelector: () => null } as unknown as Document,
        callback => { receive = callback; });
    const panel = body.children.find(e => e.id === 'supervisor-panel')!, content = panel.children[1];
    receive({ type: 'supervisorSelection', sessionId: 'ses_A' });
    const view = snapshot(); view.tasks[0].title = '<img src=x onerror=alert(1)> Check R1 (@coder subagent)';
    receive({ type: 'supervisorState', sessionId: 'ses_A', status: 'observed', view });
    const card = content.children[1].children[0], [name, badge, , details] = card.children;
    expect(name.textContent).toBe('<img src=x onerror=alert(1)> Check R1'); expect(name.children).toHaveLength(0);
    expect(details.open).toBe(false);
    expect(card.children.slice(0, 3).map(e => e.textContent).join('')).not.toMatch(/task_A|ses_child|instance_A/);
    expect(details.textContent).toContain('task_A');
    details.open = true; panel.scrollTop = 87;
    view.tasks[0].health = 'running'; view.tasks[0].lastProgressAgeMs = 7000;
    receive({ type: 'supervisorState', sessionId: 'ses_A', status: 'observed', view });
    expect(content.children[1].children[0]).toBe(card); expect(details.open).toBe(true); expect(panel.scrollTop).toBe(87);
    expect(badge.textContent).toBe('Running'); expect(badge.attributes.get('data-tone')).toBe('info');
    receive({ type: 'supervisorState', sessionId: 'ses_A', status: 'unavailable' });
    expect(badge.textContent).toBe('Unknown · historical'); expect(badge.attributes.get('data-tone')).toBe('muted');
    receive({ type: 'supervisorSelection', sessionId: 'ses_B' });
    expect(content.textContent).not.toContain('Check R1'); expect(panel.scrollTop).toBe(0);
});

test('outcomes, permission waits, stalls and observation failures have distinct honest status labels', () => {
    const task = snapshot().tasks[0];
    expect(taskStatus(task, false)).toEqual({ label: 'Waiting for permission', tone: 'warning' });
    expect(taskStatus({ ...task, health: 'suspected_stall' }, false)).toEqual({ label: 'Suspected stall', tone: 'warning' });
    expect(taskStatus({ ...task, health: 'unreachable' }, false).tone).toBe('danger');
    expect(taskStatus({ ...task, phase: 'terminal', outcome: 'failed' }, false)).toEqual({ label: 'Failed', tone: 'danger' });
    expect(taskStatus({ ...task, phase: 'terminal', outcome: 'completed' }, false)).toEqual({ label: 'Completed', tone: 'success' });
    expect(taskStatus({ ...task, phase: 'terminal', outcome: null }, false).label).toBe('Ended');
    expect(taskStatus({ ...task, phase: 'terminal', outcome: 'completed' }, true).tone).toBe('muted');
});

test('display titles are optional, bounded and never admit unrelated prompt fields', () => {
    const view = snapshot(); expect(view.tasks[0].title).toBeNull();
    expect(parseSupervisorView({ ...view, tasks: [{ ...view.tasks[0], title: 'Check R1', prompt: 'private' }] }).tasks[0].title).toBe('Check R1');
    expect(JSON.stringify(parseSupervisorView({ ...view, tasks: [{ ...view.tasks[0], prompt: 'private' }] }))).not.toContain('private');
    for (const title of ['x'.repeat(501), 'bad\nname', 123])
        expect(() => parseSupervisorView({ ...view, tasks: [{ ...view.tasks[0], title }] })).toThrow();
});
