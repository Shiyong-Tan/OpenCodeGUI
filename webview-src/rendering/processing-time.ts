type AssistantMessage = {
  role?: string;
  meta?: Record<string, any>;
};

export function formatProcessingDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(Number.isFinite(durationMs) ? durationMs / 1000 : 0));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}min`;
  if (minutes > 0) return `${minutes}min ${seconds}s`;
  return `${seconds}s`;
}

function finiteTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function finiteDuration(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function resolveAssistantProcessingTime(message: AssistantMessage, now = Date.now()): {
  startedAt: number;
  completedAt: number | null;
  pausedAt: number | null;
  pausedMs: number;
  durationMs: number;
} | null {
  if (message?.role !== 'assistant') return null;
  const meta = message.meta || {};
  const startedAt = finiteTimestamp(meta.processingStartedAt) ?? finiteTimestamp(meta.timeCreated);
  if (startedAt === null) return null;
  const storedCompletedAt = finiteTimestamp(meta.processingCompletedAt) ?? finiteTimestamp(meta.timeCompleted);
  if (meta.isThinking !== true && storedCompletedAt === null) return null;
  const completedAt = meta.isThinking === true ? null : storedCompletedAt;
  const endAt = completedAt ?? Math.max(startedAt, now);
  const pausedAt = finiteTimestamp(meta.processingPausedAt);
  const pausedMs = finiteDuration(meta.processingPausedMs);
  const openPauseMs = pausedAt === null
    ? 0
    : Math.max(0, endAt - Math.max(startedAt, pausedAt));
  return {
    startedAt,
    completedAt,
    pausedAt,
    pausedMs,
    durationMs: Math.max(0, endAt - startedAt - pausedMs - openPauseMs),
  };
}

export function appendAssistantProcessingTime(root: any, message: AssistantMessage, now = Date.now()): any | null {
  const timing = resolveAssistantProcessingTime(message, now);
  if (!root || !timing) return null;
  const element: any = document.createElement('div');
  element.className = 'message-processing-time';
  element.dataset.startedAt = String(timing.startedAt);
  element.dataset.completedAt = timing.completedAt === null ? '' : String(timing.completedAt);
  element.dataset.messageId = typeof (message as any)?.id === 'string' ? (message as any).id : '';
  element.textContent = formatProcessingDuration(timing.durationMs);
  element.title = 'Processing time';
  let pausedAt = timing.pausedAt;
  let pausedMs = timing.pausedMs;
  element._updateProcessingTime = (updateNow: number) => {
    if (timing.completedAt !== null) return false;
    const openPauseMs = pausedAt === null
      ? 0
      : Math.max(0, updateNow - Math.max(timing.startedAt, pausedAt));
    const next = formatProcessingDuration(Math.max(0, updateNow - timing.startedAt - pausedMs - openPauseMs));
    if (element.textContent !== next) element.textContent = next;
    return true;
  };
  element._syncProcessingPause = (meta: Record<string, any>, updateNow: number) => {
    pausedAt = finiteTimestamp(meta?.processingPausedAt);
    pausedMs = finiteDuration(meta?.processingPausedMs);
    return element._updateProcessingTime(updateNow);
  };
  root.appendChild(element);
  return element;
}

export function updateAssistantProcessingTimeElements(root: any, now = Date.now()): number {
  if (!root?.querySelectorAll) return 0;
  const elements = Array.from(root.querySelectorAll('.message-processing-time[data-completed-at=""]')) as any[];
  let updated = 0;
  for (const element of elements) {
    if (typeof element?._updateProcessingTime !== 'function') continue;
    if (element._updateProcessingTime(now) === true) updated += 1;
  }
  return updated;
}
