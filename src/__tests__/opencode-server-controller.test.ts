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
        const controller = new OpenCodeServerController({
            locks,
            process: processOwner,
            buildServeSpawn: async () => ({ command: 'opencode', args: ['serve'] }),
            fetchHealth: async () => new Response(null, { status: 200 }),
            stopEventStream: () => undefined,
            log: () => undefined,
            showError: () => undefined,
        });
        await controller.ensure('/workspace');
        expect(processOwner.start).not.toHaveBeenCalled();
        expect(controller.getBaseUrl()).toBe('http://127.0.0.1:42000');
        expect(locks.updateCache).toHaveBeenCalled();
    });

    test('starts the server and waits until health succeeds', async () => {
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
        const controller = new OpenCodeServerController({
            locks,
            process: processOwner,
            buildServeSpawn: async (args) => ({ command: 'opencode', args }),
            fetchHealth,
            stopEventStream: () => undefined,
            log: () => undefined,
            showError: () => undefined,
            delay: async () => undefined,
        });
        await controller.ensure('/workspace');
        expect(processOwner.start).toHaveBeenCalledWith(expect.objectContaining({ command: 'opencode' }), '/workspace', 'secret');
        expect(controller.getPid()).toBe(7);
    });
});
