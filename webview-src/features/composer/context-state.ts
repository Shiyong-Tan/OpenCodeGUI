export type ComposerContextItem = {
  displayText?: string;
  text?: string;
  source?: string;
  filePath?: string;
  range?: unknown;
  [key: string]: unknown;
};

export type ComposerFileRef = {
  path: string;
  name?: string;
  directory?: string;
};

export type ComposerContextState = {
  getContextItems(): readonly ComposerContextItem[];
  getFileRefs(): readonly ComposerFileRef[];
  addContext(displayText: string, payload: ComposerContextItem): boolean;
  removeContext(item: ComposerContextItem): boolean;
  addFileRef(file: ComposerFileRef): boolean;
  removeFileRef(path: string): boolean;
  clear(): void;
  hasContext(): boolean;
  hasFileRefs(): boolean;
  getDisplayPrefix(): string;
  getContextPayload(): ComposerContextItem[];
  getFilesPayload(): string[];
};

export function createComposerContextState(): ComposerContextState {
  let contextItems: ComposerContextItem[] = [];
  let fileRefs: ComposerFileRef[] = [];

  return {
    getContextItems: () => contextItems,
    getFileRefs: () => fileRefs,
    addContext: (displayText, payload) => {
      if (!displayText || !payload || typeof payload.text !== 'string') return false;
      contextItems.push({ displayText, ...payload });
      return true;
    },
    removeContext: (item) => {
      const next = contextItems.filter((entry) => entry !== item);
      if (next.length === contextItems.length) return false;
      contextItems = next;
      return true;
    },
    addFileRef: (file) => {
      if (!file?.path || fileRefs.some((item) => item.path === file.path)) return false;
      fileRefs.push(file);
      return true;
    },
    removeFileRef: (path) => {
      const next = fileRefs.filter((entry) => entry.path !== path);
      if (next.length === fileRefs.length) return false;
      fileRefs = next;
      return true;
    },
    clear: () => {
      contextItems = [];
      fileRefs = [];
    },
    hasContext: () => contextItems.length > 0,
    hasFileRefs: () => fileRefs.length > 0,
    getDisplayPrefix: () => [
      ...contextItems.map((item) => item.displayText).filter(Boolean),
      ...fileRefs.map((item) => item?.path ? `@${item.path}` : '').filter(Boolean),
    ].join(' '),
    getContextPayload: () => contextItems.map((item) => ({
      displayText: item.displayText,
      text: item.text,
      source: item.source,
      filePath: item.filePath,
      range: item.range,
    })),
    getFilesPayload: () => fileRefs
      .map((item) => item?.path)
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  };
}
