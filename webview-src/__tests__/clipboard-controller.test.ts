import { createClipboardAttachmentController, getClipboardImageItems } from '../features/composer/clipboard-controller';

describe('clipboard attachment controller', () => {
  it('selects only image clipboard items without consuming text items', () => {
    const image = { type: 'image/png' } as DataTransferItem;
    const text = { type: 'text/plain' } as DataTransferItem;
    const empty = { type: '' } as DataTransferItem;
    expect(getClipboardImageItems([text, image, empty])).toEqual([image]);
    expect(getClipboardImageItems(null)).toEqual([]);
  });

  it('captures the session before the asynchronous FileReader callback', () => {
    const reader = {
      result: 'data:image/png;base64,a',
      onload: null as ((event: ProgressEvent<FileReader>) => void) | null,
      readAsDataURL: jest.fn(),
    } as unknown as FileReader;
    let visibleSession = 'A';
    const postMessage = jest.fn();
    const controller = createClipboardAttachmentController({
      createFileReader: () => reader,
      getSessionId: () => visibleSession,
      postMessage,
    });
    const file = { type: 'image/png' } as File;
    const item = { type: 'image/png', getAsFile: () => file } as DataTransferItem;

    controller.handlePaste({ clipboardData: { items: [item] } } as unknown as ClipboardEvent);
    visibleSession = 'B';
    const capturedOnload = reader.onload;
    expect(capturedOnload).toBeInstanceOf(Function);
    capturedOnload?.call(reader, {} as ProgressEvent<FileReader>);

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'clipboardImage',
      sessionId: 'A',
    }));
  });
});
