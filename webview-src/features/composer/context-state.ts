export type ComposerContextItem = {
  displayText?: string;
  text?: string;
  source?: string;
  filePath?: string;
  workspacePath?: string;
  range?: unknown;
  contextKey?: string;
  automatic?: boolean;
  [key: string]: unknown;
};

export type ComposerFileRef = {
  path: string;
  name?: string;
  directory?: string;
};

export type ComposerContextState = {
  getContextItems(): readonly ComposerContextItem[];
  getClearRevision(): number;
  getFileRefs(): readonly ComposerFileRef[];
  addContext(displayText: string, payload: ComposerContextItem): boolean;
  setAutomaticContext(payload: ComposerContextItem | null): boolean;
  removeContext(item: ComposerContextItem): boolean;
  addFileRef(file: ComposerFileRef): boolean;
  removeFileRef(path: string): boolean;
  clear(): void;
  hasContext(): boolean;
  hasNonAutomaticContext(): boolean;
  hasFileRefs(): boolean;
  getDisplayPrefix(): string;
  getContextPayload(): ComposerContextItem[];
  getFilesPayload(): string[];
};

export function createComposerContextState(): ComposerContextState {
  let contextItems: ComposerContextItem[] = [];
  let fileRefs: ComposerFileRef[] = [];
  let clearRevision = 0;

  return {
    getContextItems: () => contextItems,
    getClearRevision: () => clearRevision,
    getFileRefs: () => fileRefs,
    addContext: (displayText, payload) => {
      if (!displayText || !payload || typeof payload.text !== 'string') return false;
      contextItems.push({ displayText, ...payload });
      return true;
    },
    setAutomaticContext: (payload) => {
      const previous = contextItems.find((item) => item.automatic === true);
      if (previous?.contextKey && previous.contextKey === payload?.contextKey) return false;
      const withoutAutomatic = contextItems.filter((item) => item.automatic !== true);
      if (payload && typeof payload.text === 'string' && payload.displayText) {
        contextItems = [...withoutAutomatic, { ...payload, automatic: true }];
        if (payload.filePath) {
          fileRefs = fileRefs.filter((file) => file.path !== payload.workspacePath);
        }
      } else {
        contextItems = withoutAutomatic;
      }
      return previous !== undefined || Boolean(payload);
    },
    removeContext: (item) => {
      const next = contextItems.filter((entry) => entry !== item);
      if (next.length === contextItems.length) return false;
      contextItems = next;
      return true;
    },
    addFileRef: (file) => {
      if (!file?.path
        || fileRefs.some((item) => item.path === file.path)
        || contextItems.some((item) => item.workspacePath === file.path)) return false;
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
      clearRevision += 1;
    },
    hasContext: () => contextItems.length > 0,
    hasNonAutomaticContext: () => contextItems.some((item) => item.automatic !== true),
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
      workspacePath: item.workspacePath,
      range: item.range,
      contextKey: item.contextKey,
      automatic: item.automatic,
    })),
    getFilesPayload: () => fileRefs
      .map((item) => item?.path)
      .filter((value): value is string => typeof value === 'string'
        && value.length > 0
        && !contextItems.some((item) => item.workspacePath === value)),
  };
}
