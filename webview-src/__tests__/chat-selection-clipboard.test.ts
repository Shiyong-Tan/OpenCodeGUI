import { installChatSelectionClipboard } from '../features/chat-selection-clipboard';
class Element extends EventTarget {
  parentElement?: Element; editable = false; textContent = ''; className = ''; type = ''; style = {};
  children: Element[] = [];
  nodeType = 1;
  appendChild(node: Element) { node.parentElement = this; this.children.push(node); }
  contains(node: Element): boolean { return node === this || !!node?.parentElement && this.contains(node.parentElement); }
  closest() { return this.editable ? this : null; }
  setAttribute() {} focus() {}
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(n => n !== this); }
}
function harness() {
  const body = new Element(), container = new Element(), text = new Element(); container.appendChild(text);
  let sessionId = 'ses_A';
  const selection = { isCollapsed: false, rangeCount: 1, anchorNode: text, focusNode: text, toString: () => 'Selected text' };
  const doc = Object.assign(new EventTarget(), { body, documentElement: { clientWidth: 1000, clientHeight: 600 },
    defaultView: new EventTarget(), getSelection: () => selection, createElement: () => new Element() });
  const postMessage = jest.fn();
  installChatSelectionClipboard({ document: doc as unknown as Document, container: container as unknown as HTMLElement,
    getSessionId: () => sessionId, postMessage });
  const emit = (target: EventTarget, type: string, props: object = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), props); target.dispatchEvent(event); return event;
  };
  return { doc, container, text, selection, postMessage, emit, body, switchSession: () => { sessionId = 'ses_B'; } };
}
test.each(['ctrlKey', 'metaKey'])('copies only the selected chat text through %s', modifier => {
  const h = harness();
  const event = h.emit(h.doc, 'keydown', { key: 'c', [modifier]: true });
  expect(event.defaultPrevented).toBe(true);
  expect(h.postMessage).toHaveBeenCalledWith({ type: 'copySelectedText', sessionId: 'ses_A', text: 'Selected text' });
});
test('native copy event also uses the explicit clipboard bridge', () => {
  const h = harness(), setData = jest.fn();
  expect(h.emit(h.doc, 'copy', { clipboardData: { setData } }).defaultPrevented).toBe(true);
  expect(setData).toHaveBeenCalledWith('text/plain', 'Selected text'); expect(h.postMessage).toHaveBeenCalledTimes(1);
});
test('right-click copy retains its selection but rejects a subsequent session switch', () => {
  const h = harness();
  h.emit(h.container, 'contextmenu', { clientX: 40, clientY: 50 });
  h.selection.isCollapsed = true;
  h.emit(h.body.children[0], 'click');
  expect(h.postMessage).toHaveBeenCalledTimes(1);
  h.selection.isCollapsed = false;
  h.emit(h.container, 'contextmenu', { clientX: 40, clientY: 50 });
  h.switchSession(); h.emit(h.body.children[0], 'click');
  expect(h.postMessage).toHaveBeenCalledTimes(1);
});
test('editable controls, external selections and paste keys retain native behavior', () => {
  const h = harness(); h.text.editable = true;
  expect(h.emit(h.doc, 'keydown', { key: 'c', ctrlKey: true }).defaultPrevented).toBe(false);
  expect(h.emit(h.doc, 'keydown', { key: 'v', ctrlKey: true }).defaultPrevented).toBe(false);
  h.text.editable = false; h.selection.anchorNode = new Element();
  expect(h.emit(h.doc, 'copy').defaultPrevented).toBe(false); expect(h.postMessage).not.toHaveBeenCalled();
});
