import { supervisorTone } from '../supervisor/panel';
import { mountSupervisorPanel, supervisorLines } from '../supervisor/panel';
import { parseSupervisorView } from '../../src/supervisor/protocol';
import { taskStatus } from '../supervisor/cards';
import { processStatus, processMetrics } from '../supervisor/processes';

const snapshot = () => parseSupervisorView({ schemaVersion: 1, isolationId: 'lab_A', instanceId: 'instance_A', revision: 1,
    pluginVersion: '0.1.0', openCodeVersion: '1.18.29', observedAt: '2026-09-20T00:00:00.000Z', parentSessionId: 'ses_A',
    scope: 'isolated_allowlisted_commands', tasks: [{ taskId: 'task_A', attemptId: 'attempt_A', parentSessionId: 'ses_A', childSessionId: 'ses_child',
        phase: 'active', health: 'waiting_permission', outcome: null, lastObservationAgeMs: null, lastProgressAgeMs: 1000 }],
    executions: [], notifications: [], notificationIdentities: [] });
class Element {
    id = ''; private text = ''; hidden = false; disabled = false; open = false; scrollTop = 0; className = ''; style = { cssText: '' };
    parent?: Element;
    get parentNode() { return this.parent; }
    get nextSibling(): Element | null { return this.parent?.children[this.parent.children.indexOf(this) + 1] ?? null; }
    get textContent(): string { return this.text + this.children.map(c => c.textContent).join(''); }
    set textContent(value: string) { this.text = value; this.children.length = 0; }
    get lastElementChild() { return this.children[this.children.length - 1]; }
    readonly children: Element[] = [];
    readonly attributes = new Map<string, string>();
    setAttribute(key: string, value: string) { this.attributes.set(key, value); }
    readonly listeners = new Map<string, () => void>();
    addEventListener(type: string, handler: () => void) { this.listeners.set(type, handler); }
    click() { this.listeners.get('click')?.(); }
    append(...values: Element[]) { values.forEach(v => { v.remove(); v.parent = this; this.children.push(v); }); }
    insertBefore(node: Element, before: Element | null) { node.remove(); node.parent = this; this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, node); }
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

