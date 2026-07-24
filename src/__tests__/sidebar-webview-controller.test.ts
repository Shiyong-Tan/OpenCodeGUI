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
const sessionControllerSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'webview', 'controllers', 'SessionCommandController.ts'), 'utf8',
);
const turnControllerSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'webview', 'controllers', 'TurnCommandController.ts'), 'utf8',
);
const undoControllerSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'webview', 'controllers', 'UndoCommandController.ts'), 'utf8',
);
const lifecycleControllerSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'webview', 'controllers', 'WebviewLifecycleController.ts'), 'utf8',
);

describe('SidebarWebviewController', () => {
  test('SidebarProvider retains only the VS Code compatibility delegation', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'SidebarProvider.ts'), 'utf8');
    expect(source).toMatch(/public resolveWebviewView\([\s\S]*?return resolveSidebarWebviewView\([\s\S]*?this\.sidebarWebviewDependencies[\s\S]*?\);\s*}/);
  });

  test('keeps the major protocol owners in one command dispatcher', () => {
    for (const command of ['undoToMessage', 'restoreSegment']) {
      expect(undoControllerSource).toContain(`case "${command}"`);
      expect(controllerSource).not.toContain(`case "${command}"`);
    }
    expect(turnControllerSource).toContain('case "sendMessage"');
    for (const command of ['selectSession', 'snapshotTimelineIds']) {
      expect(sessionControllerSource).toContain(`case '${command}'`);
    }
    expect(controllerSource).toContain('const utilityHandling = utilityCommandHandler(data, activeWebview, webviewView.webview)');
    expect(controllerSource).toContain('utilityHandling !== false && await utilityHandling');
    expect(controllerSource).toContain('const sessionHandling = sessionCommandHandler(data, activeWebview, webviewView.webview)');
    expect(controllerSource).toContain('const turnHandling = turnCommandHandler(data, activeWebview, webviewView.webview)');
    expect(controllerSource).toContain('const undoHandling = undoCommandHandler(data, activeWebview, webviewView.webview)');
    expect(controllerSource).toContain('const lifecycleHandling = lifecycleController.handleCommand(');
    expect(lifecycleControllerSource).toContain("case 'webviewReady'");
    expect(sessionControllerSource).toContain('this.host.handleSnapshotTimelineIds(data.payload)');
  });

  test('reapplies cached append metadata to every selected-session hydration payload', () => {
    expect(sessionControllerSource).toContain('const restoreCachedAppendMetadata = (messages: SessionMessage[])');
    expect(sessionControllerSource).toContain('const snapshotMessages = restoreCachedAppendMetadata(snapshotFormatted.messages)');
    expect(sessionControllerSource).toContain('const mergedMessages = restoreCachedAppendMetadata(mergedMessagesRaw)');
    expect(sessionControllerSource).toContain('const fullMessages = restoreCachedAppendMetadata(formatted.messages)');
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
      beginWebviewLifecycleResolution: (targetView: any) => {
        host._view = targetView;
        return 'panel-1';
      },
      getLifecycleActiveWebview: (fallback?: any) => host._view?.webview || fallback,
      handleWebviewLifecycleVisibility: jest.fn(),
      handleWebviewLifecycleDispose: jest.fn(),
      startWebviewLivenessProbes: jest.fn(), stopWebviewLivenessProbes: jest.fn(), triggerWebviewLivenessProbe: jest.fn(),
    };
    resolveSidebarWebviewView(
      view,
      {} as any,
      {} as any,
      {
        localResourceRoots: [{} as any],
        getHtmlForWebview: () => '<html></html>',
        log: jest.fn(),
        utilityCommandHandler: () => false,
        sessionCommandHandler: () => false,
        turnCommandHandler: () => false,
        undoCommandHandler: () => false,
        lifecycleController: {
          begin: (targetView: any) => host.beginWebviewLifecycleResolution(targetView),
          getActiveWebview: (fallback: any) => host.getLifecycleActiveWebview(fallback),
          handleCommand: () => false,
          handleVisibility: (targetView: any) => host.handleWebviewLifecycleVisibility(targetView),
          handleDispose: (panelId: string) => host.handleWebviewLifecycleDispose(panelId),
        },
      },
    );
    expect(host._view).toBe(view);
    expect(webview.options).toEqual({ enableScripts: true, localResourceRoots: [{}] });
    expect(webview.html).toBe('<html></html>');
    expect(Object.keys(callbacks).sort()).toEqual(['dispose', 'message', 'visibility']);
  });
});
