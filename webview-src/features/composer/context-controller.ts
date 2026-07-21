import type { ComposerContextItem, ComposerContextState } from './context-state';

export type ContextTokenPresentation =
  | { kind: 'append'; label: 'Append'; title: 'Exit append mode'; ariaLabel: 'Exit append mode' }
  | { kind: 'context'; label: string; title: 'Remove context'; ariaLabel: string; item: ComposerContextItem }
  | { kind: 'file'; label: string; title: 'Remove file reference'; ariaLabel: string; path: string };

export function deriveContextTokenPresentation(
  state: ComposerContextState,
  appendActive: boolean,
): ContextTokenPresentation[] {
  if (appendActive) {
    return [{ kind: 'append', label: 'Append', title: 'Exit append mode', ariaLabel: 'Exit append mode' }];
  }
  const contextTokens: ContextTokenPresentation[] = state.getContextItems()
    .filter((item) => Boolean(item?.displayText))
    .map((item) => ({
      kind: 'context',
      label: String(item.displayText),
      title: 'Remove context',
      ariaLabel: `Remove ${item.displayText}`,
      item,
    }));
  const fileTokens: ContextTokenPresentation[] = state.getFileRefs()
    .filter((item) => Boolean(item?.path))
    .map((item) => ({
      kind: 'file',
      label: `@${item.path}`,
      title: 'Remove file reference',
      ariaLabel: `Remove ${item.path}`,
      path: item.path,
    }));
  return [...contextTokens, ...fileTokens];
}

export function createContextTokenUiController(options: {
  state: ComposerContextState;
  document: Document;
  listElement: HTMLElement;
  isAppendActive(): boolean;
  exitAppend(): void;
}): { render(): void } {
  const render = (): void => {
    options.listElement.innerHTML = '';
    for (const token of deriveContextTokenPresentation(options.state, options.isAppendActive())) {
      const chip = options.document.createElement('span');
      chip.className = `input-token ${token.kind}-token`;

      const label = options.document.createElement('span');
      label.className = 'input-token-label';
      label.textContent = token.label;
      chip.appendChild(label);

      const removeButton = options.document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'input-token-remove';
      removeButton.title = token.title;
      removeButton.setAttribute('aria-label', token.ariaLabel);
      removeButton.textContent = '\u00D7';
      removeButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (token.kind === 'append') {
          options.exitAppend();
          return;
        }
        const changed = token.kind === 'context'
          ? options.state.removeContext(token.item)
          : options.state.removeFileRef(token.path);
        if (changed) render();
      });
      chip.appendChild(removeButton);
      options.listElement.appendChild(chip);
    }
  };

  return { render };
}
