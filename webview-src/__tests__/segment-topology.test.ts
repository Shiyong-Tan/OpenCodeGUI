import { createSegmentTopology } from '../features/segments/segment-topology';

function createTopology() {
  const debug: string[][] = [];
  return { debug, topology: createSegmentTopology({ debug: (payload) => debug.push(payload), now: () => 100 }) };
}

describe('segment topology', () => {
  test('uses explicit canonical members without expanding across the timeline', () => {
    const { topology } = createTopology();
    const session = { timeline: ['msg_a', 'msg_hidden', 'msg_b'] };
    expect(topology.normalizeMembers(session, 'msg_a', 'msg_b', ['msg_a', 'msg_b', 'msg_a'], 'notice')).toEqual({
      anchorMsgId: 'msg_a', endMsgId: 'msg_b', memberMsgIds: ['msg_a', 'msg_b'],
    });
  });

  test('rejects inverted and missing-end ranges with the existing ordering semantics', () => {
    const { topology } = createTopology();
    const session = { timeline: ['msg_a', 'system:x', 'msg_b'] };
    expect(topology.computeMembers(session, 'msg_b', 'msg_a')).toEqual([]);
    expect(topology.computeMembers(session, 'msg_a', 'msg_missing')).toEqual([]);
  });

  test('resolves local/server aliases before normalizing members', () => {
    const { topology } = createTopology();
    const session = {
      timeline: ['msg_a', 'msg_b'],
      clientKeyToServerId: new Map([['local-a', 'msg_a']]),
      serverIdToClientKey: new Map([['remote-b', 'msg_b']]),
    };
    expect(topology.normalizeMembers(session, 'local-a', 'remote-b', [], 'notice').memberMsgIds).toEqual(['msg_a', 'msg_b']);
  });

  test('orders members by timeline and keeps valid off-timeline members afterward', () => {
    const { topology } = createTopology();
    expect(topology.orderMembersByTimeline(['msg_c', 'bad', 'msg_a', 'msg_b'], ['msg_a', 'msg_b'])).toEqual(['msg_a', 'msg_b', 'msg_c']);
  });

  test('sanitizes nested segment snapshots with monotonic restore defaults', () => {
    const { topology } = createTopology();
    expect(topology.sanitizeMergedSnapshot({ noticeKey: 'n', memberMsgIds: ['bad', 'msg_a'], restoreAllowed: false })).toEqual(expect.objectContaining({
      anchorMsgId: 'msg_a', endMsgId: 'msg_a', memberMsgIds: ['msg_a'], restoreAllowed: false, createdAt: 100, updatedAt: 100,
    }));
  });
});
