# OpenCode GUI

OpenCode GUI is a powerful Visual Studio Code extension that brings the capabilities of the OpenCode CLI directly into your editor through a sleek, interactive sidebar.

## Features

- **Interactive AI Chat**: Communicate with OpenCode directly from the VS Code sidebar.
- **Code Modification**: High-level chat-based code editing and generation.
- **Diff View**: Built-in diff provider to visualize and review changes proposed by the AI before they are applied.
- **Session Management**: Easily create, view, and switch between different chat sessions.
- **Model Selection**: Switch between different AI models and variants supported by OpenCode.
- **File Attachments**: Attach files or images from your clipboard to provide context for your requests.
- **Undo/Redo Support**: Revert or restore changes made during a session with ease.
  + **Undo**: Revert AI-generated changes back to any previous state using Git-powered tracking
  + **Restore**: Restore previously undone changes within the same session
  + **Visual Conflict Resolution**: Review and resolve conflicts when undoing changes
  + **Session History**: Full history of all changes tracked per session

## Installation

### Prerequisites

- [OpenCode CLI](https://github.com/Shiyong-Tan/OpenCodeCLI) must be installed and available in your `PATH`.
- **Git 2.30.0 or higher** must be installed and available in your `PATH`. The extension uses Git to track and manage code changes.
- VS Code version 1.80.0 or higher.

### From VSIX

1. Download the `opencode-gui-0.0.1.vsix` file.
2. In VS Code, open the Extensions view (`Ctrl+Shift+X`).
3. Click on the "..." (Views and More Actions) menu and select "Install from VSIX...".
4. Select the downloaded file and restart VS Code.

## Usage

1. Open the OpenCode sidebar by clicking on the OpenCode icon in the Activity Bar.
2. Use the chat interface to ask questions, request code changes, or explore your project.
3. Review changes in the diff view that automatically opens when OpenCode proposes modifications.
4. Manage your sessions and settings (model, variant, mode) directly in the sidebar.

## Server Reuse (Per Workspace)

OpenCode GUI manages the OpenCode background server per workspace using a lock file.

- Lock path: `.opencode/server.lock.json` in the workspace root.
- Stores: workspace-specific `port` and `password`.
- Reuses an existing server when the health check succeeds with Basic Auth.
- If the lock port is occupied by a different server, OpenCode GUI migrates to a new port and updates the lock file.

## Troubleshooting

- If model or variant is not shown after loading the extension, run `Developer: Reload Window` once and wait for initialization to complete.

## How Undo/Restore Works

OpenCode GUI uses Git to track and manage code changes:

1. **Baseline Tracking**: When a session starts, a baseline Git commit is created
2. **Change Recording**: Each AI response is tracked with its own Git commit
3. **Undo**: Reverts workspace files to the baseline commit state
4. **Restore**: Re-applies previously undone changes from history

> **Note**: All changes are stored locally in `.opencode/` directory. No data is sent to external servers for undo functionality.

## Commands

- `OpenCode: Check Version`: Verifies that the OpenCode CLI is correctly installed and accessible.

## Contributing

Contributions are welcome! Please feel free to submit pull requests or open issues on the [GitHub repository](https://github.com/Shiyong-Tan/OpenCodeGUI).

## License

This project is licensed under the MIT License.
