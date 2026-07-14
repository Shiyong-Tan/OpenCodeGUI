import type { LegacyProjectedRenderUnit } from './types';

/**
 * Copies an already projected legacy sequence without adding Wave 2 domain semantics.
 */
export function deriveRenderUnits<T>(
  projected: readonly LegacyProjectedRenderUnit<T>[],
): LegacyProjectedRenderUnit<T>[] {
  return projected.map((unit) => ({ ...unit }));
}
