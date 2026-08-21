jest.mock('vscode', () => ({
    workspace: {
        workspaceFolders: [{ uri: { fsPath: 'D:\\0.Code\\OpenCodeGUI' } }],
        getConfiguration: () => ({
            get: (_key: string, defaultValue: unknown) => defaultValue,
        }),
        asRelativePath: (p: string) => p,
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
        showInformationMessage: () => undefined,
        showErrorMessage: () => undefined,
    },
    Uri: {
        file: (fsPath: string) => ({ fsPath }),
        joinPath: (...parts: any[]) => ({ fsPath: parts.map((p) => p?.fsPath || String(p)).join('/') }),
    },
    commands: {
        executeCommand: async () => undefined,
    },
    env: {
        clipboard: {
            readText: async () => '',
        },
    },
}), { virtual: true });

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SidebarProvider } from '../../SidebarProvider';
import { OpenCodeDiffProvider } from '../../OpenCodeDiffProvider';
import { OpenCodeClient } from '../../OpenCodeClient';

const USER_OWNED_SESSIONS_KEY = 'opencode.userOwnedSessionIds.v1';
const createdProviders: Array<{ dispose: () => Promise<void> }> = [];
const tempRoots: string[] = [];

function createProvider(workspaceRoot: string, stored: Record<string, string | undefined> = {}): any {
    const store = new Map<string, string | undefined>(Object.entries(stored));
    const context: any = {
        globalState: {
            get: (key: string) => store.get(key),
            update: (key: string, value: string | undefined) => {
                if (typeof value === 'undefined') {
                    store.delete(key);
                } else {
                    store.set(key, value);
                }
                return Promise.resolve();
            },
        },
        extensionUri: { fsPath: workspaceRoot },
        globalStoragePath: path.join(workspaceRoot, '.tmp-storage'),
    };
    const diffProvider = { updateFromSnapshot: jest.fn() } as unknown as OpenCodeDiffProvider;
    const provider = new SidebarProvider(context, context.extensionUri, diffProvider) as any;
    createdProviders.push(provider);
    provider.client = {
        getWorkspaceRoot: jest.fn().mockReturnValue(workspaceRoot),
        getSessionInfo: jest.fn((sessionId: string) => {
            const cwdBySession: Record<string, string | undefined> = {
                ses_main_info_match: workspaceRoot,
                ses_child_info_match: workspaceRoot,
                ses_other_info: path.join(workspaceRoot, '..', 'other'),
            };
            return Promise.resolve({ path: { cwd: cwdBySession[sessionId] } });
        }),
        dispose: jest.fn().mockResolvedValue(undefined),
        shutdownServer: jest.fn().mockResolvedValue(undefined),
    };
    provider.uiDebugChannel = { appendLine: jest.fn() };
    provider.getWorkspaceRootPath = () => workspaceRoot;
    return { provider, store };
}

async function createTempWorkspace(): Promise<string> {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'opencode-parentid-'));
    tempRoots.push(root);
    return root;
}

afterEach(async () => {
    await Promise.all(createdProviders.splice(0).map((provider) => typeof provider.dispose === 'function' ? provider.dispose() : undefined));
    await Promise.all(tempRoots.splice(0).map((root) => fs.promises.rm(root, { recursive: true, force: true })));
});

