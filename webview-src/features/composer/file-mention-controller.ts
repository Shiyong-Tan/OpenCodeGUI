import type { ComposerContextState, ComposerFileRef } from './context-state';

export type FileMentionRange = { start: number; end: number };

export function normalizeFileRef(file: unknown): ComposerFileRef | null {
  if (!file || typeof (file as { path?: unknown }).path !== 'string' || !(file as { path: string }).path) return null;
  const value = file as { path: string; name?: unknown; directory?: unknown };
  return {
    path: value.path,
    name: typeof value.name === 'string' ? value.name : value.path.split('/').pop(),
    directory: typeof value.directory === 'string' ? value.directory : '',
  };
}

export function findActiveFileMention(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): { query: string; start: number; end: number } | null {
  if (selectionStart !== selectionEnd) return null;
  const beforeCursor = value.slice(0, selectionStart);
  const match = beforeCursor.match(/(^|\s)@([^\s@]*)$/);
  if (!match) return null;
  const query = match[2] || '';
  return { query, start: selectionStart - query.length - 1, end: selectionStart };
}

export function createFileMentionController(options: {
  contextState: ComposerContextState;
  document: Document;
  window: Window;
  input: HTMLTextAreaElement;
  listElement: HTMLElement;
  postMessage(message: unknown): void;
  onContextChanged(): void;
  createRequestId?(): string;
}): {
  close(): void;
  schedule(): void;
  handleKeydown(event: KeyboardEvent): boolean;
  handleResults(requestId: string, files: unknown[]): boolean;
} {
  let open = false;
  let requestId = '';
  let range: FileMentionRange | null = null;
  let items: ComposerFileRef[] = [];
  let selectedIndex = 0;
  let timer: number | null = null;

  const activeMention = () => findActiveFileMention(
    options.input.value,
    options.input.selectionStart,
    options.input.selectionEnd,
  );

  const render = (): void => {
    options.listElement.innerHTML = '';
    if (!open) {
      options.listElement.classList.add('hidden');
      return;
    }
    if (!items.length) {
      const empty = options.document.createElement('div');
      empty.className = 'file-mention-empty';
      empty.textContent = 'No files found';
      options.listElement.appendChild(empty);
      options.listElement.classList.remove('hidden');
      return;
    }
    items.forEach((item, index) => {
      const option = options.document.createElement('button');
      option.type = 'button';
      option.className = `file-mention-item${index === selectedIndex ? ' selected' : ''}`;
      option.dataset.index = String(index);

      const name = options.document.createElement('span');
      name.className = 'file-mention-name';
      name.textContent = item.name || item.path;
      option.appendChild(name);

      const directory = options.document.createElement('span');
      directory.className = 'file-mention-dir';
      directory.textContent = item.directory || '.';
      option.appendChild(directory);
      option.addEventListener('mousedown', (event) => {
        event.preventDefault();
        select(index);
      });
      options.listElement.appendChild(option);
    });
    options.listElement.classList.remove('hidden');
  };

  const close = (): void => {
    open = false;
    items = [];
    selectedIndex = 0;
    range = null;
    options.listElement.classList.add('hidden');
    options.listElement.innerHTML = '';
  };

  const select = (index: number): void => {
    const item = items[index];
    if (!item || !range) return;
    const { start, end } = range;
    options.input.value = `${options.input.value.slice(0, start)}${options.input.value.slice(end)}`;
    options.input.selectionStart = start;
    options.input.selectionEnd = start;
    options.contextState.addFileRef(item);
    options.onContextChanged();
    close();
    options.input.focus();
  };

  const request = (): void => {
    const mention = activeMention();
    if (!mention) {
      close();
      return;
    }
    open = true;
    range = { start: mention.start, end: mention.end };
    selectedIndex = 0;
    requestId = options.createRequestId?.()
      || `files-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    options.postMessage({ type: 'listWorkspaceFiles', requestId, query: mention.query });
  };

  const schedule = (): void => {
    if (timer !== null) options.window.clearTimeout(timer);
    const mention = activeMention();
    if (!mention) {
      close();
      return;
    }
    open = true;
    range = { start: mention.start, end: mention.end };
    render();
    timer = options.window.setTimeout(request, 120);
  };

  const handleKeydown = (event: KeyboardEvent): boolean => {
    if (!open || options.listElement.classList.contains('hidden')) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (items.length > 0) {
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        selectedIndex = (selectedIndex + delta + items.length) % items.length;
        render();
      }
      return true;
    }
    if (event.key === 'Enter' && items.length > 0) {
      event.preventDefault();
      select(selectedIndex);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return true;
    }
    return false;
  };

  const handleResults = (incomingRequestId: string, files: unknown[]): boolean => {
    if (incomingRequestId !== requestId) return false;
    items = files.map(normalizeFileRef).filter((item): item is ComposerFileRef => Boolean(item));
    selectedIndex = 0;
    open = Boolean(range);
    render();
    return true;
  };

  return { close, schedule, handleKeydown, handleResults };
}
