import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

describe('composer context production ownership', () => {
  it('does not retain parallel context and file reference arrays', () => {
    expect(source).not.toMatch(/^let pendingContextItems = \[\];/m);
    expect(source).not.toMatch(/^let pendingFileRefs = \[\];/m);
    expect(source).not.toContain('pendingContextItems.push(');
    expect(source).not.toContain('pendingFileRefs.push(');
  });

  it('routes add, remove, reset, display, and send payload behavior through context state', () => {
    expect(source).toContain('composerContextStateController = factory();');
    expect(source).toContain('getComposerContextStateController().addContext(displayText, payload)');
    expect(source).toContain('getComposerContextStateController().addFileRef(normalized);');
    expect(source).toContain('contextState.removeContext(item)');
    expect(source).toContain('contextState.removeFileRef(item.path)');
    expect(source).toContain('contextState.getDisplayPrefix();');
    expect(source).toContain('contextState.getContextPayload();');
    expect(source).toContain('contextState.getFilesPayload();');
    expect(source).toContain('contextState.clear();');
  });
});
