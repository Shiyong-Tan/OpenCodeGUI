import fs from 'fs';
import path from 'path';
import { getSafeShellSpec } from '../rendering/safe-shell-spec';
import { collectBoundedSmartSearchText, createLinearSearchMatcher } from '../features/search/search-text';
import {
  cleanSearchSubagentTitle,
  formatSearchSubagentModel,
  getLoadedSessionSearchText,
  pickSearchAgentMode,
  visitLoadedChatSearchChunks as visitSearchChunks,
} from '../features/search/search-corpus';

const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const markdownControllerSource = fs.readFileSync(
  path.join(process.cwd(), 'webview-src', 'rendering', 'markdown-controller.ts'),
  'utf8',
).replace(/\r\n/g, '\n');
const messageRendererSource = fs.readFileSync(
  path.join(process.cwd(), 'webview-src', 'rendering', 'message-renderer.ts'),
  'utf8',
).replace(/\r\n/g, '\n');

function extractMessageRenderer(): string {
  const marker = 'export function renderMessageElement(';
  const start = messageRendererSource.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  return messageRendererSource.slice(start);
}

function extractFunction(marker: string): string {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const brace = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) { escaped = false; continue; }
    if (quote && char === '\\') { escaped = true; continue; }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unclosed function ${marker}`);
}

class TestNode {
  children: TestElement[] = [];
  parentElement: TestElement | null = null;
  appendChild(child: TestElement): TestElement {
    if (child.parentElement) child.remove();
    this.children.push(child);
    child.parentElement = this as unknown as TestElement;
    return child;
  }
  removeChild(child: TestElement): TestElement {
    const index = this.children.indexOf(child);
    if (index < 0) throw new Error('Child not found');
    this.children.splice(index, 1);
    child.parentElement = null;
    return child;
  }
  replaceChildren(...children: TestElement[]): void {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    for (const child of children) this.appendChild(child);
  }
}

class TestElement extends TestNode {
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<(event: any) => void>>();
  className = '';
  id = '';
  type = '';
  disabled = false;
  tabIndex = 0;
  textContent = '';
  title = '';
  href = '';
  src = '';
  alt = '';
  loading = '';
  tagName: string;
  ownerDocument: TestDocument;
  _safeShellDispose?: () => void;
  constructor(tagName: string, document: TestDocument) {
    super();
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = document;
  }
  get childNodes(): TestElement[] { return this.children; }
  get isConnected(): boolean {
    let current: TestElement | null = this;
    while (current) {
      if (current === this.ownerDocument.body) return true;
      current = current.parentElement;
    }
    return false;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
    if (name === 'id') this.id = String(value);
  }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  addEventListener(name: string, listener: (event: any) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) || []), listener]);
  }
  dispatch(name: string): void {
    const event = { preventDefault: jest.fn(), stopPropagation: jest.fn(), currentTarget: this };
    for (const listener of this.listeners.get(name) || []) listener(event);
  }
  click(): void { if (!this.disabled) this.dispatch('click'); }
  focus(): void { this.ownerDocument.activeElement = this; }
  remove(): void {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }
  replaceWith(next: TestElement): void {
    if (!this.parentElement) return;
    const parent = this.parentElement;
    const index = parent.children.indexOf(this);
    parent.children[index] = next;
    next.parentElement = parent;
    this.parentElement = null;
  }
  replaceChild(next: TestElement, child: TestElement): TestElement {
    const index = this.children.indexOf(child);
    if (index < 0) throw new Error('Child not found');
    this.children[index] = next;
    next.parentElement = this;
    child.parentElement = null;
    return child;
  }
  querySelector(selector: string): TestElement | null {
    return this.querySelectorAll(selector)[0] || null;
  }
  querySelectorAll(selector: string): TestElement[] {
    const result: TestElement[] = [];
    const visit = (node: TestElement) => {
      for (const child of node.children) {
        const role = /^\[data-safe-shell-role="([^"]+)"\]$/.exec(selector)?.[1];
        const matches = role ? child.dataset.safeShellRole === role
          : selector === 'button' ? child.tagName === 'BUTTON'
            : selector === 'a' ? child.tagName === 'A'
            : selector === 'img' ? child.tagName === 'IMG'
            : /^[a-z]+$/.test(selector) ? child.tagName === selector.toUpperCase()
            : selector === '[data-render-unit-key]' ? Boolean(child.dataset.renderUnitKey)
              : false;
        if (matches) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }
}

class TestFragment extends TestElement {
  constructor(document: TestDocument) { super('#fragment', document); }
}

class TestDocument {
  body: TestElement;
  activeElement: TestElement | null = null;
  constructor() { this.body = new TestElement('body', this); }
  createElement(tag: string): TestElement { return new TestElement(tag, this); }
  createDocumentFragment(): TestFragment { return new TestFragment(this); }
  getElementById(id: string): TestElement | null {
    if (this.body.id === id) return this.body;
    const visit = (node: TestElement): TestElement | null => {
      for (const child of node.children) {
        if (child.id === id) return child;
        const nested = visit(child);
        if (nested) return nested;
      }
      return null;
    };
    return visit(this.body);
  }
}

function descendantCount(root: TestElement): number {
  return root.children.reduce((count, child) => count + 1 + descendantCount(child), 0);
}

function rootText(root: TestElement): string {
  return [root.textContent, ...root.children.map(rootText)].join(' ');
}

function control(root: TestElement, role: string): TestElement {
  const found = root.querySelector(`[data-safe-shell-role="${role}"]`);
  if (!found) throw new Error(`Missing control ${role}`);
  return found;
}

function createHarness(options: { appendable?: boolean; undoAllowed?: boolean; busy?: boolean; clipboard?: Promise<boolean> } = {}) {
  const document = new TestDocument();
  const chat = document.createElement('main');
  chat.id = 'chat';
  document.body.appendChild(chat);
  let mounted: TestElement | null = null;
  let activeSessionId = 'session-a';
  const calls = {
    rich: 0, userMarkdown: 0, images: 0, copyText: 0, assistantCopyText: 0, appendCheck: 0,
    messageCopyText: 0, append: 0, undoCheck: 0, discard: 0, undo: 0, clipboard: [] as string[],
    posted: [] as any[], gitDiff: [] as any[], segmentRich: 0, segmentRestore: [] as any[], segmentToggle: [] as any[],
  };
  const clipboard = options.clipboard || Promise.resolve(true);
  const session: any = { messagesById: new Map(), backendTurnInFlight: true };
  const deps: any = {
    document,
    window: {
      __ocRendering: { getSafeShellSpec },
      __oc: { renderFromState: jest.fn() },
      __ocFeatures: {
        cleanSearchSubagentTitle,
        formatSearchSubagentModel,
        pickSearchAgentMode,
        visitLoadedChatSearchChunks: visitSearchChunks,
        createLinearSearchMatcher,
        collectBoundedSmartSearchText,
        getLoadedSessionSearchText,
      },
    },
    get activeSessionId() { return activeSessionId; },
    set activeSessionId(value: string) { activeSessionId = value; },
    keyedChatRenderCapture: null,
    keyedFollowingTurnDividerOverride: null,
    keyedRootForKey: (key: string) => mounted?.dataset.renderUnitKey === key ? mounted : null,
    renderSegmentElement: jest.fn(() => {
      calls.segmentRich += 1;
      const richRoot = document.createElement('div');
      deps.keyedChatRenderCapture.appendChild(richRoot);
    }),
    renderConflictCard: jest.fn(),
    renderMarkdownInto: jest.fn((root: TestElement, text: string) => { root.textContent = text; }),
    renderMessageElement: jest.fn(() => {
      calls.rich += 1;
      const richRoot = document.createElement('div');
      deps.keyedChatRenderCapture.appendChild(richRoot);
    }),
    getAppendItems: (message: any) => Array.isArray(message?.meta?.appendedPrompts) ? message.meta.appendedPrompts : [],
    stripSystemInjections: (text: string) => text,
    stripAttachmentManifest: (text: string) => text,
    getUserMessageCopyText: (message: any) => {
      calls.copyText += 1;
      const parts = [String(message.text || '').trim(), ...deps.getAppendItems(message).map((item: any) => String(item?.text || '').trim())];
      return parts.filter(Boolean).join('\n\n');
    },
    getDisplayedAssistantCopyText: (message: any) => {
      calls.assistantCopyText += 1;
      if (!message || message.role !== 'assistant') return '';
      if (message.meta?.isDiff) return String(message.meta.diffText || message.text || '').trim();
      const completed = message.meta?.isThinking !== true;
      const segments = message.meta?.textSegments;
      if (completed && Array.isArray(segments) && segments.length > 0) {
        const finalText = typeof segments[segments.length - 1] === 'string' ? segments[segments.length - 1].trim() : '';
        if (finalText) return finalText;
      }
      return String(message.text || '').trim();
    },
    getMessageCopyText: (message: any) => {
      calls.messageCopyText += 1;
      if (message?.role === 'assistant') return deps.getDisplayedAssistantCopyText(message);
      if (message?.role === 'user') return deps.getUserMessageCopyText(message);
      return '';
    },
    isAllowedFileExt: () => true,
    FILE_REF_RE: /([A-Za-z0-9_./-]+\.[A-Za-z0-9]+):(\d{1,6})(?::(\d{1,6}))?/g,
    FILE_ONLY_RE: /(?<![A-Za-z0-9_./-])((?:\.{1,2}\/)?(?:[A-Za-z0-9_-]+\/)+[A-Za-z0-9_-]+\.[A-Za-z][A-Za-z0-9]{0,9})(?![A-Za-z0-9_./-])/g,
    writeTextToClipboard: (text: string) => { calls.clipboard.push(text); return clipboard; },
    vscode: { postMessage: (message: any) => calls.posted.push(message) },
    postOpenGitDiff: (...args: any[]) => calls.gitDiff.push(args),
    handleRestoreSegment: (...args: any[]) => calls.segmentRestore.push(args),
    handleToggleSegment: (...args: any[]) => calls.segmentToggle.push(args),
    createOperationId: () => 'op-safe-shell-test',
    logSessionState: jest.fn(),
    canAppendToMessage: () => { calls.appendCheck += 1; return options.appendable === true; },
    enterAppendInputMode: () => { calls.append += 1; },
    canUndo: () => { calls.undoCheck += 1; return { allowed: options.undoAllowed !== false, msgId: 'msg_user', reason: 'ok' }; },
    discardAllSegments: () => { calls.discard += 1; },
    handleUndoToMessage: () => { calls.undo += 1; },
    getSessionState: () => session,
    isBusy: options.busy === true,
    selectedMode: 'build',
    clearTimeout,
    setTimeout,
    cancelAnimationFrame: clearTimeout,
    requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  };

  const changeListAdapter = source.includes('function renderSafeShellChangeList(')
    ? extractFunction('function renderSafeShellChangeList(')
    : 'function renderSafeShellChangeList() { return null; }';
  const segmentAdapter = source.includes('function renderSafeShellSegment(')
    ? extractFunction('function renderSafeShellSegment(')
    : 'function renderSafeShellSegment() { return null; }';
  const conflictPageAdapter = source.includes('function scanSafeShellConflictDiffPage(')
    ? extractFunction('function scanSafeShellConflictDiffPage(')
    : 'function scanSafeShellConflictDiffPage() { return { pageText: "", totalPages: 1, codeUnitCount: 0, lineCount: 0 }; }';
  const conflictAdapter = source.includes('function renderSafeShellConflictCard(')
    ? extractFunction('function renderSafeShellConflictCard(')
    : 'function renderSafeShellConflictCard() { return null; }';
  const imageAdapter = source.includes('function renderSafeShellImageMessage(')
    ? extractFunction('function renderSafeShellImageMessage(')
    : 'function renderSafeShellImageMessage() { return null; }';
  const codePageAdapter = source.includes('function scanSafeShellCodePage(')
    ? extractFunction('function scanSafeShellCodePage(')
    : 'function scanSafeShellCodePage() { return { blockCount: 0 }; }';
  const codeAdapter = source.includes('function renderSafeShellCodeMessage(')
    ? extractFunction('function renderSafeShellCodeMessage(')
    : 'function renderSafeShellCodeMessage() { return null; }';
  const diffPageAdapter = source.includes('function scanSafeShellDiffPage(')
    ? extractFunction('function scanSafeShellDiffPage(')
    : 'function scanSafeShellDiffPage() { return { pageText: "", totalPages: 1, selectedPage: 1, codeUnitCount: 0, lineCount: 0, hunkCount: 0 }; }';
  const diffAdapter = source.includes('function renderSafeShellDiffMessage(')
    ? extractFunction('function renderSafeShellDiffMessage(')
    : 'function renderSafeShellDiffMessage() { return null; }';
  const tablePageAdapter = source.includes('function scanSafeShellTablePage(')
    ? extractFunction('function scanSafeShellTablePage(')
    : 'function scanSafeShellTablePage() { return { found: false }; }';
  const tableAdapter = source.includes('function renderSafeShellTableMessage(')
    ? extractFunction('function renderSafeShellTableMessage(')
    : 'function renderSafeShellTableMessage() { return null; }';
  const markdownPageAdapter = source.includes('function scanSafeShellMarkdownPage(')
    ? extractFunction('function scanSafeShellMarkdownPage(')
    : 'function scanSafeShellMarkdownPage() { return { pageText: "", totalPages: 1 }; }';
  const markdownAdapter = source.includes('function renderSafeShellMarkdownMessage(')
    ? extractFunction('function renderSafeShellMarkdownMessage(')
    : 'function renderSafeShellMarkdownMessage() { return null; }';
  const conflictOwnerStart = source.indexOf('function renderConflictCard(');
  const conflictOwnerEnd = source.indexOf('\nfunction commitCurrentQuestionAnswers(', conflictOwnerStart);
  const conflictOwnerAdapter = source.slice(conflictOwnerStart, conflictOwnerEnd);
  const runtime = new Function('deps', `with (deps) {
    let safeShellPresentationGeneration = 0;
    const safeShellMountOwnership = new WeakMap();
    let keyedPresentationSelectionOverride = null;
    let keyedUnitKeyOverride = null;
    let conflictShellPresentationGeneration = 0;
    let conflictCardEl = null;
    let lastConflictPayload = null;
    ${extractFunction('function forEachSafeShellUserCanonicalPart(')}
    ${extractFunction('function scanSafeShellTextPage(')}
    ${extractFunction('function scanSafeShellAssistantTextPage(')}
    ${codePageAdapter}
    ${diffPageAdapter}
    ${tablePageAdapter}
    ${markdownPageAdapter}
    ${extractFunction('function pickMode(')}
    ${extractFunction('function cleanSubagentTitle(')}
    ${extractFunction('function formatSubagentModel(')}
    ${extractFunction('function visitLoadedChatSearchChunks(')}
    ${extractFunction('function isSafeShellMountCurrent(')}
    ${extractFunction('function disposeSafeShellRoot(')}
    ${extractFunction('function renderSafeShellUserMessage(')}
    ${extractFunction('function renderSafeShellAssistantMessage(')}
    ${extractFunction('function renderSafeShellSubagentMessage(')}
    ${extractFunction('function renderSafeShellToolMetaMessage(')}
    ${imageAdapter}
    ${codeAdapter}
    ${diffAdapter}
    ${tableAdapter}
    ${markdownAdapter}
    function getSessionOrNull() { return getSessionState(); }
    ${extractFunction('function renderNestedMessageElement(')}
    ${changeListAdapter}
    ${segmentAdapter}
    ${conflictPageAdapter}
    ${conflictAdapter}
    ${conflictOwnerAdapter}
    ${extractFunction('function renderDetachedKeyedUnit(')}
    ${extractFunction('function getLoadedSessionSearchText(')}
    return {
      renderDetachedKeyedUnit, disposeSafeShellRoot, getLoadedSessionSearchText, visitLoadedChatSearchChunks,
      scanSafeShellTablePage, scanSafeShellMarkdownPage,
      renderNestedDiff: (message, selection, unitKey) => {
        keyedPresentationSelectionOverride = selection;
        keyedUnitKeyOverride = unitKey;
        return renderNestedMessageElement(message);
      },
      setLastConflictPayload: (payload) => { lastConflictPayload = payload; },
      getConflictLifecycle: () => ({ conflictCardEl, lastConflictPayload })
    };
  }`)(deps);

  const mount = (root: TestElement) => {
    if (mounted) mounted.replaceWith(root); else chat.appendChild(root);
    mounted = root;
  };
  const unmount = () => { mounted?._safeShellDispose?.(); runtime.disposeSafeShellRoot(mounted); mounted?.remove(); mounted = null; };
  return { document, chat, calls, deps, session, runtime, mount, unmount, get mounted() { return mounted; } };
}

function renderChangeList(harness: ReturnType<typeof createHarness>, message: any, selection?: any): TestElement {
  harness.session.messagesById.set(message.id, message);
  const root = harness.runtime.renderDetachedKeyedUnit(
    harness.session,
    { key: message.id, kind: 'change-list', value: { message, hasPriorUser: true } },
    new Set(),
    selection,
  );
  harness.mount(root);
  return root;
}

function renderUser(harness: ReturnType<typeof createHarness>, message: any, selection?: any): TestElement {
  harness.session.messagesById.set(message.id, message);
  const root = harness.runtime.renderDetachedKeyedUnit(
    harness.session,
    { key: message.id, kind: 'message', value: { message, hasPriorUser: false } },
    new Set(),
    selection,
  );
  harness.mount(root);
  return root;
}

function renderAssistant(harness: ReturnType<typeof createHarness>, message: any, selection?: any): TestElement {
  harness.session.messagesById.set(message.id, message);
  const root = harness.runtime.renderDetachedKeyedUnit(
    harness.session,
    { key: message.id, kind: 'message', value: { message, hasPriorUser: true } },
    new Set(),
    selection,
  );
  harness.mount(root);
  return root;
}

function renderMessage(harness: ReturnType<typeof createHarness>, message: any, selection?: any): TestElement {
  harness.session.messagesById.set(message.id, message);
  const root = harness.runtime.renderDetachedKeyedUnit(
    harness.session,
    { key: message.id, kind: 'message', value: { message, hasPriorUser: true } },
    new Set(),
    selection,
  );
  harness.mount(root);
  return root;
}

function renderSegment(harness: ReturnType<typeof createHarness>, segment: any, selection?: any): TestElement {
  const key = segment.renderKey || segment.noticeKey || segment.id || 'segment-key';
  const root = harness.runtime.renderDetachedKeyedUnit(
    harness.session,
    { key, sourceKey: key, kind: 'segment', value: { segment } },
    new Set(),
    selection,
  );
  harness.mount(root);
  return root;
}

function renderConflict(harness: ReturnType<typeof createHarness>, payload: any, selection?: any): TestElement {
  harness.runtime.setLastConflictPayload(payload);
  const identity = payload.conflictId || payload.operationId || 'active';
  const key = `conflict:${payload.sessionId || 'none'}:${identity}`;
  const root = harness.runtime.renderDetachedKeyedUnit(
    harness.session,
    { key, kind: 'conflict', value: payload },
    new Set(),
    selection,
  );
  harness.mount(root);
  return root;
}

describe('A1S.1 ordinary user safe shell main contract', () => {
  test('A1S.1-RED-1 keeps omitted mode on the exact rich path and explicit user shell bypasses rich work', () => {
    const detached = extractFunction('function renderDetachedKeyedUnit(');
    expect(detached).toContain('presentationSelection');
    expect(detached).toContain('renderSafeShellUserMessage(session, unit, presentationSelection)');
    expect(detached).toContain('renderMessageElement(unit.value.message, renderedSet);');

    const harness = createHarness();
    const message = { id: 'msg_user', role: 'user', text: 'hello', meta: { appendedPrompts: [{ text: 'more' }], images: ['x'] } };
    harness.runtime.renderDetachedKeyedUnit(harness.session, { key: message.id, kind: 'message', value: { message } }, new Set());
    expect(harness.calls.rich).toBe(1);
    const root = renderUser(harness, message, { mode: 'safe-shell', family: 'message-user' });
    expect(harness.calls.rich).toBe(1);
    expect(root.dataset.safeShellFamily).toBe('message-user');
    expect(source).not.toMatch(/renderSafeShellUserMessage[\s\S]{0,500}(renderUserMarkdown|appendMessageImages|enhanceCodeBlocksWithCopyButtons)/);
  });

  test('A1S.1-RED-2 remains bounded for adversarial canonical content and pages/copies canonically', async () => {
    const appendedPrompts = Array.from({ length: 100_000 }, (_, index) => ({ text: `append-${index}` }));
    const message = {
      id: 'msg_user', role: 'user',
      text: `${'line\n'.repeat(100_000)}${'x'.repeat(8 * 1024 * 1024)}`,
      meta: { appendedPrompts, images: Array.from({ length: 100_000 }, (_, index) => `image-${index}`) },
    };
    const harness = createHarness();
    const root = renderUser(harness, message, { mode: 'safe-shell', family: 'message-user' });
    const accepted = getSafeShellSpec({ mode: 'safe-shell', family: 'message-user', shape: {} }) as any;
    expect(descendantCount(root)).toBeLessThanOrEqual(accepted.budgets.collapsedDescendants);
    expect(root.children.length).toBeLessThanOrEqual(accepted.budgets.rootDirectChildren);
    expect({ descendants: descendantCount(root), directChildren: root.children.length }).toEqual({ descendants: 8, directChildren: 4 });
    expect(control(root, 'status').textContent).toMatch(/100000 appended prompts.*100000 images/i);

    control(root, 'open-full').click();
    expect(descendantCount(root)).toBeLessThanOrEqual(accepted.budgets.openDescendants);
    expect({ descendants: descendantCount(root), directChildren: root.children.length }).toEqual({ descendants: 12, directChildren: 4 });
    const viewer = control(root, 'viewer');
    const pageSpec = getSafeShellSpec({ mode: 'safe-shell', family: 'message-user', shape: {} }) as any;
    expect(viewer.textContent.length).toBeLessThanOrEqual(pageSpec.page.content.maxCodeUnits);
    expect(viewer.textContent.split('\n').length).toBeLessThanOrEqual(pageSpec.page.content.maxLines);
    const firstPage = control(root, 'page-status').textContent;
    control(root, 'next').click();
    expect(control(root, 'page-status').textContent).not.toBe(firstPage);
    control(root, 'previous').click();
    expect(control(root, 'page-status').textContent).toBe(firstPage);

    control(root, 'copy-full').click();
    await Promise.resolve();
    expect(harness.calls.copyText).toBe(1);
    expect(harness.calls.clipboard[0]).toContain('append-99999');
    control(root, 'close').click();
    expect(descendantCount(root)).toBeLessThanOrEqual(accepted.budgets.collapsedDescendants);
  }, 30_000);

  test('A1S.1-RED-3 delegates append and undo eligibility/actions without canonical mutation', () => {
    const message = Object.freeze({ id: 'msg_user', role: 'user', text: 'canonical', meta: Object.freeze({ appendedPrompts: Object.freeze([]) }) });
    const appendHarness = createHarness({ appendable: true });
    const appendRoot = renderUser(appendHarness, message, { mode: 'safe-shell', family: 'message-user' });
    control(appendRoot, 'append').click();
    expect(appendHarness.calls.appendCheck).toBeGreaterThan(0);
    expect(appendHarness.calls.append).toBe(1);

    const undoHarness = createHarness({ appendable: false, undoAllowed: true });
    const undoRoot = renderUser(undoHarness, message, { mode: 'safe-shell', family: 'message-user' });
    control(undoRoot, 'undo').click();
    expect(undoHarness.calls.undoCheck).toBeGreaterThan(0);
    expect(undoHarness.calls.discard).toBe(1);
    expect(undoHarness.calls.undo).toBe(1);
    expect(message.text).toBe('canonical');

    const deniedHarness = createHarness({ appendable: false, undoAllowed: false });
    expect(control(renderUser(deniedHarness, message, { mode: 'safe-shell', family: 'message-user' }), 'undo').disabled).toBe(true);
    const busyHarness = createHarness({ appendable: false, undoAllowed: true, busy: true });
    expect(control(renderUser(busyHarness, message, { mode: 'safe-shell', family: 'message-user' }), 'undo').disabled).toBe(true);
  });

  test('A1S.1-RED-4 provides deterministic native accessibility and rejects stale callbacks', async () => {
    let resolveClipboard!: (value: boolean) => void;
    const pendingClipboard = new Promise<boolean>((resolve) => { resolveClipboard = resolve; });
    const harness = createHarness({ clipboard: pendingClipboard });
    const message = { id: 'msg_user', role: 'user', text: 'one\ntwo', meta: {} };
    const normal = renderUser(harness, message);
    const shell = renderUser(harness, message, { mode: 'safe-shell', family: 'message-user' });
    expect(shell).not.toBe(normal);
    expect(shell.dataset.renderUnitKey).toBe(normal.dataset.renderUnitKey);
    const open = control(shell, 'open-full');
    expect(open.tagName).toBe('BUTTON');
    expect(open.type).toBe('button');
    expect(open.getAttribute('aria-controls')).toBe(control(shell, 'viewer-region').id);
    expect(open.getAttribute('aria-expanded')).toBe('false');
    expect(control(shell, 'status').getAttribute('role')).toBe('status');
    open.click();
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(harness.document.activeElement).toBe(control(shell, 'viewer'));
    control(shell, 'copy-full').click();
    harness.unmount();
    harness.deps.activeSessionId = 'session-b';
    resolveClipboard(true);
    await Promise.resolve();
    expect(shell.dataset.safeShellCopyState).toBeUndefined();

    const remounted = renderUser(harness, message, { mode: 'safe-shell', family: 'message-user' });
    control(remounted, 'open-full').click();
    control(remounted, 'close').click();
    expect(harness.document.activeElement).toBe(control(remounted, 'open-full'));
  });

  test('runtime consumes accepted A1S.0 descriptors and main owns no copied numeric policy', () => {
    const shellFunctions = [
      extractFunction('function scanSafeShellTextPage('),
      extractFunction('function renderSafeShellUserMessage('),
    ].join('\n');
    expect(shellFunctions).toContain("typeof rendering.getSafeShellSpec !== 'function'");
    expect(shellFunctions).toContain('rendering.getSafeShellSpec({');
    expect(shellFunctions).not.toMatch(/\b(?:8192|8_192|40|48)\b/);
    expect(source).toContain('let safeShellPresentationGeneration = 0;');
    expect(source).toContain('existing._safeShellDispose?.();');
  });

  test('A1S.1-SMOKE runs normal → shell → page/copy/action/close → remount and keeps ordinary rendering normal', async () => {
    let resolveClipboard!: (value: boolean) => void;
    const pendingClipboard = new Promise<boolean>((resolve) => { resolveClipboard = resolve; });
    const harness = createHarness({ appendable: true, clipboard: pendingClipboard });
    const contract = getSafeShellSpec({ mode: 'safe-shell', family: 'message-user', shape: {} }) as any;
    const message = { id: 'msg_user', role: 'user', text: 'x'.repeat(contract.page.content.maxCodeUnits + 1), meta: {} };

    renderUser(harness, message);
    expect(harness.calls.rich).toBe(1);
    const shell = renderUser(harness, message, { mode: 'safe-shell', family: 'message-user' });
    control(shell, 'open-full').click();
    control(shell, 'next').click();
    control(shell, 'copy-full').click();
    control(shell, 'append').click();
    expect(harness.calls.append).toBe(1);
    control(shell, 'close').click();

    harness.unmount();
    const remounted = renderUser(harness, message, { mode: 'safe-shell', family: 'message-user' });
    resolveClipboard(true);
    await Promise.resolve();
    expect(shell.dataset.safeShellCopyState).toBeUndefined();
    expect(remounted.dataset.safeShellCopyState).toBeUndefined();

    renderUser(harness, { id: 'msg_ordinary_send', role: 'user', text: 'ordinary send', meta: {} });
    expect(harness.calls.rich).toBe(2);
  });
});

describe('A1S.8 explicit dormant message-image safe shell main contract', () => {
  const selection = { mode: 'safe-shell', family: 'message-image' };

  test('A1S.8-RED-1 selects the explicit adapter before normal appendMessageImages and leaves omitted presentation unchanged', () => {
    const detached = extractFunction('function renderDetachedKeyedUnit(');
    expect(detached).toContain('renderSafeShellImageMessage(session, unit, presentationSelection)');
    expect(detached.indexOf('renderSafeShellImageMessage')).toBeLessThan(detached.indexOf('renderMessageElement(unit.value.message, renderedSet);'));
    expect(source.indexOf('function renderSafeShellImageMessage(')).toBeLessThan(source.indexOf('function appendMessageImages('));

    const harness = createHarness();
    const message = { id: 'image-owner', role: 'assistant', text: 'caption', meta: { images: ['https://example.invalid/one.png'] } };
    const normal = renderMessage(harness, message);
    expect(normal.dataset.safeShellFamily).toBeUndefined();
    expect(harness.calls.rich).toBe(1);
    const shell = renderMessage(harness, message, selection);
    expect(shell.dataset.safeShellFamily).toBe('message-image');
    expect(harness.calls.rich).toBe(1);
    expect(shell.querySelectorAll('img')).toHaveLength(0);
    expect(extractFunction('function appendMessageImages(')).toContain("img.alt = 'Attachment'");
  });

  test('A1S.8-RED-2 bounds 100k canonical sources and huge dimension metadata, with zero collapsed and one current open image', () => {
    const images = Array.from({ length: 100_000 }, (_, index) => index % 3 === 0
      ? `https://example.invalid/${index}.png`
      : index % 3 === 1 ? `data:image/png;base64,${index}` : `malformed-${index}`);
    const harness = createHarness();
    const root = renderMessage(harness, {
      id: 'image-huge', role: 'user', text: '',
      meta: { images, imageDimensions: Array.from({ length: 100_000 }, () => ({ width: Number.MAX_VALUE, height: Number.MAX_VALUE })) },
    }, selection);
    const accepted = getSafeShellSpec({ mode: 'safe-shell', family: 'message-image', shape: { imageCount: images.length } }) as any;
    expect(root.querySelectorAll('img')).toHaveLength(0);
    expect(descendantCount(root)).toBeLessThanOrEqual(32);
    expect(descendantCount(root)).toBeLessThanOrEqual(accepted.budgets.collapsedDescendants);
    expect(root.children.length).toBeLessThanOrEqual(5);
    expect(control(root, 'status').textContent).toMatch(/100000 images.*none loaded/i);

    control(root, 'open-full').click();
    expect(root.querySelectorAll('img')).toHaveLength(1);
    expect(descendantCount(root)).toBeLessThanOrEqual(40);
    expect(descendantCount(root)).toBeLessThanOrEqual(accepted.budgets.openDescendants);
    expect(root.children.length).toBeLessThanOrEqual(5);
    expect(control(root, 'image-status').textContent).toMatch(/image 1 of 100000/i);
    expect(root.querySelectorAll('img')[0].src).toBe(images[0]);
    expect(root.querySelectorAll('img')[0].alt).toBe('Attachment 1');
    control(root, 'next').click();
    expect(root.querySelectorAll('img')).toHaveLength(1);
    expect(control(root, 'image-status').textContent).toMatch(/image 2 of 100000/i);
    expect(root.querySelectorAll('img')[0].src).toBe(images[1]);

    const direct = createHarness();
    const five = ['one', 'two', 'three', 'four', 'five'];
    const directRoot = renderMessage(direct, { id: 'image-five', role: 'assistant', meta: { images: five } }, selection);
    control(directRoot, 'open-full').click();
    for (let index = 0; index < five.length; index += 1) {
      expect(directRoot.querySelectorAll('img')).toHaveLength(1);
      expect(directRoot.querySelectorAll('img')[0].src).toBe(five[index]);
      expect(directRoot.querySelectorAll('img')[0].alt).toBe(`Attachment ${index + 1}`);
      expect(control(directRoot, 'image-status').textContent).toMatch(new RegExp(`image ${index + 1} of 5`, 'i'));
      if (index + 1 < five.length) control(directRoot, 'next').click();
    }
    control(directRoot, 'close').click();
    expect(directRoot.querySelectorAll('img')).toHaveLength(0);
    expect(descendantCount(directRoot)).toBeLessThanOrEqual(32);
  }, 30_000);

  test('A1S.8-RED-3 current load/error is bounded while stale page/replacement/unmount/session callbacks are no-ops', () => {
    const message = { id: 'image-callbacks', role: 'assistant', meta: { images: ['first', 'second'] } };
    const harness = createHarness();
    const firstRoot = renderMessage(harness, message, selection);
    control(firstRoot, 'open-full').click();
    const stalePageImage = firstRoot.querySelectorAll('img')[0];
    control(firstRoot, 'next').click();
    stalePageImage.dispatch('error');
    stalePageImage.dispatch('load');
    expect(firstRoot.querySelectorAll('img')).toHaveLength(1);
    expect(firstRoot.querySelectorAll('img')[0].src).toBe('second');

    const staleReplacementImage = firstRoot.querySelectorAll('img')[0];
    const secondRoot = renderMessage(harness, message, selection);
    staleReplacementImage.dispatch('error');
    expect(secondRoot.querySelectorAll('img')).toHaveLength(0);

    control(secondRoot, 'open-full').click();
    const staleUnmountImage = secondRoot.querySelectorAll('img')[0];
    harness.unmount();
    staleUnmountImage.dispatch('error');
    staleUnmountImage.dispatch('load');
    expect(secondRoot.querySelectorAll('img')).toHaveLength(1);
    expect(secondRoot.querySelectorAll('img')[0]).toBe(staleUnmountImage);

    const sessionHarness = createHarness();
    const sessionRoot = renderMessage(sessionHarness, message, selection);
    control(sessionRoot, 'open-full').click();
    const staleSessionImage = sessionRoot.querySelectorAll('img')[0];
    sessionHarness.deps.activeSessionId = 'session-b';
    staleSessionImage.dispatch('error');
    expect(sessionRoot.querySelectorAll('img')).toHaveLength(1);

    sessionHarness.deps.activeSessionId = 'session-a';
    const current = sessionRoot.querySelectorAll('img')[0];
    current.dispatch('load');
    expect(current.dataset.safeShellImageState).toBe('loaded');
    current.dispatch('error');
    expect(sessionRoot.querySelectorAll('img')).toHaveLength(0);
    expect(control(sessionRoot, 'image-fallback').textContent).toBe('Image unavailable');
    expect(descendantCount(sessionRoot)).toBeLessThanOrEqual(40);
  });

  test('A1S.8-SMOKE normal → shell/open/next/error/close → stale remount and ordinary render remains rich', () => {
    const harness = createHarness();
    const message = { id: 'image-smoke', role: 'user', text: 'caption', meta: { images: ['one', 'two'] } };
    renderMessage(harness, message);
    expect(harness.calls.rich).toBe(1);
    const shell = renderMessage(harness, message, selection);
    control(shell, 'open-full').click();
    const stale = shell.querySelectorAll('img')[0];
    control(shell, 'next').click();
    shell.querySelectorAll('img')[0].dispatch('error');
    expect(control(shell, 'image-fallback').textContent).toBe('Image unavailable');
    control(shell, 'close').click();
    expect(shell.querySelectorAll('img')).toHaveLength(0);
    renderMessage(harness, message, selection);
    stale.dispatch('error');
    renderUser(harness, { id: 'ordinary-send-after-image', role: 'user', text: 'send', meta: {} });
    expect(harness.calls.rich).toBe(2);
  });
});

