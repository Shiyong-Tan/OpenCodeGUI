import { mountSupervisorPanel, supervisorLines } from '../supervisor/panel';
import { parseSupervisorView } from '../../src/supervisor/protocol';

const snapshot = () => parseSupervisorView({ schemaVersion: 1, isolationId: 'lab_A', instanceId: 'instance_A', revision: 1,
    pluginVersion: '0.1.0', openCodeVersion: '1.18.29', observedAt: '2026-09-20T00:00:00.000Z', parentSessionId: 'ses_A',
    scope: 'isolated_allowlisted_commands', tasks: [{ taskId: 'task_A', attemptId: 'attempt_A', parentSessionId: 'ses_A', childSessionId: 'ses_child',
        phase: 'active', health: 'waiting_permission', outcome: null, lastObservationAgeMs: null, lastProgressAgeMs: 1000 }],
    executions: [], notifications: [], notificationIdentities: [] });
class Element {
    id = ''; textContent = ''; hidden = false; style = { cssText: '' };
    readonly children: Element[] = [];
    readonly attributes = new Map<string, string>();
    setAttribute(key: string, value: string) { this.attributes.set(key, value); }
    addEventListener() {}
    append(...values: Element[]) { this.children.push(...values); }
    replaceChildren() { this.children.length = 0; }
}

test('panel routes by selected session, preserves unknown values and never touches chat nodes', () => {
    const body = new Element();
    const chat = new Element(); chat.id = 'chat'; chat.textContent = 'existing final'; body.append(chat);
    let receive!: (message: unknown) => void;
    const document = { body, createElement: () => new Element(), querySelector: () => null } as unknown as Document;
    mountSupervisorPanel(document, callback => { receive = callback; });
    const content = body.children.find(element => element.id === 'supervisor-panel')!.children[1];
    receive({ type: 'supervisorSelection', sessionId: 'ses_A' });
    receive({ type: 'supervisorState', sessionId: 'ses_A', status: 'observed', view: snapshot() });
    expect(content.textContent).toContain('等待权限'); expect(content.textContent).toContain('最后观测 未知');
    receive({ type: 'supervisorState', sessionId: 'ses_A', status: 'unavailable' });
    expect(content.textContent).toContain('当前状态未知');
    receive({ type: 'sessionData', sessionId: 'ses_B' });
    receive({ type: 'supervisorState', sessionId: 'ses_A', status: 'observed', view: snapshot() });
    expect(content.textContent).not.toContain('task_A');
    expect(chat.textContent).toBe('existing final'); expect(body.children[0]).toBe(chat);
});

test('projection labels previous instance as historical and never treats absence as a completed task', () => {
    expect(supervisorLines(snapshot(), true).join('\n')).toContain('当前状态未知');
    const empty = snapshot(); empty.tasks = [];
    expect(supervisorLines(empty).join('\n')).toContain('没有已登记任务');
    expect(supervisorLines(empty).join('\n')).not.toContain('停止已确认');
});

test('normal panel shows disabled state, retains old-instance evidence and fences other sessions', () => {
    const body = new Element();
    let receive!: (message: unknown) => void;
    const document = { body, createElement: () => new Element(),
        querySelector: () => ({ getAttribute: () => 'disabled' }) } as unknown as Document;
    mountSupervisorPanel(document, callback => { receive = callback; });
    const button = body.children.find(element => element.id === 'supervisor-toggle')!;
    const content = body.children.find(element => element.id === 'supervisor-panel')!.children[1];
    expect(button.textContent).toContain('未启用');
    receive({ type: 'supervisorSelection', sessionId: 'ses_A' });
    expect(content.textContent).toContain('后端插件和任务可能仍在运行');
    for (const status of ['connecting', 'unavailable', 'incompatible', 'disconnected', 'connected']) {
        receive({ type: 'supervisorConnectionStatus', mode: 'normal', status });
        expect(button.textContent).not.toContain('实验');
        if (status === 'incompatible') {
            expect(content.textContent).toContain('1.18.29、1.18.31');
            expect(content.textContent).toContain('同时更新 GUI 和 OpenCodeTaskSupervisor');
            expect(content.textContent).toContain('不会自动重启服务');
        }
        if (status === 'unavailable') {
            expect(content.textContent).toContain('Unsupported OpenCode version');
            expect(content.textContent).toContain('仅更新 GUI 无法修复旧插件');
        }
    }
    receive({ type: 'supervisorState', sessionId: 'ses_A', status: 'observed', view: snapshot() });
    const next = snapshot(); next.instanceId = 'instance_B'; next.tasks = [];
    receive({ type: 'supervisorState', sessionId: 'ses_A', status: 'observed', view: next });
    expect(content.textContent).toContain('instance_A');
    expect(content.textContent).toContain('instance_B');
    expect(content.textContent).toContain('当前状态未知');
    receive({ type: 'supervisorConnectionStatus', mode: 'normal', status: 'disabled' });
    expect(content.textContent).toContain('instance_A');
    expect(content.textContent).toContain('后端插件和任务可能仍在运行');
    receive({ type: 'sessionData', sessionId: 'ses_B' });
    receive({ type: 'supervisorState', sessionId: 'ses_A', status: 'observed', view: snapshot() });
    expect(content.textContent).not.toContain('task_A');
});
