jest.mock('vscode', () => ({
    workspace: { workspaceFolders: [{ uri: { fsPath: process.cwd() } }], getConfiguration: () => ({ get: (_key: string, value: unknown) => value }) },
    window: { createOutputChannel: () => ({ appendLine: () => undefined, append: () => undefined, clear: () => undefined, show: () => undefined, hide: () => undefined, dispose: () => undefined }) },
    Uri: { file: (fsPath: string) => ({ fsPath }), joinPath: (...parts: any[]) => ({ fsPath: parts.map((part) => part?.fsPath || String(part)).join('/') }) },
    commands: { executeCommand: async () => undefined }, env: { clipboard: { readText: async () => '' } },
}), { virtual: true });

import { OpenCodeClient } from '../../OpenCodeClient';

const clients: OpenCodeClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.dispose())); });

describe('append successor post-final ownership', () => {
    it('binds only the acknowledged append parent after final and routes its canonical text', () => {
        const client: any = new OpenCodeClient();
        clients.push(client);
        const sessionId = 'ses_append';
        client.startTurn(sessionId, 'local-root');
        client.setCurrentTurnUserMsgId(sessionId, 'msg_root', 'test');
        client.displayTurnUserMsgIdBySession.set(sessionId, 'msg_root');
        client.beginAppendPrompt(sessionId, 'append-local', 'follow up', 'msg_root');
        client.bindAppendUserMessage(sessionId, 'msg_append');
        client.setPendingAssistantTmpKey(sessionId, 'tmp:predecessor');
        client.finishTurn(sessionId);

        const events = client.mapServerEventToChatEvents('message.updated', { info: {
            id: 'msg_successor', sessionID: sessionId, role: 'assistant', parentID: 'msg_append', finish: undefined,
        } }, 'sse');
        expect(client.getActiveAppendSuccessor(sessionId)).toEqual(expect.objectContaining({
            appendUserMsgId: 'msg_append', assistantMsgId: 'msg_successor', sealedPredecessorTmpKey: 'tmp:predecessor', generation: 1,
        }));
        expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'turnInFlight', inFlight: true })]));

        const textEvents = client.mapServerEventToChatEvents('message.part.updated', { part: {
            sessionID: sessionId, messageID: 'msg_successor', type: 'text', delta: 'canonical', text: 'canonical',
        } }, 'sse');
        expect(textEvents).toEqual(expect.arrayContaining([expect.objectContaining({
            type: 'text', assistantMsgId: 'msg_successor', appendSuccessor: expect.objectContaining({ assistantMsgId: 'msg_successor' }), tmpKey: undefined,
        })]));
    });

    it('fails closed for foreign, conflicting, and unparented post-final traffic', () => {
        const client: any = new OpenCodeClient();
        clients.push(client);
        client.startTurn('ses_append', 'local-root');
        client.setCurrentTurnUserMsgId('ses_append', 'msg_root', 'test');
        client.displayTurnUserMsgIdBySession.set('ses_append', 'msg_root');
        client.beginAppendPrompt('ses_append', 'append-local', 'follow up', 'msg_root');
        client.bindAppendUserMessage('ses_append', 'msg_append');
        client.finishTurn('ses_append');
        client.mapServerEventToChatEvents('message.updated', { info: { id: 'msg_successor', sessionID: 'ses_append', role: 'assistant', parentID: 'msg_append' } }, 'sse');
        expect(client.mapServerEventToChatEvents('message.part.updated', { part: { sessionID: 'ses_append', messageID: 'msg_foreign', type: 'text', delta: 'no' } }, 'sse')).toEqual([]);
        expect(client.mapServerEventToChatEvents('message.updated', { info: { id: 'msg_conflict', sessionID: 'ses_append', role: 'assistant', parentID: 'msg_append' } }, 'sse')).toEqual([]);
        expect(client.getActiveAppendSuccessor('ses_append')).toBeUndefined();
    });
});
