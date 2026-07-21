import { createAttachmentState } from '../features/composer/attachment-state';
import { createComposerContextState } from '../features/composer/context-state';
import { buildComposerSubmission } from '../features/composer/submission';

describe('composer submission', () => {
  it('rejects an empty composer', () => {
    expect(buildComposerSubmission({
      text: '  ', attachments: createAttachmentState(), context: createComposerContextState(),
    })).toBeNull();
  });

  it('preserves context prefix, newline, images, and extension payloads', () => {
    const attachments = createAttachmentState([{
      name: 'shot.png', mime: 'image/png', dataUrl: 'data:image/png;base64,QQ==',
    }]);
    const context = createComposerContextState();
    context.addContext('selection', { text: 'selected', source: 'editor' });
    context.addFileRef({ path: 'src/a.ts' });
    expect(buildComposerSubmission({ text: 'explain', attachments, context })).toEqual({
      messageText: 'selection @src/a.ts\nexplain',
      messageImages: ['data:image/png;base64,QQ=='],
      attachmentsPayload: [{ filename: 'shot.png', mime: 'image/png', dataBase64: 'QQ==', tempPath: undefined }],
      contextPayload: [{ displayText: 'selection', text: 'selected', source: 'editor', filePath: undefined, range: undefined }],
      filesPayload: ['src/a.ts'],
    });
  });

  it('preserves attachment-only fallback copy', () => {
    expect(buildComposerSubmission({
      text: '', attachments: createAttachmentState([{ name: 'notes.txt' }]), context: createComposerContextState(),
    })?.messageText).toBe('Attachment added.');
    expect(buildComposerSubmission({
      text: '', attachments: createAttachmentState([{ name: 'img-paste', mime: 'image/png' }]), context: createComposerContextState(),
    })?.messageText).toBe('Image attached.');
  });
});
