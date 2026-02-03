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

## Installation

### Prerequisites

- [OpenCode CLI](https://github.com/Shiyong-Tan/OpenCodeCLI) must be installed and available in your `PATH`.
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

## Commands

- `OpenCode: Check Version`: Verifies that the OpenCode CLI is correctly installed and accessible.

## Contributing

Contributions are welcome! Please feel free to submit pull requests or open issues on the [GitHub repository](https://github.com/Shiyong-Tan/OpenCodeGUI).

## License

This project is licensed under the MIT License.
