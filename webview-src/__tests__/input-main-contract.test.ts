import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

describe('composer input production ownership', () => {
  it('delegates paste, input, click, and keydown listener ownership', () => {
    expect(source).toContain('const composerInputController = createComposerInputController({');
    expect(source).toContain('composerInputController.install();');
    expect(source).not.toContain("input.addEventListener('input',");
    expect(source).not.toContain("input.addEventListener('click',");
    expect(source).not.toContain("input.addEventListener('keydown',");
    expect(source).not.toContain("input.addEventListener('paste',");
  });

  it('keeps append, regular draft, mode, and send business effects behind callbacks', () => {
    expect(source).toContain('isAppendDraftActive: () => Boolean(appendInputMode && appendInputMode.sessionId === activeSessionId)');
    expect(source).toContain('session.appendComposerDrafts.set(appendInputMode.rootUserKey, value);');
    expect(source).toContain('if (session) session.inputDraft = value;');
    expect(source).toContain('onExitAppend: () => exitAppendInputMode({ restoreDraft: true })');
    expect(source).toContain('onSend: () => sendBtn.click()');
  });
});
