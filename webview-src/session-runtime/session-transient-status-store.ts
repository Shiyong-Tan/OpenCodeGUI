export type SessionTransientStatus<TStall> = Readonly<{
  notice: string;
  stall: TStall | null;
}>;

export function createSessionTransientStatusStore<TStall>() {
  const bySession = new Map<string, { notice: string; stall: TStall | null }>();

  function getOrCreate(sessionId: string): { notice: string; stall: TStall | null } {
    const existing = bySession.get(sessionId);
    if (existing) return existing;
    const created = { notice: '', stall: null };
    bySession.set(sessionId, created);
    return created;
  }

  function prune(sessionId: string, state: { notice: string; stall: TStall | null }): void {
    if (!state.notice && !state.stall) bySession.delete(sessionId);
  }

  return Object.freeze({
    get(sessionId: string): SessionTransientStatus<TStall> {
      const state = bySession.get(sessionId);
      return state
        ? { notice: state.notice, stall: state.stall }
        : { notice: '', stall: null };
    },
    setNotice(sessionId: string, notice: string): void {
      const state = getOrCreate(sessionId);
      state.notice = notice;
      prune(sessionId, state);
    },
    setStall(sessionId: string, stall: TStall | null): void {
      const state = getOrCreate(sessionId);
      state.stall = stall;
      prune(sessionId, state);
    },
    deleteSession(sessionId: string): void {
      bySession.delete(sessionId);
    },
  });
}