test('variant switch follows settings, hides disabled overlay, and waits for acknowledgement', () => {
    const body = new Element(), toolbar = new Element(), variant = new Element();
    toolbar.append(variant); body.append(toolbar);
    let receive!: (message: unknown) => void; const send = jest.fn();
    mountSupervisorPanel({ body, createElement: () => new Element(),
        querySelector: (selector: string) => selector === '.variant-wrapper' ? variant :
            selector.startsWith('script') ? { getAttribute: () => 'disabled' } : null } as unknown as Document,
        callback => { receive = callback; }, send);
    const toggle = toolbar.children[1], label = body.children.find(e => e.id === 'supervisor-toggle')!;
    const panel = body.children.find(e => e.id === 'supervisor-panel')!;
    expect(toggle.id).toBe('supervisor-enable'); expect(toggle.attributes.get('aria-checked')).toBe('false');
    expect(label.hidden).toBe(true);
    toggle.click(); toggle.click(); expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith({ type: 'setSupervisorEnabled', enabled: true });
    expect(toggle.disabled).toBe(true); expect(label.hidden).toBe(true);
    receive({ type: 'supervisorToggleResult', enabled: true });
    expect(toggle.disabled).toBe(false); expect(label.hidden).toBe(false);
    receive({ type: 'supervisorConnectionStatus', mode: 'normal', status: 'connected' });
    label.click(); expect(panel.hidden).toBe(false);
    toggle.click(); expect(send).toHaveBeenLastCalledWith({ type: 'setSupervisorEnabled', enabled: false });
    receive({ type: 'supervisorToggleResult', enabled: true, error: 'Could not save' });
    expect(toggle.attributes.get('aria-checked')).toBe('true'); expect(label.hidden).toBe(false);
    // The settings editor uses the same canonical flag.
    receive({ type: 'supervisorConnectionStatus', mode: 'normal', status: 'disabled' });
    expect(toggle.attributes.get('aria-checked')).toBe('false'); expect(label.hidden).toBe(true);
    expect(panel.hidden).toBe(true); expect(label.attributes.get('aria-expanded')).toBe('false');
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
            expect(content.textContent).toContain('protocol or service identity mismatch');
            expect(content.textContent).toContain('API compatibility');
            expect(content.textContent).toContain('services will not restart automatically');
        }
        if (status === 'unavailable') {
            expect(content.textContent).toContain('Unsupported OpenCode version');
            expect(content.textContent).toContain('updating GUI alone cannot remove its version allowlist');
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
    const card = content.children[1].children[0], [name, badge, , , details] = card.children;
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
    const card = content.children[1].children[0], [name, badge, , , details] = card.children;
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

const processView = () => {
    const view = snapshot();
    return parseSupervisorView({ ...view, executions: [{ ...view.tasks[0], executionId: 'execution_A', toolCallId: 'call_A',
        displayName: 'python.exe', rootPid: 42, activeProcesses: 2, durationMs: 12000, cpuPercent: 125.5, workingSetBytes: '2097152', exitCode: null,
        phase: 'running', health: 'running', lastObservationAgeMs: 0, lastActivityAgeMs: 100,
        rootExited: false, ownedProcessesStopped: false, cpu100ns: '100', cpuDelta100ns: '10',
        readBytes: '0', writeBytes: '0', readDeltaBytes: '0', writeDeltaBytes: '0',
        cancelRequested: false, requestAccepted: null, cancelOutcomeUnknown: false, coverageUnknown: false, safeToRetry: false,
        command: 'private command', stdout: 'private output',
    }] });
};

test('process metrics and state distinguish root exit, descendants, quiet, unknown and historical evidence', () => {
    const e = processView().executions[0];
    expect(processMetrics(e, false)).toContain('CPU 125.5%'); expect(processMetrics(e, false)).toContain('2.0 MiB');
    expect(processStatus(e, false).label).toBe('Running');
    expect(processStatus({ ...e, rootExited: true }, false).label).toContain('descendants');
    expect(processStatus({ ...e, health: 'suspect' }, false).label).toContain('Quiet');
    expect(processStatus({ ...e, phase: 'stopped', exitCode: 7 }, false).tone).toBe('danger');
    expect(processStatus({ ...e, phase: 'stopped', exitCode: 0 }, false).tone).toBe('success');
    expect(processStatus(e, true).tone).toBe('muted'); expect(processMetrics(e, true)).not.toMatch(/CPU|MiB/);
    expect(processMetrics({ ...e, health: 'unknown' }, false)).not.toMatch(/CPU|MiB|live processes/);
    expect(JSON.stringify(processView())).not.toMatch(/private command|private output/);
    for (const extra of [{ cpuPercent: -1 }, { durationMs: Infinity }, { rootPid: '42' }, { displayName: 'bad\nname' }, { workingSetBytes: '-1' }])
        expect(() => parseSupervisorView({ ...processView(), executions: [{ ...e, ...extra }] })).toThrow();
});

test('process rows retain identity during refresh, escape labels, and follow session reset and stale observations', () => {
    const body = new Element(); let receive!: (message: unknown) => void;
    mountSupervisorPanel({ body, createElement: () => new Element(), querySelector: () => null } as unknown as Document,
        callback => { receive = callback; });
    receive({ type: 'supervisorSelection', sessionId: 'ses_A' });
    const view = processView(); view.executions[0].displayName = '<img src=x>';
    const observed = { type: 'supervisorState', sessionId: 'ses_A', status: 'observed', view };
    receive(observed);
    const content = body.children.find(e => e.id === 'supervisor-panel')!.children[1];
    const card = content.children[1].children[0], row = card.children[3].children[0];
    expect(row.children[0].textContent).toBe('<img src=x>'); expect(row.children[0].children).toHaveLength(0);
    expect(row.textContent).not.toMatch(/execution_A|call_A|private/);
    view.executions[0].cpuPercent = 50; receive(observed);
    expect(card.children[3].children[0]).toBe(row); expect(row.textContent).toContain('CPU 50.0%');
    receive({ type: 'supervisorState', sessionId: 'ses_A', status: 'unavailable' });
    expect(row.children[1].attributes.get('data-tone')).toBe('muted'); expect(row.textContent).not.toContain('CPU');
    receive({ type: 'supervisorSelection', sessionId: 'ses_B' }); expect(content.textContent).not.toContain('<img src=x>');
});


test('supervisor icon distinguishes healthy, attention, failure and missing evidence', () => {
    const view = snapshot();
    expect(supervisorTone()).toBe('unknown');
    expect(supervisorTone(view)).toBe('attention');
    view.tasks.forEach(t => { t.health = 'running'; t.outcome = null; });
    view.executions = []; view.notifications = [];
    expect(supervisorTone(view)).toBe('healthy');
    view.tasks[0].health = 'suspected_stall';
    expect(supervisorTone(view)).toBe('attention');
    view.tasks[0].outcome = 'failed';
    expect(supervisorTone(view)).toBe('error');
});
