jest.mock('vscode', () => ({
    workspace: { workspaceFolders: [] },
    window: { createOutputChannel: () => ({ appendLine: () => undefined, dispose: () => undefined }) },
}), { virtual: true });

import { OpenCodeClient } from '../OpenCodeClient';

describe('OpenCodeClient active-turn recovery', () => {
    test('reads the session-scoped runtime status from the shared status endpoint', async () => {
        const client = new OpenCodeClient() as any;
        client.ensureServer = jest.fn().mockResolvedValue(undefined);
        client.requestJson = jest.fn().mockResolvedValue({
            ses_busy: { type: 'busy' },
            ses_idle: { type: 'idle' },
        });

        await expect(client.getSessionStatusType('ses_busy')).resolves.toBe('busy');
        expect(client.requestJson).toHaveBeenCalledWith('GET', '/session/status');
    });

    test('restores canonical user and assistant ownership without inventing temporary ids', () => {
        const client = new OpenCodeClient() as any;
        client.scheduleSilenceResync = jest.fn();

        client.recoverActiveTurn('ses_recovered', 'msg_user', 'msg_assistant', 1234);

        expect(client.getCurrentTurnMessageIds('ses_recovered')).toEqual({
            userMessageIds: ['msg_user'],
            assistantMessageIds: ['msg_assistant'],
        });
        expect(client.getTurnAssistantMsgId('ses_recovered')).toBe('msg_assistant');
        expect(client.currentTurnStartedAtBySession.get('ses_recovered')).toBe(1234);
        expect(client.scheduleSilenceResync).toHaveBeenCalledWith('ses_recovered');
    });

    test('preserves an existing live turn handoff while refreshing canonical ownership', () => {
        const client = new OpenCodeClient() as any;
        client.scheduleSilenceResync = jest.fn();
        client.turnStateBySession.set('ses_live', {
            pendingUserLocalKey: 'local-user',
            pendingAssistantTmpKey: 'tmp:assistant',
            assistantMsgId: 'msg_old_assistant',
            exportInFlight: true,
            exportResolved: false,
            resolvedUserMsgId: 'msg_user',
            turnMessageIds: new Set(['local-user', 'msg_user', 'msg_old_assistant']),
            assistantMessageIds: new Set(['msg_old_assistant']),
            appendFollowupHandoff: {
                phase: 'followup-active',
                predecessorAssistantMsgId: 'msg_old_assistant',
                followupAssistantMsgId: 'msg_new_assistant',
            },
        });

        client.recoverActiveTurn('ses_live', 'msg_user', 'msg_new_assistant', 2345);

        const state = client.turnStateBySession.get('ses_live');
        expect(state).toEqual(expect.objectContaining({
            pendingUserLocalKey: 'local-user',
            pendingAssistantTmpKey: 'tmp:assistant',
            assistantMsgId: 'msg_new_assistant',
            exportInFlight: true,
            appendFollowupHandoff: expect.objectContaining({ phase: 'followup-active' }),
        }));
        expect(Array.from(state.turnMessageIds)).toEqual(expect.arrayContaining([
            'local-user', 'msg_user', 'msg_old_assistant', 'msg_new_assistant',
        ]));
        expect(Array.from(state.assistantMessageIds)).toEqual(expect.arrayContaining([
            'msg_old_assistant', 'msg_new_assistant',
        ]));
    });
});
