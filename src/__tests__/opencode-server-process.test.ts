import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { OpenCodeServerProcess } from '../transport/OpenCodeServerProcess';

describe('OpenCode server process', () => {
    test('owns the serve process and preserves its environment contract', async () => {
        const child = Object.assign(new EventEmitter(), { pid: 43123 }) as ChildProcess;
        const spawn = jest.fn(() => child) as any;
        const processKill = jest.fn();
        const server = new OpenCodeServerProcess({ spawn, processKill, platform: 'linux' });
        expect(server.start({ command: 'opencode', args: ['serve', '--port', '42000'] }, '/workspace', 'secret'))
            .toBe(43123);
        expect(server.getPid()).toBe(43123);
        expect(spawn).toHaveBeenCalledWith('opencode', ['serve', '--port', '42000'], expect.objectContaining({
            cwd: '/workspace',
            shell: false,
            env: expect.objectContaining({ PYTHONIOENCODING: 'utf-8', OPENCODE_SERVER_PASSWORD: 'secret' }),
        }));
        await server.shutdown();
        expect(processKill).toHaveBeenCalledWith(43123, 'SIGTERM');
        expect(server.getPid()).toBeUndefined();
    });

    test('only the owning launch supplies private supervisor metadata', () => {
        const previous = process.env.OPENCODE_GUI_SUPERVISOR_BINDING;
        process.env.OPENCODE_GUI_SUPERVISOR_BINDING = 'foreign-binding';
        const spawn = jest.fn(() => Object.assign(new EventEmitter(), { pid: 43125 })) as any;
        const server = new OpenCodeServerProcess({ spawn });
        try {
            server.start({ command: 'opencode', args: ['serve'] }, '/workspace', 'secret');
            expect(spawn.mock.calls[0][2].env.OPENCODE_GUI_SUPERVISOR_BINDING).toBeUndefined();
            server.detach();
            server.start({ command: 'opencode', args: ['serve'], supervisorBinding: 'own-binding' }, '/workspace', 'secret');
            expect(spawn.mock.calls[1][2].env.OPENCODE_GUI_SUPERVISOR_BINDING).toBe('own-binding');
            expect(spawn.mock.calls[1][2].env.OPENCODE_SERVER_PASSWORD).toBe('secret');
        } finally {
            server.detach();
            if (previous === undefined) delete process.env.OPENCODE_GUI_SUPERVISOR_BINDING;
            else process.env.OPENCODE_GUI_SUPERVISOR_BINDING = previous;
        }
    });

    test('detach forgets ownership without terminating the old process', () => {
        const child = Object.assign(new EventEmitter(), { pid: 43124 }) as ChildProcess;
        const processKill = jest.fn();
        const server = new OpenCodeServerProcess({ spawn: (() => child) as any, processKill, platform: 'linux' });
        server.start({ command: 'opencode', args: ['serve'] }, '/workspace', 'secret');
        server.detach();
        expect(server.getPid()).toBeUndefined();
        expect(processKill).not.toHaveBeenCalled();
    });
});


test('Windows legacy PID-only shutdown refuses instead of calling taskkill', async () => {
    const exec = jest.fn();
    const owner = new OpenCodeServerProcess({ platform: 'win32', exec: exec as unknown as typeof import('child_process').exec,
        spawn: jest.fn(() => Object.assign(new EventEmitter(), { pid: 43129 })) as unknown as typeof import('child_process').spawn });
    owner.start({ command: 'fixture.exe', args: [] }, 'C:\\fixture', 'fixture-password');
    await expect(owner.shutdown()).rejects.toMatchObject({ reason: 'explicit_verified_operation_required' });
    expect(exec).not.toHaveBeenCalled();
    owner.detach();
});
