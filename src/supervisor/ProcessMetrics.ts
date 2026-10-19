import type { SupervisorView } from './protocol';

/** Display-only join. The snapshot has already passed the reader's service fences. */
export function processWaitMetrics(view: SupervisorView, parent: string, child: string, executionId: string, ageMs: number): string | undefined {
    if (view.parentSessionId !== parent || ageMs < 0 || ageMs > 5000) return undefined;
    const execution = view.executions.find(e => e.executionId === executionId && e.parentSessionId === parent && e.childSessionId === child);
    if (!execution) return undefined;
    const task = view.tasks.find(t => t.taskId === execution.taskId && t.attemptId === execution.attemptId && t.childSessionId === child);
    if (!task) return undefined;
    const parts: string[] = [];
    if (execution.durationMs !== null) {
        const seconds = Math.floor(execution.durationMs / 1000);
        parts.push(`Elapsed ${Math.floor(seconds / 60)}m ${seconds % 60}s`);
    }
    if (execution.lastObservationAgeMs === null || execution.lastObservationAgeMs + ageMs > 5000 || execution.health === 'unknown' || execution.coverageUnknown)
        parts.push('Observation uncertain');
    else if (execution.phase === 'stopped') parts.push(`Exited ${execution.exitCode ?? 'unknown'}`);
    else {
        if (execution.cpuPercent !== null) parts.push(`CPU ${execution.cpuPercent.toFixed(1)}%`);
        if (execution.activeProcesses !== null) parts.push(`${execution.activeProcesses} live processes`);
        if (execution.health === 'suspect') parts.push('Quiet');
    }
    return parts.join(' · ') || undefined;
}
