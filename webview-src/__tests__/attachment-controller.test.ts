import { deriveAttachmentPresentation } from '../features/composer/attachment-controller';

describe('attachment presentation', () => {
  it('preserves image thumbnail detection and numbering', () => {
    const result = deriveAttachmentPresentation([
      { id: 'a', name: 'img-pasted', dataUrl: 'data:image/png;base64,A' },
      { id: 'b', name: 'photo.bin', mime: 'image/jpeg' },
      { id: 'c', name: 'photo.png', mime: 'application/octet-stream' },
    ]);
    expect(result.map(({ isImage, label }) => ({ isImage, label }))).toEqual([
      { isImage: true, label: 'image1' },
      { isImage: true, label: 'image2' },
      { isImage: false, label: 'photo.png' },
    ]);
  });

  it('keeps the existing fallback file label', () => {
    expect(deriveAttachmentPresentation([{ filePath: 'C:/tmp/restored.txt' }])[0]).toMatchObject({
      isImage: false,
      label: 'Attachment',
    });
  });
});
