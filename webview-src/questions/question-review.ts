import type { PermissionCard } from '../../src/permissions/PermissionReviewService';
export type QuestionDraft = PermissionCard & { stepIndex: number; answers: string[][]; selected: string[]; draft: string; pending: boolean; error: string; localOnly: false };
/** Review scope controls visibility only. Each request keeps its original session owner. */
export function createQuestionReview(post: (message: unknown) => void, changed: () => void, pendingChanged: (cards: PermissionCard[], scope: string) => void = () => {}) {
    let scope = '', refreshId = '', counter = 0, waiting = 0, stale = true;
    const rows = new Map<string, QuestionDraft>();
    const key = (v: { sessionId: string; requestId: string }) => `${v.sessionId}:${v.requestId}`;
    const current = () => rows.values().next().value as QuestionDraft | undefined;
    const refresh = () => {
        if (!scope || (waiting && Date.now() - waiting < 10000)) return;
        if (waiting) { stale = true; changed(); }
        waiting = Date.now(); refreshId = String(++counter); post({ type: 'questionRefresh', scopeSessionId: scope, refreshId });
    };
    const timer = setInterval(refresh, 3000);
    return {
        current, refresh, blocked: () => stale || !!current()?.pending,
        update(fn: (row: QuestionDraft) => QuestionDraft) { const row = current(); if (row) rows.set(key(row), fn(row)); },
        select(id: string) { if (scope !== id) { scope = id; rows.clear(); waiting = 0; refreshId = ''; stale = true; changed(); } refresh(); },
        submit(response: 'answer' | 'reject', answers?: string[][]) {
            const row = current(); if (!row || stale || row.pending) return;
            row.pending = true; row.error = ''; changed();
            post({ type: 'questionDecision', scopeSessionId: scope, sessionId: row.sessionId, requestId: row.requestId, reviewToken: row.reviewToken, response, answers });
        },
        receive(message: Record<string, unknown>) {
            if (message.type === 'questionSnapshot') {
                if (message.scopeSessionId !== scope || message.refreshId !== refreshId) return;
                waiting = 0;
                if (message.error || !Array.isArray(message.requests)) { stale = true; if (current()) current()!.error = 'Questions unavailable. Waiting to reconnect.'; changed(); return; }
                const cards = message.requests as PermissionCard[];
                if (cards.some(c => c.scopeSessionId !== scope)) return;
                const before = JSON.stringify([current(), stale]);
                const retained = new Set<string>();
                for (const card of cards) {
                    if (card.state !== 'pending' || !card.questions?.length || !card.reviewToken) continue;
                    const id = key(card); retained.add(id); const prior = rows.get(id);
                    if (prior?.reviewToken === card.reviewToken) { if (prior.error === 'Questions unavailable. Waiting to reconnect.') prior.error = ''; continue; }
                    rows.set(id, { ...card, stepIndex: 0, answers: [], selected: [], draft: '', pending: false, error: '', localOnly: false });
                }
                for (const id of rows.keys()) if (!retained.has(id)) rows.delete(id);
                stale = false; pendingChanged([...rows.values()], scope);
                if (JSON.stringify([current(), stale]) !== before) changed();
                return;
            }
            if (message.type === 'questionDecisionAck' || message.type === 'questionDecisionFailed') {
                if (typeof message.sessionId !== 'string' || typeof message.requestId !== 'string') return;
                const id = key({ sessionId: message.sessionId, requestId: message.requestId }), row = rows.get(id); if (!row) return;
                if (message.type === 'questionDecisionAck') rows.delete(id);
                else { row.pending = false; row.error = typeof message.error === 'string' ? message.error : 'Answer not confirmed'; }
                stale = true; waiting = 0; refreshId = ''; changed(); refresh(); return;
            }
            if (message.type === 'serverStatus' && message.status !== 'connected') { stale = true; waiting = 0; refreshId = ''; changed(); }
            else refresh();
        },
        dispose() { clearInterval(timer); rows.clear(); },
    };
}