describe('A1S.2 ordinary assistant safe shell main contract', () => {
  test('A1S.2-RED-1 selects the assistant base shell before rich markdown and uses the canonical displayed final fallback', () => {
    const detached = extractFunction('function renderDetachedKeyedUnit(');
    expect(detached).toContain('renderSafeShellAssistantMessage(session, unit, presentationSelection)');
    expect(detached.indexOf('renderSafeShellAssistantMessage')).toBeLessThan(detached.indexOf('renderMessageElement(unit.value.message, renderedSet);'));

    const harness = createHarness();
    const finalMessage = { id: 'msg_assistant', role: 'assistant', text: 'accumulated', meta: { isThinking: false, textSegments: ['draft', '  final answer  '] } };
    renderAssistant(harness, finalMessage);
    expect(harness.calls.rich).toBe(1);
    const shell = renderAssistant(harness, finalMessage, { mode: 'safe-shell', family: 'message-assistant' });
    expect(harness.calls.rich).toBe(1);
    expect(shell.dataset.safeShellFamily).toBe('message-assistant');
    control(shell, 'open-full').click();
    expect(control(shell, 'viewer').textContent).toBe('final answer');

    const fallback = renderAssistant(harness, { ...finalMessage, id: 'msg_fallback', meta: { isThinking: false, textSegments: [''] } }, { mode: 'safe-shell', family: 'message-assistant' });
    control(fallback, 'open-full').click();
    expect(control(fallback, 'viewer').textContent).toBe('accumulated');
    expect(source).not.toMatch(/function renderSafeShellAssistantMessage[\s\S]{0,800}(renderAssistantMarkdown|renderMarkdownInto|enhanceCodeBlocksWithCopyButtons)/);

    const richMessages = [
      { ...finalMessage, id: 'msg_diff', meta: { isThinking: false, isDiff: true, diffText: 'diff' } },
      { ...finalMessage, id: 'msg_image', meta: { isThinking: false, images: ['image'] } },
      { ...finalMessage, id: 'msg_subagent', meta: { isThinking: false, subagents: [{}] } },
    ];
    for (const richMessage of richMessages) {
      const richRoot = renderAssistant(harness, richMessage, { mode: 'safe-shell', family: 'message-assistant' });
      expect(richRoot.dataset.safeShellFamily).toBeUndefined();
    }
    for (const family of ['message-code', 'message-diff', 'message-image', 'message-subagent', 'message-table', 'message-markdown']) {
      const laterRoot = renderAssistant(harness, { ...finalMessage, id: `msg_${family}` }, { mode: 'safe-shell', family });
      expect(laterRoot.dataset.safeShellFamily).toBe(family === 'message-markdown' ? 'message-markdown' : undefined);
    }
  });

  test('A1S.2-RED-2 bounds adversarial assistant markdown and only builds validated current-page delegated file links', () => {
    const huge = `${Array.from({ length: 100_000 }, (_, index) => `src/file-${index}.ts:${index + 1}:1`).join('\n')}\n${'line\n'.repeat(100_000)}${'x'.repeat(8 * 1024 * 1024)}`;
    const message = { id: 'msg_assistant_huge', role: 'assistant', text: huge, meta: { isThinking: false, textSegments: [huge] } };
    const harness = createHarness();
    const root = renderAssistant(harness, message, { mode: 'safe-shell', family: 'message-assistant' });
    const accepted = getSafeShellSpec({ mode: 'safe-shell', family: 'message-assistant', shape: {} }) as any;
    expect(descendantCount(root)).toBeLessThanOrEqual(accepted.budgets.collapsedDescendants);
    expect(root.children.length).toBeLessThanOrEqual(accepted.budgets.rootDirectChildren);
    expect({ descendants: descendantCount(root), directChildren: root.children.length }).toEqual({ descendants: 7, directChildren: 4 });
    control(root, 'open-full').click();
    expect(descendantCount(root)).toBeLessThanOrEqual(accepted.budgets.openDescendants);
    expect(root.children.length).toBeLessThanOrEqual(accepted.budgets.rootDirectChildren);
    expect({ descendants: descendantCount(root), directChildren: root.children.length }).toEqual({ descendants: 20, directChildren: 4 });
    const viewer = control(root, 'viewer');
    expect(viewer.textContent.length).toBeLessThanOrEqual(accepted.page.content.maxCodeUnits);
    expect(viewer.textContent.split('\n').length).toBeLessThanOrEqual(accepted.page.content.maxLines);
    const firstPage = control(root, 'page-status').textContent;
    control(root, 'next').click();
    expect(control(root, 'page-status').textContent).not.toBe(firstPage);
    const links = root.querySelectorAll('a');
    expect(links).toHaveLength(accepted.budgets.openDescendants - accepted.budgets.collapsedDescendants);
    expect(links.length).toBeLessThanOrEqual(accepted.budgets.openDescendants - accepted.budgets.collapsedDescendants);
    for (const link of links) expect(link.href).toMatch(/^ocfile:\/\/open\?path=/);
    expect(source).toContain('ocfile://open?path=');
    expect(source).toContain("type: 'openFileAtLocation'");
    expect(extractFunction('function renderSafeShellAssistantMessage(')).not.toContain("type: 'openFileAtLocation'");
  }, 30_000);

  test('A1S.2-RED-3 keeps canonical copy/search rows and stable search mounting independent of shell DOM', async () => {
    const harness = createHarness();
    const message = { id: 'msg_search', role: 'assistant', text: 'accumulated searchable text', meta: { isThinking: false, textSegments: ['canonical final searchable text'] } };
    harness.session.timeline = [message.id];
    harness.session.messagesById.set(message.id, message);
    const canonicalRows = () => harness.session.timeline.map((id: string) => {
      const item = harness.session.messagesById.get(id);
      return { id, role: item.role, text: harness.runtime.getLoadedSessionSearchText(item).slice(0, 2200) };
    });
    const normalRows = JSON.stringify(canonicalRows());
    const normalSmartInputs = JSON.stringify(canonicalRows().map((row: any) => ({ ...row, text: row.text.replace(/\s+/g, ' ').trim() })));
    const normal = renderAssistant(harness, message);
    const shell = renderAssistant(harness, message, { mode: 'safe-shell', family: 'message-assistant' });
    expect(JSON.stringify(canonicalRows())).toBe(normalRows);
    expect(JSON.stringify(canonicalRows().map((row: any) => ({ ...row, text: row.text.replace(/\s+/g, ' ').trim() })))).toBe(normalSmartInputs);
    expect(shell.dataset.renderUnitKey).toBe(normal.dataset.renderUnitKey);
    expect(extractFunction('function collectLoadedTextSearchKeys(')).not.toMatch(/safeShell|innerText|textContent/);
    expect(extractFunction('function collectSmartSearchMessages(')).not.toMatch(/safeShell|innerText|textContent/);
    expect(extractFunction('function mountChatWindowSearchKey(')).not.toMatch(/safeShell|presentationSelection/);
    control(shell, 'copy-full').click();
    await Promise.resolve();
    expect(harness.calls.clipboard).toEqual(['canonical final searchable text']);
    expect(harness.calls.assistantCopyText).toBeGreaterThan(0);
  });

  test('A1S.2-RED-4 preserves accessibility/async ownership and freezes stream, alias, measurement, and final owners', async () => {
    let resolveClipboard!: (value: boolean) => void;
    const harness = createHarness({ clipboard: new Promise<boolean>((resolve) => { resolveClipboard = resolve; }) });
    const message = { id: 'msg_async_assistant', role: 'assistant', text: 'one\ntwo', meta: { isThinking: false, textSegments: ['one\ntwo'] } };
    const shell = renderAssistant(harness, message, { mode: 'safe-shell', family: 'message-assistant' });
    const open = control(shell, 'open-full');
    expect(open.tagName).toBe('BUTTON');
    expect(open.getAttribute('aria-controls')).toBe(control(shell, 'viewer-region').id);
    expect(control(shell, 'status').getAttribute('role')).toBe('status');
    open.click();
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(harness.document.activeElement).toBe(control(shell, 'viewer'));
    control(shell, 'copy-full').click();
    harness.unmount();
    harness.deps.activeSessionId = 'session-b';
    resolveClipboard(true);
    await Promise.resolve();
    expect(shell.dataset.safeShellCopyState).toBeUndefined();

    for (const owner of ['tryPatchAssistantStreamingBubble', 'acknowledgeKeyedStreamPatch', 'getKeyedStreamStablePresentation', 'getKeyedUnitPresentation']) {
      expect(extractFunction(`function ${owner}(`)).not.toContain('renderSafeShellAssistantMessage');
    }
    expect(extractFunction('function renderSafeShellAssistantMessage(')).not.toMatch(/invalidateMeasurement|finalAssistantLock|rekeyKeyedChatPresentation|acknowledgeKeyedStreamPatch/);
  });

  test('A1S.2-SMOKE runs normal → shell/search/page/file/copy → stale remount and keeps stream/final normal', async () => {
    let resolveClipboard!: (value: boolean) => void;
    const harness = createHarness({ clipboard: new Promise<boolean>((resolve) => { resolveClipboard = resolve; }) });
    const contract = getSafeShellSpec({ mode: 'safe-shell', family: 'message-assistant', shape: {} }) as any;
    const canonical = `${'src/smoke.ts:2:3\n'.repeat(contract.budgets.openDescendants - contract.budgets.collapsedDescendants + 1)}${'x'.repeat(contract.page.content.maxCodeUnits + 1)}`;
    const message = { id: 'msg_assistant_smoke', role: 'assistant', text: 'accumulated', meta: { isThinking: false, textSegments: [canonical] } };
    harness.session.timeline = [message.id];
    renderAssistant(harness, message);
    expect(harness.calls.rich).toBe(1);
    const shell = renderAssistant(harness, message, { mode: 'safe-shell', family: 'message-assistant' });
    expect(harness.runtime.getLoadedSessionSearchText(message)).toBe('accumulated');
    control(shell, 'open-full').click();
    expect(shell.querySelectorAll('a')).toHaveLength(contract.budgets.openDescendants - contract.budgets.collapsedDescendants);
    control(shell, 'next').click();
    control(shell, 'copy-full').click();
    harness.unmount();
    renderAssistant(harness, message, { mode: 'safe-shell', family: 'message-assistant' });
    resolveClipboard(true);
    await Promise.resolve();
    expect(shell.dataset.safeShellCopyState).toBeUndefined();

    renderAssistant(harness, { id: 'msg_stream', role: 'assistant', text: 'stream', meta: { isThinking: true, textSegments: [] } });
    renderAssistant(harness, { id: 'msg_final', role: 'assistant', text: 'final', meta: { isThinking: false, textSegments: ['final'] } });
    expect(harness.calls.rich).toBe(3);
  });
});

