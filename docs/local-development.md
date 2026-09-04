# Local Development

## Start

1. Open this repository in VS Code.
2. Install dependencies:

   ```bash
   npm install
   ```

3. Start the extension and Webview watchers:

   ```bash
   npm run watch:all
   ```

4. Press `F5` and choose **Extension Development Host** if prompted.
5. In the new VS Code window, open the OpenCode sidebar from the activity bar.

## Test

Run all Jest tests:

```bash
npm test -- --runInBand
```

Run compile checks:

```bash
npm run compile
```

Stop the watcher with `Ctrl+C`.
