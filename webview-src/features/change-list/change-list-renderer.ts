type ChangeStats = { additions?: number; deletions?: number };
type ChangeListRow = Readonly<{
  normalizedPath: string;
  base: string;
  directory: string;
  markdown: boolean;
  additions?: number;
  deletions?: number;
  showStats: boolean;
}>;

export type ChangeListPresentation = Readonly<{
  messageId: string;
  fileCount: number;
  reverted: boolean;
  commitHead?: string;
  commitBase?: string;
  deltaColumnWidth: string;
  rows: ReadonlyArray<ChangeListRow>;
}>;

export function deriveChangeListPresentation(message: any): ChangeListPresentation | null {
  if (message?.meta?.kind !== 'changeList') return null;
  const files = Array.isArray(message.meta.files) ? message.meta.files : [];
  if (!files.length) return null;
  const statsByPath = message.meta.statsByPath && typeof message.meta.statsByPath === 'object'
    ? message.meta.statsByPath as Record<string, ChangeStats>
    : {};
  let maxStatDigits = 1;
  for (const rawPath of files) {
    if (typeof rawPath !== 'string' || !rawPath.length) continue;
    const stats = statsByPath[rawPath.replace(/\\/g, '/')];
    if (!stats) continue;
    for (const value of [stats.additions, stats.deletions]) {
      if (!Number.isFinite(value)) continue;
      maxStatDigits = Math.max(maxStatDigits, String(Math.abs(value as number)).length);
    }
  }
  const rows: ChangeListRow[] = files.flatMap((rawPath: unknown) => {
    if (typeof rawPath !== 'string' || !rawPath.length) return [];
    const normalizedPath = rawPath.replace(/\\/g, '/');
    const parts = normalizedPath.split('/');
    const base = parts.pop() || normalizedPath;
    const directory = parts.length ? `${parts.join('/')}/` : '';
    const stats = statsByPath[normalizedPath];
    return [{
      normalizedPath,
      base,
      directory,
      markdown: /\.md$/i.test(normalizedPath),
      additions: stats?.additions,
      deletions: stats?.deletions,
      showStats: Boolean(stats && (Number.isFinite(stats.additions) || Number.isFinite(stats.deletions))),
    }];
  });
  return Object.freeze({
    messageId: message.id,
    fileCount: files.length,
    reverted: message.meta.reverted === true,
    commitHead: typeof message.meta.commitHead === 'string' ? message.meta.commitHead : undefined,
    commitBase: typeof message.meta.commitBase === 'string' ? message.meta.commitBase : undefined,
    deltaColumnWidth: `${maxStatDigits + 1}ch`,
    rows: Object.freeze(rows.map((row) => Object.freeze(row))),
  });
}

export function createChangeListRenderer(options: {
  document: Document;
  getSessionId(): string | null;
  openFile(path: string, sessionId: string | null): void;
  openDiff(path: string, sessionId: string | null, commitHead?: string, commitBase?: string): void;
}) {
  const render = (message: any): HTMLElement | null => {
    const presentation = deriveChangeListPresentation(message);
    if (!presentation) return null;
    const container = options.document.createElement('div');
    container.className = 'conflict-card change-list-card';
    container.style.textAlign = 'left';
    container.dataset.messageId = presentation.messageId;

    const header = options.document.createElement('div');
    header.className = 'conflict-card-header';
    header.textContent = `Changed files (${presentation.fileCount})`;
    container.appendChild(header);
    if (presentation.reverted) {
      const revertedNotice = options.document.createElement('div');
      revertedNotice.className = 'change-list-reverted';
      revertedNotice.textContent = 'Changes reverted by Undo.';
      container.appendChild(revertedNotice);
    }

    const list = options.document.createElement('div');
    list.className = 'conflict-card-list';
    list.style.setProperty('--delta-col-width', presentation.deltaColumnWidth);
    for (const row of presentation.rows) {
      const details = options.document.createElement('details');
      details.className = 'conflict-card-item';
      const summary = options.document.createElement('summary');
      summary.style.textAlign = 'left';
      summary.addEventListener('click', () => {
        const sessionId = options.getSessionId();
        if (row.markdown) options.openFile(row.normalizedPath, sessionId);
        else options.openDiff(row.normalizedPath, sessionId, presentation.commitHead, presentation.commitBase);
      });
      const nameWrap = options.document.createElement('span');
      nameWrap.className = 'conflict-card-name';
      const baseSpan = options.document.createElement('span');
      baseSpan.className = 'conflict-card-file';
      baseSpan.textContent = row.base;
      nameWrap.appendChild(baseSpan);
      if (row.directory) {
        const separator = options.document.createElement('span');
        separator.className = 'conflict-card-path-sep';
        separator.textContent = '|';
        nameWrap.appendChild(separator);
        const directory = options.document.createElement('span');
        directory.className = 'conflict-card-path';
        directory.textContent = row.directory;
        nameWrap.appendChild(directory);
      }
      summary.appendChild(nameWrap);
      if (row.showStats) {
        const stats = options.document.createElement('span');
        stats.className = 'change-list-stats';
        const delta = options.document.createElement('span');
        delta.className = 'change-delta';
        const additions = options.document.createElement('span');
        additions.className = 'delta plus';
        additions.textContent = Number.isFinite(row.additions) ? `+${row.additions}` : '';
        const separator = options.document.createElement('span');
        separator.className = 'sep';
        separator.textContent = '|';
        const deletions = options.document.createElement('span');
        deletions.className = 'delta minus';
        deletions.textContent = Number.isFinite(row.deletions) ? `-${row.deletions}` : '';
        delta.append(additions, separator, deletions);
        stats.appendChild(delta);
        summary.appendChild(stats);
      }
      details.appendChild(summary);
      list.appendChild(details);
    }
    container.appendChild(list);
    return container;
  };
  return { render };
}
