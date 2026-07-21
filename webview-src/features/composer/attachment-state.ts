export type ComposerAttachment = {
  id?: string;
  name?: string;
  filePath?: string;
  dataUrl?: string;
  mime?: string;
};

export type AttachmentPayload = {
  filename?: string;
  mime?: string;
  dataBase64?: string;
  tempPath?: string;
};

export type AttachmentState = {
  getItems(): readonly ComposerAttachment[];
  replace(items: readonly ComposerAttachment[]): void;
  restoreFilePaths(filePaths: readonly string[]): void;
  add(item: ComposerAttachment): void;
  removeById(id: string | undefined): boolean;
  clear(): void;
  hasItems(): boolean;
  hasNonImage(): boolean;
  getMessageImages(): string[];
  getPayload(): AttachmentPayload[];
};

export function isImageAttachment(item: ComposerAttachment | null | undefined): boolean {
  const mime = typeof item?.mime === 'string' ? item.mime : '';
  if (mime.startsWith('image/')) return true;
  const name = typeof item?.name === 'string' ? item.name : '';
  return /\.(png|jpe?g|gif|webp|bmp|svg|tiff?|ico|heic)$/.test(name.toLowerCase());
}

function toPayload(item: ComposerAttachment): AttachmentPayload {
  const dataUrl = typeof item?.dataUrl === 'string' ? item.dataUrl : '';
  const commaIndex = dataUrl.indexOf(',');
  const dataBase64 = dataUrl.startsWith('data:') && commaIndex !== -1
    ? dataUrl.slice(commaIndex + 1)
    : undefined;
  return {
    filename: typeof item?.name === 'string' ? item.name : undefined,
    mime: typeof item?.mime === 'string' ? item.mime : undefined,
    dataBase64,
    tempPath: typeof item?.filePath === 'string' ? item.filePath : undefined,
  };
}

export function createAttachmentState(initialItems: readonly ComposerAttachment[] = []): AttachmentState {
  let items = Array.from(initialItems);

  return {
    getItems: () => items,
    replace: (nextItems) => {
      items = Array.from(nextItems);
    },
    restoreFilePaths: (filePaths) => {
      items = filePaths.map((filePath) => ({ filePath }));
    },
    add: (item) => {
      items.push(item);
    },
    removeById: (id) => {
      const index = items.findIndex((item) => item.id === id);
      if (index < 0) return false;
      items.splice(index, 1);
      return true;
    },
    clear: () => {
      items = [];
    },
    hasItems: () => items.length > 0,
    hasNonImage: () => items.some((item) => !isImageAttachment(item)),
    getMessageImages: () => items
      .map((item) => item.dataUrl)
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
    getPayload: () => items.map(toPayload),
  };
}