describe('SidebarProvider parentID session history filtering', () => {
    it('asks OpenCode to filter root sessions before applying the result limit', async () => {
        const client = new OpenCodeClient() as any;
        client.workspaceRoot = 'D:\\workspace';
        client.ensureServer = jest.fn().mockResolvedValue(undefined);
        client.requestJson = jest.fn().mockResolvedValue([
            {
                id: 'ses_child_backend',
                title: 'Child',
                parentID: 'ses_parent_backend',
                path: { cwd: 'D:\\workspace' },
                time: { updated: 20 },
            },
            {
                id: 'ses_main_backend',
                title: 'Main',
                path: { cwd: 'D:\\workspace' },
                time: { updated: 10 },
            },
        ]);

        const sessions = await client.listSessions();

        expect(client.requestJson).toHaveBeenCalledWith(
            'GET',
            '/session?directory=D%3A%5Cworkspace&roots=true&limit=1000'
        );
        expect(sessions).toEqual([
            expect.objectContaining({ id: 'ses_child_backend', parentID: 'ses_parent_backend' }),
            expect.objectContaining({ id: 'ses_main_backend', parentID: undefined }),
        ]);
    });

    it('includes same-workspace main sessions and excludes child sessions regardless of persisted trust', async () => {
        const workspaceRoot = await createTempWorkspace();
        const { provider, store } = createProvider(workspaceRoot, {
            [USER_OWNED_SESSIONS_KEY]: JSON.stringify(['ses_child_owned', 'ses_main_owned']),
        });
        const workspaceKey = provider.getWorkspaceKeyForRoot(workspaceRoot);
        store.set(`recentSession.${workspaceKey}`, 'ses_child_recent');
        provider.currentSessionId = 'ses_child_current';

        const snapshotDir = path.join(workspaceRoot, '.opencode', 'sessionSnapshots');
        await fs.promises.mkdir(snapshotDir, { recursive: true });
        await fs.promises.writeFile(
            path.join(snapshotDir, 'ses_child_snapshot.json'),
            JSON.stringify({ sessionId: 'ses_child_snapshot', sessionData: { sessionId: 'ses_child_snapshot' } }),
            'utf-8'
        );

        const sessions = [
            { id: 'ses_main_owned', cwd: workspaceRoot },
            { id: 'ses_main_raw', cwd: workspaceRoot },
            { id: 'ses_child_owned', cwd: workspaceRoot, parentID: 'ses_parent' },
            { id: 'ses_child_recent', cwd: workspaceRoot, parentID: 'ses_parent' },
            { id: 'ses_child_current', cwd: workspaceRoot, parentID: 'ses_parent' },
            { id: 'ses_child_snapshot', cwd: workspaceRoot, parentID: 'ses_parent' },
        ];

        const filtered = await provider.filterSessionsForWorkspace(sessions, workspaceRoot, 'test-parentid');

        expect(filtered.map((session: any) => session.id)).toEqual(['ses_main_owned', 'ses_main_raw']);
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('excludedChildSessions=4'));
        expect(JSON.parse(store.get(USER_OWNED_SESSIONS_KEY) || '[]')).toEqual(['ses_child_owned', 'ses_main_owned']);
    });

    it('keeps missing-cwd compatibility for main sessions only', async () => {
        const workspaceRoot = await createTempWorkspace();
        const { provider } = createProvider(workspaceRoot);

        const sessions = [
            { id: 'ses_main_info_match' },
            { id: 'ses_main_missing_cwd' },
            { id: 'ses_child_missing_cwd', parentID: 'ses_parent' },
            { id: 'ses_other_info' },
        ];

        const filtered = await provider.filterSessionsForWorkspace(sessions, workspaceRoot, 'test-missing-cwd');

        expect(filtered.map((session: any) => session.id)).toEqual(['ses_main_info_match', 'ses_main_missing_cwd']);
        expect(provider.client.getSessionInfo).not.toHaveBeenCalledWith('ses_child_missing_cwd');
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('mainWorkspaceUnknown=1'));
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('mainWorkspaceMismatch=1'));
    });

    it('when workspace is unavailable, still excludes only child sessions from history', async () => {
        const workspaceRoot = await createTempWorkspace();
        const { provider } = createProvider(workspaceRoot);

        const sessions = [
            { id: 'ses_main_no_workspace' },
            { id: 'ses_child_no_workspace', parentID: 'ses_parent' },
        ];

        const filtered = await provider.filterSessionsForWorkspace(sessions, undefined, 'test-no-workspace');

        expect(filtered.map((session: any) => session.id)).toEqual(['ses_main_no_workspace']);
        expect(provider.client.getSessionInfo).not.toHaveBeenCalled();
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('workspace=null'));
        expect(provider.uiDebugChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining('excludedChildSessions=1'));
    });

    it('uses the parentID filter in the refresh sessions path', async () => {
        const workspaceRoot = await createTempWorkspace();
        const { provider } = createProvider(workspaceRoot);
        provider.client.listSessions = jest.fn().mockResolvedValue([
            { id: 'ses_child_refresh', title: 'Child', updated: '', cwd: workspaceRoot, parentID: 'ses_parent' },
            { id: 'ses_main_refresh', title: 'Main', updated: '', cwd: workspaceRoot },
        ]);
        const webview = { postMessage: jest.fn() };

        await provider.refreshSessions(webview, 'req-refresh-parentid');

        expect(webview.postMessage).toHaveBeenCalledWith({
            type: 'sessionsList',
            requestId: 'req-refresh-parentid',
            sessions: [expect.objectContaining({ id: 'ses_main_refresh' })],
        });
        const payload = webview.postMessage.mock.calls.find(([message]: any[]) => message?.type === 'sessionsList')?.[0];
        expect(payload.sessions.map((session: any) => session.id)).toEqual(['ses_main_refresh']);
    });

    it('uses the parentID filter in the init history payload', async () => {
        const workspaceRoot = await createTempWorkspace();
        const { provider } = createProvider(workspaceRoot);
        provider.currentSessionId = 'ses_main_init';
        provider.client.listModels = jest.fn().mockResolvedValue([]);
        provider.client.listAgents = jest.fn().mockResolvedValue([]);
        provider.client.listSessions = jest.fn().mockResolvedValue([
            { id: 'ses_child_init', title: 'Child', updated: '', cwd: workspaceRoot, parentID: 'ses_parent' },
            { id: 'ses_main_init', title: 'Main', updated: '', cwd: workspaceRoot },
        ]);
        provider.client.setSessionId = jest.fn();
        const webview = { postMessage: jest.fn() };

        await provider.sendInit(webview);

        const initPayload = webview.postMessage.mock.calls.find(([message]: any[]) => message?.type === 'init')?.[0];
        expect(initPayload).toBeTruthy();
        expect(initPayload.sessions.map((session: any) => session.id)).toEqual(['ses_main_init']);
        expect(initPayload.currentSessionId).toBe('ses_main_init');
    });
});
