import {
  createAssistantImageController,
  decodeLocalReference,
  isAssistantImagePath,
} from '../features/images/assistant-image-controller';

class FakeClassList {
  private readonly values = new Set<string>();
  add(...names: string[]) { names.forEach((name) => this.values.add(name)); }
  remove(...names: string[]) { names.forEach((name) => this.values.delete(name)); }
  contains(name: string) { return this.values.has(name); }
}

class FakeElement {
  readonly dataset: Record<string, string> = {};
  readonly classList = new FakeClassList();
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  parentNode: FakeElement | null = null;
  parentElement: FakeElement | null = null;
  isConnected = true;
  className = '';
  textContent = '';
  tabIndex = -1;
  loading = '';
  alt = '';

  constructor(readonly tagName: string) {}
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) || null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  appendChild(child: FakeElement) {
    child.parentNode = this;
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child: FakeElement, before: FakeElement | null) {
    child.parentNode = this;
    child.parentElement = this;
    const index = before ? this.children.indexOf(before) : -1;
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
    return child;
  }
  get nextSibling(): FakeElement | null {
    if (!this.parentNode) return null;
    const index = this.parentNode.children.indexOf(this);
    return this.parentNode.children[index + 1] || null;
  }
  get nextElementSibling(): FakeElement | null { return this.nextSibling; }
  querySelectorAll() {
    const result: FakeElement[] = [];
    const visit = (element: FakeElement) => {
      for (const child of element.children) {
        if (child instanceof FakeAnchor || child instanceof FakeImage) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }
}

class FakeAnchor extends FakeElement {
  constructor() { super('a'); }
  get href() { return this.getAttribute('href') || ''; }
  set href(value: string) { this.setAttribute('href', value); }
}

class FakeImage extends FakeElement {
  private clickHandler?: () => void;
  constructor() { super('img'); }
  get src() { return this.getAttribute('src') || ''; }
  set src(value: string) { this.setAttribute('src', value); }
  addEventListener(type: string, handler: () => void) {
    if (type === 'click') this.clickHandler = handler;
  }
  click() { this.clickHandler?.(); }
}

describe('assistant image controller', () => {
  beforeAll(() => {
    (globalThis as any).HTMLAnchorElement = FakeAnchor;
    (globalThis as any).HTMLImageElement = FakeImage;
  });

  test('recognizes local image references without treating remote URLs as workspace paths', () => {
    expect(isAssistantImagePath('.../eta_kappa.png')).toBe(true);
    expect(isAssistantImagePath('results/plot.SVG')).toBe(true);
    expect(isAssistantImagePath('results/summary.json')).toBe(false);
    expect(decodeLocalReference('ocfile://open?path=results%2Fplot.png'))
      .toBe('results/plot.png');
    expect(decodeLocalReference('results/plot%20one.png')).toBe('results/plot one.png');
    expect(decodeLocalReference('https://example.com/plot.png')).toBe('');
  });

  test('uses the preceding full path to resolve ellipsis images and installs lazy previews', () => {
    const posts: any[] = [];
    const root = new FakeElement('div');
    const summary = root.appendChild(new FakeAnchor()) as FakeAnchor;
    summary.href = 'data/results/case-a/summary.json';
    const abbreviated = root.appendChild(new FakeImage()) as FakeImage;
    abbreviated.src = '.../eta_kappa.png';
    const code = root.appendChild(new FakeElement('code'));
    const linked = code.appendChild(new FakeAnchor()) as FakeAnchor;
    linked.href = 'data/results/case-a/relative_deltaD_energy.png';
    linked.textContent = 'data/results/case-a/relative_deltaD_energy.png';
    code.textContent = linked.textContent;
    const document = {
      createElement: (tag: string) => tag === 'a' ? new FakeAnchor() : new FakeImage(),
    } as unknown as Document;
    const controller = createAssistantImageController({
      document,
      postMessage: (message) => posts.push(message),
      createRequestId: () => 'request-1',
    });

    controller.enhance(root as unknown as HTMLElement);
    expect(posts[0]).toEqual({
      type: 'resolveAssistantImageReferences',
      requestId: 'request-1',
      references: [
        {
          id: 'image-1',
          path: '.../eta_kappa.png',
          contextPath: 'data/results/case-a/summary.json',
        },
        {
          id: 'image-2',
          path: 'data/results/case-a/relative_deltaD_energy.png',
          contextPath: undefined,
        },
      ],
    });

    expect(controller.acceptResponse({
      type: 'assistantImageReferencesResolved',
      requestId: 'request-1',
      items: [
        {
          id: 'image-1',
          path: '.../eta_kappa.png',
          resolvedPath: 'data/results/case-a/eta_kappa.png',
          uri: 'webview://eta',
        },
        {
          id: 'image-2',
          path: linked.href,
          resolvedPath: 'data/results/case-a/relative_deltaD_energy.png',
          uri: 'webview://delta',
        },
      ],
    })).toBe(true);

    expect(abbreviated.src).toBe('webview://eta');
    expect(abbreviated.loading).toBe('lazy');
    expect(root.children).toHaveLength(4);
    expect(root.children[3].className).toBe('assistant-image-thumbnail');
    expect(code.classList.contains('assistant-image-path-hidden')).toBe(true);
    abbreviated.click();
    expect(posts[1]).toEqual({
      type: 'openFileAtLocation',
      path: 'data/results/case-a/eta_kappa.png',
    });
  });
});
