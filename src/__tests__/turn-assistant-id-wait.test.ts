jest.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({
            get: (_key: string, defaultValue: unknown) => defaultValue,
        }),
    },
    window: {
        createOutputChannel: () => ({
            appendLine: () => undefined,
            append: () => undefined,
            clear: () => undefined,
            show: () => undefined,
            hide: () => undefined,
            dispose: () => undefined,
        }),
    },
}), { virtual: true });

import { OpenCodeClient } from '../OpenCodeClient';

describe('turn assistant identity wait', () => {
    test('returns the owned assistant identity immediately when it exists', async () => {
        const client = new OpenCodeClient() as any;
        client.turnStateBySession.set('ses_owned', { assistantMsgId: 'msg_owned' });

        await expect(client.waitForTurnAssistantMsgId('ses_owned', 0)).resolves.toBe('msg_owned');
    });

    test('honors the timeout instead of waiting for a future turn identity', async () => {
        const client = new OpenCodeClient();

        await expect(client.waitForTurnAssistantMsgId('ses_missing', 0)).resolves.toBeUndefined();
    });
});
