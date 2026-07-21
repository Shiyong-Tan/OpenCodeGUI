import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

describe('file mention production ownership', () => {
  it('does not retain parallel mention state, timer, result, or DOM implementations', () => {
    expect(source).not.toContain('const fileMentionState = {');
    expect(source).not.toContain('function findActiveFileMention()');
    expect(source).not.toContain('function requestFileMentionResults()');
    expect(source).not.toContain('function renderFileMentionList()');
    expect(source).not.toContain("empty.textContent = 'No files found';");
  });

  it('delegates scheduling, closing, keyboard navigation, and result correlation to the controller', () => {
    expect(source).toContain('const fileMentionController = createFileMentionController({');
    expect(source).toContain('fileMentionController.schedule();');
    expect(source).toContain('fileMentionController.close();');
    expect(source).toContain('if (fileMentionController.handleKeydown(e)) return;');
    expect(source).toContain('fileMentionController.handleResults(message.requestId, files);');
  });
});
