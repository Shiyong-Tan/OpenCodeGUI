export type SessionConflictStoreOptions<TConflict> = Readonly<{
  identity(conflict: TConflict): string;
}>;

export function createSessionConflictStore<TConflict>(
  options: SessionConflictStoreOptions<TConflict>,
) {
  const bySession = new Map<string, TConflict>();

  return Object.freeze({
    set(sessionId: string, conflict: TConflict): void {
      bySession.set(sessionId, conflict);
    },
    get(sessionId: string): TConflict | null {
      return bySession.get(sessionId) || null;
    },
    clear(sessionId: string, expectedIdentity?: string): boolean {
      const current = bySession.get(sessionId);
      if (!current) return false;
      if (expectedIdentity && options.identity(current) !== expectedIdentity) return false;
      bySession.delete(sessionId);
      return true;
    },
    deleteSession(sessionId: string): void {
      bySession.delete(sessionId);
    },
  });
}
