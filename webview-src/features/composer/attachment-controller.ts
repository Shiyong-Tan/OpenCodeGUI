import type { AttachmentState, ComposerAttachment } from './attachment-state';

export type AttachmentPresentation = {
  item: ComposerAttachment;
  isImage: boolean;
  label: string;
};

export type AttachmentUiController = {
  render(): void;
};

function isRenderedAsImage(item: ComposerAttachment): boolean {
  const name = typeof item?.name === 'string' ? item.name : '';
  const mime = typeof item?.mime === 'string' ? item.mime : '';
  return mime.startsWith('image/') || name.startsWith('img-');
}

export function deriveAttachmentPresentation(items: readonly ComposerAttachment[]): AttachmentPresentation[] {
  const totalImages = items.filter(isRenderedAsImage).length;
  let imageIndex = 0;
  return items.map((item) => {
    const isImage = isRenderedAsImage(item);
    if (isImage) imageIndex += 1;
    return {
      item,
      isImage,
      label: isImage
        ? (totalImages > 1 ? `image${imageIndex}` : 'image')
        : (typeof item?.name === 'string' && item.name ? item.name : 'Attachment'),
    };
  });
}

export function createAttachmentUiController(options: {
  state: AttachmentState;
  document: Document;
  listElement: HTMLElement;
}): AttachmentUiController {
  const { state, document, listElement } = options;

  const render = (): void => {
    listElement.innerHTML = '';
    for (const presentation of deriveAttachmentPresentation(state.getItems())) {
      const { item, isImage, label } = presentation;
      const entry = document.createElement('div');
      entry.className = isImage
        ? 'attachment-image-item'
        : 'attachment-image-item attachment-file-item';

      if (isImage) {
        const thumb = document.createElement('img');
        thumb.className = 'attachment-image-thumb';
        thumb.alt = label;
        if (typeof item?.dataUrl === 'string' && item.dataUrl) {
          thumb.src = item.dataUrl;
        }
        entry.appendChild(thumb);
      } else {
        const icon = document.createElement('span');
        icon.className = 'attachment-file-icon';
        icon.textContent = '\u{1F4C4}';
        entry.appendChild(icon);
      }

      const text = document.createElement('span');
      text.className = 'attachment-image-label';
      text.textContent = label;

      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'attachment-image-remove';
      removeButton.textContent = '\u00D7';
      removeButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (state.removeById(item.id)) render();
      });

      entry.appendChild(text);
      entry.appendChild(removeButton);
      listElement.appendChild(entry);
    }
  };

  return { render };
}
