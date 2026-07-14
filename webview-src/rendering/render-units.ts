import type { RenderUnit, RenderUnitCandidate } from './types';

/**
 * Produces the sole ordered visible-unit projection. All suppression is resolved
 * before DOM reconciliation; no timeline indexes or DOM objects escape here.
 */
export function deriveRenderUnits<T>(
  candidates: readonly RenderUnitCandidate<T>[],
): RenderUnit<T>[] {
  const keys = new Set<string>();
  const units: RenderUnit<T>[] = [];
  for (const candidate of candidates) {
    if (
      candidate.hidden
      || candidate.appendChildHidden
      || candidate.appendAssistantHidden
      || candidate.dcpHidden
      || candidate.emptyUserText
    ) continue;

    const key = candidate.canonicalKey || candidate.key;
    if (!key) throw new Error('Render unit key must be non-empty');
    if (keys.has(key)) throw new Error(`Duplicate render unit key: ${key}`);
    keys.add(key);
    units.push({ key, sourceKey: candidate.key, kind: candidate.kind, value: candidate.value });
  }
  return units;
}
