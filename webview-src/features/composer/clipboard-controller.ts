export function getClipboardImageItems(items: ArrayLike<DataTransferItem> | null | undefined): DataTransferItem[] {
  if (!items) return [];
  return Array.from(items).filter((item) => Boolean(item?.type && item.type.startsWith('image/')));
}

export function createClipboardAttachmentController(options: {
  createFileReader(): FileReader;
  postMessage(message: unknown): void;
}): { handlePaste(event: ClipboardEvent): void } {
  return {
    handlePaste: (event) => {
      for (const item of getClipboardImageItems(event.clipboardData?.items)) {
        const file = item.getAsFile();
        if (!file) continue;
        const reader = options.createFileReader();
        reader.onload = () => {
          options.postMessage({
            type: 'clipboardImage',
            dataUrl: reader.result,
            mime: file.type,
          });
        };
        reader.readAsDataURL(file);
      }
    },
  };
}
