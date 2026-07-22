import * as fs from 'fs';
import * as path from 'path';
import { mapServerEventToChatEvents } from '../events/OpenCodeEventMapper';

describe('OpenCodeEventMapper', () => {
  test('OpenCodeClient keeps a single compatibility delegation', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'OpenCodeClient.ts'), 'utf8');
    expect(source).toMatch(/private mapServerEventToChatEvents\([\s\S]*?return mapServerEventToChatEvents\(this, type, props, source\);\s*}/);
  });

  test('maps session metadata without taking ownership of client state', () => {
    const host = {
      normalizeEvent: (type: string, _props: any, source: string) => ({
        type, source, lane: 'main', sessionId: 'session-a', messageId: undefined,
        parentId: undefined, finish: undefined, partType: undefined,
      }),
      logUiDebug: jest.fn(),
    };
    expect(mapServerEventToChatEvents(host, 'session.created', {
      info: { id: 'session-a', parentID: 'parent-a', mode: 'build', agent: 'worker', modelID: 'model-a' },
    }, 'resync')).toEqual([{
      type: 'session', sessionId: 'session-a', parentSessionId: 'parent-a',
      mode: 'build', agent: 'worker', modelID: 'model-a', source: 'resync',
    }]);
    expect(host.logUiDebug).toHaveBeenCalledTimes(1);
  });

  test('maps usage and preserves the idle lifecycle callback order', () => {
    const calls: string[] = [];
    const host = {
      normalizeEvent: (type: string, props: any, source: string) => ({
        type, source, lane: 'main', sessionId: props.sessionID,
      }),
      logUiDebug: (value: string) => calls.push(value.includes('session.idle.received')
        ? 'idle-log' : (value.includes('session.status.detail') ? 'status-detail' : 'normalized-log')),
      sessionIdleReceivedBySession: { add: () => calls.push('idle-store') },
      canceledActiveTurnBySession: new Map(),
      turnStateBySession: new Map([['session-a', {}]]),
      markTurnFinal: () => calls.push('mark-final'),
    };
    const events = mapServerEventToChatEvents(host, 'session.status', {
      sessionID: 'session-a', status: { type: 'idle', used: 12, size: 100, cost: { amount: 0.25 } },
    }, 'resync');
    expect(events).toEqual([{
      type: 'sessionUsage', sessionId: 'session-a', usage: { used: 12, size: 100, amount: 0.25 }, source: 'resync',
    }]);
    expect(calls).toEqual(['normalized-log', 'status-detail', 'idle-store', 'idle-log', 'mark-final']);
  });

  test('requires exact canonical append-successor admission before bypassing the finished guard', () => {
    const host: any = { normalizeEvent: (_t: string, props: any) => ({ sessionId: props.info.sessionID, messageId: props.info.id, parentId: props.info.parentID, type: 'message.updated', lane: 'unknown' }), tryBindAppendSuccessor: () => undefined, getActiveAppendSuccessor: () => undefined, isActiveAppendSuccessorEvent: () => false, logUiDebug: jest.fn(), turnFinishedBySession: new Set(['ses']), resolveBackgroundPulseTarget: () => undefined };
    expect(mapServerEventToChatEvents(host, 'message.updated', { info: { sessionID: 'ses', id: 'msg', parentID: 'msg_parent', role: 'assistant' } }, 'sse')).toEqual([]);
  });
});
