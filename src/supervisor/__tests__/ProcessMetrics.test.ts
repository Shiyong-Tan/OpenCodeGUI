import { parseSupervisorView } from '../protocol';
import { processWaitMetrics } from '../ProcessMetrics';
import { SupervisorPanelController } from '../SupervisorPanelController';
import type { SupervisorReadResult } from '../SupervisorReader';

const snapshot = () => parseSupervisorView({ schemaVersion: 1, isolationId: 'scope', instanceId: 'instance', revision: 1,
    pluginVersion: '0.1.12', openCodeVersion: '2.0.31', observedAt: new Date().toISOString(), parentSessionId: 'ses_parent',
    scope: 'isolated_allowlisted_commands', notifications: [], notificationIdentities: [], tasks: [{ taskId: 'task', attemptId: 'attempt',
        parentSessionId: 'ses_parent', childSessionId: 'ses_child', phase: 'active', health: 'running', outcome: null,
        lastObservationAgeMs: 0, lastProgressAgeMs: 0 }], executions: [{ taskId: 'task', attemptId: 'attempt', parentSessionId: 'ses_parent',
        childSessionId: 'ses_child', executionId: 'exec_A', toolCallId: 'launch_A', displayName: 'python', rootPid: 42,
        activeProcesses: 2, durationMs: 512000, cpuPercent: 95, workingSetBytes: '1024', exitCode: null,
        phase: 'running', health: 'running', lastObservationAgeMs: 0, lastActivityAgeMs: 100, rootExited: false, ownedProcessesStopped: false,
        cpu100ns: '100', cpuDelta100ns: '10', readBytes: '0', writeBytes: '0', readDeltaBytes: '0', writeDeltaBytes: '0',
        cancelRequested: false, requestAccepted: null, cancelOutcomeUnknown: false, coverageUnknown: false, safeToRetry: false }] });

test('old-plugin panel metrics join only the exact parent, child, execution and attempt', () => {
    const view = snapshot();
    expect(processWaitMetrics(view, 'ses_parent', 'ses_child', 'exec_A', 0)).toBe('Elapsed 8m 32s · CPU 95.0% · 2 live processes');
    for (const [parent, child, id] of [['ses_other','ses_child','exec_A'],['ses_parent','ses_other','exec_A'],['ses_parent','ses_child','exec_B']])
        expect(processWaitMetrics(view, parent, child, id, 0)).toBeUndefined();
    expect(processWaitMetrics({ ...view, tasks: [{ ...view.tasks[0], attemptId: 'replacement' }] }, 'ses_parent','ses_child','exec_A',0)).toBeUndefined();
    expect(processWaitMetrics(view,'ses_parent','ses_child','exec_A',5001)).toBeUndefined();
    view.executions[0].health = 'unknown';
    expect(processWaitMetrics(view,'ses_parent','ses_child','exec_A',0)).toBe('Elapsed 8m 32s · Observation uncertain');
});

test('panel-owned metrics refresh without tool events, and fail closed on selection, disconnect, expiry or failed read', async () => {
    jest.useFakeTimers();
    let selection = { sessionId:'ses_parent', epoch:1 }, status = 'connected';
    let result: SupervisorReadResult = {status:'observed',view:snapshot()};
    const refreshTools = jest.fn();
    const panel = new SupervisorPanelController({selection:()=>selection, connectionStatus:()=>status, publish:jest.fn(),
        read:async()=>result, refreshTools},60000);
    const summary = () => panel.processMetrics('ses_parent','ses_child','exec_A');
    try {
        await panel.tick(); expect(summary()).toContain('CPU 95.0%'); expect(refreshTools).toHaveBeenCalledTimes(1);
        jest.setSystemTime(Date.now()+5001); expect(summary()).toBeUndefined();
        await panel.tick(); status='disconnected'; expect(summary()).toBeUndefined(); status='connected';
        selection={sessionId:'ses_other',epoch:2}; expect(summary()).toBeUndefined();
        selection={sessionId:'ses_parent',epoch:3}; expect(summary()).toBeUndefined();
        await panel.tick(); expect(summary()).toContain('8m 32s');
        result={status:'unavailable',reason:'read_failed'}; await panel.tick(); expect(summary()).toBeUndefined();
        result={status:'observed',view:snapshot()}; await panel.tick(); panel.setEnabled(false); expect(summary()).toBeUndefined();
    } finally {panel.dispose();jest.useRealTimers();}
});
