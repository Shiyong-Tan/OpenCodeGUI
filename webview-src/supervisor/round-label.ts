/** Called by the canonical message renderer, never by a DOM/position matcher. */
export function supervisorRoundLabel(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return;
    const round = value as { kind?: unknown; timingBasis?: unknown; sources?: unknown };
    if (round.kind !== 'independent' || round.timingBasis !== 'first-observed-activity' || !Array.isArray(round.sources) || round.sources.length > 256) return;
    const sources = round.sources.filter((source): source is {taskId: string; notificationId: string} =>
        !!source && typeof source === 'object' && typeof source.taskId === 'string' && typeof source.notificationId === 'string');
    if (!sources.length) return;
    return '监督通知触发 · 从首次观察到活动计时\n' + sources.map(s => `任务 ${s.taskId} · 通知 ${s.notificationId}`).join('\n');
}
