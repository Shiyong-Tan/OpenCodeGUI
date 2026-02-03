import * as vscode from 'vscode';
import * as cp from 'child_process';
import { SidebarProvider } from './SidebarProvider';
import { OpenCodeDiffProvider } from './OpenCodeDiffProvider';

export function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "opencode-gui" is now active!');

    const workspaceRoot = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]?.uri.fsPath;
    const diffProvider = new OpenCodeDiffProvider(workspaceRoot);

    const sidebarProvider = new SidebarProvider(context, context.extensionUri, diffProvider);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            "opencode.sidebar",
            sidebarProvider
        )
    );

    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider('opencode-diff', diffProvider)
    );

    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
            diffProvider.handleVisibleRangeChange(event.textEditor);
        })
    );

	let disposable = vscode.commands.registerCommand('opencode.checkVersion', () => {
		// Attempt to run opencode --version
		// Assuming 'opencode' is in the PATH. If not, we might need configuration for the path.
		cp.exec('opencode --version', (err, stdout, stderr) => {
			if (err) {
				console.error('Error running opencode:', err);
				vscode.window.showErrorMessage('Error: Could not run "opencode". Please ensure it is installed and in your PATH.');
				return;
			}
			
			if (stderr) {
				console.warn('opencode stderr:', stderr);
			}

			const version = stdout.trim();
			vscode.window.showInformationMessage(`OpenCode Detection Successful! Version: ${version}`);
		});
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {}
