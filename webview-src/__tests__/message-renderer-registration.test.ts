import fs from 'fs';
import path from 'path';
import { renderMessageElement } from '../rendering/message-renderer';

function withDocument(run: () => void): void {
  const previousDocument = (global as any).document;
  (global as any).document = {
    createElement: () => ({
      appendChild: jest.fn(),
      classList: { add: jest.fn() },
      dataset: {},
    }),
  };
  try {
    run();
  } finally {
    (global as any).document = previousDocument;
  }
}

function createUserHost(appendMessageToChat: () => boolean | void) {
  return {
    activeSessionId: 'session-a',
    appendMessageImages: jest.fn(),
    appendMessageToChat,
    attachMessageCopyButton: jest.fn(),
    canAppendToMessage: () => false,
    getAppendItems: () => [],
    getSessionState: () => ({}),
    gitUndoEnabled: false,
    keyedFollowingTurnDividerOverride: false,
    shouldShowBackgroundSubagentIndicator: () => false,
    stripAttachmentManifest: (text: string) => text,
    stripSystemInjections: (text: string) => text,
    renderUserMarkdown: jest.fn(),
  };
}

describe('message renderer registration', () => {
  test('does not register early, rejected, or thrown root/message appends', () => {
    const nullChangeList = new Set<string>();
    renderMessageElement({
      activeSessionId: 'session-a',
      getSessionState: () => ({}),
      changeListRenderer: { render: () => null },
      appendChatRenderRoot: jest.fn(),
    }, { id: 'null-changelist', role: 'system', meta: { kind: 'changeList' } }, nullChangeList);
    expect(nullChangeList).not.toContain('null-changelist');

    const rejectedRoot = new Set<string>();
    renderMessageElement({
      activeSessionId: 'session-a',
      getSessionState: () => ({}),
      changeListRenderer: { render: () => ({}) },
      appendChatRenderRoot: () => false,
    }, { id: 'rejected-root', role: 'system', meta: { kind: 'changeList' } }, rejectedRoot);
    expect(rejectedRoot).not.toContain('rejected-root');

    const thrownRoot = new Set<string>();
    expect(() => renderMessageElement({
      activeSessionId: 'session-a',
      getSessionState: () => ({}),
      changeListRenderer: { render: () => ({}) },
      appendChatRenderRoot: () => { throw new Error('root append failed'); },
    }, { id: 'thrown-root', role: 'system', meta: { kind: 'changeList' } }, thrownRoot)).toThrow('root append failed');
    expect(thrownRoot).not.toContain('thrown-root');

    withDocument(() => {
      const blankUser = new Set<string>();
      renderMessageElement(createUserHost(jest.fn()), {
        id: 'blank-user', role: 'user', text: '   ',
      }, blankUser);
      expect(blankUser).not.toContain('blank-user');

      const rejectedMessage = new Set<string>();
      renderMessageElement(createUserHost(() => false), {
        id: 'rejected-message', role: 'user', text: 'hello',
      }, rejectedMessage);
      expect(rejectedMessage).not.toContain('rejected-message');

      const thrownMessage = new Set<string>();
      expect(() => renderMessageElement(createUserHost(() => { throw new Error('message append failed'); }), {
        id: 'thrown-message', role: 'user', text: 'hello',
      }, thrownMessage)).toThrow('message append failed');
      expect(thrownMessage).not.toContain('thrown-message');
    });
  });

  test('appendMessageToChat returns the underlying admission result without another append', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'media', 'main.js'), 'utf8');
    const start = source.indexOf('function appendMessageToChat(messageElement, message) {');
    const end = source.indexOf('\n    function renderNestedMessageElement', start);
    const wrapper = source.slice(start, end);
    expect(wrapper).toContain('return appendChatRenderRoot(messageElement);');
    expect(wrapper).toContain('return appendChatRenderRoot(row);');
    expect((wrapper.match(/appendChatRenderRoot\(/g) || [])).toHaveLength(2);
  });
});
