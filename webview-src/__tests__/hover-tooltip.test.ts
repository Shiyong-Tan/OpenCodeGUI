import { installHoverTooltips } from '../features/hover-tooltip';
class HintElement extends EventTarget {
  className = ''; id = ''; hidden = false; textContent = ''; isConnected = true;
  style = { left: '', top: '' }; attributes = new Map<string, string>();
  get title() { return this.getAttribute('title') || ''; }
  set title(value: string) { this.setAttribute('title', value); }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  removeAttribute(key: string) { this.attributes.delete(key); }
  closest(selector: string) { return selector === '[title]' ? this : null; }
  contains(node: unknown) { return node === this; }
  getBoundingClientRect() { return { left: 990, top: 10, bottom: 30, width: 80, height: 40 }; }
}
describe('shared hover hints', () => {
  let doc: EventTarget; let win: EventTarget; let hint: HintElement; let mutations: () => void;
  beforeEach(() => {
    jest.useFakeTimers();
    Object.assign(globalThis, { Element: HintElement, Node: HintElement,
      MutationObserver: class { constructor(callback: () => void) { mutations = callback; } observe() {} } });
    doc = Object.assign(new EventTarget(), { createElement: () => hint = new HintElement(), body: { appendChild() {} } });
    win = Object.assign(new EventTarget(), { innerWidth: 1024, innerHeight: 768 });
    installHoverTooltips(doc as Document, win as Window);
  });
  afterEach(() => { win.dispatchEvent(new Event('blur')); jest.useRealTimers(); });
  function emit(type: string, target: HintElement) {
    const event = new Event(type); Object.defineProperty(event, 'target', { value: target }); doc.dispatchEvent(event);
  }
  test('shows plain text with bounded placement and restores metadata on leave', () => {
    const button = new HintElement(); button.title = '<img src=x>'; button.setAttribute('aria-describedby', 'existing');
    emit('mouseover', button); expect(hint.hidden).toBe(true); expect(button.title).toBe('');
    jest.advanceTimersByTime(350);
    expect(hint.hidden).toBe(false); expect(hint.textContent).toBe('<img src=x>');
    expect(hint.style.left).toBe('936px'); expect(hint.style.top).toBe('38px');
    emit('mouseout', button);
    expect(hint.hidden).toBe(true); expect(button.title).toBe('<img src=x>'); expect(button.getAttribute('aria-describedby')).toBe('existing');
  });
  test('supports focus and dismisses without delayed reappearance', () => {
    const button = new HintElement(); button.title = 'Task status'; emit('focusin', button);
    doc.dispatchEvent(new Event('keydown')); jest.advanceTimersByTime(400);
    expect(hint.hidden).toBe(true); expect(button.title).toBe('Task status');
  });
  test('refreshes changed status and hides when the control is removed', () => {
    const button = new HintElement(); button.title = 'Running'; emit('mouseover', button);
    jest.advanceTimersByTime(350); button.title = 'Disconnected'; mutations();
    expect(hint.textContent).toBe('Disconnected'); button.isConnected = false; mutations();
    expect(hint.hidden).toBe(true); expect(button.title).toBe('Disconnected');
  });
});
