export interface MarkdownMessageCache {
  readonly text?: string;
  _renderSignature?: string;
  _renderHtml?: string;
}

export interface MarkdownRenderOptions {
  readonly linkifyRefs?: boolean;
}

export interface MarkdownControllerDependencies {
  readonly document: Document;
  readonly renderMarkdown: (text: string) => string;
  readonly sanitizeHtml: (html: string, config: {
    readonly ALLOWED_TAGS: readonly string[];
    readonly ALLOWED_ATTR: readonly string[];
  }) => string;
  readonly normalizeMarkdown?: (text: string) => string;
  readonly wrapTables: (root: HTMLElement) => unknown;
  readonly linkifyFileRefs: (root: HTMLElement) => unknown;
  readonly enhanceImageReferences?: (root: HTMLElement) => unknown;
  readonly highlightElement?: (element: Element) => unknown;
  readonly writeClipboardText?: (text: string) => Promise<unknown>;
  readonly startRenderPhase?: () => unknown;
  readonly finishRenderPhase?: (phase: 'richEnhancement', startedAt: unknown) => unknown;
  readonly scheduleTimeout?: typeof setTimeout;
  readonly cancelTimeout?: typeof clearTimeout;
}

export interface MarkdownController {
  renderAssistantMarkdown(content: HTMLElement, message: MarkdownMessageCache | null | undefined, linkifyRefs: boolean): void;
  renderUserMarkdown(content: HTMLElement, text: string): void;
  renderMarkdownInto(element: HTMLElement, text: string, options?: MarkdownRenderOptions): void;
  writeTextToClipboard(text: string): Promise<boolean>;
  enhanceCodeBlocksWithCopyButtons(root: HTMLElement | null | undefined): void;
  resetCachedCodeBlockCopyEnhancements(root: HTMLElement | null | undefined): void;
}

const ALLOWED_TAGS = Object.freeze([
  'a', 'img', 'p', 'br', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li',
  'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'section', 'eq', 'eqn',
  'math', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt', 'mroot',
  'mtable', 'mtr', 'mtd', 'mtext', 'mstyle', 'annotation', 'semantics',
]);

const ALLOWED_ATTR = Object.freeze([
  'href', 'src', 'alt', 'loading', 'title', 'target', 'rel', 'class', 'role', 'aria-hidden', 'style',
  'mathvariant', 'display', 'xmlns', 'encoding',
]);

function normalizeEscapedDollarMath(value: string): string {
  const protectedMarkdown: string[] = [];
  const protectedText = value.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g, (segment) => {
    const index = protectedMarkdown.push(segment) - 1;
    return `\u0000OC_CODE_${index}\u0000`;
  });
  const looksLikeLatex = (inner: string): boolean => /\\[a-zA-Z]+|[_^]|\\[{}]|\|[^|\n]+\|/.test(inner);
  const normalized = protectedText
    .replace(/\\\$\\\$([\s\S]*?)\\\$\\\$/g, (match, inner: string) => (
      looksLikeLatex(inner) ? `$$${inner}$$` : match
    ))
    .replace(/\\\$([^$\n]*?)\\\$/g, (match, inner: string) => (
      looksLikeLatex(inner) ? `$${inner.trim()}$` : match
    ));
  return normalized.replace(/\u0000OC_CODE_(\d+)\u0000/g, (_match, rawIndex: string) => (
    protectedMarkdown[Number(rawIndex)] || ''
  ));
}

function normalizeMultilineDollarMath(value: string): string {
  const protectedMarkdown: string[] = [];
  const protectedText = value.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g, (segment) => {
    const index = protectedMarkdown.push(segment) - 1;
    return `\u0000OC_CODE_${index}\u0000`;
  });
  const normalized = protectedText.replace(
    /^([ \t]*)\$\$[ \t]*\n([\s\S]*?)\n[ \t]*\$\$[ \t]*$/gm,
    (_match, indentation: string, inner: string) => {
      const body = inner
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join(' ');
      return body ? `${indentation}$$${body}$$` : _match;
    },
  );
  return normalized.replace(/\u0000OC_CODE_(\d+)\u0000/g, (_match, rawIndex: string) => (
    protectedMarkdown[Number(rawIndex)] || ''
  ));
}

function isEscapedAt(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function replaceUnescapedMathPipes(value: string): string {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    output += value[index] === '|' && !isEscapedAt(value, index) ? '\\vert{}' : value[index];
  }
  return output;
}

function normalizeDollarMathPipes(value: string): string {
  let output = '';
  let cursor = 0;
  while (cursor < value.length) {
    const opening = value.indexOf('$', cursor);
    if (opening < 0) return output + value.slice(cursor);
    output += value.slice(cursor, opening);
    const next = value[opening + 1] || '';
    if (isEscapedAt(value, opening) || value[opening - 1] === '$' || next === '$' || /\s/.test(next)) {
      output += '$';
      cursor = opening + 1;
      continue;
    }
    let closing = opening + 1;
    while ((closing = value.indexOf('$', closing + 1)) >= 0) {
      const before = value[closing - 1] || '';
      const after = value[closing + 1] || '';
      if (!isEscapedAt(value, closing)
        && value[closing + 1] !== '$'
        && !/\s/.test(before)
        && (!after || /[\s.,;:!?)}\]|]/.test(after))) break;
    }
    if (closing < 0) return output + value.slice(opening);
    const inner = value.slice(opening + 1, closing);
    output += `$${replaceUnescapedMathPipes(inner)}$`;
    cursor = closing + 1;
  }
  return output;
}

