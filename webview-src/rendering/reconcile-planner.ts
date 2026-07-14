import type { ReconcileItem, ReconcileStep } from './types';

/** Plans keyed reconciliation as data; applying DOM operations remains out of scope. */
export function planReconciliation(
  previous: readonly ReconcileItem[],
  next: readonly ReconcileItem[],
): ReconcileStep[] {
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
