export function createSessionSearchRegistry<TState>(createState: () => TState) {
  const bySession = new Map<string, TState>();

  return Object.freeze({
    get(sessionId: string, create = true): TState | null {
      if (!sessionId) return null;
      const existing = bySession.get(sessionId);
      if (existing || !create) return existing || null;
      const state = createState();
      bySession.set(sessionId, state);
      return state;
    },
    deleteSession(sessionId: string): void {
      bySession.delete(sessionId);
    },
  });
}
