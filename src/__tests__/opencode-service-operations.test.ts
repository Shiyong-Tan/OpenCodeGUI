import { OpenCodeServerController } from '../transport/OpenCodeServerController';
import type { OpenCodeServerProcess } from '../transport/OpenCodeServerProcess';
import type { OpenCodeServerLockStore } from '../transport/OpenCodeServerLockStore';
import type { OpenCodeServiceRecordStore, OwnedServiceRecord } from '../transport/OpenCodeServiceRecordStore';

function fixture(options: { foreign?: boolean; unknownStart?: boolean; stopUnknown?: boolean } = {}) {
    const lock = { workspaceRoot: 'C:\\trial', port: 42000, password: 'fixture-password', updatedAt: 'now' };
    const original: OwnedServiceRecord = { schemaVersion: 1, generation: 1, serviceId: 'a'.repeat(64),
        workspace: 'c:/trial', port: 42000, authenticationHash: 'b'.repeat(64), intentionallyStopped: false,
        process: options.unknownStart ? undefined : { serviceId: 'a'.repeat(64), pid: 123, creationFileTime: '133700000000000000' } };
    let current: OwnedServiceRecord | undefined = options.foreign ? undefined : original;
    let running = true;
    const order: string[] = [];
    const records = {
        current: jest.fn(async () => current), workspaceKey: jest.fn(async () => 'c'.repeat(64)), matches: jest.fn(() => true),
        begin: jest.fn(async () => { order.push('begin'); current = { ...original, serviceId: 'd'.repeat(64), generation: 2, process: undefined }; return current; }),
        register: jest.fn(async (_workspace, process) => { current = { ...current!, process }; }),
        markStopped: jest.fn(async () => { current = { ...current!, intentionallyStopped: true }; }),
    };
    const release = jest.fn(async () => undefined);
    const processOwner = {
        acquireOperation: jest.fn(async () => release), getPid: jest.fn(() => undefined), detach: jest.fn(),
        clearRememberedPid: jest.fn(), shutdown: jest.fn(), start: jest.fn(),
        inspectOwned: jest.fn(async (_identity, stop = false) => {
            if (stop) { order.push('stop'); if (!options.stopUnknown) running = false; }
            return { state: stop && options.stopUnknown ? 'stop_unknown' : running ? 'running' : 'stopped', rootExited: !running, activeProcesses: running ? 1 : 0, listenerOwned: running };
        }),
        startOwned: jest.fn(async (_spec, _cwd, _password, serviceId, register) => {
            order.push('start'); await register({ serviceId, pid: 124, creationFileTime: '133700000000000001' }); running = true; return 124;
        }),
    };
    const activity = jest.fn(async (): Promise<'idle' | 'active'> => 'idle');
    const connectionChanged = jest.fn();
    const controller = new OpenCodeServerController({
        locks: { readOrCreate: async () => ({ lock, mtimeMs: 1 }), buildAuthHeader: () => 'Basic fixture', updateCache: jest.fn(),
            getMigrationPorts: () => [], write: async () => 1 } as unknown as OpenCodeServerLockStore,
        process: processOwner as unknown as OpenCodeServerProcess,
        ownedRecords: records as unknown as OpenCodeServiceRecordStore, activity, connectionChanged,
        buildServeSpawn: async () => ({ command: 'fixture.exe', args: ['serve'] }),
        fetchHealth: async () => new Response(null, { status: running ? 200 : 503 }),
        stopEventStream: jest.fn(), log: jest.fn(), showError: jest.fn(),
    });
    return { controller, records, processOwner, activity, order, release, connectionChanged,
        replace: () => { current = { ...original, serviceId: 'e'.repeat(64) }; } };
}

test('restart confirms old Job stopped before persisting and launching a replacement', async () => {
    const f = fixture();
    await expect(f.controller.operate('C:\\trial', 'restart', jest.fn())).resolves.toBe('restarted');
    expect(f.order).toEqual(['stop', 'begin', 'start']);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.connectionChanged).toHaveBeenCalled();
});

test('external services and unknown prior starts cannot be stopped or replaced', async () => {
    for (const options of [{ foreign: true }, { unknownStart: true }]) {
        const f = fixture(options);
        await expect(f.controller.operate('C:\\trial', 'restart', jest.fn())).rejects.toThrow();
        expect(f.processOwner.inspectOwned.mock.calls.some(call => call[1])).toBe(false);
        expect(f.records.begin).not.toHaveBeenCalled();
    }
});

