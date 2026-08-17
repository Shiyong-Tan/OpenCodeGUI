jest.mock('vscode', () => ({
    workspace: {
        workspaceFolders: [{ uri: { fsPath: 'D:\\workspace root' } }],
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

describe('OpenCodeClient session fork', () => {
    test('posts an end-of-session fork with encoded owner identity and workspace', async () => {
        const client = new OpenCodeClient() as any;
        client.ensureServer = jest.fn(async () => undefined);
        client.workspaceRoot = 'D:\\workspace root';
        client.requestJson = jest.fn(async () => ({ id: 'session-child' }));

        await expect(client.forkSession('session/source')).resolves.toEqual({ id: 'session-child' });

        expect(client.requestJson).toHaveBeenCalledWith(
            'POST',
            '/session/session%2Fsource/fork?directory=D%3A%5Cworkspace%20root',
            {},
        );
    });

    test('rejects a response without a child session ID', async () => {
        const client = new OpenCodeClient() as any;
        client.ensureServer = jest.fn(async () => undefined);
        client.requestJson = jest.fn(async () => ({}));

        await expect(client.forkSession('session-source')).rejects.toThrow('Failed to fork session.');
    });

    test('reports active turn ownership without consulting the selected session', () => {
        const client = new OpenCodeClient() as any;
        client.turnStateBySession.set('session-a', {});
        client.currentSessionId = 'session-b';

        expect(client.hasActiveTurn('session-a')).toBe(true);
        expect(client.hasActiveTurn('session-b')).toBe(false);
    });
});
