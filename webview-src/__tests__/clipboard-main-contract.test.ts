import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

describe('clipboard attachment production ownership', () => {
  it('delegates image filtering, FileReader lifecycle, and clipboard protocol to the controller', () => {
    expect(source).toContain('const clipboardAttachmentController = createClipboardAttachmentController({');
    expect(source).toContain("input.addEventListener('paste', (event) => clipboardAttachmentController.handlePaste(event));");
    expect(source).not.toContain('function handlePaste(e)');
    expect(source).not.toContain("item.type.startsWith('image/')");
  });
});
