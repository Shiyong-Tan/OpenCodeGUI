import * as vscode from 'vscode';
import { ServiceOperationError } from './WindowsServiceJob';

interface Host { operateService(action: 'start' | 'stop' | 'restart', confirm: (action: 'stop' | 'restart') => Promise<boolean>): Promise<string> }
const reasons: Record<string, string> = {
    external_service_not_owned: 'This service is external or has no GUI ownership record. It cannot be taken over or stopped.',
    ownership_connection_mismatch: 'The current connection does not match the owned service record. Operation refused.',
    prior_start_unknown: 'The previous start outcome is unknown. Retain diagnostics; a replacement service will not be started.',
    prior_execution_not_stopped: 'The previous service has not been confirmed stopped. A replacement service will not be started.',
    stop_result_unknown: 'The stop outcome is unknown. A replacement service will not be started.',
    activity_unknown: 'Task activity could not be verified. The service was not stopped or restarted.',
    active_operation_not_confirmed: 'Interruption of active tasks was not confirmed. The operation was cancelled or confirmation timed out.',
    operation_superseded: 'The service instance changed. The previous operation was refused; check the current service again.',
    operation_busy: 'Another window is operating on this workspace service. Try again shortly.',
    service_explicitly_stopped: 'The service was explicitly stopped. Run OpenCode: Start Service to continue.',
    service_control_unavailable: 'Verified service management is unavailable in this environment. It currently requires Windows.',
};

export function registerServiceCommands(context: vscode.ExtensionContext, host: Host): void {
    for (const action of ['start', 'stop', 'restart'] as const) {
        context.subscriptions.push(vscode.commands.registerCommand(`opencode.service.${action}`, async () => {
            try {
                const result = await host.operateService(action, async requested => {
                    const label = requested === 'restart' ? 'Restart Service' : 'Stop Service';
                    return await vscode.window.showWarningMessage(
                        'This workspace has running tasks or tasks waiting for permission. This operation will interrupt the service and its managed processes. Unsaved results may be lost. Tasks will not be automatically redispatched.',
                        { modal: true }, label) === label;
                });
                const message = result === 'stopped' ? 'OpenCode service is confirmed stopped. Run Start Service to resume chatting.' :
                    result === 'already_running' ? 'The GUI-owned OpenCode service is already running.' : result === 'restarted' ? 'OpenCode service restarted. Supervisor will reconnect and authenticate.' : 'OpenCode service started.';
                void vscode.window.showInformationMessage(message);
            } catch (error) {
                const reason = error instanceof ServiceOperationError ? error.reason : 'operation_failed';
                void vscode.window.showErrorMessage(reasons[reason] ?? `OpenCode service operation did not complete (${reason}). A replacement service will not be started while its state is uncertain.`);
            }
        }));
    }
}
