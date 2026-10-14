import { SupervisorActivationPending } from '../ActivationPending';
jest.mock('vscode', () => ({
    workspace: { workspaceFolders: [{}], workspaceFile: undefined, getConfiguration: jest.fn() },
    ConfigurationTarget: { Workspace: 2, Global: 1 }, window: { showErrorMessage: jest.fn() },
}), { virtual: true });
import * as vscode from 'vscode';
import { updateSupervisorSetting } from '../SupervisorSetting';
import { createUtilityCommandHandler, type UtilityCommandHost } from '../../webview/controllers/UtilityCommandController';

const postMessage = jest.fn(async () => true);
const webview = { postMessage } as unknown as vscode.Webview;
let enabled = false;
const update = jest.fn(async (_key: string, value: boolean) => { enabled = value; });
beforeEach(() => {
    jest.clearAllMocks(); enabled = false;
    Object.assign(vscode.workspace, { workspaceFolders: [{}], workspaceFile: undefined });
    (vscode.workspace.getConfiguration as jest.Mock).mockReturnValue({ get: () => enabled, update });
});
test('utility command writes only workspace configuration and acknowledges canonical state', async () => {
    const handler = createUtilityCommandHandler({} as UtilityCommandHost);
    expect(await handler({ type: 'setSupervisorEnabled', enabled: true }, webview, webview)).toBe(true);
    expect(update).toHaveBeenCalledWith('supervisor.enabled', true, vscode.ConfigurationTarget.Workspace);
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'supervisorToggleResult', enabled: true });
    await updateSupervisorSetting(false, webview);
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'supervisorToggleResult', enabled: false });
});
test('a failed save rolls back the switch to the actual configuration', async () => {
    update.mockRejectedValueOnce(new Error('private filesystem details'));
    await updateSupervisorSetting(true, webview);
    expect(postMessage).toHaveBeenCalledWith({ type: 'supervisorToggleResult', enabled: false,
        error: 'Could not save the Supervisor workspace setting.' });
    expect(JSON.stringify(postMessage.mock.calls)).not.toContain('private filesystem');
});
test('missing workspace and malformed values never fall back to global configuration', async () => {
    Object.assign(vscode.workspace, { workspaceFolders: [] });
    await updateSupervisorSetting(true, webview);
    expect(update).not.toHaveBeenCalled();
    Object.assign(vscode.workspace, { workspaceFolders: [{}] });
    await updateSupervisorSetting('true', webview);
    expect(update).not.toHaveBeenCalled();
});


test('activation failure restores display state and disabling never installs or restarts', async () => {
    const activate = jest.fn(async () => { throw new Error('Release unavailable'); });
    await updateSupervisorSetting(true, webview, activate);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(enabled).toBe(false);
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'supervisorToggleResult', enabled: false, error: 'Release unavailable' });
    activate.mockClear();
    await updateSupervisorSetting(false, webview, activate);
    expect(activate).not.toHaveBeenCalled();
});


test('saved activation pending survives reload intent and can still be disabled', async () => {
    await updateSupervisorSetting(true, webview, async () => { throw new SupervisorActivationPending('launch_binding_missing'); });
    expect(enabled).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'supervisorToggleResult', enabled: true, error: 'launch_binding_missing' });
    await updateSupervisorSetting(false, webview);
    expect(enabled).toBe(false);
});

test('active or unverified task activity blocks both switch directions before any setting mutation', async () => {
    const activate = jest.fn(); const guard = jest.fn(async () => { throw new Error('Tasks are active'); });
    for (const value of [true, false]) await updateSupervisorSetting(value, webview, activate, guard);
    expect(update).not.toHaveBeenCalled(); expect(activate).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'supervisorToggleResult', enabled: false, busy: true, error: 'Tasks are active' });
});
