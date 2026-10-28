/** Explicit chat selection actions; editable controls retain native clipboard behavior. */
export function installChatSelectionClipboard(options: {
  document: Document; container: HTMLElement; getSessionId(): string | null;
  postMessage(message: unknown): void; selectionText?(selection: Selection): string;
}): void {
  const doc = options.document;
  let menu: HTMLElement | undefined;
  const close = () => { menu?.remove(); menu = undefined; };
  const editable = 'input, textarea, [contenteditable]:not([contenteditable="false"])';
  const selected = (target: EventTarget | null) => {
    if ((target as Element | null)?.closest?.(editable)) return;
    const selection = doc.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1
      || !selection.anchorNode || !selection.focusNode
      || !options.container.contains(selection.anchorNode) || !options.container.contains(selection.focusNode)) return;
    const node = selection.anchorNode;
    const element = node.nodeType === 1 ? node as Element : node.parentElement;
    if (element?.closest(editable)) return;
    const sessionId = options.getSessionId();
    const text = options.selectionText?.(selection) ?? selection.toString();
    return sessionId && text ? { type: 'copySelectedText', sessionId, text } : undefined;
  };
  doc.addEventListener('keydown', event => {
    if (event.key === 'Escape') { close(); return; }
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'c') return;
    const value = selected(event.target); if (!value) return;
    event.preventDefault(); event.stopImmediatePropagation();
    options.postMessage(value); close();
  }, true);
  doc.addEventListener('copy', event => {
    const value = selected(event.target); if (!value) return;
    event.clipboardData?.setData('text/plain', value.text);
    event.preventDefault(); options.postMessage(value);
  }, true);
  options.container.addEventListener('contextmenu', event => {
    const value = selected(event.target); if (!value) return;
    event.preventDefault(); event.stopPropagation(); close();
    const button = doc.createElement('button');
    button.type = 'button'; button.className = 'chat-selection-copy-menu';
    button.textContent = 'Copy'; button.setAttribute('aria-label', 'Copy selected text');
    button.style.left = `${Math.max(0, Math.min(event.clientX, doc.documentElement.clientWidth - 120))}px`;
    button.style.top = `${Math.max(0, Math.min(event.clientY, doc.documentElement.clientHeight - 40))}px`;
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => {
      if (options.getSessionId() === value.sessionId) options.postMessage(value);
      close();
    });
    menu = button; doc.body.appendChild(button); button.focus({ preventScroll: true });
  });
  doc.addEventListener('pointerdown', event => { if (menu && !menu.contains(event.target as Node)) close(); }, true);
  doc.addEventListener('scroll', close, true);
  doc.defaultView?.addEventListener('blur', close);
}
