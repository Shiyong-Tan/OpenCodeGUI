jest.mock('vscode', () => ({ window: { createOutputChannel: () => ({ appendLine() {} }) }, workspace: {} }), { virtual: true });
import { OpenCodeClient } from '../OpenCodeClient';
import { handleSidebarChatEvent } from '../events/SidebarChatEventHandler';

function harness() {
    const client = Object.create(OpenCodeClient.prototype) as any;
    const a = {}, b = {};
    Object.assign(client, { currentSessionId: 'B', turnStateBySession: new Map([['A', a], ['B', b]]),
        turnFinalWaitersBySession: new Map([['A', [jest.fn()]], ['B', [jest.fn()]]]),
        getServerConn: jest.fn(async () => ({ lock: { port: 123, password: 'test' } })),
        checkServerHealth: jest.fn(async () => 'unreachable'), emitChatEvents: jest.fn(), logUiDebug: jest.fn(),
        updateServerStatus: jest.fn(), triggerImmediateResyncForAwaitingFinals: jest.fn(),
        restartServerFromEventFailure: jest.fn(), scheduleSessionResyncLimited: jest.fn() });
    return client;
}

test('service outage warns each owning waiting session once and does not restart or resolve tasks', async () => {
    const client = harness();
    await client.handleEventStreamFailure();
    await client.handleEventStreamFailure();
    expect(client.emitChatEvents.mock.calls.map(([events]: any[]) => [events[0].sessionId, events[0].type])).toEqual([
        ['A', 'serviceUnavailable'], ['B', 'serviceUnavailable'],
    ]);
    expect(client.restartServerFromEventFailure).not.toHaveBeenCalled();
    expect(client.turnFinalWaitersBySession.size).toBe(2);
    expect(client.turnFinalWaitersBySession.get('A')[0]).not.toHaveBeenCalled();
});

test('recovery is fenced against newer turns and never claims completion', async () => {
    const client = harness();
    await client.handleEventStreamFailure();
    client.emitChatEvents.mockClear();
    client.turnStateBySession.set('A', {});
    client.checkServerHealth.mockResolvedValue('ok');
    await client.handleEventStreamFailure();
    expect(client.emitChatEvents).toHaveBeenCalledTimes(1);
    expect(client.emitChatEvents.mock.calls[0][0][0]).toMatchObject({ sessionId: 'B', type: 'serviceRecovered' });
    expect(client.serviceOutageBySession.size).toBe(0);
});

test('connection failure before health also warns active turns; idle behavior stays separate', async () => {
    const client = harness();
    client.getServerConn.mockRejectedValue(new Error('unreachable'));
    await client.handleEventStreamFailure();
    expect(client.emitChatEvents).toHaveBeenCalledTimes(2);
    expect(client.restartServerFromEventFailure).not.toHaveBeenCalled();
    const idle = harness(); idle.turnFinalWaitersBySession.clear();
    await idle.handleEventStreamFailure();
    expect(idle.emitChatEvents).not.toHaveBeenCalled();
    expect(idle.restartServerFromEventFailure).toHaveBeenCalled();
});

test('outage UI routes to event session even while another session is visible', async () => {
    const webview = { postMessage: jest.fn() };
    const host = { _view: { webview }, smartSearchSessions: { owns: () => false } };
    await handleSidebarChatEvent(host as any, { type: 'serviceUnavailable', sessionId: 'A', text: 'Service unreachable' }, webview as any);
    expect(webview.postMessage).toHaveBeenCalledWith({ type: 'systemNotice', sessionId: 'A', level: 'warn', message: 'Service unreachable' });
});

test.each(['workspace', 'turn'])('late health failure cannot warn a replacement %s', async change => {
    const client = harness();
    let finish!: (health: string) => void;
    client.checkServerHealth.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = client.handleEventStreamFailure();
    await Promise.resolve();
    if (change === 'workspace') client.workspaceRoot = 'different';
    else { client.turnStateBySession.set('A', {}); client.turnFinalWaitersBySession.delete('B'); }
    finish('unreachable');
    await pending;
    expect(client.emitChatEvents).not.toHaveBeenCalled();
    expect(client.restartServerFromEventFailure).not.toHaveBeenCalled();
});
