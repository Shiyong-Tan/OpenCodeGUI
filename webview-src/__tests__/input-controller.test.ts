import { decideComposerInputKeyAction } from '../features/composer/input-controller';

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
});
