jest.mock('vscode', () => ({ workspace: { workspaceFolders: [{ uri: { fsPath: process.cwd() } }], getConfiguration: () => ({ get: (_k: string, value: unknown) => value }) }, window: { createOutputChannel: () => ({ appendLine: () => undefined, append: () => undefined, clear: () => undefined, show: () => undefined, hide: () => undefined, dispose: () => undefined }) }, Uri: { file: (fsPath: string) => ({ fsPath }), joinPath: (...parts: any[]) => ({ fsPath: parts.map((part) => part?.fsPath || String(part)).join('/') }) }, commands: { executeCommand: async () => undefined }, env: { clipboard: { readText: async () => '' } } }), { virtual: true });
import { OpenCodeClient } from '../../OpenCodeClient';
const clients: OpenCodeClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.dispose())); });

function sealedAppendClient(): any {
    const client: any = new OpenCodeClient(); clients.push(client);
    client.startTurn('ses_append', 'local-root'); client.setCurrentTurnUserMsgId('ses_append', 'msg_root', 'test'); client.displayTurnUserMsgIdBySession.set('ses_append', 'msg_root');
    client.beginAppendPrompt('ses_append', 'append-local', 'follow up', 'msg_root'); client.bindAppendUserMessage('ses_append', 'msg_append'); client.setPendingAssistantTmpKey('ses_append', 'tmp:predecessor'); client.finishTurn('ses_append');
    return client;
}
describe('append successor post-final ownership', () => {
    it('binds only an acknowledged same-session append parent and routes canonical text without a tmp key', () => {
        const client = sealedAppendClient();
        const events = client.mapServerEventToChatEvents('message.updated', { info: { id: 'msg_successor', sessionID: 'ses_append', role: 'assistant', parentID: 'msg_append' } }, 'sse');
        expect(client.getActiveAppendSuccessor('ses_append')).toEqual(expect.objectContaining({ rootUserMsgId: 'msg_root', appendUserMsgId: 'msg_append', assistantMsgId: 'msg_successor', generation: 1, sealedPredecessorTmpKey: 'tmp:predecessor' }));
        expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'turnInFlight', inFlight: true })]));
        expect(client.mapServerEventToChatEvents('message.part.updated', { part: { sessionID: 'ses_append', messageID: 'msg_successor', type: 'text', delta: 'canonical' } }, 'sse')).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', assistantMsgId: 'msg_successor', tmpKey: undefined })]));
    });
    it('drops foreign parts and clears a conflicting successor binding fail closed', () => {
        const client = sealedAppendClient();
        client.mapServerEventToChatEvents('message.updated', { info: { id: 'msg_successor', sessionID: 'ses_append', role: 'assistant', parentID: 'msg_append' } }, 'sse');
        expect(client.mapServerEventToChatEvents('message.part.updated', { part: { sessionID: 'ses_append', messageID: 'msg_foreign', type: 'text', delta: 'no' } }, 'sse')).toEqual([]);
        client.mapServerEventToChatEvents('message.updated', { info: { id: 'msg_conflict', sessionID: 'ses_append', role: 'assistant', parentID: 'msg_append' } }, 'sse');
        expect(client.getActiveAppendSuccessor('ses_append')).toBeUndefined();
    });
});