test('unknown stop result forbids a replacement and never records success', async () => {
    const f = fixture({ stopUnknown: true });
    await expect(f.controller.operate('C:\\trial', 'restart', jest.fn())).rejects.toMatchObject({ reason: 'stop_result_unknown' });
    expect(f.records.begin).not.toHaveBeenCalled(); expect(f.records.markStopped).not.toHaveBeenCalled();
});

test('active refusal and activity arriving after idle both require confirmation', async () => {
    const refused = fixture(); refused.activity.mockResolvedValue('active');
    const no = jest.fn(async () => false);
    await expect(refused.controller.operate('C:\\trial', 'stop', no)).rejects.toMatchObject({ reason: 'active_operation_not_confirmed' });
    expect(refused.order).toEqual([]);
    const f = fixture(); f.activity.mockResolvedValueOnce('idle').mockResolvedValueOnce('active');
    const yes = jest.fn(async () => true);
    await expect(f.controller.operate('C:\\trial', 'stop', yes)).resolves.toBe('stopped');
    expect(yes).toHaveBeenCalledTimes(1);
});

test('duplicate command shares one operation; a changed service generation fences a waiting request', async () => {
    const f = fixture();
    const first = f.controller.operate('C:\\trial', 'stop', jest.fn());
    expect(f.controller.operate('C:\\trial', 'stop', jest.fn())).toBe(first);
    await first; expect(f.order).toEqual(['stop']);
    const changed = fixture();
    changed.processOwner.acquireOperation.mockImplementation(async () => { changed.replace(); return changed.release; });
    await expect(changed.controller.operate('C:\\trial', 'restart', jest.fn())).rejects.toMatchObject({ reason: 'operation_superseded' });
    expect(changed.order).toEqual([]);
});

test('activity query failure is conservative and does not issue a stop', async () => {
    const f = fixture(); f.activity.mockRejectedValue(new Error('query unavailable'));
    await expect(f.controller.operate('C:\\trial', 'stop', jest.fn())).rejects.toThrow('query unavailable');
    expect(f.order).toEqual([]); expect(f.release).toHaveBeenCalledTimes(1);
});

test('a foreign listener on an owned port cannot authorize a stop', async () => {
    const f = fixture();
    f.processOwner.inspectOwned.mockResolvedValue({ state: 'running', rootExited: false, activeProcesses: 1, listenerOwned: false });
    await expect(f.controller.operate('C:\\trial', 'restart', jest.fn())).rejects.toMatchObject({ reason: 'listener_ownership_unknown' });
    expect(f.order).toEqual([]);
});

test('a competing window mutex refusal cannot perform any service mutation', async () => {
    const f = fixture(); f.processOwner.acquireOperation.mockRejectedValue(new Error('operation_busy'));
    await expect(f.controller.operate('C:\\trial', 'restart', jest.fn())).rejects.toThrow('operation_busy');
    expect(f.order).toEqual([]);
});

test('expired active confirmation cannot stop a service when approval arrives late', async () => {
    jest.useFakeTimers();
    try {
        const f = fixture(); f.activity.mockResolvedValue('active');
        let approve!: (value: boolean) => void;
        const pending = f.controller.operate('C:\\trial', 'stop', () => new Promise(resolve => { approve = resolve; }));
        const assertion = expect(pending).rejects.toMatchObject({ reason: 'active_operation_not_confirmed' });
        await jest.advanceTimersByTimeAsync(15001); await assertion;
        approve(true); await jest.advanceTimersByTimeAsync(1);
        expect(f.order).toEqual([]); expect(f.release).toHaveBeenCalledTimes(1);
    } finally { jest.useRealTimers(); }
});

test('an explicit stop survives ensure and cannot silently restart', async () => {
    const f = fixture(); await f.controller.operate('C:\\trial', 'stop', jest.fn());
    await expect(f.controller.ensure('C:\\trial')).rejects.toMatchObject({ reason: 'service_explicitly_stopped' });
    expect(f.order).toEqual(['stop']);
    await expect(f.controller.operate('C:\\trial', 'stop', jest.fn())).resolves.toBe('stopped');
    expect(f.order).toEqual(['stop']);
});
