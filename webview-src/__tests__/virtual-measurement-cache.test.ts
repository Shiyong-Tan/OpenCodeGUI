import { createVirtualMeasurementCache } from '../features/virtual-measurement-cache';

describe('virtual measurement cache', () => {
  test('restores only matching revisions at the same viewport width', () => {
    let stored = '';
    let width = 900;
    const scheduled: Array<() => void> = [];
    const cache = createVirtualMeasurementCache({
      read: () => stored,
      write: (value) => { stored = value; },
      getWidth: () => width,
      now: () => 10,
      schedule: (callback) => { scheduled.push(callback); return 1; },
    });
    cache.remember('session-a', [
      { key: 'message-a', revision: 'revision-a', size: 321 },
      { key: 'message-b', revision: 'revision-b', size: 654 },
    ]);

    expect(cache.getInitial(
      'session-a',
      ['message-a', 'message-b'],
      ['revision-a', 'changed-revision'],
    )).toEqual([{ key: 'message-a', revision: 'revision-a', size: 321 }]);
    width = 700;
    expect(cache.getInitial('session-a', ['message-a'], ['revision-a'])).toEqual([]);
    scheduled.shift()?.();
    expect(stored).not.toContain('revision-a');
    expect(stored).not.toContain('revision-b');
  });

  test('loads persisted geometry and rejects malformed entries', () => {
    const stored = JSON.stringify({
      version: 1,
      sessions: [{
        sessionId: 'session-a',
        width: 800,
        updatedAt: 1,
        entries: [
          ['message-a', 't23q4q:a', 222],
          ['bad-size', 'digest', -1],
        ],
      }],
    });
    const cache = createVirtualMeasurementCache({
      read: () => stored,
      write: () => undefined,
      getWidth: () => 800,
    });

    expect(cache.getInitial('session-a', ['message-a'], ['revision-a'])).toEqual([
      { key: 'message-a', revision: 'revision-a', size: 222 },
    ]);
    expect(cache.getInitial('session-a', ['bad-size'], ['anything'])).toEqual([]);
  });
});
