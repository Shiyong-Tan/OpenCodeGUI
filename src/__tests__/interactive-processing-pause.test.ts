jest.mock('vscode', () => ({
    workspace: { workspaceFolders: [] },
    window: {
        createOutputChannel: jest.fn(() => ({
            appendLine: jest.fn(),
            append: jest.fn(),
            dispose: jest.fn(),
        })),
    },
}), { virtual: true });

import { OpenCodeClient } from '../OpenCodeClient';

function createClient(): any {
    const client: any = Object.create(OpenCodeClient.prototype);
    client.currentTurnStartedAtBySession = new Map([['session-a', 1_000]]);
    client.turnProcessingPausedAtBySession = new Map();
    client.turnProcessingPausedMsBySession = new Map();
    client.pendingQuestionCallIdsBySession = new Map();
    client.pendingPermissionIdsBySession = new Map();
    client.logUiDebug = jest.fn();
    return client;
}

describe('interactive processing-time pause', () => {
    test('accumulates question wait time without resetting turn time', () => {
        const client = createClient();
        client.pendingQuestionCallIdsBySession.set('session-a', new Set(['question-1']));
        client.syncInteractiveProcessingPause('session-a', 'question-added', 4_000);

        expect(client.getCurrentTurnProcessingPausedAt('session-a')).toBe(4_000);
        expect(client.getCurrentTurnProcessingPausedMs('session-a')).toBe(0);

        client.pendingQuestionCallIdsBySession.delete('session-a');
        client.syncInteractiveProcessingPause('session-a', 'question-cleared', 10_000);

        expect(client.getCurrentTurnProcessingPausedAt('session-a')).toBeUndefined();
        expect(client.getCurrentTurnProcessingPausedMs('session-a')).toBe(6_000);
        expect(client.getCurrentTurnStartedAt('session-a')).toBe(1_000);
    });

    test('does not resume until both question and permission blockers clear', () => {
        const client = createClient();
        client.pendingQuestionCallIdsBySession.set('session-a', new Set(['question-1']));
        client.syncInteractiveProcessingPause('session-a', 'question-added', 4_000);
        client.pendingPermissionIdsBySession.set('session-a', new Set(['permission-1']));
        client.syncInteractiveProcessingPause('session-a', 'permission-added', 5_000);

        client.pendingQuestionCallIdsBySession.delete('session-a');
        client.syncInteractiveProcessingPause('session-a', 'question-cleared', 8_000);
        expect(client.getCurrentTurnProcessingPausedAt('session-a')).toBe(4_000);

        client.pendingPermissionIdsBySession.delete('session-a');
        client.syncInteractiveProcessingPause('session-a', 'permission-cleared', 11_000);
        expect(client.getCurrentTurnProcessingPausedAt('session-a')).toBeUndefined();
        expect(client.getCurrentTurnProcessingPausedMs('session-a')).toBe(7_000);
    });
});
