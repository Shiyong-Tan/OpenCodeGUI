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
    expect(source).toContain('sessionComposerStore.addAttachment(sessionId, attachment);');
    expect(source).toContain('getAttachmentStateController().add(attachment);');
    expect(source).toContain('if (sessionId === activeSessionId)');
    expect(source).toContain('getAttachmentStateController().restoreFilePaths(draft.attachments);');
    expect(source).toContain('attachmentState.clear();');
    expect(source).toContain('getAttachmentStateController().clear();');
  });

  it('delegates send payload and image derivation to the composer submission module', () => {
    expect(source).toContain('const submission = buildComposerSubmission({');
    expect(source).toContain('attachments: attachmentState');
    expect(source).toContain('const { messageText, messageImages, attachmentsPayload, contextPayload, filesPayload } = submission;');
  });

  it('delegates attachment DOM ownership to the composer controller', () => {
    expect(source).toContain('const attachmentUiController = createAttachmentUiController({');
    expect(source).toContain('attachmentUiController.render();');
    expect(source).not.toContain("entry.className = 'attachment-image-item';");
  });
});
