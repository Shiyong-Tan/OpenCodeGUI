import { createAttachmentState, isImageAttachment } from '../features/composer/attachment-state';

describe('composer attachment state', () => {
  it('preserves the existing image classification rules', () => {
    expect(isImageAttachment({ mime: 'image/png', name: 'file.bin' })).toBe(true);
    expect(isImageAttachment({ name: 'SCREENSHOT.HEIC' })).toBe(true);
    expect(isImageAttachment({ name: 'notes.txt', mime: 'text/plain' })).toBe(false);
    expect(isImageAttachment({ filePath: 'C:/tmp/image.png' })).toBe(false);
  });

  it('owns add, remove, clear, and draft restoration', () => {
    const state = createAttachmentState([{ id: 'a', name: 'a.txt' }]);
    state.add({ id: 'b', name: 'b.png' });
    expect(state.hasItems()).toBe(true);
    expect(state.hasNonImage()).toBe(true);
    expect(state.removeById('a')).toBe(true);
    expect(state.removeById('missing')).toBe(false);
    expect(state.hasNonImage()).toBe(false);

    state.restoreFilePaths(['C:/tmp/restored.txt']);
    expect(state.getItems()).toEqual([{ filePath: 'C:/tmp/restored.txt' }]);
    state.clear();
    expect(state.getItems()).toEqual([]);
  });

  it('builds the same message image and extension payload shapes', () => {
    const state = createAttachmentState([
      {
        id: 'image',
        name: 'shot.png',
        mime: 'image/png',
        dataUrl: 'data:image/png;base64,QUJD',
      },
      {
        id: 'file',
        name: 'notes.txt',
        mime: 'text/plain',
        filePath: 'C:/tmp/notes.txt',
      },
    ]);

    expect(state.getMessageImages()).toEqual(['data:image/png;base64,QUJD']);
    expect(state.getPayload()).toEqual([
      { filename: 'shot.png', mime: 'image/png', dataBase64: 'QUJD', tempPath: undefined },
      { filename: 'notes.txt', mime: 'text/plain', dataBase64: undefined, tempPath: 'C:/tmp/notes.txt' },
    ]);
  });
});
