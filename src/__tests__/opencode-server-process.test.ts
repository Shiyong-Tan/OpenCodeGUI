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
