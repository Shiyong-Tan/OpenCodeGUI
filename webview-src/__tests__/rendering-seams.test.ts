import { deriveRenderUnits } from '../rendering/render-units';
import type { LegacyProjectedRenderUnit } from '../rendering/types';
import { presentationFingerprint } from '../rendering/presentation-fingerprint';
import { planReconciliation } from '../rendering/reconcile-planner';
import { restoreScrollAnchor } from '../rendering/scroll-anchor-model';
import {
  createTanStackVirtualAdapter,
  type VirtualizerConstructor,
} from '../rendering/tanstack-virtual-adapter';

describe('Wave 1 pure rendering seams', () => {
  test('render units preserve legacy-projected order and data without domain interpretation', () => {
    const input: LegacyProjectedRenderUnit[] = [
      { key: 'message:1', kind: 'message', value: { text: 'one' } },
      { key: 'surface:loading', kind: 'surface', value: { pending: true } },
    ];

    expect(deriveRenderUnits(input)).toEqual(input);
    expect(deriveRenderUnits(input)).not.toBe(input);
  });

  test('presentation fingerprints are stable across object key order', () => {
    expect(presentationFingerprint({ b: 2, a: ['x', { z: true }] }))
      .toBe(presentationFingerprint({ a: ['x', { z: true }], b: 2 }));
    expect(presentationFingerprint({ a: 1 })).not.toBe(presentationFingerprint({ a: 2 }));
  });

  test('reconcile planner returns data-only keyed reuse/move/create/replace/remove steps', () => {
    expect(planReconciliation(
      [{ key: 'a', fingerprint: '1' }, { key: 'b', fingerprint: '1' }, { key: 'old', fingerprint: '1' }],
      [{ key: 'b', fingerprint: '1' }, { key: 'a', fingerprint: '2' }, { key: 'new', fingerprint: '1' }],
    )).toEqual([
      { type: 'move', key: 'b', from: 1, to: 0 },
      { type: 'replace', key: 'a', from: 0, to: 1 },
      { type: 'create', key: 'new', to: 2 },
      { type: 'remove', key: 'old', from: 2 },
    ]);
  });

  test('scroll anchor model computes only the requested scrollTop plan', () => {
    expect(restoreScrollAnchor({ scrollTop: 120, anchorTopBefore: 40, anchorTopAfter: 65 }))
      .toEqual({ scrollTop: 145, delta: 25 });
  });

  test('TanStack adapter remains constructor-injected and dormant until explicitly created', () => {
    let constructions = 0;
    class FakeVirtualizer {
      constructor(readonly options: unknown) { constructions += 1; }
      getVirtualItems() { return [{ index: 0, start: 0, end: 10, size: 10, key: 'a', lane: 0 }]; }
      getTotalSize() { return 10; }
    }

    expect(constructions).toBe(0);
    const adapter = createTanStackVirtualAdapter(
      { count: 1 } as never,
      FakeVirtualizer as unknown as VirtualizerConstructor,
    );
    expect(constructions).toBe(1);
    expect(adapter.getRange()).toEqual({ items: FakeVirtualizer.prototype.getVirtualItems(), totalSize: 10 });
  });
});
