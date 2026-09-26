import { parseSupervisorView, type SupervisorView } from '../../src/supervisor/protocol';

const age = (value: number | null): string => value === null ? 'Unknown' : `${Math.floor(value / 1000)} s`;
const fact = (value: boolean | null): string => value === null ? 'Unknown' : value ? 'Yes' : 'No';
const states: Record<string, string> = { registered: 'Registered', dispatching: 'Dispatching', active: 'Active', terminal: 'Ended',
    running: 'Running', waiting_permission: 'Waiting for permission', waiting_question: 'Waiting for answer', suspected_stall: 'Suspected stall', suspect: 'Suspected stall',
    unreachable: 'Observation unreachable', ended: 'Ended', cancel_unknown: 'Cancellation outcome unknown', unknown: 'Unknown',
    starting: 'Starting', stopped: 'Confirmed stopped', start_failed: 'Start failed', permission_denied: 'Permission denied',
    queued: 'Waiting for parent', submitting: 'Submitting', submitted: 'Submitted, receipt not yet confirmed', received: 'Received by parent',
    not_observed: 'No parent activity observed', activity_observed: 'Parent activity observed', result_read: 'Result read' };
export function supervisorLines(view: SupervisorView, stale = false): string[] {
    const lines = [stale ? 'Observation unavailable or previous instance: historical evidence below; current state unknown' : 'Read-only live observations',
        `OpenCode ${view.openCodeVersion} / Plugin ${view.pluginVersion}`, `Instance ${view.instanceId}`];
    if (!view.tasks.length) lines.push('No registered tasks in this session');
    for (const task of view.tasks) {
        lines.push(`Task ${task.taskId}`, `Child session ${task.childSessionId ?? 'Not yet created'}`,
            `${stale ? 'Previous ' : ''}Status: ${states[task.phase] ?? 'Unknown'} / ${states[task.health] ?? 'Unknown'}`,
            `Last observation ${age(task.lastObservationAgeMs)}; Last activity ${age(task.lastProgressAgeMs)}`);
        for (const e of view.executions.filter(item => item.taskId === task.taskId && item.attemptId === task.attemptId)) {
            lines.push(`Execution ${e.executionId}: ${states[e.health] ?? 'Unknown'}`,
                `Process ${e.displayName ?? 'Unknown'}; PID ${e.rootPid ?? 'Unknown'}; Root exit code ${e.exitCode ?? 'Unknown'}`,
                `Process sample ${age(e.lastObservationAgeMs)}; Activity ${age(e.lastActivityAgeMs)}`,
                `CPU delta ${e.cpuDelta100ns ?? 'Unknown'} ×100ns; Read/write delta ${e.readDeltaBytes ?? 'Unknown'} / ${e.writeDeltaBytes ?? 'Unknown'} bytes`,
                `Root exited ${fact(e.rootExited)}; Managed processes stopped ${fact(e.ownedProcessesStopped)}`,
                `Cancellation request accepted ${fact(e.requestAccepted)}; Cancellation outcome: ${e.cancelOutcomeUnknown ? 'Unknown' : 'See stop evidence'}`,
                'CPU/I/O indicate activity only, not computational correctness; reassignment is unavailable here');
        }
        for (const n of view.notifications.filter(item => item.taskId === task.taskId && item.attemptId === task.attemptId)) {
            lines.push(`Notification ${n.notificationId}: ${states[n.delivery] ?? 'Unknown'} / ${states[n.progress] ?? 'Unknown'}`);
            lines.push('Notification queued for ' + age(n.queueAgeMs) + '; Waiting for first observed activity after submission ' + age(n.activityWaitAgeMs));
            if (n.escalated) lines.push('User review needed: the parent has not completed the required result handling');
        }
    }
    return lines;
}