describe('A1S.3 multiplexed tool/system/meta safe shell main contract', () => {
  const selection = { mode: 'safe-shell', family: 'message-tool-meta' };

  test('A1S.3-RED-1 routes real role/kind fixtures through one multiplexed adapter without subtype factories', () => {
    const adapter = extractFunction('function renderSafeShellToolMetaMessage(');
    const detached = extractFunction('function renderDetachedKeyedUnit(');
    expect(detached).toContain('renderSafeShellToolMetaMessage(session, unit, presentationSelection)');
    expect(detached.indexOf('renderSafeShellToolMetaMessage')).toBeLessThan(detached.indexOf('renderMessageElement(unit.value.message, renderedSet);'));
    expect(adapter).not.toMatch(/render(?:WebSearch|OpenCode|Tool|System)(?:Message|Element|Factory)/);

    const fixtures = [
      { id: 'msg_tool', role: 'tool', text: 'tool text', meta: {} },
      { id: 'msg_system', role: 'system', text: 'system text', meta: {} },
      { id: 'msg_unknown', role: 'assistant', text: 'unknown meta text', meta: { kind: 'unknown' } },
      { id: 'msg_web_search', role: 'assistant', text: 'search text', meta: { kind: 'web_search' } },
      { id: 'msg_opencode', role: 'assistant', text: 'OpenCode tool text', meta: { kind: 'opencode_tool_state' } },
    ];
    const harness = createHarness();
    for (const fixture of fixtures) {
      const normal = renderMessage(harness, fixture);
      expect(normal.dataset.safeShellFamily).toBeUndefined();
      const shell = renderMessage(harness, fixture, selection);
      expect(shell.dataset.safeShellFamily).toBe('message-tool-meta');
    }
    expect(harness.calls.rich).toBe(fixtures.length);
  });

  test('A1S.3-RED-2 bounds huge text/payload/status shapes and exposes only truthful labels and policy-allowed copy', async () => {
    const canonicalText = `${'line\n'.repeat(100_000)}${'x'.repeat(8 * 1024 * 1024)}`;
    const secret = `RAW-PAYLOAD-${'z'.repeat(8 * 1024 * 1024)}`;
    const statuses = Array.from({ length: 100_000 }, (_, index) => ({ status: `secret-status-${index}`, payload: secret }));
    const harness = createHarness();
    const assistant = {
      id: 'msg_meta_huge', role: 'assistant', text: canonicalText,
      meta: { kind: 'web_search', status: 'available-secret', statuses, payload: secret, input: secret, output: secret },
    };
    const root = renderMessage(harness, assistant, selection);
    const accepted = getSafeShellSpec({ mode: 'safe-shell', family: 'message-tool-meta', shape: {} }) as any;
    expect(descendantCount(root)).toBeLessThanOrEqual(accepted.budgets.collapsedDescendants);
    expect(root.children.length).toBeLessThanOrEqual(accepted.budgets.rootDirectChildren);
    expect({ descendants: descendantCount(root), directChildren: root.children.length }).toEqual({ descendants: 7, directChildren: 4 });
    expect(control(root, 'status').textContent).toMatch(/role assistant.*kind web_search.*status available.*100000 status entries/i);
    expect(control(root, 'status').textContent).not.toContain('available-secret');
    expect(rootText(root)).not.toContain('RAW-PAYLOAD');
    expect(rootText(root)).not.toContain('secret-status-');

    control(root, 'open-full').click();
    expect(descendantCount(root)).toBeLessThanOrEqual(accepted.budgets.openDescendants);
    expect({ descendants: descendantCount(root), directChildren: root.children.length }).toEqual({ descendants: 11, directChildren: 4 });
    expect(control(root, 'viewer').textContent.length).toBeLessThanOrEqual(accepted.page.content.maxCodeUnits);
    expect(control(root, 'viewer').textContent.split('\n').length).toBeLessThanOrEqual(accepted.page.content.maxLines);
    const firstPage = control(root, 'page-status').textContent;
    control(root, 'next').click();
    expect(control(root, 'page-status').textContent).not.toBe(firstPage);
    control(root, 'copy-full').click();
    await Promise.resolve();
    expect(harness.calls.clipboard).toEqual([canonicalText]);
    expect(harness.calls.clipboard[0]).not.toContain('RAW-PAYLOAD');

    for (const fixture of [
      { id: 'msg_tool_unknown', role: 'tool', text: 'tool', meta: {} },
      { id: 'msg_system_unknown', role: 'system', text: 'system', meta: { kind: 42, status: null } },
    ]) {
      const deniedCopy = renderMessage(harness, fixture, selection);
      expect(control(deniedCopy, 'status').textContent).toMatch(new RegExp(`role ${fixture.role}.*kind unknown.*status unavailable`, 'i'));
      expect(deniedCopy.querySelector('[data-safe-shell-role="copy-full"]')).toBeNull();
    }
  }, 30_000);

  test('A1S.3-RED-3 adds no protocol/action/logging and preserves omitted rich owners', () => {
    const adapter = extractFunction('function renderSafeShellToolMetaMessage(');
    expect(adapter).not.toMatch(/vscode\.postMessage|console\.|toolResult|question|provider|openFile|openDiff|payload\s*[.[]/i);
    for (const forbiddenRole of ['user']) {
      const harness = createHarness();
      const root = renderMessage(harness, { id: `msg_${forbiddenRole}`, role: forbiddenRole, text: 'normal', meta: { kind: 'web_search' } }, selection);
      expect(root.dataset.safeShellFamily).toBeUndefined();
      expect(harness.calls.rich).toBe(1);
    }
    const subagentHarness = createHarness();
    const subagent = renderMessage(subagentHarness, { id: 'msg_subagent_deny', role: 'assistant', text: 'normal', meta: { kind: 'web_search', subagents: [{}] } }, selection);
    expect(subagent.dataset.safeShellFamily).toBeUndefined();
    expect(subagentHarness.calls.rich).toBe(1);
  });

  test('A1S.3-RED-4 preserves canonical search and accessible generation-owned paging/focus cleanup', async () => {
    let resolveClipboard!: (value: boolean) => void;
    const harness = createHarness({ clipboard: new Promise<boolean>((resolve) => { resolveClipboard = resolve; }) });
    const message = { id: 'msg_meta_search', role: 'assistant', text: 'canonical searchable meta text', meta: { kind: 'unknown' } };
    harness.session.timeline = [message.id];
    harness.session.messagesById.set(message.id, message);
    const before = harness.runtime.getLoadedSessionSearchText(message);
    renderMessage(harness, message);
    const shell = renderMessage(harness, message, selection);
    expect(harness.runtime.getLoadedSessionSearchText(message)).toBe(before);
    expect(shell.dataset.renderUnitKey).toBe(message.id);
    expect(extractFunction('function collectLoadedTextSearchKeys(')).not.toMatch(/safeShell|innerText|textContent/);
    expect(extractFunction('function collectSmartSearchMessages(')).not.toMatch(/safeShell|innerText|textContent/);
    const open = control(shell, 'open-full');
    expect(open.tagName).toBe('BUTTON');
    expect(open.type).toBe('button');
    expect(open.getAttribute('aria-controls')).toBe(control(shell, 'viewer-region').id);
    expect(open.getAttribute('aria-expanded')).toBe('false');
    expect(control(shell, 'status').getAttribute('role')).toBe('status');
    open.click();
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(harness.document.activeElement).toBe(control(shell, 'viewer'));
    control(shell, 'copy-full').click();
    harness.unmount();
    harness.deps.activeSessionId = 'session-b';
    resolveClipboard(true);
    await Promise.resolve();
    expect(shell.dataset.safeShellCopyState).toBeUndefined();
  });

  test('A1S.3-SMOKE normal fixtures → explicit shell/page/copy → unknown → stale unmount → normal unchanged', async () => {
    const harness = createHarness();
    for (const message of [
      { id: 'smoke_tool', role: 'tool', text: 'tool normal', meta: {} },
      { id: 'smoke_system', role: 'system', text: 'system normal', meta: {} },
      { id: 'smoke_meta', role: 'assistant', text: 'meta normal', meta: { kind: 'web_search' } },
    ]) renderMessage(harness, message);
    expect(harness.calls.rich).toBe(3);
    const shell = renderMessage(harness, { id: 'smoke_shell', role: 'assistant', text: 'x'.repeat(10_000), meta: { kind: 'opencode_tool_state' } }, selection);
    control(shell, 'open-full').click();
    control(shell, 'next').click();
    control(shell, 'copy-full').click();
    await Promise.resolve();
    const unknown = renderMessage(harness, { id: 'smoke_unknown', role: 'system', text: 'unknown', meta: {} }, selection);
    expect(control(unknown, 'status').textContent).toMatch(/kind unknown/i);
    harness.unmount();
    renderAssistant(harness, { id: 'smoke_normal_assistant', role: 'assistant', text: 'normal unchanged', meta: { isThinking: false } });
    expect(harness.calls.rich).toBe(4);
  });
});

describe('A1S.4P canonical subagent search projection', () => {
  function createSearchRuntime() {
    return new Function('window', `
      ${extractFunction('function pickMode(')}
      ${extractFunction('function cleanSubagentTitle(')}
      ${extractFunction('function formatSubagentModel(')}
      ${extractFunction('function visitLoadedChatSearchChunks(')}
      ${extractFunction('function createLinearSearchMatcher(')}
      ${extractFunction('function collectBoundedSmartSearchText(')}
      return { visitLoadedChatSearchChunks, createLinearSearchMatcher, collectBoundedSmartSearchText };
    `)({ __ocFeatures: {
      createLinearSearchMatcher,
      collectBoundedSmartSearchText,
      pickSearchAgentMode,
      cleanSearchSubagentTitle,
      formatSearchSubagentModel,
      visitLoadedChatSearchChunks: visitSearchChunks,
    } }) as any;
  }

  test('A1S.4P-RED1 visits existing canonical values then exact safe subagent presentation values without hidden data', () => {
    const runtime = createSearchRuntime();
    const secret = 'DO-NOT-INDEX';
    const message = {
      id: 'parent-id', role: 'assistant', text: 'parent text',
      meta: {
        diffText: 'diff text', files: ['src/a.ts', { path: 'src/b.ts' }], todos: [{ content: 'todo text' }],
        payload: secret, input: secret, output: secret, hiddenMetadata: secret,
        subagents: [{
          id: 'agent-secret-id', agentSessionId: 'session-secret-id', state: 'failed', isDone: true,
          title: '  Build index (@agent-secret-id)  ', mode: '  explore  ', description: 'ignored description',
          model: 'model-id', providerId: 'provider-id', latestFullText: '  complete answer  ', latestText: 'preview',
          latestTool: '  grep  ', latestToolInput: '  safe query  ', payload: secret, input: secret, output: secret,
        }, {
          title: '', description: '  fallback mode  ', model: '', providerId: 'provider-only', latestFullText: '   ',
          latestText: '  fallback latest  ', latestTool: '', latestToolInput: '',
        }],
      },
    };
    const chunks: string[] = [];
    runtime.visitLoadedChatSearchChunks(null, { key: 'parent-key', kind: 'message', value: { message } }, (value: string) => chunks.push(value));
    expect(chunks).toEqual([
      'parent text', ' ', 'diff text', ' ', 'src/a.ts', ' ', 'src/b.ts', ' ', 'todo text',
      ' ', 'Build index', ' ', 'explore', ' ', 'model-id/provider-id', ' ', 'complete answer', ' ', 'grep', ' ', 'safe query',
      ' ', 'Subagent', ' ', 'fallback mode', ' ', 'provider-only', ' ', 'fallback latest',
    ]);
    const corpus = chunks.join(' ');
    expect(corpus).not.toMatch(/DO-NOT-INDEX|secret-id|failed|Task failed|[●○]/);

    const plain = { text: 'plain', meta: { diffText: 'diff', files: ['file'], todos: [{ text: 'todo' }] } };
    const plainChunks: string[] = [];
    runtime.visitLoadedChatSearchChunks(null, { key: 'plain-key', kind: 'message', value: { message: plain } }, (value: string) => plainChunks.push(value));
    expect(plainChunks).toEqual(['plain', ' ', 'diff', ' ', 'file', ' ', 'todo']);
  });

  test('A1S.4P-RED2 matches complete off-window and cross-chunk text linearly with bounded temporary lower-case allocations', () => {
    const runtime = createSearchRuntime();
    const agents = Array.from({ length: 100_000 }, (_, index) => ({ title: `agent-${index}` }));
    agents[99_998] = { title: 'cross' };
    const huge = `${'x'.repeat(8 * 1024 * 1024)}off-window`;
    const unit = { key: 'parent-key', kind: 'message', value: { message: { text: huge, meta: { subagents: agents } } } };

    const originalLower = String.prototype.toLowerCase;
    let lowerCalls = 0;
    let maxLowerInput = 0;
    String.prototype.toLowerCase = function patchedLower(this: string) {
      lowerCalls += 1;
      maxLowerInput = Math.max(maxLowerInput, String(this).length);
      return originalLower.call(this);
    };
    try {
      const offWindow = runtime.createLinearSearchMatcher('OFF-WINDOW');
      let visits = 0;
      runtime.visitLoadedChatSearchChunks(null, unit, (chunk: string) => { visits += 1; offWindow.visit(chunk); });
      expect(offWindow.matched()).toBe(true);
      expect(visits).toBe(200_001);

      const crossChunk = runtime.createLinearSearchMatcher('cross agent-99999');
      runtime.visitLoadedChatSearchChunks(null, unit, crossChunk.visit);
      expect(crossChunk.matched()).toBe(true);
      expect(lowerCalls).toBeLessThanOrEqual(205_000);
      expect(maxLowerInput).toBeLessThanOrEqual(4096);
    } finally {
      String.prototype.toLowerCase = originalLower;
    }
    const matcher = extractFunction('function createLinearSearchMatcher(');
    expect(matcher).not.toMatch(/join\s*\(|(?:^|[^.])concat\s*\(|\+=\s*chunk|toLowerCase\(\)\.includes/);
  }, 30_000);

  test('A1S.4P-RED3 fills the existing 2200 smart cap incrementally and returns only truthful parent-key rows', () => {
    const runtime = createSearchRuntime();
    const unit = {
      key: 'parent-key', kind: 'message', value: { message: {
        role: 'assistant', text: `${'a'.repeat(2195)} tail`,
        meta: { subagents: [{ title: 'first-safe-title', latestText: 'hidden-by-cap' }, { title: 'second-safe-title' }] },
      } },
    };
    let visits = 0;
    const text = runtime.collectBoundedSmartSearchText((visit: (chunk: string) => void) => {
      runtime.visitLoadedChatSearchChunks(null, unit, (chunk: string) => { visits += 1; return visit(chunk); });
    }, 2200);
    expect(text).toHaveLength(2200);
    expect(text).toBe(`${'a'.repeat(2195)} tail`);
    expect(text).not.toContain('hidden-by-cap');
    expect(visits).toBe(1);
    expect(runtime.collectBoundedSmartSearchText((visit: (chunk: string) => void) => visit('  plain\n\tmessage  '), 2200, true)).toBe('plain message');
    expect(extractFunction('function collectBoundedSmartSearchText(')).not.toMatch(/join\s*\(|(?:^|[^.])concat\s*\(|corpus/i);

    const rowsOwner = extractFunction('function getLoadedChatSearchRows(');
    expect(rowsOwner).toContain('id: unit.key');
    expect(rowsOwner).toContain('collectBoundedSmartSearchText');
    expect(rowsOwner).not.toMatch(/subagents\s*[:=]|agentSessionId|sessionId|taskId/);
  });
});

describe('A1S.4 explicit subagent safe shell main contract', () => {
  const selection = { mode: 'safe-shell', family: 'message-subagent' };

  test('A1S.4-RED-1 selects the explicit adapter before rich rendering and leaves the normal subagent owner untouched', () => {
    const adapter = extractFunction('function renderSafeShellSubagentMessage(');
    const detached = extractFunction('function renderDetachedKeyedUnit(');
    expect(detached).toContain('renderSafeShellSubagentMessage(session, unit, presentationSelection)');
    expect(detached.indexOf('renderSafeShellSubagentMessage')).toBeLessThan(detached.indexOf('renderMessageElement(unit.value.message, renderedSet);'));
    expect(adapter).not.toMatch(/subagents\.forEach|renderMarkdownInto|addSubagentTextToggle|subagentIntervals|renderIfActive|logRenderStorm/i);

    const harness = createHarness();
    const message = { id: 'subagent-parent', role: 'assistant', text: 'parent', meta: { isThinking: true, subagents: [{ title: 'one' }] } };
    const normal = renderMessage(harness, message);
    expect(normal.dataset.safeShellFamily).toBeUndefined();
    expect(harness.calls.rich).toBe(1);
    const shell = renderMessage(harness, message, selection);
    expect(shell.dataset.safeShellFamily).toBe('message-subagent');
    expect(harness.calls.rich).toBe(1);

    for (const rejected of [
      { id: 'no-agents', role: 'assistant', text: 'plain', meta: {} },
      { id: 'wrong-role', role: 'user', text: 'plain', meta: { subagents: [{}] } },
    ]) {
      expect(renderMessage(harness, rejected, selection).dataset.safeShellFamily).toBeUndefined();
    }
    expect(harness.calls.rich).toBe(3);
  });

  test('A1S.4-RED-2 bounds 100k agents and 8MiB detail while paging six agents and copying every represented field', async () => {
    const huge = `${'line\n'.repeat(100_000)}${'x'.repeat(8 * 1024 * 1024)}`;
    const agents = Array.from({ length: 100_000 }, (_, index) => ({
      title: `agent-${index}`,
      state: index % 3 === 0 ? 'running' : index % 3 === 1 ? 'done' : 'failed',
      latestText: index === 0 ? 'preview-zero' : `preview-${index}`,
      latestFullText: index === 0 ? huge : `full-${index}`,
      latestTool: `tool-${index}`,
      latestToolInput: `input-${index}`,
      parentSessionId: 'parent-session',
    }));
    const message = { id: 'huge-subagents', role: 'assistant', text: 'parent', meta: { isThinking: true, subagents: agents } };
    const harness = createHarness();
    const root = renderMessage(harness, message, selection);
    const accepted = getSafeShellSpec({ mode: 'safe-shell', family: 'message-subagent', shape: {} }) as any;
    expect(descendantCount(root)).toBeLessThanOrEqual(Math.min(48, accepted.budgets.collapsedDescendants));
    expect(root.children.length).toBeLessThanOrEqual(Math.min(5, accepted.budgets.rootDirectChildren));
    expect({ descendants: descendantCount(root), directChildren: root.children.length }).toEqual({ descendants: 13, directChildren: 5 });
    expect(control(root, 'status').textContent).toMatch(/100000 agents.*33334 running.*33333 done.*33333 failed/i);
    expect(rootText(root)).not.toContain('agent-6');

    control(root, 'open-full').click();
    expect(descendantCount(root)).toBeLessThanOrEqual(Math.min(64, accepted.budgets.openDescendants));
    expect(root.children.length).toBeLessThanOrEqual(Math.min(5, accepted.budgets.rootDirectChildren));
    expect({ descendants: descendantCount(root), directChildren: root.children.length }).toEqual({ descendants: 21, directChildren: 5 });
    expect(control(root, 'agent-page-status').textContent).toMatch(/agents 1–6 of 100000/i);
    expect(control(root, 'viewer').textContent.length).toBeLessThanOrEqual(accepted.page.content.maxCodeUnits);
    expect(control(root, 'viewer').textContent.split('\n').length).toBeLessThanOrEqual(accepted.page.content.maxLines);
    const detailPage = control(root, 'detail-page-status').textContent;
    control(root, 'detail-next').click();
    expect(control(root, 'detail-page-status').textContent).not.toBe(detailPage);
    control(root, 'agent-next').click();
    expect(control(root, 'agent-page-status').textContent).toMatch(/agents 7–12 of 100000/i);

    control(root, 'copy-full').click();
    await Promise.resolve();
    expect(harness.calls.clipboard).toHaveLength(1);
    expect(harness.calls.clipboard[0]).toContain('agent-0');
    expect(harness.calls.clipboard[0]).toContain(huge);
    expect(harness.calls.clipboard[0]).toContain('agent-99999');
    expect(harness.calls.clipboard[0]).toContain('tool-99999');
    expect(harness.calls.clipboard[0]).toContain('input-99999');
  }, 30_000);

  test('A1S.4-RED-3 preserves order, fallback/detail semantics, parent identity, and canonical search independently of shell DOM', () => {
    const malformed = { secret: 'never stringify this identity' };
    const message = {
      id: 'ordered-subagents', role: 'assistant', text: 'parent searchable', sessionId: 'message-parent',
      meta: { isThinking: true, subagents: [
        { title: 'First (@hidden)', mode: 'explore', model: 'm1', providerId: 'p1', state: 'finalizing', latestText: 'first preview', latestFullText: 'first full', latestTool: 'grep', latestToolInput: 'needle', parentSessionId: 'agent-parent' },
        { title: 'Second', description: 'fallback mode', state: 'cancelled', latestText: 'second fallback', latestFullText: '   ', agentSessionId: malformed, parentSessionId: malformed },
      ] },
    };
    const harness = createHarness();
    const searchChunks = () => {
      const chunks: string[] = [];
      harness.runtime.visitLoadedChatSearchChunks(harness.session, { key: message.id, kind: 'message', value: { message } }, (chunk: string) => chunks.push(chunk));
      return chunks;
    };
    const before = searchChunks();
    const root = renderMessage(harness, message, selection);
    expect(searchChunks()).toEqual(before);
    expect(rootText(root).indexOf('First')).toBeLessThan(rootText(root).indexOf('Second'));
    expect(rootText(root)).toContain('agent-parent');
    expect(rootText(root)).toContain('message-parent');
    expect(rootText(root)).not.toContain('never stringify');
    expect(control(root, 'status').textContent).toMatch(/1 finalizing.*1 cancelled/i);
    control(root, 'open-full').click();
    expect(control(root, 'viewer').textContent).toContain('first preview');
    expect(control(root, 'viewer').textContent).toContain('first full');
    expect(control(root, 'viewer').textContent).toContain('grep');
    expect(control(root, 'viewer').textContent).toContain('needle');
    control(root, 'agent-1').click();
    expect(control(root, 'viewer').textContent).toContain('second fallback');
    expect(control(root, 'viewer').textContent).not.toContain('first full');

    const accepted = getSafeShellSpec({ mode: 'safe-shell', family: 'message-subagent', shape: {} }) as any;
    for (let update = 0; update < 24; update += 1) {
      message.meta.subagents[0].state = update % 2 === 0 ? 'running' : 'done';
      const updated = renderMessage(harness, message, selection);
      expect(descendantCount(updated)).toBeLessThanOrEqual(Math.min(48, accepted.budgets.collapsedDescendants));
      expect(updated.children.length).toBeLessThanOrEqual(Math.min(5, accepted.budgets.rootDirectChildren));
      expect(control(updated, 'status').textContent).toContain(update % 2 === 0 ? '1 running' : '1 done');
    }
  });

  test('A1S.4-RED-4 uses native controls and generation-owned focus/copy cleanup with stale callbacks as no-ops', async () => {
    let resolveClipboard!: (value: boolean) => void;
    const harness = createHarness({ clipboard: new Promise<boolean>((resolve) => { resolveClipboard = resolve; }) });
    const message = { id: 'owned-subagents', role: 'assistant', meta: { isThinking: true, subagents: [{ title: 'one', latestText: 'preview', latestFullText: 'full' }] } };
    const shell = renderMessage(harness, message, selection);
    const open = control(shell, 'open-full');
    expect(open.tagName).toBe('BUTTON');
    expect(open.type).toBe('button');
    expect(open.getAttribute('aria-controls')).toBe(control(shell, 'viewer-region').id);
    expect(open.getAttribute('aria-expanded')).toBe('false');
    expect(control(shell, 'status').getAttribute('role')).toBe('status');
    open.click();
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(harness.document.activeElement).toBe(control(shell, 'viewer'));
    control(shell, 'copy-full').click();
    harness.unmount();
    harness.deps.activeSessionId = 'session-b';
    resolveClipboard(true);
    await Promise.resolve();
    expect(shell.dataset.safeShellCopyState).toBeUndefined();

    const remounted = renderMessage(harness, message, selection);
    control(remounted, 'open-full').click();
    control(remounted, 'close').click();
    expect(harness.document.activeElement).toBe(control(remounted, 'open-full'));
  });

  test('A1S.4-SMOKE normal → shell/agent/detail/copy/close → stale remount → normal remains rich', async () => {
    const harness = createHarness();
    const message = { id: 'smoke-subagents', role: 'assistant', meta: { isThinking: true, subagents: [
      { title: 'one', latestFullText: 'full one', latestTool: 'read', latestToolInput: 'a' },
      { title: 'two', latestText: 'full two', state: 'done' },
    ] } };
    renderMessage(harness, message);
    expect(harness.calls.rich).toBe(1);
    const shell = renderMessage(harness, message, selection);
    control(shell, 'open-full').click();
    control(shell, 'agent-1').click();
    control(shell, 'copy-full').click();
    await Promise.resolve();
    control(shell, 'close').click();
    harness.unmount();
    renderMessage(harness, message, selection);
    renderAssistant(harness, { id: 'ordinary-after-subagent', role: 'assistant', text: 'ordinary', meta: { isThinking: false } });
    expect(harness.calls.rich).toBe(2);
  });
});

describe('A1S.5 explicit change-list safe shell main contract', () => {
  const selection = { mode: 'safe-shell', family: 'change-list' };

  test('A1S.5-RED-1 bounds adversarial files at eight per page before delegating full rich rendering', () => {
    const hugePath = `${'huge/'.repeat(20_000)}README.md`;
    const files = Array.from({ length: 100_000 }, (_, index) => index === 0 ? hugePath : `src\\file-${index}.ts`);
    const message = {
      id: 'change-list-huge', role: 'system',
      meta: { kind: 'changeList', files, statsByPath: { [hugePath]: { additions: Number.MAX_SAFE_INTEGER, deletions: 9e200 } }, reverted: true, commitHead: 'head-a', commitBase: 'base-a' },
    };
    const owner = extractMessageRenderer();
    const detached = extractFunction('function renderDetachedKeyedUnit(');
    expect(detached).toContain('renderSafeShellChangeList(session, unit, presentationSelection)');
    expect(detached.indexOf('renderSafeShellChangeList')).toBeLessThan(detached.indexOf('renderMessageElement(unit.value.message, renderedSet);'));
    expect(owner).toContain('changeListRenderer.render(message)');
    expect(owner).not.toMatch(/for \(const rawPath of files\)/);

    const harness = createHarness();
    const normal = renderChangeList(harness, message);
    expect(normal.dataset.safeShellFamily).toBeUndefined();
    expect(harness.calls.rich).toBe(1);
    const root = renderChangeList(harness, message, selection);
    const accepted = getSafeShellSpec({ mode: 'safe-shell', family: 'change-list', shape: { itemCount: files.length } }) as any;
    expect(root.dataset.safeShellFamily).toBe('change-list');
    expect(harness.calls.rich).toBe(1);
    expect(descendantCount(root)).toBeLessThanOrEqual(Math.min(56, accepted.budgets.collapsedDescendants));
    expect(root.children.length).toBeLessThanOrEqual(Math.min(5, accepted.budgets.rootDirectChildren));
    expect({ descendants: descendantCount(root), directChildren: root.children.length }).toEqual({ descendants: 13, directChildren: 4 });
    expect(root.querySelectorAll('button').filter((button) => button.dataset.safeShellRole?.startsWith('file-'))).toHaveLength(8);
    expect(rootText(root)).not.toContain('file-8.ts');
    expect(control(root, 'status').textContent).toMatch(/100000 changed files.*reverted.*yes/i);

    control(root, 'open-full').click();
    expect(descendantCount(root)).toBeLessThanOrEqual(Math.min(72, accepted.budgets.openDescendants));
    expect(root.children.length).toBeLessThanOrEqual(Math.min(5, accepted.budgets.rootDirectChildren));
    expect({ descendants: descendantCount(root), directChildren: root.children.length }).toEqual({ descendants: 17, directChildren: 4 });
    expect(control(root, 'file-page-status').textContent).toMatch(/files 1–8 of 100000/i);
    control(root, 'next').click();
    expect(control(root, 'file-page-status').textContent).toMatch(/files 9–16 of 100000/i);
    expect(rootText(root)).not.toContain(hugePath);
    expect(extractFunction('function renderSafeShellChangeList(')).not.toMatch(/files\.(?:map|slice)|Array\.from\s*\(\s*files|for \(const rawPath of files\)/);
  }, 30_000);

  test('A1S.5-RED-2 discloses canonical stats/reverted state and preserves exact Markdown and Git-diff owner arguments', () => {
    const files = ['docs\\Guide.MD', 'src\\app.ts', 'missing.txt'];
    const message = {
      id: 'change-list-actions', role: 'system',
      meta: { kind: 'changeList', files, statsByPath: { 'docs/Guide.MD': { additions: 12, deletions: 3 }, 'src/app.ts': { additions: Number.MAX_SAFE_INTEGER, deletions: 9e200 } }, reverted: false, commitHead: 'head-123', commitBase: 'base-456' },
    };
    const harness = createHarness();
    const root = renderChangeList(harness, message, selection);
    expect(control(root, 'status').textContent).toMatch(/3 changed files.*reverted.*no/i);
    expect(control(root, 'file-0').getAttribute('aria-label')).toMatch(/docs\/Guide\.MD.*\+12.*-3/i);
    expect(control(root, 'file-2').getAttribute('aria-label')).toMatch(/missing\.txt.*stats unavailable/i);

    control(root, 'file-0').click();
    expect(harness.calls.posted).toEqual([{ type: 'openFileAtLocation', path: 'docs/Guide.MD', sessionId: 'session-a' }]);
    control(root, 'file-1').click();
    expect(harness.calls.gitDiff).toEqual([['src/app.ts', 'session-a', 'head-123', 'base-456']]);
    expect(rootText(root)).not.toContain('path:');
  });

  test('A1S.5-RED-3 uses native accessible controls, canonical search, focus return, and rejects stale actions', async () => {
    const message = { id: 'change-list-owned', role: 'system', text: 'canonical parent', meta: { kind: 'changeList', files: ['one.md', 'two.ts', 'three.ts', 'four.ts', 'five.ts', 'six.ts', 'seven.ts', 'eight.ts', 'nine.ts'], commitHead: 'h', commitBase: 'b' } };
    const harness = createHarness();
    const unit = { key: message.id, kind: 'change-list', value: { message } };
    const chunksBefore: string[] = [];
    harness.runtime.visitLoadedChatSearchChunks(harness.session, unit, (chunk: string) => chunksBefore.push(chunk));
    const shell = renderChangeList(harness, message, selection);
    const chunksAfter: string[] = [];
    harness.runtime.visitLoadedChatSearchChunks(harness.session, unit, (chunk: string) => chunksAfter.push(chunk));
    expect(chunksAfter).toEqual(chunksBefore);
    expect(chunksAfter).toContain('nine.ts');

    const open = control(shell, 'open-full');
    const firstFile = control(shell, 'file-0');
    for (const button of shell.querySelectorAll('button')) expect(button.type).toBe('button');
    expect(open.getAttribute('aria-controls')).toBe(control(shell, 'viewer-region').id);
    expect(open.getAttribute('aria-expanded')).toBe('false');
    expect(firstFile.getAttribute('aria-label')).toContain('one.md');
    expect(control(shell, 'status').getAttribute('role')).toBe('status');
    open.click();
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(harness.document.activeElement).toBe(control(shell, 'file-0'));
    control(shell, 'close').click();
    expect(harness.document.activeElement).toBe(control(shell, 'open-full'));

    firstFile.click();
    expect(harness.calls.posted).toHaveLength(0);
    const liveFile = control(shell, 'file-0');
    harness.deps.activeSessionId = 'session-b';
    liveFile.click();
    expect(harness.calls.posted).toHaveLength(0);
  });

  test('A1S.5-SMOKE normal card → shell/page/actions → reverted remount/stale rejection → basic send', () => {
    const message = { id: 'change-list-smoke', role: 'system', meta: { kind: 'changeList', files: ['one.md', 'two.ts', 'three.ts', 'four.ts', 'five.ts', 'six.ts', 'seven.ts', 'eight.ts', 'nine.md'], commitHead: 'head', commitBase: 'base' } };
    const harness = createHarness();
    renderChangeList(harness, message);
    expect(harness.calls.rich).toBe(1);
    const shell = renderChangeList(harness, message, selection);
    const staleMarkdown = control(shell, 'file-0');
    staleMarkdown.click();
    control(shell, 'file-1').click();
    expect(harness.calls.posted[0]).toMatchObject({ type: 'openFileAtLocation', path: 'one.md', sessionId: 'session-a' });
    expect(harness.calls.gitDiff[0]).toEqual(['two.ts', 'session-a', 'head', 'base']);
    control(shell, 'open-full').click();
    control(shell, 'next').click();
    control(shell, 'file-8').click();
    expect(harness.calls.posted[1]).toMatchObject({ path: 'nine.md' });

    const reverted = renderChangeList(harness, { ...message, meta: { ...message.meta, reverted: true } }, selection);
    expect(control(reverted, 'status').textContent).toMatch(/reverted: yes/i);
    staleMarkdown.click();
    expect(harness.calls.posted).toHaveLength(2);
    renderUser(harness, { id: 'ordinary-send-after-change-list', role: 'user', text: 'send', meta: {} });
    expect(harness.calls.rich).toBe(2);
  });
});

describe('A1S.6 explicit reverted-segment safe shell main contract', () => {
  const selection = { mode: 'safe-shell', family: 'segment' };

  test('A1S.6-RED-1 covers both real paths before expanded nested construction while omitted mode stays rich', () => {
    const detached = extractFunction('function renderDetachedKeyedUnit(');
    const messageOwner = extractMessageRenderer();
    const segmentOwner = extractFunction('function renderSegmentElement(');
    expect(detached).toContain('renderSafeShellSegment(session, unit, presentationSelection)');
    expect(detached.indexOf('renderSafeShellSegment')).toBeLessThan(detached.indexOf('renderSegmentElement(session, unit.value.segment'));
    expect(detached.indexOf('renderSafeShellSegment')).toBeLessThan(detached.indexOf('renderMessageElement(unit.value.message, renderedSet);'));
    expect(messageOwner).toContain('renderNestedMessageElement(msg)');
    expect(messageOwner).toContain('renderNestedInvalidSegmentElement(session, child)');
    expect(segmentOwner).toContain('renderAssistantMarkdown(content, msg)');

    const harness = createHarness();
    const direct = { id: 'seg:direct', noticeKey: 'notice-direct', memberMsgIds: ['msg-1'], memberIds: new Set(['msg-1']), state: 'restorable', anchorMsgId: 'msg-1', endMsgId: 'msg-1', isExpanded: true };
    renderSegment(harness, direct);
    expect(harness.calls.segmentRich).toBe(1);
    expect(renderSegment(harness, direct, selection).dataset.safeShellFamily).toBe('segment');
    expect(harness.calls.segmentRich).toBe(1);

    const placeholder = { id: 'system:undo-seg:notice-legacy', role: 'system', text: '', meta: { kind: 'undoSegmentPlaceholder', noticeKey: 'notice-legacy' } };
    harness.session.segmentsByNoticeKey = new Map([['notice-legacy', { noticeKey: 'notice-legacy', memberMsgIds: ['msg-1'], mergedInvalidSegments: [], restoreAllowed: true, collapsed: false }]]);
    renderMessage(harness, placeholder);
    expect(harness.calls.rich).toBe(1);
    expect(renderMessage(harness, placeholder, selection).dataset.safeShellFamily).toBe('segment');
    expect(harness.calls.rich).toBe(1);
    expect(extractFunction('function renderSafeShellSegment(')).not.toMatch(/renderNestedMessageElement|renderNestedInvalidSegmentElement|renderAssistantMarkdown|renderUserMarkdown|memberIds\.(?:map|slice)|invalidSegments\.(?:map|slice)|Array\.from/);
  });

  test('A1S.6-RED-2 bounds 100k members/missing/merged-invalid entries at six per page with truthful state and order', () => {
    const memberIds = Array.from({ length: 100_000 }, (_, index) => `msg-${index}`);
    const mergedInvalidSegments = Array.from({ length: 100_000 }, (_, index) => ({ noticeKey: `invalid-${index}`, memberMsgIds: [`invalid-msg-${index}`], restoreAllowed: index % 2 === 0 }));
    const segment = Object.freeze({
      noticeKey: 'notice-huge', memberMsgIds: Object.freeze(memberIds), mergedInvalidSegments: Object.freeze(mergedInvalidSegments),
      restoreAllowed: true, collapsed: false, anchorMsgId: 'msg-0', endMsgId: 'msg-99999',
    });
    const message = Object.freeze({ id: 'system:undo-seg:notice-huge', role: 'system', text: '', meta: Object.freeze({ kind: 'undoSegmentPlaceholder', noticeKey: 'notice-huge' }) });
    const harness = createHarness();
    harness.session.segmentsByNoticeKey = new Map([['notice-huge', segment]]);
    for (let index = 0; index < memberIds.length; index += 2) harness.session.messagesById.set(memberIds[index], { id: memberIds[index], role: 'assistant', text: `canonical-${index}` });
    const root = renderMessage(harness, message, selection);
    const accepted = getSafeShellSpec({ mode: 'safe-shell', family: 'segment', shape: { itemCount: 200_000 } }) as any;
    expect(descendantCount(root)).toBeLessThanOrEqual(Math.min(56, accepted.budgets.collapsedDescendants));
    expect(root.children.length).toBeLessThanOrEqual(Math.min(5, accepted.budgets.rootDirectChildren));
    expect({ descendants: descendantCount(root), directChildren: root.children.length }).toEqual({ descendants: 13, directChildren: 4 });
    expect(root.querySelectorAll('button').filter((button) => button.dataset.safeShellRole?.startsWith('entry-'))).toHaveLength(6);
    expect(control(root, 'status').textContent).toMatch(/50000 available of 100000 members.*100000 merged-invalid.*restore eligible.*yes/i);
    expect(control(root, 'entry-0').textContent).toMatch(/1.*msg-0.*available/i);
    expect(control(root, 'entry-1').textContent).toMatch(/2.*msg-1.*unavailable/i);
    expect(rootText(root)).not.toContain('msg-6');

    control(root, 'open-full').click();
    expect(descendantCount(root)).toBeLessThanOrEqual(Math.min(72, accepted.budgets.openDescendants));
    expect(root.children.length).toBeLessThanOrEqual(Math.min(5, accepted.budgets.rootDirectChildren));
    expect({ descendants: descendantCount(root), directChildren: root.children.length }).toEqual({ descendants: 17, directChildren: 4 });
    expect(control(root, 'entry-page-status').textContent).toMatch(/entries 1–6 of 200000/i);
    control(root, 'next').click();
    expect(control(root, 'entry-page-status').textContent).toMatch(/entries 7–12 of 200000/i);
    expect(rootText(root)).not.toContain('invalid-0');

    const directHarness = createHarness();
    directHarness.session.messagesById = harness.session.messagesById;
    const directRoot = renderSegment(directHarness, { id: 'seg:huge-direct', noticeKey: 'seg:huge-direct', memberMsgIds: memberIds, mergedInvalidSegments, state: 'restorable', anchorMsgId: 'msg-0', endMsgId: 'msg-99999', isExpanded: true }, selection);
    expect({ descendants: descendantCount(directRoot), directChildren: directRoot.children.length }).toEqual({ descendants: 13, directChildren: 4 });
    expect(control(directRoot, 'status').textContent).toMatch(/50000 available of 100000 members.*100000 merged-invalid.*restore eligible.*yes/i);
    control(directRoot, 'open-full').click();
    expect({ descendants: descendantCount(directRoot), directChildren: directRoot.children.length }).toEqual({ descendants: 17, directChildren: 4 });
    expect(directRoot.querySelectorAll('button').filter((button) => button.dataset.safeShellRole?.startsWith('entry-'))).toHaveLength(6);

    const orderedHarness = createHarness();
    const orderedSegment = { noticeKey: 'ordered', memberMsgIds: ['member-a', 'member-b', 'member-c'], mergedInvalidSegments: [{ noticeKey: 'invalid-a', memberMsgIds: ['child-a'] }, { noticeKey: 'invalid-b', memberMsgIds: [] }], restoreAllowed: false, collapsed: false };
    orderedHarness.session.segmentsByNoticeKey = new Map([['ordered', orderedSegment]]);
    const ordered = renderMessage(orderedHarness, { id: 'system:undo-seg:ordered', role: 'system', meta: { kind: 'undoSegmentPlaceholder', noticeKey: 'ordered' } }, selection);
    expect(control(ordered, 'entry-0').textContent).toContain('member-a');
    expect(control(ordered, 'entry-2').textContent).toContain('member-c');
    expect(control(ordered, 'entry-3').textContent).toContain('invalid-a');
    expect(control(ordered, 'entry-4').textContent).toContain('invalid-b');
  }, 30_000);

  test('A1S.6-RED-3 preserves exact path actions, disabled semantics, canonical search, ARIA/focus, and stale rejection', async () => {
    const harness = createHarness();
    const direct = Object.freeze({ id: 'seg:direct-owned', noticeKey: 'seg:notice-owned', memberMsgIds: Object.freeze(['msg-a', 'msg-b']), state: 'restorable', anchorMsgId: 'msg-a', endMsgId: 'msg-b', isExpanded: true });
    harness.session.messagesById.set('msg-a', { id: 'msg-a', text: 'first canonical' });
    harness.session.messagesById.set('msg-b', { id: 'msg-b', text: 'second canonical needle' });
    const directUnit = { key: 'direct-owned-key', sourceKey: 'direct-owned-source', kind: 'segment', value: { segment: direct } };
    const before: string[] = [];
    harness.runtime.visitLoadedChatSearchChunks(harness.session, directUnit, (chunk: string) => before.push(chunk));
    const directRoot = renderSegment(harness, { ...direct, renderKey: 'direct-owned-key' }, selection);
    const after: string[] = [];
    harness.runtime.visitLoadedChatSearchChunks(harness.session, directUnit, (chunk: string) => after.push(chunk));
    expect(after).toEqual(before);
    expect(after).toContain('second canonical needle');
    control(directRoot, 'restore').click();
    expect(harness.calls.posted.find((item) => item.type === 'restoreSegment')).toEqual({
      type: 'restoreSegment', sessionId: 'session-a', operationId: 'op-safe-shell-test', noticeKey: 'notice-owned', anchorMsgId: 'msg-a', endMsgId: 'msg-b',
    });
    control(directRoot, 'toggle').click();
    expect(harness.calls.segmentToggle).toEqual([['session-a', 'seg:direct-owned']]);

    const legacySegment = Object.freeze({ noticeKey: 'legacy-owned', memberMsgIds: Object.freeze(['msg-a']), mergedInvalidSegments: Object.freeze([]), restoreAllowed: true, collapsed: false });
    harness.session.segmentsByNoticeKey = new Map([['legacy-owned', legacySegment]]);
    const placeholder = { id: 'system:undo-seg:legacy-owned', role: 'system', meta: { kind: 'undoSegmentPlaceholder', noticeKey: 'legacy-owned' } };
    const legacyRoot = renderMessage(harness, placeholder, selection);
    control(legacyRoot, 'restore').click();
    control(legacyRoot, 'toggle').click();
    expect(harness.calls.segmentRestore).toEqual([['session-a', 'legacy-owned']]);
    expect(harness.calls.segmentToggle).toEqual([['session-a', 'seg:direct-owned'], ['session-a', 'legacy-owned']]);
    for (const button of legacyRoot.querySelectorAll('button')) expect(button.type).toBe('button');
    const open = control(legacyRoot, 'open-full');
    expect(open.getAttribute('aria-controls')).toBe(control(legacyRoot, 'viewer-region').id);
    expect(open.getAttribute('aria-expanded')).toBe('false');
    expect(control(legacyRoot, 'status').getAttribute('role')).toBe('status');
    open.click();
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(harness.document.activeElement).toBe(control(legacyRoot, 'entry-0'));
    control(legacyRoot, 'close').click();
    expect(harness.document.activeElement).toBe(control(legacyRoot, 'open-full'));

    const staleRestore = control(legacyRoot, 'restore');
    renderMessage(harness, placeholder, selection);
    staleRestore.click();
    expect(harness.calls.segmentRestore).toHaveLength(1);
    harness.deps.activeSessionId = 'session-b';
    control(harness.mounted!, 'restore').click();
    expect(harness.calls.segmentRestore).toHaveLength(1);

    for (const denied of [
      { noticeKey: 'frozen', memberMsgIds: [], state: 'frozen', anchorMsgId: 'msg-a' },
      { noticeKey: 'discarded', memberMsgIds: [], state: 'discarded', anchorMsgId: 'msg-a' },
      { noticeKey: 'no-anchor', memberMsgIds: [], state: 'restorable' },
    ]) expect(control(renderSegment(createHarness(), denied, selection), 'restore').disabled).toBe(true);
  });

  test('A1S.6-SMOKE normal/restorable → shell/page/actions → frozen remount/stale rejection → ordinary send', () => {
    const harness = createHarness();
    const segment = { id: 'seg:smoke', noticeKey: 'seg:smoke-notice', memberMsgIds: ['msg-0', 'msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5', 'msg-6'], state: 'restorable', anchorMsgId: 'msg-0', endMsgId: 'msg-6', isExpanded: true };
    for (const id of segment.memberMsgIds) harness.session.messagesById.set(id, { id, text: id });
    renderSegment(harness, segment);
    expect(harness.calls.segmentRich).toBe(1);
    const shell = renderSegment(harness, segment, selection);
    const staleRestore = control(shell, 'restore');
    control(shell, 'open-full').click();
    control(shell, 'next').click();
    control(shell, 'restore').click();
    control(shell, 'toggle').click();
    expect(harness.calls.posted.filter((item) => item.type === 'restoreSegment')).toHaveLength(1);
    expect(harness.calls.segmentToggle).toEqual([['session-a', 'seg:smoke']]);

    const frozen = renderSegment(harness, { ...segment, state: 'frozen' }, selection);
    expect(control(frozen, 'restore').disabled).toBe(true);
    expect(control(frozen, 'status').textContent).toMatch(/state frozen.*restore eligible: no/i);
    staleRestore.click();
    expect(harness.calls.posted.filter((item) => item.type === 'restoreSegment')).toHaveLength(1);
    renderUser(harness, { id: 'ordinary-send-after-segment', role: 'user', text: 'send', meta: {} });
    expect(harness.calls.rich).toBe(1);
  });
});

describe('A1S.7 explicit conflict safe shell main contract', () => {
  const selection = { mode: 'safe-shell', family: 'conflict' };
  const owner = {
    sessionId: 'session-a', operationId: 'operation-a', conflictId: 'conflict-a', kind: 'restore', source: 'undo',
    startMessageId: 'msg-start', endMessageId: 'msg-end', noticeKey: 'notice-a',
  };

  test('A1S.7-RED-1 bounds 100k conflicts and 8MiB diffs at six conflicts plus one bounded diff page and one keyed root', () => {
    const detached = extractFunction('function renderDetachedKeyedUnit(');
    expect(detached).toContain('presentationSelection');
    expect(detached).toContain('renderConflictCard(unit.value, { detached: true, presentationSelection, unitKey: unit.key })');
    expect(source).toContain('function renderSafeShellConflictCard(');

    const hugeDiff = `${'line\n'.repeat(100_000)}${'x'.repeat(8 * 1024 * 1024)}`;
    const conflicts = Array.from({ length: 100_000 }, (_, index) => ({
      path: `src/file-${index}.ts`, expectedExists: index % 2 === 0, currentExists: index % 3 === 0,
      diffText: index === 0 ? hugeDiff : `diff-${index}`,
    }));
    const harness = createHarness();
    const root = renderConflict(harness, { type: 'conflictCard', ...owner, conflicts }, selection);
    const accepted = getSafeShellSpec({ mode: 'safe-shell', family: 'conflict', shape: { itemCount: conflicts.length } }) as any;
    expect(root.dataset.safeShellFamily).toBe('conflict');
    expect(harness.chat.querySelectorAll('[data-render-unit-key]')).toHaveLength(1);
    expect(descendantCount(root)).toBeLessThanOrEqual(Math.min(64, accepted.budgets.collapsedDescendants));
    expect(root.children.length).toBeLessThanOrEqual(Math.min(5, accepted.budgets.rootDirectChildren));
    expect({ descendants: descendantCount(root), directChildren: root.children.length }).toEqual({ descendants: 16, directChildren: 5 });
    expect(root.querySelectorAll('button').filter((button) => button.dataset.safeShellRole?.startsWith('conflict-'))).toHaveLength(6);
    expect(rootText(root)).not.toContain('file-6.ts');

    control(root, 'open-full').click();
    expect(descendantCount(root)).toBeLessThanOrEqual(Math.min(80, accepted.budgets.openDescendants));
    expect(root.children.length).toBeLessThanOrEqual(Math.min(5, accepted.budgets.rootDirectChildren));
    expect({ descendants: descendantCount(root), directChildren: root.children.length }).toEqual({ descendants: 24, directChildren: 5 });
    expect(control(root, 'conflict-page-status').textContent).toMatch(/conflicts 1–6 of 100000/i);
    const viewer = control(root, 'viewer');
    expect(viewer.textContent.length).toBeLessThanOrEqual(accepted.page.content.maxCodeUnits);
    expect(viewer.textContent.split('\n').length).toBeLessThanOrEqual(accepted.page.content.maxLines);
    const firstDiffPage = control(root, 'diff-page-status').textContent;
    control(root, 'diff-next').click();
    expect(control(root, 'diff-page-status').textContent).not.toBe(firstDiffPage);
    control(root, 'next').click();
    expect(control(root, 'conflict-page-status').textContent).toMatch(/conflicts 7–12 of 100000/i);
  }, 30_000);

  test('A1S.7-RED-2 preserves per-file Git diff and exact owner-qualified decisions while rejecting stale generations', () => {
    expect(source).toContain('function renderSafeShellConflictCard(');
    const payload = { type: 'conflictCard', ...owner, conflicts: [
      { path: 'src/one.ts', expectedExists: true, currentExists: false, diffText: 'one diff' },
      { path: 'src/two.ts', expectedExists: false, currentExists: true, diffText: 'two diff' },
    ] };
    const harness = createHarness();
    const first = renderConflict(harness, payload, selection);
    control(first, 'conflict-1').click();
    control(first, 'open-diff').click();
    expect(harness.calls.gitDiff).toEqual([['src/two.ts', 'session-a']]);

    const staleSkip = control(first, 'skip');
    const second = renderConflict(harness, payload, selection);
    staleSkip.click();
    expect(harness.calls.posted.filter((message) => message.type === 'conflictDecision')).toHaveLength(0);
    control(second, 'skip').click();
    expect(harness.calls.posted.filter((message) => message.type === 'conflictDecision')).toEqual([{
      type: 'conflictDecision', decision: 'skip', ...owner,
    }]);

    const overrideHarness = createHarness();
    const override = renderConflict(overrideHarness, payload, selection);
    control(override, 'override').click();
    expect(overrideHarness.calls.posted.filter((message) => message.type === 'conflictDecision')).toEqual([{
      type: 'conflictDecision', decision: 'override', ...owner,
    }]);
  });

  test('A1S.7-RED-3 keeps truthful state, native ARIA/focus, canonical search/copy, and normal-owner cleanup', async () => {
    expect(source).toContain('function renderSafeShellConflictCard(');
    const payload = { type: 'conflictCard', ...owner, conflicts: [
      { path: 'src/known.ts', expectedExists: true, currentExists: false, diffText: 'canonical full diff' },
      { path: 'src/unknown.ts', diffText: 'other diff' },
    ] };
    const beforeHash = JSON.stringify(payload);
    const harness = createHarness();
    const unit = { key: 'conflict:session-a:conflict-a', kind: 'conflict', value: payload };
    const searchBefore: string[] = [];
    harness.runtime.visitLoadedChatSearchChunks(harness.session, unit, (chunk: string) => searchBefore.push(chunk));
    const shell = renderConflict(harness, payload, selection);
    const searchAfter: string[] = [];
    harness.runtime.visitLoadedChatSearchChunks(harness.session, unit, (chunk: string) => searchAfter.push(chunk));
    expect(searchAfter).toEqual(searchBefore);
    expect(control(shell, 'conflict-0').getAttribute('aria-label')).toMatch(/expected exists.*current missing/i);
    expect(control(shell, 'conflict-1').getAttribute('aria-label')).toMatch(/expected unavailable.*current unavailable/i);
    for (const button of shell.querySelectorAll('button')) expect(button.type).toBe('button');
    const open = control(shell, 'open-full');
    expect(open.getAttribute('aria-controls')).toBe(control(shell, 'viewer-region').id);
    expect(open.getAttribute('aria-expanded')).toBe('false');
    expect(control(shell, 'status').getAttribute('role')).toBe('status');
    open.click();
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(harness.document.activeElement).toBe(control(shell, 'viewer'));
    control(shell, 'copy-full').click();
    await Promise.resolve();
    expect(harness.calls.clipboard).toEqual(['canonical full diff']);
    control(shell, 'close').click();
    expect(harness.document.activeElement).toBe(control(shell, 'open-full'));
    control(shell, 'override').click();
    expect(harness.runtime.getConflictLifecycle()).toEqual({ conflictCardEl: null, lastConflictPayload: null });
    expect(shell.isConnected).toBe(false);
    expect(JSON.stringify(payload)).toBe(beforeHash);

    const normalHarness = createHarness();
    const normal = renderConflict(normalHarness, payload);
    expect(normal.dataset.safeShellFamily).toBeUndefined();
    expect(normal.querySelectorAll('button')).toHaveLength(2);
    normal.querySelectorAll('button')[0].click();
    expect(normalHarness.runtime.getConflictLifecycle()).toEqual({ conflictCardEl: null, lastConflictPayload: null });
    expect(normal.isConnected).toBe(false);
    const conflictOwner = source.slice(source.indexOf('function renderConflictCard('), source.indexOf('\nfunction commitCurrentQuestionAnswers('));
    expect(conflictOwner).toContain('for (const item of payload.conflicts)');
    expect(extractFunction('function renderSafeShellConflictCard(')).not.toMatch(/renderMarkdownInto|renderAssistantMarkdown|renderMessageElement/);
  });

  test('A1S.7-SMOKE normal detached → shell/page/diff/decision → different owner remount rejects stale action and basic send stays rich', () => {
    const firstPayload = { type: 'conflictCard', ...owner, conflicts: Array.from({ length: 7 }, (_, index) => ({
      path: `src/smoke-${index}.ts`, expectedExists: true, currentExists: false, diffText: `diff-${index}`,
    })) };
    const harness = createHarness();
    const normal = renderConflict(harness, firstPayload);
    expect(normal.dataset.safeShellFamily).toBeUndefined();
    const shell = renderConflict(harness, firstPayload, selection);
    const staleOverride = control(shell, 'override');
    control(shell, 'open-full').click();
    control(shell, 'next').click();
    control(shell, 'open-diff').click();
    expect(harness.calls.gitDiff).toEqual([['src/smoke-6.ts', 'session-a']]);

    const nextPayload = { ...firstPayload, operationId: 'operation-b', conflictId: 'conflict-b', noticeKey: 'notice-b' };
    const next = renderConflict(harness, nextPayload, selection);
    staleOverride.click();
    expect(harness.calls.posted.filter((message) => message.type === 'conflictDecision')).toHaveLength(0);
    control(next, 'skip').click();
    expect(harness.calls.posted.filter((message) => message.type === 'conflictDecision')[0]).toMatchObject({
      decision: 'skip', operationId: 'operation-b', conflictId: 'conflict-b', noticeKey: 'notice-b',
    });
    renderUser(harness, { id: 'ordinary-send-after-conflict', role: 'user', text: 'send', meta: {} });
    expect(harness.calls.rich).toBe(1);
  });
});

describe('A1S.9 explicit dormant message-code safe shell main contract', () => {
  const selection = { mode: 'safe-shell', family: 'message-code' };

  test('A1S.9-RED-1 routes fenced assistant markdown before rich markdown and copies the exact canonical block without fabricating Edit', async () => {
    const detached = extractFunction('function renderDetachedKeyedUnit(');
    expect(detached).toContain('renderSafeShellCodeMessage(session, unit, presentationSelection)');
    expect(detached.indexOf('renderSafeShellCodeMessage')).toBeLessThan(detached.indexOf('renderMessageElement(unit.value.message, renderedSet);'));
    expect(source.indexOf('function renderSafeShellCodeMessage(')).toBeLessThan(source.indexOf('function renderAssistantMarkdown('));

    const harness = createHarness();
    const canonical = 'const value = `<tag>`;\nreturn value;\n';
    const message = { id: 'code-owner', role: 'assistant', text: `### Editable code\n\n\`\`\`typescript extra malformed label\n${canonical}\`\`\``, meta: { isThinking: false } };
    renderAssistant(harness, message);
    expect(harness.calls.rich).toBe(1);
    const shell = renderAssistant(harness, message, selection);
    expect(harness.calls.rich).toBe(1);
    expect(shell.dataset.safeShellFamily).toBe('message-code');
    expect(control(shell, 'status').textContent).toMatch(/1 code block.*typescript.*block 1 of 1.*page 1 of 1/i);
    expect(rootText(shell)).not.toMatch(/\bEdit\b/);
    control(shell, 'copy-full').click();
    await Promise.resolve();
    expect(harness.calls.clipboard).toEqual([canonical]);
    expect(extractFunction('function renderSafeShellCodeMessage(')).not.toMatch(/renderAssistantMarkdown|renderMarkdownInto|enhanceCodeBlocksWithCopyButtons/);
  });

  test('A1S.9-RED-2 streams 100k fences, 1M lines, 8MiB lines, and malformed fences within budgets while traversing every block/page', () => {
    const tinyBlocks = Array.from({ length: 100_000 }, (_, index) => `~~~lang-${index}\nb${index}\n~~~`).join('\n');
    const huge = `${'line\n'.repeat(1_000_000)}${'x'.repeat(8 * 1024 * 1024)}`;
    const message = { id: 'code-huge', role: 'assistant', text: `\`\`bad-label\nignored\n\`\`\n\`\`\`javascript bad label\n${huge}\n\`\`\`\n${tinyBlocks}`, meta: { isThinking: false } };
    const harness = createHarness();
    const root = renderAssistant(harness, message, selection);
    const accepted = getSafeShellSpec({ mode: 'safe-shell', family: 'message-code', shape: { blockCount: 100_001 } }) as any;
    expect(descendantCount(root)).toBeLessThanOrEqual(Math.min(40, accepted.budgets.collapsedDescendants));
    expect(root.children.length).toBeLessThanOrEqual(Math.min(5, accepted.budgets.rootDirectChildren));
    expect({ descendants: descendantCount(root), directChildren: root.children.length }).toEqual({ descendants: 7, directChildren: 4 });
    control(root, 'open-full').click();
    expect(descendantCount(root)).toBeLessThanOrEqual(Math.min(52, accepted.budgets.openDescendants));
    expect(root.children.length).toBeLessThanOrEqual(Math.min(5, accepted.budgets.rootDirectChildren));
    expect({ descendants: descendantCount(root), directChildren: root.children.length }).toEqual({ descendants: 12, directChildren: 4 });
    expect(control(root, 'viewer').textContent.length).toBeLessThanOrEqual(accepted.page.content.maxCodeUnits);
    expect(control(root, 'viewer').textContent.split('\n').length).toBeLessThanOrEqual(accepted.page.content.maxLines);
    expect(control(root, 'block-status').textContent).toMatch(/block 1 of 100001.*javascript/i);
    const firstHugePage = control(root, 'page-status').textContent;
    control(root, 'next').click();
    expect(control(root, 'page-status').textContent).not.toBe(firstHugePage);
    expect(extractFunction('function scanSafeShellCodePage(')).not.toMatch(/\.matchAll\(|Array\.from|\.split\(|blocks\s*=\s*\[/);
  }, 30_000);

  test('A1S.9-RED-3 uses native ARIA/focus, rejects stale clipboard/timer/session/generation/root work, and leaves omitted markdown/highlight/copy unchanged', async () => {
    let resolveClipboard!: (value: boolean) => void;
    const harness = createHarness({ clipboard: new Promise<boolean>((resolve) => { resolveClipboard = resolve; }) });
    const message = { id: 'code-stale', role: 'assistant', text: '```js\none\ntwo\n```', meta: { isThinking: false } };
    const normal = renderAssistant(harness, message);
    const shell = renderAssistant(harness, message, selection);
    expect(shell.dataset.renderUnitKey).toBe(normal.dataset.renderUnitKey);
    expect(harness.calls.rich).toBe(1);
    const open = control(shell, 'open-full');
    expect(open.tagName).toBe('BUTTON');
    expect(open.type).toBe('button');
    expect(open.getAttribute('aria-controls')).toBe(control(shell, 'viewer-region').id);
    expect(open.getAttribute('aria-expanded')).toBe('false');
    expect(control(shell, 'status').getAttribute('role')).toBe('status');
    open.click();
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(harness.document.activeElement).toBe(control(shell, 'viewer'));
    control(shell, 'copy-full').click();
    harness.unmount();
    harness.deps.activeSessionId = 'session-b';
    resolveClipboard(true);
    await Promise.resolve();
    expect(shell.dataset.safeShellCopyState).toBeUndefined();

    harness.deps.activeSessionId = 'session-a';
    const remounted = renderAssistant(harness, message, selection);
    control(remounted, 'open-full').click();
    control(remounted, 'close').click();
    expect(harness.document.activeElement).toBe(control(remounted, 'open-full'));
    renderAssistant(harness, { id: 'ordinary-markdown', role: 'assistant', text: '**ordinary**', meta: { isThinking: false } });
    expect(harness.calls.rich).toBe(2);
    expect(source).not.toMatch(/function (?:create|render|open)[A-Za-z]*(?:EditableCode|CodeEditor)[A-Za-z]*\(/);
  });
});

describe('A1S.10 explicit dormant message-diff safe shell main contract', () => {
  const selection = { mode: 'safe-shell', family: 'message-diff' };

  test('A1S.10-RED-1 routes both real diff branches before pre/code construction without fabricating a Git owner', async () => {
    const detached = extractFunction('function renderDetachedKeyedUnit(');
    const topLevelOwner = extractMessageRenderer();
    const nestedOwner = extractFunction('function renderNestedMessageElement(');
    expect(detached).toContain('renderSafeShellDiffMessage(session, unit, presentationSelection)');
    expect(detached.indexOf('renderSafeShellDiffMessage')).toBeLessThan(detached.indexOf('renderMessageElement(unit.value.message, renderedSet'));
    expect(topLevelOwner).toContain('renderNestedMessageElement(msg)');
    expect(nestedOwner).toContain('renderSafeShellDiffMessage(getSessionOrNull(activeSessionId), { key: keyedUnitKeyOverride, value: { message } }, keyedPresentationSelectionOverride)');
    expect(nestedOwner.indexOf('renderSafeShellDiffMessage')).toBeLessThan(nestedOwner.indexOf("document.createElement('pre')"));

    const harness = createHarness();
    const message = { id: 'diff-owner', role: 'system', text: 'fallback text', meta: { isDiff: true, diffText: '@@ -1 +1 @@\n-old\n+new\n' } };
    renderMessage(harness, message);
    expect(harness.calls.rich).toBe(1);
    const shell = renderMessage(harness, message, selection);
    expect(harness.calls.rich).toBe(1);
    expect(shell.dataset.safeShellFamily).toBe('message-diff');
    control(shell, 'copy-full').click();
    await Promise.resolve();
    expect(harness.calls.clipboard).toEqual([message.meta.diffText]);
    expect(harness.calls.gitDiff).toEqual([]);
    const nested = harness.runtime.renderNestedDiff(message, selection, 'nested-diff-owner');
    nested.dataset.renderUnitKey = 'nested-diff-owner';
    harness.mount(nested);
    expect(nested.dataset.safeShellFamily).toBe('message-diff');
    expect(extractFunction('function renderSafeShellDiffMessage(')).not.toMatch(/postOpenGitDiff|openGitDiff|commitHead|commitBase|renderMarkdownInto/);
  });

  test('A1S.10-RED-2 streams 8MiB lines and 1M lines/hunks with truthful bounded pages, including empty and malformed input', () => {
    const canonical = `${'@@ malformed\n'.repeat(1_000_000)}${'x'.repeat(8 * 1024 * 1024)}`;
    const harness = createHarness();
    const root = renderMessage(harness, { id: 'diff-huge', role: 'system', text: 'not canonical', meta: { isDiff: true, diffText: canonical } }, selection);
    const accepted = getSafeShellSpec({ mode: 'safe-shell', family: 'message-diff', shape: { codeUnitCount: canonical.length, lineCount: 1_000_001 } }) as any;
    expect(descendantCount(root)).toBeLessThanOrEqual(Math.min(40, accepted.budgets.collapsedDescendants));
    expect(root.children.length).toBeLessThanOrEqual(Math.min(5, accepted.budgets.rootDirectChildren));
    expect({ descendants: descendantCount(root), directChildren: root.children.length }).toEqual({ descendants: 7, directChildren: 4 });
    expect(control(root, 'status').textContent).toMatch(/1000000 hunks.*1000001 logical lines.*page 1 of/i);
    control(root, 'open-full').click();
    expect(descendantCount(root)).toBeLessThanOrEqual(Math.min(52, accepted.budgets.openDescendants));
    expect(root.children.length).toBeLessThanOrEqual(Math.min(5, accepted.budgets.rootDirectChildren));
    expect({ descendants: descendantCount(root), directChildren: root.children.length }).toEqual({ descendants: 11, directChildren: 4 });
    expect(control(root, 'viewer').textContent.length).toBeLessThanOrEqual(8192);
    expect(control(root, 'viewer').textContent.split('\n').length).toBeLessThanOrEqual(40);
    const first = control(root, 'page-status').textContent;
    control(root, 'next').click();
    expect(control(root, 'page-status').textContent).not.toBe(first);

    for (const [id, text] of [['empty', ''], ['malformed', '@@\n+\n-\n']]) {
      const small = renderMessage(createHarness(), { id: `diff-${id}`, role: 'system', text, meta: { isDiff: true } }, selection);
      expect(descendantCount(small)).toBeLessThanOrEqual(40);
      expect(small.children.length).toBeLessThanOrEqual(5);
      control(small, 'open-full').click();
      expect(descendantCount(small)).toBeLessThanOrEqual(52);
      expect(control(small, 'viewer').textContent.length).toBeLessThanOrEqual(8192);
      expect(control(small, 'viewer').textContent.split('\n').length).toBeLessThanOrEqual(40);
    }
    expect(extractFunction('function scanSafeShellDiffPage(')).not.toMatch(/\.split\(|\.matchAll\(|Array\.from|\.map\(|\.slice\(/);
  }, 30_000);

  test('A1S.10-RED-3 preserves canonical search equality and native focus while rejecting stale generation/session/clipboard work', async () => {
    let resolveClipboard!: (value: boolean) => void;
    const harness = createHarness({ clipboard: new Promise<boolean>((resolve) => { resolveClipboard = resolve; }) });
    const message = { id: 'diff-stale', role: 'system', text: 'fallback-search', meta: { isDiff: true, diffText: 'canonical-search\n+exact trailing  \n' } };
    const unit = { key: message.id, kind: 'message', value: { message } };
    const before: string[] = [];
    harness.runtime.visitLoadedChatSearchChunks(harness.session, unit, (chunk: string) => before.push(chunk));
    expect(before).toEqual([message.meta.diffText]);
    expect(harness.runtime.getLoadedSessionSearchText(message)).toBe(message.meta.diffText);
    const shell = renderMessage(harness, message, selection);
    const after: string[] = [];
    harness.runtime.visitLoadedChatSearchChunks(harness.session, unit, (chunk: string) => after.push(chunk));
    expect(after).toEqual(before);
    const open = control(shell, 'open-full');
    expect(open.tagName).toBe('BUTTON');
    expect(open.type).toBe('button');
    expect(open.getAttribute('aria-controls')).toBe(control(shell, 'viewer-region').id);
    expect(open.getAttribute('aria-expanded')).toBe('false');
    expect(control(shell, 'status').getAttribute('role')).toBe('status');
    open.click();
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(harness.document.activeElement).toBe(control(shell, 'viewer'));
    control(shell, 'copy-full').click();
    const replacement = renderMessage(harness, message, selection);
    harness.deps.activeSessionId = 'session-b';
    resolveClipboard(true);
    await Promise.resolve();
    expect(shell.dataset.safeShellCopyState).toBeUndefined();
    expect(replacement.dataset.safeShellCopyState).toBeUndefined();
    harness.deps.activeSessionId = 'session-a';
    control(replacement, 'open-full').click();
    control(replacement, 'close').click();
    expect(harness.document.activeElement).toBe(control(replacement, 'open-full'));
  });
});

describe('A1S.11 explicit dormant message-table and message-markdown safe shell main contract', () => {
  const tableSelection = { mode: 'safe-shell', family: 'message-table' };
  const markdownSelection = { mode: 'safe-shell', family: 'message-markdown' };

  test('A1S.11-RED-1 routes explicit adapters before markdown-it, purification, highlighting, table wrapping, and code enhancement only', () => {
    const detached = extractFunction('function renderDetachedKeyedUnit(');
    expect(detached).toContain('renderSafeShellTableMessage(session, unit, presentationSelection)');
    expect(detached).toContain('renderSafeShellMarkdownMessage(session, unit, presentationSelection)');
    expect(detached.indexOf('renderSafeShellTableMessage')).toBeLessThan(detached.indexOf('renderMessageElement(unit.value.message, renderedSet);'));
    expect(detached.indexOf('renderSafeShellMarkdownMessage')).toBeLessThan(detached.indexOf('renderMessageElement(unit.value.message, renderedSet);'));
    expect(source.indexOf('function renderSafeShellTableMessage(')).toBeLessThan(source.indexOf('function renderMarkdownInto('));
    expect(source.indexOf('function renderSafeShellMarkdownMessage(')).toBeLessThan(source.indexOf('function renderMarkdownInto('));

    const harness = createHarness();
    const tableMessage = { id: 'table-route', role: 'assistant', text: '| A | B |\n| --- | --- |\n| 1 | 2 |', meta: { isThinking: false } };
    const markdownMessage = { id: 'markdown-route', role: 'assistant', text: '# Heading\n\n[link](https://example.invalid)', meta: { isThinking: false } };
    renderAssistant(harness, tableMessage);
    renderAssistant(harness, markdownMessage);
    expect(harness.calls.rich).toBe(2);
    expect(renderAssistant(harness, tableMessage, tableSelection).dataset.safeShellFamily).toBe('message-table');
    expect(renderAssistant(harness, markdownMessage, markdownSelection).dataset.safeShellFamily).toBe('message-markdown');
    expect(harness.calls.rich).toBe(2);
    for (const name of ['renderSafeShellTableMessage', 'renderSafeShellMarkdownMessage']) {
      expect(extractFunction(`function ${name}(`)).not.toMatch(/md\.render|purify\.sanitize|DOMPurify|highlightElement|wrapTables|enhanceCodeBlocksWithCopyButtons|renderMarkdownInto/);
    }
  });

  test('A1S.11-RED-2 streams truthful table row/column semantics and bounded real table DOM across adversarial fixtures', async () => {
    const rows = Array.from({ length: 9 }, (_, row) => `| ${Array.from({ length: 7 }, (_, column) => `r${row}c${column}`).join(' | ')} |`);
    const canonical = `| ${Array.from({ length: 7 }, (_, column) => `列${column}😀`).join(' | ')} |\n| ${Array.from({ length: 7 }, () => ':---:').join(' | ')} |\n${rows.join('\n')}`;
    const harness = createHarness();
    const root = renderAssistant(harness, { id: 'table-bounds', role: 'assistant', text: canonical, meta: { isThinking: false } }, tableSelection);
    const accepted = getSafeShellSpec({ mode: 'safe-shell', family: 'message-table', shape: { rowCount: 9, columnCount: 7 } }) as any;
    expect(descendantCount(root)).toBeLessThanOrEqual(Math.min(56, accepted.budgets.collapsedDescendants));
    expect(root.children.length).toBeLessThanOrEqual(Math.min(5, accepted.budgets.rootDirectChildren));
    expect(root.querySelectorAll('table')).toHaveLength(0);
    expect(control(root, 'status').textContent).toMatch(/9 rows.*7 columns.*9 omitted rows.*7 omitted columns/i);
    control(root, 'open-full').click();
    expect(descendantCount(root)).toBeLessThanOrEqual(Math.min(88, accepted.budgets.openDescendants));
    expect(root.children.length).toBeLessThanOrEqual(Math.min(5, accepted.budgets.rootDirectChildren));
    expect(root.querySelectorAll('table')).toHaveLength(1);
    expect(root.querySelectorAll('caption')).toHaveLength(1);
    expect(root.querySelectorAll('tbody')[0].querySelectorAll('tr')).toHaveLength(8);
    expect(root.querySelectorAll('tr').every((row) => row.querySelectorAll('th').length + row.querySelectorAll('td').length <= 6)).toBe(true);
    expect(root.querySelectorAll('th').every((cell) => cell.getAttribute('scope') === 'col')).toBe(true);
    expect(control(root, 'status').textContent).toMatch(/1 omitted row.*1 omitted column/i);
    control(root, 'column-next').click();
    expect(control(root, 'column-page-status').textContent).toMatch(/columns 7–7 of 7/i);
    control(root, 'row-next').click();
    expect(control(root, 'row-page-status').textContent).toMatch(/rows 9–9 of 9/i);
    expect(rootText(root)).toContain('r8c6');
    control(root, 'copy-full').click();
    await Promise.resolve();
    expect(harness.calls.clipboard).toEqual([canonical]);

    const boundary = harness.runtime.scanSafeShellTablePage(
      `| ${Array.from({ length: 6 }, (_, index) => `h${index}`).join(' | ')} |\n| ${Array.from({ length: 6 }, () => '---').join(' | ')} |\n${Array.from({ length: 8 }, () => '| a | b | c | d | e | f |').join('\n')}`,
      1, 1, { limit: 8 }, { limit: 6 },
    );
    expect(boundary).toMatchObject({ found: true, rowCount: 8, columnCount: 6, rowPages: 1, columnPages: 1 });
    expect(harness.runtime.scanSafeShellTablePage('', 1, 1, { limit: 8 }, { limit: 6 })).toMatchObject({ found: false, rowCount: 0, columnCount: 0 });

    const scan = harness.runtime.scanSafeShellTablePage(
      `| ${Array.from({ length: 100_000 }, (_, index) => `h${index}`).join(' | ')} |\n| ${Array.from({ length: 100_000 }, () => '---').join(' | ')} |\n| huge | ${'x'.repeat(8 * 1024 * 1024)} |\n| --- | repeated |\n${'| sparse |\n'.repeat(99_998)}`,
      12_500, 16_667, { limit: 8 }, { limit: 6 },
    );
    expect(scan).toMatchObject({ found: true, rowCount: 100_000, columnCount: 100_000, selectedRowPage: 12_500, selectedColumnPage: 16_667 });
    expect(scan.rows.length).toBeLessThanOrEqual(8);
    expect(scan.rows.every((row: string[]) => row.length <= 6)).toBe(true);
    expect(JSON.stringify(scan).length).toBeLessThan(20_000);
    for (const malformed of ['', '| only | one |', '| h |\n| nope |\n| x |']) {
      expect(harness.runtime.scanSafeShellTablePage(malformed, 1, 1, { limit: 8 }, { limit: 6 }).found).toBe(false);
    }
    expect(extractFunction('function scanSafeShellTablePage(')).not.toMatch(/\.split\(|\.matchAll\(|Array\.from|rows\s*=\s*source|cells\s*=\s*source/);
  }, 30_000);

  test('A1S.11-RED-3 bounds 100k-block/link/table markdown and 8MiB lines with current-page trusted links and complete paging', () => {
    const repeated = Array.from({ length: 100_000 }, (_, index) => `# Block ${index}\n\n[link-${index}](https://example.invalid/${index}) src/file-${index}.ts:${index + 1}:1\n\n| h |\n| --- |\n| ${index} |`).join('\n\n');
    const canonical = `${repeated}\n${'x'.repeat(8 * 1024 * 1024)}`;
    const message = { id: 'markdown-huge', role: 'assistant', text: canonical, meta: { isThinking: false } };
    const harness = createHarness();
    const root = renderAssistant(harness, message, markdownSelection);
    const accepted = getSafeShellSpec({ mode: 'safe-shell', family: 'message-markdown', shape: { codeUnitCount: canonical.length, lineCount: 700_000 } }) as any;
    expect(descendantCount(root)).toBeLessThanOrEqual(Math.min(40, accepted.budgets.collapsedDescendants));
    expect(root.children.length).toBeLessThanOrEqual(Math.min(5, accepted.budgets.rootDirectChildren));
    expect(root.querySelectorAll('a')).toHaveLength(0);
    expect(control(root, 'status').textContent).toMatch(/300000 blocks.*100000 links.*100000 tables/i);
    control(root, 'open-full').click();
    expect(descendantCount(root)).toBeLessThanOrEqual(Math.min(52, accepted.budgets.openDescendants));
    expect(root.children.length).toBeLessThanOrEqual(Math.min(5, accepted.budgets.rootDirectChildren));
    expect(control(root, 'viewer').textContent.length).toBeLessThanOrEqual(accepted.page.content.maxCodeUnits);
    expect(control(root, 'viewer').textContent.split('\n').length).toBeLessThanOrEqual(accepted.page.content.maxLines);
    expect(root.querySelectorAll('a').length).toBeLessThanOrEqual(accepted.budgets.openDescendants - accepted.budgets.collapsedDescendants);
    for (const link of root.querySelectorAll('a')) expect(link.href).toMatch(/^ocfile:\/\/open\?path=/);
    const first = control(root, 'page-status').textContent;
    control(root, 'next').click();
    expect(control(root, 'page-status').textContent).not.toBe(first);
    expect(extractFunction('function scanSafeShellMarkdownPage(')).not.toMatch(/md\.parse|md\.render|\.split\(|\.matchAll\(|Array\.from/);
  }, 30_000);

  test('A1S.11-RED-4 preserves canonical copy/search and native focus/ownership while ordinary rich sanitization stays unchanged', async () => {
    let resolveClipboard!: (value: boolean) => void;
    const harness = createHarness({ clipboard: new Promise<boolean>((resolve) => { resolveClipboard = resolve; }) });
    const canonical = '# Canonical search\n\nsrc/current.ts:4:2\n\n<script>never rich in shell</script>';
    const message = { id: 'markdown-owned', role: 'assistant', text: canonical, meta: { isThinking: false } };
    const unit = { key: message.id, kind: 'message', value: { message } };
    const before: string[] = [];
    harness.runtime.visitLoadedChatSearchChunks(harness.session, unit, (chunk: string) => before.push(chunk));
    renderAssistant(harness, message);
    const shell = renderAssistant(harness, message, markdownSelection);
    const after: string[] = [];
    harness.runtime.visitLoadedChatSearchChunks(harness.session, unit, (chunk: string) => after.push(chunk));
    expect(after).toEqual(before);
    expect(shell.dataset.renderUnitKey).toBe(message.id);
    const open = control(shell, 'open-full');
    expect(open.tagName).toBe('BUTTON');
    expect(open.type).toBe('button');
    expect(open.getAttribute('aria-controls')).toBe(control(shell, 'viewer-region').id);
    expect(open.getAttribute('aria-expanded')).toBe('false');
    expect(control(shell, 'status').getAttribute('role')).toBe('status');
    open.click();
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(harness.document.activeElement).toBe(control(shell, 'viewer'));
    control(shell, 'copy-full').click();
    const replacement = renderAssistant(harness, message, markdownSelection);
    harness.deps.activeSessionId = 'session-b';
    resolveClipboard(true);
    await Promise.resolve();
    expect(shell.dataset.safeShellCopyState).toBeUndefined();
    expect(replacement.dataset.safeShellCopyState).toBeUndefined();
    harness.deps.activeSessionId = 'session-a';
    control(replacement, 'open-full').click();
    control(replacement, 'close').click();
    expect(harness.document.activeElement).toBe(control(replacement, 'open-full'));
    renderAssistant(harness, { id: 'ordinary-rich-after-markdown', role: 'assistant', text: '**rich** <script>blocked</script>', meta: { isThinking: false } });
    expect(harness.calls.rich).toBe(2);
    expect(source).toContain('sanitizeHtml: (html, config) => purify.sanitize(html, config)');
    expect(markdownControllerSource).toContain('element.innerHTML = dependencies.sanitizeHtml(raw');
  });
});
