import type { TodoState } from '../../src/supervisor/todo-protocol';

/** Read-only projection of the plugin's session-owned list. */
export class SupervisorTodos {
    private readonly root: HTMLElement;
    private fingerprint = '';
    constructor(private readonly document: Document, body: HTMLElement) {
        this.root = document.createElement('section'); this.root.className = 'sv-card';
        this.root.hidden = true; body.append(this.root);
    }
    render(state?: TodoState, stale = false): void {
        const fingerprint = JSON.stringify([state, stale]);
        if (fingerprint === this.fingerprint) return;
        this.fingerprint = fingerprint; this.root.replaceChildren();
        this.root.hidden = !state?.items.length;
        if (!state?.items.length) return;
        const title = this.document.createElement('h4'); title.className = 'sv-name';
        title.textContent = stale ? 'Todo list · Last known' : 'Todo list'; this.root.append(title);
        for (const item of state.items) {
            const row = this.document.createElement('p'), badge = this.document.createElement('span');
            badge.className = 'sv-badge';
            badge.textContent = item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '●' : '○';
            badge.setAttribute('data-tone', item.status === 'completed' ? 'success' : item.status === 'in_progress' ? 'info' : 'muted');
            badge.setAttribute('aria-label', item.status.replace('_', ' '));
            const label = this.document.createElement('span'); label.textContent = ' ' + item.content;
            row.append(badge, label); this.root.append(row);
        }
    }
}
