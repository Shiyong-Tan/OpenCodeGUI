type SessionRenderSchedulerOptions = {
  getActiveSessionId(): string;
  render(reason: string): void;
  onInactive(sessionId: string, reason: string): void;
  setTimeout(callback: () => void, delayMs: number): any;
  clearTimeout(handle: any): void;
  now(): number;
  intervalMs: number;
};

export function createSessionRenderScheduler(options: SessionRenderSchedulerOptions) {
  const states = new Map<string, { timer: any; lastRenderedAt: number; reason: string }>();
  function schedule(sessionId: string, reason: string, scheduleOptions: { immediate?: boolean } = {}): boolean {
    if (!sessionId || sessionId !== options.getActiveSessionId()) {
      options.onInactive(sessionId, reason);
      return false;
    }
    let state = states.get(sessionId);
    if (!state) {
      state = { timer: null, lastRenderedAt: 0, reason: '' };
      states.set(sessionId, state);
    }
    state.reason = reason || state.reason || 'session-metadata-coalesced';
    const render = () => {
      state!.timer = null;
      if (sessionId !== options.getActiveSessionId()) {
        states.delete(sessionId);
        return;
      }
      state!.lastRenderedAt = options.now();
      const renderReason = state!.reason;
      state!.reason = '';
      options.render(renderReason);
    };
    if (scheduleOptions.immediate === true) {
      if (state.timer !== null) options.clearTimeout(state.timer);
      render();
      return true;
    }
    if (state.timer !== null) return true;
    const delay = Math.max(0, options.intervalMs - (options.now() - state.lastRenderedAt));
    state.timer = options.setTimeout(render, delay);
    return true;
  }
  function dispose(): void {
    for (const state of states.values()) if (state.timer !== null) options.clearTimeout(state.timer);
    states.clear();
  }
  return Object.freeze({ schedule, dispose });
}
