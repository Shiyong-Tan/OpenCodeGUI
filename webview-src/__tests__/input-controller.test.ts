import {
  createComposerInputController,
  decideComposerInputKeyAction,
} from '../features/composer/input-controller';

describe('composer input key routing', () => {
  it('preserves append Escape and native append Tab behavior', () => {
    expect(decideComposerInputKeyAction({ key: 'Escape', shiftKey: false, appendActive: true, inputFocused: true })).toBe('exit-append');
    expect(decideComposerInputKeyAction({ key: 'Tab', shiftKey: false, appendActive: true, inputFocused: true })).toBe('allow-append-tab');
  });

  it('cycles mode only for a focused non-append composer', () => {
    expect(decideComposerInputKeyAction({ key: 'Tab', shiftKey: false, appendActive: false, inputFocused: true })).toBe('cycle-mode');
    expect(decideComposerInputKeyAction({ key: 'Tab', shiftKey: false, appendActive: false, inputFocused: false })).toBe('none');
  });

  it('sends on Enter but preserves Shift+Enter newline', () => {
    expect(decideComposerInputKeyAction({ key: 'Enter', shiftKey: false, appendActive: false, inputFocused: true })).toBe('send');
    expect(decideComposerInputKeyAction({ key: 'Enter', shiftKey: true, appendActive: false, inputFocused: true })).toBe('none');
  });

  it('reserves Tab routing for completion before mode cycling', () => {
    expect(decideComposerInputKeyAction({
      key: 'Tab', shiftKey: false, appendActive: false, inputFocused: true,
    })).toBe('cycle-mode');
    // The installed controller invokes wordCompletion.handleKeydown first; this
    // pure fallback remains mode cycling only when no suggestion was accepted.
  });

  it('lets file mentions and word completion consume keys before composer actions', () => {
    const listeners = new Map<string, (event: any) => void>();
    const input: any = {
      value: 'virtualiz',
      addEventListener: (name: string, listener: (event: any) => void) => listeners.set(name, listener),
    };
    const onCycleMode = jest.fn();
    const completionKeydown = jest.fn(() => true);
    createComposerInputController({
      document: { activeElement: input } as any,
      input,
      fileMention: { close: jest.fn(), schedule: jest.fn(), handleKeydown: jest.fn(() => false) },
      wordCompletion: {
        clear: jest.fn(),
        schedule: jest.fn(),
        handleKeydown: completionKeydown,
        onCompositionStart: jest.fn(),
        onCompositionEnd: jest.fn(),
        syncScroll: jest.fn(),
      },
      clipboard: { handlePaste: jest.fn() },
      isAppendActive: () => false,
      isAppendDraftActive: () => false,
      onAppendDraft: jest.fn(),
      onRegularDraft: jest.fn(),
      onExitAppend: jest.fn(),
      onCycleMode,
      onSend: jest.fn(),
      onAppendInputChanged: jest.fn(),
    }).install();

    listeners.get('keydown')?.({ key: 'Tab', shiftKey: false });
    expect(completionKeydown).toHaveBeenCalled();
    expect(onCycleMode).not.toHaveBeenCalled();
  });
});
