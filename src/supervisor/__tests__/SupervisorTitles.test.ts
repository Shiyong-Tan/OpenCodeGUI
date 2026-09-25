import { fillSupervisorTitles } from '../SupervisorTitles';
import { parseSupervisorView } from '../protocol';
const view = () => parseSupervisorView({ schemaVersion: 1, isolationId: 'scope', instanceId: 'instance', revision: 1,
    pluginVersion: '0.1.0', openCodeVersion: '1.18.31', observedAt: '2026-09-25T00:00:00.000Z', parentSessionId: 'ses_parent',
    scope: 'isolated_allowlisted_commands', executions: [], notifications: [], notificationIdentities: [], tasks: [
        { taskId: 'task', attemptId: 'attempt', parentSessionId: 'ses_parent', childSessionId: 'ses_child', phase: 'active', health: 'running',
          outcome: null, lastObservationAgeMs: 0, lastProgressAgeMs: 0 }] });
test('missing title is recovered only from the same child and parent, without mutating evidence', async () => {
    const input = view(), read = jest.fn(async () => ({ id: 'ses_child', parentID: 'ses_parent', title: 'Explain TGV solver choice (@physicist subagent)' }));
    const output = await fillSupervisorTitles(input, read);
    expect(output.tasks[0].title).toContain('Explain TGV'); expect(input.tasks[0].title).toBeNull();
    expect(output.tasks[0].health).toBe('running'); expect(output.revision).toBe(input.revision);
    expect(read).toHaveBeenCalledWith('ses_child');
    read.mockClear(); await fillSupervisorTitles(output, read); expect(read).not.toHaveBeenCalled();
});
test('foreign, invalid and unavailable titles never replace the fallback or task health', async () => {
    for (const data of [{ id: 'ses_other', parentID: 'ses_parent', title: 'Wrong' },
        { id: 'ses_child', parentID: 'ses_other', title: 'Wrong' }, { id: 'ses_child', parentID: 'ses_parent', title: 'bad\ntext' }]) {
        expect((await fillSupervisorTitles(view(), async () => data)).tasks[0].title).toBeNull();
    }
    expect((await fillSupervisorTitles(view(), async () => { throw new Error('offline'); })).tasks[0].health).toBe('running');
});
