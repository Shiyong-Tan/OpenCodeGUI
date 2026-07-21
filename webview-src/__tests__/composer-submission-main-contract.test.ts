import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');

describe('composer submission production ownership', () => {
  it('delegates emptiness, fallback text, prefix, image, attachment, context, and file payload derivation', () => {
    expect(source).toContain('const buildComposerSubmission = window.__ocFeatures?.buildComposerSubmission;');
    expect(source).toContain('const submission = buildComposerSubmission({');
    expect(source).toContain('const { messageText, messageImages, attachmentsPayload, contextPayload, filesPayload } = submission;');
    expect(source).not.toContain("const fallbackText = hasNonImage ? 'Attachment added.' : 'Image attached.';");
    expect(source).not.toContain('const contextDisplay = contextState.getDisplayPrefix();');
  });
});
