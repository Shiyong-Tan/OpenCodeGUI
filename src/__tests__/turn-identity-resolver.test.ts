import { buildFinalizeTurnIdentity } from '../continuation/TurnIdentityResolver';

describe('buildFinalizeTurnIdentity', () => {
    const source = {
        getAppendRootUserMsgId: () => 'msg_root',
        getCurrentTurnUserMsgId: () => 'msg_current',
        getLatestAppendUserMsgId: () => 'msg_append',
        getTurnAssistantMsgId: () => 'msg_assistant',
    };

    test('uses the latest append as user while retaining the root and assistant identities', () => {
        expect(buildFinalizeTurnIdentity(source, 'session-a')).toEqual({
            sessionId: 'session-a',
            userMessageId: 'msg_append',
            assistantMessageId: 'msg_assistant',
            rootUserMessageId: 'msg_root',
            latestAppendUserMessageId: 'msg_append',
        });
    });

    test('preserves explicit identities and payload fields', () => {
        expect(buildFinalizeTurnIdentity(source, 'session-a', {
            reqId: 'request-a',
            userMessageId: 'msg_explicit_user',
            assistantMessageId: 'msg_explicit_assistant',
            rootUserMessageId: 'msg_explicit_root',
            latestAppendUserMessageId: 'msg_explicit_append',
        })).toMatchObject({
            sessionId: 'session-a',
            reqId: 'request-a',
            userMessageId: 'msg_explicit_user',
            assistantMessageId: 'msg_explicit_assistant',
            rootUserMessageId: 'msg_explicit_root',
            latestAppendUserMessageId: 'msg_explicit_append',
        });
    });

    test('falls back to current user when no append root exists', () => {
        const noAppendSource = {
            ...source,
            getAppendRootUserMsgId: () => undefined,
            getLatestAppendUserMsgId: () => undefined,
        };
        expect(buildFinalizeTurnIdentity(noAppendSource, 'session-a')).toMatchObject({
            userMessageId: 'msg_current',
            rootUserMessageId: 'msg_current',
        });
    });
});
