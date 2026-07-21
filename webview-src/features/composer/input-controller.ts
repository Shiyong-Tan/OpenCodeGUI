export type ComposerInputKeyAction = 'none' | 'exit-append' | 'allow-append-tab' | 'cycle-mode' | 'send';

export function decideComposerInputKeyAction(options: {
  key: string;
  shiftKey: boolean;
  appendActive: boolean;
  inputFocused: boolean;
}): ComposerInputKeyAction {
  if (options.appendActive && options.key === 'Escape') return 'exit-append';
  if (options.appendActive && options.key === 'Tab') return 'allow-append-tab';
  if (!options.appendActive && options.key === 'Tab' && options.inputFocused) return 'cycle-mode';
  if (options.key === 'Enter' && !options.shiftKey) return 'send';
  return 'none';
}

export function createComposerInputController(options: {
  document: Document;
  input: HTMLTextAreaElement;
  fileMention: {
    close(): void;
    schedule(): void;
    handleKeydown(event: KeyboardEvent): boolean;
  };
  clipboard: { handlePaste(event: ClipboardEvent): void };
  isAppendActive(): boolean;
  isAppendDraftActive(): boolean;
  onAppendDraft(value: string): void;
  onRegularDraft(value: string): void;
  onExitAppend(): void;
  onCycleMode(): void;
  onSend(): void;
  onAppendInputChanged(): void;
}): { install(): void } {
  const install = (): void => {
    options.input.addEventListener('paste', (event) => options.clipboard.handlePaste(event));
    options.input.addEventListener('input', () => {
      if (options.isAppendDraftActive()) {
        options.onAppendDraft(options.input.value);
        options.fileMention.close();
        options.onAppendInputChanged();
        return;
      }
      options.onRegularDraft(options.input.value);
      options.fileMention.schedule();
    });
    options.input.addEventListener('click', () => {
      if (options.isAppendActive()) {
        options.fileMention.close();
        return;
      }
      options.fileMention.schedule();
    });
    options.input.addEventListener('keydown', (event) => {
      if (options.fileMention.handleKeydown(event)) return;
      const action = decideComposerInputKeyAction({
        key: event.key,
        shiftKey: event.shiftKey,
        appendActive: options.isAppendActive(),
        inputFocused: options.document.activeElement === options.input,
      });
      if (action === 'exit-append') {
        event.preventDefault();
        options.onExitAppend();
      } else if (action === 'cycle-mode') {
        event.preventDefault();
        options.onCycleMode();
      } else if (action === 'send') {
        event.preventDefault();
        options.onSend();
      }
    });
  };
  return { install };
}
