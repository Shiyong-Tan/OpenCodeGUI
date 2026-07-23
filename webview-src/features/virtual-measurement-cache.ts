import type { VirtualAdapterMeasurement } from '../rendering/tanstack-virtual-adapter';

interface StoredMeasurement {
  readonly revisionDigest: string;
  readonly size: number;
}

interface SessionMeasurementCache {
  width: number;
  updatedAt: number;
  readonly entries: Map<string, StoredMeasurement>;
}

export interface VirtualMeasurementCacheOptions {
  readonly read: () => string | null;
  readonly write: (value: string) => void;
  readonly getWidth: () => number;
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delay: number) => unknown;
  readonly sessionLimit?: number;
  readonly entryLimit?: number;
}

export function createVirtualMeasurementCache(options: VirtualMeasurementCacheOptions) {
  const sessionLimit = Math.max(1, Math.floor(options.sessionLimit ?? 12));
  const entryLimit = Math.max(1, Math.floor(options.entryLimit ?? 600));
  const now = options.now || (() => Date.now());
  const schedule = options.schedule || ((callback: () => void, delay: number) => setTimeout(callback, delay));
  const sessions = new Map<string, SessionMeasurementCache>();
  let writePending = false;

  const digest = (value: string) => {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${(hash >>> 0).toString(36)}:${value.length.toString(36)}`;
  };

  const load = () => {
    try {
      const stored = JSON.parse(options.read() || 'null');
      if (stored?.version !== 1 || !Array.isArray(stored.sessions)) return;
      for (const candidate of stored.sessions.slice(0, sessionLimit)) {
        if (!candidate || typeof candidate.sessionId !== 'string' || !candidate.sessionId
          || !Number.isFinite(candidate.width) || !Array.isArray(candidate.entries)) continue;
        const entries = new Map<string, StoredMeasurement>();
        for (const entry of candidate.entries.slice(-entryLimit)) {
          if (!Array.isArray(entry) || entry.length !== 3
            || typeof entry[0] !== 'string' || typeof entry[1] !== 'string'
            || !Number.isFinite(entry[2]) || entry[2] <= 0) continue;
          entries.set(entry[0], { revisionDigest: entry[1], size: entry[2] });
        }
        sessions.set(candidate.sessionId, {
          width: candidate.width,
          updatedAt: Number.isFinite(candidate.updatedAt) ? candidate.updatedAt : 0,
          entries,
        });
      }
    } catch { /* invalid storage only removes the optimization */ }
  };

  const flush = () => {
    writePending = false;
    try {
      const storedSessions = Array.from(sessions, ([sessionId, cache]) => ({
        sessionId,
        width: cache.width,
        updatedAt: cache.updatedAt,
        entries: Array.from(cache.entries, ([key, entry]) => [key, entry.revisionDigest, entry.size]),
      }))
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, sessionLimit);
      options.write(JSON.stringify({ version: 1, sessions: storedSessions }));
      return true;
    } catch {
      return false;
    }
  };

  const requestWrite = () => {
    if (writePending) return;
    writePending = true;
    schedule(flush, 120);
  };

  const remember = (sessionId: string, measurements: readonly VirtualAdapterMeasurement[]) => {
    if (!sessionId || !Array.isArray(measurements) || measurements.length === 0) return;
    const width = Number(options.getWidth());
    if (!(width > 0)) return;
    let cache = sessions.get(sessionId);
    if (!cache || Math.abs(cache.width - width) > 1) {
      cache = { width, updatedAt: now(), entries: new Map() };
      sessions.set(sessionId, cache);
    }
    for (const measurement of measurements) {
      if (!measurement || typeof measurement.key !== 'string' || !measurement.key
        || typeof measurement.revision !== 'string'
        || !Number.isFinite(measurement.size) || measurement.size <= 0) continue;
      cache.entries.delete(measurement.key);
      cache.entries.set(measurement.key, {
        revisionDigest: digest(measurement.revision),
        size: measurement.size,
      });
    }
    while (cache.entries.size > entryLimit) cache.entries.delete(cache.entries.keys().next().value!);
    cache.updatedAt = now();
    while (sessions.size > sessionLimit) {
      const oldest = Array.from(sessions.entries()).sort((left, right) => left[1].updatedAt - right[1].updatedAt)[0];
      if (!oldest) break;
      sessions.delete(oldest[0]);
    }
    requestWrite();
  };

  const getInitial = (
    sessionId: string,
    keys: readonly string[],
    revisions: readonly string[],
  ): VirtualAdapterMeasurement[] => {
    const cache = sessions.get(sessionId);
    const width = Number(options.getWidth());
    if (!cache || !(width > 0) || Math.abs(cache.width - width) > 1) return [];
    const result: VirtualAdapterMeasurement[] = [];
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const revision = revisions[index] || '';
      const cached = cache.entries.get(key);
      if (!cached || cached.revisionDigest !== digest(revision)) continue;
      result.push({ key, revision, size: cached.size });
    }
    return result;
  };

  load();
  return Object.freeze({ remember, getInitial, flush });
}
