/** One presentation owner for native title hints, including dynamically mounted controls. */
export function installHoverTooltips(document: Document, window: Window): void {
  const tooltip = document.createElement('div');
  tooltip.className = 'oc-hover-tooltip';
  tooltip.id = 'oc-hover-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  document.body.appendChild(tooltip);
  let owner: HTMLElement | null = null;
  let title = '';
  let describedBy: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hide = () => {
    clearTimeout(timer);
    tooltip.hidden = true;
    if (owner) {
      if (!owner.getAttribute('title')) owner.setAttribute('title', title);
      if (describedBy === null) owner.removeAttribute('aria-describedby');
      else owner.setAttribute('aria-describedby', describedBy);
    }
    owner = null;
  };
  const place = () => {
    if (!owner?.isConnected) { hide(); return; }
    const rect = owner.getBoundingClientRect();
    const bounds = tooltip.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left + (rect.width - bounds.width) / 2, window.innerWidth - bounds.width - 8));
    const above = rect.top - bounds.height - 8;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(8, Math.min(above >= 8 ? above : rect.bottom + 8, window.innerHeight - bounds.height - 8))}px`;
  };
  const show = (event: Event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[title]') : null;
    if (target === owner) return;
    hide();
    if (!target?.title.trim() || target.closest('.quota-tooltip')) return;
    owner = target;
    title = target.title;
    describedBy = target.getAttribute('aria-describedby');
    // Suppress the browser's second bubble only while this control owns our hint.
    target.setAttribute('title', '');
    target.setAttribute('aria-describedby', [describedBy, tooltip.id].filter(Boolean).join(' '));
    tooltip.textContent = title;
    timer = setTimeout(() => { tooltip.hidden = false; place(); }, 350);
  };
  const leave = (event: Event) => {
    const related = (event as MouseEvent).relatedTarget;
    if (owner && related instanceof Node && owner.contains(related)) return;
    hide();
  };
  document.addEventListener('mouseover', show);
  document.addEventListener('mouseout', leave);
  document.addEventListener('focusin', show);
  document.addEventListener('focusout', leave);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', hide, true);
  document.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
  window.addEventListener('resize', hide);
  new MutationObserver(() => {
    if (!owner) return;
    if (!owner.isConnected) { hide(); return; }
    const updated = owner.getAttribute('title');
    if (updated) {
      title = updated;
      tooltip.textContent = title;
      owner.setAttribute('title', '');
      if (!tooltip.hidden) place();
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
}
