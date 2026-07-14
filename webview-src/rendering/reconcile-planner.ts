import type { ReconcileItem, ReconcileStep } from './types';

/** Plans keyed reconciliation as data; applying DOM operations remains out of scope. */
export function planReconciliation(
  previous: readonly ReconcileItem[],
  next: readonly ReconcileItem[],
): ReconcileStep[] {
  const assertUnique = (items: readonly ReconcileItem[], label: string): void => {
    const keys = new Set<string>();
    for (const item of items) {
      if (!item.key) throw new Error(`${label} reconcile key must be non-empty`);
      if (keys.has(item.key)) throw new Error(`Duplicate ${label} reconcile key: ${item.key}`);
      keys.add(item.key);
    }
  };
  assertUnique(previous, 'previous');
  assertUnique(next, 'next');
  const previousByKey = new Map(previous.map((item, index) => [item.key, { item, index }]));
  const nextKeys = new Set(next.map((item) => item.key));
  const steps: ReconcileStep[] = [];

  next.forEach((item, to) => {
    const existing = previousByKey.get(item.key);
    if (!existing) {
      steps.push({ type: 'create', key: item.key, to });
    } else if (existing.item.fingerprint !== item.fingerprint) {
      steps.push({ type: 'replace', key: item.key, from: existing.index, to });
    } else if (existing.index !== to) {
      steps.push({ type: 'move', key: item.key, from: existing.index, to });
    } else {
      steps.push({ type: 'reuse', key: item.key, from: existing.index, to });
    }
  });

  previous.forEach((item, from) => {
    if (!nextKeys.has(item.key)) steps.push({ type: 'remove', key: item.key, from });
  });
  return steps;
}
