import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const attribute = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Use the webview's resource loader directly, preserving report layout and relative assets. */
export function renderHtmlPreview(content: string, file: string, webview: Pick<vscode.Webview, 'asWebviewUri'>): string {
    const base = webview.asWebviewUri(vscode.Uri.file(path.dirname(file))).toString().replace(/\/$/, '') + '/';
    const resources = content.replace(/\b(src|poster|href)\s*=\s*(["'])(.*?)\2/gi, (original, key: string, quote: string, value: string) => {
        let uri: vscode.Uri;
        if (/^file:/i.test(value)) uri = vscode.Uri.parse(value);
        else if (path.isAbsolute(value) || /^[a-z]:[\\/]/i.test(value)) uri = vscode.Uri.file(value);
        else return original;
        return `${key}=${quote}${attribute(webview.asWebviewUri(uri).toString())}${quote}`;
    });
    const head = `<base href="${attribute(base)}">`;
    let document = /<head\b[^>]*>/i.test(resources)
        ? resources.replace(/<head\b[^>]*>/i, match => `${match}${head}`)
        : `${head}${resources}`;
    const action = `<button id="opencode-preview-source" style="position:fixed;bottom:12px;right:12px;z-index:2147483647;padding:7px 12px;border-radius:7px;border:1px solid var(--vscode-panel-border);color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer">Open source</button>
        <script>(()=>{const api=acquireVsCodeApi();document.getElementById('opencode-preview-source').onclick=()=>api.postMessage({type:'openSource'});})();</script>`;
    document = /<\/body\s*>/i.test(document) ? document.replace(/<\/body\s*>/i, `${action}</body>`) : document + action;
    return document;
}

export async function openHtmlPreview(file: string, workspaceRoot: string): Promise<void> {
    const content = await fs.promises.readFile(file, 'utf8');
    const panel = vscode.window.createWebviewPanel('opencode.htmlPreview', `Preview: ${path.basename(file)}`,
        vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [vscode.Uri.file(workspaceRoot)] });
    panel.webview.html = renderHtmlPreview(content, file, panel.webview);
    const subscription = panel.webview.onDidReceiveMessage(async (message: unknown) => {
        if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'openSource') {
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)), { preview: true });
        }
    });
    panel.onDidDispose(() => subscription.dispose());
}
