import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const attribute = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Render local reports in an isolated document; source access stays bound to the original file. */
export async function openHtmlPreview(file: string, workspaceRoot: string): Promise<void> {
    const content = await fs.promises.readFile(file, 'utf8');
    const panel = vscode.window.createWebviewPanel('opencode.htmlPreview', `Preview: ${path.basename(file)}`,
        vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [vscode.Uri.file(workspaceRoot)] });
    const base = panel.webview.asWebviewUri(vscode.Uri.file(path.dirname(file))).toString().replace(/\/$/, '') + '/';
    // srcdoc uses its own base so relative styles, images and scripts resolve beside the report.
    const document = `<base href="${attribute(base)}">${content}`;
    panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><style>
        html,body{height:100%;margin:0;display:flex;flex-direction:column;background:var(--vscode-editor-background)}
        header{padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border)}
        button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:5px;padding:5px 12px;cursor:pointer}
        iframe{width:100%;flex:1;border:0;background:white}
        </style></head><body><header><button id="source">Open source</button></header>
        <iframe title="HTML preview" sandbox="allow-scripts" srcdoc="${attribute(document)}"></iframe>
        <script>const api=acquireVsCodeApi();document.getElementById('source').onclick=()=>api.postMessage({type:'openSource'});</script>
        </body></html>`;
    const subscription = panel.webview.onDidReceiveMessage(async (message: unknown) => {
        if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'openSource') {
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)), { preview: true });
        }
    });
    panel.onDidDispose(() => subscription.dispose());
}
