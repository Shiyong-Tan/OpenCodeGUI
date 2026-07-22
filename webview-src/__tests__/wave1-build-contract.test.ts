import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('Wave 1 build and package contracts', () => {
  test('extension compile remains distinct while compile and prepublish are complete and non-duplicative', () => {
    const scripts = JSON.parse(read('package.json')).scripts;
    expect(scripts['compile:extension']).toBe('tsc -p ./');
    expect(scripts.compile).toBe('npm run compile:extension && npm run build:webview');
    expect(scripts['vscode:prepublish']).toBe('npm run compile');
  });

  test('production and watch builds are local IIFE workflows', () => {
    const packageJson = JSON.parse(read('package.json'));
    expect(packageJson.scripts['build:webview']).toBeDefined();
    expect(packageJson.scripts['watch:webview']).toBeDefined();
    expect(packageJson.scripts.watch).toBe('tsc -watch -p ./');
    expect(packageJson.scripts['watch:all']).toBe('node scripts/watch-all.js');
    expect(packageJson.scripts['check:webview:determinism']).toBeDefined();
    expect(packageJson.scripts['check:webview:package']).toBeDefined();
    const buildScript = read('scripts/build-rendering.js');
    expect(buildScript).toContain("format: 'iife'");
    expect(buildScript).toContain("outfile: path.join(root, 'media', 'rendering.bundle.js')");
    expect(buildScript).toContain("outfile: path.join(root, 'media', 'features.bundle.js')");
    expect(buildScript).toContain("outfile: path.join(root, 'media', 'undo.bundle.js')");
    expect(buildScript).toContain("outfile: path.join(root, 'media', 'continuation.bundle.js')");
    const watchAll = read('scripts/watch-all.js');
    expect(watchAll).toContain("'--watch', '-p', './'");
    expect(watchAll).toContain("path.join(root, 'scripts', 'build-rendering.js'), '--watch'");
    expect(watchAll).toContain("process.on('SIGINT'");
    expect(watchAll).toContain("process.on('SIGTERM'");
  });

  test('source-map smoke restores production state in finally', () => {
    const sourceMapCheck = read('scripts/check-rendering-source-map.js');
    expect(sourceMapCheck).toContain('finally');
    expect(sourceMapCheck).toContain('fs.rmSync(mapFile, { force: true })');
    expect(sourceMapCheck).toContain("['scripts/build-rendering.js']");
  });

  test('generated production bundle is ignored but package policy includes it and excludes source/map', () => {
    expect(read('.gitignore')).toContain('media/rendering.bundle.js');
    expect(read('.gitignore')).toContain('media/features.bundle.js');
    expect(read('.gitignore')).toContain('media/undo.bundle.js');
    expect(read('.gitignore')).toContain('media/continuation.bundle.js');
    const vscodeIgnore = read('.vscodeignore');
    expect(vscodeIgnore).toContain('webview-src/**');
    expect(vscodeIgnore).toContain('*.map');
    expect(vscodeIgnore).not.toContain('media/rendering.bundle.js');
  });

  test('provider resolves and loads modular bundles before legacy main.js without CSP or nonce', () => {
    const provider = read('src/SidebarProvider.ts');
    expect(provider).toContain('vscode.Uri.joinPath(this._extensionUri, "media", "rendering.bundle.js")');
    expect(provider).toContain('vscode.Uri.joinPath(this._extensionUri, "media", "features.bundle.js")');
    expect(provider).toContain('vscode.Uri.joinPath(this._extensionUri, "media", "undo.bundle.js")');
    expect(provider).toContain('vscode.Uri.joinPath(this._extensionUri, "media", "continuation.bundle.js")');
    expect(provider).toMatch(/<script src="\$\{renderingScriptUri\}"><\/script>\s*<script src="\$\{featureScriptUri\}"><\/script>\s*<script src="\$\{undoScriptUri\}"><\/script>\s*<script src="\$\{continuationScriptUri\}"><\/script>\s*<script src="\$\{scriptUri\}"><\/script>/);
    expect(provider).not.toMatch(/Content-Security-Policy|nonce=/);
  });

  test('the keyed renderer exclusively owns the initial chat greeting root', () => {
    const provider = read('src/SidebarProvider.ts').replace(/\r\n/g, '\n');
    expect(provider).toContain('<div class="chat-area" id="chat"></div>');
    expect(provider).not.toMatch(/<div class="chat-area" id="chat">\s*<div class="message bot">/);
    const main = read('media/main.js');
    expect(main).toContain("loadingHistory ? `history-loading:${activeSessionId}` : `greeting:${activeSessionId || 'none'}`");
    expect(main).toContain("value: loadingHistory ? { text: 'Loading history ...' } : null");
  });

  test('long chats expose one floating jump-to-latest control outside the keyed chat root', () => {
    const provider = read('src/SidebarProvider.ts');
    const main = read('media/main.js');
    const css = read('media/main.css');
    expect(provider).toContain('class="chat-scroll-shell"');
    expect(provider).toContain('id="chat-jump-bottom"');
    expect(provider).toMatch(/<div class="chat-area" id="chat"><\/div>\s*<button class="chat-jump-bottom hidden"/);
    expect(main).toContain("chatJumpBottomBtn?.addEventListener('click'");
    expect(main).toContain('scrollToBottom(true);');
    expect(css).toContain('.chat-jump-bottom.hidden');
  });
});
