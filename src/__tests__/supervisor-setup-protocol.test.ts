jest.mock('vscode', () => ({ workspace: { isTrusted: true }, window: { createOutputChannel: () => ({ appendLine() {} }) } }), { virtual: true });
jest.mock('../supervisor/SupervisorSetup', () => ({ configureSupervisor: jest.fn(async () => false) }));
import { OpenCodeClient } from '../OpenCodeClient';
import { configureSupervisor } from '../supervisor/SupervisorSetup';

function harness(family: 'v1' | 'v2' = 'v2') {
    const host = Object.create(OpenCodeClient.prototype);
    Object.assign(host, {
        workspaceRoot: 'fixture',
        assertSupervisorSwitchIdle: jest.fn(async () => undefined),
        ensureServer: jest.fn(async () => {
            host.protocolBinding = { identity: { family }, isCurrent: () => true };
        }),
        getSupervisorStatus: jest.fn(() => 'connected'),
    });
    return host;
}
beforeEach(() => jest.clearAllMocks());

test.each(['v1', 'v2'] as const)('cold setup discovers %s before selecting the install format', async family => {
    const host = harness(family);
    expect(host.protocolBinding).toBeUndefined();
    await host.enableSupervisor();
    expect(configureSupervisor).toHaveBeenCalledWith('fixture', undefined, family);
    expect(host.assertSupervisorSwitchIdle).toHaveBeenCalledTimes(2);
});

test('discovery failure never writes configuration', async () => {
    const host = harness(); host.ensureServer.mockRejectedValue(new Error('unreachable'));
    await expect(host.enableSupervisor()).rejects.toThrow('unreachable');
    expect(configureSupervisor).not.toHaveBeenCalled();
});

test('stale or missing bindings never default to the legacy format', async () => {
    const host = harness(); host.ensureServer.mockResolvedValue(undefined);
    await expect(host.enableSupervisor()).rejects.toThrow('protocol could not be verified');
    expect(configureSupervisor).not.toHaveBeenCalled();
    host.protocolBinding = { identity: { family: 'v2' }, isCurrent: () => false };
    await expect(host.enableSupervisor()).rejects.toThrow('protocol could not be verified');
    expect(configureSupervisor).not.toHaveBeenCalled();
});

test('work starting during discovery blocks configuration changes', async () => {
    const host = harness(); host.assertSupervisorSwitchIdle.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('locked'));
    await expect(host.enableSupervisor()).rejects.toThrow('locked');
    expect(configureSupervisor).not.toHaveBeenCalled();
});
