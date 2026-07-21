import { createMessagePresentationController } from '../rendering/message-presentation';

const controller = createMessagePresentationController({
  stripSystemInjections: (text) => text.replace(/<system>.*?<\/system>/g, ''),
  stripAttachmentManifest: (text) => text.replace(/<attachments>.*?<\/attachments>/g, ''),
  getAppendItems: (message) => Array.isArray(message.meta?.appendedPrompts)
    ? message.meta.appendedPrompts as Array<{ text?: string; status?: string }>
    : [],
});

describe('message presentation controller', () => {
  it('selects only the final completed assistant segment without mutating the source', () => {
    const message = {
      id: 'assistant-1', role: 'assistant', text: 'accumulated',
      meta: { isThinking: false, textSegments: ['draft', '  final answer  '] },
    };

    expect(controller.resolveContent(message)).toEqual({
      kind: 'assistant',
      message: { ...message, text: 'final answer' },
    });
    expect(message.text).toBe('accumulated');
  });

  it('keeps accumulated assistant text while streaming and in nested segments', () => {
    const streaming = { id: 'assistant-2', role: 'assistant', text: 'stream', meta: { isThinking: true, textSegments: ['final'] } };
    const nested = { ...streaming, id: 'assistant-3', meta: { isThinking: false, textSegments: ['final'] } };

    expect(controller.resolveContent(streaming)).toEqual({ kind: 'assistant', message: streaming });
    expect(controller.resolveContent(nested, true)).toEqual({ kind: 'assistant', message: nested });
  });

  it('removes user-only injected metadata and preserves append items', () => {
    const message = {
      id: 'user-1', role: 'user', text: 'hello<system>hidden</system><attachments>files</attachments>',
      meta: { appendedPrompts: [{ text: 'later', status: 'queued' }] },
    };

    expect(controller.resolveContent(message)).toEqual({
      kind: 'user', text: 'hello', appendItems: [{ text: 'later', status: 'queued' }],
    });
  });

  it('skips an empty primary user bubble but retains nested user ownership', () => {
    const message = { id: 'user-2', role: 'user', text: '\n<system>hidden</system>', meta: {} };
    expect(controller.resolveContent(message)).toEqual({ kind: 'skip' });
    expect(controller.resolveContent(message, true)).toEqual({ kind: 'user', text: '', appendItems: [] });
  });

  it('normalizes bubble classes, diffs, plain text, and append statuses', () => {
    expect(controller.getBubbleClass({ id: 'u', role: 'user' })).toBe('message user');
    expect(controller.getBubbleClass({ id: 't', role: 'tool' }, true)).toBe('message system nested-message');
    expect(controller.getBubbleClass({ id: 'a', role: 'assistant' })).toBe('message bot');
    expect(controller.resolveContent({ id: 'd', role: 'system', text: 'fallback', meta: { isDiff: true, diffText: 'patch' } }))
      .toEqual({ kind: 'diff', text: 'patch' });
    expect(controller.resolveContent({ id: 's', role: 'system', text: 'notice' }))
      .toEqual({ kind: 'plain', text: 'notice' });
    expect(controller.getAppendStatus('applied')).toBeNull();
    expect(controller.getAppendStatus('failed')).toEqual({ className: 'append-message-status append-failed', text: 'Append failed' });
    expect(controller.getAppendStatus('queued')).toEqual({ className: 'append-message-status append-queued', text: 'Queued' });
    expect(controller.getAppendStatus('sending')).toEqual({ className: 'append-message-status append-sending', text: 'Sending...' });
  });
});
