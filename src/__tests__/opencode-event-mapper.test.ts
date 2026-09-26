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

  test('CLI transport output cannot replace the explicitly selected session', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'OpenCodeClient.ts'), 'utf8');
    const start = source.indexOf('private handleCliOutputLine(');
    const end = source.indexOf('private resolveBin(', start);
    const handler = source.slice(start, end);
    expect(source).toContain('private executeStreaming(args: string[], sessionId: string');
    expect(source).toContain("throw new Error('Missing session ID for streaming process.')");
    expect(handler).toContain("const resolvedSessionId = sessionId || ownerSessionId;");
    expect(handler).not.toContain('this.currentSessionId');
    expect(handler).not.toContain('this.currentSessionId = sessionId;');
    expect(source).toContain('public setSessionId(sessionId: string | undefined): void');
  });

  test('maps usage and preserves the idle lifecycle callback order', () => {
    const calls: string[] = [];
    const host = {
      normalizeEvent: (type: string, props: any, source: string) => ({
        type, source, lane: 'main', sessionId: props.sessionID,
      }),
      logUiDebug: (value: string) => calls.push(value.includes('session.idle.received')
        ? 'idle-log' : (value.includes('session.idle.final')
          ? 'idle-final-log' : (value.includes('session.status.detail') ? 'status-detail' : 'normalized-log'))),
      sessionIdleReceivedBySession: { add: () => calls.push('idle-store') },
      canceledActiveTurnBySession: new Map(),
      turnStateBySession: new Map([['session-a', {}]]),
      handleSessionIdleFinal: (sessionId: string) => calls.push(`idle-final:${sessionId}`),
    };
    const events = mapServerEventToChatEvents(host, 'session.status', {
      sessionID: 'session-a', status: { type: 'idle', used: 12, size: 100, cost: { amount: 0.25 } },
    }, 'resync');
    expect(events).toEqual([{
      type: 'sessionUsage', sessionId: 'session-a', usage: { used: 12, size: 100, amount: 0.25 }, source: 'resync',
    }]);
    expect(calls).toEqual(['normalized-log', 'status-detail', 'idle-store', 'idle-log', 'idle-final:session-a']);
  });
});

test.each(['sse', 'resync'] as const)('trusted internal message is intercepted before append/final/text logic (%s)', source => {
  const host = {
    normalizeEvent: () => ({ sessionId: 'ses_A', lane: 'main' }),
    getTrustedSupervisorNotification: (session: string, id: string) => session === 'ses_A' && id === 'msg_notice' ? {} : undefined,
    logUiDebug: jest.fn(),
  };
  expect(mapServerEventToChatEvents(host, 'message.updated', { info: { id: 'msg_notice', role: 'user', sessionID: 'ses_A' } }, source)).toEqual([]);
  expect(mapServerEventToChatEvents(host, 'message.part.updated', { part: { messageID: 'msg_notice', type: 'text', text: 'arbitrary notification text' } }, source)).toEqual([]);
  expect(host.logUiDebug).not.toHaveBeenCalled();
});


test('permission lifecycle events survive a finished chat generation without reviving it', () => {
  const host = { normalizeEvent: () => ({ sessionId: 'ses_child', lane: 'subagent' }), logUiDebug: jest.fn(),
    resolveBackgroundPulseTarget: () => undefined, turnFinishedBySession: new Set(['ses_child']),
    rememberPendingPermission: jest.fn(), clearPendingPermission: jest.fn() };
  const asked = mapServerEventToChatEvents(host, 'permission.asked', { sessionID: 'ses_child', id: 'per_a', permission: 'read', patterns: ['fixture.txt'] });
  expect(asked).toEqual([expect.objectContaining({ type: 'permissionRequest', sessionId: 'ses_child', permissionId: 'per_a' })]);
  const replied = mapServerEventToChatEvents(host, 'permission.replied', { sessionID: 'ses_child', requestID: 'per_a', reply: 'reject' });
  expect(replied).toEqual([expect.objectContaining({ type: 'permissionReplied', sessionId: 'ses_child', permissionId: 'per_a' })]);
  expect(host.turnFinishedBySession.has('ses_child')).toBe(true);
});


test('question events survive finality without reopening the child turn', () => {
  const host = { normalizeEvent: () => ({ sessionId: 'ses_child', lane: 'subagent' }), logUiDebug: jest.fn(),
    resolveBackgroundPulseTarget: () => undefined, turnFinishedBySession: new Set(['ses_child']) };
  for (const event of ['question.asked', 'question.replied', 'question.rejected']) {
    expect(mapServerEventToChatEvents(host, event, { sessionID: 'ses_child', requestID: 'que_one' })).toEqual([{ type: 'questionChanged', sessionId: 'ses_child' }]);
  }
  expect(host.turnFinishedBySession.has('ses_child')).toBe(true);
});
