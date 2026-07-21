import { getClipboardImageItems } from '../features/composer/clipboard-controller';

describe('clipboard attachment controller', () => {
  it('selects only image clipboard items without consuming text items', () => {
    const image = { type: 'image/png' } as DataTransferItem;
    const text = { type: 'text/plain' } as DataTransferItem;
    const empty = { type: '' } as DataTransferItem;
    expect(getClipboardImageItems([text, image, empty])).toEqual([image]);
    expect(getClipboardImageItems(null)).toEqual([]);
  });
});
