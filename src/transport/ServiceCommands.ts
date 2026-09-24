import * as vscode from 'vscode';
import { ServiceOperationError } from './WindowsServiceJob';

interface Host { operateService(action: 'start' | 'stop' | 'restart', confirm: (action: 'stop' | 'restart') => Promise<boolean>): Promise<string> }
const reasons: Record<string, string> = {
    external_service_not_owned: '这是外部或旧版未登记服务，无法证明归本 GUI 管理；不会接管或停止。',
    ownership_connection_mismatch: '当前连接与自有服务登记不匹配，操作已拒绝。',
    prior_start_unknown: '上次启动结果未知；请保留诊断，不会启动替代实例。',
    prior_execution_not_stopped: '旧服务尚未确认停止，不会启动替代实例。',
    stop_result_unknown: '停止结果未知，不会启动替代实例。',
    activity_unknown: '无法确认任务活动状态，未执行停止或重启。',
    active_operation_not_confirmed: '未确认中断活动任务，操作已取消或确认已超时。',
    operation_superseded: '服务实例已经变化，旧操作已拒绝；请重新检查当前服务。',
    operation_busy: '另一个窗口正在操作此工作区服务，请稍后重试。',
    service_explicitly_stopped: '服务已显式停止，请先执行 OpenCode: Start Service。',
    service_control_unavailable: '当前环境不支持安全的服务管理；首版仅支持 Windows 普通安装。',
};

export function registerServiceCommands(context: vscode.ExtensionContext, host: Host): void {
    for (const action of ['start', 'stop', 'restart'] as const) {
        context.subscriptions.push(vscode.commands.registerCommand(`opencode.service.${action}`, async () => {
            try {
                const result = await host.operateService(action, async requested => {
                    const label = requested === 'restart' ? '确认重启服务' : '确认停止服务';
                    return await vscode.window.showWarningMessage(
                        '当前工作区的 OpenCode 服务有执行中或等待权限的任务。此操作会中断服务及其受托管进程；未保存结果可能丢失。不会自动重派任务。',
                        { modal: true }, label) === label;
                });
                const message = result === 'stopped' ? 'OpenCode 服务已确认停止。使用 Start Service 后继续聊天。' :
                    result === 'already_running' ? 'OpenCode 自有服务已在运行。' : result === 'restarted' ? 'OpenCode 服务已重启；监督连接将重新认证。' : 'OpenCode 服务已启动。';
                void vscode.window.showInformationMessage(message);
            } catch (error) {
                const reason = error instanceof ServiceOperationError ? error.reason : 'operation_failed';
                void vscode.window.showErrorMessage(reasons[reason] ?? `OpenCode 服务操作未完成（${reason}）。状态不确定时不会启动替代实例。`);
            }
        }));
    }
}
