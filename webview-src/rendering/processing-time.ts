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
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0 || days > 0) parts.push(`${minutes}min`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

function finiteTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function resolveAssistantProcessingTime(message: AssistantMessage, now = Date.now()): {
  startedAt: number;
  completedAt: number | null;
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
  return { startedAt, completedAt, durationMs: Math.max(0, endAt - startedAt) };
}

export function appendAssistantProcessingTime(root: any, message: AssistantMessage, now = Date.now()): any | null {
  const timing = resolveAssistantProcessingTime(message, now);
  if (!root || !timing) return null;
  const element: any = document.createElement('div');
  element.className = 'message-processing-time';
  element.dataset.startedAt = String(timing.startedAt);
  element.dataset.completedAt = timing.completedAt === null ? '' : String(timing.completedAt);
  element.textContent = formatProcessingDuration(timing.durationMs);
  element.title = 'Processing time';
  element._updateProcessingTime = (updateNow: number) => {
    if (timing.completedAt !== null) return false;
    const next = formatProcessingDuration(Math.max(0, updateNow - timing.startedAt));
    if (element.textContent !== next) element.textContent = next;
    return true;
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
