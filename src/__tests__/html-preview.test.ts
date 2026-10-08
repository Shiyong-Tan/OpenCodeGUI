jest.mock('vscode', () => ({ window: { createWebviewPanel: jest.fn(), showTextDocument: jest.fn() }, workspace: { openTextDocument: jest.fn() }, ViewColumn: { Active: -1 }, Uri: { file: (fsPath: string) => ({ fsPath }) } }), { virtual: true });
jest.mock('fs', () => ({ promises: { readFile: jest.fn() } }));
import * as fs from 'fs';
import * as vscode from 'vscode';
import { openHtmlPreview } from '../webview/HtmlPreview';

test('HTML preview isolates scripts, resolves relative assets and binds source to the original file', async () => {
    (fs.promises.readFile as jest.Mock).mockResolvedValue('<html><img src="figure.png"><script>hello()</script></html>');
    let listener!: (message: unknown) => Promise<void>; let disposed!: () => void;
    const dispose = jest.fn();
    const panel = { webview: { html: '', asWebviewUri: () => ({ toString: () => 'https://resource/reports' }), onDidReceiveMessage: (callback: typeof listener) => { listener = callback; return { dispose }; } }, onDidDispose: (callback: () => void) => { disposed = callback; } };
    (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);
    await openHtmlPreview('/workspace/reports/report.html', '/workspace');
    expect(panel.webview.html).toContain('sandbox="allow-scripts"');
    expect(panel.webview.html).not.toContain('allow-same-origin');
    expect(panel.webview.html).toContain('&lt;base href=&quot;https://resource/reports/&quot;');
    expect(panel.webview.html).toContain('Open source');
    await listener({ type: 'openSource', path: '/other/file' });
    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({ fsPath: '/workspace/reports/report.html' });
    disposed(); expect(dispose).toHaveBeenCalled();
});

