import { createMarkdownController, normalizeMarkdownText } from '../rendering/markdown-controller';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

function renderWithProductionMath(markdown: string): string {
  const sandbox: any = { module: { exports: {} }, exports: {}, require };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(process.cwd(), 'media', 'katex.min.js'), 'utf8'), sandbox);
  const katex = sandbox.module.exports;
  sandbox.module = { exports: {} };
  vm.runInContext(fs.readFileSync(path.join(process.cwd(), 'media', 'texmath.min.js'), 'utf8'), sandbox);
  const texmath = sandbox.module.exports;
  const MarkdownIt = require('markdown-it');
  const markdownIt = new MarkdownIt({ breaks: true });
  markdownIt.use(texmath, {
    engine: katex,
    delimiters: ['dollars', 'brackets'],
    outerSpace: true,
    katexOptions: { throwOnError: false },
  });
  return markdownIt.render(normalizeMarkdownText(markdown));
}

describe('markdown text normalization', () => {
  test('preserves the production reminder, math, newline, and nested-list transformations', () => {
    expect(normalizeMarkdownText('<system-reminder source="x">keep</system-reminder>\r\n\\[x + y\\]\r\n$  x_1  $'))
      .toBe('&lt;system-reminder&gt;keep&lt;/system-reminder&gt;\n\n\n\\[x + y\\]\n\n\n\\(x_1\\)');
    expect(normalizeMarkdownText('1. parent\n- child\n+ child two\n2. next'))
      .toBe('1. parent\n    - child\n    + child two\n2. next');
  });

  test('does not rewrite plain currency, fenced lists, headings, or horizontal rules', () => {
    expect(normalizeMarkdownText('$12.50\n```\n1. code\n- unchanged\n```\n1. item\n# heading\n- top'))
      .toBe('$12.50\n```\n1. code\n- unchanged\n```\n1. item\n# heading\n- top');
  });

  test('restores escaped inline and display math without rewriting code or currency', () => {
    const input = [
      '2. speed \\$v_{\\mathrm{HF}}^{(1)}\\$;',
      '3. target',
      '\\$\\$',
      'v_{\\mathrm{target},\\alpha} = \\alpha v_{\\mathrm{HF}}^{(1)};',
      '\\$\\$',
      'Price \\$12.50 and `\\$x_1\\$`.',
      '```text',
      '\\$\\$not_math_1\\$\\$',
      '```',
    ].join('\n');

    expect(normalizeMarkdownText(input)).toBe([
      '2. speed \\(v_{\\mathrm{HF}}^{(1)}\\);',
      '3. target',
      '$$v_{\\mathrm{target},\\alpha} = \\alpha v_{\\mathrm{HF}}^{(1)};$$',
      'Price \\$12.50 and `\\$x_1\\$`.',
      '```text',
      '\\$\\$not_math_1\\$\\$',
      '```',
    ].join('\n'));
  });

  test('prevents list-contained display math from becoming a setext heading', () => {
    const input = [
      '2. HF speed $v_{\\mathrm{HF}}^{(1)}$；',
      '3. target speed',
      '   $$',
      '   v_{\\mathrm{target},\\alpha}',
      '   =',
      '   \\alpha v_{\\mathrm{HF}}^{(1)};',
      '   $$',
      '4. fixed $\\alpha\\in\\{1,1.25,1.5,\\ldots\\}$，continue',
      '5. objective',
      '   $$',
      '   \\Phi_\\alpha(x_0,x_{\\mathrm{HF}})',
      '   =',
      '   L_{D,0}(x_0)',
      '   +',
      '   L_{D,\\mathrm{HF}}(x_{\\mathrm{HF}}).',
      '   $$',
    ].join('\n');

    expect(normalizeMarkdownText(input)).toBe([
      '2. HF speed \\(v_{\\mathrm{HF}}^{(1)}\\)；',
      '3. target speed',
      '   $$v_{\\mathrm{target},\\alpha} = \\alpha v_{\\mathrm{HF}}^{(1)};$$',
      '4. fixed \\(\\alpha\\in\\{1,1.25,1.5,\\ldots\\}\\)，continue',
      '5. objective',
      '   $$\\Phi_\\alpha(x_0,x_{\\mathrm{HF}}) = L_{D,0}(x_0) + L_{D,\\mathrm{HF}}(x_{\\mathrm{HF}}).$$',
    ].join('\n'));
  });

  test('renders every formula in the reported ordered-list structure', () => {
    const markdown = [
      '1. fixed images;',
      '2. HF speed $v_{\\mathrm{HF}}^{(1)}$；',
      '3. target speed',
      '   $$',
      '   v_{\\mathrm{target},\\alpha}',
      '   =',
      '   \\alpha v_{\\mathrm{HF}}^{(1)};',
      '   $$',
      '4. fixed $\\alpha\\in\\{1,1.25,1.5,\\ldots\\}$，continue;',
      '5. objective',
      '   $$',
      '   \\Phi_\\alpha(x_0,x_{\\mathrm{HF}})',
      '   =',
      '   L_{D,0}(x_0)',
      '   +',
      '   L_{D,\\mathrm{HF}}(x_{\\mathrm{HF}}).',
      '   $$',
    ].join('\n');

    const html = renderWithProductionMath(markdown);
    expect(html.match(/class="katex"/g)).toHaveLength(4);
    expect(html).not.toContain('<h1>');
    expect(html).not.toContain('$$<br>');
  });
});

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

  it('rebinds image references after cached assistant HTML is remounted', () => {
    const root = new FakeElement('div');
    const enhanceImageReferences = jest.fn();
    const controller = createMarkdownController({
      document: {
        body: new FakeElement('body'),
        createElement: (tagName: string) => new FakeElement(tagName),
        execCommand: jest.fn(() => true),
      } as unknown as Document,
      renderMarkdown: (text) => `<p>${text}</p>`,
      sanitizeHtml: (html) => html,
      normalizeMarkdown: (text) => text,
      wrapTables: () => undefined,
      linkifyFileRefs: () => undefined,
      enhanceImageReferences,
    });
    const message = { text: '![plot](results/plot.png)' };

    controller.renderAssistantMarkdown(root as unknown as HTMLElement, message, true);
    controller.renderAssistantMarkdown(root as unknown as HTMLElement, message, true);

    expect(enhanceImageReferences).toHaveBeenCalledTimes(2);
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
