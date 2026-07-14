import { deriveRenderUnits } from '../rendering/render-units';
import { presentationFingerprint } from '../rendering/presentation-fingerprint';
import { planReconciliation } from '../rendering/reconcile-planner';
import type { RenderUnitCandidate } from '../rendering/types';

describe('Wave 2 render-unit projection', () => {
  test('preserves visible ordering and stable canonical keys across every unit class', () => {
    const candidates: RenderUnitCandidate[] = [
      { key: 'msg:user', kind: 'message', value: { role: 'user', text: 'hello' } },
      { key: 'msg:append', kind: 'message', value: {}, appendChildHidden: true },
      { key: 'msg:append-assistant', kind: 'message', value: {}, appendAssistantHidden: true },
      { key: 'msg:dcp', kind: 'message', value: {}, dcpHidden: true },
      { key: 'msg:hidden', kind: 'message', value: {}, hidden: true },
      { key: 'system:undo:1', canonicalKey: 'segment:1', kind: 'segment', value: { collapsed: true } },
      { key: 'system:changeList:1', kind: 'change-list', value: { files: ['a.ts'] } },
      { key: 'surface:error', kind: 'surface', value: { text: 'failed' } },
      { key: 'surface:conflict', kind: 'surface', value: { conflict: true } },
    ];

    expect(deriveRenderUnits(candidates).map(({ key, sourceKey, kind }) => ({ key, sourceKey, kind })))
      .toEqual([
        { key: 'msg:user', sourceKey: 'msg:user', kind: 'message' },
        { key: 'segment:1', sourceKey: 'system:undo:1', kind: 'segment' },
        { key: 'system:changeList:1', sourceKey: 'system:changeList:1', kind: 'change-list' },
        { key: 'surface:error', sourceKey: 'surface:error', kind: 'surface' },
        { key: 'surface:conflict', sourceKey: 'surface:conflict', kind: 'surface' },
      ]);
  });

  test('alias variants converge on one canonical unit and duplicate canonical identity fails closed', () => {
    expect(deriveRenderUnits([
      { key: 'tmp:assistant', canonicalKey: 'msg_final', kind: 'message', value: { text: 'old' } },
    ])[0]).toMatchObject({ key: 'msg_final', sourceKey: 'tmp:assistant' });
    expect(() => deriveRenderUnits([
      { key: 'tmp:assistant', canonicalKey: 'msg_final', kind: 'message', value: {} },
      { key: 'msg_final', kind: 'message', value: {} },
    ])).toThrow(/duplicate render unit key/i);
  });

  test('empty user text produces zero units and no empty wrapper', () => {
    expect(deriveRenderUnits([
      { key: 'empty', kind: 'message', value: { role: 'user', text: '' }, emptyUserText: true },
    ])).toEqual([]);
  });
});

describe('Wave 2 load-bearing presentation identity', () => {
  const messagePresentation = (lookupKey: string, expanded: boolean) => ({
    visibleText: 'answer',
    rich: { diffText: '+line', images: ['one.png'], files: ['a.ts'], todos: [{ content: 'x', status: 'pending' }] },
    actions: { canAppend: true, canUndo: false, canRestore: true },
    status: { thinking: true, statusText: 'Running', reverted: false, collapsed: false },
    ownership: { sessionId: 's1', messageId: 'm1', commitHead: 'h1', commitBase: 'b1' },
    subagentExpansion: { lookupKey, expanded },
  });

  test.each([
    ['visible text', { visibleText: 'changed' }],
    ['rich metadata', { rich: { diffText: '-line' } }],
    ['actions', { actions: { canAppend: false } }],
    ['status', { status: { thinking: false } }],
    ['ownership', { ownership: { sessionId: 's2' } }],
  ])('%s changes the fingerprint', (_label, replacement) => {
    expect(presentationFingerprint(messagePresentation('s1:m1:a1', false)))
      .not.toBe(presentationFingerprint({ ...messagePresentation('s1:m1:a1', false), ...replacement }));
  });

  test('subagent expansion value and lookup-key each change only the affected unit', () => {
    const previous = [
      { key: 'm1', fingerprint: presentationFingerprint(messagePresentation('s1:m1:a1', false)) },
      { key: 'm2', fingerprint: presentationFingerprint({ visibleText: 'stable' }) },
    ];
    for (const changed of [messagePresentation('s1:m1:a1', true), messagePresentation('s1:m1:a2', false)]) {
      expect(planReconciliation(previous, [
        { key: 'm1', fingerprint: presentationFingerprint(changed) },
        previous[1],
      ])).toEqual([
        { type: 'replace', key: 'm1', from: 0, to: 0 },
        { type: 'reuse', key: 'm2', from: 1, to: 1 },
      ]);
    }
  });

  test('unchanged reconciliation does no root work', () => {
    const items = [{ key: 'a', fingerprint: '1' }, { key: 'b', fingerprint: '2' }];
    expect(planReconciliation(items, items)).toEqual([
      { type: 'reuse', key: 'a', from: 0, to: 0 },
      { type: 'reuse', key: 'b', from: 1, to: 1 },
    ]);
  });

  test('ambiguous duplicate identity fails closed before planning DOM work', () => {
    expect(() => planReconciliation([], [
      { key: 'same', fingerprint: '1' },
      { key: 'same', fingerprint: '2' },
    ])).toThrow(/duplicate next reconcile key/i);
  });
});
