import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { renderMessageElement } from '../rendering/message-renderer';

const render = renderMessageElement as (host: any, message: any, renderedSet: Set<string>) => void;

function withDocument(run: () => void): void {
  const previousDocument = (global as any).document;
  (global as any).document = {
    createElement: () => ({ appendChild: jest.fn(), classList: { add: jest.fn() }, dataset: {} }),
  };
  try { run(); } finally { (global as any).document = previousDocument; }
}

function createUserHost(appendMessageToChat: () => boolean | void) {
  return {
    activeSessionId: 'session-a', appendMessageImages: jest.fn(), appendMessageToChat,
    attachMessageCopyButton: jest.fn(), canAppendToMessage: () => false, getAppendItems: () => [],
    getSessionState: () => ({}), gitUndoEnabled: false, keyedFollowingTurnDividerOverride: false,
    logWarning: jest.fn(),
    shouldShowBackgroundSubagentIndicator: () => false, stripAttachmentManifest: (text: string) => text,
    stripSystemInjections: (text: string) => text, renderUserMarkdown: jest.fn(),
  };
}

function extractFunction(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing ${marker}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${marker}`);
}

function invokeRealAppend(admission: (root: any) => boolean): { result: any; admissions: any[]; order: string[] } {
  const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
  const wrapper = extractFunction(source, 'function appendMessageToChat(messageElement, message)');
  const admissions: any[] = [];
  const order: string[] = [];
  const context = vm.createContext({
    KEYED_CHAT_RECONCILE_ENABLED: false,
    appendChatRenderRoot: (root: any) => { admissions.push(root); order.push('admit'); return admission(root); },
    document: { createElement: () => ({ dataset: {}, appendChild: () => order.push('row.appendChild') }) },
  });
  vm.runInContext(`${wrapper}; globalThis.invoke = appendMessageToChat;`, context);
  return {
    result: vm.runInContext(`invoke({ id: 'message-a' }, { id: 'message-a', role: 'user' })`, context),
    admissions,
    order,
  };
}

describe('message renderer registration', () => {
  test.each([undefined, 'session-explicit'])('Steer captures the owning session when message.sessionId is %s', sessionId => {
    const previousDocument = (global as any).document;
    const elements: any[] = [];
    (global as any).document = { createElement: () => {
      const element = { appendChild: jest.fn(), classList: { add: jest.fn() }, dataset: {}, style: {},
        className: '', disabled: false, listeners: {} as Record<string, (event: any) => void>,
        addEventListener(type: string, listener: (event: any) => void) { this.listeners[type] = listener; } };
      elements.push(element); return element;
    } };
    const postMessage = jest.fn();
    const host = { ...createUserHost(() => true), activeSessionId: 'session-a', vscode: { postMessage },
      getAppendItems: () => [{ text: 'Change direction', status: 'queued', delivery: 'queue', canSteer: true,
        inboxId: 'msg_queued', clientMessageId: 'client-queued', generation: 7 }] };
    try {
      render(host, { id: 'msg_root', role: 'user', text: 'Original task', sessionId }, new Set());
      const button = elements.find(element => element.className === 'append-steer-button');
      expect(button).toBeDefined();
      host.activeSessionId = 'session-b';
      button.listeners.click({ stopPropagation: jest.fn() });
      button.listeners.click({ stopPropagation: jest.fn() });
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(postMessage).toHaveBeenCalledWith({ type: 'steerQueuedPrompt', sessionId: sessionId ?? 'session-a',
        rootUserMsgId: 'msg_root', clientMessageId: 'client-queued', inboxId: 'msg_queued', generation: 7 });
    } finally { (global as any).document = previousDocument; }
  });

  test('keeps early, rejected, missing-element, and thrown appends retryable', () => {
    const nullChangeList = new Set<string>();
    render({ activeSessionId: 'session-a', getSessionState: () => ({}), changeListRenderer: { render: () => null }, appendChatRenderRoot: jest.fn() }, { id: 'null-changelist', role: 'system', meta: { kind: 'changeList' } }, nullChangeList);
    expect(nullChangeList).not.toContain('null-changelist');

    const rejectedRoot = new Set<string>();
    render({ activeSessionId: 'session-a', getSessionState: () => ({}), changeListRenderer: { render: () => ({}) }, appendChatRenderRoot: () => false }, { id: 'rejected-root', role: 'system', meta: { kind: 'changeList' } }, rejectedRoot);
    expect(rejectedRoot).not.toContain('rejected-root');

    const thrownRoot = new Set<string>();
    expect(() => render({ activeSessionId: 'session-a', getSessionState: () => ({}), changeListRenderer: { render: () => ({}) }, appendChatRenderRoot: () => { throw new Error('root failed'); } }, { id: 'thrown-root', role: 'system', meta: { kind: 'changeList' } }, thrownRoot)).toThrow('root failed');
    expect(thrownRoot).not.toContain('thrown-root');

    withDocument(() => {
      const blank = new Set<string>();
      render(createUserHost(jest.fn()), { id: 'blank', role: 'user', text: '   ' }, blank);
      expect(blank).not.toContain('blank');
      const rejected = new Set<string>();
      render(createUserHost(() => false), { id: 'rejected', role: 'user', text: 'text' }, rejected);
      expect(rejected).not.toContain('rejected');
      const thrown = new Set<string>();
      expect(() => render(createUserHost(() => { throw new Error('message failed'); }), { id: 'thrown', role: 'user', text: 'text' }, thrown)).toThrow('message failed');
      expect(thrown).not.toContain('thrown');
    });
  });

  test('registers accepted changelist and ordinary user/assistant appends exactly once', () => {
    const changelist = new Set<string>();
    const appendRoot = jest.fn(() => true);
    const changelistHost = { activeSessionId: 'session-a', getSessionState: () => ({}), changeListRenderer: { render: () => ({}) }, appendChatRenderRoot: appendRoot, logWarning: jest.fn() };
    render(changelistHost, { id: 'change', role: 'system', meta: { kind: 'changeList' } }, changelist);
    render(changelistHost, { id: 'change', role: 'system', meta: { kind: 'changeList' } }, changelist);
    expect(changelist).toEqual(new Set(['change']));
    expect(appendRoot).toHaveBeenCalledTimes(1);

    withDocument(() => {
      for (const role of ['user', 'assistant']) {
        const rendered = new Set<string>();
        const append = jest.fn(() => true);
        const host = createUserHost(append);
        if (role === 'assistant') Object.assign(host, { renderAssistantMarkdown: jest.fn() });
        const message = { id: `${role}-accepted`, role, text: 'text', meta: {} };
        render(host, message, rendered);
        render(host, message, rendered);
        expect(rendered).toEqual(new Set([message.id]));
        expect(append).toHaveBeenCalledTimes(1);
      }
    });
  });

  test('real appendMessageToChat VM wrapper propagates admission once and preserves row-before-admission order', () => {
    const accepted = invokeRealAppend(() => true);
    expect(accepted.result).toBe(true);
    expect(accepted.admissions).toHaveLength(1);
    expect(accepted.order).toEqual(['row.appendChild', 'admit']);

    const rejected = invokeRealAppend(() => false);
    expect(rejected.result).toBe(false);
    expect(rejected.admissions).toHaveLength(1);
    expect(rejected.order).toEqual(['row.appendChild', 'admit']);

    expect(() => invokeRealAppend(() => { throw new Error('admission failed'); })).toThrow('admission failed');
  });

  test('real wrapper returns false without admission when no element can be appended', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
    const wrapper = extractFunction(source, 'function appendMessageToChat(messageElement, message)');
    const admission = jest.fn();
    const context = vm.createContext({ appendChatRenderRoot: admission });
    vm.runInContext(`${wrapper}; globalThis.invoke = appendMessageToChat;`, context);
    expect(vm.runInContext(`invoke(null, { role: 'user' })`, context)).toBe(false);
    expect(admission).not.toHaveBeenCalled();
  });
});
