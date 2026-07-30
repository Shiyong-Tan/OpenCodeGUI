import fs from 'fs';
import path from 'path';

const main = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
const provider = fs.readFileSync(path.join(process.cwd(), 'src', 'SidebarProvider.ts'), 'utf8');
const inputController = fs.readFileSync(
  path.join(process.cwd(), 'webview-src', 'features', 'composer', 'input-controller.ts'),
  'utf8',
);

describe('local word completion production ownership', () => {
  it('loads a dedicated bundle and delegates input interaction to its controller', () => {
    expect(provider).toContain('"media", "word-completion.bundle.js"');
    expect(provider).toContain('<script src="${wordCompletionScriptUri}"></script>');
    expect(main).toContain('window.__ocWordCompletion?.createWordCompletionController');
    expect(main).toContain('wordCompletion: wordCompletionController');
    expect(inputController).toContain('if (options.fileMention.handleKeydown(event)) return;');
    expect(inputController).toContain('if (options.wordCompletion?.handleKeydown(event)) return;');
  });

  it('keeps completion behind mentions and outside chat history state', () => {
    expect(main).toContain("type: 'getWorkspaceCompletionTerms'");
    expect(main).toContain("case 'workspaceCompletionTerms':");
    expect(main).not.toContain('session.wordCompletion');
    expect(main).not.toContain('snapshot.wordCompletion');
  });
});
