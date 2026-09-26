import { SupervisorActivationPending } from './ActivationPending';
import * as vscode from 'vscode';

/** VS Code workspace configuration remains the sole owner of the enabled flag. */
export async function updateSupervisorSetting(value: unknown, webview: vscode.Webview, activate?: () => Promise<void>): Promise<void> {
    const previous = vscode.workspace.getConfiguration('opencode').get<boolean>('supervisor.enabled', false);
    let error: string | undefined;
    if (typeof value !== 'boolean') error = 'Invalid Supervisor switch value.';
    else if (!vscode.workspace.workspaceFolders?.length && !vscode.workspace.workspaceFile)
        error = 'Open a workspace to change Supervisor settings.';
    else {
        try {
            await vscode.workspace.getConfiguration('opencode').update('supervisor.enabled', value, vscode.ConfigurationTarget.Workspace);
        } catch { error = 'Could not save the Supervisor workspace setting.'; }
        if (!error && value && activate) {
            try { await activate(); }
            catch (cause) {
                error = cause instanceof Error ? cause.message : 'Supervisor setup failed.';
                if (!(cause instanceof SupervisorActivationPending)) {
                    try { await vscode.workspace.getConfiguration('opencode').update('supervisor.enabled', previous, vscode.ConfigurationTarget.Workspace); }
                    catch { error += ' Could not restore the previous display setting.'; }
                }
            }
        }
    }
    const enabled = vscode.workspace.getConfiguration('opencode').get<boolean>('supervisor.enabled', false);
    await webview.postMessage({ type: 'supervisorToggleResult', enabled, ...(error ? { error } : {}) });
    if (error) void vscode.window.showErrorMessage(error);
}
