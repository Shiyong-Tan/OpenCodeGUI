function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Map) {
    const entries = [...value.entries()].map(([key, entry]) => [canonicalize(key), canonicalize(entry)]);
    entries.sort((left, right) => {
      const a = JSON.stringify(left[0]);
      const b = JSON.stringify(right[0]);
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return { $map: entries };
  }
  if (value instanceof Set) {
    const entries = [...value].map(canonicalize);
    entries.sort((left, right) => {
      const a = JSON.stringify(left);
      const b = JSON.stringify(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return { $set: entries };
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (value === undefined) return { $undefined: true };
  return value;
}

/** Returns a deterministic data fingerprint without inspecting or mutating the DOM. */
export function presentationFingerprint(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
