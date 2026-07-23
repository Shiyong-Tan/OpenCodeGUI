jest.mock('vscode', () => ({
    workspace: { workspaceFolders: [{ uri: { fsPath: process.cwd() } }], getConfiguration: () => ({ get: (_key: string, value: unknown) => value }), asRelativePath: (value: string) => value },
    window: { createOutputChannel: () => ({ appendLine: () => undefined, append: () => undefined, clear: () => undefined, show: () => undefined, hide: () => undefined, dispose: () => undefined }) },
    Uri: { file: (fsPath: string) => ({ fsPath }), joinPath: (...parts: any[]) => ({ fsPath: parts.map((part) => part?.fsPath || String(part)).join('/') }) },
    commands: { executeCommand: async () => undefined }, env: { clipboard: { readText: async () => '' } },
}), { virtual: true });

import { OpenCodeClient } from '../../OpenCodeClient';
import { loadAppendSuccessorProtocolHarness } from '../helpers/append-successor-protocol-harness';

const clients: OpenCodeClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.dispose())); });

describe('append successor canonical presentation protocol RED', () => {
    it('binds an explicitly parented post-final successor once with canonical assistant ownership', () => {
        const client: any = new OpenCodeClient();
        clients.push(client);
        const root = 'msg_f8c2a5a79001WGVyQnERdJaQ8I';
        const append = 'msg_f8c2a6810001ejk13w0hUPa65S';
        const successor = 'msg_f8c2ae670001KiG8j2hE8doUCp';
        client.startTurn('ses_f8', 'local-root');
        client.setCurrentTurnUserMsgId('ses_f8', root, 'test-root');
        client.displayTurnUserMsgIdBySession.set('ses_f8', root);
        client.beginAppendPrompt('ses_f8', 'append-client', 'queued append', root);
        client.bindAppendUserMessage('ses_f8', append);
        client.finishTurn('ses_f8');
        const events = client.mapServerEventToChatEvents('message.updated', {
            info: { id: successor, sessionID: 'ses_f8', role: 'assistant', parentID: append },
        }, 'sse');
        expect(events.filter((event: any) => event.type === 'turnInFlight' && event.inFlight === true)).toEqual([expect.objectContaining({ ownerMsgId: successor, assistantMsgId: successor })]);
        expect(events.some((event: any) => event.type === 'turnResolved')).toBe(false);
        const duplicate = client.mapServerEventToChatEvents('message.updated', { info: { id: successor, sessionID: 'ses_f8', role: 'assistant', parentID: append } }, 'sse');
        expect(duplicate.some((event: any) => event.type === 'turnInFlight')).toBe(false);
    });
    it('routes an active exact successor MessageAbortedError once and keeps user cancel silent', () => {
        const client: any = new OpenCodeClient();
        clients.push(client);
        client.startTurn('ses_abort', 'local-root');
        client.setCurrentTurnUserMsgId('ses_abort', 'msg_root', 'test-root');
        client.displayTurnUserMsgIdBySession.set('ses_abort', 'msg_root');
        client.beginAppendPrompt('ses_abort', 'append-client', 'queued append', 'msg_root');
        client.bindAppendUserMessage('ses_abort', 'msg_append');
        client.finishTurn('ses_abort');
        client.mapServerEventToChatEvents('message.updated', { info: { id: 'msg_successor', sessionID: 'ses_abort', role: 'assistant', parentID: 'msg_append' } }, 'sse');
        const abort = client.mapServerEventToChatEvents('session.error', { sessionID: 'ses_abort', error: { name: 'MessageAbortedError', message: 'aborted' } }, 'sse');
        expect(abort.filter((event: any) => event.type === 'error')).toEqual([expect.objectContaining({ appendSuccessorOutcome: 'aborted', appendSuccessor: expect.objectContaining({ appendUserMsgId: 'msg_append', assistantMsgId: 'msg_successor', generation: 1 }) })]);
        client.canceledActiveTurnBySession.set('ses_abort', true);
        expect(client.mapServerEventToChatEvents('session.error', { sessionID: 'ses_abort', error: { name: 'MessageAbortedError' } }, 'sse').some((event: any) => event.type === 'error')).toBe(false);
    });
    it('preserves ordinary turnInFlight and assistant metadata transition behavior through extraction', () => {
        const { context, sessions, posts } = loadAppendSuccessorProtocolHarness();
        const session: any = { messagesById: new Map([['msg_assistant', { id: 'msg_assistant', meta: {} }]]), currentTurnAssistantKey: null, currentTurnAssistantMsgId: null, thinkingId: null };
        sessions.set('ses_f8', session);
        let exits = 0; let meta = 0; let renders = 0;
        Object.assign(context, {
            getEventSessionId: () => 'ses_f8', updateSendGate: () => undefined, maybeExitAppendInputModeAfterTurnEnd: () => { exits += 1; },
            resolveContentEventRoute: () => ({ sessionId: 'ses_f8', shouldRender: true }), retainAgentLaneParentAssociation: () => undefined,
            handleAssistantMeta: () => { meta += 1; }, tryPatchAssistantStreamingBubble: () => ({ applied: false }), renderIfActive: () => { renders += 1; }, logSessionState: () => undefined,
            activeSessionId: 'ses_f8',
        });
        expect(context.applyAppendSuccessorProtocolTransition({ type: 'turnInFlight', sessionId: 'ses_f8', inFlight: true, ownerMsgId: 'msg_assistant' })).toBe(true);
        expect(session).toEqual(expect.objectContaining({ backendTurnInFlight: true, currentTurnAssistantKey: 'msg_assistant', thinkingId: 'msg_assistant' }));
        expect(context.applyAppendSuccessorProtocolTransition({ type: 'turnInFlight', sessionId: 'ses_f8', inFlight: false })).toBe(true);
        expect(exits).toBe(1);
        expect(context.applyAppendSuccessorProtocolTransition({ type: 'assistantMessageMeta', sessionId: 'ses_f8', assistantMsgId: 'msg_assistant' })).toBe(true);
        expect(meta).toBe(1); expect(renders).toBe(1); expect(posts.length).toBeGreaterThan(0);
    });
    it('does not rekey the acknowledged append user into the canonical successor assistant', () => {
        const { context, sessions } = loadAppendSuccessorProtocolHarness();
        const root = 'msg_f8c2a5a79001WGVyQnERdJaQ8I';
        const append = 'msg_f8c2a6810001ejk13w0hUPa65S';
        const predecessor = 'msg_f8c2a5a8a001f6FVeyn7CO5Wwi';
        const successor = 'msg_f8c2ae670001KiG8j2hE8doUCp';
        const session: any = {
            messagesById: new Map([[root, { id: root, role: 'user', text: 'root' }], [append, { id: append, role: 'user', text: 'queued append' }], [predecessor, { id: predecessor, role: 'assistant', text: 'done' }]]),
            timeline: [root, append, predecessor], segmentsByNoticeKey: new Map(), clientKeyToServerId: new Map(), serverIdToClientKey: new Map(), appendRootUserKey: root, appendComposerDrafts: new Map(), currentTurnAssistantKey: append, currentTurnAssistantMsgId: append, thinkingId: append,
        };
        sessions.set('ses_f8', session);
        context.replaceKeyEverywhere(append, successor, 'ses_f8');
        expect(session.messagesById.get(append)).toEqual(expect.objectContaining({ role: 'user', text: 'queued append' }));
        expect(session.messagesById.has(successor)).toBe(false);
        expect(session.currentTurnAssistantKey).not.toBe(append);
        expect(session.timeline).toEqual([root, append, predecessor]);
    });
});
