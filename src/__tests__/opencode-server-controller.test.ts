import { OpenCodeServerController } from '../transport/OpenCodeServerController';

function createLock(port = 42000) {
    return { workspaceRoot: '/workspace', port, password: 'secret', updatedAt: 'now' };
}

describe('OpenCode server controller', () => {
    test('reuses a healthy locked server without spawning', async () => {
        const lock = createLock();
        const processOwner = { getPid: jest.fn(), detach: jest.fn(), shutdown: jest.fn(), start: jest.fn(), clearRememberedPid: jest.fn() } as any;
        const locks = {
            portBase: 42000,
            portRange: 256,
            readOrCreate: jest.fn(async () => ({ lock, mtimeMs: 1 })),
            updateCache: jest.fn(),
            buildAuthHeader: () => 'Basic auth',
            getMigrationPorts: () => [42000],
            write: jest.fn(),
        } as any;
        const prepareSupervisorLaunch = jest.fn(async () => 'private-binding');
        const controller = new OpenCodeServerController({
            locks,
            process: processOwner,
            prepareSupervisorLaunch,
            buildServeSpawn: async () => ({ command: 'opencode', args: ['serve'] }),
            fetchHealth: async () => new Response(null, { status: 200 }),
            stopEventStream: () => undefined,
            log: () => undefined,
            showError: () => undefined,
        });
        await controller.ensure('/workspace');
        expect(processOwner.start).not.toHaveBeenCalled();
        expect(prepareSupervisorLaunch).not.toHaveBeenCalled();
        expect(controller.getBaseUrl()).toBe('http://127.0.0.1:42000');
        expect(locks.updateCache).toHaveBeenCalled();
    });

    afterEach(() => jest.useRealTimers());

    test.each(['ok', 'error', 'timeout'])('owned launch bounds supervision metadata: %s', async (mode) => {
        if (mode === 'timeout') jest.useFakeTimers();
        const lock = createLock();
        const processOwner = { getPid: jest.fn(() => 7), detach: jest.fn(), shutdown: jest.fn(), start: jest.fn(() => 7), clearRememberedPid: jest.fn() } as any;
        const locks = {
            portBase: 42000,
            portRange: 256,
            readOrCreate: jest.fn(async () => ({ lock, mtimeMs: 1 })),
            updateCache: jest.fn(),
            buildAuthHeader: () => 'Basic auth',
            getMigrationPorts: () => [42000],
            write: jest.fn(),
        } as any;
        const fetchHealth = jest.fn()
            .mockResolvedValueOnce(new Response(null, { status: 503 }))
            .mockResolvedValueOnce(new Response(null, { status: 200 }));
        const logs: string[] = [];
        const prepareSupervisorLaunch = jest.fn(async () => {
            if (mode === 'error') throw new Error('private-binding');
            if (mode === 'timeout') return new Promise<string>(() => undefined);
            return 'private-binding';
        });
        const controller = new OpenCodeServerController({
            locks,
            process: processOwner,
            prepareSupervisorLaunch,
            buildServeSpawn: async (args) => ({ command: 'opencode', args }),
            fetchHealth,
            stopEventStream: () => undefined,
            log: line => logs.push(line),
            showError: () => undefined,
            delay: async () => undefined,
        });
        const starting = controller.ensure('/workspace');
        if (mode === 'timeout') await jest.advanceTimersByTimeAsync(2000);
        await starting;
        expect(processOwner.start).toHaveBeenCalledWith(expect.objectContaining({ command: 'opencode' }), '/workspace', 'secret');
        expect(controller.getPid()).toBe(7);
        expect(prepareSupervisorLaunch).toHaveBeenCalledTimes(1);
        expect(prepareSupervisorLaunch).toHaveBeenCalledWith(lock);
        expect(processOwner.start.mock.calls[0][0].supervisorBinding).toBe(mode === 'ok' ? 'private-binding' : undefined);
        expect(logs.join(' ')).not.toContain('private-binding');
    });
});