function isMarkdownTableDivider(value: string): boolean {
  const trimmed = value.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = trimmed.split('|').map((cell) => cell.trim());
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

// Markdown-it determines table columns before texmath parses inline formulas,
// so raw math bars must stop looking like column separators at this boundary.
function normalizeTableMathPipes(value: string): string {
  const lines = value.split('\n');
  const fenced = new Array<boolean>(lines.length).fill(false);
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const fenceLine = /^\s*(```|~~~)/.test(lines[index]);
    fenced[index] = inFence || fenceLine;
    if (fenceLine) inFence = !inFence;
  }

  const tableRows = new Set<number>();
  for (let index = 1; index < lines.length; index += 1) {
    if (fenced[index] || fenced[index - 1] || !isMarkdownTableDivider(lines[index])) continue;
    if (!lines[index - 1].includes('|')) continue;
    tableRows.add(index - 1);
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (fenced[cursor] || !lines[cursor].trim() || !lines[cursor].includes('|')) break;
      tableRows.add(cursor);
    }
  }

  for (const index of tableRows) {
    const code: string[] = [];
    let line = lines[index].replace(/`+[^`\n]*?`+/g, (segment) => {
      const key = code.push(segment) - 1;
      return `\u0000OC_TABLE_CODE_${key}\u0000`;
    });
    line = line.replace(/\\\((.*?)\\\)/g, (_match, inner: string) => (
      `\\(${replaceUnescapedMathPipes(inner)}\\)`
    ));
    line = normalizeDollarMathPipes(line);
    lines[index] = line.replace(/\u0000OC_TABLE_CODE_(\d+)\u0000/g, (_match, rawIndex: string) => (
      code[Number(rawIndex)] || ''
    ));
  }
  return lines.join('\n');
}

export function normalizeMarkdownText(value: string): string {
  let text = typeof value === 'string' ? value : '';
  text = text
    .replace(/<system-reminder\b[^>]*>/gi, '&lt;system-reminder&gt;')
    .replace(/<\/system-reminder>/gi, '&lt;/system-reminder&gt;')
    .replace(/\r\n/g, '\n');
  text = normalizeEscapedDollarMath(text);
  text = normalizeMultilineDollarMath(text);
  text = normalizeTableMathPipes(text);
  text = text.replace(/\\\[(.*?)\\\]/gs, (_match, inner: string) => `\n\n\\[${inner}\\]\n\n`);
  text = text.replace(/\$([^$\n]*?)\$/g, (match, inner: string) => {
    if (!/\\[a-zA-Z]+|\^|_/.test(inner)) return match;
    return `\\(${inner.trim()}\\)`;
  });

  const lines = text.split('\n');
  let inFence = false;
  const isFence = (line: string): boolean => /^\s*```/.test(line) || /^\s*~~~/.test(line);
  const isOrdered = (line: string): boolean => /^\s*\d+[.)]\s+/.test(line);
  const isHeading = (line: string): boolean => /^\s*#{1,6}\s+/.test(line);
  const isHr = (line: string): boolean => /^\s*(\*\s*){3,}$/.test(line)
    || /^\s*(-\s*){3,}$/.test(line)
    || /^\s*(_\s*){3,}$/.test(line);
  const isBlank = (line: string): boolean => /^\s*$/.test(line);
  const isUnindentedBullet = (line: string): boolean => /^[-+*]\s+/.test(line);

  for (let index = 0; index < lines.length; index += 1) {
    if (isFence(lines[index])) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !isOrdered(lines[index])) continue;
    let cursor = index + 1;
    let touched = false;
    while (cursor < lines.length) {
      const next = lines[cursor];
      if (isFence(next) || isBlank(next) || isHeading(next) || isHr(next) || isOrdered(next)) break;
      if (!isUnindentedBullet(next)) break;
      lines[cursor] = `    ${next}`;
      touched = true;
      cursor += 1;
    }
    if (touched) index = cursor - 1;
  }
  return lines.join('\n');
}

export function createMarkdownController(dependencies: MarkdownControllerDependencies): MarkdownController {
  const scheduleTimeout = dependencies.scheduleTimeout || setTimeout;
  const cancelTimeout = dependencies.cancelTimeout || clearTimeout;
  const copyResetTimers = new WeakMap<HTMLButtonElement, ReturnType<typeof setTimeout>>();

  async function writeTextToClipboard(text: string): Promise<boolean> {
    if (!text) return false;
    let copied = false;
    if (dependencies.writeClipboardText) {
      try {
        await dependencies.writeClipboardText(text);
        copied = true;
      } catch {
        copied = false;
      }
    }
    if (!copied) {
      let textarea: HTMLTextAreaElement | null = null;
      try {
        textarea = dependencies.document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'absolute';
        textarea.style.left = '-9999px';
        dependencies.document.body.appendChild(textarea);
        textarea.select();
        copied = dependencies.document.execCommand('copy');
      } catch {
        copied = false;
      } finally {
        textarea?.parentNode?.removeChild(textarea);
      }
    }
    return copied;
  }

  function enhanceCodeBlocksWithCopyButtons(root: HTMLElement | null | undefined): void {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    if (root.closest && root.closest('.conflict-card')) return;
    const richEnhancementStartedAt = dependencies.startRenderPhase?.();

    for (const pre of Array.from(root.querySelectorAll<HTMLElement>('pre'))) {
      if (pre.closest && pre.closest('.conflict-card')) continue;
      if (pre.dataset.hasCopyBtn === '1') continue;
      const code = pre.querySelector<HTMLElement>('code');
      if (!code) continue;
      pre.dataset.hasCopyBtn = '1';

      let wrapper = pre.parentElement;
      if (!wrapper || !wrapper.classList.contains('code-block-wrap')) {
        wrapper = dependencies.document.createElement('div');
        wrapper.className = 'code-block-wrap';
        pre.parentElement?.insertBefore(wrapper, pre);
        wrapper.appendChild(pre);
      }

      const button = dependencies.document.createElement('button');
      button.type = 'button';
      button.className = 'code-copy-btn';
      button.textContent = 'Copy';
      button.addEventListener('click', async (event) => {
        event.stopPropagation();
        const text = code.innerText || '';
        if (!text) return;
        const copied = await writeTextToClipboard(text);
        const priorTimer = copyResetTimers.get(button);
        if (priorTimer !== undefined) cancelTimeout(priorTimer);
        button.textContent = copied ? 'Copied!' : 'Failed';
        const timer = scheduleTimeout(() => {
          copyResetTimers.delete(button);
          button.textContent = 'Copy';
        }, copied ? 800 : 1200);
        copyResetTimers.set(button, timer);
      });
      wrapper.appendChild(button);
    }
    dependencies.finishRenderPhase?.('richEnhancement', richEnhancementStartedAt);
  }

  function resetCachedCodeBlockCopyEnhancements(root: HTMLElement | null | undefined): void {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('.code-copy-btn'))) {
      const timer = copyResetTimers.get(button);
      if (timer !== undefined) cancelTimeout(timer);
      copyResetTimers.delete(button);
      button.remove();
    }
    for (const pre of Array.from(root.querySelectorAll<HTMLElement>('pre[data-has-copy-btn="1"]'))) {
      delete pre.dataset.hasCopyBtn;
    }
  }

  function renderMarkdownInto(element: HTMLElement, text: string, options: MarkdownRenderOptions = {}): void {
    const richEnhancementStartedAt = dependencies.startRenderPhase?.();
    delete element.dataset.linkified;
    const normalizeMarkdown = dependencies.normalizeMarkdown || normalizeMarkdownText;
    const raw = dependencies.renderMarkdown(normalizeMarkdown(text || ''));
    element.innerHTML = dependencies.sanitizeHtml(raw, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
    });
    for (const link of Array.from(element.querySelectorAll<HTMLAnchorElement>('a'))) {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    }
    if (dependencies.highlightElement) {
      for (const block of Array.from(element.querySelectorAll('pre code'))) {
        dependencies.highlightElement(block);
      }
    }
    dependencies.wrapTables(element);
    enhanceCodeBlocksWithCopyButtons(element);
    if (options.linkifyRefs === true && element.dataset.linkified !== '1') {
      dependencies.linkifyFileRefs(element);
      element.dataset.linkified = '1';
    }
    dependencies.finishRenderPhase?.('richEnhancement', richEnhancementStartedAt);
  }

  function renderAssistantMarkdown(
    content: HTMLElement,
    message: MarkdownMessageCache | null | undefined,
    linkifyRefs: boolean,
  ): void {
    const text = typeof message?.text === 'string' ? message.text : '';
    const signature = `${linkifyRefs ? '1' : '0'}:${text}`;
    if (message && message._renderSignature === signature && typeof message._renderHtml === 'string') {
      content.innerHTML = message._renderHtml;
      resetCachedCodeBlockCopyEnhancements(content);
      enhanceCodeBlocksWithCopyButtons(content);
      if (linkifyRefs) dependencies.enhanceImageReferences?.(content);
      return;
    }
    renderMarkdownInto(content, text, { linkifyRefs });
    if (message && typeof message === 'object') {
      message._renderSignature = signature;
      message._renderHtml = content.innerHTML;
    }
    if (linkifyRefs) dependencies.enhanceImageReferences?.(content);
  }

  function renderUserMarkdown(content: HTMLElement, text: string): void {
    renderMarkdownInto(content, text || '', { linkifyRefs: false });
  }

  return Object.freeze({
    renderAssistantMarkdown,
    renderUserMarkdown,
    renderMarkdownInto,
    writeTextToClipboard,
    enhanceCodeBlocksWithCopyButtons,
    resetCachedCodeBlockCopyEnhancements,
  });
}
