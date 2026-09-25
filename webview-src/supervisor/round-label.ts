/** Called by the canonical message renderer, never by a DOM/position matcher. */
export function supervisorRoundLabel(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return;
    const round = value as { kind?: unknown; timingBasis?: unknown; sources?: unknown };
    if (round.kind !== 'independent' || round.timingBasis !== 'first-observed-activity' || !Array.isArray(round.sources) || round.sources.length > 256) return;
    const sources = round.sources.filter((source): source is {taskId: string; notificationId: string} =>
        !!source && typeof source === 'object' && typeof source.taskId === 'string' && typeof source.notificationId === 'string');
    if (!sources.length) return;
    return 'Supervisor notification · Timed from first observed activity\n' + sources.map(s => `Task ${s.taskId} · Notification ${s.notificationId}`).join('\n');
}
