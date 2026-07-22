jest.mock('vscode', () => ({
  window: {
    createOutputChannel: () => ({ appendLine: () => undefined, append: () => undefined, dispose: () => undefined }),
    showErrorMessage: () => undefined,
    showInformationMessage: () => undefined,
  },
  workspace: { workspaceFolders: [] },
  Uri: { joinPath: (...parts: any[]) => parts.join('/') },
}), { virtual: true });

import * as fs from 'fs';
import * as path from 'path';
import { resolveSidebarWebviewView } from '../webview/SidebarWebviewController';

const controllerSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'webview', 'SidebarWebviewController.ts'), 'utf8',
);

describe('SidebarWebviewController', () => {
  test('SidebarProvider retains only the VS Code compatibility delegation', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'SidebarProvider.ts'), 'utf8');
    expect(source).toMatch(/public resolveWebviewView\([\s\S]*?return resolveSidebarWebviewView\(this, webviewView, context, _token\);\s*}/);
  });

  test('keeps the major protocol owners in one command dispatcher', () => {
    for (const command of ['selectSession', 'sendMessage', 'undoToMessage', 'restoreSegment', 'smartSessionSearch', 'snapshotTimelineIds']) {
      expect(controllerSource).toContain(`case "${command}"`);
    }
    expect(controllerSource).toContain('host.handleSnapshotTimelineIds(data.payload)');
  });

  test('registers message, visibility, and disposal lifecycles once', () => {
    const callbacks: Record<string, Function> = {};
    const webview: any = {
      options: {}, html: '',
      onDidReceiveMessage: (callback: Function) => { callbacks.message = callback; },
    };
    const view: any = {
      webview, visible: true,
      onDidChangeVisibility: (callback: Function) => { callbacks.visibility = callback; },
      onDidDispose: (callback: Function) => { callbacks.dispose = callback; },
    };
    const host: any = {
      _view: undefined, webviewLivenessPanelSeq: 0, _webviewInstanceId: '', _extensionUri: {}, initPosted: false,
      resetWebviewLiveness: jest.fn(),
      uiDebugChannel: { appendLine: jest.fn() },
      _getHtmlForWebview: () => '<html></html>',
      startWebviewLivenessProbes: jest.fn(), stopWebviewLivenessProbes: jest.fn(), triggerWebviewLivenessProbe: jest.fn(),
    };
    resolveSidebarWebviewView(host, view, {} as any, {} as any);
    expect(host._view).toBe(view);
    expect(webview.options).toEqual({ enableScripts: true, localResourceRoots: [{}] });
    expect(webview.html).toBe('<html></html>');
    expect(Object.keys(callbacks).sort()).toEqual(['dispose', 'message', 'visibility']);
  });
});
