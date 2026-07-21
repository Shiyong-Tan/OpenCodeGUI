export interface PresentableMessage {
  readonly id: string;
  readonly role: string;
  readonly text?: string;
  readonly meta?: {
    readonly isThinking?: boolean;
    readonly isDiff?: boolean;
    readonly diffText?: string;
    readonly textSegments?: readonly unknown[];
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
}

export interface AppendPresentationItem {
  readonly text?: string;
  readonly status?: string;
  readonly [key: string]: unknown;
}

export type MessageContentPlan =
  | { readonly kind: 'diff'; readonly text: string }
  | { readonly kind: 'assistant'; readonly message: PresentableMessage }
  | { readonly kind: 'user'; readonly text: string; readonly appendItems: readonly AppendPresentationItem[] }
  | { readonly kind: 'plain'; readonly text: string }
  | { readonly kind: 'skip' };

export interface MessagePresentationDependencies {
  readonly stripSystemInjections: (text: string) => string;
  readonly stripAttachmentManifest: (text: string) => string;
  readonly getAppendItems: (message: PresentableMessage) => readonly AppendPresentationItem[];
}

export interface MessagePresentationController {
  getBubbleClass(message: PresentableMessage, nested?: boolean): string;
  resolveContent(message: PresentableMessage, nested?: boolean): MessageContentPlan;
  getAppendStatus(status: string | undefined): { readonly className: string; readonly text: string } | null;
}

export function createMessagePresentationController(
  dependencies: MessagePresentationDependencies,
): MessagePresentationController {
  function getBubbleClass(message: PresentableMessage, nested = false): string {
    const roleClass = message.role === 'user'
      ? 'user'
      : message.role === 'system' || message.role === 'tool'
        ? 'system'
        : 'bot';
    return `message ${roleClass}${nested ? ' nested-message' : ''}`;
  }

  function resolveContent(message: PresentableMessage, nested = false): MessageContentPlan {
    const raw = typeof message.text === 'string' ? message.text : '';
    if (message.meta?.isDiff === true) {
      return { kind: 'diff', text: message.meta.diffText || raw };
    }
    if (message.role === 'assistant') {
      if (!nested && message.meta?.isThinking !== true && Array.isArray(message.meta?.textSegments)
        && message.meta.textSegments.length > 0) {
        const finalSegment = message.meta.textSegments[message.meta.textSegments.length - 1];
        const finalText = typeof finalSegment === 'string' ? finalSegment.trim() : '';
        if (finalText) return { kind: 'assistant', message: { ...message, text: finalText } };
      }
      return { kind: 'assistant', message };
    }
    if (message.role !== 'user') return { kind: 'plain', text: raw };

    const visibleText = nested
      ? dependencies.stripSystemInjections(raw.replace(/^(\r?\n)+/, ''))
      : dependencies.stripSystemInjections(dependencies.stripAttachmentManifest(raw));
    if (!nested && !visibleText.trim()) return { kind: 'skip' };
    return {
      kind: 'user',
      text: visibleText,
      appendItems: nested ? [] : dependencies.getAppendItems(message),
    };
  }

  function getAppendStatus(status: string | undefined): { readonly className: string; readonly text: string } | null {
    if (!status || status === 'applied') return null;
    const text = status === 'failed'
      ? 'Append failed'
      : status === 'rejected'
        ? 'Append unavailable'
        : status === 'seen'
          ? 'Received'
          : status === 'queued'
            ? 'Queued'
            : 'Sending...';
    return { className: `append-message-status append-${status}`, text };
  }

  return Object.freeze({ getBubbleClass, resolveContent, getAppendStatus });
}
