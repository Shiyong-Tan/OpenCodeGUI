export type SessionUsage = {
  used: number;
  size: number;
  amount: number;
};

export type HeaderUsagePresentation = {
  visible: boolean;
  disabled: boolean;
  title: string;
  percent: number;
  high: boolean;
  compactMode: boolean;
  compactRunning: boolean;
  fillWidth: string;
  label: string;
};

export type HeaderState = {
  setBaseTitle(title: string): void;
  setStatusText(text: string): void;
  setWaiting(waiting: boolean): void;
  getDisplayTitle(): string;
  isWaiting(): boolean;
  setUsage(sessionId: string, usage: Partial<SessionUsage>): void;
  getUsage(sessionId: string): SessionUsage | null;
  setCompactionState(sessionId: string, running: boolean, contextLimit: number): void;
  isCompacting(sessionId: string): boolean;
  setCompactHover(active: boolean): void;
  isCompactHoverActive(): boolean;
  deriveUsage(options: {
    sessionId: string;
    contextLimit: number;
    recomputedUsage?: Partial<SessionUsage> | null;
    compactDisabled: boolean;
    disabledTitle: string;
  }): HeaderUsagePresentation;
};

type UsageMessage = {
  role?: string;
  meta?: {
    tokens?: {
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    } | null;
    cost?: number;
    timeCreated?: number;
    timeCompleted?: number;
  };
};

const hiddenUsage = (): HeaderUsagePresentation => ({
  visible: false,
  disabled: true,
  title: '',
  percent: 0,
  high: false,
  compactMode: false,
  compactRunning: false,
  fillWidth: '0%',
  label: '0%',
});

function finiteOrZero(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function clampUsagePercent(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
}

export function recomputeSessionUsage(messages: Iterable<UsageMessage> | null | undefined): SessionUsage | null {
  if (!messages) return null;
  const assistants = Array.from(messages)
    .filter((message) => message?.role === 'assistant')
    .map((message) => ({
      tokens: message.meta?.tokens || null,
      cost: message.meta?.cost,
      timeCreated: finiteOrZero(message.meta?.timeCreated),
      timeCompleted: finiteOrZero(message.meta?.timeCompleted),
    }))
    .sort((left, right) => left.timeCreated - right.timeCreated);

  let amount = 0;
  let input = 0;
  let output = 0;
  let reasoning = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let used = 0;

  for (const assistant of assistants) {
    const cost = Number(assistant.cost);
    if (Number.isFinite(cost)) amount += cost;
    const usage = assistant.tokens || {};
    const nextInput = finiteOrZero(usage.input);
    const nextOutput = finiteOrZero(usage.output);
    const nextReasoning = finiteOrZero(usage.reasoning);
    const nextCacheRead = finiteOrZero(usage.cache?.read);
    const nextCacheWrite = finiteOrZero(usage.cache?.write);
    if (nextInput + nextOutput + nextReasoning + nextCacheRead + nextCacheWrite <= 0) continue;
    used = nextInput + nextCacheRead + nextCacheWrite + nextOutput;
    input += nextInput;
    output += nextOutput;
    reasoning += nextReasoning;
    cacheRead += nextCacheRead;
    cacheWrite += nextCacheWrite;
  }

  return { used, size: input + cacheRead + cacheWrite + output + reasoning, amount };
}

export function createHeaderState(initialTitle = 'OpenCode: Chat'): HeaderState {
  let baseTitle = initialTitle;
  let statusText = '';
  let waiting = false;
  let compactHoverActive = false;
  const usageBySession = new Map<string, SessionUsage>();
  const compactingSessions = new Set<string>();

  return {
    setBaseTitle: (title) => { baseTitle = title; },
    setStatusText: (text) => { statusText = text; },
    setWaiting: (value) => { waiting = Boolean(value); },
    getDisplayTitle: () => statusText || baseTitle,
    isWaiting: () => waiting,
    setUsage: (sessionId, usage) => {
      usageBySession.set(sessionId, {
        used: finiteOrZero(usage.used),
        size: finiteOrZero(usage.size),
        amount: finiteOrZero(usage.amount),
      });
    },
    getUsage: (sessionId) => usageBySession.get(sessionId) || null,
    setCompactionState: (sessionId, running, contextLimit) => {
      if (running) {
        compactingSessions.add(sessionId);
        return;
      }
      compactingSessions.delete(sessionId);
      const previous = usageBySession.get(sessionId);
      if (previous) {
        usageBySession.set(sessionId, {
          used: 0,
          size: previous.size > 0 ? previous.size : finiteOrZero(contextLimit),
          amount: previous.amount || 0,
        });
      } else if (contextLimit > 0) {
        usageBySession.set(sessionId, { used: 0, size: contextLimit, amount: 0 });
      }
    },
    isCompacting: (sessionId) => compactingSessions.has(sessionId),
    setCompactHover: (active) => { compactHoverActive = Boolean(active); },
    isCompactHoverActive: () => compactHoverActive,
    deriveUsage: ({ sessionId, contextLimit, recomputedUsage, compactDisabled, disabledTitle }) => {
      let usage = sessionId ? usageBySession.get(sessionId) || null : null;
      if (usage && usage.size <= 0 && contextLimit > 0) {
        usage = { ...usage, size: contextLimit };
        usageBySession.set(sessionId, usage);
      }
      if ((!usage || !Number.isFinite(usage.size) || usage.size <= 0) && sessionId && recomputedUsage && contextLimit > 0) {
        usage = {
          used: finiteOrZero(recomputedUsage.used),
          size: contextLimit,
          amount: finiteOrZero(recomputedUsage.amount),
        };
      }
      if (!usage || usage.size <= 0) {
        compactHoverActive = false;
        return hiddenUsage();
      }

      const compactRunning = compactingSessions.has(sessionId);
      const percent = clampUsagePercent((usage.used / usage.size) * 100);
      const compactMode = compactRunning || compactHoverActive;
      return {
        visible: true,
        disabled: compactDisabled,
        title: compactDisabled ? disabledTitle : '',
        percent,
        high: percent >= 50 && !compactRunning && !compactHoverActive,
        compactMode,
        compactRunning,
        fillWidth: compactMode ? '100%' : `${percent}%`,
        label: compactRunning ? 'Running' : (compactHoverActive ? 'Compact' : `${Math.round(percent)}%`),
      };
    },
  };
}
