import { createMarkdownController } from '../rendering/markdown-controller';

type Listener = (event: { stopPropagation(): void }) => unknown;

class FakeElement {
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Listener>();
  parentElement: FakeElement | null = null;
  parentNode: FakeElement | null = null;
  className = '';
  textContent = '';
  innerText = '';
  innerHTML = '';
  type = '';
  value = '';

  constructor(readonly tagName: string) {}

  get classList() {
    return { contains: (name: string) => this.className.split(/\s+/).includes(name) };
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentElement?.removeChild(child);
    this.children.push(child);
    child.parentElement = this;
    child.parentNode = this;
    return child;
  }

  insertBefore(child: FakeElement, before: FakeElement): FakeElement {
    child.parentElement?.removeChild(child);
    const index = this.children.indexOf(before);
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
    child.parentElement = this;
    child.parentNode = this;
    return child;
  }

  removeChild(child: FakeElement): FakeElement {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentElement = null;
    child.parentNode = null;
    return child;
  }

  remove(): void {
    this.parentElement?.removeChild(this);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  select(): void {}

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, listener);
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const descendants: FakeElement[] = [];
    const visit = (element: FakeElement) => {
      for (const child of element.children) {
        descendants.push(child);
        visit(child);
      }
    };
    visit(this);
    if (selector === 'pre code') {
      return descendants.filter((item) => item.tagName === 'code' && item.parentElement?.tagName === 'pre');
    }
    if (selector === 'pre[data-has-copy-btn="1"]') {
      return descendants.filter((item) => item.tagName === 'pre' && item.dataset.hasCopyBtn === '1');
    }
    if (selector.startsWith('.')) {
      const className = selector.slice(1);
      return descendants.filter((item) => item.classList.contains(className));
    }
    return descendants.filter((item) => item.tagName === selector);
  }

  closest(selector: string): FakeElement | null {
    const className = selector.startsWith('.') ? selector.slice(1) : '';
    let current: FakeElement | null = this;
    while (current) {
      if (className && current.classList.contains(className)) return current;
      current = current.parentElement;
    }
    return null;
  }
}

function createHarness() {
  const body = new FakeElement('body');
  const document = {
    body,
    createElement: (tagName: string) => new FakeElement(tagName),
    execCommand: jest.fn(() => true),
  } as unknown as Document;
  const clipboardWrites: string[] = [];
  const controller = createMarkdownController({
    document,
    renderMarkdown: (text) => `<p>${text}</p>`,
    sanitizeHtml: (html) => html,
    normalizeMarkdown: (text) => text,
    wrapTables: () => undefined,
    linkifyFileRefs: () => undefined,
    writeClipboardText: async (text) => { clipboardWrites.push(text); },
  });
  return { controller, clipboardWrites };
}

function createDetachedCodeRoot() {
  const root = new FakeElement('div');
  const pre = root.appendChild(new FakeElement('pre'));
  const code = pre.appendChild(new FakeElement('code'));
  code.innerText = 'const answer = 42;';
  return { root, pre };
}

describe('markdown controller', () => {
  it('enhances a detached markdown root and copies its code', async () => {
    const { controller, clipboardWrites } = createHarness();
    const { root, pre } = createDetachedCodeRoot();

    controller.enhanceCodeBlocksWithCopyButtons(root as unknown as HTMLElement);

    expect(pre.dataset.hasCopyBtn).toBe('1');
    expect(root.children[0].className).toBe('code-block-wrap');
    const button = root.querySelector('.code-copy-btn');
    expect(button).not.toBeNull();
    await button?.listeners.get('click')?.({ stopPropagation() {} });
    expect(clipboardWrites).toEqual(['const answer = 42;']);
    expect(button?.textContent).toBe('Copied!');
  });

  it('removes cached controls before rebinding one live handler', () => {
    const { controller } = createHarness();
    const { root } = createDetachedCodeRoot();
    const message = { text: 'cached message' };

    controller.renderAssistantMarkdown(root as unknown as HTMLElement, message, false);
    controller.renderAssistantMarkdown(root as unknown as HTMLElement, message, false);

    expect(root.querySelectorAll('.code-copy-btn')).toHaveLength(1);
    expect(root.querySelectorAll('pre[data-has-copy-btn="1"]')).toHaveLength(1);
    expect(root.querySelector('.code-copy-btn')?.listeners.has('click')).toBe(true);
  });

  it('falls back to the document copy command when the Clipboard API fails', async () => {
    const body = new FakeElement('body');
    const execCommand = jest.fn(() => true);
    const controller = createMarkdownController({
      document: {
        body,
        createElement: (tagName: string) => new FakeElement(tagName),
        execCommand,
      } as unknown as Document,
      renderMarkdown: (text) => text,
      sanitizeHtml: (html) => html,
      normalizeMarkdown: (text) => text,
      wrapTables: () => undefined,
      linkifyFileRefs: () => undefined,
      writeClipboardText: async () => { throw new Error('denied'); },
    });

    await expect(controller.writeTextToClipboard('fallback')).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
    expect(body.children).toHaveLength(0);
  });
});
