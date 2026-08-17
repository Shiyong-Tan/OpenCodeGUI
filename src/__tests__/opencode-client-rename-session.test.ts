jest.mock('vscode', () => ({
    workspace: {
        workspaceFolders: [{ uri: { fsPath: 'D:\\workspace root' } }],
        getConfiguration: () => ({ get: (_key: string, defaultValue: unknown) => defaultValue }),
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

describe('OpenCodeClient session rename', () => {
    test('patches the encoded session in the owning workspace', async () => {
        const client = new OpenCodeClient() as any;
        client.ensureServer = jest.fn(async () => undefined);
        client.workspaceRoot = 'D:\\workspace root';
        client.requestJson = jest.fn(async () => ({ id: 'session/source', title: 'New title' }));

        await expect(client.renameSession('session/source', '  New title  ')).resolves.toEqual({
            id: 'session/source',
            title: 'New title',
        });
        expect(client.requestJson).toHaveBeenCalledWith(
            'PATCH',
            '/session/session%2Fsource?directory=D%3A%5Cworkspace%20root',
            { title: 'New title' },
        );
    });

    test('rejects an empty title before contacting the server', async () => {
        const client = new OpenCodeClient() as any;
        client.ensureServer = jest.fn(async () => undefined);
        client.requestJson = jest.fn();

        await expect(client.renameSession('session-a', '   ')).rejects.toThrow(
            'Session title cannot be empty.'
        );
        expect(client.ensureServer).not.toHaveBeenCalled();
    });
});
