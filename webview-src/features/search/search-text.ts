export type SearchChunkVisitor = (value: string) => boolean | void;

export function createLinearSearchMatcher(query: unknown): {
  visit(value: unknown): void;
  matched(): boolean;
} {
  const needle = String(query || '').trim().toLowerCase();
  const failure = new Uint32Array(needle.length);
  for (let index = 1, matched = 0; index < needle.length; index += 1) {
    while (matched > 0 && needle[index] !== needle[matched]) matched = failure[matched - 1];
    if (needle[index] === needle[matched]) matched += 1;
    failure[index] = matched;
  }
  let matchedLength = 0;
  let found = needle.length === 0;
  const visit = (value: unknown): void => {
    if (found || typeof value !== 'string' || !value) return;
    for (let offset = 0; offset < value.length && !found; offset += 4096) {
      const lower = value.slice(offset, offset + 4096).toLowerCase();
      for (let index = 0; index < lower.length; index += 1) {
        while (matchedLength > 0 && lower[index] !== needle[matchedLength]) matchedLength = failure[matchedLength - 1];
        if (lower[index] === needle[matchedLength]) matchedLength += 1;
        if (matchedLength === needle.length) found = true;
      }
    }
  };
  return { visit, matched: () => found };
}

export function collectBoundedSmartSearchText(
  produce: ((visit: SearchChunkVisitor) => void) | null | undefined,
  cap = 2200,
  normalizeWhitespace = false,
): string {
  const limit = Math.max(0, Math.min(2200, Number.isFinite(cap) ? Math.trunc(cap) : 2200));
  const buffer = new Uint16Array(limit);
  let length = 0;
  let pendingSpace = false;
  if (typeof produce === 'function' && limit > 0) {
    produce((value) => {
      if (length >= limit) return false;
      if (typeof value !== 'string' || !value) return true;
      if (normalizeWhitespace) {
        for (let index = 0; index < value.length && length < limit; index += 1) {
          const code = value.charCodeAt(index);
          const isWhitespace = code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32
            || code === 160 || code === 5760 || (code >= 8192 && code <= 8202) || code === 8232 || code === 8233
            || code === 8239 || code === 8287 || code === 12288 || code === 65279;
          if (isWhitespace) {
            if (length > 0) pendingSpace = true;
            continue;
          }
          if (pendingSpace && length < limit) buffer[length++] = 32;
          pendingSpace = false;
          if (length < limit) buffer[length++] = code;
        }
        return length < limit;
      }
      const take = Math.min(value.length, limit - length);
      for (let index = 0; index < take; index += 1) buffer[length + index] = value.charCodeAt(index);
      length += take;
      return length < limit;
    });
  }
  return length ? String.fromCharCode(...buffer.subarray(0, length)) : '';
}
