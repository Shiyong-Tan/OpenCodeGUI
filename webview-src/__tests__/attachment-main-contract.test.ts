import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

describe('composer attachment production ownership', () => {
  it('does not retain a parallel mutable attachment array in main.js', () => {
    expect(source).not.toMatch(/^let attachments = \[\];/m);
    expect(source).not.toContain('attachments.push(');
    expect(source).not.toContain('attachments.splice(');
  });

  it('routes extension events, draft restoration, removal, and clearing through attachment state', () => {
    expect(source).toContain('attachmentStateController = factory();');
    expect(source).toContain('getAttachmentStateController().add({');
    expect(source).toContain('getAttachmentStateController().restoreFilePaths(draft.attachments);');
    expect(source).toContain('attachmentState.removeById(item.id)');
    expect(source).toContain('attachmentState.clear();');
    expect(source).toContain('getAttachmentStateController().clear();');
  });

  it('delegates send payload and image derivation to attachment state', () => {
    expect(source).toContain('attachmentState.getMessageImages();');
    expect(source).toContain('attachmentState.getPayload();');
    expect(source).toContain('attachmentState.hasNonImage();');
  });
});
