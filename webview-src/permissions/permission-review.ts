import type { PermissionCard } from '../../src/permissions/PermissionReviewService';

type Message = Record<string, unknown>;
type Row = { root: HTMLElement; name: HTMLElement; scope: HTMLElement; detail: HTMLElement; reason: HTMLElement;
    allow: HTMLButtonElement; reject: HTMLButtonElement; card: PermissionCard };
export function createPermissionReview(options: {
    document: Document; postMessage(message: unknown): void; onPendingChanged(cards: PermissionCard[], scopeSessionId: string): void;
}) {
    const { document, postMessage } = options;
    const root = document.createElement('section'); root.className = 'permission-review'; root.hidden = true;
    const heading = document.createElement('strong'), status = document.createElement('p'), body = document.createElement('div');
    const inactive = document.createElement('details'), inactiveTitle = document.createElement('summary'), inactiveBody = document.createElement('div');
    inactive.append(inactiveTitle, inactiveBody); inactive.hidden = true;
    const refresh = document.createElement('button'); refresh.type = 'button'; refresh.textContent = 'Refresh permissions';
    root.append(heading, status, refresh, body, inactive);
    const style = document.createElement('style');
    style.textContent = `.permission-review{margin:8px 12px;padding:12px;border:1px solid var(--vscode-editorWarning-foreground);border-radius:10px;background:var(--vscode-editor-background);max-height:42vh;overflow:auto;font:12px/1.5 var(--vscode-font-family)}
.permission-review[hidden]{display:none}.permission-review article{margin-top:10px;padding-top:8px;border-top:1px solid var(--vscode-panel-border)}
.permission-review h4,.permission-review p{margin:4px 0}.permission-review pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:160px;overflow:auto}
.permission-review button{margin:4px 8px 0 0;padding:4px 9px;border:1px solid var(--vscode-button-border,transparent);border-radius:5px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}
.permission-review button:disabled{opacity:.45;cursor:default}.permission-review button:focus-visible{outline:2px solid var(--vscode-focusBorder)}
.permission-review [data-state=expired]{opacity:.65}.permission-review summary{cursor:pointer}`;
    document.body.append(style);
    const composer = document.querySelector('.input-container');
    if (composer?.parentNode) composer.parentNode.insertBefore(root, composer); else document.body.append(root);
    const rows = new Map<string, Row>(), sending = new Set<string>(), errors = new Map<string, string>();
    let scopeSessionId = '', refreshId = '', counter = 0, waitingAt = 0, stale = true, failed = false;
    const key = (card: Pick<PermissionCard, 'sessionId' | 'requestId'>) => `${card.sessionId}:${card.requestId}`;
    const update = () => {
        const cards = [...rows.values()].map(r => r.card), pending = cards.filter(c => c.state === 'pending');
        root.hidden = pending.length === 0;
        heading.textContent = failed ? 'Permissions unavailable' : `Permission requests · ${pending.length} waiting`;
        const expired = cards.filter(c => c.state === 'expired').length;
        inactive.hidden = !expired; inactiveTitle.textContent = `Inactive requests (${expired})`;
        status.textContent = stale ? 'Observation unavailable. Refresh before responding.' :
            pending.length ? 'Review the tool and scope. Each response applies to the named session.' : 'Residual requests are inactive and cannot be approved.';
        for (const [id, row] of rows) {
            row.root.setAttribute('data-state', row.card.state);
            row.allow.disabled = row.reject.disabled = stale || row.card.state !== 'pending' || sending.has(id);
            row.reason.textContent = errors.get(id) || (sending.has(id) ? 'Submitting decision…' : row.card.reason);
        }
        // Timing/blocker state is a projection of verified requests, never inferred from a parent being visible.
        if (!stale) options.onPendingChanged(pending, scopeSessionId);
    };
    const requestRefresh = () => {
        if (!scopeSessionId || document.hidden) return;
        if (waitingAt && Date.now() - waitingAt < 10000) return;
        if (waitingAt) { stale = true; failed = true; update(); }
        waitingAt = Date.now(); refreshId = `${++counter}`;
        postMessage({ type: 'permissionRefresh', scopeSessionId, refreshId });
    };
    const decide = (row: Row, response: 'once' | 'reject') => {
        const card = row.card, id = key(card);
        if (stale || card.state !== 'pending' || !card.reviewToken || sending.has(id)) return;
        sending.add(id); errors.delete(id); update();
        postMessage({ type: 'permissionResult', scopeSessionId: card.scopeSessionId, sessionId: card.sessionId,
            permissionId: card.requestId, requestId: card.requestId, reviewToken: card.reviewToken, response });
    };
    const render = (cards: PermissionCard[]) => {
        const retained = new Set<string>();
        for (const card of cards) {
            const id = key(card); retained.add(id);
            let row = rows.get(id);
            if (!row) {
                const article = document.createElement('article'), name = document.createElement('h4'), scope = document.createElement('p');
                const details = document.createElement('details'), summary = document.createElement('summary'), detail = document.createElement('pre');
                summary.textContent = 'Request details'; details.append(summary, detail);
                const reason = document.createElement('p'), allow = document.createElement('button'), reject = document.createElement('button');
                allow.type = reject.type = 'button'; allow.textContent = 'Approve once'; reject.textContent = 'Reject';
                article.append(name, scope, details, reason, allow, reject); body.append(article);
                row = { root: article, name, scope, detail, reason, allow, reject, card }; rows.set(id, row);
                const target = row; allow.addEventListener('click', () => decide(target, 'once')); reject.addEventListener('click', () => decide(target, 'reject'));
            }
            row.card = card;
            const container = card.state === 'expired' ? inactiveBody : body;
            if (row.root.parentNode !== container) container.append(row.root);
            row.name.textContent = `${card.agent || 'Agent'} · ${card.title || 'Untitled session'}`;
            row.scope.textContent = `${card.tool || 'Tool unknown'} · ${card.permission}: ${card.patterns.join(', ')}`;
            row.detail.textContent = `Session: ${card.sessionId}\nRequest: ${card.requestId}\nTool: ${card.tool}\nArguments: ${card.input}`;
        }
        for (const [id, row] of rows) if (!retained.has(id)) { row.root.remove(); rows.delete(id); sending.delete(id); errors.delete(id); }
        update();
    };
    refresh.addEventListener('click', requestRefresh);
    const timer = setInterval(requestRefresh, 3000);
    return {
        select(sessionId: string) {
            if (sessionId === scopeSessionId) { requestRefresh(); return; }
            scopeSessionId = sessionId; waitingAt = 0; refreshId = ''; stale = true; failed = false; inactive.open = false;
            render([]); sending.clear(); errors.clear(); requestRefresh();
        },
        refresh: requestRefresh,
        receive(message: Message) {
            if (message.type === 'serverStatus') {
                if (message.status !== 'connected') { waitingAt = 0; refreshId = ''; stale = true; failed = !!scopeSessionId; update(); }
                else requestRefresh();
                return;
            }
            if (message.type === 'permissionSnapshot') {
                if (message.scopeSessionId !== scopeSessionId || message.refreshId !== refreshId) return;
                waitingAt = 0;
                if (message.error || !Array.isArray(message.requests)) { stale = true; failed = true; update(); return; }
                const cards = message.requests as PermissionCard[];
                if (cards.some(c => !c || c.scopeSessionId !== scopeSessionId || typeof c.sessionId !== 'string' || typeof c.requestId !== 'string' || !Array.isArray(c.patterns))) {
                    stale = true; failed = true; update(); return;
                }
                stale = false; failed = false; render(cards); return;
            }
            if (message.type === 'permissionResultAck' || message.type === 'permissionResultFailed') {
                const id = `${message.sessionId}:${message.permissionId}`;
                if (!rows.has(id) && !sending.has(id)) return;
                sending.delete(id);
                if (message.type === 'permissionResultAck') { rows.get(id)?.root.remove(); rows.delete(id); errors.delete(id); }
                else errors.set(id, typeof message.reason === 'string' ? message.reason : 'Decision failed. Refresh and review again.');
                waitingAt = 0; refreshId = ''; stale = true; update(); requestRefresh(); return;
            }
            if (message.type === 'permissionOverlay' || message.type === 'permissionOverlayClose') requestRefresh();
        },
        dispose() { clearInterval(timer); root.remove(); style.remove(); },
    };
}
