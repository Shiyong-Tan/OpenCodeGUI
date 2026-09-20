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
