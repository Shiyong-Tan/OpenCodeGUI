import { canonicalWorkspace, signConnectionLease, verifyConnectionLease, type ConnectionLease } from '../normal-connection-protocol';
import { activateSupervisorService } from '../activate-service';

test('POSIX bindings preserve case and Windows bindings retain their spelling', () => {
    expect(canonicalWorkspace('/Users/A/Work/')).toBe('/Users/A/Work');
    expect(canonicalWorkspace('/')).toBe('/');
    expect(canonicalWorkspace('D:/Trial')).toBe('d:/trial');
    for (const value of ['relative', '//server/share', '/a/../b', '/a//b', '/a/./b']) expect(() => canonicalWorkspace(value)).toThrow();
    const binding = { workspace: '/Users/A/Work', integrationId: '11'.repeat(32), serviceId: '22'.repeat(32), serviceOrigin: 'http://127.0.0.1:42001' };
    const lease: ConnectionLease = { ...binding, schemaVersion: 1, kind: 'normal-gui', instanceId: '33'.repeat(32), bridgeOrigin: 'http://127.0.0.1:42002', opencodeVersion: '1.18.31', pluginVersion: '0.1.0', issuedAt: 1000, expiresAt: 2000 };
    const signed = signConnectionLease(lease, '44'.repeat(32));
    expect(verifyConnectionLease(signed, binding, '44'.repeat(32), 1500).workspace).toBe(binding.workspace);
    expect(() => verifyConnectionLease(signed, { ...binding, workspace: '/users/a/work' }, '44'.repeat(32), 1500)).toThrow();
});
test.each(['darwin'] as const)('%s activation never invokes native service controls', async platform => {
    const host = { ensure: jest.fn(async () => {}), operate: jest.fn(async () => 'already_running'), checkWorkspace: jest.fn() };
    await activateSupervisorService(platform, host);
    expect(host.ensure).toHaveBeenCalledTimes(1); expect(host.operate).not.toHaveBeenCalled();
    host.checkWorkspace.mockImplementation(() => { throw new Error('workspace changed'); });
    await expect(activateSupervisorService(platform, host)).rejects.toThrow('workspace changed');
});
test.each(['win32', 'linux'] as const)('%s uses the guarded restart route', async platform => {
    const host = { ensure: jest.fn(async () => {}), operate: jest.fn(async () => 'already_running'), checkWorkspace: jest.fn() };
    await activateSupervisorService(platform, host);
    expect(host.operate.mock.calls).toEqual([['start'], ['restart']]); expect(host.ensure).not.toHaveBeenCalled();
});
