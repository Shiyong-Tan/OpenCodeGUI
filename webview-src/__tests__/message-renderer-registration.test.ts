import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { renderMessageElement } from '../rendering/message-renderer';

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
  test('keeps early, rejected, missing-element, and thrown appends retryable', () => {
    const nullChangeList = new Set<string>();
    renderMessageElement({ activeSessionId: 'session-a', getSessionState: () => ({}), changeListRenderer: { render: () => null }, appendChatRenderRoot: jest.fn() }, { id: 'null-changelist', role: 'system', meta: { kind: 'changeList' } }, nullChangeList);
    expect(nullChangeList).not.toContain('null-changelist');

    const rejectedRoot = new Set<string>();
    renderMessageElement({ activeSessionId: 'session-a', getSessionState: () => ({}), changeListRenderer: { render: () => ({}) }, appendChatRenderRoot: () => false }, { id: 'rejected-root', role: 'system', meta: { kind: 'changeList' } }, rejectedRoot);
    expect(rejectedRoot).not.toContain('rejected-root');

    const thrownRoot = new Set<string>();
    expect(() => renderMessageElement({ activeSessionId: 'session-a', getSessionState: () => ({}), changeListRenderer: { render: () => ({}) }, appendChatRenderRoot: () => { throw new Error('root failed'); } }, { id: 'thrown-root', role: 'system', meta: { kind: 'changeList' } }, thrownRoot)).toThrow('root failed');
    expect(thrownRoot).not.toContain('thrown-root');

    withDocument(() => {
      const blank = new Set<string>();
      renderMessageElement(createUserHost(jest.fn()), { id: 'blank', role: 'user', text: '   ' }, blank);
      expect(blank).not.toContain('blank');
      const rejected = new Set<string>();
      renderMessageElement(createUserHost(() => false), { id: 'rejected', role: 'user', text: 'text' }, rejected);
      expect(rejected).not.toContain('rejected');
      const thrown = new Set<string>();
      expect(() => renderMessageElement(createUserHost(() => { throw new Error('message failed'); }), { id: 'thrown', role: 'user', text: 'text' }, thrown)).toThrow('message failed');
      expect(thrown).not.toContain('thrown');
    });
  });

  test('registers accepted changelist and ordinary user/assistant appends exactly once', () => {
    const changelist = new Set<string>();
    const appendRoot = jest.fn(() => true);
    const changelistHost = { activeSessionId: 'session-a', getSessionState: () => ({}), changeListRenderer: { render: () => ({}) }, appendChatRenderRoot: appendRoot };
    renderMessageElement(changelistHost, { id: 'change', role: 'system', meta: { kind: 'changeList' } }, changelist);
    renderMessageElement(changelistHost, { id: 'change', role: 'system', meta: { kind: 'changeList' } }, changelist);
    expect(changelist).toEqual(new Set(['change']));
    expect(appendRoot).toHaveBeenCalledTimes(1);

    withDocument(() => {
      for (const role of ['user', 'assistant']) {
        const rendered = new Set<string>();
        const append = jest.fn(() => true);
        const host = createUserHost(append);
        if (role === 'assistant') Object.assign(host, { renderAssistantMarkdown: jest.fn() });
        const message = { id: `${role}-accepted`, role, text: 'text', meta: {} };
        renderMessageElement(host, message, rendered);
        renderMessageElement(host, message, rendered);
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
