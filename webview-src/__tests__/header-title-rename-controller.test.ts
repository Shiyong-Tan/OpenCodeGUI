import { createHeaderUiController } from '../features/header/header-controller';
import { createHeaderState } from '../features/header/header-state';

class FakeClassList {
  private readonly values = new Set<string>();
  add(value: string): void { this.values.add(value); }
  remove(value: string): void { this.values.delete(value); }
  toggle(value: string, force?: boolean): boolean {
    const next = force === undefined ? !this.values.has(value) : force;
    if (next) this.values.add(value);
    else this.values.delete(value);
    return next;
  }
  contains(value: string): boolean { return this.values.has(value); }
}

class FakeElement {
  textContent = '';
  title = '';
  disabled = false;
  style: Record<string, string> = {};
  classList = new FakeClassList();
  ownerDocument = { getSelection: () => null, createRange: () => null };
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(event: any) => void>>();

  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  addEventListener(type: string, listener: (event: any) => void): void {
    const entries = this.listeners.get(type) || [];
    entries.push(listener);
    this.listeners.set(type, entries);
  }
  focus(): void {}
  emit(type: string, event: Record<string, unknown> = {}): void {
    const payload = { preventDefault: jest.fn(), ...event };
    for (const listener of this.listeners.get(type) || []) listener(payload);
  }
}

function createHarness() {
  const state = createHeaderState('Original title');
  const title = new FakeElement();
  const usage = new FakeElement();
  const usageFill = new FakeElement();
  const usageLabel = new FakeElement();
  const onRename = jest.fn();
  const controller = createHeaderUiController({
    state,
    titleElement: title as any,
    usageElement: usage as any,
    usageFillElement: usageFill as any,
    usageLabelElement: usageLabel as any,
    getActiveSessionId: () => 'session-a',
    getContextLimit: () => 0,
    getRecomputedUsage: () => null,
    isCompactDisabled: () => false,
    compactDisabledTitle: '',
    onCompact: jest.fn(),
    onRename,
  });
  controller.install();
  controller.renderTitle();
  return { state, title, onRename, controller };
}

describe('header session title rename controller', () => {
  test.each(['Enter', 'blur'])('%s commits an edited title', (commitEvent) => {
    const harness = createHarness();
    harness.title.emit('dblclick');
    expect(harness.title.getAttribute('contenteditable')).toBe('true');
    harness.title.textContent = 'Renamed session';
    if (commitEvent === 'blur') harness.title.emit('blur');
    else harness.title.emit('keydown', { key: 'Enter' });

    expect(harness.state.getBaseTitle()).toBe('Renamed session');
    expect(harness.onRename).toHaveBeenCalledWith(
      'session-a',
      'Renamed session',
      expect.stringMatching(/^rename-/),
    );
  });

  test('Escape cancels without issuing a rename', () => {
    const harness = createHarness();
    harness.title.emit('dblclick');
    harness.title.textContent = 'Discard me';
    harness.title.emit('keydown', { key: 'Escape' });

    expect(harness.state.getBaseTitle()).toBe('Original title');
    expect(harness.onRename).not.toHaveBeenCalled();
  });

  test('a failed rename restores the previous title', () => {
    const harness = createHarness();
    harness.title.emit('dblclick');
    harness.title.textContent = 'Rejected title';
    harness.title.emit('blur');
    const opId = harness.onRename.mock.calls[0][2];

    harness.controller.handleSessionRenameResult({
      sessionId: 'session-a',
      opId,
      success: false,
    });

    expect(harness.state.getBaseTitle()).toBe('Original title');
    expect(harness.title.textContent).toBe('Original title');
  });
});
