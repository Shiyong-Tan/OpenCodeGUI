import type { AttachmentPayload, AttachmentState } from './attachment-state';
import type { ComposerContextItem, ComposerContextState } from './context-state';

export type ComposerSubmission = {
  messageText: string;
  messageImages: string[];
  attachmentsPayload: AttachmentPayload[];
  contextPayload: ComposerContextItem[];
  filesPayload: string[];
};

export function buildComposerSubmission(options: {
  text: string;
  attachments: AttachmentState;
  context: ComposerContextState;
}): ComposerSubmission | null {
  const text = options.text.trim();
  if (!text && !options.attachments.hasItems() && !options.context.hasContext() && !options.context.hasFileRefs()) {
    return null;
  }
  const fallbackText = options.attachments.hasNonImage() ? 'Attachment added.' : 'Image attached.';
  const contextDisplay = options.context.getDisplayPrefix();
  const baseText = contextDisplay ? (text ? `${contextDisplay}\n${text}` : contextDisplay) : text;
  return {
    messageText: baseText || fallbackText,
    messageImages: options.attachments.getMessageImages(),
    attachmentsPayload: options.attachments.getPayload(),
    contextPayload: options.context.getContextPayload(),
    filesPayload: options.context.getFilesPayload(),
  };
}
