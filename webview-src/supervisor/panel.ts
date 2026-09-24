import { parseSupervisorView, type SupervisorView } from '../../src/supervisor/protocol';

const age = (value: number | null): string => value === null ? '未知' : `${Math.floor(value / 1000)} 秒`;
const fact = (value: boolean | null): string => value === null ? '未知' : value ? '是' : '否';
const states: Record<string, string> = { registered: '已登记', dispatching: '派遣中', active: '执行中', terminal: '已结束',
    running: '运行', waiting_permission: '等待权限', suspected_stall: '疑似停滞', suspect: '疑似停滞',
    unreachable: '观测失联', ended: '已结束', cancel_unknown: '取消结果未知', unknown: '未知',
    starting: '启动中', stopped: '停止已确认', start_failed: '启动失败', permission_denied: '权限未获准',
    queued: '等待父处理', submitting: '提交中', submitted: '已提交，尚未确认接收', received: '父已接收',
    not_observed: '尚无父活动', activity_observed: '已观察父活动', result_read: '结果已读取' };
export function supervisorLines(view: SupervisorView, stale = false): string[] {
    const lines = [stale ? '观测失联或旧实例：以下为历史证据，当前状态未知' : '只读实时观测',
        `OpenCode ${view.openCodeVersion} / 插件 ${view.pluginVersion}`, `实例 ${view.instanceId}`];
    if (!view.tasks.length) lines.push('当前会话没有已登记任务');
    for (const task of view.tasks) {
        lines.push(`任务 ${task.taskId}`, `子会话 ${task.childSessionId ?? '尚未创建'}`,
            `${stale ? '上次' : ''}状态：${states[task.phase] ?? '未知'} / ${states[task.health] ?? '未知'}`,
            `最后观测 ${age(task.lastObservationAgeMs)}；最后活动 ${age(task.lastProgressAgeMs)}`);
        for (const e of view.executions.filter(item => item.taskId === task.taskId && item.attemptId === task.attemptId)) {
            lines.push(`执行 ${e.executionId}：${states[e.health] ?? '未知'}`,
                `进程采样 ${age(e.lastObservationAgeMs)}；活动 ${age(e.lastActivityAgeMs)}`,
                `CPU 增量 ${e.cpuDelta100ns ?? '未知'} ×100ns；读/写增量 ${e.readDeltaBytes ?? '未知'} / ${e.writeDeltaBytes ?? '未知'} 字节`,
                `根退出 ${fact(e.rootExited)}；受托管进程停止 ${fact(e.ownedProcessesStopped)}`,
                `取消请求已接受 ${fact(e.requestAccepted)}；取消结果${e.cancelOutcomeUnknown ? '未知' : '见停止证据'}`,
                'CPU/I/O 仅为活动证据，不证明计算正确；不提供重派操作');
        }
        for (const n of view.notifications.filter(item => item.taskId === task.taskId && item.attemptId === task.attemptId)) {
            lines.push(`通知 ${n.notificationId}：${states[n.delivery] ?? '未知'} / ${states[n.progress] ?? '未知'}`);
            lines.push('通知排队 ' + age(n.queueAgeMs) + '；提交后等待首次观测活动 ' + age(n.activityWaitAgeMs));
            if (n.escalated) lines.push('需要用户检查：父未完成规定的结果处理');
        }
    }
    return lines;
}

export function mountSupervisorPanel(document: Document, receive: (handler: (value: unknown) => void) => void): void {
    const button = document.createElement('button'); button.id = 'supervisor-toggle';
    button.textContent = '监督 · 实验'; button.setAttribute('aria-expanded', 'false');
    button.style.cssText = 'position:fixed;right:12px;top:42px;z-index:9000;font-size:12px;padding:4px 8px;';
    const panel = document.createElement('section'); panel.id = 'supervisor-panel'; panel.hidden = true;
    panel.setAttribute('aria-label', '实验监督器，只读');
    panel.style.cssText = 'position:fixed;right:8px;top:76px;bottom:90px;width:min(380px,calc(100vw - 16px));overflow:auto;z-index:9001;background:var(--vscode-editor-background);color:var(--vscode-foreground);border:1px solid var(--vscode-panel-border);padding:12px;box-sizing:border-box;white-space:pre-wrap;font-size:12px;';
    const title = document.createElement('h3'); title.textContent = '实验模式，仅预设受托管命令';
    const body = document.createElement('div'); body.id = 'supervisor-content'; body.textContent = '等待会话观测';
    panel.append(title, body); document.body.append(button, panel);
    button.addEventListener('click', () => { panel.hidden = !panel.hidden; button.setAttribute('aria-expanded', String(!panel.hidden)); });
    let sessionId: string | null = null;
    let current: SupervisorView | undefined;
    let previous: SupervisorView | undefined;
    let normal = false;
    let lastStatus = '';
    const historical = () => (previous ? supervisorLines(previous, true).join('\n') + '\n' : '') + (current ? supervisorLines(current, true).join('\n') : '');
    const connectionStates: Record<string, string> = { disabled: '未启用', unavailable: '未安装或不可用',
        connecting: '连接中', connected: '已连接', incompatible: '不兼容', disconnected: '已断开' };
    const connectionStatus = (status: unknown) => {
        if (typeof status !== 'string' || !connectionStates[status]) return;
        normal = true;
        lastStatus = status;
        button.textContent = '监督 · ' + connectionStates[status];
        panel.setAttribute('aria-label', '子任务监督器，只读');
        title.textContent = '子任务监督器 · ' + connectionStates[status];
        const hint = status === 'disabled' ? 'GUI 展示已关闭；后端插件和任务可能仍在运行。' :
            status === 'unavailable' ? '请检查插件安装；首次加载需要下一次正常服务启动，不会自动重启已有服务。' :
            status === 'incompatible' ? '当前仅支持 Windows / OpenCode 1.18.29。' : connectionStates[status];
        if (status !== 'connected') body.textContent = (current ? historical() + '\n' : '') + hint + '\n设置：OpenCode › Supervisor: Enabled';
    };
    connectionStatus(document.querySelector('script[data-supervisor-status]')?.getAttribute('data-supervisor-status'));
    const select = (id: string | null) => {
        if (sessionId === id) return;
        sessionId = id; current = undefined; previous = undefined; body.replaceChildren(); body.textContent = '等待会话观测';
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
            body.textContent = current ? historical() : '观测不可用，当前状态未知'; return;
        }
        try {
            const next = parseSupervisorView(message.view);
            if (next.parentSessionId !== sessionId) return;
            if (current && next.instanceId === current.instanceId && next.revision < current.revision) return;
            if (normal && current && next.instanceId !== current.instanceId) previous = current;
            if (!normal && current && next.instanceId !== current.instanceId) {
                body.textContent = supervisorLines(current, true).join('\n') + '\n实例已变化，请重新加载隔离窗口'; return;
            }
            current = next;
            // Only this overlay's text changes. Never rebuild, measure or scroll chat DOM.
            body.textContent = (previous ? supervisorLines(previous, true).join('\n') + '\n——当前服务实例——\n' : '') + supervisorLines(next).join('\n');
        } catch { body.textContent = '监督协议不可用，当前状态未知'; }
    });
}
