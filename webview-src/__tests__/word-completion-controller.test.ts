import {
  createWordCompletionController,
  extractCompletionWords,
  findCompletionPrefix,
} from '../features/composer/word-completion-controller';

function createElement() {
  return {
    textContent: '',
    scrollTop: 0,
    scrollLeft: 0,
    style: {},
    classList: {
      values: new Set<string>(),
      add(value: string) { this.values.add(value); },
      remove(value: string) { this.values.delete(value); },
      contains(value: string) { return this.values.has(value); },
    },
  } as any;
}

function createHarness(value = '', session = 'session-a') {
  const input = {
    value,
    selectionStart: value.length,
    selectionEnd: value.length,
    scrollTop: 0,
    scrollLeft: 0,
  } as any;
  const ghost = createElement();
  const ghostPrefix = createElement();
  const ghostSuffix = createElement();
  const accepted: string[] = [];
  const mockWindow: any = {
    setTimeout(callback: () => void) { callback(); return 1; },
    clearTimeout() {},
  };
  const controller = createWordCompletionController({
    input,
    ghost,
    ghostPrefix,
    ghostSuffix,
    window: mockWindow,
    getSessionId: () => session,
    onAccepted: (next) => accepted.push(next),
    delayMs: 0,
  });
  return { controller, input, ghost, ghostPrefix, ghostSuffix, accepted, mockWindow };
}

describe('local word completion controller', () => {
  it('extracts project identifiers while filtering hashes and numeric ids', () => {
    expect(extractCompletionWords('resetSessionState hydration_state abcdef123456789012345678')).toEqual(
      expect.arrayContaining(['resetSessionState', 'reset', 'Session', 'State', 'hydration_state', 'hydration', 'state']),
    );
    expect(extractCompletionWords('abcdef123456789012345678')).toEqual([]);
  });

  it('only completes a word at the collapsed end cursor and skips paths or mentions', () => {
    expect(findCompletionPrefix('check virtualiz', 15, 15)).toEqual({
      prefix: 'virtualiz', start: 6, end: 15,
    });
    expect(findCompletionPrefix('src/virtualiz', 13, 13)).toBeNull();
    expect(findCompletionPrefix('@virtualiz', 11, 11)).toBeNull();
    expect(findCompletionPrefix('virtualiz later', 5, 5)).toBeNull();
  });

  it('prefers current-session terminology and accepts it with Tab semantics', () => {
    const harness = createHarness('check recon');
    harness.controller.setWorkspaceWords(['reconfigure']);
    harness.controller.learnText('session-a', 'reconstruction reconstruction');
    harness.controller.refresh();

    expect(harness.ghostSuffix.textContent).toBe('struction');
    const preventDefault = jest.fn();
    expect(harness.controller.handleKeydown({ key: 'Tab', preventDefault } as any)).toBe(true);
    expect(preventDefault).toHaveBeenCalled();
    expect(harness.input.value).toBe('check reconstruction');
    expect(harness.accepted).toEqual(['check reconstruction']);
  });

  it('suppresses completion while an IME composition is active', () => {
    const harness = createHarness('virtualiz');
    harness.controller.onCompositionStart();
    harness.controller.refresh();
    expect(harness.controller.getSuggestion()).toBeNull();
    harness.controller.onCompositionEnd();
    expect(harness.controller.getSuggestion()?.completion.toLowerCase()).toMatch(/^virtualiz/);
  });

  it('learns each hydrated message only once per session', () => {
    const harness = createHarness('customW');
    const messages = [{ id: 'm1', text: 'customWorkspaceTerm' }];
    harness.controller.learnSessionMessages('session-a', messages);
    harness.controller.learnSessionMessages('session-a', messages);
    harness.controller.refresh();
    expect(harness.controller.getSuggestion()?.completion).toBe('customWorkspaceTerm');
    expect(harness.controller.getStats().sessionWords).toBeGreaterThan(0);
  });

  it('can be disabled without changing the input value', () => {
    const harness = createHarness('virtualiz');
    harness.controller.setEnabled(false);
    harness.controller.refresh();
    expect(harness.controller.getSuggestion()).toBeNull();
    expect(harness.input.value).toBe('virtualiz');
  });

  it('does not leak session-only terminology into another session', () => {
    const owner = createHarness('customW', 'session-a');
    owner.controller.learnText('session-a', 'customWorkspaceTerm');
    owner.controller.refresh();
    expect(owner.controller.getSuggestion()?.completion).toBe('customWorkspaceTerm');

    const other = createHarness('customW', 'session-b');
    other.controller.learnText('session-a', 'customWorkspaceTerm');
    other.controller.refresh();
    expect(other.controller.getSuggestion()).toBeNull();
  });

  it('positions the suffix at the measured textarea caret', () => {
    const harness = createHarness('virtualiz');
    const marker: any = { textContent: '', offsetLeft: 143, offsetTop: 29 };
    const mirror: any = {
      style: {},
      textContent: '',
      appendChild: jest.fn(),
      remove: jest.fn(),
    };
    let created = 0;
    harness.input.clientWidth = 500;
    harness.input.scrollLeft = 3;
    harness.input.scrollTop = 4;
    harness.input.ownerDocument = {
      body: { appendChild: jest.fn() },
      createElement: () => (++created === 1 ? mirror : marker),
    };
    harness.mockWindow.getComputedStyle = () => ({
      boxSizing: 'border-box',
      borderLeftWidth: '0px',
      borderRightWidth: '0px',
      borderTopWidth: '0px',
      borderBottomWidth: '0px',
      paddingLeft: '10px',
      paddingRight: '10px',
      paddingTop: '10px',
      paddingBottom: '10px',
      font: '13px sans-serif',
      fontFamily: 'sans-serif',
      fontSize: '13px',
      fontStyle: 'normal',
      fontWeight: '400',
      fontVariant: 'normal',
      letterSpacing: 'normal',
      lineHeight: '18px',
      textAlign: 'left',
      textIndent: '0px',
      textTransform: 'none',
      wordSpacing: 'normal',
      tabSize: '4',
    });

    harness.controller.refresh();

    expect(harness.ghostPrefix.textContent).toBe('');
    expect(harness.ghostSuffix.style.left).toBe('140px');
    expect(harness.ghostSuffix.style.top).toBe('25px');
    expect(mirror.remove).toHaveBeenCalled();
  });
});
