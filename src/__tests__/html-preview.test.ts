jest.mock('vscode', () => ({ window: { createWebviewPanel: jest.fn(), showTextDocument: jest.fn() }, workspace: { openTextDocument: jest.fn() }, ViewColumn: { Active: -1 }, Uri: { file: (fsPath: string) => ({ fsPath }) } }), { virtual: true });
jest.mock('fs', () => ({ promises: { readFile: jest.fn() } }));
import * as fs from 'fs';
import * as vscode from 'vscode';
import { openHtmlPreview, renderHtmlPreview } from '../webview/HtmlPreview';

test('HTML preview uses the direct resource loader and binds source to the original file', async () => {
    (fs.promises.readFile as jest.Mock).mockResolvedValue('<html><img src="figure.png"><script>hello()</script></html>');
    let listener!: (message: unknown) => Promise<void>; let disposed!: () => void;
    const dispose = jest.fn();
    const panel = { webview: { html: '', asWebviewUri: () => ({ toString: () => 'https://resource/reports' }), onDidReceiveMessage: (callback: typeof listener) => { listener = callback; return { dispose }; } }, onDidDispose: (callback: () => void) => { disposed = callback; } };
    (vscode.window.createWebviewPanel as jest.Mock).mockReturnValue(panel);
    await openHtmlPreview('/workspace/reports/report.html', '/workspace');
    expect(panel.webview.html).not.toContain('srcdoc=');
    expect(panel.webview.html).toContain('<base href="https://resource/reports/">');
    expect(panel.webview.html).toContain('<img src="figure.png">');
    expect(panel.webview.html).toContain('Open source');
    await listener({ type: 'openSource', path: '/other/file' });
    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith({ fsPath: '/workspace/reports/report.html' });
    disposed(); expect(dispose).toHaveBeenCalled();
});

test('preserves complete document and media markup while converting absolute local resources', () => {
    const webview = { asWebviewUri: (uri: vscode.Uri) => ({ toString: () => 'https://resource/' + uri.fsPath }) as vscode.Uri };
    const html = renderHtmlPreview('<!doctype html><html><head><title>Report</title></head><body><video controls poster="/workspace/poster.png"><source src="/workspace/movie.mp4"></video><img src="../image.png"><img src="https://example.com/img.png"></body></html>', '/workspace/report.html', webview);
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<head><base');
    expect(html).toContain('poster="https://resource//workspace/poster.png"');
    expect(html).toContain('src="https://resource//workspace/movie.mp4"');
    expect(html).toContain('src="../image.png"');
    expect(html).toContain('src="https://example.com/img.png"');
});

