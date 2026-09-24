import { SupervisorPanelController } from '../SupervisorPanelController';
import type { SupervisorReadResult } from '../SupervisorReader';
import { readFileSync } from 'fs';
import { resolve } from 'path';

test('late A projection never reaches B, including a pending session selection', async () => {
    let selection = { sessionId: 'ses_A', epoch: 1 };
    let release!: (result: SupervisorReadResult) => void;
    const publish = jest.fn();
    const controller = new SupervisorPanelController({ selection: () => selection,
        read: () => new Promise(resolve => { release = resolve; }), publish }, 60000);
    try {
        const pending = controller.tick();
        controller.selectionChanged('ses_B');
        await controller.tick();
        expect(publish.mock.calls.at(-1)?.[0]).toEqual({ type: 'supervisorSelection', sessionId: 'ses_B' });
        selection = { sessionId: 'ses_B', epoch: 2 };
        release({ status: 'unavailable', reason: 'read_failed' }); await pending;
        expect(publish.mock.calls.some(([message]) => message.type === 'supervisorState')).toBe(false);
    } finally { controller.dispose(); }
});

test('dispose fences a late projection and manifest declares one default-off experiment setting', async () => {
    let release!: (result: SupervisorReadResult) => void;
    const publish = jest.fn();
    const controller = new SupervisorPanelController({ selection: () => ({ sessionId: 'ses_A', epoch: 1 }),
        read: () => new Promise(resolve => { release = resolve; }), publish });
    const pending = controller.tick(); controller.dispose();
    release({ status: 'unavailable', reason: 'read_failed' }); await pending;
    expect(publish.mock.calls.some(([message]) => message.type === 'supervisorState')).toBe(false);
    const text = readFileSync(resolve(__dirname, '../../../package.json'), 'utf8');
    expect(text.match(/"configuration"\s*:/g)).toHaveLength(1);
    expect(JSON.parse(text).contributes.configuration.properties['opencode.experimentalSupervisor'].default).toBe(false);
});

test('normal disabled panel has no polling timer and rejects a pending read after disable', async () => {
    jest.useFakeTimers();
    let release!: (value: SupervisorReadResult) => void;
    const publish = jest.fn(), read = jest.fn(() => new Promise<SupervisorReadResult>(resolve => { release = resolve; }));
    let status = 'disabled';
    const panel = new SupervisorPanelController({ selection: () => ({ sessionId: 'ses_A', epoch: 1 }), read, publish,
        connectionStatus: () => status }, 2000, false);
    try {
        expect(jest.getTimerCount()).toBe(0);
        await jest.advanceTimersByTimeAsync(10000);
        expect(read).not.toHaveBeenCalled();
        status = 'connecting'; panel.setEnabled(true);
        await jest.advanceTimersByTimeAsync(2000);
        expect(read).toHaveBeenCalledTimes(1);
        status = 'disabled'; panel.setEnabled(false);
        expect(jest.getTimerCount()).toBe(0);
        release({ status: 'unavailable', reason: 'disposed' });
        await Promise.resolve(); await Promise.resolve();
        expect(publish.mock.calls.some(([message]) => message.type === 'supervisorState')).toBe(false);
        expect(publish.mock.calls.at(-1)?.[0]).toEqual({ type: 'supervisorConnectionStatus', mode: 'normal', status: 'disabled' });
    } finally { panel.dispose(); jest.useRealTimers(); }
});
