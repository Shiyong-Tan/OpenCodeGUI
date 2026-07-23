jest.mock('vscode', () => ({
    workspace: { workspaceFolders: [{ uri: { fsPath: process.cwd() } }], getConfiguration: () => ({ get: (_key: string, value: unknown) => value }) },
    window: { createOutputChannel: () => ({ appendLine: () => undefined, dispose: () => undefined }) },
    Uri: { file: (fsPath: string) => ({ fsPath }), joinPath: (...parts: any[]) => ({ fsPath: parts.map((part) => part?.fsPath || String(part)).join('/') }) },
    commands: { executeCommand: async () => undefined }, env: { clipboard: { readText: async () => '' } },
}), { virtual: true });

import { OpenCodeClient } from '../../OpenCodeClient';
import { inspectAppendFollowupInlineDispatcher } from '../helpers/append-successor-protocol-harness';

const clients: OpenCodeClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.dispose())); });

function createSameTurnFixture(): any {
    const client: any = new OpenCodeClient();
    clients.push(client);
    client.startTurn('ses', 'local-root');
    client.setCurrentTurnUserMsgId('ses', 'msg_root', 'test');
    client.displayTurnUserMsgIdBySession.set('ses', 'msg_root');
    client.beginAppendPrompt('ses', 'append-client', 'follow up', 'msg_root');
    client.bindAppendUserMessage('ses', 'msg_u');
    client.recordAssistantMsgId('ses', 'msg_a');
    return client;
}

describe('append followup same-turn handoff', () => {
    it('keeps the followup protocol in the lexical message dispatcher, not a detached helper', () => {
        const scope = inspectAppendFollowupInlineDispatcher();
        expect(scope.dispatcher).toBeGreaterThanOrEqual(0);
        expect(scope.turnInFlight).toBeGreaterThan(scope.dispatcher);
        expect(scope.assistantMeta).toBeGreaterThan(scope.turnInFlight);
        expect(scope.indexDelta).toBeGreaterThan(scope.turnInFlight);
        expect(scope.extractedHelper).toBe(-1);
    });

    it('rotates the existing turn from canonical A to B only after A tool-calls completion', () => {
        const client = createSameTurnFixture();
        const state = client.turnStateBySession.get('ses');
        const beforeTurnKey = client.turnWriteStateBySession.get('ses')?.turnKey;

        expect(client.mapServerEventToChatEvents('message.updated', {
            info: { id: 'msg_b', sessionID: 'ses', role: 'assistant', parentID: 'msg_u' },
        }, 'sse')).toEqual([]);

        client.mapServerEventToChatEvents('message.updated', {
            info: { id: 'msg_a', sessionID: 'ses', role: 'assistant', parentID: 'msg_root', finish: 'tool-calls' },
        }, 'sse');
        expect(state.appendFollowupHandoff).toEqual(expect.objectContaining({ phase: 'tool-calls-complete', predecessorAssistantMsgId: 'msg_a' }));

        const events = client.mapServerEventToChatEvents('message.updated', {
            info: { id: 'msg_b', sessionID: 'ses', role: 'assistant', parentID: 'msg_u' },
        }, 'sse');
        expect(events).toEqual(expect.arrayContaining([expect.objectContaining({
            type: 'turnInFlight', ownerMsgId: 'msg_b', assistantMsgId: 'msg_b',
            appendFollowup: expect.objectContaining({ appendUserMsgId: 'msg_u', predecessorAssistantMsgId: 'msg_a', assistantMsgId: 'msg_b', mode: 'same-turn-handoff' }),
        })]));
        expect(client.turnStateBySession.get('ses')).toBe(state);
        expect(state.assistantMsgId).toBe('msg_b');
        expect(state.turnMessageIds).toEqual(new Set(['msg_a', 'msg_b']));
        expect(client.turnWriteStateBySession.get('ses')?.turnKey).toBe(beforeTurnKey);
        expect(client.turnFinishedBySession.has('ses')).toBe(false);
    });

    it('rejects renewed or late A content and accepts only B as the final owner', () => {
        const client = createSameTurnFixture();
        client.mapServerEventToChatEvents('message.updated', { info: { id: 'msg_a', sessionID: 'ses', role: 'assistant', parentID: 'msg_root', finish: 'tool-calls' } }, 'sse');
        client.mapServerEventToChatEvents('message.part.updated', { part: { sessionID: 'ses', messageID: 'msg_a', type: 'text', text: 'renewed' } }, 'sse');
        expect(client.mapServerEventToChatEvents('message.updated', { info: { id: 'msg_b', sessionID: 'ses', role: 'assistant', parentID: 'msg_u' } }, 'sse')).toEqual([]);

        client.mapServerEventToChatEvents('message.updated', { info: { id: 'msg_a', sessionID: 'ses', role: 'assistant', parentID: 'msg_root', finish: 'tool-calls' } }, 'sse');
        client.mapServerEventToChatEvents('message.updated', { info: { id: 'msg_b', sessionID: 'ses', role: 'assistant', parentID: 'msg_u' } }, 'sse');
        expect(client.mapServerEventToChatEvents('message.updated', { info: { id: 'msg_a', sessionID: 'ses', role: 'assistant', parentID: 'msg_root', finish: 'stop' } }, 'sse')).toEqual([]);
        expect(client.mapServerEventToChatEvents('message.updated', { info: { id: 'msg_b', sessionID: 'ses', role: 'assistant', parentID: 'msg_u', finish: 'stop' } }, 'sse')).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'assistantMessageMeta', assistantMsgId: 'msg_b' })]));
    });

    it('finalizes an inactive session latest text-only successor when idle is the terminal signal', () => {
        const client = createSameTurnFixture();
        client.mapServerEventToChatEvents('message.updated', {
            info: { id: 'msg_a', sessionID: 'ses', role: 'assistant', parentID: 'msg_root', finish: 'tool-calls' },
        }, 'sse');
        client.setSessionId('other-visible-session');

        const textEvents = client.mapServerEventToChatEvents('message.part.updated', {
            part: { sessionID: 'ses', messageID: 'msg_b', type: 'text', text: 'OK' },
        }, 'sse');
        expect(textEvents).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'text', sessionId: 'ses', assistantMsgId: 'msg_b', text: 'OK' }),
        ]));
        expect(client.getTurnAssistantMsgId('ses')).toBe('msg_b');

        client.mapServerEventToChatEvents('message.part.updated', {
            part: { sessionID: 'ses', messageID: 'msg_b', type: 'step-finish' },
        }, 'sse');
        client.mapServerEventToChatEvents('session.status', {
            sessionID: 'ses', status: { type: 'idle' },
        }, 'sse');

        expect(client.getFinalizingMsgId('ses')).toBe('msg_b');
        expect((client as any).turnFinalMsgIdBySession.get('ses')).toBe('msg_b');
        expect((client as any).turnFinalSourceBySession.get('ses')).toBe('session-idle');
        expect(client.getSessionId()).toBe('other-visible-session');
    });
});
